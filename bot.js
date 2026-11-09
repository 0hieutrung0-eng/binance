import time
import math
import os
from binance.client import Client
from binance.exceptions import BinanceAPIException

# ==========================================
# 1. CẤU HÌNH
# ==========================================
API_KEY = "hTNtFqn7erbVjsKS4BXpDN1quZhST0zbUudHPRL5N56wnUQqvrLen4JdEbateuIi"
API_SECRET = "UGPd4K7Qw8qd5hIwBm0kekPhDpFEN2q9WJfBF6McevHrmMtNfDXcEXrotep74Nt"

USE_TESTNET = False
LEVERAGE = 5
MARGIN_PER_TRADE = 2.0

MAX_ACTIVE_TRADES = 5

PROFIT_PERCENT = 0.03
LOSS_PERCENT = 0.03
BREAK_EVEN_TRIGGER = 0.006

TRADE_MODE = "NORMAL"

ST_PERIOD = 10
ST_MULTIPLIER = 3.0
RSI_PERIOD = 14
EMA_FAST = 8
EMA_SLOW = 21

ENTRY_INTERVAL = "5m"
HTF_INTERVAL = "15m"

SYMBOL_PRECISION_CACHE = {}
LAST_TRADE_TIME = {}


# ==========================================
# 2. HÀM CƠ BẢN
# ==========================================
def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')


def load_symbol_precisions(client):
    global SYMBOL_PRECISION_CACHE
    try:
        info = client.futures_exchange_info()
        for s in info['symbols']:
            for f in s['filters']:
                if f['filterType'] == 'LOT_SIZE':
                    step = float(f['stepSize'])
                    precision = len(str(step).rstrip('0').split('.')[-1]) if '.' in str(step) else 0
                    SYMBOL_PRECISION_CACHE[s['symbol']] = precision
        print("[INIT] Đã tải Lot Size thành công")
    except Exception as e:
        print(f"[LỖI PRECISION] {e}")


def floor_precision(val, precision):
    factor = 10 ** precision
    return math.floor(val * factor) / factor


def get_max_leverage(client, symbol):
    try:
        brackets = client.futures_leverage_bracket(symbol=symbol)
        return int(brackets[0]['brackets'][0]['initialLeverage'])
    except:
        return 5


def is_hedge_mode(client):
    try:
        return client.futures_get_position_mode().get('dualSidePosition', False)
    except:
        return False


def get_usdt_balances(client):
    try:
        acc = client.futures_account()
        for a in acc['assets']:
            if a['asset'] == 'USDT':
                return {
                    'wallet': float(a['walletBalance']),
                    'available': float(a['availableBalance']),
                    'unrealized': float(a.get('unrealizedProfit', 0))
                }
    except:
        pass
    return {'wallet': 0.0, 'available': 0.0, 'unrealized': 0.0}


# ==========================================
# 3. CHỈ BÁO
# ==========================================
def ema(data, period):
    if len(data) < period:
        return [data[-1]] * len(data)
    k = 2 / (period + 1)
    result = [sum(data[:period]) / period]
    for price in data[period:]:
        result.append(price * k + result[-1] * (1 - k))
    return result


def rsi(closes, period=14):
    if len(closes) < period + 1:
        return 50.0
    gains, losses = [], []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i-1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def supertrend(highs, lows, closes, period=10, multiplier=3.0):
    n = len(closes)
    if n < period + 2:
        return None

    atr_values = []
    for i in range(1, n):
        tr = max(highs[i] - lows[i],
                 abs(highs[i] - closes[i-1]),
                 abs(lows[i] - closes[i-1]))
        atr_values.append(tr)

    atr_series = []
    for i in range(len(atr_values)):
        if i < period - 1:
            atr_series.append(sum(atr_values[:i+1]) / (i+1))
        else:
            atr_series.append(sum(atr_values[i-period+1:i+1]) / period)

    hl2 = [(highs[i] + lows[i]) / 2 for i in range(n)]
    final_upper = [0.0] * n
    final_lower = [0.0] * n
    direction = [1] * n

    for i in range(period, n):
        basic_upper = hl2[i] + multiplier * atr_series[i-1]
        basic_lower = hl2[i] - multiplier * atr_series[i-1]

        if i == period:
            final_upper[i] = basic_upper
            final_lower[i] = basic_lower
            direction[i] = 1 if closes[i] > basic_upper else -1
            continue

        final_upper[i] = basic_upper if (basic_upper < final_upper[i-1] or closes[i-1] > final_upper[i-1]) else final_upper[i-1]
        final_lower[i] = basic_lower if (basic_lower > final_lower[i-1] or closes[i-1] < final_lower[i-1]) else final_lower[i-1]

        if direction[i-1] == 1:
            direction[i] = -1 if closes[i] < final_lower[i] else 1
        else:
            direction[i] = 1 if closes[i] > final_upper[i] else -1

    return 'LONG' if direction[-1] == 1 else 'SHORT'


def check_higher_timeframe_trend(client, symbol):
    try:
        klines = client.futures_klines(symbol=symbol, interval=HTF_INTERVAL, limit=40)
        closes = [float(k[4]) for k in klines]
        highs = [float(k[2]) for k in klines]
        lows = [float(k[3]) for k in klines]
        return supertrend(highs, lows, closes, ST_PERIOD, ST_MULTIPLIER)
    except:
        return None


def decide_direction(client, symbol):
    try:
        now = time.time()
        if symbol in LAST_TRADE_TIME and now - LAST_TRADE_TIME[symbol] < 45:
            return None

        klines = client.futures_klines(symbol=symbol, interval=ENTRY_INTERVAL, limit=60)
        closes = [float(k[4]) for k in klines]
        highs = [float(k[2]) for k in klines]
        lows = [float(k[3]) for k in klines]
        volumes = [float(k[5]) for k in klines]

        avg_vol = sum(volumes[-15:-1]) / 14
        if volumes[-1] < avg_vol * 1.05:
            return None

        st_dir = supertrend(highs, lows, closes, ST_PERIOD, ST_MULTIPLIER)
        if st_dir is None:
            return None

        htf_dir = check_higher_timeframe_trend(client, symbol)

        current_rsi = rsi(closes, RSI_PERIOD)
        ema_fast = ema(closes, EMA_FAST)[-1]
        ema_slow = ema(closes, EMA_SLOW)[-1]
        ema_bullish = ema_fast > ema_slow

        raw_signal = None

        if st_dir == 'LONG' and 28 < current_rsi < 72:
            if ema_bullish or (htf_dir == 'LONG'):
                raw_signal = 'LONG'
        elif st_dir == 'SHORT' and 28 < current_rsi < 72:
            if (not ema_bullish) or (htf_dir == 'SHORT'):
                raw_signal = 'SHORT'

        if raw_signal is None:
            return None

        if TRADE_MODE == "REVERSE":
            final = 'SHORT' if raw_signal == 'LONG' else 'LONG'
            print(f"   [ĐẢO NGƯỢC] {symbol} | {raw_signal} → {final} | RSI: {current_rsi:.1f}")
            return final
        else:
            print(f"   [TÍN HIỆU] {symbol} | {raw_signal} | RSI: {current_rsi:.1f} | HTF: {htf_dir}")
            return raw_signal

    except Exception as e:
        return None


# ==========================================
# 4. MỞ LỆNH (BẮT BUỘC TP + SL)
# ==========================================
def open_position(client, symbol, direction, hedge_mode):
    try:
        balances = get_usdt_balances(client)
        if balances['available'] < MARGIN_PER_TRADE:
            return False

        try:
            client.futures_change_margin_type(symbol=symbol, marginType="ISOLATED")
        except:
            pass

        max_lev = get_max_leverage(client, symbol)
        lev = min(LEVERAGE, max_lev)
        if lev < 5:
            return False

        client.futures_change_leverage(symbol=symbol, leverage=lev)

        price = float(client.futures_symbol_ticker(symbol=symbol)['price'])
        prec = SYMBOL_PRECISION_CACHE.get(symbol, 3)

        notional = MARGIN_PER_TRADE * lev
        qty = floor_precision(notional / price, prec)
        if qty <= 0:
            return False

        effective_margin = (qty * price) / lev
        if effective_margin < MARGIN_PER_TRADE * 0.87:
            return False

        if direction == 'LONG':
            side = 'BUY'
            pos_side = 'LONG'
            tp_price = round(price * (1 + PROFIT_PERCENT), 6)
            sl_price = round(price * (1 - LOSS_PERCENT), 6)
            close_side = 'SELL'
        else:
            side = 'SELL'
            pos_side = 'SHORT'
            tp_price = round(price * (1 - PROFIT_PERCENT), 6)
            sl_price = round(price * (1 + LOSS_PERCENT), 6)
            close_side = 'BUY'

        params = {'symbol': symbol, 'side': side, 'type': 'MARKET', 'quantity': qty}
        if hedge_mode:
            params['positionSide'] = pos_side
        client.futures_create_order(**params)
        print(f"\n[KHỚP LỆNH] {direction} {symbol} | Lev {lev}x | Giá {price:.6f} | Qty {qty} | Margin ≈ {effective_margin:.2f}U")

        tp_ok = sl_ok = False
        for _ in range(3):
            if not tp_ok:
                try:
                    p = {
                        'symbol': symbol, 'side': close_side, 'type': 'TAKE_PROFIT_MARKET',
                        'stopPrice': tp_price, 'closePosition': True, 'workingType': 'CONTRACT_PRICE'
                    }
                    if hedge_mode:
                        p['positionSide'] = pos_side
                    client.futures_create_order(**p)
                    tp_ok = True
                except:
                    time.sleep(0.3)

            if not sl_ok:
                try:
                    p = {
                        'symbol': symbol, 'side': close_side, 'type': 'STOP_MARKET',
                        'stopPrice': sl_price, 'closePosition': True, 'workingType': 'CONTRACT_PRICE'
                    }
                    if hedge_mode:
                        p['positionSide'] = pos_side
                    client.futures_create_order(**p)
                    sl_ok = True
                except:
                    time.sleep(0.3)

            if tp_ok and sl_ok:
                break

        if not (tp_ok and sl_ok):
            print(f"   [CẢNH BÁO] Không đặt được TP/SL → Đóng {symbol} ngay!")
            try:
                close_p = {'symbol': symbol, 'side': close_side, 'type': 'MARKET', 'quantity': qty, 'reduceOnly': True}
                if hedge_mode:
                    close_p['positionSide'] = pos_side
                client.futures_create_order(**close_p)
            except:
                pass
            return False

        print(f" → TP: {tp_price} | SL: {sl_price} (OK)")
        LAST_TRADE_TIME[symbol] = time.time()
        return True

    except BinanceAPIException as e:
        if e.code != -2019:
            print(f"[LỖI MỞ LỆNH] {symbol}: {e}")
        return False
    except Exception as e:
        print(f"[LỖI] {symbol}: {e}")
        return False


def manage_break_even(client, hedge_mode):
    try:
        positions = client.futures_position_information()
        for p in positions:
            amt = float(p['positionAmt'])
            if amt == 0:
                continue
            symbol = p['symbol']
            entry = float(p['entryPrice'])
            mark = float(p['markPrice'])
            pnl_pct = (mark - entry) / entry if amt > 0 else (entry - mark) / entry
            if pnl_pct < BREAK_EVEN_TRIGGER:
                continue

            try:
                for o in client.futures_get_open_orders(symbol=symbol):
                    if o['type'] in ('STOP_MARKET', 'STOP'):
                        client.futures_cancel_order(symbol=symbol, orderId=o['orderId'])
            except:
                pass

            close_side = 'SELL' if amt > 0 else 'BUY'
            pos_side = 'LONG' if amt > 0 else 'SHORT'
            be_price = round(entry * (1.0006 if amt > 0 else 0.9994), 6)

            params = {
                'symbol': symbol, 'side': close_side, 'type': 'STOP_MARKET',
                'stopPrice': be_price, 'closePosition': True, 'workingType': 'CONTRACT_PRICE'
            }
            if hedge_mode:
                params['positionSide'] = pos_side
            try:
                client.futures_create_order(**params)
                print(f"   [BREAK-EVEN] {symbol} → SL về {be_price}")
            except:
                pass
    except:
        pass


# ==========================================
# 5. STATUS
# ==========================================
def print_status(client):
    try:
        balances = get_usdt_balances(client)
        positions = client.futures_position_information()
        active = [p for p in positions if float(p['positionAmt']) != 0]
        active_symbols = []

        print(f"[VÍ] Tổng USDT: {balances['wallet']:.2f} | Available: {balances['available']:.2f} | Unrealized: {balances['unrealized']:+.2f}")
        print(f"[STATUS] Lệnh mở: {len(active)}/{MAX_ACTIVE_TRADES} | Mode: {TRADE_MODE}")

        if not active:
            print("   (Không có vị thế)")
            return []

        total_pnl = 0.0
        print("   ────────── VỊ THẾ ĐANG MỞ ──────────")
        for p in active:
            symbol = p['symbol']
            amt = float(p['positionAmt'])
            entry = float(p['entryPrice'])
            mark = float(p['markPrice'])
            pnl = float(p['unRealizedProfit'])
            lev = p.get('leverage', '?')
            direction = "LONG" if amt > 0 else "SHORT"
            emoji = "🟢" if pnl >= 0 else "🔴"
            print(f"   {emoji} {symbol} {direction} | Entry: {entry:.6f} | Mark: {mark:.6f} | PnL: {pnl:+.4f}U | Lev: {lev}x")
            total_pnl += pnl
            active_symbols.append(symbol)
        print(f"   Tổng Unrealized: {total_pnl:+.4f} USDT")
        return active_symbols
    except Exception as e:
        print(f"[LỖI STATUS] {e}")
        return []


def clean_orphan_orders(client, active_symbols):
    try:
        for o in client.futures_get_open_orders():
            if o['symbol'] not in active_symbols:
                client.futures_cancel_all_open_orders(symbol=o['symbol'])
                print(f"[CLEANUP] Hủy lệnh thừa {o['symbol']}")
    except:
        pass


# ==========================================
# 6. VÒNG LẶP CHÍNH - QUÉT TOP TĂNG/GIẢM
# ==========================================
def run_bot():
    client = Client(API_KEY, API_SECRET, testnet=USE_TESTNET)
    load_symbol_precisions(client)
    hedge = is_hedge_mode(client)

    print(f"Bot khởi động | Testnet: {USE_TESTNET} | Hedge: {hedge}")
    time.sleep(1)

    while True:
        try:
            clear_screen()
            print("=" * 64)
            print(f"BOT SUPER TREND | Mode: {TRADE_MODE} | Quét TOP TĂNG/GIẢM")
            print(f"Entry: {ENTRY_INTERVAL} | HTF: {HTF_INTERVAL} | Margin: {MARGIN_PER_TRADE}U | Lev: {LEVERAGE}x")
            print("=" * 64)

            active_symbols = print_status(client)
            clean_orphan_orders(client, active_symbols)
            manage_break_even(client, hedge)

            if len(active_symbols) >= MAX_ACTIVE_TRADES:
                print(f"\n[THÔNG BÁO] Đã đủ {MAX_ACTIVE_TRADES} lệnh.")
            else:
                balances = get_usdt_balances(client)
                if balances['available'] >= MARGIN_PER_TRADE:
                    tickers = client.futures_ticker()
                    candidates = []

                    for t in tickers:
                        sym = t['symbol']
                        if (sym.endswith('USDT') and
                            not any(sym.startswith(x) for x in ['USDC', 'TUSD', 'BUSD', 'EUR', 'GBP', 'USDP']) and
                            float(t['quoteVolume']) > 5_000_000):   # volume tối thiểu

                            change = abs(float(t['priceChangePercent']))
                            if change >= 0.8:                      # chỉ lấy coin có biến động
                                candidates.append(t)

                    # Sắp xếp theo biến động mạnh nhất (tăng hoặc giảm)
                    candidates = sorted(candidates,
                                        key=lambda x: abs(float(x['priceChangePercent'])),
                                        reverse=True)[:40]          # Lấy top 30

                    print(f"\n[QUÉT TOP TĂNG/GIẢM] Đang kiểm tra {len(candidates)} coin biến động mạnh nhất...")
                    found = 0
                    checked = 0

                    for t in candidates:
                        if len(active_symbols) >= MAX_ACTIVE_TRADES:
                            break
                        symbol = t['symbol']
                        if symbol in active_symbols:
                            continue
                        if get_usdt_balances(client)['available'] < MARGIN_PER_TRADE:
                            break

                        checked += 1
                        direction = decide_direction(client, symbol)
                        if direction:
                            success = open_position(client, symbol, direction, hedge)
                            if success:
                                active_symbols.append(symbol)
                                found += 1
                            time.sleep(0.55)

                    print(f"   → Đã kiểm tra {checked} coin | Tìm thấy {found} tín hiệu")

            print("\n[ĐANG CHỜ] Quét lại sau 5 giây...")
            time.sleep(5)

        except Exception as e:
            print(f"[LỖI SYSTEM] {e}")
            time.sleep(6)


if __name__ == "__main__":
    run_bot()
