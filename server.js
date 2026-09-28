// 植物大战僵尸在线版 —— 账号 + 云存档服务器
// 一个 Express 进程同时托管游戏静态文件(public/)和 JSON API。
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8123;
// 部署在 HTTPS(反向代理)后面时设 SECURE_COOKIE=1，让会话 cookie 带上 Secure。
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';
const SESSION_DAYS = 30;
const USER_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/;   // 字母数字下划线或中文，2-20 位

initDb();
const app = express();
app.set('trust proxy', 1);                 // 取到反代传来的真实 IP
app.use(express.json({ limit: '1200kb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });

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
// 简单内存限流：同一 IP 15 分钟内 login/register 尝试上限
const attempts = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const rec = attempts.get(req.ip) || { count: 0, reset: now + 9e5 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 9e5; }
  rec.count++;
  attempts.set(req.ip, rec);
  if (rec.count > 50) return res.status(429).json({ error: 'too_many_attempts' });
  next();
}

// ---------- API ----------
app.post('/api/register', rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (!USER_RE.test(username || '')) return res.status(400).json({ error: 'bad_username' });
  if (typeof password !== 'string' || password.length < 6 || password.length > 200)
    return res.status(400).json({ error: 'bad_password' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username))
    return res.status(409).json({ error: 'username_taken' });
  const info = db.prepare('INSERT INTO users(username,pw_hash,created_at) VALUES(?,?,?)')
    .run(username, hashPassword(password), Date.now());
  setSession(res, info.lastInsertRowid);
  res.json({ username });
});

app.post('/api/login', rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!u || !verifyPassword(String(password || ''), u.pw_hash))
    return res.status(401).json({ error: 'bad_credentials' });
  setSession(res, u.id);
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
  if (json.length > 1_000_000) return res.status(413).json({ error: 'save_too_large' });
  const now = Date.now();
  db.prepare(`INSERT INTO saves(user_id,data,updated_at) VALUES(?,?,?)
              ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`)
    .run(req.user.id, json, now);
  res.json({ ok: true, updatedAt: now });
}
app.put('/api/save', authRequired, saveHandler);
app.post('/api/save', authRequired, saveHandler);

// ---------- 游戏静态文件 ----------
// 只暴露 public/，server.js / db.js / data.db 都在根目录，绝不外泄。
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders(res, filePath) {
    // 页面/脚本/样式禁用强缓存：改动后刷新即生效，也避免浏览器留着旧版卡住。
    // 仍用 ETag 协商，内容没变会返回 304，不影响加载速度。
    if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.listen(PORT, () => console.log(`PvZ 在线版运行中 → http://127.0.0.1:${PORT}`));
