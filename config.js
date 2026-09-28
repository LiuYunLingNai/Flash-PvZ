// 配置加载（写法参考 douyin-auto-spark）：
//   config/default_config.yaml  出厂默认值，随代码更新，勿改
//   config/config.yaml          本机覆盖，gitignore；首次启动自动从默认值复制生成
// 首次运行会把默认配置复制成 config.yaml；以后默认值里新增的项也会自动补进
// 用户的 config.yaml（保留注释、不动已改的值）。
// 最终优先级：环境变量 > config/config.yaml > config/default_config.yaml > 内置兜底。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultFile = path.join(root, 'config', 'default_config.yaml');
const configFile = path.join(root, 'config', 'config.yaml');

// 内置兜底：两个 yaml 都丢了也能起服务。
const defaults = {
  port: 8123,
  secureCookie: false,
  dbPath: 'data.db',
  sessionDays: 30,
  username: { minLength: 2, maxLength: 20 },
  password: { minLength: 6, maxLength: 200 },
  rateLimit: { maxAttempts: 50, windowMinutes: 15 },
  saveMaxKb: 1000,
};

// 深合并：value 覆盖 base，仅对纯对象递归，其余（含数组）整体覆盖，null 回退到 base。
function merge(base, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? base;
  const result = { ...base };
  for (const [key, item] of Object.entries(value)) {
    result[key] = item == null
      ? base?.[key]
      : typeof item === 'object' && !Array.isArray(item)
        ? merge(base?.[key] ?? {}, item)
        : item;
  }
  return result;
}

function readYaml(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch (e) {
    throw new Error(`配置文件解析失败：${file}`, { cause: e });
  }
}

// 保证 config/config.yaml 存在，并把默认值里新增的键（连同注释）补进去，不动用户已改的值。
function ensureConfigFile() {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  if (!fs.existsSync(configFile)) {
    if (fs.existsSync(defaultFile)) fs.copyFileSync(defaultFile, configFile);
    else fs.writeFileSync(configFile, YAML.stringify(defaults), 'utf8');
    return;
  }
  if (!fs.existsSync(defaultFile)) return;
  const before = fs.readFileSync(configFile, 'utf8');
  const userDoc = YAML.parseDocument(before);
  const defaultDoc = YAML.parseDocument(fs.readFileSync(defaultFile, 'utf8'));
  if (!YAML.isMap(userDoc.contents) || !YAML.isMap(defaultDoc.contents)) return;
  mergeYamlMaps(userDoc.contents, defaultDoc.contents);
  const after = userDoc.toString();
  if (after !== before) fs.writeFileSync(configFile, after, 'utf8');
}

// 把 defaultMap 里缺失的键补进 userMap（保留用户顺序与已有注释），递归处理嵌套对象。
function mergeYamlMaps(userMap, defaultMap) {
  const existing = new Map(userMap.items.map((item, index) => [String(item.key?.value), { item, index }]));
  for (const [defaultIndex, defaultItem] of defaultMap.items.entries()) {
    const key = String(defaultItem.key?.value);
    const found = existing.get(key);
    if (!found) { userMap.items.push(defaultItem.clone?.() ?? defaultItem); continue; }
    copyLeadingComment(userMap, found.index, defaultMap, defaultIndex);
    copyInlineComment(found.item, defaultItem);
    if (YAML.isMap(found.item.value) && YAML.isMap(defaultItem.value))
      mergeYamlMaps(found.item.value, defaultItem.value);
  }
}
const readLead = (map, i) => (i === 0 ? map.commentBefore : map.items[i]?.key?.commentBefore);
function copyLeadingComment(userMap, ui, defMap, di) {
  if (readLead(userMap, ui)) return;
  const c = readLead(defMap, di);
  if (!c) return;
  if (ui === 0) userMap.commentBefore = c;
  else if (userMap.items[ui]?.key) userMap.items[ui].key.commentBefore = c;
}
function copyInlineComment(userItem, defItem) {
  if (!userItem.key?.comment && defItem.key?.comment) userItem.key.comment = defItem.key.comment;
  const uv = userItem.value, dv = defItem.value;
  if (!uv || !dv || YAML.isMap(uv) || YAML.isSeq(uv)) return;
  if (!uv.comment && dv.comment) uv.comment = dv.comment;
}

// yaml 层的合并配置（默认 → 用户），未叠加环境变量。
export function getConfig() {
  ensureConfigFile();
  return merge(merge(defaults, readYaml(defaultFile)), readYaml(configFile));
}

// 项目实际使用的解析结果：叠加环境变量、规整类型、把 dbPath 解析成绝对路径。
function resolve(raw) {
  const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  const bool = (v, d) => (v === undefined || v === null ? d : v === true || v === 'true' || v === '1' || v === 1);
  const dbPathRaw = process.env.DB_PATH || raw.dbPath || 'data.db';
  return {
    port: num(process.env.PORT ?? raw.port, 8123),
    secureCookie: process.env.SECURE_COOKIE !== undefined
      ? process.env.SECURE_COOKIE === '1'
      : bool(raw.secureCookie, false),
    dbPath: path.isAbsolute(dbPathRaw) ? dbPathRaw : path.join(root, dbPathRaw),
    sessionDays: num(raw.sessionDays, 30),
    usernameMin: num(raw.username?.minLength, 2),
    usernameMax: num(raw.username?.maxLength, 20),
    passwordMin: num(raw.password?.minLength, 6),
    passwordMax: num(raw.password?.maxLength, 200),
    rateMaxAttempts: num(raw.rateLimit?.maxAttempts, 50),
    rateWindowMinutes: num(raw.rateLimit?.windowMinutes, 15),
    saveMaxKb: num(raw.saveMaxKb, 1000),
  };
}

export const config = resolve(getConfig());
