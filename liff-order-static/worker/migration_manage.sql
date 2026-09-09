-- 遷移：orders 表新增後台管理欄位（已存在的資料庫使用）
ALTER TABLE orders ADD COLUMN manage_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN followup_at TEXT;
ALTER TABLE orders ADD COLUMN note TEXT;