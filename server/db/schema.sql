-- =====================================================
-- CoHub Express DBスキーマ
-- =====================================================

-- ユーザー（グループ各社社員）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login_id TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  company_code TEXT NOT NULL DEFAULT 'STD',  -- STD/KBC/SZE
  role TEXT DEFAULT 'member',  -- member | admin
  avatar_url TEXT DEFAULT '',
  avatar_style TEXT DEFAULT '',  -- shonen | anime | pixar | watercolor
  status TEXT DEFAULT 'active',  -- active | 退席中 | 会議中
  session_token TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT
);

-- 座標（空間内の位置）
CREATE TABLE IF NOT EXISTS positions (
  user_id TEXT PRIMARY KEY,
  x INTEGER DEFAULT 400,
  y INTEGER DEFAULT 300,
  status TEXT DEFAULT 'online',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 近接チャット履歴（24h保持、本人のみ閲覧可）
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  receiver_id TEXT,  -- NULL=近接全員、値あり=特定相手
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, created_at DESC);

-- 会社マスタ
CREATE TABLE IF NOT EXISTS companies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ring_color TEXT DEFAULT '#000000'
);
INSERT OR IGNORE INTO companies (code, name, ring_color) VALUES
  ('STD', 'スタンダード運輸', '#1f2937'),
  ('KBC', '関東BC', '#2563eb'),
  ('SZE', 'スズエ電機', '#059669');
