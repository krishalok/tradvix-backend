const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_KEY });
const supabase = createClient(
  'https://xpjduksasbaxhhbgdmiz.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);
const JWT_SECRET = process.env.JWT_SECRET;



// ── CACHE ─────────────────────────────────────────────────────
const cache = {};
const setCache = (k,d,t=300000) => { cache[k] = {data:d, time:Date.now(), ttl:t}; };
const getCache = (k) => { const c=cache[k]; if(!c) return null; if(Date.now()-c.time>c.ttl) { delete cache[k]; return null; } return c.data; };

// ── FMP FETCH ─────────────────────────────────────────────────


// ── SYMBOLS ───────────────────────────────────────────────────
const SYMBOLS = [
  'SPY','QQQ','DIA','IWM',
  'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AVGO',
  'AMD','NFLX','JPM','GS','V','MA','BAC','XOM','CVX',
  'LLY','JNJ','UNH','WMT','COST','HD','NKE','BA','CAT','DIS',
  'BRK-B','PG','PEP','KO','MRK','ABBV','CRM','ACN','MCD','TXN'
];

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
function authMiddleware(req,res,next){
  const token=req.headers.authorization?.replace('Bearer ','');
  if(!token) return res.status(401).json({error:'No token'});
  try{ req.user=jwt.verify(token,JWT_SECRET); next(); }
  catch(e){ res.status(401).json({error:'Invalid token'}); }
}

// ── HEALTH ────────────────────────────────────────────────────
app.get('/health',(req,res)=>res.json({
  status:'✅ TRADVIX Backend v6.0 — FMP',
  time:new Date().toISOString()
}));

// ── AUTH ROUTES ───────────────────────────────────────────────
app.post('/auth/signup', async (req,res) => {
  try{
    const {name,email,password} = req.body;
    if(!name||!email||!password) return res.status(400).json({error:'All fields required'});
    if(password.length<6) return res.status(400).json({error:'Password too short'});
    const {data:existing} = await supabase.from('users').select('id').eq('email',email.toLowerCase()).single();
    if(existing) return res.status(400).json({error:'Email already registered'});
    const password_hash = await bcrypt.hash(password,10);
    const {data:user,error} = await supabase.from('users').insert({name,email:email.toLowerCase(),password_hash,tier:'free'}).select().single();
    if(error) throw error;
    const token = jwt.sign({id:user.id,name:user.name,email:user.email,tier:user.tier},JWT_SECRET,{expiresIn:'30d'});
    res.json({token,user:{id:user.id,name:user.name,email:user.email,tier:user.tier}});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/auth/login', async (req,res) => {
  try{
    const {email,password} = req.body;
    if(!email||!password) return res.status(400).json({error:'All fields required'});
    const {data:user} = await supabase.from('users').select('*').eq('email',email.toLowerCase()).single();
    if(!user) return res.status(400).json({error:'Invalid email or password'});
    const valid = await bcrypt.compare(password,user.password_hash);
    if(!valid) return res.status(400).json({error:'Invalid email or password'});
    const token = jwt.sign({id:user.id,name:user.name,email:user.email,tier:user.tier},JWT_SECRET,{expiresIn:'30d'});
    res.json({token,user:{id:user.id,name:user.name,email:user.email,tier:user.tier}});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/auth/me', authMiddleware, async (req,res) => {
  try{
    const {data:user} = await supabase.from('users').select('id,name,email,tier,created_at').eq('id',req.user.id).single();
    res.json(user);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── QUOTES ────────────────────────────────────────────────────
app.get('/api/quotes', async (req,res) => {
  try{
    const c=getCache('quotes'); if(c) return res.json(c);
    const raw = await yf.quote(SYMBOLS);
    const data = Array.isArray(raw)?raw:[raw];
    const quotes = {};
    for(const q of data) {
      if(!q?.symbol||!q?.regularMarketPrice) continue;
      quotes[q.symbol] = {
        c:+q.regularMarketPrice.toFixed(2),
        d:+(q.regularMarketChange||0).toFixed(2),
        dp:+(q.regularMarketChangePercent||0).toFixed(2),
        o:+(q.regularMarketOpen||q.regularMarketPrice).toFixed(2),
        h:+(q.regularMarketDayHigh||q.regularMarketPrice).toFixed(2),
        l:+(q.regularMarketDayLow||q.regularMarketPrice).toFixed(2),
        pc:+(q.regularMarketPreviousClose||q.regularMarketPrice).toFixed(2),
        v:q.regularMarketVolume||0,
        mkt:q.marketCap||0,
        pe:q.trailingPE||0,
        name:q.shortName||q.longName||q.symbol,
        sector:q.sector||'',
        fiftyTwoWeekHigh:q.fiftyTwoWeekHigh||null,
        fiftyTwoWeekLow:q.fiftyTwoWeekLow||null,
        beta:q.beta||null
      };
    }
    setCache('quotes',quotes);
    setCache('quotes_backup',quotes,86400000);
    res.json(quotes);
  }catch(e){
    const backup=getCache('quotes_backup');
    if(backup) return res.json(backup);
    res.status(500).json({error:e.message});
  }
});

// ── GAINERS ───────────────────────────────────────────────────
app.get('/api/gainers', async (req,res) => {
  try{
    const c=getCache('gainers'); if(c) return res.json(c);
    const data = await yf.screener({scrIds:'day_gainers',count:10});
    const result = (data?.quotes||[]).map(q=>({
      symbol:q.symbol,name:q.shortName||q.symbol,
      price:q.regularMarketPrice,
      changesPercentage:q.regularMarketChangePercent,
      change:q.regularMarketChange,
      volume:q.regularMarketVolume,
      marketCap:q.marketCap
    }));
    setCache('gainers',result);
    res.json(result);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── LOSERS ────────────────────────────────────────────────────
app.get('/api/losers', async (req,res) => {
  try{
    const c=getCache('losers'); if(c) return res.json(c);
    const data = await yf.screener({scrIds:'day_losers',count:10});
    const result = (data?.quotes||[]).map(q=>({
      symbol:q.symbol,name:q.shortName||q.symbol,
      price:q.regularMarketPrice,
      changesPercentage:q.regularMarketChangePercent,
      change:q.regularMarketChange,
      volume:q.regularMarketVolume,
      marketCap:q.marketCap
    }));
    setCache('losers',result);
    res.json(result);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── SECTORS ───────────────────────────────────────────────────
app.get('/api/sectors', async (req,res) => {
  try{
    const c=getCache('sectors'); if(c) return res.json(c);
    const etfs = {
      Technology:'XLK',Healthcare:'XLV',Financials:'XLF',
      Energy:'XLE',Consumer:'XLY',Industrials:'XLI',
      'Real Estate':'XLRE',Utilities:'XLU',Materials:'XLB',
      Staples:'XLP',Communication:'XLC'
    };
    const syms = Object.values(etfs);
    const data = await yf.quote(syms);
    const result = {};
    for(const q of (Array.isArray(data)?data:[data])) {
      const sector = Object.keys(etfs).find(k=>etfs[k]===q.symbol);
      if(sector) result[sector] = {
        etf:q.symbol,
        price:q.regularMarketPrice,
        change:q.regularMarketChangePercent||0,
        volume:q.regularMarketVolume||0
      };
    }
    setCache('sectors',result,300000);
    res.json(result);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── EARNINGS ──────────────────────────────────────────────────
app.get('/api/earnings', async (req,res) => {
  try{
    const c=getCache('earnings'); if(c) return res.json(c);
    const syms=['MSFT','GOOGL','AMZN','META','AAPL','NVDA','AVGO','TSLA'];
    const result=[];
    for(const sym of syms){
      try{
        const d=await yf.quoteSummary(sym,{modules:['calendarEvents']});
        const ev=d?.calendarEvents?.earnings;
        if(ev?.earningsDate?.[0]){
          result.push({symbol:sym,date:ev.earningsDate[0],
            epsEstimate:ev.epsAverage||null,revenueEstimate:ev.revenueAverage||null});
        }
      }catch(e){}
      await new Promise(r=>setTimeout(r,100));
    }
    result.sort((a,b)=>new Date(a.date)-new Date(b.date));
    setCache('earnings',result,3600000);
    res.json(result);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── NEWS ──────────────────────────────────────────────────────
app.get('/api/news', async (req,res) => {
  try{
    const c=getCache('news'); if(c) return res.json(c);
    const data = await yf.search('stock market',{newsCount:20,quotesCount:0});
    const result = (data?.news||[]).slice(0,15).map(n=>({
      title:n.title,url:n.link,
      source:n.publisher,
      date:new Date((n.providerPublishTime||0)*1000).toISOString()
    }));
    setCache('news',result,300000);
    res.json(result);
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/news/:symbol', async (req,res) => {
  try{
    const sym = req.params.symbol.toUpperCase();
    const c=getCache('news_'+sym); if(c) return res.json(c);
    const data = await yf.search(sym,{newsCount:8,quotesCount:0});
    const result = (data?.news||[]).map(n=>({
      title:n.title,url:n.link,
      source:n.publisher,
      date:new Date((n.providerPublishTime||0)*1000).toISOString()
    }));
    setCache('news_'+sym,result,300000);
    res.json(result);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── MACRO ─────────────────────────────────────────────────────
app.get('/api/macro', async (req,res) => {
  res.json({
    'Fed Rate':{value:5.33,date:'2024-09-01',prev:5.5},
    'Inflation':{value:2.4,date:'2024-09-01',prev:2.5},
    'Unemployment':{value:4.1,date:'2024-09-01',prev:4.2},
    'GDP Growth':{value:2.8,date:'2024-09-01',prev:3.0}
  });
});

// ── HISTORY ───────────────────────────────────────────────────
app.get('/api/history/:symbol', async (req,res) => {
  try{
    const sym = req.params.symbol.toUpperCase();
    const c=getCache('hist_'+sym); if(c) return res.json(c);
    const to=new Date(),from=new Date();
    from.setDate(from.getDate()-90);
    const data=await yf.historical(sym,{
      period1:from.toISOString().split('T')[0],
      period2:to.toISOString().split('T')[0],interval:'1d'
    });
    const closes=data.map(d=>d.close).filter(Boolean);
    setCache('hist_'+sym,closes,3600000);
    res.json(closes);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── ANALYZE ───────────────────────────────────────────────────
app.get('/api/analyze/:symbol', authMiddleware, async (req,res) => {
  try{
    const sym = req.params.symbol.toUpperCase();
    const level = req.query.level||'novice';
    const key = `analyze_${sym}_${level}`;
    const c=getCache(key); if(c) return res.json(c);

    const [quoteData, histData, newsData] = await Promise.all([
      fmpFetch(`/quote?symbol=${sym}`),
      fmpFetch(`/historical-price-eod/light?symbol=${sym}&limit=90`),
      fmpFetch(`/news/stock?symbols=${sym}&limit=3`)
    ]);

    const q = Array.isArray(quoteData)?quoteData[0]:quoteData;
    if(!q) return res.status(404).json({error:'Symbol not found'});

    const closes = (Array.isArray(histData)?histData:[]).map(d=>d.close).filter(Boolean).reverse();

    // Technicals
    function calcRSI(c,n=14){if(!c||c.length<n+1)return null;let g=0,l=0;for(let i=1;i<=n;i++){const d=c[i]-c[i-1];d>0?g+=d:l+=Math.abs(d);}let ag=g/n,al=l/n;for(let i=n+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(n-1)+(d>0?d:0))/n;al=(al*(n-1)+(d<0?Math.abs(d):0))/n;}return al===0?100:+(100-100/(1+ag/al)).toFixed(1);}
    function calcSMA(a,n){if(!a||a.length<n)return null;return +(a.slice(-n).reduce((s,v)=>s+v,0)/n).toFixed(2);}
    function calcEMA(a,n){if(!a||a.length<n)return null;const k=2/(n+1);let e=a.slice(0,n).reduce((s,v)=>s+v,0)/n;for(let i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return +e.toFixed(2);}

    const rsi=calcRSI(closes);
    const sma50=calcSMA(closes,Math.min(50,closes.length));
    const sma20=calcSMA(closes,Math.min(20,closes.length));
    const ema12=calcEMA(closes,Math.min(12,closes.length));
    const ema26=calcEMA(closes,Math.min(26,closes.length));
    const macd=ema12&&ema26?+(ema12-ema26).toFixed(3):null;
    const recentNews=(Array.isArray(newsData)?newsData:[]).slice(0,3).map(n=>n.title).join('; ');

    const stockCtx=`Symbol: ${sym} | Price: $${q.price} | Change: ${q.changePercentage?.toFixed(2)}%
52W: $${q.yearLow} — $${q.yearHigh} | MarketCap: $${(q.marketCap/1e9)?.toFixed(1)}B
RSI: ${rsi||'N/A'} | MACD: ${macd||'N/A'} | SMA20: ${sma20} | SMA50: ${sma50}
News: ${recentNews||'None'}`;

    const prompts={
      novice:`You are ARIA, friendly AI analyst for Fintel Quantum. Analyze ${sym} for a complete beginner. Simple language, no jargon. Clear BUY/HOLD/SELL call.\n\n${stockCtx}\n\nFormat:\nRECOMMENDATION: [BUY/HOLD/SELL]\nSIMPLE EXPLANATION: [2-3 sentences anyone can understand]\nTIP: [One practical action]\n\nEnd with: "This is informational only and not financial advice."`,
      intermediate:`You are ARIA, AI analyst for Fintel Quantum. Analyze for intermediate investor.\n\n${stockCtx}\n\nFormat:\nRECOMMENDATION: [STRONG BUY/BUY/HOLD/SELL/STRONG SELL]\nANALYSIS: [3-4 sentences]\nENTRY: [Price range]\nSTOP LOSS: [Level]\nTARGET: [Price target]\nRISK: [LOW/MEDIUM/HIGH]\n\nEnd with: "For informational purposes only. Not financial advice."`,
      expert:`You are ARIA, expert analyst for Fintel Quantum. Institutional-grade analysis.\n\n${stockCtx}\n\nFormat:\nSIGNAL: [BUY/HOLD/SELL] | Conviction: [HIGH/MEDIUM/LOW]\nTECHNICAL: [Detailed analysis]\nMOMENTUM: [RSI/MACD interpretation]\nSTRUCTURE: [Support/resistance levels]\nTRADE PLAN: [Entry/stop/target R:R]\nCATALYST: [Key risks and catalysts]\n\nEnd with: "For informational purposes only. Not financial advice."`,
      deep:`You are ARIA, world-class analyst for Fintel Quantum. Deepest analysis.\n\n${stockCtx}\n\n1. EXECUTIVE SUMMARY\n2. TECHNICAL ANALYSIS\n3. FUNDAMENTAL ASSESSMENT\n4. RISK FACTORS with probabilities\n5. PRICE SCENARIOS — Bull/Base/Bear\n6. RECOMMENDATION\n7. CONFIDENCE SCORE /10\n\nEnd with: "For informational purposes only. Not financial advice."`
    };

    const completion = await groq.chat.completions.create({
      model:'llama-3.3-70b-versatile',
      messages:[{role:'user',content:prompts[level]||prompts.novice}],
      temperature:0.65,
      max_tokens:level==='deep'?2000:900
    });

    const result={
      symbol:sym,level,
      price:q.regularMarketPrice,
      change:q.regularMarketChangePercent,
      analysis:completion.choices[0]?.message?.content||'Unavailable',
      technicals:{rsi,macd,sma20,sma50},
      timestamp:new Date().toISOString(),
      model:'Llama 3.3 70B'
    };
    setCache(key,result,3600000);
    res.json(result);
  }catch(e){ console.error('Analysis error:',e.message); res.status(500).json({error:e.message}); }
});

// ── CHAT ──────────────────────────────────────────────────────
app.post('/api/chat', authMiddleware, async (req,res) => {
  try{
    const{message,symbol,history=[]}=req.body;
    if(!message) return res.status(400).json({error:'No message'});
    const messages=[
      {role:'system',content:`You are ARIA, AI research analyst for Fintel Quantum. Helpful, knowledgeable, direct. Always end responses with "This is informational only and not financial advice." ${symbol?`Context: analyzing ${symbol}`:''}`},
      ...history.slice(-6),
      {role:'user',content:message}
    ];
    const completion = await groq.chat.completions.create({
      model:'llama-3.3-70b-versatile',messages,temperature:0.7,max_tokens:600
    });
    res.json({response:completion.choices[0]?.message?.content||'No response'});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── RESEARCH ──────────────────────────────────────────────────
app.get('/api/research/:symbol', authMiddleware, async (req,res) => {
  try{
    const sym=req.params.symbol.toUpperCase();
    const c=getCache('research_'+sym); if(c) return res.json(c);
    const{default:fetch}=await import('node-fetch');
    const url=`https://export.arxiv.org/api/query?search_query=ti:${encodeURIComponent(sym)}+OR+abs:${encodeURIComponent(sym)}&start=0&max_results=5&sortBy=submittedDate&sortOrder=descending`;
    const xml=await(await fetch(url)).text();
    const entries=[...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m=>{
      const e=m[1];
      const title=(e.match(/<title>([^<]*)<\/title>/)?.[1]||'').replace(/\s+/g,' ').trim();
      const summary=(e.match(/<summary>([^<]*)<\/summary>/)?.[1]||'').replace(/\s+/g,' ').trim().slice(0,200)+'...';
      const link=e.match(/href="(.*?)"/)?.[1]||'';
      const date=e.match(/<published>(.*?)<\/published>/)?.[1]?.slice(0,10)||'';
      return{title,summary,link,date};
    }).filter(e=>e.title);
    setCache('research_'+sym,entries,86400000);
    res.json(entries);
  }catch(e){ res.status(500).json({error:e.message}); }
});

const PORT=process.env.PORT||4000;
app.listen(PORT,()=>{
  console.log(`\n🚀 TRADVIX Backend v6.0 — FMP Edition`);
  console.log(`📊 Financial Modeling Prep API`);
  console.log(`🤖 Groq AI — Llama 3.3 70B`);
  console.log(`http://localhost:${PORT}\n`);
});
