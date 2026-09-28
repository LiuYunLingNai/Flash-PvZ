// 配置加载：def_config/config.yaml 为出厂默认，config/config.yaml 为本机覆盖，
// 二者深合并后再让环境变量覆盖。
// 优先级：环境变量 > config/config.yaml > def_config/config.yaml > 内置兜底默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEF_FILE = path.join(__dirname, 'def_config', 'config.yaml');   // 默认值，勿改
const USER_FILE = path.join(__dirname, 'config', 'config.yaml');      // 本机覆盖，gitignore

function readYaml(file, warnIfMissing) {
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) {
    if (warnIfMissing) console.warn('[config] 读取', path.relative(__dirname, file), '失败，忽略：', e.message);
    return {};
  }
}

// 深合并：user 覆盖 def；仅对「纯对象」递归，其余（含数组）直接覆盖。
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

const y = deepMerge(readYaml(DEF_FILE, true), readYaml(USER_FILE, false));

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
