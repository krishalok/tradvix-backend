const express = require('express');
const cors    = require('cors');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_KEY });

const app = express();
app.use(cors());

const TTL       = 60000;
const TTL_LONG  = 300000;
const TTL_HOUR  = 3600000;
const TTL_DAY   = 86400000;

let cache = {};
const setCache = (key, data, ttl=TTL) => { cache[key] = { data, time: Date.now(), ttl }; };
const getCache = (key) => { const c=cache[key]; if(!c) return null; if(Date.now()-c.time>c.ttl){delete cache[key];return null;} return c.data; };

const FALLBACK_SYMBOLS = [
  'SPY','QQQ','DIA','IWM',
  'NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AVGO',
  'AMD','NFLX','JPM','GS','V','MA','BAC','XOM','CVX',
  'LLY','JNJ','UNH','WMT','COST','HD','NKE','BA','CAT','DIS'
];

// ── HELPERS ───────────────────────────────────────
async function fetchJSON(url, opts={}) {
  const { default: fetch } = await import('node-fetch');
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function calcRSI(c,n=14){if(!c||c.length<n+1)return null;let g=0,l=0;for(let i=1;i<=n;i++){const d=c[i]-c[i-1];d>0?g+=d:l+=Math.abs(d);}let ag=g/n,al=l/n;for(let i=n+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(n-1)+(d>0?d:0))/n;al=(al*(n-1)+(d<0?Math.abs(d):0))/n;}return al===0?100:+(100-100/(1+ag/al)).toFixed(1);}
function calcSMA(a,n){if(!a||a.length<n)return null;return +(a.slice(-n).reduce((s,v)=>s+v,0)/n).toFixed(2);}
function calcEMA(a,n){if(!a||a.length<n)return null;const k=2/(n+1);let e=a.slice(0,n).reduce((s,v)=>s+v,0)/n;for(let i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return +e.toFixed(2);}

// ── DYNAMIC SYMBOLS ───────────────────────────────
async function getLiveSymbols() {
  const cached = getCache('symbols');
  if (cached) return cached;
  try {
    const [gainers, losers, trending] = await Promise.all([
      yf.dailyGainers({ count: 50 }),
      yf.dailyLosers({ count: 50 }),
      yf.trendingSymbols('US', { count: 20 }),
    ]);
    const all = [...new Set([
      'SPY','QQQ','DIA','IWM',
      ...(gainers?.quotes||[]).map(q=>q.symbol),
      ...(losers?.quotes||[]).map(q=>q.symbol),
      ...(trending?.quotes||[]).map(q=>q.symbol),
    ])].filter(s=>s&&!s.includes('.')&&s.length<=5);
    setCache('symbols', all, TTL_LONG);
    return all;
  } catch(e) { return FALLBACK_SYMBOLS; }
}

// ── ROUTES ────────────────────────────────────────

app.get('/health', (req,res) => res.json({
  status: '✅ TRADVIX Backend v4.0',
  features: ['quotes','gainers','losers','trending','history','news','analyze','sector','earnings','premarket','macro','sec','research','chat'],
  time: new Date().toISOString()
}));

// Quotes
app.get('/api/quotes', async (req,res) => {
  try {
    const cached = getCache('quotes');
    if (cached) return res.json(cached);
    const symbols = await getLiveSymbols();
    const raw = await yf.quote(symbols);
    const quotes = {};
    for (const q of (Array.isArray(raw)?raw:[raw])) {
      if (!q?.symbol||!q?.regularMarketPrice) continue;
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
        preMarket: q.preMarketPrice||null,
        preMarketChange: q.preMarketChangePercent||null,
        postMarket: q.postMarketPrice||null,
        postMarketChange: q.postMarketChangePercent||null,
        fiftyTwoWeekHigh: q.fiftyTwoWeekHigh||null,
        fiftyTwoWeekLow: q.fiftyTwoWeekLow||null,
        avgVolume: q.averageDailyVolume3Month||null,
        beta: q.beta||null,
      };
    }
    setCache('quotes', quotes);
    console.log(`✅ Quotes: ${Object.keys(quotes).length}`);
    res.json(quotes);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Gainers
app.get('/api/gainers', async (req,res) => {
  try {
    const cached = getCache('gainers');
    if (cached) return res.json(cached);
    const data = await yf.dailyGainers({ count: 10 });
    const result = (data?.quotes||[]).map(q=>({
      symbol: q.symbol, name: q.shortName||q.symbol,
      price: q.regularMarketPrice, changesPercentage: q.regularMarketChangePercent,
      change: q.regularMarketChange, volume: q.regularMarketVolume, marketCap: q.marketCap,
    }));
    setCache('gainers', result);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Losers
app.get('/api/losers', async (req,res) => {
  try {
    const cached = getCache('losers');
    if (cached) return res.json(cached);
    const data = await yf.dailyLosers({ count: 10 });
    const result = (data?.quotes||[]).map(q=>({
      symbol: q.symbol, name: q.shortName||q.symbol,
      price: q.regularMarketPrice, changesPercentage: q.regularMarketChangePercent,
      change: q.regularMarketChange, volume: q.regularMarketVolume, marketCap: q.marketCap,
    }));
    setCache('losers', result);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Pre-market movers
app.get('/api/premarket', async (req,res) => {
  try {
    const cached = getCache('premarket');
    if (cached) return res.json(cached);
    const symbols = FALLBACK_SYMBOLS.slice(4);
    const raw = await yf.quote(symbols);
    const movers = (Array.isArray(raw)?raw:[raw])
      .filter(q=>q?.preMarketPrice&&q?.preMarketChangePercent)
      .map(q=>({
        symbol: q.symbol,
        name: q.shortName||q.symbol,
        price: q.regularMarketPrice,
        preMarketPrice: q.preMarketPrice,
        preMarketChange: q.preMarketChangePercent,
      }))
      .sort((a,b)=>Math.abs(b.preMarketChange)-Math.abs(a.preMarketChange))
      .slice(0,10);
    setCache('premarket', movers, TTL);
    res.json(movers);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// History
app.get('/api/history/:symbol', async (req,res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const cached = getCache(`history_${sym}`);
    if (cached) return res.json(cached);
    const to = new Date(), from = new Date();
    from.setDate(from.getDate()-90);
    const data = await yf.historical(sym, {
      period1: from.toISOString().split('T')[0],
      period2: to.toISOString().split('T')[0],
      interval: '1d',
    });
    const closes = data.map(d=>d.close).filter(Boolean);
    setCache(`history_${sym}`, closes, TTL_HOUR);
    res.json(closes);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sector heatmap
app.get('/api/sectors', async (req,res) => {
  try {
    const cached = getCache('sectors');
    if (cached) return res.json(cached);
    const sectorETFs = {
      'Technology':    'XLK',
      'Healthcare':    'XLV',
      'Financials':    'XLF',
      'Energy':        'XLE',
      'Consumer':      'XLY',
      'Industrials':   'XLI',
      'Real Estate':   'XLRE',
      'Utilities':     'XLU',
      'Materials':     'XLB',
      'Staples':       'XLP',
      'Communication': 'XLC',
    };
    const etfs = Object.values(sectorETFs);
    const raw = await yf.quote(etfs);
    const result = {};
    for (const q of (Array.isArray(raw)?raw:[raw])) {
      const sector = Object.keys(sectorETFs).find(k=>sectorETFs[k]===q.symbol);
      if (sector && q.regularMarketPrice) {
        result[sector] = {
          etf: q.symbol,
          price: q.regularMarketPrice,
          change: q.regularMarketChangePercent,
          volume: q.regularMarketVolume,
        };
      }
    }
    setCache('sectors', result, TTL);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Earnings calendar
app.get('/api/earnings', async (req,res) => {
  try {
    const cached = getCache('earnings');
    if (cached) return res.json(cached);
    const symbols = FALLBACK_SYMBOLS.slice(4, 20);
    const results = [];
    for (const sym of symbols.slice(0,8)) {
      try {
        const data = await yf.quoteSummary(sym, { modules: ['calendarEvents','defaultKeyStatistics'] });
        const ev = data?.calendarEvents?.earnings;
        if (ev?.earningsDate?.[0]) {
          results.push({
            symbol: sym,
            date: ev.earningsDate[0],
            epsEstimate: ev.epsAverage||null,
            revenueEstimate: ev.revenueAverage||null,
          });
        }
      } catch(e) {}
      await new Promise(r=>setTimeout(r,200));
    }
    results.sort((a,b)=>new Date(a.date)-new Date(b.date));
    setCache('earnings', results, TTL_HOUR);
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Macro data from FRED
app.get('/api/macro', async (req,res) => {
  try {
    const cached = getCache('macro');
    if (cached) return res.json(cached);
    const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
    const FRED_KEY  = 'abcdef1234567890abcdef1234567890'; // public demo key
    const series = { 'Fed Rate':'FEDFUNDS', 'Inflation':'CPIAUCSL', 'GDP Growth':'A191RL1Q225SBEA', 'Unemployment':'UNRATE' };
    const result = {};
    for (const [name, id] of Object.entries(series)) {
      try {
        const url = `${FRED_BASE}?series_id=${id}&api_key=${FRED_KEY}&file_type=json&limit=2&sort_order=desc`;
        const data = await fetchJSON(url);
        const obs = data?.observations;
        if (obs?.length) {
          result[name] = { value: parseFloat(obs[0].value), date: obs[0].date, prev: parseFloat(obs[1]?.value) };
        }
      } catch(e) { result[name] = { value: null, date: null }; }
    }
    setCache('macro', result, TTL_DAY);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// SEC filings summary
app.get('/api/sec/:symbol', async (req,res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const cached = getCache(`sec_${sym}`);
    if (cached) return res.json(cached);
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=%22${sym}%22&dateRange=custom&startdt=${new Date(Date.now()-90*86400000).toISOString().split('T')[0]}&enddt=${new Date().toISOString().split('T')[0]}&forms=10-K,10-Q,8-K`;
    const data = await fetchJSON(searchUrl);
    const filings = (data?.hits?.hits||[]).slice(0,5).map(h=>({
      type: h._source?.form_type,
      date: h._source?.file_date,
      title: h._source?.display_names?.[0]||sym,
      description: h._source?.period_of_report,
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${sym}&type=10-K&dateb=&owner=include&count=10`,
    }));
    setCache(`sec_${sym}`, filings, TTL_DAY);
    res.json(filings);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Research papers from arxiv
app.get('/api/research/:symbol', async (req,res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const cached = getCache(`research_${sym}`);
    if (cached) return res.json(cached);
    const company = req.query.name || sym;
    const url = `https://export.arxiv.org/api/query?search_query=ti:${encodeURIComponent(company)}+OR+abs:${encodeURIComponent(sym)}&start=0&max_results=5&sortBy=submittedDate&sortOrder=descending&cat=q-fin`;
    const xml = await (await (await import('node-fetch')).default(url)).text();
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m=>{
      const e = m[1];
      const title   = (e.match(/<title>(.*?)<\/title>/)?.[1]||'').replace(/\n/g,' ').trim();
      const summary = (e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]||'').replace(/\n/g,' ').trim().slice(0,200)+'...';
      const link    = e.match(/href="(.*?)"/)?.[1]||'';
      const date    = e.match(/<published>(.*?)<\/published>/)?.[1]?.slice(0,10)||'';
      return { title, summary, link, date };
    }).filter(e=>e.title);
    setCache(`research_${sym}`, entries, TTL_DAY);
    res.json(entries);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// News
app.get('/api/news', async (req,res) => {
  try {
    const cached = getCache('news');
    if (cached) return res.json(cached);
    const data = await yf.search('stock market', { newsCount: 20, quotesCount: 0 });
    const news = (data?.news||[]).slice(0,15).map(n=>({
      title: n.title, url: n.link, source: n.publisher,
      date: new Date((n.providerPublishTime||0)*1000).toISOString(),
    }));
    setCache('news', news, TTL);
    res.json(news);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Stock news
app.get('/api/news/:symbol', async (req,res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const cached = getCache(`news_${sym}`);
    if (cached) return res.json(cached);
    const data = await yf.search(sym, { newsCount: 8, quotesCount: 0 });
    const news = (data?.news||[]).map(n=>({
      title: n.title, url: n.link, source: n.publisher,
      date: new Date((n.providerPublishTime||0)*1000).toISOString(),
    }));
    setCache(`news_${sym}`, news, TTL);
    res.json(news);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AI Analysis — 4 levels
app.get('/api/analyze/:symbol', async (req,res) => {
  try {
    const sym   = req.params.symbol.toUpperCase();
    const level = req.query.level||'novice';
    const key   = `analyze_${sym}_${level}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const [quotesRaw, histData, newsData] = await Promise.all([
      yf.quote(sym),
      yf.historical(sym, {
        period1: new Date(Date.now()-90*86400000).toISOString().split('T')[0],
        period2: new Date().toISOString().split('T')[0],
        interval: '1d',
      }),
      yf.search(sym, { newsCount: 3, quotesCount: 0 }),
    ]);

    const q = Array.isArray(quotesRaw)?quotesRaw[0]:quotesRaw;
    if (!q) return res.status(404).json({ error: 'Symbol not found' });

    const closes = histData.map(d=>d.close).filter(Boolean);
    const rsi    = calcRSI(closes);
    const sma50  = calcSMA(closes, Math.min(50,closes.length));
    const sma20  = calcSMA(closes, Math.min(20,closes.length));
    const ema12  = calcEMA(closes, Math.min(12,closes.length));
    const ema26  = calcEMA(closes, Math.min(26,closes.length));
    const macd   = ema12&&ema26?+(ema12-ema26).toFixed(3):null;
    const wkChg  = closes.length>=5?+((closes[closes.length-1]-closes[closes.length-5])/closes[closes.length-5]*100).toFixed(2):null;
    const moChg  = closes.length>=20?+((closes[closes.length-1]-closes[closes.length-20])/closes[closes.length-20]*100).toFixed(2):null;
    const recentNews = (newsData?.news||[]).slice(0,3).map(n=>n.title).join('; ');

    const stockCtx = `
STOCK: ${sym} — ${q.shortName||sym}
Price: $${q.regularMarketPrice} | Today: ${q.regularMarketChangePercent?.toFixed(2)}%
52W Range: $${q.fiftyTwoWeekLow} — $${q.fiftyTwoWeekHigh}
Market Cap: $${(q.marketCap/1e9)?.toFixed(1)}B | P/E: ${q.trailingPE?.toFixed(1)||'N/A'} | Beta: ${q.beta?.toFixed(2)||'N/A'}
Volume: ${q.regularMarketVolume?.toLocaleString()} (Avg: ${q.averageDailyVolume3Month?.toLocaleString()||'N/A'})
RSI(14): ${rsi||'N/A'} | MACD: ${macd||'N/A'} | SMA20: $${sma20} | SMA50: $${sma50}
1W: ${wkChg||'N/A'}% | 1M: ${moChg||'N/A'}%
Recent news: ${recentNews||'None'}
    `.trim();

    const prompts = {
      novice: `You are ARIA, the AI analyst for TRADVIX — the world's most advanced stock intelligence platform. Analyze ${sym} for a complete beginner who knows nothing about investing. Be warm, clear, and encouraging. Use everyday language. Give a definitive BUY, HOLD, or SELL call with a simple reason why.

${stockCtx}

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:
RECOMMENDATION: [BUY/HOLD/SELL]
IN SIMPLE TERMS: [2-3 sentences a 15-year-old would understand — explain what the company does and why to buy/hold/sell]
WHAT THIS MEANS FOR YOU: [One practical sentence about what action to consider]
RISK LEVEL: [LOW / MEDIUM / HIGH] — [one sentence why]`,

      intermediate: `You are ARIA, the AI analyst for TRADVIX. Analyze ${sym} for an intermediate investor who understands basic concepts like P/E ratios and moving averages. Reference the technicals. Give a clear recommendation with specific price levels.

${stockCtx}

FORMAT:
RECOMMENDATION: [STRONG BUY / BUY / HOLD / SELL / STRONG SELL]
ANALYSIS: [3-4 sentences covering price action, key technical signals, and fundamental context]
ENTRY POINT: [$X — $Y range with reasoning]
STOP LOSS: [$X — why this level]
PRICE TARGET: [$X in [timeframe] — reasoning]
RISK/REWARD: [X:1]
RISK LEVEL: [LOW/MEDIUM/HIGH]`,

      expert: `You are ARIA, a world-class quantitative analyst at TRADVIX. Provide institutional-grade technical and fundamental analysis for an experienced trader. Be precise, direct, and professional. No hand-holding.

${stockCtx}

FORMAT:
SIGNAL: [STRONG BUY/BUY/HOLD/SELL/STRONG SELL] | Conviction: [HIGH/MEDIUM/LOW]
TECHNICAL SETUP: [Multi-timeframe analysis, key levels, pattern recognition]
MOMENTUM ANALYSIS: [RSI divergence, MACD histogram, volume profile]
KEY LEVELS: Support $X, $X | Resistance $X, $X
TRADE STRUCTURE: Entry $X | Stop $X | T1 $X | T2 $X | R:R [X:1]
FUNDAMENTAL OVERLAY: [Valuation, sector positioning, catalyst timeline]
RISK FACTORS: [Top 3 specific risks with probability assessment]`,

      deep: `You are ARIA, Chief Investment Analyst at TRADVIX — the most sophisticated AI stock analysis platform in the world. Provide the deepest possible multi-dimensional analysis combining technical analysis, fundamental valuation, macro context, sentiment analysis, and probabilistic scenario modeling. This analysis should rival what a top-tier hedge fund would produce.

${stockCtx}

STRUCTURE YOUR ANALYSIS:

1. EXECUTIVE VERDICT
[One powerful paragraph with your overall assessment and conviction level]

2. TECHNICAL ANALYSIS
[Multi-timeframe breakdown: daily, weekly trends. Key patterns, momentum indicators, volume analysis, support/resistance architecture]

3. FUNDAMENTAL ASSESSMENT  
[Valuation vs peers, business quality score, growth trajectory, margin trends, balance sheet strength]

4. MACRO & SECTOR CONTEXT
[How Fed policy, inflation, and sector rotation affect this specific stock right now]

5. SENTIMENT & POSITIONING
[News sentiment, analyst consensus shifts, institutional buying/selling signals from volume]

6. SCENARIO ANALYSIS
Bull Case ($X target, X% probability): [Specific catalyst and timeline]
Base Case ($X target, X% probability): [Most likely path]
Bear Case ($X target, X% probability): [Key risk that materializes]

7. TRADE RECOMMENDATION
[Specific position sizing, entry structure, risk management, timeframe]

8. CONFIDENCE SCORE: [X/10]
[Why this score — what would change it higher or lower]`,
    };

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompts[level]||prompts.novice }],
      temperature: 0.65,
      max_tokens: level==='deep'?2000:900,
    });

    const result = {
      symbol: sym, level,
      price: q.regularMarketPrice,
      change: q.regularMarketChangePercent,
      analysis: completion.choices[0]?.message?.content||'Analysis unavailable',
      technicals: { rsi, macd, sma20, sma50, wkChg, moChg },
      timestamp: new Date().toISOString(),
      model: 'Llama 3.3 70B (Groq)',
    };

    setCache(key, result, TTL_HOUR);
    res.json(result);
  } catch(e) {
    console.error('Analysis error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ARIA Chat — ask anything about any stock
app.post('/api/chat', async (req,res) => {
  try {
    const { message, symbol, history=[] } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });

    let context = '';
    if (symbol) {
      try {
        const q = await yf.quote(symbol.toUpperCase());
        const qq = Array.isArray(q)?q[0]:q;
        if (qq) context = `Current data for ${symbol}: Price $${qq.regularMarketPrice}, Change ${qq.regularMarketChangePercent?.toFixed(2)}%, Market Cap $${(qq.marketCap/1e9)?.toFixed(1)}B, P/E ${qq.trailingPE?.toFixed(1)||'N/A'}.`;
      } catch(e) {}
    }

    const messages = [
      { role: 'system', content: `You are ARIA, the world's most advanced AI stock analyst for TRADVIX. You are confident, knowledgeable, and direct. You have deep expertise in technical analysis, fundamental analysis, macroeconomics, and quantitative finance. Always give specific, actionable answers. Never say "I cannot" — always provide your best analysis. ${context}` },
      ...history.slice(-6),
      { role: 'user', content: message },
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.7,
      max_tokens: 600,
    });

    res.json({ response: completion.choices[0]?.message?.content||'No response', model: 'Llama 3.3 70B' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Keep alive
setInterval(async () => {
  try {
    const { default: fetch } = await import('node-fetch');
    const url = process.env.RENDER_EXTERNAL_URL||'https://tradvix-backend.onrender.com';
    await fetch(`${url}/health`);
    console.log('💓 Alive');
  } catch(e) {}
}, 840000);

const PORT = process.env.PORT||4000;
app.listen(PORT, () => {
  console.log(`\n🚀 TRADVIX Backend v4.0 — http://localhost:${PORT}`);
  console.log(`🤖 Groq AI · 📊 Yahoo Finance · 📄 SEC · 🔬 arxiv`);
  console.log(`✅ Endpoints: quotes, gainers, losers, premarket, sectors, earnings, macro, sec, research, news, analyze, chat\n`);
});
