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
  // 生年月日 (健診Box連携・年齢別分析用、本人と管理者のみ閲覧)
  ensureColumn(_db, 'users', 'birth_date', 'birth_date TEXT');
  // ニックネーム (本人が初回ログイン時に設定。匿名投稿時の表示名として使用)
  ensureColumn(_db, 'users', 'nickname', 'nickname TEXT');
  // 利用規約・プライバシーポリシー同意 (バージョン文字列で管理 / 改定時に再同意要求)
  ensureColumn(_db, 'users', 'consent_version', 'consent_version TEXT');
  ensureColumn(_db, 'users', 'consent_accepted_at', 'consent_accepted_at TEXT');
  // 同意履歴 (監査・法的証跡用) — IP/UA を記録、削除しない
  _db.exec(`CREATE TABLE IF NOT EXISTS consent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    consent_version TEXT NOT NULL,
    accepted_log INTEGER NOT NULL DEFAULT 0,
    accepted_privacy INTEGER NOT NULL DEFAULT 0,
    accepted_policy INTEGER NOT NULL DEFAULT 0,
    ip_address TEXT,
    user_agent TEXT,
    accepted_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cl_user ON consent_logs(user_id, accepted_at DESC);`);
  // ゲスト (大学・NPO等の外部レビュアー) フラグ — 施策ボードレビュー権限
  ensureColumn(_db, 'users', 'is_guest_reviewer', 'is_guest_reviewer INTEGER DEFAULT 0');
  ensureColumn(_db, 'users', 'guest_org', 'guest_org TEXT');
  // 大学・NPO法人 会社コード追加 (ゲスト用所属)
  _db.prepare("INSERT OR IGNORE INTO companies (code, name, ring_color) VALUES ('UNIVERSITY', '大学・研究機関', '#7c3aed')").run();
  _db.prepare("INSERT OR IGNORE INTO companies (code, name, ring_color) VALUES ('NPO', 'NPO法人', '#0891b2')").run();
  _db.prepare("INSERT OR IGNORE INTO companies (code, name, ring_color) VALUES ('GUEST', 'ゲスト', '#94a3b8')").run();
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
  // 投稿元区分 (運管/倉庫/総務/その他) - B案で追加
  ensureColumn(_db, 'wellness_posts', 'source_type', "source_type TEXT DEFAULT '運管'");
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
  // 配車センター追加 (2026-04-27): 現場棟内、未実装ページ
  _db.prepare(`INSERT OR IGNORE INTO floors (code, name, bg_image, world_w, world_h, entry_x, entry_y, sort_order, icon, building)
    VALUES ('field_dispatch', '配車センター', '/assets/floor_field_rest.png', 1344, 768, 672, 678, 11, '🗺', 'field')`).run();
  // 健康管理室フロア (2026-04-28再設置): AIヘルスアドバイザー (bot_health) 常駐
  _db.prepare(`INSERT OR IGNORE INTO floors (code, name, bg_image, world_w, world_h, entry_x, entry_y, sort_order, icon, building)
    VALUES ('wellness_room', '🏥 健康管理室', '/assets/floor_wellness_room.png', 1344, 768, 672, 700, 6, '🏥', 'office')`).run();
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
    is_anonymous INTEGER DEFAULT 0,
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
  // 既存DBに is_anonymous 追加 (idempotent migration)
  ensureColumn(_db, 'plaza_posts', 'is_anonymous', 'is_anonymous INTEGER DEFAULT 0');
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
  // 個人健康記録 (Phase9) — 血圧 / 健康メモ / 健診結果ファイル
  _db.exec(`CREATE TABLE IF NOT EXISTS bp_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    systolic INTEGER NOT NULL,
    diastolic INTEGER NOT NULL,
    pulse INTEGER,
    measured_at TEXT,
    memo TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bp_user ON bp_records(user_id, measured_at DESC);
  CREATE TABLE IF NOT EXISTS health_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    note TEXT NOT NULL,
    tag TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_hn_user ON health_notes(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS health_checkups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    year INTEGER,
    file_url TEXT NOT NULL,
    file_name TEXT,
    file_size INTEGER,
    uploaded_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_hc_user ON health_checkups(user_id, year DESC);`);
  // 凝集型テーマ投票 (Phase10) — CoWell v2 から移植
  // 1サイクル = テーマ起票 → 全社投票 → 専門家コメント → 施策化
  _db.exec(`CREATE TABLE IF NOT EXISTS wellness_themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_no INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    description TEXT,
    source_summary TEXT,
    status TEXT NOT NULL DEFAULT '投票中',
    created_by TEXT,
    advisor_comment TEXT,
    advisor_id TEXT,
    advisor_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wt_cycle ON wellness_themes(cycle_no, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_wt_status ON wellness_themes(status, created_at DESC);
  CREATE TABLE IF NOT EXISTS wellness_theme_votes (
    theme_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    vote INTEGER NOT NULL,                -- -1, 0, 1, 2 (反対/中立/賛成/強く賛成)
    comment TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (theme_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_wtv_theme ON wellness_theme_votes(theme_id);`);
  // チャレンジ + KPI (Phase11) — CoWell移植
  _db.exec(`CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    theme_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    icon TEXT DEFAULT '💪',
    period_start TEXT,
    period_end TEXT,
    kpi_items TEXT DEFAULT '[]',  -- JSON: [{key,label,unit,target,type:'number|bool|choice'}]
    status TEXT NOT NULL DEFAULT 'draft',
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ch_status ON challenges(status, period_end DESC);
  CREATE TABLE IF NOT EXISTS challenge_participants (
    challenge_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (challenge_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS kpi_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challenge_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    record_date TEXT NOT NULL,
    kpi_values TEXT DEFAULT '{}',  -- JSON: {kpi_key: value}
    comment TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(challenge_id, user_id, record_date)
  );
  CREATE INDEX IF NOT EXISTS idx_kpi_challenge ON kpi_records(challenge_id, record_date DESC);
  CREATE INDEX IF NOT EXISTS idx_kpi_user ON kpi_records(user_id, record_date DESC);`);
  // 推進メンバー議論機能 (CoWell移植) — 現場の声/施策へのコメント+共感+AI評議会
  _db.exec(`CREATE TABLE IF NOT EXISTS wellness_post_reactions (
    post_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (post_id, user_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_wpr_post ON wellness_post_reactions(post_id);
  CREATE TABLE IF NOT EXISTS wellness_post_discussions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wpd_post ON wellness_post_discussions(post_id, created_at);
  CREATE TABLE IF NOT EXISTS wellness_action_council (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id INTEGER NOT NULL,
    role TEXT NOT NULL,                -- AIメディカル/AIヘルス/AI食事/AI経営/AI現場
    avatar TEXT,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wac_action ON wellness_action_council(action_id, created_at);
  CREATE TABLE IF NOT EXISTS wellness_action_discussions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id INTEGER NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wad_action ON wellness_action_discussions(action_id, created_at);`);
  // ===== v2 パイプライン拡張 (2026-04-27) =====
  // wellness_actions: 候補→評議→推進確定→保健師中→役員→投票→保健師末→実行→完了
  ensureColumn(_db, 'wellness_actions', 'final_draft', 'final_draft TEXT');
  ensureColumn(_db, 'wellness_actions', 'final_draft_at', 'final_draft_at TEXT');
  ensureColumn(_db, 'wellness_actions', 'finalized_by', 'finalized_by TEXT');
  ensureColumn(_db, 'wellness_actions', 'finalized_at', 'finalized_at TEXT');
  ensureColumn(_db, 'wellness_actions', 'nurse_mid_comment', 'nurse_mid_comment TEXT');
  ensureColumn(_db, 'wellness_actions', 'nurse_mid_by', 'nurse_mid_by TEXT');
  ensureColumn(_db, 'wellness_actions', 'nurse_mid_at', 'nurse_mid_at TEXT');
  ensureColumn(_db, 'wellness_actions', 'nurse_final_comment', 'nurse_final_comment TEXT');
  ensureColumn(_db, 'wellness_actions', 'nurse_final_by', 'nurse_final_by TEXT');
  ensureColumn(_db, 'wellness_actions', 'nurse_final_at', 'nurse_final_at TEXT');
  ensureColumn(_db, 'wellness_actions', 'executive_approver_id', 'executive_approver_id TEXT');
  ensureColumn(_db, 'wellness_actions', 'executive_approved_at', 'executive_approved_at TEXT');
  ensureColumn(_db, 'wellness_actions', 'vote_started_at', 'vote_started_at TEXT');
  ensureColumn(_db, 'wellness_actions', 'vote_closed_at', 'vote_closed_at TEXT');
  ensureColumn(_db, 'wellness_actions', 'vote_result_json', 'vote_result_json TEXT');
  // 7軸priority評価 (legal/risk/freq/urgency/safety/value/needs 各1-5点)
  ensureColumn(_db, 'wellness_actions', 'priority_axes', 'priority_axes TEXT');
  // AI凝縮 永続化 + 候補ごとの議論
  _db.exec(`CREATE TABLE IF NOT EXISTS wellness_insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generated_by TEXT,
    generated_at TEXT DEFAULT (datetime('now')),
    days_window INTEGER,
    summary TEXT,
    candidates_json TEXT,
    counts_json TEXT,
    status TEXT DEFAULT 'active'
  );
  CREATE INDEX IF NOT EXISTS idx_wi_at ON wellness_insights(generated_at DESC);
  CREATE TABLE IF NOT EXISTS wellness_insight_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    insight_id INTEGER NOT NULL,
    candidate_idx INTEGER NOT NULL DEFAULT -1,
    author_id TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT,
    registered_action_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wit_insight ON wellness_insight_threads(insight_id, candidate_idx);`);
  // 社員投票 (1〜5点)
  _db.exec(`CREATE TABLE IF NOT EXISTS wellness_action_votes (
    action_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
    comment TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (action_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_wav_action ON wellness_action_votes(action_id);`);
  // 一般投稿/食事投稿への推進メンバーコメント (3つの柱の右側コメント、AI凝縮の補強材料)
  _db.exec(`CREATE TABLE IF NOT EXISTS plaza_post_promoter_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ppc_post ON plaza_post_promoter_comments(post_id, created_at);`);
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

  // ============================================================
  // CoLink 吸収 (2026-04-28): 関東BC 倉庫向け機能を CoHub に統合
  // 製品事故報告書・日報・クレーム・BC報告・施策一覧を保持。FK なし(reporter は TEXT)
  // ============================================================
  // 製品事故報告書 (CoLink accident_reports と互換)
  _db.exec(`CREATE TABLE IF NOT EXISTS kbc_accident_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    accident_date TEXT NOT NULL,
    accident_time TEXT,
    weather TEXT,
    timing TEXT,
    location_floor TEXT,
    location_area TEXT,
    reporter_name TEXT NOT NULL,
    accident_type TEXT DEFAULT '製品破損',
    product_code TEXT,
    product_name TEXT,
    product_category TEXT,
    quantity INTEGER DEFAULT 1,
    cause_category TEXT,
    cause_detail TEXT,
    situation_template TEXT,
    situation_detail TEXT,
    damage_description TEXT,
    media_paths TEXT DEFAULT '[]',
    label_photo_path TEXT,
    reporter_reflection TEXT,
    similar_accident_known TEXT DEFAULT '有',
    handling TEXT DEFAULT '関東BCへ連絡済み・指示待ち',
    handling_instruction TEXT,
    cost_amount INTEGER,
    cost_status TEXT DEFAULT '未定',
    status TEXT DEFAULT 'draft',
    manager_comment TEXT,
    approved_by TEXT,
    approved_at TEXT,
    rejected_reason TEXT,
    pdf_path TEXT,
    reported_to TEXT,
    reported_where TEXT,
    police_contact TEXT DEFAULT '無し',
    legacy_colink_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_kar_date ON kbc_accident_reports(accident_date DESC);
  CREATE INDEX IF NOT EXISTS idx_kar_reporter ON kbc_accident_reports(reporter_name);

  CREATE TABLE IF NOT EXISTS kbc_accident_cause_master (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    template TEXT NOT NULL,
    keywords TEXT,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS kbc_accident_product_master (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_category TEXT NOT NULL,
    product_name TEXT,
    sort_order INTEGER DEFAULT 0
  );

  -- 日報 (1464件のXLSインポート履歴あり)
  CREATE TABLE IF NOT EXISTS kbc_daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT NOT NULL,
    report_date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    break_minutes INTEGER DEFAULT 60,
    staff INTEGER DEFAULT 0,
    temp_workers INTEGER DEFAULT 0,
    part_workers INTEGER DEFAULT 0,
    workers REAL DEFAULT 0,
    shipping_total INTEGER DEFAULT 0,
    memo TEXT DEFAULT '',
    phase1_at TEXT,
    floor_1f_in INTEGER, floor_1f_out INTEGER,
    floor_2f_in INTEGER, floor_2f_out INTEGER,
    floor_3f_in INTEGER, floor_3f_out INTEGER,
    floor_4f_in INTEGER, floor_4f_out INTEGER,
    floor_5f_in INTEGER, floor_5f_out INTEGER,
    inbound_total INTEGER DEFAULT 0,
    outbound_total INTEGER DEFAULT 0,
    phase2_at TEXT,
    legacy_colink_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(user_name, report_date)
  );
  CREATE INDEX IF NOT EXISTS idx_kdr_date ON kbc_daily_reports(report_date DESC);

  -- クレーム
  CREATE TABLE IF NOT EXISTS kbc_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_month TEXT NOT NULL,
    product_category TEXT NOT NULL,
    product_name TEXT,
    quantity INTEGER DEFAULT 1,
    amount INTEGER DEFAULT 0,
    area TEXT,
    cause TEXT,
    reporter TEXT,
    memo TEXT,
    legacy_colink_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_kclm_month ON kbc_claims(claim_month DESC);

  -- BC報告 (荷主向け)
  CREATE TABLE IF NOT EXISTS kbc_bc_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_report_id INTEGER,
    report_type TEXT DEFAULT '破損',
    occurrence_time TEXT,
    location TEXT,
    product_code TEXT,
    product_name TEXT,
    quantity INTEGER DEFAULT 1,
    damaged_item TEXT,
    cause TEXT,
    damage_detail TEXT,
    action_taken TEXT,
    prevention TEXT,
    inspection_code TEXT,
    inspection_name TEXT,
    inspection_qty INTEGER DEFAULT 1,
    inspection_detail TEXT,
    inspection_result TEXT,
    reporter TEXT,
    photo_path TEXT,
    status TEXT DEFAULT 'new',
    client_comment TEXT DEFAULT '',
    confirmed_at TEXT,
    confirmed_by TEXT,
    media_paths TEXT DEFAULT '[]',
    legacy_colink_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_kbr_status ON kbc_bc_reports(status, created_at DESC);

  -- アクションプラン (改善施策一覧)
  CREATE TABLE IF NOT EXISTS kbc_action_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    priority TEXT,
    category TEXT,
    issue TEXT,
    action TEXT,
    person TEXT,
    deadline TEXT,
    status TEXT DEFAULT '未着手',
    legacy_colink_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_kap_status ON kbc_action_plans(status);

  -- 車両事故報告書 (新規・運送ドライバー向け、製品事故とは独立)
  CREATE TABLE IF NOT EXISTS vehicle_accident_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    accident_date TEXT NOT NULL,
    accident_time TEXT,
    weather TEXT,
    location TEXT,
    reporter_id TEXT NOT NULL,
    reporter_name TEXT,
    vehicle_no TEXT,
    accident_type TEXT,        -- 単独/追突/出会い頭/施設接触/物損のみ等
    counter_party TEXT,         -- 相手車両/相手側情報
    injury_status TEXT DEFAULT '無し',  -- 無し/軽傷/重傷/死亡
    police_contact TEXT DEFAULT '無し',
    insurance_status TEXT,
    cause_summary TEXT,
    description TEXT,
    media_paths TEXT DEFAULT '[]',
    repair_status TEXT,
    cost_amount INTEGER,
    status TEXT DEFAULT 'draft',
    manager_comment TEXT,
    approved_by TEXT,
    approved_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_var_date ON vehicle_accident_reports(accident_date DESC);
  CREATE INDEX IF NOT EXISTS idx_var_reporter ON vehicle_accident_reports(reporter_id);`);

  // 健康管理室 個人アクションプラン (社員ごとの相談履歴+AI生成プラン)
  _db.exec(`CREATE TABLE IF NOT EXISTS myplan_consultations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    selections_json TEXT NOT NULL,         -- [{layer, key, label}, ...]
    free_text TEXT,
    checkup_attached INTEGER DEFAULT 0,    -- 本人が健診データを引っ張ったか (将来用)
    movement_priority INTEGER DEFAULT 0,   -- 運動意欲 検出フラグ (AI重み付け用)
    plan_now TEXT,                         -- 📍 今のあなた
    plan_today TEXT,                       -- ✅ 今日からできる1つ
    plan_week TEXT,                        -- 🎯 1週間チャレンジ
    plan_month TEXT,                       -- 📅 1ヶ月の目標
    plan_kpi TEXT,                         -- 📊 数値で見える化 (JSON文字列)
    today_done_at TEXT,                    -- 今日のアクション完了日時
    shared_with_promoter INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_myplan_user ON myplan_consultations(user_id, created_at DESC);`);

  // AIチャット 不適切質問ログ (内部統制 / 監査用)
  // L1キーワード検知 / L3 Gemini SAFETY block で記録、推進メンバー/管理者へ即時通報
  _db.exec(`CREATE TABLE IF NOT EXISTS inappropriate_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,                  -- bot_aoi / bot_health
    content TEXT NOT NULL,                  -- 検知された入力本文 (フル保存、改ざん防止)
    detection_layer TEXT NOT NULL,         -- 'L1_keyword' / 'L3_gemini_safety'
    category TEXT,                         -- sexual / harassment / discrimination 等
    matched_pattern TEXT,                   -- 一致したキーワード or finishReason
    severity TEXT DEFAULT 'medium',        -- low / medium / high
    reviewed_at TEXT,
    reviewed_by TEXT,
    review_note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ial_user ON inappropriate_logs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ial_unreviewed ON inappropriate_logs(reviewed_at, severity);`);

  // ニックネーム公開フラグ (段3 先駆者制)
  ensureColumn(_db, 'myplan_consultations', 'share_publicly', 'share_publicly INTEGER DEFAULT 0');
  ensureColumn(_db, 'myplan_consultations', 'share_opted_at', 'share_opted_at TEXT');
  ensureColumn(_db, 'myplan_consultations', 'category_top', 'category_top TEXT');  // 'move' / 'meal' / etc 集計用
  ensureColumn(_db, 'users', 'pioneer_count', 'pioneer_count INTEGER DEFAULT 0');  // 公開プラン累積数 = 先駆者バッジ
  // 公開フィードクエリ用インデックス
  _db.exec(`CREATE INDEX IF NOT EXISTS idx_myplan_share ON myplan_consultations(share_publicly, created_at DESC);`);

  return _db;
}

module.exports = { getDb };
