// 植物大战僵尸在线版 —— 账号 + 云存档服务器
// 一个 Express 进程同时托管游戏静态文件(public/)和 JSON API。
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { db, initDb } from './db.js';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = config.port;
// HTTPS(反向代理)部署时在 config.yaml 设 secureCookie: true，让会话 cookie 带上 Secure。
const SECURE_COOKIE = config.secureCookie;
const SESSION_DAYS = config.sessionDays;
const USER_RE = new RegExp(`^[A-Za-z0-9_\u4e00-\u9fa5]{${config.usernameMin},${config.usernameMax}}$`);
const SAVE_MAX_BYTES = config.saveMaxKb * 1000;

// ---------- 日志 ----------
// 统一带时间戳的日志，方便在 pm2/systemd 里排查问题。
function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function log(...a) { console.log(`[${ts()}]`, ...a); }

const PUBLIC_DIR = path.join(__dirname, 'public');

// Ruffle 的 .wasm 有 14MB 一个，手机弱网/反代下整段流式下载很容易中途断
// （Ruffle 报 "Failed to read from a ReadableStream"）。启动时把 wasm/js 预压成 .gz，
// 支持 gzip 的浏览器只需传 ~1/3 体积，大幅降低下载中断概率、也更快。
function ensurePrecompressed(dir) {
  let made = 0;
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return; }
  for (const name of files) {
    if (!/\.(wasm|js)$/i.test(name)) continue;
    const src = path.join(dir, name);
    const gz = src + '.gz';
    try {
      const s = fs.statSync(src);
      if (fs.existsSync(gz) && fs.statSync(gz).mtimeMs >= s.mtimeMs) continue;  // 已是最新
      fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(src), { level: 9 }));
      made++;
    } catch (e) { log('预压缩失败', name, '-', e.message); }
  }
  if (made) log(`已预压缩 ${made} 个静态资源 (gzip)`);
}

initDb();
log('数据库就绪 →', config.dbPath);
ensurePrecompressed(path.join(PUBLIC_DIR, 'ruffle'));

const app = express();
app.set('trust proxy', 1);                 // 取到反代传来的真实 IP
app.use(express.json({ limit: `${config.saveMaxKb + 200}kb` }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

// 访问日志：API 请求全记；静态资源只在出错(4xx/5xx)时记，避免大量素材加载刷屏。
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/') || res.statusCode >= 400) {
      log(`${req.ip} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

// ---------- 工具 ----------
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const s = Buffer.from(hashHex, 'hex');
  return h.length === s.length && crypto.timingSafeEqual(h, s);
}
function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)')
    .run(token, userId, now, now + SESSION_DAYS * 864e5);
  const c = [`session=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (SECURE_COOKIE) c.push('Secure');
  res.setHeader('Set-Cookie', c.join('; '));
}
function clearSessionCookie(res) {
  const c = ['session=', 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (SECURE_COOKIE) c.push('Secure');
  res.setHeader('Set-Cookie', c.join('; '));
}
function currentUser(req) {
  const t = parseCookies(req).session;
  if (!t) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(t);
  if (!s) return null;
  if (s.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token=?').run(t); return null; }
  return db.prepare('SELECT id,username FROM users WHERE id=?').get(s.user_id);
}
function authRequired(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_authenticated' });
  req.user = u;
  next();
}
// 简单内存限流：同一 IP 在 config.yaml 设定的时间窗内 login/register 尝试上限
const attempts = new Map();
const RATE_WINDOW_MS = config.rateWindowMinutes * 60000;
function rateLimit(req, res, next) {
  const now = Date.now();
  const rec = attempts.get(req.ip) || { count: 0, reset: now + RATE_WINDOW_MS };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + RATE_WINDOW_MS; }
  rec.count++;
  attempts.set(req.ip, rec);
  if (rec.count > config.rateMaxAttempts) return res.status(429).json({ error: 'too_many_attempts' });
  next();
}

// ---------- API ----------
app.post('/api/register', rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (!USER_RE.test(username || '')) return res.status(400).json({ error: 'bad_username' });
  if (typeof password !== 'string' || password.length < config.passwordMin || password.length > config.passwordMax)
    return res.status(400).json({ error: 'bad_password' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username))
    return res.status(409).json({ error: 'username_taken' });
  const info = db.prepare('INSERT INTO users(username,pw_hash,created_at) VALUES(?,?,?)')
    .run(username, hashPassword(password), Date.now());
  setSession(res, info.lastInsertRowid);
  log(`新用户注册: ${username} (id=${info.lastInsertRowid})`);
  res.json({ username });
});

app.post('/api/login', rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!u || !verifyPassword(String(password || ''), u.pw_hash))
    return res.status(401).json({ error: 'bad_credentials' });
  setSession(res, u.id);
  log(`登录成功: ${u.username} (id=${u.id})`);
  res.json({ username: u.username });
});

app.post('/api/logout', (req, res) => {
  const t = parseCookies(req).session;
  if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ username: u.username });
});

app.get('/api/save', authRequired, (req, res) => {
  const row = db.prepare('SELECT data,updated_at FROM saves WHERE user_id=?').get(req.user.id);
  res.json({ data: row ? JSON.parse(row.data) : {}, updatedAt: row ? row.updated_at : 0 });
});

// 存档写入：PUT(常规) 和 POST(sendBeacon 只能发 POST) 都接受。
function saveHandler(req, res) {
  const data = req.body && req.body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return res.status(400).json({ error: 'bad_data' });
  const json = JSON.stringify(data);
  if (json.length > SAVE_MAX_BYTES) return res.status(413).json({ error: 'save_too_large' });
  const now = Date.now();
  db.prepare(`INSERT INTO saves(user_id,data,updated_at) VALUES(?,?,?)
              ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`)
    .run(req.user.id, json, now);
  log(`存档写入: ${req.user.username} (id=${req.user.id}, ${(json.length / 1024).toFixed(1)}KB)`);
  res.json({ ok: true, updatedAt: now });
}
app.put('/api/save', authRequired, saveHandler);
app.post('/api/save', authRequired, saveHandler);

// ---------- 游戏静态文件 ----------
// 只暴露 public/，server.js / db.js / data.db 都在根目录，绝不外泄。

// 预压缩优先：有 <文件>.gz 且客户端支持 gzip 时，直接发压缩版（wasm 14MB→~4MB）。
const GZ_TYPES = { '.wasm': 'application/wasm', '.js': 'text/javascript; charset=utf-8' };
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const ext = path.extname(req.path).toLowerCase();
  const type = GZ_TYPES[ext];
  if (!type || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
  const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  const gz = path.join(PUBLIC_DIR, rel + '.gz');
  if (!gz.startsWith(PUBLIC_DIR + path.sep)) return next();     // 防目录穿越
  fs.stat(gz, (err, st) => {
    if (err || !st.isFile()) return next();                    // 没预压缩版就走普通静态
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Length', st.size);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Ruffle 的 wasm 和 core.ruffle.<hash>.js 文件名带内容哈希，可长期强缓存；
    // ruffle.js 等无哈希文件仍用协商缓存（改动后刷新即生效）。
    const hashed = ext === '.wasm' || /\.[0-9a-f]{12,}\.js$/i.test(rel);
    res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(gz).pipe(res);
  });
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  setHeaders(res, filePath) {
    // 页面/脚本/样式禁用强缓存：改动后刷新即生效，也避免浏览器留着旧版卡住。
    // 仍用 ETag 协商，内容没变会返回 304，不影响加载速度。
    if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.listen(PORT, () => {
  log(`PvZ 在线版运行中 → http://127.0.0.1:${PORT}`);
  log(`配置: 端口=${PORT} secureCookie=${SECURE_COOKIE} 会话=${SESSION_DAYS}天 单存档上限=${config.saveMaxKb}KB`);
});
