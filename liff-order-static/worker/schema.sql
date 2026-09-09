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

-- 後台管理員帳號（多帳號登入）
CREATE TABLE IF NOT EXISTS admin_users (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'operator',  -- 'admin' 超管 / 'operator' 一般操作者
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 後台操作日誌（誰登入、誰下載、誰打包，方便稽核）
CREATE TABLE IF NOT EXISTS admin_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL,
  action      TEXT NOT NULL,      -- login / download_file / download_zip / change_password / add_user / delete_user
  order_no    TEXT,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_username ON admin_audit(username);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at);