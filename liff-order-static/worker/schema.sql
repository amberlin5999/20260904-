-- 數倍DTF · 訂單後端（Cloudflare D1）資料庫結構
-- 用法：npx wrangler d1 execute <database-name> --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS orders (
  order_no   TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'received',
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no    TEXT NOT NULL REFERENCES orders(order_no) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  qty         INTEGER NOT NULL DEFAULT 1,
  object_key  TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_files_order_no ON order_files(order_no);