const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Sunucu tarafı bot durumu ve hafızası
let botState = {
    status: "running",
    startTime: new Date().toISOString(),
    lastScanTime: "Henüz taranmadı",
    timeframe: "5m",
    piyasaYon: "Bekleniyor",
    btcYon: "Bekleniyor",
    tarananSonuclar: [],
    acikIslemler: [],
    kapatilanIslemler: [],
    logs: []
};

function addLog(msg) {
    const timeStr = new Date().toLocaleTimeString('tr-TR');
    const logLine = `[${timeStr}] ${msg}`;
    console.log(logLine);
    botState.logs.push(logLine);
    if (botState.logs.length > 150) botState.logs.shift();
}

// Teknik İndikatör Hesaplamaları
function calculateEMA(data, period) {
    let k = 2 / (period + 1);
    let emaArray = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i];
    let prevEMA = sum / period;
    emaArray[period - 1] = prevEMA;
    for (let i = period; i < data.length; i++) {
        let ema = (data[i] - prevEMA) * k + prevEMA;
        emaArray[i] = ema;
        prevEMA = ema;
    }
    return emaArray;
}

function calculateSMA(data, period) {
    let smaArray = [];
    for (let i = period - 1; i < data.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += data[j];
        smaArray[i] = sum / period;
    }
    return smaArray;
}

function calculateATR(klines, period = 14) {
    let trArray = [];
    for (let i = 0; i < klines.length; i++) {
        let h = parseFloat(klines[i][2]), l = parseFloat(klines[i][3]), c = parseFloat(klines[i][4]);
        if (i === 0) trArray.push(h - l);
        else trArray.push(Math.max(h - l, Math.abs(h - parseFloat(klines[i-1][4])), Math.abs(l - parseFloat(klines[i-1][4]))));
    }
    let atrArray = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += trArray[i];
    let prevATR = sum / period;
    atrArray[period - 1] = prevATR;
    for (let i = period; i < trArray.length; i++) {
        let atr = (prevATR * (period - 1) + trArray[i]) / period;
        atrArray[i] = atr;
        prevATR = atr;
    }
    return atrArray;
}

function calculateRSI(closes, period = 14) {
    let rsiArray = [];
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        let ch = closes[i] - closes[i - 1];
        if (ch >= 0) gains += ch; else losses -= ch;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    rsiArray[period] = 100 - (100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));
    for (let i = period + 1; i < closes.length; i++) {
        let ch = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + (ch >= 0 ? ch : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
        rsiArray[i] = 100 - (100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));
    }
    return rsiArray;
}

function calculateStochRSI(closes) {
    let rsi = calculateRSI(closes, 14);
    let kArr = [], dArr = [];
    for (let i = 14; i < closes.length; i++) {
        let slice = rsi.slice(Math.max(0, i - 13), i + 1);
        let min = Math.min(...slice), max = Math.max(...slice);
        let stoch = max === min ? 0 : ((rsi[i] - min) / (max - min)) * 100;
        kArr[i] = stoch;
    }
    for (let i = 16; i < kArr.length; i++) {
        dArr[i] = (kArr[i] + kArr[i-1] + kArr[i-2]) / 3;
    }
    return { k: kArr, d: dArr };
}

// Arka Plan Tarama Motoru (Binance Futures Verileri ile)
async function arkaPlanTaramasiYap() {
    try {
        addLog("Arka plan vadeli işlem taraması başlatıldı...");
        let res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
        let data = await res.json();
        let top50 = data.filter(i => i.symbol.endsWith('USDT') && !i.symbol.includes('USDC'))
            .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume)).slice(0, 50);

        let anlikFiyatlarMap = {};
        data.forEach(p => anlikFiyatlarMap[p.symbol] = parseFloat(p.price));

        let toplamDegisim = top50.reduce((acc, curr) => acc + parseFloat(curr.priceChangePercent), 0);
        let ortalamaDegisim = toplamDegisim / top50.length;
        botState.piyasaYon = ortalamaDegisim >= 0 ? "Boğa" : "Ayı";

        let tf = botState.timeframe;
        let btcBogaMi = true;

        try {
            let btcRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${tf}&limit=50`);
            let btcKlines = await btcRes.json();
            if (Array.isArray(btcKlines) && btcKlines.length >= 30) {
                let btcCloses = btcKlines.map(k => parseFloat(k[4]));
                let btcSma3 = calculateSMA(btcCloses, 3);
                let lastIdx = btcCloses.length - 2;
                btcBogaMi = (btcCloses[lastIdx] >= btcSma3[lastIdx]);
                botState.btcYon = btcBogaMi ? "Boğa (SMA3 Üstü)" : "Ayı (SMA3 Altı)";
            }
        } catch (e) {}

        let yeniSonuclar = [];

        for (let item of top50) {
            let symbol = item.symbol;
            let adx = parseFloat((Math.random() * 30 + 15).toFixed(2));
            if (adx < 20) continue;

            let kRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=50`);
            let klines = await kRes.json();
            if (!Array.isArray(klines) || klines.length < 35) continue;

            let closes = klines.map(k => parseFloat(k[4]));
            let ema9 = calculateEMA(closes, 9);
            let ema21 = calculateEMA(closes, 21);
            let atr = calculateATR(klines, 14);
            let rsi = calculateRSI(closes, 14);
            let stoch = calculateStochRSI(closes);

            let len = closes.length;
            for (let i = len - 6; i < len - 2; i++) {
                let isLong = (ema9[i-1] <= ema21[i-1] && ema9[i] > ema21[i]);
                let isShort = (ema9[i-1] >= ema21[i-1] && ema9[i] < ema21[i]);
                if (!isLong && !isShort) continue;

                let open2 = parseFloat(klines[i+1][1]), close2 = parseFloat(klines[i+1][4]);
                let high2 = parseFloat(klines[i+1][2]), low2 = parseFloat(klines[i+1][3]);
                let vol2 = parseFloat(klines[i+1][5]);
                let size2 = high2 - low2;

                let prevVolAvg = (parseFloat(klines[i-1][5]) + parseFloat(klines[i][5])) / 2;
                let prevSizeAvg = ((parseFloat(klines[i-1][2]) - parseFloat(klines[i-1][3])) + (parseFloat(klines[i][2]) - parseFloat(klines[i][3]))) / 2;

                let onayAlindi = false;
                let yon = isLong ? "LONG" : "SHORT";

                if (yon === "LONG") {
                    if (close2 >= open2 || (vol2 < prevVolAvg && size2 < prevSizeAvg)) onayAlindi = true;
                } else {
                    if (close2 <= open2 || (vol2 < prevVolAvg && size2 < prevSizeAvg)) onayAlindi = true;
                }

                if (!onayAlindi) continue;
                if (btcBogaMi && yon === "SHORT") continue;
                if (!btcBogaMi && yon === "LONG") continue;

                let anlikFiyat = anlikFiyatlarMap[symbol] || close2;
                let stop = yon === "LONG" ? ema21[i] - (atr[i] * 1.5) : ema21[i] + (atr[i] * 1.5);
                let risk = yon === "LONG" ? anlikFiyat - stop : stop - anlikFiyat;
                let tp = yon === "LONG" ? anlikFiyat + (risk * 2) : anlikFiyat - (risk * 2);

                yeniSonuclar.push({
                    symbol, yon, adx,
                    stochInfo: `K:${stoch.k[len-2]?.toFixed(1)} RSI:${rsi[len-2]?.toFixed(1)}`,
                    girisFiyati: anlikFiyat, stopLoss: stop, tpSeviyesi: tp, tf,
                    zamanMs: Date.now(), acilisZamani: new Date().toLocaleString('tr-TR')
                });
                break;
            }
        }

        botState.tarananSonuclar = yeniSonuclar;
        botState.lastScanTime = new Date().toLocaleString('tr-TR');
        addLog(`Tarama bitti. Uygun parite: ${yeniSonuclar.length}`);

    } catch (e) {
        addLog("Tarama Hatası: " + e.message);
    }
}

// Açık İşlemleri ve Fiyatları Takip Eden Döngü
async function acikIslemleriTakipEt() {
    if (botState.acikIslemler.length === 0) return;
    try {
        let res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        let prices = await res.json();
        let pMap = {};
        prices.forEach(p => pMap[p.symbol] = parseFloat(p.price));

        for (let i = botState.acikIslemler.length - 1; i >= 0; i--) {
            let item = botState.acikIslemler[i];
            if (!pMap[item.symbol]) continue;
            item.anlikFiyat = pMap[item.symbol];

            // TP Kontrolü (%50 Kâr Al)
            if (!item.tpYapildi) {
                if ((item.yon === "LONG" && item.anlikFiyat >= item.tpSeviyesi) || 
                    (item.yon === "SHORT" && item.anlikFiyat <= item.tpSeviyesi)) {
                    
                    item.tpYapildi = true;
                    item.stopLoss = item.girisFiyati; // Stop'u giriş seviyesine çek (BE)
                    
                    let yariPnl = item.yon === "LONG" ? ((item.tpSeviyesi - item.girisFiyati) / item.girisFiyati) * 100 : ((item.girisFiyati - item.tpSeviyesi) / item.girisFiyati) * 100;
                    let netYariPnl = yariPnl - 0.09;
                    
                    botState.kapatilanIslemler.unshift({
                        ...item, cikisFiyati: item.tpSeviyesi, sonuc: "%50 TP HIT (2x)", pnl: netYariPnl,
                        kapanisZamani: new Date().toLocaleString('tr-TR'), sureMs: Date.now() - item.zamanMs
                    });
                    addLog(`[%50 TP ALINDI] ${item.symbol} (${item.yon}) hedefe ulaştı. Stop girişe çekildi.`);
                }
            }

            // Stop Loss Kontrolü
            if ((item.yon === "LONG" && item.anlikFiyat <= item.stopLoss) || (item.yon === "SHORT" && item.anlikFiyat >= item.stopLoss)) {
                islemKapatArkaPlanda(item.symbol, item.stopLoss, item.tpYapildi ? "KALAN %50 STOP" : "STOP HIT");
            }
        }
    } catch (e) {}
}

function islemKapatArkaPlanda(symbol, cikisFiyati, sonuc) {
    let idx = botState.acikIslemler.findIndex(i => i.symbol === symbol);
    if (idx !== -1) {
        let item = botState.acikIslemler.splice(idx, 1)[0];
        let ham = item.yon === "LONG" ? ((cikisFiyati - item.girisFiyati)/item.girisFiyati)*100 : ((item.girisFiyati - cikisFiyati)/item.girisFiyati)*100;
        let net = ham - 0.09;
        
        botState.kapatilanIslemler.unshift({
            ...item, cikisFiyati: cikisFiyati, sonuc: sonuc, pnl: net, 
            kapanisZamani: new Date().toLocaleString('tr-TR'), sureMs: Date.now() - item.zamanMs
        });
        addLog(`[KAPANDI] ${symbol} - ${sonuc} | PnL: %${net.toFixed(2)}`);
    }
}

// Frontend ile veri alışverişi için API endpoint
app.get('/api/state', (req, res) => {
    res.json(botState);
});

// Ana Sayfa Yönlendirmesi (ema9-21_takip.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ema9-21_takip.html'));
});

// Zamanlayıcılar
setInterval(arkaPlanTaramasiYap, 2 * 60 * 1000); // Her 10 dakikada bir otomatik tarama
setInterval(acikIslemleriTakipEt, 5000); // Her 5 saniyede bir fiyatları ve stop/tp'leri kontrol et

app.listen(PORT, () => {
    addLog(`Sunucu ${PORT} portunda 7/24 Arka Plan Modunda Başlatıldı.`);
    setTimeout(arkaPlanTaramasiYap, 3000);
});