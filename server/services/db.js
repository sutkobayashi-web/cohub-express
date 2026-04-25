const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let _db = null;

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function getDb() {
  if (_db) return _db;
  const dbDir = path.join(__dirname, '..', 'db');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cohub.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  const schema = fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8');
  _db.exec(schema);
  // 既存DB向けマイグレーション (idempotent)
  ensureColumn(_db, 'users', 'google_cal_id', 'google_cal_id TEXT');
  ensureColumn(_db, 'users', 'last_cal_dm_date', 'last_cal_dm_date TEXT');
  ensureColumn(_db, 'users', 'dm_group', 'dm_group TEXT');
  ensureColumn(_db, 'users', 'dm_rank', 'dm_rank INTEGER DEFAULT 0');
  ensureColumn(_db, 'users', 'last_wellness_dm_date', 'last_wellness_dm_date TEXT');
  // 推進メンバー(運管型) フラグ — 健康管理室 現場の声POST権限
  ensureColumn(_db, 'users', 'is_field_promoter', 'is_field_promoter INTEGER DEFAULT 0');
  // 現場の声POST 構造化テーブル
  _db.exec(`CREATE TABLE IF NOT EXISTS wellness_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poster_id TEXT NOT NULL,
    company_code TEXT,
    category TEXT NOT NULL,
    urgency TEXT NOT NULL,
    identity_mode TEXT NOT NULL,
    memo TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wp_at ON wellness_posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wp_cat ON wellness_posts(category, created_at DESC);`);
  // 健康管理室 月次施策ボード
  _db.exec(`CREATE TABLE IF NOT EXISTS wellness_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT,
    source_post_ids TEXT,
    source_summary TEXT,
    status TEXT NOT NULL DEFAULT '候補',
    owner_id TEXT,
    budget_jpy INTEGER DEFAULT 0,
    target_date TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    approved_by TEXT,
    approved_at TEXT,
    completed_at TEXT,
    announce_message TEXT,
    is_ai_suggested INTEGER DEFAULT 0,
    rejection_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wa_status ON wellness_actions(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wa_at ON wellness_actions(created_at DESC);`);
  // 労働安全健康推進室への名称統一 (旧: 安全衛生健康管理室)
  _db.prepare("UPDATE floors SET name = '労働安全健康推進室' WHERE code = 'wellness_room'").run();
  // login_id 統一: eitaro → e_sugai (須貝栄二)
  try { _db.prepare("UPDATE users SET login_id = 'e_sugai' WHERE login_id = 'eitaro'").run(); } catch (e) {}
  // 推進メンバー初期付与 (運管型) — taketake はテスト確認用
  _db.prepare("UPDATE users SET is_field_promoter = 1 WHERE login_id IN ('y_yoshizawa','a_yamada','e_sugai','taketake')").run();
  // 現場の声 専用グループチャット作成 (idempotent)
  const PROMOTER_GROUP_ID = 'g_field_voice';
  const grpExists = _db.prepare('SELECT 1 FROM chat_groups WHERE id = ?').get(PROMOTER_GROUP_ID);
  if (!grpExists) {
    _db.prepare("INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)")
      .run(PROMOTER_GROUP_ID, '🩺 現場の声 (運管POST)', '🩺', null);
  }
  // 健康管理室ディスカッションGC (Bライン: 事務側からの直接議論)
  const WELLNESS_DISC_ID = 'g_wellness_disc';
  const discExists = _db.prepare('SELECT 1 FROM chat_groups WHERE id = ?').get(WELLNESS_DISC_ID);
  if (!discExists) {
    _db.prepare("INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)")
      .run(WELLNESS_DISC_ID, '🏥 健康管理室ディスカッション', '🏥', null);
  }
  // メンバー: 推進メンバー + 全管理者を自動加入 (両グループ共通、既加入はスキップ)
  const promoterRows = _db.prepare("SELECT id FROM users WHERE is_field_promoter = 1 OR role = 'admin'").all();
  const memInsert = _db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)');
  for (const r of promoterRows) {
    memInsert.run(PROMOTER_GROUP_ID, r.id);
    memInsert.run(WELLNESS_DISC_ID, r.id);
  }
  // 事務所棟フロアの登場位置を正面玄関(下中央)に揃える
  _db.prepare(`UPDATE floors SET entry_x=672, entry_y=678
               WHERE code IN ('lobby','office','meeting_a','meeting_b','meeting_c')
                 AND (entry_x <> 672 OR entry_y <> 678)`).run();
  return _db;
}

module.exports = { getDb };
