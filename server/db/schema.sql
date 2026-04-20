-- =====================================================
-- CoHub Express DBスキーマ
-- =====================================================

-- ユーザー（グループ各社社員）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login_id TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  company_code TEXT NOT NULL DEFAULT 'SU_HQ',  -- SU_HQ/SU_SAITAMA/SU_MKANTO/SU_ZAMA/IBA_KASHIMA/IBA_SANWA/SUZUE/ADMIN
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

-- チャット履歴（60日保持、管理者は全文閲覧可）
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  receiver_id TEXT,       -- NULL=フロア全員、値あり=DM
  content TEXT NOT NULL,
  room_code TEXT DEFAULT 'public',  -- public / private_xxx / dm
  has_mention INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_code, created_at DESC);

-- 会社マスタ
CREATE TABLE IF NOT EXISTS companies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ring_color TEXT DEFAULT '#000000'
);
INSERT OR IGNORE INTO companies (code, name, ring_color) VALUES
  ('SU_HQ',       'SU本社',   '#1f2937'),
  ('SU_SAITAMA',  'SU埼玉',   '#dc2626'),
  ('SU_MKANTO',   'SU南関東', '#7c3aed'),
  ('SU_ZAMA',     'SU座間',   '#ea580c'),
  ('IBA_KASHIMA', 'IBA鹿島',  '#0891b2'),
  ('IBA_SANWA',   'IBA三和',  '#0284c7'),
  ('SUZUE',       'スズエ',   '#059669'),
  ('ADMIN',       '管理職',   '#ca8a04');
