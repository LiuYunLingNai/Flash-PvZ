// SQLite 存储层。用 Node 24 内置的 node:sqlite，无需任何原生编译。
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

// 数据库文件路径由 config.yaml 的 dbPath 决定（默认项目根目录 data.db），
// 放在 public/ 之外 —— 绝不会被静态服务暴露出去。
export const db = new DatabaseSync(config.dbPath);

export function initDb() {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      pw_hash    TEXT NOT NULL,          -- scrypt: saltHex:hashHex
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saves (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data       TEXT NOT NULL,          -- JSON: { localStorageKey: base64value }
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
}
