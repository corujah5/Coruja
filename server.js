require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const { mergeCandidateSources, rankSimilarSeries } = require('./lib/similar-series');
const { rankSimilarMovies } = require('./lib/similar-movies');
const { localDateKey: discoverDateKey, normalizeDiscoverQuery, buildDiscoverRequest, filterUpcomingPayload } = require('./lib/discover-catalog');
const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TMDB_READ_ACCESS_TOKEN || process.env.TMDB_TOKEN;
const scryptAsync = promisify(crypto.scrypt);
const SESSION_COOKIE = 'coruja_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const LEGACY_SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads');
const COMMENTS_FILE = path.join(DATA_DIR, 'comments.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const INVITES_FILE = path.join(DATA_DIR, 'invites.json');
const STATES_DIR = path.join(DATA_DIR, 'states');
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '').trim();
const ADMIN_BOOTSTRAP_SECRET = String(process.env.ADMIN_BOOTSTRAP_SECRET || '');
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');
const ADMIN_KEY_HEADER = 'x-admin-key';
const ADMIN_BOOTSTRAP_STATE_FILE = path.join(DATA_DIR, 'admin-bootstrap.json');
const bootstrapAttempts = new Map();
const BOOTSTRAP_MAX_ATTEMPTS = 5;
const BOOTSTRAP_WINDOW_MS = 15 * 60 * 1000;
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
app.set('trust proxy', 1);
app.disable('x-powered-by');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(STATES_DIR, { recursive: true });
if (!fs.existsSync(COMMENTS_FILE)) fs.writeFileSync(COMMENTS_FILE, '[]', 'utf8');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}', 'utf8');
if (!fs.existsSync(INVITES_FILE)) fs.writeFileSync(INVITES_FILE, '[]', 'utf8');

app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  const nonce = crypto.randomBytes(18).toString('base64');
  res.locals.cspNonce = nonce;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://image.tmdb.org https://www.themoviedb.org",
    "connect-src 'self' https://api.themoviedb.org",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
function serveApp(req, res) {
  const nonce = res.locals.cspNonce;
  let html = fs.readFileSync(INDEX_FILE, 'utf8');
  html = html.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`)
    .replace(/<style\b(?![^>]*\bnonce=)/gi, `<style nonce="${nonce}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
}
app.get(['/', '/index.html', '/login', '/callback'], serveApp);
app.use('/uploads', (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  requireAccount(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny', index: false }));

// O CORUJA abre diretamente na tela inicial. Rotas antigas de login/callback
// também apontam para a aplicação, sem mandar o usuário para uma página externa.
function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const parsed = Object.create(null);
  raw.split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const key = part.slice(0, index).trim();
    try { parsed[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  });
  return parsed;
}
function sessionCookieOptions(req, maxAge = SESSION_TTL_MS) {
  return { httpOnly: true, secure: req.secure === true, sameSite: 'lax', path: '/', maxAge };
}
function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions(req));
}
function clearSessionCookie(req, res) {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions(req, 0));
}

function readComments(){
  try { return JSON.parse(fs.readFileSync(COMMENTS_FILE, 'utf8') || '[]'); }
  catch { return []; }
}
function writeComments(items){ writeJson(COMMENTS_FILE, items); }
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
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptAsync(String(password), salt, 64, PASSWORD_SCRYPT);
  return { algorithm: 'scrypt', N: PASSWORD_SCRYPT.N, r: PASSWORD_SCRYPT.r, p: PASSWORD_SCRYPT.p, salt, hash: hash.toString('hex') };
}
async function verifyPassword(password, record) {
  let salt = record?.salt;
  let expected = record?.hash;
  let options = record?.algorithm === 'scrypt' && Number(record.N) > 1
    ? { N: Number(record.N), r: Number(record.r) || 8, p: Number(record.p) || 1, maxmem: 64 * 1024 * 1024 }
    : LEGACY_SCRYPT;
  if (typeof salt !== 'string' || typeof expected !== 'string' || !/^[a-f0-9]{128}$/i.test(expected)) {
    salt = 'coruja-invalid-login-salt';
    expected = '0'.repeat(128);
  }
  try {
    const actual = await scryptAsync(String(password), salt, 64, options);
    const wanted = Buffer.from(expected, 'hex');
    return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
  } catch { return false; }
}
function sessionUserId(record) {
  if (typeof record === 'string') return record;
  if (record && typeof record === 'object' && Number(record.expiresAt) > Date.now()) return String(record.userId || '');
  return '';
}
function revokeUserSessions(sessions, userId) {
  let changed = false;
  Object.keys(sessions).forEach(token => {
    if (sessionUserId(sessions[token]) === String(userId)) { delete sessions[token]; changed = true; }
  });
  return changed;
}
function migrateLegacySessions() {
  const sessions = readSessions();
  const legacyTokens = Object.entries(sessions).filter(([, record]) => typeof record === 'string');
  if (!legacyTokens.length) return;
  const backupPath = path.join(DATA_DIR, `sessions-pre-cookie-auth-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.json`);
  if (fs.existsSync(SESSIONS_FILE)) {
    fs.copyFileSync(SESSIONS_FILE, backupPath, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(backupPath, 0o600); } catch {}
  }
  const now = Date.now();
  legacyTokens.forEach(([token, userId]) => {
    sessions[token] = { userId: String(userId), createdAt: now, expiresAt: now + SESSION_TTL_MS };
  });
  writeSessions(sessions);
}
migrateLegacySessions();
function createSession(sessions, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions[token] = { userId: String(userId), createdAt: now, expiresAt: now + SESSION_TTL_MS };
  return token;
}
function authUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const sessions = readSessions();
  const record = sessions[token];
  const userId = sessionUserId(record);
  if (!userId) {
    if (record) { delete sessions[token]; writeSessions(sessions); }
    return null;
  }
  const user = readUsers().find(item => item.id === userId && !item.blocked) || null;
  if (!user) { delete sessions[token]; writeSessions(sessions); return null; }
  return user;
}
function requireAccount(req,res,next){
  const account=authUser(req);
  if(!account) { if(parseCookies(req)[SESSION_COOKIE]) clearSessionCookie(req,res); return res.status(401).json({error:'Não autenticado.'}); }
  req.account=account;
  next();
}
// Catálogo, busca, perfis e comentários só são servidos a uma sessão válida.
// As rotas de autenticação e administração mantêm seus próprios controles.
app.use([
  '/api/test','/api/home','/api/movies','/api/series','/api/search','/api/discover',
  '/api/tv','/api/movie','/api/users','/api/comments'
],requireAccount);
app.get('/uploads/:filename', requireAccount, (req, res) => {
  const filename = String(req.params.filename || '');
  if (!/^[a-f0-9-]{36}\.(png|jpg|webp)$/i.test(filename)) return res.sendStatus(404);
  const file = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(file);
});
function isAdminAccount(account) {
  return !!ADMIN_ACCOUNT_ID && String(account?.id || '') === String(ADMIN_ACCOUNT_ID);
}
function adminKeyMatches(candidate) {
  const digest = value => crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
  return crypto.timingSafeEqual(digest(candidate), digest(ADMIN_KEY));
}
function requireAdminKey(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  if (Buffer.byteLength(ADMIN_KEY, 'utf8') < 16) return res.status(503).json({ error: 'A administração local não está configurada.' });
  const suppliedKey = String(req.get(ADMIN_KEY_HEADER) || '');
  if (!adminKeyMatches(suppliedKey)) return res.status(401).json({ error: 'Acesso ao painel não autorizado.' });
  next();
}
app.use('/api/admin', requireAdminKey);
function makeUsername(name,id=''){
  const base=String(name||'coruja').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,24)||'coruja';
  return `${base}${String(id).replace(/-/g,'').slice(0,5)}`.slice(0,30);
}
function normalizeUsername(value){
  return String(value||'').trim().replace(/^@/,'').toLowerCase().replace(/[^a-z0-9_.]/g,'').slice(0,30);
}
function bootstrapSecretMatches(candidate, configured) {
  const digest = value => crypto.createHash('sha256').update(value, 'utf8').digest();
  return crypto.timingSafeEqual(digest(String(candidate || '')), digest(String(configured || '')));
}
function readBootstrapUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(users) ? users : null;
  } catch { return null; }
}
function isBootstrapJournalUser(user) {
  return !!user
    && typeof user.id === 'string'
    && /^[a-f0-9-]{36}$/i.test(user.id)
    && /^[a-z0-9_.]{3,30}$/.test(String(user.username || ''))
    && user.password?.algorithm === 'scrypt'
    && /^[a-f0-9]{32}$/i.test(String(user.password.salt || ''))
    && /^[a-f0-9]{128}$/i.test(String(user.password.hash || ''));
}
function recoverAdminBootstrap() {
  if (!fs.existsSync(ADMIN_BOOTSTRAP_STATE_FILE)) return;
  let record;
  try { record = JSON.parse(fs.readFileSync(ADMIN_BOOTSTRAP_STATE_FILE, 'utf8')); }
  catch { throw new Error('Bootstrap recovery state is invalid.'); }

  // Accept the consumed marker format written by the previous implementation.
  if (record?.status === 'consumed' || (record?.consumedAt && record?.accountId && !record?.status)) return;
  if (record?.status !== 'provisioning' || !isBootstrapJournalUser(record.user)) {
    throw new Error('Bootstrap recovery state is invalid.');
  }

  const users = readBootstrapUsers();
  if (!users) throw new Error('Bootstrap account data is invalid.');
  const existing = users.find(item => item.id === record.user.id);
  if (existing) {
    if (normalizeUsername(existing.username) !== normalizeUsername(record.user.username)) {
      throw new Error('Bootstrap account does not match its recovery state.');
    }
  } else {
    if (users.length) throw new Error('Bootstrap recovery conflicts with existing accounts.');
    writeUserState(record.user, record.user.state || {});
    users.push(record.user);
    writeUsers(users);
  }

  writeJson(ADMIN_BOOTSTRAP_STATE_FILE, {
    status: 'consumed',
    consumedAt: new Date().toISOString(),
    accountId: record.user.id
  });
}
function bootstrapRateLimited(ip) {
  const now = Date.now();
  for (const [key, entry] of bootstrapAttempts) if (entry.resetAt <= now) bootstrapAttempts.delete(key);
  return (bootstrapAttempts.get(String(ip))?.count || 0) >= BOOTSTRAP_MAX_ATTEMPTS;
}
function recordBootstrapFailure(ip) {
  const key = String(ip);
  const entry = bootstrapAttempts.get(key);
  if (!entry || entry.resetAt <= Date.now()) bootstrapAttempts.set(key, { count: 1, resetAt: Date.now() + BOOTSTRAP_WINDOW_MS });
  else entry.count++;
}
// A pending journal is a write-ahead record. Complete it before resolving the
// administrator ID so a crash during provisioning is recoverable on restart.
try { recoverAdminBootstrap(); } catch {}
// Resolve a stable account ID at startup so a later username change/reuse
// cannot transfer administrator privileges to another account.
const ADMIN_ACCOUNT_ID = normalizeUsername(ADMIN_USERNAME)
  ? (readUsers().find(user => normalizeUsername(user.username) === normalizeUsername(ADMIN_USERNAME))?.id || '')
  : '';
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
  out.episodeWatchCounts=(out.episodeWatchCounts&&typeof out.episodeWatchCounts==='object')?out.episodeWatchCounts:{};
  Object.entries(out.episodeWatchCounts).forEach(([key,value])=>{const count=Math.floor(Number(value));if(/^\d+-\d+-\d+$/.test(key)&&count>0&&Number.isFinite(count))out.episodeWatchCounts[key]=count;else delete out.episodeWatchCounts[key]});
  out.watchedMovies=(out.watchedMovies&&typeof out.watchedMovies==='object')?out.watchedMovies:{};
  out.positions=(out.positions&&typeof out.positions==='object')?out.positions:{};
  out.episodeRatings=(out.episodeRatings&&typeof out.episodeRatings==='object')?out.episodeRatings:{};
  out.movieRatings=(out.movieRatings&&typeof out.movieRatings==='object')?out.movieRatings:{};
  out.seasonPromptNever=(out.seasonPromptNever&&typeof out.seasonPromptNever==='object')?out.seasonPromptNever:{};
  out.completedShows=(out.completedShows&&typeof out.completedShows==='object')?out.completedShows:{};
  out.watchDurations=(out.watchDurations&&typeof out.watchDurations==='object')?out.watchDurations:{episodes:{},movies:{}};
  out.watchDurations.episodes=(out.watchDurations.episodes&&typeof out.watchDurations.episodes==='object')?out.watchDurations.episodes:{};
  out.watchDurations.movies=(out.watchDurations.movies&&typeof out.watchDurations.movies==='object')?out.watchDurations.movies:{};
  out.watchDurations.episodeRewatches=(out.watchDurations.episodeRewatches&&typeof out.watchDurations.episodeRewatches==='object')?out.watchDurations.episodeRewatches:{};
  Object.entries(out.watchDurations.episodeRewatches).forEach(([key,value])=>{const minutes=Number(value);if(/^\d+-\d+-\d+$/.test(key)&&Number.isFinite(minutes)&&minutes>0)out.watchDurations.episodeRewatches[key]=minutes;else delete out.watchDurations.episodeRewatches[key]});
  out.comments=Array.isArray(out.comments)?out.comments:[];
  out.commentCount=Number(out.commentCount||0);
  out.profile=cleanText(out.profile||'',60)||'Coruja';
  return out;
}

// Contas e perfis sociais. O progresso fica associado à conta para funcionar em outro aparelho.
function readInvites(){ return readJson(INVITES_FILE, []); }
function writeInvites(items){ writeJson(INVITES_FILE, items); }
function makeInviteCode(){ let code=''; const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; do{code='CORUJA-'+Array.from({length:8},()=>chars[Math.floor(Math.random()*chars.length)]).join('')}while(readInvites().some(x=>x.code===code)); return code; }
app.get('/api/admin/session',(req,res)=>res.json({authorized:true}));
app.get('/api/admin/invites',(req,res)=>res.json({invites:readInvites()}));
app.post('/api/admin/invites',(req,res)=>{const invites=readInvites(),amount=Math.min(50,Math.max(1,Number(req.body?.amount||1))),created=[];for(let i=0;i<amount;i++){const item={code:makeInviteCode(),used:false,createdAt:new Date().toISOString(),usedAt:null,usedBy:null};invites.push(item);created.push(item)}writeInvites(invites);res.status(201).json({invites:created});});
app.get('/api/admin/users',(req,res)=>{const users=migrateUsers().map(u=>({id:u.id,name:u.name||'Coruja',username:u.username||'',email:u.email||'',createdAt:u.createdAt||null,passwordConfigured:!!(u.password&&u.password.hash&&u.password.salt),blocked:!!u.blocked,blockedAt:u.blockedAt||null})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));res.json({users});});
app.post('/api/admin/users',async(req,res)=>{
  try{
    const name=cleanText(req.body?.name,60);
    const rawUsername=cleanText(req.body?.username,40);
    if(rawUsername&&!/^[a-zA-Z0-9_.]{3,30}$/.test(rawUsername))return res.status(400).json({error:'O usuário deve ter de 3 a 30 caracteres: letras, números, ponto ou sublinhado.'});
    let password=typeof req.body?.password==='string'?req.body.password:'';
    if(!password)password=crypto.randomBytes(12).toString('base64url');
    if(password.length<8||password.length>128)return res.status(400).json({error:'A senha deve ter entre 8 e 128 caracteres.'});
    const passwordHash=await hashPassword(password);
    const users=migrateUsers();
    const username=rawUsername?normalizeUsername(rawUsername):uniqueUsername(users,makeUsername(name||'usuario',crypto.randomBytes(6).toString('hex')));
    if(users.some(u=>normalizeUsername(u.username)===username))return res.status(409).json({error:'Este usuário já está em uso.'});
    const id=crypto.randomUUID();
    const user={id,name:name||username,username,email:'',avatar:'',password:passwordHash,state:cleanState({}),followers:[],following:[],createdAt:new Date().toISOString(),blocked:false};
    writeUserState(user,user.state);users.push(user);writeUsers(users);
    return res.status(201).json({user:publicUser(user),username,password});
  }catch(error){return res.status(500).json({error:'Não foi possível criar a conta.'});}
});app.get('/api/admin/stats',(req,res)=>{const users=migrateUsers();const invites=readInvites();const sessions=readSessions();const activeUserIds=new Set(Object.values(sessions).map(sessionUserId).filter(Boolean));const recentUsers=users.map(u=>({id:u.id,name:u.name||'Coruja',username:u.username||'',email:u.email||'',createdAt:u.createdAt||null,blocked:!!u.blocked})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));const recentInvites=invites.slice().sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));res.json({totalUsers:users.length,inviteAvailable:invites.filter(x=>!x.used).length,inviteUsed:invites.filter(x=>x.used).length,activeSessions:activeUserIds.size,recentUsers,recentInvites});});
app.post('/api/admin/users/:id/block',(req,res)=>{const users=readUsers(),u=users.find(x=>x.id===req.params.id);if(!u)return res.status(404).json({error:'Usuário não encontrado.'});if(u.id===ADMIN_ACCOUNT_ID)return res.status(400).json({error:'A conta administradora não pode ser bloqueada.'});u.blocked=!u.blocked;u.blockedAt=u.blocked?new Date().toISOString():null;writeUsers(users);if(u.blocked){const sessions=readSessions();revokeUserSessions(sessions,u.id);writeSessions(sessions);}res.json({ok:true,blocked:!!u.blocked,user:{id:u.id,name:u.name||'Coruja',email:u.email||''}});});
app.post('/api/admin/users/:id/reset-password',async(req,res)=>{const temporaryPassword=crypto.randomBytes(12).toString('base64url')+'A1';const passwordHash=await hashPassword(temporaryPassword);const users=readUsers(),u=users.find(x=>x.id===req.params.id);if(!u)return res.status(404).json({error:'Usuário não encontrado.'});u.password=passwordHash;u.passwordResetAt=new Date().toISOString();writeUsers(users);const sessions=readSessions();revokeUserSessions(sessions,u.id);writeSessions(sessions);res.json({ok:true,user:{id:u.id,name:u.name||'Coruja',username:u.username||'',email:u.email||''},temporaryPassword});});
app.delete('/api/admin/users/:id',(req,res)=>{
  const users=readUsers(),target=users.find(u=>u.id===req.params.id);
  if(!target)return res.status(404).json({error:'Usuário não encontrado.'});
  if(target.id===ADMIN_ACCOUNT_ID)return res.status(400).json({error:'A conta administradora não pode ser excluída.'});
  const remaining=users.filter(u=>u.id!==target.id);
  remaining.forEach(u=>{
    if(Array.isArray(u.followers))u.followers=u.followers.filter(id=>id!==target.id);
    if(Array.isArray(u.following))u.following=u.following.filter(id=>id!==target.id);
  });
  writeUsers(remaining);
  const sessions=readSessions();
  revokeUserSessions(sessions,target.id);
  writeSessions(sessions);
  const stateFile=stateFileFor(target.id);
  if(fs.existsSync(stateFile))fs.unlinkSync(stateFile);
  res.json({ok:true});
});
// Provision the first administrator only. This endpoint is deliberately not
// exposed in the UI and becomes permanently unavailable after first use.
app.post('/api/bootstrap/admin', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && !req.secure) {
    return res.status(426).json({ error: 'HTTPS é obrigatório para o provisionamento.' });
  }
  if (Buffer.byteLength(ADMIN_BOOTSTRAP_SECRET, 'utf8') < 32) return res.sendStatus(404);
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (bootstrapRateLimited(ip)) return res.status(429).json({ error: 'Muitas tentativas. Tente novamente mais tarde.' });
  const suppliedSecret = String(req.get('x-admin-bootstrap') || '');
  if (!bootstrapSecretMatches(suppliedSecret, ADMIN_BOOTSTRAP_SECRET)) {
    recordBootstrapFailure(ip);
    return res.status(403).json({ error: 'Autorização de provisionamento inválida.' });
  }
  bootstrapAttempts.delete(String(ip));

  if (fs.existsSync(ADMIN_BOOTSTRAP_STATE_FILE)) return res.status(410).json({ error: 'O provisionamento inicial já foi consumido.' });
  let users = readBootstrapUsers();
  if (!users) return res.status(503).json({ error: 'O arquivo de contas não pôde ser validado.' });
  if (users.length) return res.status(409).json({ error: 'O provisionamento só está disponível antes da primeira conta.' });

  const name = cleanText(req.body?.name, 60);
  const rawUsername = cleanText(req.body?.username, 40);
  const username = normalizeUsername(rawUsername);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[a-zA-Z0-9_.]{3,30}$/.test(rawUsername) || !username) {
    return res.status(400).json({ error: 'Informe um usuário de 3 a 30 caracteres: letras, números, ponto ou sublinhado.' });
  }
  if (!normalizeUsername(ADMIN_USERNAME) || username !== normalizeUsername(ADMIN_USERNAME)) {
    return res.status(400).json({ error: 'O usuário deve corresponder à conta administradora configurada.' });
  }
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'A senha deve ter entre 8 e 128 caracteres.' });

  try {
    const passwordHash = await hashPassword(password);
    // Recheck after the asynchronous scrypt operation so concurrent requests
    // cannot create more than one account.
    if (fs.existsSync(ADMIN_BOOTSTRAP_STATE_FILE)) return res.status(410).json({ error: 'O provisionamento inicial já foi consumido.' });
    users = readBootstrapUsers();
    if (!users) return res.status(503).json({ error: 'O arquivo de contas não pôde ser validado.' });
    if (users.length) return res.status(409).json({ error: 'O provisionamento só está disponível antes da primeira conta.' });
    if (users.some(user => normalizeUsername(user.username) === username)) return res.status(409).json({ error: 'Este usuário já está cadastrado.' });

    const id = crypto.randomUUID();
    const user = {
      id,
      name: name || username,
      username,
      email: '',
      avatar: '',
      password: passwordHash,
      state: cleanState({}),
      followers: [],
      following: [],
      createdAt: new Date().toISOString(),
      blocked: false
    };
    // Commit the recovery journal first. If any following write fails or the
    // process stops, bootstrap remains locked and startup can finish the same
    // account creation from this hash-only record.
    writeJson(ADMIN_BOOTSTRAP_STATE_FILE, { status: 'provisioning', user });
    recoverAdminBootstrap();
    return res.status(201).json({ ok: true, user: publicUser(user) });
  } catch {
    return res.status(500).json({ error: 'Não foi possível provisionar a conta administradora.' });
  }
});

app.get('/api/auth/invite-availability',(req,res)=>res.status(410).json({valid:false,error:'O cadastro público está desativado. Solicite suas credenciais ao administrador.'}));
app.post('/api/auth/register',(req,res)=>res.status(403).json({error:'O cadastro público está desativado. Solicite suas credenciais ao administrador.'}));
function loginBucketKey(value) { return String(value || '').toLowerCase().slice(0, 180); }
function loginRateLimited(ip, identifier) {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) if (entry.resetAt <= now) loginAttempts.delete(key);
  return [loginBucketKey(`ip:${ip}`), loginBucketKey(`account:${ip}:${identifier}`)].some(key => (loginAttempts.get(key)?.count || 0) >= LOGIN_MAX_ATTEMPTS);
}
function recordLoginFailure(ip, identifier) {
  const now = Date.now();
  [loginBucketKey(`ip:${ip}`), loginBucketKey(`account:${ip}:${identifier}`)].forEach(key => {
    const entry = loginAttempts.get(key);
    if (!entry || entry.resetAt <= now) loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    else entry.count++;
  });
}
function clearLoginFailures(ip, identifier) {
  loginAttempts.delete(loginBucketKey(`ip:${ip}`));
  loginAttempts.delete(loginBucketKey(`account:${ip}:${identifier}`));
}
function bearerToken(req) { return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim(); }
app.post('/api/auth/migrate', (req, res) => {
  const legacyToken = bearerToken(req);
  if (!legacyToken) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  const sessions = readSessions();
  const userId = sessionUserId(sessions[legacyToken]);
  const user = userId && readUsers().find(item => item.id === userId && !item.blocked);
  if (!user) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  const token = createSession(sessions, user.id);
  delete sessions[legacyToken];
  writeSessions(sessions);
  setSessionCookie(req, res, token);
  res.json({ user: publicUser(user), state: readUserState(user) });
});
app.post('/api/auth/login', async (req,res) => {
  try {
    const identifier = cleanText(req.body?.identifier || req.body?.username || req.body?.email, 160);
    const password = String(req.body?.password || '');
    if (!identifier || !password) return res.status(400).json({ error: 'Digite seu usuário e senha.' });
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (loginRateLimited(ip, identifier)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
    const normalizedUsername = identifier.includes('@') ? '' : normalizeUsername(identifier);
    let users = migrateUsers();
    let user = users.find(item => (normalizedUsername && normalizeUsername(item.username) === normalizedUsername) || String(item.email || '').toLowerCase() === identifier.toLowerCase());
    const verifiedPasswordHash = user?.password?.hash || '';
    const passwordMatches = await verifyPassword(password, user?.password);
    if (!user || user.blocked || !passwordMatches) {
      recordLoginFailure(ip, identifier);
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }
    if (user.password?.algorithm !== 'scrypt' || Number(user.password.N) < PASSWORD_SCRYPT.N || Number(user.password.p) < PASSWORD_SCRYPT.p) {
      const passwordHash=await hashPassword(password);
      users=readUsers();
      user=users.find(item=>item.id===user.id);
      if(!user||user.blocked||user.password?.hash!==verifiedPasswordHash)return res.status(401).json({error:'Usuário ou senha incorretos.'});
      user.password = passwordHash;
      writeUsers(users);
    }
    clearLoginFailures(ip, identifier);
    const sessions = readSessions();
    const token = createSession(sessions, user.id);
    writeSessions(sessions);
    setSessionCookie(req, res, token);
    return res.json({ user: publicUser(user), state: readUserState(user) });
  } catch {
    return res.status(500).json({ error: 'Não foi possível entrar.' });
  }
});
app.post('/api/auth/logout', (req,res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  const sessions = readSessions();
  if (token) delete sessions[token];
  writeSessions(sessions);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});
app.get('/api/me',(req,res)=>{const u=authUser(req);if(!u)return res.status(401).json({error:'Não autenticado.'});res.json({user:publicUser(u),state:readUserState(u)});});
app.put('/api/me/profile',(req,res)=>{const u=authUser(req);if(!u)return res.status(401).json({error:'Não autenticado.'});const users=readUsers();const name=cleanText(req.body?.name,60);if(name)u.name=name; const requestedUsername=normalizeUsername(req.body?.username); if(requestedUsername){ if(!/^[a-z0-9_.]{3,30}$/.test(requestedUsername)) return res.status(400).json({error:'O nome de usuário deve ter de 3 a 30 caracteres.'}); if(readUsers().some(x=>x.id!==u.id&&normalizeUsername(x.username)===requestedUsername)) return res.status(409).json({error:'Este nome de usuário já está em uso.'}); u.username=requestedUsername; } u.avatar=cleanText(req.body?.avatar,250000);writeUserState(u,req.body?.state||readUserState(u));writeUsers(users);res.json({user:publicUser(u),state:readUserState(u)});});
app.post('/api/me/state',(req,res)=>{const u=authUser(req);if(!u)return res.status(401).json({error:'Não autenticado.'});const users=readUsers(); const clean=cleanState(req.body?.state); writeUserState(u,clean); if(req.body?.name)u.name=cleanText(req.body.name,60); writeUsers(users); res.json({ok:true,state:clean});});
// Salvamento para celular/fechamento de aba: sendBeacon não permite cabeçalho Authorization,
// então aceitamos o token no corpo apenas neste endpoint e validamos a mesma sessão.
app.post('/api/me/state-beacon',(req,res)=>{const u=authUser(req);if(!u)return res.status(401).json({error:'Não autenticado.'});const users=readUsers();const account=users.find(x=>x.id===u.id);if(!account||account.blocked)return res.status(401).json({error:'Não autenticado.'});const clean=cleanState(req.body?.state);writeUserState(account,clean);if(req.body?.name)account.name=cleanText(req.body.name,60);writeUsers(users);res.json({ok:true});});

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
  if (!TOKEN) throw new Error('Configure TMDB_READ_ACCESS_TOKEN no arquivo .env');
  const u = new URL('https://api.themoviedb.org/3' + endpoint);
  for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k,v);
  const r = await fetch(u, {headers:{Authorization:`Bearer ${TOKEN}`, accept:'application/json'}});
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

const tvKeywordsCache = new Map();
const TV_KEYWORDS_CACHE_TTL_MS = 30 * 60 * 1000;
async function getTvKeywords(id) {
  const key = String(id);
  const cached = tvKeywordsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = tmdb(`/tv/${encodeURIComponent(key)}/keywords`).then(data => {
    const keywords = Array.isArray(data?.results) ? data.results : [];
    tvKeywordsCache.set(key, { promise: Promise.resolve(keywords), expiresAt: Date.now() + TV_KEYWORDS_CACHE_TTL_MS });
    while (tvKeywordsCache.size > 300) tvKeywordsCache.delete(tvKeywordsCache.keys().next().value);
    return keywords;
  }).catch(error => {
    tvKeywordsCache.delete(key);
    throw error;
  });
  tvKeywordsCache.set(key, { promise, expiresAt: Date.now() + TV_KEYWORDS_CACHE_TTL_MS });
  return promise;
}

const movieKeywordsCache = new Map();
const MOVIE_KEYWORDS_CACHE_TTL_MS = 30 * 60 * 1000;
async function getMovieKeywords(id) {
  const key = String(id);
  const cached = movieKeywordsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = tmdb(`/movie/${encodeURIComponent(key)}/keywords`).then(data => {
    const keywords = Array.isArray(data?.keywords) ? data.keywords : [];
    movieKeywordsCache.set(key, { promise: Promise.resolve(keywords), expiresAt: Date.now() + MOVIE_KEYWORDS_CACHE_TTL_MS });
    while (movieKeywordsCache.size > 300) movieKeywordsCache.delete(movieKeywordsCache.keys().next().value);
    return keywords;
  }).catch(error => {
    movieKeywordsCache.delete(key);
    throw error;
  });
  movieKeywordsCache.set(key, { promise, expiresAt: Date.now() + MOVIE_KEYWORDS_CACHE_TTL_MS });
  return promise;
}

function hasSharedTvGenre(current, candidate) {
  const currentIds = new Set((current?.genres || []).map(item => String(item?.id ?? '')).filter(Boolean));
  const candidateIds = Array.isArray(candidate?.genre_ids)
    ? candidate.genre_ids.map(String)
    : (candidate?.genres || []).map(item => String(item?.id ?? '')).filter(Boolean);
  return candidateIds.some(id => currentIds.has(id));
}

async function loadSimilarTvRecommendations(current, similarResponse, currentKeywords, recommendationResponse) {
  const candidates = mergeCandidateSources(similarResponse, recommendationResponse, 20);
  const currentId = Number(current?.id);
  const seen = new Set(Number.isSafeInteger(currentId) ? [currentId] : []);
  const eligible = candidates.filter(candidate => {
    const id = Number(candidate?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !hasSharedTvGenre(current, candidate)) return false;
    seen.add(id);
    return true;
  }).slice(0, 20);

  const keywordMap = new Map();
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(4, eligible.length) }, async () => {
    while (nextIndex < eligible.length) {
      const candidate = eligible[nextIndex++];
      const id = Number(candidate.id);
      try { keywordMap.set(id, await getTvKeywords(id)); }
      catch { keywordMap.set(id, []); }
    }
  });
  await Promise.all(workers);

  let resolvedCurrentKeywords = Array.isArray(currentKeywords?.results) ? currentKeywords.results : currentKeywords;
  if (!Array.isArray(resolvedCurrentKeywords) || !resolvedCurrentKeywords.length) {
    try { resolvedCurrentKeywords = await getTvKeywords(currentId); }
    catch { resolvedCurrentKeywords = []; }
  }

  return rankSimilarSeries({
    current,
    candidates,
    currentKeywords: resolvedCurrentKeywords,
    keywordsById: keywordMap,
    limit: 10
  });
}

async function loadSimilarMovieRecommendations(current, similarResponse, currentKeywords, recommendationResponse) {
  const candidates = mergeCandidateSources(similarResponse, recommendationResponse, 20).filter(candidate =>
    !candidate?.media_type || candidate.media_type === 'movie'
  );
  const currentId = Number(current?.id);
  const eligible = candidates.filter(candidate => {
    const id = Number(candidate?.id);
    return Number.isSafeInteger(id) && id > 0 && id !== currentId && (candidate?.title || candidate?.original_title);
  }).slice(0, 20);

  const keywordMap = new Map();
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(4, eligible.length) }, async () => {
    while (nextIndex < eligible.length) {
      const candidate = eligible[nextIndex++];
      const id = Number(candidate.id);
      try { keywordMap.set(id, await getMovieKeywords(id)); }
      catch { keywordMap.set(id, []); }
    }
  });
  await Promise.all(workers);

  let resolvedCurrentKeywords = Array.isArray(currentKeywords?.keywords) ? currentKeywords.keywords : currentKeywords;
  if (!Array.isArray(resolvedCurrentKeywords) || !resolvedCurrentKeywords.length) {
    try { resolvedCurrentKeywords = await getMovieKeywords(currentId); }
    catch { resolvedCurrentKeywords = []; }
  }

  return rankSimilarMovies({
    current,
    candidates,
    currentKeywords: resolvedCurrentKeywords,
    keywordsById: keywordMap,
    limit: 10
  });
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
      ()=>tmdb('/trending/all/day',{language:'pt-BR'}),
      ()=>tmdb('/trending/all/week',{language:'pt-BR'}),
      ()=>tmdb('/tv/popular',{language:'pt-BR',page:1}),
      ()=>tmdb('/movie/popular',{language:'pt-BR',region:'BR',page:1}),
      ()=>tmdb('/tv/on_the_air',{language:'pt-BR',page:1}),
      ()=>tmdb('/movie/now_playing',{language:'pt-BR',region:'BR',page:1}),
      ()=>tmdb('/discover/tv',{language:'pt-BR',watch_region:'BR',sort_by:'popularity.desc',first_air_date_gte:since90,first_air_date_lte:today,page:1}),
      ()=>tmdb('/discover/movie',{language:'pt-BR',region:'BR',watch_region:'BR',sort_by:'popularity.desc',primary_release_date_gte:since90,primary_release_date_lte:today,page:1}),
      ()=>tmdb('/tv/top_rated',{language:'pt-BR',page:1}),
      ()=>tmdb('/movie/upcoming',{language:'pt-BR',region:'BR',page:1}),
      ()=>tmdb('/discover/tv',{language:'pt-BR',sort_by:'popularity.desc','first_air_date.gte':since90,'first_air_date.lte':today,page:1})
    ];
    // Limita a concorrência para evitar respostas vazias quando o TMDB recebe
    // muitas consultas de catálogo de uma vez.
    const settled = new Array(requests.length);
    const concurrency = 2;
    for(let i=0;i<requests.length;i+=concurrency){
      const batch=await Promise.allSettled(requests.slice(i,i+concurrency).map(request=>request()));
      batch.forEach((result,index)=>{settled[i+index]=result});
    }
    // Tenta novamente respostas com erro ou sem resultados antes de devolver
    // carrosséis vazios para a página inicial.
    for(let i=2;i<requests.length;i++){
      const result=settled[i];
      if(result?.status==='fulfilled'&&Array.isArray(result.value?.results)&&result.value.results.length)continue;
      try{settled[i]={status:'fulfilled',value:await requests[i]()}}catch(error){settled[i]={status:'rejected',reason:error}}
    }
    const value = (i, fallback={results:[]}) => settled[i].status==='fulfilled' ? settled[i].value : fallback;
    const data={
      trendingDay:value(0), trending:value(1), tv:value(2), movies:value(3), popularTv:value(4),
      popularMovies:value(5), newTv:value(6), newMovies:value(7),
      topRatedTv:value(8), upcomingMovies:value(9), newestTv:value(10)
    };
    const categoriesLoaded=settled.slice(2).every(result=>result?.status==='fulfilled'&&Array.isArray(result.value?.results)&&result.value.results.length>0);
    homeCache={data,expires:Date.now()+(categoriesLoaded?15*60*1000:30*1000)};
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

app.get('/api/series/new', async (req,res)=>{
  try {
    const page=Math.max(1,Math.min(500,Number(req.query.page)||1));
    const today=new Date().toISOString().slice(0,10);
    const since90=new Date(Date.now()-90*24*60*60*1000).toISOString().slice(0,10);
    const d=await tmdb('/discover/tv',{language:'pt-BR',sort_by:'popularity.desc','first_air_date.gte':since90,'first_air_date.lte':today,page});
    res.json(d);
  } catch(e){res.status(500).json({error:e.message});}
});

const discoverCatalogCache = new Map();
const discoverGenreCache = new Map();
const discoverItemCache = new Map();
const discoverCatalogInFlight = new Map();
const discoverGenreInFlight = new Map();
const DISCOVER_CACHE_TTL_MS = 10 * 60 * 1000;
app.get('/api/discover', async (req,res)=>{
  let filters;
  try { filters = normalizeDiscoverQuery(req.query, discoverDateKey()); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const request = buildDiscoverRequest(filters);
  const cacheKey = `${request.endpoint}?${new URLSearchParams(request.params).toString()}`;
  const cached = discoverCatalogCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return res.json({ ...cached.data, _cacheExpiresAt: cached.expires });
  let pending = discoverCatalogInFlight.get(cacheKey);
  if (!pending) {
    pending = (async()=>{
      const response = await tmdb(request.endpoint, request.params);
      const data = filters.source === 'upcoming' ? filterUpcomingPayload(response, filters.today) : response;
      const entry = { data, expires: Date.now() + DISCOVER_CACHE_TTL_MS };
      discoverCatalogCache.set(cacheKey, entry);
      if (discoverCatalogCache.size > 150) {
        for (const [key,value] of discoverCatalogCache) if (value.expires <= Date.now()) discoverCatalogCache.delete(key);
        while (discoverCatalogCache.size > 150) discoverCatalogCache.delete(discoverCatalogCache.keys().next().value);
      }
      return entry;
    })();
    discoverCatalogInFlight.set(cacheKey, pending);
  }
  try {
    const entry = await pending;
    return res.json({ ...entry.data, _cacheExpiresAt: entry.expires });
  } catch {
    return res.status(502).json({ error: 'Não foi possível carregar este catálogo agora.' });
  } finally {
    if (discoverCatalogInFlight.get(cacheKey) === pending) discoverCatalogInFlight.delete(cacheKey);
  }
});

app.get('/api/discover/genres', async (req,res)=>{
  const mediaType = String(req.query.type || '').toLowerCase();
  if (!['movie','tv'].includes(mediaType)) return res.status(400).json({ error: 'Tipo de catálogo inválido.' });
  const cached = discoverGenreCache.get(mediaType);
  if (cached && cached.expires > Date.now()) return res.json({ ...cached.data, _cacheExpiresAt: cached.expires });
  let pending = discoverGenreInFlight.get(mediaType);
  if (!pending) {
    pending = (async()=>{
      const data = await tmdb(`/genre/${mediaType}/list`, { language: 'pt-BR' });
      const entry = { data, expires: Date.now() + 24 * 60 * 60 * 1000 };
      discoverGenreCache.set(mediaType, entry);
      return entry;
    })();
    discoverGenreInFlight.set(mediaType, pending);
  }
  try {
    const entry = await pending;
    return res.json({ ...entry.data, _cacheExpiresAt: entry.expires });
  } catch {
    return res.status(502).json({ error: 'Não foi possível carregar os gêneros agora.' });
  } finally {
    if (discoverGenreInFlight.get(mediaType) === pending) discoverGenreInFlight.delete(mediaType);
  }
});

app.get('/api/discover/item/:type/:id', async (req,res)=>{
  const mediaType = String(req.params.type || '').toLowerCase();
  const id = String(req.params.id || '');
  if (!['movie','tv'].includes(mediaType) || !/^\d{1,12}$/.test(id) || Number(id) <= 0) return res.status(400).json({ error: 'Título inválido.' });
  const cacheKey = `${mediaType}:${id}`;
  const cached = discoverItemCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return res.json(cached.data);
  try {
    const data = await tmdb(`/${mediaType}/${id}`, { language: 'pt-BR' });
    discoverItemCache.set(cacheKey, { data, expires: Date.now() + 24 * 60 * 60 * 1000 });
    return res.json(data);
  } catch {
    return res.status(502).json({ error: 'Não foi possível carregar os detalhes deste título.' });
  }
});

app.get('/api/search', async (req,res)=>{
  try {
    const page=Math.max(1,Math.min(500,Number(req.query.page)||1));
    res.json(await tmdb('/search/multi',{query:req.query.q||'',language:'pt-BR',region:'BR',include_adult:'false',page}));
  }
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/tv/:id', async (req,res)=>{
  try {
    if(req.query.tracker==='1') return res.json(await tmdb(`/tv/${req.params.id}`,{language:'pt-BR'}));
    const detail = await tmdb(`/tv/${req.params.id}`,{language:'pt-BR',append_to_response:'credits,videos,images,recommendations,similar,keywords'});
    detail.similar = {
      ...(detail.similar || {}),
      results: await loadSimilarTvRecommendations(detail, detail.similar, detail.keywords, detail.recommendations)
    };
    res.json(detail);
  }
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/tv/:id/season/:season', async (req,res)=>{
  try { res.json(await tmdb(`/tv/${req.params.id}/season/${req.params.season}`,req.query.tracker==='1'?{language:'pt-BR'}:{language:'pt-BR',append_to_response:'credits,videos,images'})); }
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/tv/:id/providers', async (req,res)=>{
  try { res.json(await tmdb(`/tv/${req.params.id}/watch/providers`,{})); }
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/movie/:id', async (req,res)=>{
  try {
    const detail = await tmdb(`/movie/${req.params.id}`,{language:'pt-BR',append_to_response:'credits,videos,images,recommendations,similar,keywords'});
    detail.similar = {
      ...(detail.similar || {}),
      results: await loadSimilarMovieRecommendations(detail, detail.similar, detail.keywords, detail.recommendations)
    };
    res.json(detail);
  }
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
    const {mediaType,mediaId,tvId,season,episode,text,imageData}=req.body||{};
    const isMovie=mediaType==='movie';
    if((mediaType!=='movie'&&mediaType!=='tv') || (!text && !imageData)) return res.status(400).json({error:'Preencha o comentário ou escolha uma foto.'});
    if(isMovie ? !/^\d+$/.test(String(mediaId||'')) : (!/^\d+$/.test(String(tvId||'')) || !/^\d+$/.test(String(season||'')) || !/^\d+$/.test(String(episode||'')))) return res.status(400).json({error:isMovie?'Filme inválido.':'Episódio inválido.'});
    let imageUrl=null;
    if(imageData){
      const match=String(imageData).match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i);
      if(!match) return res.status(400).json({error:'Formato de imagem não suportado.'});
      const encoded=match[2];
      const buffer=Buffer.from(encoded,'base64');
      if(!buffer.length || buffer.toString('base64')!==encoded) return res.status(400).json({error:'Arquivo de imagem inválido.'});
      if(buffer.length>5*1024*1024) return res.status(413).json({error:'A foto deve ter no máximo 5 MB.'});
      const detected=buffer.length>=12&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png'
        :buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff?'jpg'
        :buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP'?'webp':'';
      const declared=match[1].toLowerCase()==='jpeg'?'jpg':match[1].toLowerCase();
      if(!detected || detected!==declared) return res.status(400).json({error:'O conteúdo do arquivo não corresponde ao formato informado.'});
      const ext=detected;
      const filename=`${crypto.randomUUID()}.${ext}`;
      const uploadPath=path.join(UPLOAD_DIR,filename);
      fs.writeFileSync(uploadPath,buffer,{flag:'wx',mode:0o640});
      imageUrl=`/uploads/${filename}`;
    }
    const comments=readComments();
    const item={id:crypto.randomUUID(),mediaType:isMovie?'movie':'tv',mediaId:String(isMovie?mediaId:tvId),tvId:isMovie?null:String(tvId||''),season:isMovie?null:String(season||''),episode:isMovie?null:String(episode||''),userId:String(req.account.id),userName:cleanText(req.account.name||req.account.username||'Coruja',60),text:cleanText(text,1200),imageUrl,createdAt:new Date().toISOString(),likes:0,replies:[]};
    comments.push(item); writeComments(comments); res.status(201).json(item);
  } catch(e){ res.status(500).json({error:'Não foi possível publicar o comentário.'}); }
});

app.post('/api/comments/:id/replies', (req,res)=>{
  try {
    const {text}=req.body||{};
    const value=cleanText(text,500);
    if(!value) return res.status(400).json({error:'Escreva uma resposta.'});
    const comments=readComments();
    const item=comments.find(c=>c.id===req.params.id);
    if(!item) return res.status(404).json({error:'Comentário não encontrado.'});
    if(!Array.isArray(item.replies)) item.replies=[];
    const reply={id:crypto.randomUUID(),userId:String(req.account.id),userName:cleanText(req.account.name||req.account.username||'Coruja',60),text:value,createdAt:new Date().toISOString()};
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
  if(String(req.account.id)!==String(item.userId)) return res.status(403).json({error:'Você só pode excluir seus próprios comentários.'});
  if(item.imageUrl) { const filename=path.basename(String(item.imageUrl)); const p=path.join(UPLOAD_DIR,filename); try{fs.unlinkSync(p)}catch{} }
  writeComments(comments.filter(c=>c.id!==item.id)); res.json({ok:true});
});

app.listen(PORT,'0.0.0.0',()=>console.log(`CORUJA em http://localhost:${PORT}`));
