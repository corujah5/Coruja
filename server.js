require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TMDB_TOKEN;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads');
const COMMENTS_FILE = path.join(DATA_DIR, 'comments.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const INVITES_FILE = path.join(DATA_DIR, 'invites.json');
const STATES_DIR = path.join(DATA_DIR, 'states');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(STATES_DIR, { recursive: true });
if (!fs.existsSync(COMMENTS_FILE)) fs.writeFileSync(COMMENTS_FILE, '[]', 'utf8');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}', 'utf8');
if (!fs.existsSync(INVITES_FILE)) fs.writeFileSync(INVITES_FILE, '[]', 'utf8');

app.use(express.json({ limit: '8mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// O CORUJA abre diretamente na tela inicial. Rotas antigas de login/callback
// também apontam para a aplicação, sem mandar o usuário para uma página externa.
app.get(['/login', '/callback'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function readComments(){
  try { return JSON.parse(fs.readFileSync(COMMENTS_FILE, 'utf8') || '[]'); }
  catch { return []; }
}
function writeComments(items){ fs.writeFileSync(COMMENTS_FILE, JSON.stringify(items, null, 2), 'utf8'); }
function cleanText(v, max=1000){ return String(v ?? '').trim().slice(0, max); }

function readJson(file, fallback){ try { return JSON.parse(fs.readFileSync(file,'utf8') || JSON.stringify(fallback)); } catch { return fallback; } }
function writeJson(file, value){ const tmp=file+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8'); fs.renameSync(tmp,file); }
function readUsers(){ return readJson(USERS_FILE, []); }
function writeUsers(items){ writeJson(USERS_FILE, items); }
function stateFileFor(userId){ return path.join(STATES_DIR, `${String(userId).replace(/[^a-zA-Z0-9_-]/g,'_')}.json`); }
function readUserState(u){
  if(!u) return cleanState({});
  const file=stateFileFor(u.id);
  if(fs.existsSync(file)) return cleanState(readJson(file, u.state||{}));
  return cleanState(u.state||{});
}
function writeUserState(u, state){
  const clean=cleanState(state);
  writeJson(stateFileFor(u.id), clean);
  u.state=clean;
  return clean;
}
function readSessions(){ return readJson(SESSIONS_FILE, {}); }
function writeSessions(items){ writeJson(SESSIONS_FILE, items); }
function hashPassword(password, salt=crypto.randomBytes(16).toString('hex')){
  const hash=crypto.scryptSync(String(password), salt, 64).toString('hex');
  return {salt,hash};
}
function verifyPassword(password, record){
  try { const hash=crypto.scryptSync(String(password), record.salt, 64).toString('hex'); return crypto.timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(record.hash,'hex')); }
  catch { return false; }
}
function authUser(req){
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim(); if(!token) return null;
  const sessions=readSessions(); const userId=sessions[token]; if(!userId) return null;
  return readUsers().find(u=>u.id===userId)||null;
}
function makeUsername(name,id=''){
  const base=String(name||'coruja').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,24)||'coruja';
  return `${base}${String(id).replace(/-/g,'').slice(0,5)}`.slice(0,30);
}
function normalizeUsername(value){
  return String(value||'').trim().replace(/^@/,'').toLowerCase().replace(/[^a-z0-9_.]/g,'').slice(0,30);
}
function uniqueUsername(users, desired, exceptId=''){
  let base=normalizeUsername(desired)||'coruja'; let candidate=base; let n=2;
  while(users.some(u=>u.id!==exceptId && normalizeUsername(u.username)===candidate)) candidate=`${base}${n++}`.slice(0,30);
  return candidate;
}
function publicUser(u){
  if(!u) return null;
  return {id:u.id,name:u.name||'Coruja',username:u.username||'',avatar:u.avatar||'',followers:(u.followers||[]).length,following:(u.following||[]).length};
}
function migrateUsers(){
  const users=readUsers(); let changed=false;
  users.forEach(u=>{ if(typeof u.username!=='string'){u.username='';changed=true;} });
  if(changed) writeUsers(users);
  return users;
}

function cleanState(input){
  // O estado do CORUJA TIME é do usuário. Preserve todos os campos enviados
  // para que uma atualização futura do aplicativo não faça dados desaparecerem.
  const s=(input&&typeof input==='object')?input:{};
  let out;
  try { out=JSON.parse(JSON.stringify(s)); } catch { out={}; }
  delete out.sessionToken;
  delete out.password;
  out.list=Array.isArray(out.list)?out.list:[];
  out.favorites=(out.favorites&&typeof out.favorites==='object'&&!Array.isArray(out.favorites))?out.favorites:{series:[],movies:[]};
  out.favorites.series=Array.isArray(out.favorites.series)?out.favorites.series:[];
  out.favorites.movies=Array.isArray(out.favorites.movies)?out.favorites.movies:[];
  out.watched=(out.watched&&typeof out.watched==='object')?out.watched:{};
  out.watchedAt=(out.watchedAt&&typeof out.watchedAt==='object')?out.watchedAt:{};
  out.watchedMovies=(out.watchedMovies&&typeof out.watchedMovies==='object')?out.watchedMovies:{};
  out.positions=(out.positions&&typeof out.positions==='object')?out.positions:{};
  out.episodeRatings=(out.episodeRatings&&typeof out.episodeRatings==='object')?out.episodeRatings:{};
  out.movieRatings=(out.movieRatings&&typeof out.movieRatings==='object')?out.movieRatings:{};
  out.seasonPromptNever=(out.seasonPromptNever&&typeof out.seasonPromptNever==='object')?out.seasonPromptNever:{};
  out.completedShows=(out.completedShows&&typeof out.completedShows==='object')?out.completedShows:{};
  out.watchDurations=(out.watchDurations&&typeof out.watchDurations==='object')?out.watchDurations:{episodes:{},movies:{}};
  out.watchDurations.episodes=(out.watchDurations.episodes&&typeof out.watchDurations.episodes==='object')?out.watchDurations.episodes:{};
  out.watchDurations.movies=(out.watchDurations.movies&&typeof out.watchDurations.movies==='object')?out.watchDurations.movies:{};
  out.comments=Array.isArray(out.comments)?out.comments:[];
  out.commentCount=Number(out.commentCount||0);
  out.profile=cleanText(out.profile||'',60)||'Coruja';
  return out;
}

// Contas e perfis sociais. O progresso fica associado à conta para funcionar em outro aparelho.
function readInvites(){ return readJson(INVITES_FILE, []); }
function writeInvites(items){ writeJson(INVITES_FILE, items); }
function adminAllowed(req){ return !!ADMIN_KEY && String(req.headers['x-admin-key']||req.query?.key||'')===ADMIN_KEY; }
function makeInviteCode(){ let code=''; const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; do{code='CORUJA-'+Array.from({length:8},()=>chars[Math.floor(Math.random()*chars.length)]).join('')}while(readInvites().some(x=>x.code===code)); return code; }
app.get('/api/admin/invites',(req,res)=>{if(!adminAllowed(req))return res.status(403).json({error:'Acesso ao painel não autorizado.'});res.json({invites:readInvites()});});
app.post('/api/admin/invites',(req,res)=>{if(!adminAllowed(req))return res.status(403).json({error:'Acesso ao painel não autorizado.'});const invites=readInvites(),amount=Math.min(50,Math.max(1,Number(req.body?.amount||1))),created=[];for(let i=0;i<amount;i++){const item={code:makeInviteCode(),used:false,createdAt:new Date().toISOString(),usedAt:null,usedBy:null};invites.push(item);created.push(item)}writeInvites(invites);res.status(201).json({invites:created});});
app.get('/api/admin/users',(req,res)=>{if(!adminAllowed(req))return res.status(403).json({error:'Acesso ao painel não autorizado.'});const users=migrateUsers().map(u=>({id:u.id,name:u.name||'Coruja',username:u.username||'',email:u.email||'',createdAt:u.createdAt||null,passwordConfigured:!!(u.password&&u.password.hash&&u.password.salt),blocked:!!u.blocked,blockedAt:u.blockedAt||null})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));res.json({users});});
app.get('/api/admin/stats',(req,res)=>{if(!adminAllowed(req))return res.status(403).json({error:'Acesso ao painel não autorizado.'});const users=migrateUsers();const invites=readInvites();const sessions=readSessions();const activeUserIds=new Set(Object.values(sessions));const recentUsers=users.map(u=>({id:u.id,name:u.name||'Coruja',email:u.email||'',createdAt:u.createdAt||null,blocked:!!u.blocked})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));const recentInvites=invites.slice().sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));res.json({totalUsers:users.length,inviteAvailable:invites.filter(x=>!x.used).length,inviteUsed:invites.filter(x=>x.used).length,activeSessions:activeUserIds.size,recentUsers,recentInvites});});
app.post('/api/admin/users/:id/block',(req,res)=>{if(!adminAllowed(req))return res.status(403).json({error:'Acesso ao painel não autorizado.'});const users=readUsers(),u=users.find(x=>x.id===req.params.id);if(!u)return res.status(404).json({error:'Usuário não encontrado.'});u.blocked=!u.blocked;u.blockedAt=u.blocked?new Date().toISOString():null;writeUsers(users);if(u.blocked){const sessions=readSessions();Object.keys(sessions).forEach(token=>{if(sessions[token]===u.id)delete sessions[token]});writeSessions(sessions);}res.json({ok:true,blocked:!!u.blocked,user:{id:u.id,name:u.name||'Coruja',email:u.email||''}});});
app.post('/api/admin/users/:id/reset-password',(req,res)=>{if(!adminAllowed(req))return res.status(403).json({error:'Acesso ao painel não autorizado.'});const users=readUsers(),u=users.find(x=>x.id===req.params.id);if(!u)return res.status(404).json({error:'Usuário não encontrado.'});const temporaryPassword=crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0,10)+'A1';u.password=hashPassword(temporaryPassword);u.passwordResetAt=new Date().toISOString();writeUsers(users);const sessions=readSessions();Object.keys(sessions).forEach(token=>{if(sessions[token]===u.id)delete sessions[token]});writeSessions(sessions);res.json({ok:true,user:{id:u.id,name:u.name||'Coruja',username:u.username||'',email:u.email||''},temporaryPassword});});
app.get('/api/auth/invite-availability',(req,res)=>{const code=cleanText(req.query?.code,40).toUpperCase(),item=readInvites().find(x=>x.code===code);res.json({valid:!!item&&!item.used,error:!item?'Código de convite inválido.':item.used?'Este código de convite já foi utilizado.':''});});
app.post('/api/auth/register',(req,res)=>{try{const name=cleanText(req.body?.name,60),email=cleanText(req.body?.email,160).toLowerCase(),code=cleanText(req.body?.inviteCode,40).toUpperCase(),password=String(req.body?.password||''),username=normalizeUsername(req.body?.username||'');if(!name)return res.status(400).json({error:'Digite seu nome.'});if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({error:'Digite um e-mail válido.'});if(password.length<6)return res.status(400).json({error:'A senha deve ter pelo menos 6 caracteres.'});const invites=readInvites(),invite=invites.find(x=>x.code===code);if(!invite)return res.status(400).json({error:'Código de convite inválido.'});if(invite.used)return res.status(409).json({error:'Este código de convite já foi utilizado.'});const users=migrateUsers();if(users.some(u=>u.email===email))return res.status(409).json({error:'Este e-mail já está cadastrado.'});const id=crypto.randomUUID(),u={id,email,name,username,avatar:'',password:hashPassword(password),state:cleanState(req.body?.state),followers:[],following:[],createdAt:new Date().toISOString()};users.push(u); writeUserState(u,u.state); invite.used=true;invite.usedAt=new Date().toISOString();invite.usedBy=id;writeUsers(users);writeInvites(invites);const token=crypto.randomBytes(32).toString('hex'),sessions=readSessions();sessions[token]=id;writeSessions(sessions);res.status(201).json({token,user:publicUser(u),state:readUserState(u)});}catch(e){res.status(500).json({error:'Não foi possível criar a conta.'});}});
app.post('/api/auth/login',(req,res)=>{try{const identifier=cleanText(req.body?.identifier||req.body?.email,160).toLowerCase(),password=String(req.body?.password||''),u=migrateUsers().find(x=>x.email===identifier);if(!u)return res.status(401).json({error:'E-mail não encontrado.'});if(u.blocked)return res.status(403).json({error:'Esta conta está bloqueada. Entre em contato com o administrador.'});if(!u.password||!u.password.hash||!u.password.salt)return res.status(401).json({error:'Esta conta não possui senha cadastrada. Crie uma nova conta com um código de convite.'});if(!verifyPassword(password,u.password))return res.status(401).json({error:'Senha incorreta.'});const token=crypto.randomBytes(32).toString('hex'),sessions=readSessions();sessions[token]=u.id;writeSessions(sessions);res.json({token,user:publicUser(u),state:readUserState(u)});}catch(e){res.status(500).json({error:'Não foi possível entrar.'});}});
app.post('/api/auth/logout',(req,res)=>{const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim(),sessions=readSessions();if(token)delete sessions[token];writeSessions(sessions);res.json({ok:true});});
app.get('/api/me',(req,res)=>{const u=authUser(req);if(!u)return res.status(401).json({error:'Não autenticado.'});res.json({user:publicUser(u),state:readUserState(u)});});
app.put('/api/me/profile',(req,res)=>{const u=authUser(req);if(!u)return res.status(401).json({error:'Não autenticado.'});const users=readUsers();const name=cleanText(req.body?.name,60);if(name)u.name=name; const requestedUsername=normalizeUsername(req.body?.username); if(requestedUsername){ if(!/^[a-z0-9_.]{3,30}$/.test(requestedUsername)) return res.status(400).json({error:'O nome de usuário deve ter de 3 a 30 caracteres.'}); if(readUsers().some(x=>x.id!==u.id&&normalizeUsername(x.username)===requestedUsername)) return res.status(409).json({error:'Este nome de usuário já está em uso.'}); u.username=requestedUsername; } u.avatar=cleanText(req.body?.avatar,250000);writeUserState(u,req.body?.state||readUserState(u));writeUsers(users);res.json({user:publicUser(u),state:readUserState(u)});});
app.post('/api/me/state',(req,res)=>{const u=authUser(req);if(!u)return res.status(401).json({error:'Não autenticado.'});const users=readUsers(); const clean=cleanState(req.body?.state); writeUserState(u,clean); if(req.body?.name)u.name=cleanText(req.body.name,60); writeUsers(users); res.json({ok:true});});

app.get('/api/users/search',(req,res)=>{
  const q=cleanText(req.query.q,60).toLowerCase(); if(!q)return res.json({users:[]});
  const me=authUser(req); const users=readUsers().filter(u=>(!me||u.id!==me.id)&&(u.name.toLowerCase().includes(q)||u.email.toLowerCase().includes(q)||normalizeUsername(u.username).includes(normalizeUsername(q)))).slice(0,30).map(u=>({...publicUser(u),following:!!me&&(me.following||[]).includes(u.id)}));
  res.json({users});
});
app.get('/api/users/:id',(req,res)=>{
  const users=readUsers(); const u=users.find(x=>x.id===req.params.id); if(!u)return res.status(404).json({error:'Usuário não encontrado.'});
  const me=authUser(req); const following=!!me&&(me.following||[]).includes(u.id);
  res.json({user:{...publicUser(u),following},state:u.state});
});
app.post('/api/users/:id/follow',(req,res)=>{
  const me=authUser(req); if(!me)return res.status(401).json({error:'Entre na sua conta para seguir pessoas.'}); if(me.id===req.params.id)return res.status(400).json({error:'Você não pode seguir a si mesmo.'});
  const users=readUsers(); const target=users.find(u=>u.id===req.params.id); if(!target)return res.status(404).json({error:'Usuário não encontrado.'});
  me.following=Array.from(new Set([...(me.following||[]),target.id])); target.followers=Array.from(new Set([...(target.followers||[]),me.id])); writeUsers(users); res.json({following:true,user:publicUser(target)});
});
app.delete('/api/users/:id/follow',(req,res)=>{
  const me=authUser(req); if(!me)return res.status(401).json({error:'Entre na sua conta para seguir pessoas.'});
  const users=readUsers(); const target=users.find(u=>u.id===req.params.id); if(!target)return res.status(404).json({error:'Usuário não encontrado.'});
  me.following=(me.following||[]).filter(id=>id!==target.id); target.followers=(target.followers||[]).filter(id=>id!==me.id); writeUsers(users); res.json({following:false,user:publicUser(target)});
});

async function tmdb(endpoint, params={}) {
  if (!TOKEN) throw new Error('Configure TMDB_TOKEN no arquivo .env');
  const u = new URL('https://api.themoviedb.org/3' + endpoint);
  for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k,v);
  const r = await fetch(u, {headers:{Authorization:`Bearer ${TOKEN}`, accept:'application/json'}});
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

app.get('/api/test', async (_,res)=>{
  try { const d=await tmdb('/movie/popular',{language:'pt-BR',region:'BR',page:1}); res.json({ok:true,total_results:d.total_results,primeiro:d.results?.[0]?.title||null}); }
  catch(e){res.status(500).json({ok:false,error:e.message});}
});

let homeCache = {data:null, expires:0};
app.get('/api/home', async (_,res)=>{
  try {
    if(homeCache.data && Date.now() < homeCache.expires) return res.json(homeCache.data);
    const today=new Date().toISOString().slice(0,10);
    const since90=new Date(Date.now()-90*24*60*60*1000).toISOString().slice(0,10);
    const requests = [
      tmdb('/trending/all/day',{language:'pt-BR'}),
      tmdb('/trending/all/week',{language:'pt-BR'}),
      tmdb('/tv/popular',{language:'pt-BR',page:1}),
      tmdb('/movie/popular',{language:'pt-BR',region:'BR',page:1}),
      tmdb('/tv/on_the_air',{language:'pt-BR',page:1}),
      tmdb('/movie/now_playing',{language:'pt-BR',region:'BR',page:1}),
      tmdb('/discover/tv',{language:'pt-BR',watch_region:'BR',sort_by:'popularity.desc',first_air_date_gte:since90,first_air_date_lte:today,page:1}),
      tmdb('/discover/movie',{language:'pt-BR',region:'BR',watch_region:'BR',sort_by:'popularity.desc',primary_release_date_gte:since90,primary_release_date_lte:today,page:1}),
      tmdb('/tv/top_rated',{language:'pt-BR',page:1}),
      tmdb('/movie/upcoming',{language:'pt-BR',region:'BR',page:1})
    ];
    // Uma categoria com erro no TMDB não pode derrubar o catálogo inteiro.
    const settled = await Promise.allSettled(requests);
    const value = (i, fallback={results:[]}) => settled[i].status==='fulfilled' ? settled[i].value : fallback;
    const data={
      trendingDay:value(0), trending:value(1), tv:value(2), movies:value(3), popularTv:value(4),
      popularMovies:value(5), newTv:value(6), newMovies:value(7),
      topRatedTv:value(8), upcomingMovies:value(9)
    };
    homeCache={data,expires:Date.now()+15*60*1000};
    res.json(data);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/movies/popular', async (req,res)=>{
  try {
    const page=Math.max(1,Math.min(500,Number(req.query.page)||1));
    const d=await tmdb('/movie/popular',{language:'pt-BR',region:'BR',page});
    res.json(d);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/series/popular', async (req,res)=>{
  try {
    const page=Math.max(1,Math.min(500,Number(req.query.page)||1));
    const d=await tmdb('/tv/popular',{language:'pt-BR',page});
    res.json(d);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/movies/upcoming', async (req,res)=>{
  try {
    const page=Math.max(1,Math.min(500,Number(req.query.page)||1));
    const d=await tmdb('/movie/upcoming',{language:'pt-BR',region:'BR',page});
    res.json(d);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/movies/now-playing', async (req,res)=>{
  try {
    const page=Math.max(1,Math.min(500,Number(req.query.page)||1));
    const d=await tmdb('/movie/now_playing',{language:'pt-BR',region:'BR',page});
    res.json(d);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/series/top-rated', async (req,res)=>{
  try {
    const page=Math.max(1,Math.min(500,Number(req.query.page)||1));
    const d=await tmdb('/tv/top_rated',{language:'pt-BR',page});
    res.json(d);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/search', async (req,res)=>{
  try { res.json(await tmdb('/search/multi',{query:req.query.q||'',language:'pt-BR',region:'BR',include_adult:'false',page:1})); }
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/tv/:id', async (req,res)=>{
  try { res.json(await tmdb(`/tv/${req.params.id}`,{language:'pt-BR',append_to_response:'credits,videos,images,recommendations,similar'})); }
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/tv/:id/season/:season', async (req,res)=>{
  try { res.json(await tmdb(`/tv/${req.params.id}/season/${req.params.season}`,{language:'pt-BR',append_to_response:'credits,videos,images'})); }
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/tv/:id/providers', async (req,res)=>{
  try { res.json(await tmdb(`/tv/${req.params.id}/watch/providers`,{})); }
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/movie/:id', async (req,res)=>{
  try { res.json(await tmdb(`/movie/${req.params.id}`,{language:'pt-BR',append_to_response:'credits,videos,images,recommendations,similar'})); }
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/movie/:id/providers', async (req,res)=>{
  try { res.json(await tmdb(`/movie/${req.params.id}/watch/providers`,{})); }
  catch(e){res.status(500).json({error:e.message});}
});

// Comunidade: comentários por episódio e por filme. Os comentários ficam no servidor para todos os usuários.
app.get('/api/comments', (req,res)=>{
  const mediaType=String(req.query.mediaType||'');
  const mediaId=String(req.query.mediaId||'');
  const tvId=String(req.query.tvId||'');
  const season=String(req.query.season||'');
  const episode=String(req.query.episode||'');
  let items=[];
  if(mediaType==='movie' && mediaId){
    items=readComments().filter(c=>c.mediaType==='movie'&&c.mediaId===mediaId);
  }else if(tvId && season && episode){
    items=readComments().filter(c=>(c.mediaType==='tv' ? c.mediaId===tvId : c.tvId===tvId)&&c.season===season&&c.episode===episode);
  }else return res.status(400).json({error:'Referência de comentário inválida.'});
  items.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  res.json({comments:items});
});

app.post('/api/comments', (req,res)=>{
  try {
    const {mediaType,mediaId,tvId,season,episode,userId,userName,text,imageData}=req.body||{};
    const isMovie=mediaType==='movie';
    if(!userId || !userName || (!text && !imageData)) return res.status(400).json({error:'Preencha o comentário ou escolha uma foto.'});
    if(isMovie ? !mediaId : (!tvId || !season || !episode)) return res.status(400).json({error:isMovie?'Filme inválido.':'Episódio inválido.'});
    let imageUrl=null;
    if(imageData){
      const match=String(imageData).match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
      if(!match) return res.status(400).json({error:'Formato de imagem não suportado.'});
      const buffer=Buffer.from(match[2],'base64');
      if(buffer.length>5*1024*1024) return res.status(413).json({error:'A foto deve ter no máximo 5 MB.'});
      const ext=match[1].toLowerCase()==='jpeg'?'jpg':match[1].toLowerCase();
      const filename=`${crypto.randomUUID()}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR,filename),buffer);
      imageUrl=`/uploads/${filename}`;
    }
    const comments=readComments();
    const item={id:crypto.randomUUID(),mediaType:isMovie?'movie':'tv',mediaId:String(isMovie?mediaId:tvId),tvId:isMovie?null:String(tvId||''),season:isMovie?null:String(season||''),episode:isMovie?null:String(episode||''),userId:cleanText(userId,120),userName:cleanText(userName,60),text:cleanText(text,1200),imageUrl,createdAt:new Date().toISOString(),likes:0,replies:[]};
    comments.push(item); writeComments(comments); res.status(201).json(item);
  } catch(e){ res.status(500).json({error:'Não foi possível publicar o comentário.'}); }
});

app.post('/api/comments/:id/replies', (req,res)=>{
  try {
    const {userId,userName,text}=req.body||{};
    const value=cleanText(text,500);
    if(!userId || !userName || !value) return res.status(400).json({error:'Escreva uma resposta.'});
    const comments=readComments();
    const item=comments.find(c=>c.id===req.params.id);
    if(!item) return res.status(404).json({error:'Comentário não encontrado.'});
    if(!Array.isArray(item.replies)) item.replies=[];
    const reply={id:crypto.randomUUID(),userId:cleanText(userId,120),userName:cleanText(userName,60),text:value,createdAt:new Date().toISOString()};
    item.replies.push(reply);
    writeComments(comments);
    res.status(201).json(reply);
  } catch(e){ res.status(500).json({error:'Não foi possível publicar a resposta.'}); }
});

app.post('/api/comments/:id/like', (req,res)=>{
  const comments=readComments(); const item=comments.find(c=>c.id===req.params.id);
  if(!item) return res.status(404).json({error:'Comentário não encontrado.'});
  item.likes=Number(item.likes||0)+1; writeComments(comments); res.json({likes:item.likes});
});

app.delete('/api/comments/:id', (req,res)=>{
  const comments=readComments(); const item=comments.find(c=>c.id===req.params.id);
  if(!item) return res.status(404).json({error:'Comentário não encontrado.'});
  if(String(req.query.userId||'')!==item.userId) return res.status(403).json({error:'Você só pode excluir seus próprios comentários.'});
  if(item.imageUrl) { const p=path.join(__dirname,'public',item.imageUrl.replace(/^\//,'')); try{fs.unlinkSync(p)}catch{} }
  writeComments(comments.filter(c=>c.id!==item.id)); res.json({ok:true});
});

app.listen(PORT,()=>console.log(`CORUJA em http://localhost:${PORT}`));
