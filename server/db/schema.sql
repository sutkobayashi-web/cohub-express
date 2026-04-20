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

-- 座標（空間内の位置、フロア別）
CREATE TABLE IF NOT EXISTS positions (
  user_id TEXT PRIMARY KEY,
  x INTEGER DEFAULT 672,
  y INTEGER DEFAULT 384,
  status TEXT DEFAULT 'online',
  status_text TEXT DEFAULT '',
  floor_code TEXT DEFAULT 'lobby',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 出席履歴 (ログイン/ログアウト/フロア移動)
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  floor_code TEXT,
  event_type TEXT NOT NULL,  -- login / logout / enter / leave
  at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attend_user ON attendance(user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_attend_at ON attendance(at DESC);

-- フロアマスタ（1F ロビー / 2F 事務フロア など）
CREATE TABLE IF NOT EXISTS floors (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bg_image TEXT NOT NULL,
  world_w INTEGER NOT NULL DEFAULT 1344,
  world_h INTEGER NOT NULL DEFAULT 768,
  entry_x INTEGER,  -- 入口座標 (NULL時はワールド中央下部)
  entry_y INTEGER,
  sort_order INTEGER DEFAULT 0,
  icon TEXT DEFAULT '',
  locked INTEGER DEFAULT 0,
  lock_pw_hash TEXT,
  locked_by TEXT,
  locked_at TEXT,
  approval_mode INTEGER DEFAULT 0  -- 1=入室に承認が必要
);
INSERT OR IGNORE INTO floors (code, name, bg_image, world_w, world_h, sort_order, icon) VALUES
  ('lobby',     '1F 玄関ロビー',     '/assets/floor_lobby.png',     1344, 768, 1, '🚪'),
  ('office',    '2F 事務フロア',     '/assets/floor_office.png',    1344, 768, 2, '💼'),
  ('meeting_a', '3F 役員会議室',      '/assets/floor_meeting_a.png', 1344, 768, 3, '👔'),
  ('meeting_b', '3F 会議室B',        '/assets/floor_meeting_b.png', 1344, 768, 4, '🅱'),
  ('meeting_c', '3F 大会議室',       '/assets/floor_meeting_c.png', 1344, 768, 5, '🏛');

-- PWA プッシュ通知 購読情報
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- ホワイトボード (会議室毎に共有テキスト+描画。会議室コード = primary key)
CREATE TABLE IF NOT EXISTS whiteboards (
  room_code TEXT PRIMARY KEY,
  content TEXT DEFAULT '',
  drawing_json TEXT DEFAULT '[]',
  updated_by TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 会議録音 (管理者のみ閲覧)
CREATE TABLE IF NOT EXISTS recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  size INTEGER,
  duration_ms INTEGER,
  floor_code TEXT,
  recorded_by TEXT,
  note TEXT,
  transcript TEXT,
  transcript_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- チャット履歴（60日保持、管理者は全文閲覧可）
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  receiver_id TEXT,       -- NULL=フロア全員、値あり=DM
  content TEXT NOT NULL,
  room_code TEXT DEFAULT 'public',  -- public / private_xxx / dm
  has_mention INTEGER DEFAULT 0,
  attach_url TEXT,
  attach_name TEXT,
  attach_size INTEGER,
  attach_type TEXT,
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
