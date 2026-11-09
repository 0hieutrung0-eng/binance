const fetch = require('node-fetch');
const crypto = require('crypto');
const http = require('http');

// ==================== CẤU HÌNH HỆ THỐNG ====================
const API_KEY = "hTNtFqn7erbVjsKS4BXpDN1quZhST0zbUudHPRL5N56wnUQqvrLen4JdEbateuIi";
const SECRET_KEY = "UGPd4K7Qw8qd5hIwBm0kekPhDpFEN2q9WJfBF6McevHrmMtNfDXcEXrotep74Nt";
const BASE_URL = "https://fapi.binance.com";

// TẠO HTTP SERVER BẮT ĐÚNG PORT CỦA RENDER (Tránh lỗi No open ports)
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot Binance Futures is running 24/7 with detailed error logs!\n');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🌐 Server đang lắng nghe tại cổng ${PORT}`);
});

// Hàm tạo chữ ký HMAC SHA256
function generateSignature(queryString, secretKey) {
    return crypto
        .createHmac('sha256', secretKey)
        .update(queryString)
        .digest('hex');
}

// Hàm gọi API Binance có log lỗi chi tiết HTTP Status
async function callBinanceAPI(endpoint, method = 'GET', payload = null, isSigned = false) {
    let url = BASE_URL + endpoint;
    let headers = { "X-MBX-APIKEY": API_KEY };

    if (isSigned) {
        let timestamp = Date.now();
        let queryString = `timestamp=${timestamp}`;
        if (payload) {
            for (let key in payload) {
                queryString += `&${key}=${encodeURIComponent(payload[key])}`;
            }
        }
        let signature = generateSignature(queryString, SECRET_KEY);
        url += `?${queryString}&signature=${signature}`;
    } else if (payload) {
        let queryArr = [];
        for (let key in payload) {
            queryArr.push(`${key}=${encodeURIComponent(payload[key])}`);
        }
        if (queryArr.length > 0) {
            url += `?${queryArr.join('&')}`;
        }
    }

    let options = { method, headers };

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            let response = await fetch(url, options);
            
            // KIỂM TRA MÃ LỖI HTTP TRẢ VỀ TỪ BINANCE
            if (!response.ok) {
                let errText = await response.text();
                console.log(`⚠️ API ${endpoint} trả về lỗi HTTP ${response.status}: ${errText}`);
                return null;
            }

            let data = await response.json();
            return data;
        } catch (error) {
            console.log(`⚠️ Lỗi ngoại lệ khi gọi ${endpoint} (Lần thử ${attempt}/3):`, error.message);
            if (attempt === 3) {
                return null;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return null;
}

// Tính toán chỉ báo RSI
function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        let change = closes[closes.length - i] - closes[closes.length - i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    let rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Lấy dữ liệu nến (Kline)
async function getKlineData(symbol, interval, limit) {
    let endpoint = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    let data = await callBinanceAPI(endpoint, 'GET', null, false);
    if (!Array.isArray(data)) return [];

    return data.map(k => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
    }));
}

// ==================== HÀM CHÍNH CHẠY BOT ====================
async function runBot() {
    try {
        console.log("\n==================== BẮT ĐẦU VÒNG QUÉT MỚI ====================");

        // 1. Kiểm tra vị thế mở trên sàn
        let positions = await callBinanceAPI("/fapi/v2/positionRisk", "GET", null, true);
        if (Array.isArray(positions)) {
            let activePositions = positions.filter(pos => parseFloat(pos.positionAmt) !== 0);
            if (activePositions.length > 0) {
                console.log("⚠️ Đang có vị thế mở trên sàn. Tạm dừng và kiểm tra lại sau 5 phút!");
                scheduleNextRun(5 * 60 * 1000);
                return;
            }
        }

        // 2. LẤY DANH SÁCH COIN (Ưu tiên gọi 24hr, nếu lỗi tự động dùng list dự phòng an toàn)
        let tickers = await callBinanceAPI("/fapi/v1/ticker/24hr", "GET", null, false);
        let candidates = [];

        if (Array.isArray(tickers)) {
            let usdtTickers = tickers.filter(t => 
                t.symbol.endsWith("USDT") && 
                !["USDCUSDT", "TUSDUSDT", "BUSDUSDT", "EURUSDT"].includes(t.symbol)
            );

            usdtTickers.sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent));

            let topGainers = usdtTickers.slice(0, 5);
            let topLosers = usdtTickers.slice(-5).reverse();
            candidates = [...topGainers, ...topLosers];

            console.log("📊 Lấy thành công top biến động từ sàn:");
            console.log("🟢 Top Tăng:", topGainers.map(x => `${x.symbol} (${x.priceChangePercent}%)`).join(", "));
            console.log("🔴 Top Giảm:", topLosers.map(x => `${x.symbol} (${x.priceChangePercent}%)`).join(", "));
        } else {
            console.log("⚠️ Không lấy được ticker 24h (Do IP Render bị hạn chế hoặc nghẽn mạng). Chuyển sang danh sách coin top thanh khoản cố định để quét liên tục...");
            let fallbackList = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "SUIUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT"];
            candidates = fallbackList.map(s => ({ symbol: s }));
        }

        // 3. PHÂN TÍCH CHỈ BÁO KỸ THUẬT
        console.log("🔍 Đang tiến hành phân tích chỉ báo (RSI, Volume, Trend) cho danh sách...");

        let bestTarget = null;
        let scoreBest = -999;

        for (let item of candidates) {
            let symbol = item.symbol;

            let klines5m = await getKlineData(symbol, "5m", 30);
            let klines1h = await getKlineData(symbol, "1h", 20);
            let klines1d = await getKlineData(symbol, "1d", 10);

            if (klines5m.length < 20 || klines1h.length < 15) continue;

            let closes5m = klines5m.map(k => k.close);
            let rsi5m = calculateRSI(closes5m, 14);

            let recentVol = klines5m[klines5m.length - 1].volume;
            let avgVol = (klines5m[klines5m.length - 2].volume + klines5m[klines5m.length - 3].volume + klines5m[klines5m.length - 4].volume) / 3;
            let isVolumeConfirmed = recentVol > (avgVol * 1.2);

            let trend1h = klines1h[klines1h.length - 1].close > klines1h[klines1h.length - 5].close ? "UP" : "DOWN";
            let trend1d = klines1d.length > 3 ? (klines1d[klines1d.length - 1].close > klines1d[klines1d.length - 2].close ? "UP" : "DOWN") : "UP";

            let currentScore = 0;
            let suggestedAction = "";

            if (rsi5m < 40 && (trend1h === "UP" || trend1d === "UP") && isVolumeConfirmed) {
                suggestedAction = "BUY";
                currentScore = (50 - rsi5m) + (recentVol / avgVol);
            } else if (rsi5m > 60 && (trend1h === "DOWN" || trend1d === "DOWN") && isVolumeConfirmed) {
                suggestedAction = "SELL";
                currentScore = (rsi5m - 50) + (recentVol / avgVol);
            }

            if (suggestedAction && currentScore > scoreBest) {
                scoreBest = currentScore;
                bestTarget = { symbol, action: suggestedAction, currentPrice: closes5m[closes5m.length - 1], rsi: rsi5m };
            }
        }

        // 4. XỬ LÝ KẾT QUẢ TÌM KIẾM
        if (!bestTarget) {
            console.log("📭 Chưa tìm thấy mã nào thỏa mãn tín hiệu. Sẽ quét lại liên tục sau 15 giây...");
            scheduleNextRun(15 * 1000); // Tự động quét lại sau 15 giây
            return;
        }

        console.log(`🎯 TÌM THẤY TÍN HIỆU: ${bestTarget.symbol} | Hướng: ${bestTarget.action} | Giá: ${bestTarget.currentPrice} | RSI: ${bestTarget.rsi.toFixed(2)}`);

        // 5. Kiểm tra ví và vào lệnh
        let account = await callBinanceAPI("/fapi/v2/account", "GET", null, true);
        let usdtWallet = 0;
        if (account && account.assets) {
            let usdtAsset = account.assets.find(a => a.asset === "USDT");
            if (usdtAsset) usdtWallet = parseFloat(usdtAsset.availableBalance);
        }

        console.log(`💰 SỐ DƯ VÍ USDT: ${usdtWallet.toFixed(2)} USDT`);
        if (usdtWallet <= 10) {
            console.log("❌ Số dư ví dưới 10 USDT. Chờ kiểm tra lại sau 5 phút.");
            scheduleNextRun(5 * 60 * 1000);
            return;
        }

        let { symbol, action: side, currentPrice } = bestTarget;
        let allocationPercent = (side === "BUY") ? 0.95 : 0.50; 
        let leverage = 1; 
        let capitalToUse = usdtWallet * allocationPercent * leverage;
        let quantity = parseFloat((capitalToUse / currentPrice).toFixed(3));
        let tpPrice = (side === "BUY") ? currentPrice * 1.02 : currentPrice * 0.98; 

        console.log("==================== THỰC THI KHỚP LỆNH ====================");
        console.log(`💼 Vốn phân bổ: ${capitalToUse.toFixed(2)} USDT | Khối lượng: {quantity} | TP: ${tpPrice.toFixed(4)}`);

        let orderPayload = { symbol, side, type: "MARKET", quantity };
        let marketRes = await callBinanceAPI("/fapi/v1/order", "POST", orderPayload, true);
        console.log("✅ Kết quả Market Order:", JSON.stringify(marketRes));

        let tpSide = (side === "BUY") ? "SELL" : "BUY";
        let tpPayload = { symbol, side: tpSide, type: "TAKE_PROFIT_MARKET", stopPrice: tpPrice.toFixed(4), closePosition: "true" };
        let tpRes = await callBinanceAPI("/fapi/v1/order", "POST", tpPayload, true);
        console.log("✅ Kết quả Take Profit:", JSON.stringify(tpRes));
        console.log("============================================================");

        scheduleNextRun(5 * 60 * 1000);

    } catch (error) {
        console.log("❌ Lỗi hệ thống nghiêm trọng:", error.message);
        scheduleNextRun(30 * 1000);
    }
}

function scheduleNextRun(delayMs) {
    setTimeout(runBot, delayMs);
}

console.log("🚀 Bot Binance Futures khởi động với cơ chế Log lỗi chi tiết...");
runBot();
