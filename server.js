const express = require('express');
const cors    = require('cors');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_KEY });

const app = express();
app.use(cors());

const TTL      = 60000;
const TTL_LONG = 300000;

let cache = {
  quotes:   { data: null, time: 0 },
  gainers:  { data: null, time: 0 },
  losers:   { data: null, time: 0 },
  news:     { data: null, time: 0 },
  trending: { data: null, time: 0 },
};

const analysisCache = {};
const ANALYSIS_TTL  = 3600000;

const FALLBACK = [
  'SPY','QQQ','DIA','IWM',
  'NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AVGO',
  'AMD','NFLX','JPM','GS','V','MA','BAC','XOM','CVX',
  'LLY','JNJ','UNH','WMT','COST','HD','NKE','BA','CAT','DIS'
];

let symbolCache = { data: null, time: 0 };

async function getLiveSymbols() {
  const now = Date.now();
  if (symbolCache.data && now - symbolCache.time < TTL_LONG) return symbolCache.data;
  try {
    const [gainers, losers, trending] = await Promise.all([
      yf.dailyGainers({ count: 50 }),
      yf.dailyLosers({ count: 50 }),
      yf.trendingSymbols('US', { count: 20 }),
    ]);
    const all = [...new Set([
      'SPY','QQQ','DIA','IWM',
      ...(gainers?.quotes  || []).map(q => q.symbol),
      ...(losers?.quotes   || []).map(q => q.symbol),
      ...(trending?.quotes || []).map(q => q.symbol),
    ])].filter(s => s && !s.includes('.') && s.length <= 5);
    symbolCache = { data: all, time: now };
    console.log(`📊 Live symbols: ${all.length}`);
    return all;
  } catch(e) {
    console.warn('Symbol discovery failed:', e.message);
    return FALLBACK;
  }
}

function calcRSI(c,n=14){if(!c||c.length<n+1)return null;let g=0,l=0;for(let i=1;i<=n;i++){const d=c[i]-c[i-1];d>0?g+=d:l+=Math.abs(d);}let ag=g/n,al=l/n;for(let i=n+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(n-1)+(d>0?d:0))/n;al=(al*(n-1)+(d<0?Math.abs(d):0))/n;}return al===0?100:+(100-100/(1+ag/al)).toFixed(1);}
function calcSMA(a,n){if(!a||a.length<n)return null;return +(a.slice(-n).reduce((s,v)=>s+v,0)/n).toFixed(2);}
function calcEMA(a,n){if(!a||a.length<n)return null;const k=2/(n+1);let e=a.slice(0,n).reduce((s,v)=>s+v,0)/n;for(let i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return +e.toFixed(2);}

app.get('/health', (req, res) => {
  res.json({ status: '✅ TRADVIX Backend Live', version: '3.0', source: 'Yahoo Finance + Groq AI', time: new Date().toISOString() });
});

app.get('/api/quotes', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.quotes.data && now - cache.quotes.time < TTL) return res.json(cache.quotes.data);
    const symbols = await getLiveSymbols();
    const raw = await yf.quote(symbols);
    const quotes = {};
    for (const q of (Array.isArray(raw) ? raw : [raw])) {
      if (!q?.symbol || !q?.regularMarketPrice) continue;
      quotes[q.symbol] = {
        c:   +q.regularMarketPrice.toFixed(2),
        d:   +(q.regularMarketChange||0).toFixed(2),
        dp:  +(q.regularMarketChangePercent||0).toFixed(2),
        o:   +(q.regularMarketOpen||q.regularMarketPrice).toFixed(2),
        h:   +(q.regularMarketDayHigh||q.regularMarketPrice).toFixed(2),
        l:   +(q.regularMarketDayLow||q.regularMarketPrice).toFixed(2),
        pc:  +(q.regularMarketPreviousClose||q.regularMarketPrice).toFixed(2),
        v:    q.regularMarketVolume||0,
        mkt:  q.marketCap||0,
        pe:   q.trailingPE||0,
        name: q.shortName||q.longName||q.symbol,
        sector: q.sector||'',
      };
    }
    cache.quotes = { data: quotes, time: now };
    console.log(`✅ Quotes: ${Object.keys(quotes).length}`);
    res.json(quotes);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gainers', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.gainers.data && now - cache.gainers.time < TTL) return res.json(cache.gainers.data);
    const data = await yf.dailyGainers({ count: 10 });
    const result = (data?.quotes||[]).map(q => ({
      symbol: q.symbol, name: q.shortName||q.symbol,
      price: q.regularMarketPrice, changesPercentage: q.regularMarketChangePercent,
      change: q.regularMarketChange, volume: q.regularMarketVolume, marketCap: q.marketCap,
    }));
    cache.gainers = { data: result, time: now };
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/losers', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.losers.data && now - cache.losers.time < TTL) return res.json(cache.losers.data);
    const data = await yf.dailyLosers({ count: 10 });
    const result = (data?.quotes||[]).map(q => ({
      symbol: q.symbol, name: q.shortName||q.symbol,
      price: q.regularMarketPrice, changesPercentage: q.regularMarketChangePercent,
      change: q.regularMarketChange, volume: q.regularMarketVolume, marketCap: q.marketCap,
    }));
    cache.losers = { data: result, time: now };
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trending', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.trending.data && now - cache.trending.time < TTL) return res.json(cache.trending.data);
    const data = await yf.trendingSymbols('US', { count: 10 });
    const syms = (data?.quotes||[]).map(q => q.symbol);
    const quotes = syms.length ? await yf.quote(syms) : [];
    const result = (Array.isArray(quotes)?quotes:[quotes]).map(q => ({
      symbol: q.symbol, name: q.shortName||q.symbol,
      price: q.regularMarketPrice, dp: q.regularMarketChangePercent, d: q.regularMarketChange,
    }));
    cache.trending = { data: result, time: now };
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const to = new Date(), from = new Date();
    from.setDate(from.getDate() - 90);
    const data = await yf.historical(sym, {
      period1: from.toISOString().split('T')[0],
      period2: to.toISOString().split('T')[0],
      interval: '1d',
    });
    res.json(data.map(d => d.close).filter(Boolean));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/news', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.news.data && now - cache.news.time < TTL) return res.json(cache.news.data);
    const data = await yf.search('stock market', { newsCount: 20, quotesCount: 0 });
    const news = (data?.news||[]).slice(0,15).map(n => ({
      title: n.title, url: n.link, source: n.publisher,
      date: new Date((n.providerPublishTime||0)*1000).toISOString(),
    }));
    cache.news = { data: news, time: now };
    res.json(news);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analyze/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const level = req.query.level || 'novice';
    const cacheKey = `${sym}_${level}`;
    const now = Date.now();
    if (analysisCache[cacheKey] && now - analysisCache[cacheKey].time < ANALYSIS_TTL) {
      return res.json(analysisCache[cacheKey].data);
    }
    const quotes = await yf.quote(sym);
    const q = Array.isArray(quotes) ? quotes[0] : quotes;
    if (!q) return res.status(404).json({ error: 'Symbol not found' });
    const to = new Date(), from = new Date();
    from.setDate(from.getDate() - 90);
    const hist = await yf.historical(sym, {
      period1: from.toISOString().split('T')[0],
      period2: to.toISOString().split('T')[0],
      interval: '1d',
    });
    const closes = hist.map(d => d.close).filter(Boolean);
    const rsi   = calcRSI(closes);
    const sma50 = calcSMA(closes, Math.min(50, closes.length));
    const sma20 = calcSMA(closes, Math.min(20, closes.length));
    const ema12 = calcEMA(closes, Math.min(12, closes.length));
    const ema26 = calcEMA(closes, Math.min(26, closes.length));
    const macd  = ema12&&ema26 ? +(ema12-ema26).toFixed(3) : null;
    const weekChange  = closes.length>=5  ? +((closes[closes.length-1]-closes[closes.length-5])/closes[closes.length-5]*100).toFixed(2)  : null;
    const monthChange = closes.length>=20 ? +((closes[closes.length-1]-closes[closes.length-20])/closes[closes.length-20]*100).toFixed(2) : null;
    const stockData = `Symbol: ${sym}
Company: ${q.shortName||sym}
Price: $${q.regularMarketPrice}
Today: ${q.regularMarketChangePercent?.toFixed(2)}%
High: $${q.regularMarketDayHigh} Low: $${q.regularMarketDayLow}
Volume: ${q.regularMarketVolume?.toLocaleString()}
Market Cap: $${(q.marketCap/1e9)?.toFixed(1)}B
P/E: ${q.trailingPE?.toFixed(1)||'N/A'}
RSI: ${rsi||'N/A'} MACD: ${macd||'N/A'}
SMA20: $${sma20||'N/A'} SMA50: $${sma50||'N/A'}
1W: ${weekChange||'N/A'}% 1M: ${monthChange||'N/A'}%`;
    const prompts = {
      novice: `You are ARIA, a friendly AI stock analyst for TRADVIX. Analyze this stock for a complete beginner. Use simple everyday language. No jargon. Give a clear BUY, HOLD, or SELL recommendation.\n\n${stockData}\n\nFormat:\nRECOMMENDATION: [BUY/HOLD/SELL]\nSIMPLE EXPLANATION: [2-3 simple sentences]\nTIP: [One practical action]`,
      intermediate: `You are ARIA, an AI stock analyst for TRADVIX. Analyze for an intermediate investor.\n\n${stockData}\n\nFormat:\nRECOMMENDATION: [STRONG BUY/BUY/HOLD/SELL/STRONG SELL]\nANALYSIS: [3-4 sentences]\nENTRY: [Price range]\nSTOP LOSS: [Level]\nTARGET: [Price target]\nRISK: [LOW/MEDIUM/HIGH]`,
      expert: `You are ARIA, expert quantitative analyst for TRADVIX. Institutional-grade analysis.\n\n${stockData}\n\nFormat:\nSIGNAL: [BUY/HOLD/SELL] Conviction: [HIGH/MEDIUM/LOW]\nTECHNICAL: [Detailed analysis]\nMOMENTUM: [RSI/MACD]\nSTRUCTURE: [Support/resistance]\nTRADE PLAN: [Entry/stop/target R:R]\nCATALYST: [Key risks]`,
      deep: `You are ARIA, world-class quantitative analyst for TRADVIX. Deepest analysis for professional fund managers.\n\n${stockData}\n\n1. EXECUTIVE SUMMARY\n2. TECHNICAL ANALYSIS — Multi-timeframe\n3. FUNDAMENTAL ASSESSMENT\n4. RISK FACTORS with probabilities\n5. PRICE SCENARIOS — Bull/Base/Bear\n6. INSTITUTIONAL PERSPECTIVE\n7. RECOMMENDATION — Position sizing\n8. CONFIDENCE SCORE /10`,
    };
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompts[level]||prompts.novice }],
      temperature: 0.7,
      max_tokens: level==='deep'?1500:800,
    });
    const result = {
      symbol: sym, level,
      price: q.regularMarketPrice,
      change: q.regularMarketChangePercent,
      analysis: completion.choices[0]?.message?.content||'Unavailable',
      technicals: { rsi, macd, sma20, sma50, weekChange, monthChange },
      timestamp: new Date().toISOString(),
      model: 'Llama 3.3 70B (Groq)',
    };
    analysisCache[cacheKey] = { data: result, time: now };
    res.json(result);
  } catch(e) {
    console.error('Analysis error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── KEEP ALIVE ────────────────────────────────────
setInterval(async () => {
  try {
    const { default: fetch } = await import('node-fetch');
    const url = process.env.RENDER_EXTERNAL_URL || 'https://tradvix-backend.onrender.com';
    await fetch(`${url}/health`);
    console.log('💓 Alive');
  } catch(e) {}
}, 840000);

// ── START ─────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 TRADVIX Backend v3.0`);
  console.log(`📡 http://localhost:${PORT}`);
  console.log(`🤖 Groq AI: Llama 3.3 70B`);
  console.log(`🔄 Cache TTL: ${TTL/1000}s\n`);
});
