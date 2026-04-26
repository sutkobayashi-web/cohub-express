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
  // 健康管理室への名称統一 (旧: 労働安全健康推進室 / 安全衛生健康管理室)
  _db.prepare("UPDATE floors SET name = '健康管理室' WHERE code = 'wellness_room'").run();
  // 社内タイムライン (掲示板) — Phase1 コミュニケーション基盤強化
  _db.exec(`CREATE TABLE IF NOT EXISTS board_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id TEXT NOT NULL,
    content TEXT,
    image_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bp_at ON board_posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_bp_author ON board_posts(author_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS board_reactions (
    post_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (post_id, user_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_br_post ON board_reactions(post_id);
  CREATE TABLE IF NOT EXISTS board_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bc_post ON board_comments(post_id, created_at);`);
  // 重要告知 (Phase2) — 経営/管理職→全社の確実配信、既読率追跡
  _db.exec(`CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'normal',
    requires_ack INTEGER NOT NULL DEFAULT 0,
    target TEXT NOT NULL DEFAULT 'all',
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_an_at ON announcements(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_an_level ON announcements(level, created_at DESC);
  CREATE TABLE IF NOT EXISTS announcement_reads (
    announcement_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    read_at TEXT DEFAULT (datetime('now')),
    acked_at TEXT,
    PRIMARY KEY (announcement_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ar_user ON announcement_reads(user_id);`);
  // 業務日常連絡 (Phase3) — 車両不具合/事故ヒヤリハット/遅延/その他をドライバーから一発報告
  _db.exec(`CREATE TABLE IF NOT EXISTS ops_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id TEXT NOT NULL,
    category TEXT NOT NULL,
    urgency TEXT NOT NULL DEFAULT '中',
    vehicle_no TEXT,
    location TEXT,
    description TEXT,
    image_url TEXT,
    status TEXT NOT NULL DEFAULT '受付',
    assignee_id TEXT,
    resolution_note TEXT,
    resolved_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ops_at ON ops_reports(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ops_status ON ops_reports(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ops_reporter ON ops_reports(reporter_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS ops_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_oc_report ON ops_comments(report_id, created_at);`);
  // 動画ライブラリ (Phase4) — 安全教育/業務マニュアル/経営メッセージ等
  _db.exec(`CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'その他',
    file_url TEXT NOT NULL,
    thumbnail_url TEXT,
    duration_sec INTEGER DEFAULT 0,
    file_size INTEGER DEFAULT 0,
    uploaded_by TEXT NOT NULL,
    is_required INTEGER DEFAULT 0,
    target TEXT NOT NULL DEFAULT 'all',
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_v_at ON videos(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_v_cat ON videos(category, created_at DESC);
  CREATE TABLE IF NOT EXISTS video_views (
    video_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    last_position_sec INTEGER DEFAULT 0,
    PRIMARY KEY (video_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_vv_user ON video_views(user_id);`);
  // CoWell アーカイブ取込 (Phase5) — health DB の主要テーブルを cw_* で保持
  _db.exec(`CREATE TABLE IF NOT EXISTS cw_users (
    cw_id TEXT PRIMARY KEY,
    nickname TEXT,
    real_name TEXT,
    department TEXT,
    avatar TEXT,
    cohub_uid TEXT,                    -- マッピング先 cohub users.id (NULL=未マップ)
    map_method TEXT,                   -- auto_realname / manual / unmapped
    cw_created_at TEXT,
    imported_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cwu_cohub ON cw_users(cohub_uid);
  CREATE TABLE IF NOT EXISTS cw_posts (
    cw_post_id TEXT PRIMARY KEY,
    cw_user_id TEXT NOT NULL,
    content TEXT,
    analysis TEXT,
    nickname TEXT,
    image_url TEXT,
    category TEXT,
    nutrition_scores TEXT,
    status TEXT,
    cw_created_at TEXT,
    imported_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cwp_user ON cw_posts(cw_user_id, cw_created_at DESC);
  CREATE TABLE IF NOT EXISTS cw_buddy_messages (
    cw_id INTEGER PRIMARY KEY,
    cw_user_id TEXT NOT NULL,
    role TEXT,
    content TEXT,
    cw_created_at TEXT,
    imported_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cwbm_user ON cw_buddy_messages(cw_user_id, cw_created_at);
  CREATE TABLE IF NOT EXISTS cw_step_log (
    cw_user_id TEXT NOT NULL,
    step_date TEXT NOT NULL,
    steps INTEGER DEFAULT 0,
    PRIMARY KEY (cw_user_id, step_date)
  );
  CREATE TABLE IF NOT EXISTS cw_food_weekly_reports (
    cw_report_id TEXT PRIMARY KEY,
    cw_user_id TEXT NOT NULL,
    nickname TEXT,
    week_start TEXT,
    week_end TEXT,
    meal_count INTEGER,
    report_text TEXT,
    admin_comment TEXT,
    nutrition_scores TEXT,
    cw_created_at TEXT,
    imported_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cwfwr_user ON cw_food_weekly_reports(cw_user_id, cw_created_at DESC);
  CREATE TABLE IF NOT EXISTS cw_blood_pressure (
    cw_id INTEGER PRIMARY KEY,
    cw_user_id TEXT NOT NULL,
    systolic INTEGER,
    diastolic INTEGER,
    pulse INTEGER,
    measured_at TEXT,
    cw_created_at TEXT,
    imported_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS cw_import_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT,
    rows_inserted INTEGER,
    rows_updated INTEGER,
    notes TEXT,
    ran_at TEXT DEFAULT (datetime('now'))
  );`);
  // ひろば (Phase6) — CoWell の posts 機能を CoHub にネイティブ実装
  // 食事/相談/雑談を投稿、食事は AI 栄養スコア自動付与
  _db.exec(`CREATE TABLE IF NOT EXISTS plaza_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '雑談',
    content TEXT,
    image_url TEXT,
    nutrition_scores TEXT,
    ai_comment TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pp_at ON plaza_posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pp_cat ON plaza_posts(category, created_at DESC);
  CREATE TABLE IF NOT EXISTS plaza_reactions (
    post_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (post_id, user_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_pr_post ON plaza_reactions(post_id);
  CREATE TABLE IF NOT EXISTS plaza_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pc_post ON plaza_comments(post_id, created_at);`);
  // イベント (Phase7) — 健康チャレンジ/水族館等の「開催中」リスト
  _db.exec(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    icon TEXT DEFAULT '🎉',
    url TEXT,
    is_external INTEGER DEFAULT 0,
    start_date TEXT,
    end_date TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );`);
  // 既定イベント: 🐠 水族館 (CoWell)
  const eventExists = _db.prepare("SELECT 1 FROM events WHERE title = ?").get('🐠 水族館の冒険');
  if (!eventExists) {
    _db.prepare(`INSERT INTO events (title, description, icon, url, is_external, sort_order)
      VALUES (?, ?, ?, ?, 1, 100)`).run(
      '🐠 水族館の冒険',
      '歩数で海を旅して魚を発見する CoWell の冒険RPGです。今までの冒険記録もそのまま続けられます。',
      '🐠',
      'https://health.biz-terrace.org/'
    );
  }
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
