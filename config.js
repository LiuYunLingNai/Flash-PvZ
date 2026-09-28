// 配置加载：读取根目录 config.yaml，合并默认值，环境变量可覆盖。
// 优先级：环境变量 > config.yaml > 内置默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, 'config.yaml');

let y = {};
try {
  y = YAML.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
} catch (e) {
  console.warn('[config] 读取 config.yaml 失败，改用默认配置：', e.message);
}

const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === null ? d : v === true || v === 'true' || v === '1' || v === 1);

const dbPathRaw = process.env.DB_PATH || y.dbPath || 'data.db';

export const config = {
  port: num(process.env.PORT ?? y.port, 8123),
  secureCookie: process.env.SECURE_COOKIE !== undefined
    ? process.env.SECURE_COOKIE === '1'
    : bool(y.secureCookie, false),
  // 相对路径按项目根目录解析
  dbPath: path.isAbsolute(dbPathRaw) ? dbPathRaw : path.join(__dirname, dbPathRaw),
  sessionDays: num(y.sessionDays, 30),
  usernameMin: num(y.username?.minLength, 2),
  usernameMax: num(y.username?.maxLength, 20),
  passwordMin: num(y.password?.minLength, 6),
  passwordMax: num(y.password?.maxLength, 200),
  rateMaxAttempts: num(y.rateLimit?.maxAttempts, 50),
  rateWindowMinutes: num(y.rateLimit?.windowMinutes, 15),
  saveMaxKb: num(y.saveMaxKb, 1000),
};
