const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_KEY });
const supabase = createClient(
  'https://xpjduksasbaxhhbgdmiz.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);
const JWT_SECRET = process.env.JWT_SECRET || 'tradvix_secret_2026_xpjduksas';
const TD_KEY = process.env.TD_KEY || '8d1f203be4d24ff8ab598b2e7b464aab';

// ── CACHE ─────────────────────────────────────────────────────
const cache = {};
const setCache = (k,d,t=300000) => { cache[k]={data:d,time:Date.now(),ttl:t}; };
const getCache = (k) => { const c=cache[k]; if(!c)return null; if(Date.now()-c.time>c.ttl){delete cache[k];return null;} return c.data; };
const TTL_HOUR = 3600000;
const TTL_DAY = 86400000;

// ── SYMBOLS ───────────────────────────────────────────────────
const SYMBOLS = [
  'SPY','QQQ','DIA',
  'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AVGO',
  'AMD','NFLX','JPM','GS','V','MA','BAC','XOM','CVX',
  'LLY','JNJ','UNH','WMT','COST','HD','NKE','BA','DIS',
  'BRK-B','PG','MRK','ABBV','CRM','MCD','TXN'
];

// ── TWELVE DATA FETCH ─────────────────────────────────────────
async function tdFetch(path) {
  const { default: fetch } = await import('node-fetch');
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://api.twelvedata.com${path}${sep}apikey=${TD_KEY}`);
  if (!res.ok) throw new Error(`TD error ${res.status}`);
  return res.json();
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
function authMiddleware(req,res,next){
  const token=req.headers.authorization?.replace('Bearer ','');
  if(!token) return res.status(401).json({error:'No token'});
  try{ req.user=jwt.verify(token,JWT_SECRET); next(); }
  catch(e){ res.status(401).json({error:'Invalid token'}); }
}

// ── HEALTH ────────────────────────────────────────────────────
app.get('/health',(req,res)=>res.json({
  status:'✅ TRADVIX Backend v7.0 — Twelve Data',
  time:new Date().toISOString()
}));

// ── AUTH ──────────────────────────────────────────────────────
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
    const quotes = {};
    for(let i=0;i<SYMBOLS.length;i+=5){
      const batch=SYMBOLS.slice(i,i+5);
      try{
        const data = await tdFetch(`/quote?symbol=${batch.join(',')}`);
        const items = typeof data==='object'&&!Array.isArray(data)
          ? Object.values(data).filter(v=>v&&typeof v==='object'&&v.symbol)
          : (Array.isArray(data)?data:[]);
        for(const q of items){
          if(!q?.symbol||q?.code==='error'||q?.status==='error') continue;
          quotes[q.symbol] = {
            c:parseFloat(q.close||0),
            d:parseFloat(q.change||0),
            dp:parseFloat(q.percent_change||0),
            o:parseFloat(q.open||0),
            h:parseFloat(q.high||0),
            l:parseFloat(q.low||0),
            pc:parseFloat(q.previous_close||0),
            v:parseInt(q.volume||0),
            mkt:0,pe:0,sector:'',beta:null,
            fiftyTwoWeekHigh:parseFloat(q.fifty_two_week?.high||0)||null,
            fiftyTwoWeekLow:parseFloat(q.fifty_two_week?.low||0)||null,
            name:q.name||q.symbol
          };
        }
      }catch(e){ console.log('Batch error:',e.message); }
      await new Promise(r=>setTimeout(r,300));
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
    const syms = SYMBOLS.slice(3).join(',');
    const data = await tdFetch(`/quote?symbol=${syms}`);
    const items = typeof data==='object'&&!Array.isArray(data)
      ? Object.values(data).filter(v=>v&&typeof v==='object'&&v.symbol)
      : (Array.isArray(data)?data:[]);
    const gainers = items
      .filter(q=>q?.code!=='error'&&q?.status!=='error'&&parseFloat(q.percent_change||0)>0)
      .sort((a,b)=>parseFloat(b.percent_change||0)-parseFloat(a.percent_change||0))
      .slice(0,10)
      .map(q=>({
        symbol:q.symbol,name:q.name||q.symbol,
        price:parseFloat(q.close||0),
        changesPercentage:parseFloat(q.percent_change||0),
        change:parseFloat(q.change||0),
        volume:parseInt(q.volume||0),
        marketCap:0
      }));
    setCache('gainers',gainers,300000);
    res.json(gainers);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── LOSERS ────────────────────────────────────────────────────
app.get('/api/losers', async (req,res) => {
  try{
    const c=getCache('losers'); if(c) return res.json(c);
    const syms = SYMBOLS.slice(3).join(',');
    const data = await tdFetch(`/quote?symbol=${syms}`);
    const items = typeof data==='object'&&!Array.isArray(data)
      ? Object.values(data).filter(v=>v&&typeof v==='object'&&v.symbol)
      : (Array.isArray(data)?data:[]);
    const losers = items
      .filter(q=>q?.code!=='error'&&q?.status!=='error'&&parseFloat(q.percent_change||0)<0)
      .sort((a,b)=>parseFloat(a.percent_change||0)-parseFloat(b.percent_change||0))
      .slice(0,10)
      .map(q=>({
        symbol:q.symbol,name:q.name||q.symbol,
        price:parseFloat(q.close||0),
        changesPercentage:parseFloat(q.percent_change||0),
        change:parseFloat(q.change||0),
        volume:parseInt(q.volume||0),
        marketCap:0
      }));
    setCache('losers',losers,300000);
    res.json(losers);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── SECTORS ───────────────────────────────────────────────────
app.get('/api/sectors', async (req,res) => {
  try{
    const c=getCache('sectors'); if(c) return res.json(c);
    const etfs={Technology:'XLK',Healthcare:'XLV',Financials:'XLF',Energy:'XLE',Consumer:'XLY',Industrials:'XLI','Real Estate':'XLRE',Utilities:'XLU',Materials:'XLB',Staples:'XLP',Communication:'XLC'};
    const syms=Object.values(etfs).join(',');
    const data=await tdFetch(`/quote?symbol=${syms}`);
    const items=Array.isArray(data)?data:Object.values(data);
    const result={};
    for(const q of items){
      const sector=Object.keys(etfs).find(k=>etfs[k]===q.symbol);
      if(sector&&q.status!=='error') result[sector]={
        etf:q.symbol,
        price:parseFloat(q.close||0),
        change:parseFloat(q.percent_change||0),
        volume:parseInt(q.volume||0)
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
    const data=await tdFetch('/earnings/calendar?period=next_3months');
    const result=(Array.isArray(data?.earnings)?data.earnings:[]).slice(0,8).map(e=>({
      symbol:e.symbol,date:e.date,
      epsEstimate:e.eps_estimate||null,
      revenueEstimate:e.revenue_estimate||null
    }));
    setCache('earnings',result,TTL_HOUR);
    res.json(result);
  }catch(e){
    // Fallback static earnings
    res.json([
      {symbol:'MSFT',date:'2026-04-29',epsEstimate:null,revenueEstimate:81400000000},
      {symbol:'GOOGL',date:'2026-04-29',epsEstimate:null,revenueEstimate:106900000000},
      {symbol:'AMZN',date:'2026-04-29',epsEstimate:null,revenueEstimate:177200000000},
      {symbol:'META',date:'2026-04-29',epsEstimate:null,revenueEstimate:55600000000},
      {symbol:'AAPL',date:'2026-04-30',epsEstimate:null,revenueEstimate:109700000000},
      {symbol:'NVDA',date:'2026-05-20',epsEstimate:null,revenueEstimate:78800000000}
    ]);
  }
});

// ── NEWS ──────────────────────────────────────────────────────
app.get('/api/news', async (req,res) => {
  try{
    const c=getCache('news'); if(c) return res.json(c);
    const { default:fetch } = await import('node-fetch');
    const data=await(await fetch(`https://api.twelvedata.com/news?type=general&count=20&apikey=${TD_KEY}`)).json();
    const result=(Array.isArray(data?.data)?data.data:[]).slice(0,15).map(n=>({
      title:n.title,url:n.url,
      source:n.source||'News',
      date:n.datetime||new Date().toISOString()
    }));
    setCache('news',result,300000);
    res.json(result);
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/news/:symbol', async (req,res) => {
  try{
    const sym=req.params.symbol.toUpperCase();
    const c=getCache('news_'+sym); if(c) return res.json(c);
    const { default:fetch } = await import('node-fetch');
    const data=await(await fetch(`https://api.twelvedata.com/news?symbol=${sym}&count=8&apikey=${TD_KEY}`)).json();
    const result=(Array.isArray(data?.data)?data.data:[]).map(n=>({
      title:n.title,url:n.url,
      source:n.source||'News',
      date:n.datetime||new Date().toISOString()
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
    const sym=req.params.symbol.toUpperCase();
    const c=getCache('hist_'+sym); if(c) return res.json(c);
    const data=await tdFetch(`/time_series?symbol=${sym}&interval=1day&outputsize=90`);
    const closes=(data?.values||[]).map(d=>parseFloat(d.close)).filter(Boolean).reverse();
    setCache('hist_'+sym,closes,TTL_HOUR);
    res.json(closes);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── ANALYZE ───────────────────────────────────────────────────
app.get('/api/analyze/:symbol', authMiddleware, async (req,res) => {
  try{
    const sym=req.params.symbol.toUpperCase();
    const level=req.query.level||'novice';
    const key=`analyze_${sym}_${level}`;
    const c=getCache(key); if(c) return res.json(c);

    const [quoteData,histData] = await Promise.all([
      tdFetch(`/quote?symbol=${sym}`),
      tdFetch(`/time_series?symbol=${sym}&interval=1day&outputsize=90`)
    ]);

    const q=Array.isArray(quoteData)?quoteData[0]:quoteData;
    if(!q||q.status==='error') return res.status(404).json({error:'Symbol not found'});

    const closes=(histData?.values||[]).map(d=>parseFloat(d.close)).filter(Boolean).reverse();

    function calcRSI(c,n=14){if(!c||c.length<n+1)return null;let g=0,l=0;for(let i=1;i<=n;i++){const d=c[i]-c[i-1];d>0?g+=d:l+=Math.abs(d);}let ag=g/n,al=l/n;for(let i=n+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(n-1)+(d>0?d:0))/n;al=(al*(n-1)+(d<0?Math.abs(d):0))/n;}return al===0?100:+(100-100/(1+ag/al)).toFixed(1);}
    function calcSMA(a,n){if(!a||a.length<n)return null;return +(a.slice(-n).reduce((s,v)=>s+v,0)/n).toFixed(2);}
    function calcEMA(a,n){if(!a||a.length<n)return null;const k=2/(n+1);let e=a.slice(0,n).reduce((s,v)=>s+v,0)/n;for(let i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return +e.toFixed(2);}

    const rsi=calcRSI(closes);
    const sma50=calcSMA(closes,Math.min(50,closes.length));
    const sma20=calcSMA(closes,Math.min(20,closes.length));
    const ema12=calcEMA(closes,Math.min(12,closes.length));
    const ema26=calcEMA(closes,Math.min(26,closes.length));
    const macd=ema12&&ema26?+(ema12-ema26).toFixed(3):null;
    const price=parseFloat(q.close||q.price||0);
    const change=parseFloat(q.percent_change||0);

    const stockCtx=`Symbol: ${sym} | Price: $${price} | Change: ${change.toFixed(2)}%
RSI: ${rsi||'N/A'} | MACD: ${macd||'N/A'} | SMA20: ${sma20} | SMA50: ${sma50}`;

    const prompts={
      novice:`You are ARIA, AI analyst for Fintel Quantum. Analyze ${sym} for a beginner. Plain English, no jargon.\n\n${stockCtx}\n\nFormat:\nRECOMMENDATION: [BUY/HOLD/SELL]\nEXPLANATION: [2-3 simple sentences]\nTIP: [One action]\n\nEnd: "For informational purposes only. Not financial advice."`,
      intermediate:`You are ARIA, AI analyst for Fintel Quantum.\n\n${stockCtx}\n\nFormat:\nRECOMMENDATION: [STRONG BUY/BUY/HOLD/SELL/STRONG SELL]\nANALYSIS: [3-4 sentences]\nENTRY: [Price range]\nSTOP LOSS: [Level]\nTARGET: [Price target]\nRISK: [LOW/MEDIUM/HIGH]\n\nEnd: "For informational purposes only. Not financial advice."`,
      expert:`You are ARIA, expert analyst for Fintel Quantum.\n\n${stockCtx}\n\nFormat:\nSIGNAL: [BUY/HOLD/SELL] | Conviction: [HIGH/MEDIUM/LOW]\nTECHNICAL: [Detailed]\nMOMENTUM: [RSI/MACD]\nSTRUCTURE: [Support/resistance]\nTRADE PLAN: [Entry/stop/target]\n\nEnd: "For informational purposes only. Not financial advice."`,
      deep:`You are ARIA, world-class analyst for Fintel Quantum.\n\n${stockCtx}\n\n1. EXECUTIVE SUMMARY\n2. TECHNICAL ANALYSIS\n3. RISK FACTORS\n4. PRICE SCENARIOS Bull/Base/Bear\n5. RECOMMENDATION\n6. CONFIDENCE SCORE /10\n\nEnd: "For informational purposes only. Not financial advice."`
    };

    const completion=await groq.chat.completions.create({
      model:'llama-3.3-70b-versatile',
      messages:[{role:'user',content:prompts[level]||prompts.novice}],
      temperature:0.65,
      max_tokens:level==='deep'?2000:900
    });

    const result={symbol:sym,level,price,change,
      analysis:completion.choices[0]?.message?.content||'Unavailable',
      technicals:{rsi,macd,sma20,sma50},
      timestamp:new Date().toISOString(),model:'Llama 3.3 70B'};
    setCache(key,result,TTL_HOUR);
    res.json(result);
  }catch(e){ console.error('Analysis error:',e.message); res.status(500).json({error:e.message}); }
});

// ── CHAT ──────────────────────────────────────────────────────
app.post('/api/chat', authMiddleware, async (req,res) => {
  try{
    const{message,symbol,history=[]}=req.body;
    if(!message) return res.status(400).json({error:'No message'});
    const messages=[
      {role:'system',content:`You are ARIA, AI research analyst for Fintel Quantum. Helpful and knowledgeable. Always end with "For informational purposes only. Not financial advice." ${symbol?`Context: ${symbol}`:''}`},
      ...history.slice(-6),
      {role:'user',content:message}
    ];
    const completion=await groq.chat.completions.create({
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
    const {default:fetch}=await import('node-fetch');
    const url=`https://export.arxiv.org/api/query?search_query=ti:${encodeURIComponent(sym)}&start=0&max_results=5&sortBy=submittedDate&sortOrder=descending`;
    const xml=await(await fetch(url)).text();
    const entries=[...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m=>{
      const e=m[1];
      const title=(e.match(/<title>([^<]*)<\/title>/)?.[1]||'').replace(/\s+/g,' ').trim();
      const summary=(e.match(/<summary>([^<]*)<\/summary>/)?.[1]||'').replace(/\s+/g,' ').trim().slice(0,200)+'...';
      const link=e.match(/href="([^"]*)"/)?.[1]||'';
      const date=e.match(/<published>([^<]*)<\/published>/)?.[1]?.slice(0,10)||'';
      return{title,summary,link,date};
    }).filter(e=>e.title);
    setCache('research_'+sym,entries,TTL_DAY);
    res.json(entries);
  }catch(e){ res.status(500).json({error:e.message}); }
});

const PORT=process.env.PORT||4000;
app.listen(PORT,()=>{
  console.log(`\n🚀 TRADVIX Backend v7.0 — Twelve Data`);
  console.log(`📊 Twelve Data API — 800 calls/day`);
  console.log(`🤖 Groq AI — Llama 3.3 70B`);
  console.log(`http://localhost:${PORT}\n`);
});
// v7 Twelve Data Fri May  1 09:49:15 EDT 2026
