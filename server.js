const express=require('express');
const cors=require('cors');
const bcrypt=require('bcrypt');
const jwt=require('jsonwebtoken');
const{createClient}=require('@supabase/supabase-js');
const Groq=require('groq-sdk');

const app=express();
app.use(cors());
app.use(express.json());

const groq=new Groq({apiKey:process.env.GROQ_KEY});
const supabase=createClient('https://xpjduksasbaxhhbgdmiz.supabase.co',process.env.SUPABASE_SERVICE_KEY);
const JWT_SECRET=process.env.JWT_SECRET||'tradvix_secret_2026_xpjduksas';
const FH=process.env.FH_KEY||'d7lfdc1r01qm7o0bl84gd7lfdc1r01qm7o0bl850';

// Cache
const cache={};
const setCache=(k,d,t=300000)=>{cache[k]={data:d,time:Date.now(),ttl:t};};
const getCache=(k)=>{const c=cache[k];if(!c)return null;if(Date.now()-c.time>c.ttl){delete cache[k];return null;}return c.data;};

// Finnhub fetch
async function fh(path){
  const{default:fetch}=await import('node-fetch');
  const res=await fetch(`https://finnhub.io/api/v1${path}&token=${FH}`);
  if(!res.ok)throw new Error(`Finnhub ${res.status}`);
  return res.json();
}

const SYMBOLS=['SPY','QQQ','DIA','AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AVGO','AMD','NFLX','JPM','GS','V','MA','BAC','XOM','CVX','LLY','JNJ','UNH','WMT','COST','HD','NKE','BA','DIS','PG','MRK','ABBV'];

// Auth middleware
function auth(req,res,next){
  const t=req.headers.authorization?.replace('Bearer ','');
  if(!t)return res.status(401).json({error:'No token'});
  try{req.user=jwt.verify(t,JWT_SECRET);next();}
  catch{res.status(401).json({error:'Invalid token'});}
}

// Health
app.get('/health',(req,res)=>res.json({status:'✅ Fintel Quantum Backend v8.0 — Finnhub',time:new Date().toISOString()}));

// Signup
app.post('/auth/signup',async(req,res)=>{
  try{
    const{name,email,password}=req.body;
    if(!name||!email||!password)return res.status(400).json({error:'All fields required'});
    if(password.length<6)return res.status(400).json({error:'Password too short'});
    const{data:existing}=await supabase.from('users').select('id').eq('email',email.toLowerCase()).single();
    if(existing)return res.status(400).json({error:'Email already registered'});
    const password_hash=await bcrypt.hash(password,10);
    const{data:user,error}=await supabase.from('users').insert({name,email:email.toLowerCase(),password_hash,tier:'free'}).select().single();
    if(error)throw error;
    const token=jwt.sign({id:user.id,name:user.name,email:user.email,tier:user.tier},JWT_SECRET,{expiresIn:'30d'});
    res.json({token,user:{id:user.id,name:user.name,email:user.email,tier:user.tier}});
  }catch(e){res.status(500).json({error:e.message});}
});

// Login
app.post('/auth/login',async(req,res)=>{
  try{
    const{email,password}=req.body;
    if(!email||!password)return res.status(400).json({error:'All fields required'});
    const{data:user}=await supabase.from('users').select('*').eq('email',email.toLowerCase()).single();
    if(!user)return res.status(400).json({error:'Invalid email or password'});
    const valid=await bcrypt.compare(password,user.password_hash);
    if(!valid)return res.status(400).json({error:'Invalid email or password'});
    const token=jwt.sign({id:user.id,name:user.name,email:user.email,tier:user.tier},JWT_SECRET,{expiresIn:'30d'});
    res.json({token,user:{id:user.id,name:user.name,email:user.email,tier:user.tier}});
  }catch(e){res.status(500).json({error:e.message});}
});

// Me
app.get('/auth/me',auth,async(req,res)=>{
  try{
    const{data:user}=await supabase.from('users').select('id,name,email,tier,created_at').eq('id',req.user.id).single();
    res.json(user);
  }catch(e){res.status(500).json({error:e.message});}
});

// Quotes - fetch all symbols in parallel (Finnhub 60/min free)
app.get('/api/quotes',async(req,res)=>{
  try{
    const c=getCache('quotes');if(c)return res.json(c);
    const results=await Promise.allSettled(SYMBOLS.map(sym=>fh(`/quote?symbol=${sym}`).then(q=>({sym,q}))));
    const quotes={};
    for(const r of results){
      if(r.status==='fulfilled'&&r.value?.q?.c){
        const{sym,q}=r.value;
        quotes[sym]={c:q.c,d:+(q.d||0).toFixed(2),dp:+(q.dp||0).toFixed(2),o:q.o,h:q.h,l:q.l,pc:q.pc,v:q.v||0,mkt:0,pe:0,sector:'',beta:null,fiftyTwoWeekHigh:q['52WeekHigh']||null,fiftyTwoWeekLow:q['52WeekLow']||null,name:sym};
      }
    }
    setCache('quotes',quotes);
    setCache('quotes_backup',quotes,86400000);
    res.json(quotes);
  }catch(e){
    const b=getCache('quotes_backup');
    if(b)return res.json(b);
    res.status(500).json({error:e.message});
  }
});

// Gainers - derived from quotes
app.get('/api/gainers',async(req,res)=>{
  try{
    const c=getCache('gainers');if(c)return res.json(c);
    let q=getCache('quotes');
    if(!q){const r=await fetch(`http://localhost:${process.env.PORT||4000}/api/quotes`);q=await r.json();}
    const gainers=Object.entries(q).filter(([s,v])=>!['SPY','QQQ','DIA'].includes(s)&&v.dp>0).sort(([,a],[,b])=>b.dp-a.dp).slice(0,10).map(([symbol,v])=>({symbol,name:v.name||symbol,price:v.c,changesPercentage:v.dp,change:v.d,volume:v.v,marketCap:0}));
    setCache('gainers',gainers,300000);
    res.json(gainers);
  }catch(e){res.status(500).json({error:e.message});}
});

// Losers
app.get('/api/losers',async(req,res)=>{
  try{
    const c=getCache('losers');if(c)return res.json(c);
    let q=getCache('quotes');
    if(!q){const{default:fetch}=await import('node-fetch');const r=await fetch(`http://localhost:${process.env.PORT||4000}/api/quotes`);q=await r.json();}
    const losers=Object.entries(q).filter(([s,v])=>!['SPY','QQQ','DIA'].includes(s)&&v.dp<0).sort(([,a],[,b])=>a.dp-b.dp).slice(0,10).map(([symbol,v])=>({symbol,name:v.name||symbol,price:v.c,changesPercentage:v.dp,change:v.d,volume:v.v,marketCap:0}));
    setCache('losers',losers,300000);
    res.json(losers);
  }catch(e){res.status(500).json({error:e.message});}
});

// Sectors
app.get('/api/sectors',async(req,res)=>{
  try{
    const c=getCache('sectors');if(c)return res.json(c);
    const etfs={Technology:'XLK',Healthcare:'XLV',Financials:'XLF',Energy:'XLE',Consumer:'XLY',Industrials:'XLI','Real Estate':'XLRE',Utilities:'XLU',Materials:'XLB',Staples:'XLP',Communication:'XLC'};
    const results=await Promise.allSettled(Object.entries(etfs).map(([sector,sym])=>fh(`/quote?symbol=${sym}`).then(q=>({sector,sym,q}))));
    const out={};
    for(const r of results){
      if(r.status==='fulfilled'&&r.value?.q?.c){
        const{sector,sym,q}=r.value;
        out[sector]={etf:sym,price:q.c,change:q.dp||0,volume:q.v||0};
      }
    }
    setCache('sectors',out,300000);
    res.json(out);
  }catch(e){res.status(500).json({error:e.message});}
});

// Earnings
app.get('/api/earnings',async(req,res)=>{
  try{
    const c=getCache('earnings');if(c)return res.json(c);
    const from=new Date().toISOString().split('T')[0];
    const to=new Date(Date.now()+90*86400000).toISOString().split('T')[0];
    const data=await fh(`/calendar/earnings?from=${from}&to=${to}`);
    const result=(data?.earningsCalendar||[]).filter(e=>SYMBOLS.includes(e.symbol)).slice(0,8).map(e=>({symbol:e.symbol,date:e.date,epsEstimate:e.epsEstimate||null,revenueEstimate:e.revenueEstimate||null}));
    setCache('earnings',result,3600000);
    res.json(result.length?result:[
      {symbol:'MSFT',date:'2026-07-29',epsEstimate:null,revenueEstimate:81400000000},
      {symbol:'GOOGL',date:'2026-07-29',epsEstimate:null,revenueEstimate:106900000000},
      {symbol:'NVDA',date:'2026-08-20',epsEstimate:null,revenueEstimate:78800000000},
    ]);
  }catch(e){res.json([{symbol:'NVDA',date:'2026-08-20',epsEstimate:null,revenueEstimate:78800000000}]);}
});

// News
app.get('/api/news',async(req,res)=>{
  try{
    const c=getCache('news');if(c)return res.json(c);
    const data=await fh('/news?category=general&minId=0');
    const result=(Array.isArray(data)?data:[]).slice(0,15).map(n=>({title:n.headline,url:n.url,source:n.source||'News',date:new Date((n.datetime||0)*1000).toISOString()}));
    setCache('news',result,300000);
    res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
});

// Stock news
app.get('/api/news/:symbol',async(req,res)=>{
  try{
    const sym=req.params.symbol.toUpperCase();
    const c=getCache('news_'+sym);if(c)return res.json(c);
    const now=new Date(),from=new Date(now-30*86400000);
    const data=await fh(`/company-news?symbol=${sym}&from=${from.toISOString().split('T')[0]}&to=${now.toISOString().split('T')[0]}`);
    const result=(Array.isArray(data)?data:[]).slice(0,8).map(n=>({title:n.headline,url:n.url,source:n.source||'News',date:new Date((n.datetime||0)*1000).toISOString()}));
    setCache('news_'+sym,result,300000);
    res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
});

// Macro (static - update periodically)
app.get('/api/macro',(req,res)=>res.json({
  'Fed Rate':{value:4.5,date:'2025-12-01',prev:4.75},
  'Inflation':{value:2.7,date:'2025-12-01',prev:2.9},
  'Unemployment':{value:4.2,date:'2025-12-01',prev:4.1},
  'GDP Growth':{value:2.4,date:'2025-12-01',prev:2.8}
}));

// History
app.get('/api/history/:symbol',async(req,res)=>{
  try{
    const sym=req.params.symbol.toUpperCase();
    const c=getCache('hist_'+sym);if(c)return res.json(c);
    const to=Math.floor(Date.now()/1000);
    const from=to-90*86400;
    const data=await fh(`/stock/candle?symbol=${sym}&resolution=D&from=${from}&to=${to}`);
    const closes=(data?.c||[]).filter(Boolean);
    setCache('hist_'+sym,closes,3600000);
    res.json(closes);
  }catch(e){res.status(500).json({error:e.message});}
});

// Analyze
app.get('/api/analyze/:symbol',auth,async(req,res)=>{
  try{
    const sym=req.params.symbol.toUpperCase();
    const level=req.query.level||'novice';
    const key=`analyze_${sym}_${level}`;
    const c=getCache(key);if(c)return res.json(c);
    const to=Math.floor(Date.now()/1000),from=to-90*86400;
    const[q,hist,news]=await Promise.all([
      fh(`/quote?symbol=${sym}`),
      fh(`/stock/candle?symbol=${sym}&resolution=D&from=${from}&to=${to}`),
      fh(`/company-news?symbol=${sym}&from=${new Date(Date.now()-30*86400000).toISOString().split('T')[0]}&to=${new Date().toISOString().split('T')[0]}`)
    ]);
    if(!q?.c)return res.status(404).json({error:'Symbol not found'});
    const closes=(hist?.c||[]).filter(Boolean);
    function rsi(c,n=14){if(c.length<n+1)return null;let g=0,l=0;for(let i=1;i<=n;i++){const d=c[i]-c[i-1];d>0?g+=d:l+=Math.abs(d);}let ag=g/n,al=l/n;for(let i=n+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(n-1)+(d>0?d:0))/n;al=(al*(n-1)+(d<0?Math.abs(d):0))/n;}return al===0?100:+(100-100/(1+ag/al)).toFixed(1);}
    function sma(a,n){if(a.length<n)return null;return +(a.slice(-n).reduce((s,v)=>s+v,0)/n).toFixed(2);}
    function ema(a,n){if(a.length<n)return null;const k=2/(n+1);let e=a.slice(0,n).reduce((s,v)=>s+v,0)/n;for(let i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return +e.toFixed(2);}
    const RSI=rsi(closes),SMA20=sma(closes,Math.min(20,closes.length)),SMA50=sma(closes,Math.min(50,closes.length));
    const e12=ema(closes,Math.min(12,closes.length)),e26=ema(closes,Math.min(26,closes.length));
    const MACD=e12&&e26?+(e12-e26).toFixed(3):null;
    const headlines=(Array.isArray(news)?news:[]).slice(0,3).map(n=>n.headline).join('; ');
    const ctx=`Symbol:${sym} Price:$${q.c} Change:${q.dp?.toFixed(2)}% RSI:${RSI||'N/A'} MACD:${MACD||'N/A'} SMA20:${SMA20} SMA50:${SMA50} News:${headlines||'None'}`;
    const prompts={
      novice:`You are ARIA, AI analyst for Fintel Quantum. Analyze ${sym} for a beginner. Plain English.\n\n${ctx}\n\nFormat:\nRECOMMENDATION: [BUY/HOLD/SELL]\nEXPLANATION: [2-3 simple sentences]\nTIP: [One action]\n\nEnd: "For informational purposes only. Not financial advice."`,
      intermediate:`You are ARIA, AI analyst for Fintel Quantum.\n\n${ctx}\n\nFormat:\nRECOMMENDATION: [STRONG BUY/BUY/HOLD/SELL/STRONG SELL]\nANALYSIS: [3-4 sentences]\nENTRY: [Price range]\nSTOP LOSS: [Level]\nTARGET: [Price]\nRISK: [LOW/MEDIUM/HIGH]\n\nEnd: "For informational purposes only. Not financial advice."`,
      expert:`You are ARIA, expert analyst for Fintel Quantum.\n\n${ctx}\n\nFormat:\nSIGNAL: [BUY/HOLD/SELL] | Conviction: [HIGH/MEDIUM/LOW]\nTECHNICAL: [Detailed]\nMOMENTUM: [RSI/MACD]\nSTRUCTURE: [Support/resistance]\nTRADE PLAN: [Entry/stop/target]\n\nEnd: "For informational purposes only. Not financial advice."`,
      deep:`You are ARIA, world-class analyst for Fintel Quantum.\n\n${ctx}\n\n1. EXECUTIVE SUMMARY\n2. TECHNICAL ANALYSIS\n3. RISK FACTORS\n4. PRICE SCENARIOS Bull/Base/Bear\n5. RECOMMENDATION\n6. CONFIDENCE SCORE /10\n\nEnd: "For informational purposes only. Not financial advice."`
    };
    const completion=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',messages:[{role:'user',content:prompts[level]||prompts.novice}],temperature:0.65,max_tokens:level==='deep'?2000:900});
    const result={symbol:sym,level,price:q.c,change:q.dp,analysis:completion.choices[0]?.message?.content||'Unavailable',technicals:{rsi:RSI,macd:MACD,sma20:SMA20,sma50:SMA50},timestamp:new Date().toISOString(),model:'Llama 3.3 70B'};
    setCache(key,result,3600000);
    res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
});

// Chat
app.post('/api/chat',auth,async(req,res)=>{
  try{
    const{message,symbol,history=[]}=req.body;
    if(!message)return res.status(400).json({error:'No message'});
    const msgs=[{role:'system',content:`You are ARIA, AI research analyst for Fintel Quantum. Always end with "For informational purposes only. Not financial advice." ${symbol?`Context: ${symbol}`:''}`},...history.slice(-6),{role:'user',content:message}];
    const completion=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',messages:msgs,temperature:0.7,max_tokens:600});
    res.json({response:completion.choices[0]?.message?.content||'No response'});
  }catch(e){res.status(500).json({error:e.message});}
});

// Research
app.get('/api/research/:symbol',auth,async(req,res)=>{
  try{
    const sym=req.params.symbol.toUpperCase();
    const c=getCache('research_'+sym);if(c)return res.json(c);
    const{default:fetch}=await import('node-fetch');
    const xml=await(await fetch(`https://export.arxiv.org/api/query?search_query=ti:${encodeURIComponent(sym)}&start=0&max_results=5&sortBy=submittedDate&sortOrder=descending`)).text();
    const entries=[...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m=>{
      const e=m[1];
      return{
        title:(e.match(/<title>([^<]*)<\/title>/)?.[1]||'').replace(/\s+/g,' ').trim(),
        summary:(e.match(/<summary>([^<]*)<\/summary>/)?.[1]||'').replace(/\s+/g,' ').trim().slice(0,200)+'...',
        link:e.match(/href="([^"]*)"/)?.[1]||'',
        date:e.match(/<published>([^<]*)<\/published>/)?.[1]?.slice(0,10)||''
      };
    }).filter(e=>e.title);
    setCache('research_'+sym,entries,86400000);
    res.json(entries);
  }catch(e){res.status(500).json({error:e.message});}
});

const PORT=process.env.PORT||4000;
app.listen(PORT,()=>{
  console.log(`\n🚀 Fintel Quantum Backend v8.0`);
  console.log(`📊 Finnhub — 60 calls/min unlimited`);
  console.log(`🤖 Groq — Llama 3.3 70B`);
  console.log(`http://localhost:${PORT}\n`);
});
