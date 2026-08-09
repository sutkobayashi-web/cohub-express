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
  // 推進メンバー(倉庫型) フラグ — 朝礼・昼礼カードPOST権限 (2026-05-08)
  ensureColumn(_db, 'users', 'is_warehouse_promoter', 'is_warehouse_promoter INTEGER DEFAULT 0');
  // 運行管理者 フラグ — 自拠点ドライバーの聞き取り点検担当(点呼で代行)。自拠点全員に代行可 (2026-06-02)
  ensureColumn(_db, 'users', 'is_ops_manager', 'is_ops_manager INTEGER DEFAULT 0');
  // 所長/副所長 フラグ — 自拠点全員(倉庫/ドライバー/事務)の聞き取り点検担当 (2026-06-02)
  ensureColumn(_db, 'users', 'is_branch_head', 'is_branch_head INTEGER DEFAULT 0');
  // 職種 (driver/warehouse/office/construction/manufacturing) — enroll登録時の細分化 (2026-05-08)
  // employee_type(office/field/admin) は権限軸として温存し、職種は別軸で管理
  ensureColumn(_db, 'users', 'job_role', 'job_role TEXT');
  ensureColumn(_db, 'users', 'lang', 'lang TEXT');  // 表示言語(ja/en/pt) 2026-07-09
  // からだの情報 — 食事栄養診断の個別化(性別・身長・活動レベル)。体重は user_activity_prefs.weight_kg を再利用 (2026-07-17)
  ensureColumn(_db, 'users', 'sex', 'sex TEXT');
  ensureColumn(_db, 'users', 'height_cm', 'height_cm REAL');
  ensureColumn(_db, 'users', 'activity_pal', 'activity_pal REAL');
  // タブレットキオスク用4桁PIN (bcryptハッシュ)。NULL=未設定。事務所設置タブレットからログイン (2026-05-12)
  ensureColumn(_db, 'users', 'tablet_pin_hash', 'tablet_pin_hash TEXT');
  // 4桁PIN総当たり対策のロック状態をDB永続化 (旧: プロセス内メモリで再起動消失。2026-06-24)
  ensureColumn(_db, 'users', 'tablet_pin_fail_count', 'tablet_pin_fail_count INTEGER DEFAULT 0');
  ensureColumn(_db, 'users', 'tablet_pin_lock_until', 'tablet_pin_lock_until INTEGER');
  // ヘルスリテラシー調査 (2026-05-09): 西村さん依頼。CCHL 5項目4段階尺度
  // q1〜q5 は 1=全くできない / 2=あまりできない / 3=どちらともいえない / 4=とてもそう思う
  _db.exec(`CREATE TABLE IF NOT EXISTS health_literacy (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    q1 INTEGER, q2 INTEGER, q3 INTEGER, q4 INTEGER, q5 INTEGER,
    total INTEGER,
    avg_score REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_hl_user_at ON health_literacy(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_hl_at ON health_literacy(created_at DESC);`);
  // PCがなくログインできない社員向け: 推進メンバーが聞き取り代理入力した場合の起票者ID
  // NULL = 本人による自己回答、値あり = 聞き取り入力 (代理入力者のID)
  ensureColumn(_db, 'health_literacy', 'proxy_poster_id', 'proxy_poster_id TEXT');

  // ============================================================
  // タカラスタンダード一括請負プロトタイプ (2026-05-09 月曜提案用)
  // 接頭辞 td_ で既存テーブルと完全分離
  // ============================================================
  // WMS取込履歴
  _db.exec(`CREATE TABLE IF NOT EXISTS td_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    filename TEXT,
    load_date TEXT,
    row_count INTEGER DEFAULT 0,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );`);
  // WMS品目単位データ
  _db.exec(`CREATE TABLE IF NOT EXISTS td_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER,
    load_date TEXT,
    warehouse_cd TEXT,
    shape_cd TEXT,
    original_vehicle_no TEXT,
    handai_no TEXT,
    site_name TEXT,
    item_cd TEXT,
    item_name TEXT,
    qty REAL,
    sai REAL,
    source_route TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_td_orders_date ON td_orders(load_date);
  CREATE INDEX IF NOT EXISTS idx_td_orders_site ON td_orders(load_date, site_name);
  CREATE INDEX IF NOT EXISTS idx_td_orders_veh ON td_orders(load_date, original_vehicle_no);`);
  // 教師データ用: 過去の配車結果(人が組んだもの)
  _db.exec(`CREATE TABLE IF NOT EXISTS td_dispatch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER,
    load_date TEXT,
    original_vehicle_no TEXT,
    sequence INTEGER,
    site_name TEXT,
    address TEXT,
    time_spec TEXT,
    eta TEXT,
    qty REAL,
    sai REAL,
    vehicle_type TEXT,
    transfer_base TEXT,
    company TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_td_disp_hist_date ON td_dispatch_history(load_date);
  CREATE INDEX IF NOT EXISTS idx_td_disp_hist_site ON td_dispatch_history(site_name);`);
  // AIまたは手動で生成した配車プラン (ストップ単位)
  _db.exec(`CREATE TABLE IF NOT EXISTS td_dispatches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    load_date TEXT NOT NULL,
    vehicle_no TEXT NOT NULL,
    sequence INTEGER,
    site_name TEXT,
    address TEXT,
    eta TEXT,
    time_spec TEXT,
    qty REAL,
    sai REAL,
    notes TEXT,
    ai_reason TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_td_disp_date_veh ON td_dispatches(load_date, vehicle_no);
  CREATE INDEX IF NOT EXISTS idx_td_disp_status ON td_dispatches(status, load_date);`);
  // 号車メタ (ドライバー、トークン、進捗ステータス)
  _db.exec(`CREATE TABLE IF NOT EXISTS td_dispatch_meta (
    load_date TEXT,
    vehicle_no TEXT,
    vehicle_type TEXT,
    driver_name TEXT,
    driver_phone TEXT,
    driver_token TEXT,
    status TEXT DEFAULT 'draft',
    confirmed_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    PRIMARY KEY (load_date, vehicle_no)
  );
  CREATE INDEX IF NOT EXISTS idx_td_meta_token ON td_dispatch_meta(driver_token);`);
  // 配車生成ジョブ (AI実行履歴)
  _db.exec(`CREATE TABLE IF NOT EXISTS td_dispatch_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    load_date TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT,
    status TEXT DEFAULT 'running',
    request_summary TEXT,
    response_raw TEXT,
    error_msg TEXT,
    created_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_td_jobs_date ON td_dispatch_jobs(load_date, started_at DESC);`);
  // 車種マスタ (タカラ配車用) - 容量・帰庫制約・最大ストップ数
  _db.exec(`CREATE TABLE IF NOT EXISTS td_vehicle_types (
    vehicle_type TEXT PRIMARY KEY,
    capacity_sai INTEGER NOT NULL DEFAULT 100,
    return_by_min INTEGER NOT NULL DEFAULT 840,
    max_stops INTEGER NOT NULL DEFAULT 6,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 100,
    notes TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  );`);
  // 初期シード (実データに存在する8車種、3t/4tは存在しないので含めない)
  try {
    const seedTypes = [
      ['軽ﾊﾞﾝ',          30, 840,  8, 10, '常用優先・時間指定なし向け'],
      ['ハイエース',     50, 840,  8, 20, '常用優先'],
      ['2tｽﾘﾑ',          80, 840,  6, 30, '狭路向け'],
      ['2tｼｮｰﾄ',         100, 840, 6, 40, '主力'],
      ['2tｼｮｰﾄ平ﾎﾞﾃﾞｨ', 100, 840, 6, 50, '長尺対応'],
      ['2t平ﾎﾞﾃﾞｨ',     110, 840, 6, 60, '長尺対応'],
      ['2t',             100, 840, 6, 70, '汎用'],
      ['2ワイド',        120, 840, 6, 80, '幅広積載'],
    ];
    const ins = _db.prepare(`INSERT OR IGNORE INTO td_vehicle_types
      (vehicle_type, capacity_sai, return_by_min, max_stops, is_active, sort_order, notes)
      VALUES (?, ?, ?, ?, 1, ?, ?)`);
    for (const t of seedTypes) ins.run(...t);
  } catch (e) {}
  // ジオコードキャッシュ (Nominatim呼び出し結果)
  _db.exec(`CREATE TABLE IF NOT EXISTS td_geocache (
    address TEXT PRIMARY KEY,
    lat REAL,
    lng REAL,
    source TEXT DEFAULT 'nominatim',
    accuracy TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );`);
  // 荷主アクセストークン
  _db.exec(`CREATE TABLE IF NOT EXISTS td_shipper_tokens (
    token TEXT PRIMARY KEY,
    shipper_name TEXT,
    scope TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT
  );`);
  // デフォルトの荷主トークン (タカラスタンダード) - デモ用
  try {
    const exists = _db.prepare("SELECT 1 FROM td_shipper_tokens WHERE token = 'takara'").get();
    if (!exists) {
      _db.prepare("INSERT INTO td_shipper_tokens (token, shipper_name, scope) VALUES (?, ?, ?)")
        .run('takara', 'タカラスタンダード', 'all');
    }
  } catch (e) {}
  // ミーティング履歴 (2026-05-09): ZOOM風シンプル会議+AI議事録
  _db.exec(`CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    title TEXT,
    started_by TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    participants TEXT,
    transcript TEXT,
    summary TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mt_room ON meetings(room_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_mt_at ON meetings(started_at DESC);`);
  // DM制限フラグ — 1の場合、共通グループのメンバーまたはadmin/promoterとしかDMできない
  // 新規一般社員に1を設定して部署内チャットに限定する用途 (5/4)
  ensureColumn(_db, 'users', 'dm_restricted', 'dm_restricted INTEGER DEFAULT 0');
  // 生年月日 (健診Box連携・年齢別分析用、本人と管理者のみ閲覧)
  ensureColumn(_db, 'users', 'birth_date', 'birth_date TEXT');
  // 旧姓 (Box健診xlsmが旧姓のままの場合に検索フォールバックで使用)
  ensureColumn(_db, 'users', 'maiden_name', 'maiden_name TEXT');
  // 掲示板/ひろば 最終既読時刻 (新着バッジ計算用)
  ensureColumn(_db, 'users', 'last_board_seen_at', 'last_board_seen_at TEXT');
  ensureColumn(_db, 'users', 'last_plaza_seen_at', 'last_plaza_seen_at TEXT');
  // ニックネーム (本人が初回ログイン時に設定。匿名投稿時の表示名として使用)
  ensureColumn(_db, 'users', 'nickname', 'nickname TEXT');
  // 利用規約・プライバシーポリシー同意 (バージョン文字列で管理 / 改定時に再同意要求)
  ensureColumn(_db, 'users', 'consent_version', 'consent_version TEXT');
  ensureColumn(_db, 'users', 'consent_accepted_at', 'consent_accepted_at TEXT');
  // 帝京大学公衆衛生学研究室との共同研究: 匿名集計データの利用同意 (任意・opt-in)
  ensureColumn(_db, 'users', 'research_consent', 'research_consent INTEGER DEFAULT 0');
  ensureColumn(_db, 'users', 'research_consent_at', 'research_consent_at TEXT');
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
  // 既存テーブルに研究同意カラム追加 (idempotent)
  try {
    const clCols = _db.prepare('PRAGMA table_info(consent_logs)').all().map(c => c.name);
    if (!clCols.includes('accepted_research')) {
      _db.prepare('ALTER TABLE consent_logs ADD COLUMN accepted_research INTEGER DEFAULT 0').run();
    }
  } catch (e) { console.warn('[consent_logs accepted_research migration]', e.message); }
  // ゲスト (大学・NPO等の外部レビュアー) フラグ — 施策ボードレビュー権限
  ensureColumn(_db, 'users', 'is_guest_reviewer', 'is_guest_reviewer INTEGER DEFAULT 0');
  ensureColumn(_db, 'users', 'guest_org', 'guest_org TEXT');
  // 点呼・朝礼 操作者(点呼者/管理者) フラグ — タブレットで点呼・朝礼を記録できる (2026-05-27)
  // 権限は (このフラグ OR 管理職 OR manager OR 推進メンバー運管/倉庫) のいずれかで付与
  ensureColumn(_db, 'users', 'is_tenko_operator', 'is_tenko_operator INTEGER DEFAULT 0');
  // 会社マスタ表示名を実社名へ正規化 (2026-05-25: 旧 SU本社/IBA鹿島/スズエ 等 → 正式社名)
  // 本番では 支店チャットグループ名 と users.dm_group が旧社名そのもの (companies.name と連動)。
  // 表示だけ変えると次回登録時に新社名グループが別途作られ既存グループと分断するため、
  // companies.name / chat_groups.name(支店GC) / users.dm_group を旧→新へコヒーレントに一括リネーム。
  // 全て exact-match の冪等UPDATE (旧名が無ければ no-op)。
  try {
    // code → [旧name, 新name]
    const COMPANY_RENAME = [
      // 2026-05-26: 本社→スタンダード運輸 海老名。旧名(SU本社/スタンダード運輸 本社)両方を海老名へ寄せる
      ['SU_HQ',       'SU本社',            'スタンダード運輸 海老名'],
      ['SU_HQ',       'スタンダード運輸 本社', 'スタンダード運輸 海老名'],
      ['SU_SAITAMA',  'SU埼玉',   'スタンダード運輸 埼玉'],
      ['SU_MKANTO',   'SU南関東', 'スタンダード運輸 南関東'],
      ['SU_ZAMA',     'SU座間',   'スタンダード運輸 座間'],
      ['IBA_KASHIMA', 'IBA鹿島',  '茨運(鹿島)'],
      ['IBA_SANWA',   'IBA三和',  '茨運(三和)'],
      ['SUZUE',       'スズエ',   'スズエ電機'],
      // 2026-07-07: スズエ電機を2拠点(工場)に分割。既存SUZUEは豊田工場、天竜工場は新設(SUZUE_TENRYU)。
      ['SUZUE',       'スズエ電機', 'スズエ電機 豊田工場'],
    ];
    const updCompany = _db.prepare('UPDATE companies SET name = ? WHERE code = ? AND name != ?');
    const updGroup   = _db.prepare("UPDATE chat_groups SET name = ? WHERE name = ? AND category = 'branch'");
    const updDmGroup = _db.prepare('UPDATE users SET dm_group = ? WHERE dm_group = ?');
    const renameTx = _db.transaction(() => {
      for (const [code, oldName, newName] of COMPANY_RENAME) {
        updCompany.run(newName, code, newName);
        updGroup.run(newName, oldName);
        updDmGroup.run(newName, oldName);
      }
    });
    renameTx();
  } catch (e) { console.warn('[companies coherent rename]', e.message); }
  // ============================================================
  // 仮払精算システム (2026-05-25 GAS移植) — 領収書Gemini OCR型 経費精算
  // 営業所は companies を流用。承認は単純1段 (申請済→承認済/差戻し、管理職が承認)。
  // ============================================================
  _db.exec(`CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    apply_date TEXT,
    request_office TEXT,
    target_office TEXT,
    applicant TEXT,
    usage_date TEXT,
    vendor TEXT,
    ocr_vendor TEXT,
    amount INTEGER DEFAULT 0,
    ocr_amount INTEGER DEFAULT 0,
    account_title TEXT,
    summary TEXT,
    receipt_date TEXT,
    ocr_receipt_date TEXT,
    invoice_no TEXT,
    ocr_text TEXT,
    image_url TEXT,
    status TEXT DEFAULT '申請済',
    checker TEXT,
    checked_at TEXT,
    return_reason TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_expenses_office ON expenses(request_office, status);
  CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at DESC);
  CREATE TABLE IF NOT EXISTS expense_account_titles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT, name TEXT NOT NULL, active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS expense_vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT, name TEXT NOT NULL, yomi TEXT, note TEXT, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS expense_applicants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT, name TEXT NOT NULL, company_code TEXT, active INTEGER DEFAULT 1
  );`);
  // 勘定科目 初期シード (空のときのみ)
  try {
    const cnt = _db.prepare('SELECT COUNT(*) c FROM expense_account_titles').get().c;
    if (!cnt) {
      const seed = ['燃料費','旅費交通費','荷造運賃','消耗品費','事務用品費','通信費','会議費','接待交際費','修繕費','雑費'];
      const ins = _db.prepare('INSERT INTO expense_account_titles (name, active, sort_order) VALUES (?, 1, ?)');
      seed.forEach((n, i) => ins.run(n, i));
    }
  } catch (e) { console.warn('[expense account seed]', e.message); }
  // ============================================================
  // 承認申請システム (2026-05-25 GAS移植 / 決裁基準表ベース)
  // SU・茨運共通。役職→担当者(login_id)、ルート(申請種別×金額帯×営業所→役職チェーン)は管理画面で編集可能。
  // スズエ電機は別ルート(後日)。
  // ============================================================
  _db.exec(`CREATE TABLE IF NOT EXISTS appr_roles (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, rank INTEGER DEFAULT 0, office_specific INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS appr_role_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_code TEXT NOT NULL, office_code TEXT NOT NULL DEFAULT 'ALL', user_login_id TEXT
  );
  CREATE TABLE IF NOT EXISTS appr_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    apply_type TEXT NOT NULL, office_code TEXT NOT NULL DEFAULT 'ALL',
    amount_min INTEGER DEFAULT 0, amount_max INTEGER DEFAULT 0,
    chain TEXT NOT NULL, priority INTEGER DEFAULT 100, active INTEGER DEFAULT 1, note TEXT
  );
  CREATE TABLE IF NOT EXISTS approval_apps (
    id TEXT PRIMARY KEY,
    subject TEXT, apply_type TEXT, office_code TEXT, amount INTEGER DEFAULT 0,
    route_id INTEGER, chain TEXT, status TEXT DEFAULT '申請中',
    cur_step INTEGER DEFAULT 0, cur_role TEXT,
    attach1_url TEXT, attach1_name TEXT, attach2_url TEXT, attach2_name TEXT, attach3_url TEXT, attach3_name TEXT,
    applicant_id TEXT, applicant_name TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_appr_apps_status ON approval_apps(status, cur_role);
  CREATE TABLE IF NOT EXISTS approval_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL, action TEXT, role TEXT, actor_name TEXT, note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );`);
  // 承認ルートに「自己承認を許可」フラグ(申請者本人でも承認可)。管理課の時間外等、課長本人の申請用 (2026-06-17)
  ensureColumn(_db, 'appr_routes', 'allow_self_approve', 'allow_self_approve INTEGER DEFAULT 0');
  // マンスリー栄養レポート (2026-06-17): 食事投稿を1か月集計したAIレポートを保存
  _db.exec(`CREATE TABLE IF NOT EXISTS food_monthly_reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    ym TEXT NOT NULL,
    meal_count INTEGER DEFAULT 0,
    metrics_json TEXT,
    report_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, ym)
  );
  CREATE INDEX IF NOT EXISTS idx_fmr_user ON food_monthly_reports(user_id, ym DESC);`);
  try {
    if (!_db.prepare('SELECT COUNT(*) c FROM appr_roles').get().c) {
      // 役職階層 (rank昇順=承認順)。office_specific=1 は営業所別(MGR=所長)
      const roles = [
        ['KCH','課長',1,0],['MGR','所長',2,1],['MBD','管理部長',3,0],['DIR','取締役',4,0],
        ['HOB','事業本部長',6,0],['HQA','経営管理本部長',7,0],['SVP','専務取締役',8,0],['PRES','代表取締役社長',9,0],
      ];
      const ir = _db.prepare('INSERT INTO appr_roles (code,name,rank,office_specific) VALUES (?,?,?,?)');
      roles.forEach(r => ir.run(...r));
      // 役職→担当者(login_id) ※PDFユーザーマスタより。MGRは営業所別(CoHub company_code)。空営業所/役職は管理画面で割当。
      const asg = [
        ['PRES','ALL','taketake'],['SVP','ALL','chikara'],['HQA','ALL','y_gotoh'],
        ['HOB','ALL','y_okada'],['MBD','ALL','y_yoshizawa'],
        ['MGR','SU_HQ','a_yamada'],['MGR','SU_MKANTO','y_aoki'],['MGR','SU_ZAMA','ts_hamamichi'],
        ['MGR','IBA_KASHIMA','t_tsuchiko'],['MGR','IBA_SANWA','e_sugai'],
      ];
      const ia = _db.prepare('INSERT INTO appr_role_assignments (role_code,office_code,user_login_id) VALUES (?,?,?)');
      asg.forEach(a => ia.run(...a));
      // ルート(決裁基準表 SU・茨運共通)。chain=役職コードを承認順(下位→上位)で。(●)所長不在=取締役 等の代理は省略しDIR/KCH等未割当ロールは申請時にスキップ。
      const ALL = 'KCH,MGR,MBD,DIR,HOB,HQA,SVP,PRES';
      const routes = [
        ['届書(休暇・時間外等)',0,0,'KCH,MGR,MBD'],
        ['時間外申請',0,0,'KCH,MGR,MBD'],
        ['人事変更届',0,0,'KCH,MGR,MBD'],
        ['休日手当支給申請',0,0,'KCH,MGR,MBD'],
        ['出張申請・旅費清算',0,0,'KCH,MGR,MBD,HQA'],
        ['慶弔見舞金支払申請',0,0,'KCH,MGR,MBD'],
        ['事故報告書',0,0,'KCH,MGR,MBD'],
        ['接待交際費清算',0,0,'KCH,MGR,MBD'],
        ['取引条件変更(締日等)',0,0,'KCH,MGR,MBD'],
        ['新規協力会社取引・取引条件変更',0,0,'KCH,MGR,MBD,HOB,HQA'],
        ['車検申請',0,0,'KCH,MGR,MBD'],
        ['タイヤ・バッテリー・シート申請',0,0,'KCH,MGR,MBD,HOB'],
        ['車両修理(30万円以下)',0,300000,'KCH,MGR,MBD,HOB,HQA,SVP'],
        ['車両修理(30万円超)',300001,0,ALL],
        ['車両移動申請',0,0,ALL],
        ['車両購入(新規・代替)',0,0,ALL],
        ['物品購入・修理(3万円以下)',0,30000,'KCH,MGR,MBD,HOB'],
        ['物品購入(3万円超〜5万円)',30001,50000,'KCH,MGR,MBD,HOB'],
        ['物品購入(5万円超〜10万円)',50001,100000,'KCH,MGR,MBD,HOB,HQA,SVP'],
        ['物品購入(10万円超)',100001,0,ALL],
        ['社員募集広告',0,0,'KCH,MGR,MBD,HOB,HQA,SVP,PRES'],
        ['資格取得申請',0,0,ALL],
        ['土地購入等大型投資',0,0,ALL],
        ['社外企業との契約',0,0,ALL],
        ['稟議(一般)',0,0,'KCH,MGR,MBD,HOB,HQA,SVP,PRES'],
      ];
      const irt = _db.prepare("INSERT INTO appr_routes (apply_type,office_code,amount_min,amount_max,chain,priority,active) VALUES (?,?,?,?,?,100,1)");
      routes.forEach(r => irt.run(r[0],'ALL',r[1],r[2],r[3]));
    }
  } catch (e) { console.warn('[approval seed]', e.message); }
  // 大学・NPO法人 会社コード追加 (ゲスト用所属)
  _db.prepare("INSERT OR IGNORE INTO companies (code, name, ring_color) VALUES ('UNIVERSITY', '大学・研究機関', '#7c3aed')").run();
  _db.prepare("INSERT OR IGNORE INTO companies (code, name, ring_color) VALUES ('NPO', 'NPO法人', '#0891b2')").run();
  _db.prepare("INSERT OR IGNORE INTO companies (code, name, ring_color) VALUES ('GUEST', 'ゲスト', '#94a3b8')").run();
  // スズエ電機 天竜工場 (2026-07-07: 2拠点化。豊田工場=既存SUZUE)
  _db.prepare("INSERT OR IGNORE INTO companies (code, name, ring_color) VALUES ('SUZUE_TENRYU', 'スズエ電機 天竜工場', '#0d9488')").run();
  // 2026-08-05: 本番DBに手動INSERTされていて seed に無かった所属を追加 (DB再構築で消えるのを防ぐ)。
  // ⚠️name は users.dm_group / 同名グループチャットと連動する。変更するなら3点まとめてリネームすること。
  _db.prepare("INSERT OR IGNORE INTO companies (code, name, ring_color) VALUES ('KOJI', '施工事業係', '#b45309')").run();
  _db.prepare("INSERT OR IGNORE INTO companies (code, name, ring_color) VALUES ('SU_KANRI', '管理課', '#475569')").run();
  _db.prepare("INSERT OR IGNORE INTO companies (code, name, ring_color) VALUES ('SU_KANRIBU', '管理部', '#334155')").run();
  // 拠点ごとのWi-Fi情報 (タブレット表示用 — 個人スマホがWi-Fi経由でCoWellへ接続できるよう推進メンバーが入力)
  ensureColumn(_db, 'companies', 'wifi_ssid', 'wifi_ssid TEXT');
  ensureColumn(_db, 'companies', 'wifi_password', 'wifi_password TEXT');
  ensureColumn(_db, 'companies', 'wifi_security', "wifi_security TEXT DEFAULT 'WPA'");
  ensureColumn(_db, 'companies', 'wifi_updated_at', 'wifi_updated_at TEXT');
  ensureColumn(_db, 'companies', 'wifi_updated_by', 'wifi_updated_by TEXT');
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
  // 聞き取りカード方式 (2026-05-08): 被聞き取り者と構造化回答JSON
  ensureColumn(_db, 'wellness_posts', 'subject_user_id', "subject_user_id TEXT");
  ensureColumn(_db, 'wellness_posts', 'structured_json', "structured_json TEXT");
  // 点呼POST一括管理 (2026-06-25): 確認/対応の状態。未対応/確認済/対応済
  ensureColumn(_db, 'wellness_posts', 'ack_status', "ack_status TEXT DEFAULT '未対応'");
  ensureColumn(_db, 'wellness_posts', 'ack_by', "ack_by TEXT");
  ensureColumn(_db, 'wellness_posts', 'ack_at', "ack_at TEXT");
  // ============================================================
  // 点呼・朝礼 (2026-05-27): タブレットキオスクで運行管理者が営業所メンバーを1人ずつ記録
  // 点呼=ドライバー(東海電子で点呼/アルコール/免許/血圧 実施済み確認 + 体調聞き取り)
  // 朝礼=倉庫・製造ほか(安全一言 + 体調ひとこと)。1日1回(rec_date×target_idでユニーク=上書き)。
  // ⚠️アルコール/免許/血圧の数値は東海電子が正。CoHubは二重入力せず体調観察+連絡に特化。
  // ============================================================
  _db.exec(`CREATE TABLE IF NOT EXISTS tenko_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rec_date TEXT NOT NULL,
    target_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    company_code TEXT,
    mode TEXT NOT NULL,
    tokai_done INTEGER DEFAULT 0,
    condition TEXT,
    health_json TEXT,
    urgency TEXT,
    note TEXT,
    wellness_post_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenko_uniq ON tenko_records(rec_date, target_id);
  CREATE INDEX IF NOT EXISTS idx_tenko_day ON tenko_records(rec_date, company_code);
  CREATE TABLE IF NOT EXISTS tenko_briefs (
    rec_date TEXT NOT NULL,
    company_code TEXT NOT NULL,
    message TEXT,
    set_by TEXT,
    updated_at TEXT,
    PRIMARY KEY (rec_date, company_code)
  );`);
  // 血圧は東海電子の点呼システムに連動していないため CoHubで管理者が点呼時に記入 (2026-05-27)
  ensureColumn(_db, 'tenko_records', 'bp_systolic', 'bp_systolic INTEGER');
  ensureColumn(_db, 'tenko_records', 'bp_diastolic', 'bp_diastolic INTEGER');
  ensureColumn(_db, 'tenko_records', 'pulse', 'pulse INTEGER');
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
  // 推進メンバー共有スケジュール (2026-05-20)
  _db.exec(`CREATE TABLE IF NOT EXISTS wellness_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    owner_id TEXT,
    color TEXT DEFAULT '#3b82f6',
    status TEXT DEFAULT 'planned',
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ws_date ON wellness_schedule(start_date, end_date);`);
  // 配車センター追加 (2026-04-27): 現場棟内、未実装ページ
  _db.prepare(`INSERT OR IGNORE INTO floors (code, name, bg_image, world_w, world_h, entry_x, entry_y, sort_order, icon, building)
    VALUES ('field_dispatch', '配車センター', '/assets/floor_field_rest.png', 1344, 768, 672, 678, 11, '🗺', 'field')`).run();
  // 健康管理室フロア (2026-04-28再設置): AIヘルスアドバイザー (bot_health) 常駐
  _db.prepare(`INSERT OR IGNORE INTO floors (code, name, bg_image, world_w, world_h, entry_x, entry_y, sort_order, icon, building)
    VALUES ('wellness_room', '🏥 健康管理室', '/assets/floor_wellness_room.png', 1344, 768, 672, 700, 6, '🏥', 'office')`).run();
  // 事故対策室フロア (2026-04-30): 現場棟。事故報告レビュー・再発防止検討の集合場所
  // 安全管理者(bot_safety) 常駐、前面に大型ビデオスクリーンで事故/破損情報を流し続ける
  _db.prepare(`INSERT OR IGNORE INTO floors (code, name, bg_image, world_w, world_h, entry_x, entry_y, sort_order, icon, building)
    VALUES ('field_accident', '事故対策室', '/assets/floor_field_accident.png', 1344, 768, 672, 700, 14, '🚨', 'field')`).run();
  // 既存DBのfield_accident背景を新画像に更新 (前回 floor_field_meet.png で投入していたものを上書き)
  _db.prepare(`UPDATE floors SET bg_image = '/assets/floor_field_accident.png', entry_y = 700 WHERE code = 'field_accident'`).run();
  // 2026-04-30: 現場棟フロア名から「現場 」プレフィックス削除 (UI簡素化)
  _db.prepare(`UPDATE floors SET name = '乗務員詰所' WHERE code = 'field_rest' AND name = '現場 乗務員詰所'`).run();
  _db.prepare(`UPDATE floors SET name = '倉庫作業室' WHERE code = 'field_work' AND name = '現場 倉庫作業室'`).run();
  _db.prepare(`UPDATE floors SET name = 'ミーティング' WHERE code = 'field_meet' AND name = '現場 ミーティング'`).run();
  _db.prepare(`UPDATE floors SET name = '事故対策室' WHERE code = 'field_accident' AND name = '現場 事故対策室'`).run();
  // 事故対策室スクリーン投稿テーブル
  _db.exec(`CREATE TABLE IF NOT EXISTS accident_screen_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_url TEXT NOT NULL,
    media_type TEXT NOT NULL,           -- image | video | text
    caption TEXT,
    text_body TEXT,                      -- media_type=text 時の本文 (2026-04-30追加)
    posted_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_asp_at ON accident_screen_posts(created_at DESC);

  -- 過去事故報告書 PDFアーカイブ (2026-04-30): bot_safetyの学習材料 + スクリーン掲示元
  CREATE TABLE IF NOT EXISTS accident_archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pdf_url TEXT NOT NULL,
    page_image_urls TEXT DEFAULT '[]',  -- JSON: ["/uploads/archive_xxx_p1.png", ...]
    title TEXT,
    accident_date TEXT,
    summary TEXT,
    full_text TEXT,
    uploaded_by TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_aa_at ON accident_archives(created_at DESC);
  -- 安全管理者 AI分析レポート (2026-04-30): 過去事故データを Gemini が定期分析
  CREATE TABLE IF NOT EXISTS accident_analysis_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_label TEXT,                  -- 例: "全期間", "直近180日"
    target_archives INTEGER DEFAULT 0,  -- 分析対象のアーカイブ件数
    target_reports INTEGER DEFAULT 0,   -- 分析対象の報告書件数
    summary TEXT,                        -- 200字以内の要約 (bot_safety contextに使用)
    full_report TEXT,                    -- マークダウン全文
    generated_by TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_aar_at ON accident_analysis_reports(created_at DESC);`);
  // accident_screen_posts に text_body カラム追加 (既存DB用 idempotent)
  try { _db.prepare('ALTER TABLE accident_screen_posts ADD COLUMN text_body TEXT').run(); } catch (e) {}
  // recordings: AI議事録 自動生成ステータス (none / pending / done / failed)
  ensureColumn(_db, 'recordings', 'transcript_status', "transcript_status TEXT DEFAULT 'none'");
  // 番組表 (ファイル単位グループ表示) 用カラム追加
  try { _db.prepare('ALTER TABLE accident_screen_posts ADD COLUMN source_label TEXT').run(); } catch (e) {}
  try { _db.prepare('ALTER TABLE accident_screen_posts ADD COLUMN source_id TEXT').run(); } catch (e) {}
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
  ensureColumn(_db, 'plaza_posts', 'image_urls', 'image_urls TEXT');   // 複数枚撮影 (2026-07-30)
  // イベント (Phase7) — 健康イベント等の「開催中」リスト
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
  // マイ運動記録 🔥 (2026-05-23) — 個人運動ログ、kcal統一KPI
  _db.exec(`CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    steps INTEGER,
    distance_km REAL,
    duration_min INTEGER,
    kcal INTEGER NOT NULL,
    kcal_source TEXT DEFAULT 'estimated',
    comment TEXT,
    photo_url TEXT,
    source TEXT DEFAULT 'manual',
    visibility TEXT DEFAULT 'private',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_act_user_date ON activity_logs(user_id, date DESC);
  CREATE INDEX IF NOT EXISTS idx_act_user_created ON activity_logs(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS user_activity_prefs (
    user_id TEXT PRIMARY KEY,
    weight_kg REAL,
    monthly_goal_kcal INTEGER,
    default_visibility TEXT DEFAULT 'private',
    reminder_time TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );`);
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
  // 2026-08-09: チャレンジ + KPI (challenges / challenge_participants / kpi_records) は廃止。
  //   全社健康アクションとして現実的でないと判断し、テーブルごと削除した (利用実績0件)。復活させないこと。
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
  // 旧 🐠 水族館の冒険 (CoWell Classic) は2026-05に停止、シード処理は廃止
  // login_id 統一: eitaro → e_sugai (須貝栄二)
  try { _db.prepare("UPDATE users SET login_id = 'e_sugai' WHERE login_id = 'eitaro'").run(); } catch (e) {}
  // 推進メンバー初期付与 (運管型) — taketake はテスト確認用
  _db.prepare("UPDATE users SET is_field_promoter = 1 WHERE login_id IN ('y_yoshizawa','a_yamada','e_sugai','taketake')").run();
  // [migration] chat_groups に sort_order + サークル列 追加 (idempotent)
  try {
    const cgCols = _db.prepare('PRAGMA table_info(chat_groups)').all().map(c => c.name);
    if (!cgCols.includes('sort_order')) {
      _db.prepare('ALTER TABLE chat_groups ADD COLUMN sort_order INTEGER DEFAULT 100').run();
    }
    if (!cgCols.includes('is_circle')) _db.prepare('ALTER TABLE chat_groups ADD COLUMN is_circle INTEGER DEFAULT 0').run();
    if (!cgCols.includes('description')) _db.prepare('ALTER TABLE chat_groups ADD COLUMN description TEXT').run();
    if (!cgCols.includes('lead_uid')) _db.prepare('ALTER TABLE chat_groups ADD COLUMN lead_uid TEXT').run();
    if (!cgCols.includes('recruiting')) _db.prepare('ALTER TABLE chat_groups ADD COLUMN recruiting INTEGER DEFAULT 1').run();
    if (!cgCols.includes('join_mode')) _db.prepare("ALTER TABLE chat_groups ADD COLUMN join_mode TEXT DEFAULT 'approve'").run();
    if (!cgCols.includes('cover_image')) _db.prepare('ALTER TABLE chat_groups ADD COLUMN cover_image TEXT').run();
    if (!cgCols.includes('color_theme')) _db.prepare("ALTER TABLE chat_groups ADD COLUMN color_theme TEXT DEFAULT 'teal'").run();
    // 2026-05-23: category 列 (営業所グループ親カテゴリ用) ─ 'branch' = 各営業所, 'hq' = 事業本部, null = それ以外
    if (!cgCols.includes('category')) _db.prepare('ALTER TABLE chat_groups ADD COLUMN category TEXT').run();
  } catch (e) { console.warn('[chat_groups migration]', e.message); }
  // サークル参加申請テーブル (idempotent)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS circle_join_requests (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      decided_at TEXT,
      decided_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cjr_group ON circle_join_requests(group_id);
    CREATE INDEX IF NOT EXISTS idx_cjr_user ON circle_join_requests(user_id);
    CREATE INDEX IF NOT EXISTS idx_cjr_status ON circle_join_requests(status);
  `);
  // サークル予定 (簡易カレンダー)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS circle_events (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      title TEXT NOT NULL,
      event_date TEXT NOT NULL,
      event_time TEXT,
      location TEXT,
      memo TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ce_group_date ON circle_events(group_id, event_date);
  `);
  // 現場の声 専用グループチャット作成 (idempotent)
  const PROMOTER_GROUP_ID = 'g_field_voice';
  const grpExists = _db.prepare('SELECT 1 FROM chat_groups WHERE id = ?').get(PROMOTER_GROUP_ID);
  if (!grpExists) {
    _db.prepare("INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)")
      .run(PROMOTER_GROUP_ID, '🩺 現場の声', '🩺', null);
  }
  // 健康管理室ディスカッションGC (Bライン: 事務側からの直接議論)
  const WELLNESS_DISC_ID = 'g_wellness_disc';
  const discExists = _db.prepare('SELECT 1 FROM chat_groups WHERE id = ?').get(WELLNESS_DISC_ID);
  if (!discExists) {
    _db.prepare("INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)")
      .run(WELLNESS_DISC_ID, '🏥 健康管理室ディスカッション', '🏥', null);
  }
  // 2026-05-23: 「👔 管理職グループ」(g_managers) は廃止。既存のdm_group由来「管理職」GCに集約
  // 業務連絡グループ (2026-05-08): 車両不具合/事故/荷主クレーム/BC のops.js POSTを自動配信
  const OPS_GROUP_ID = 'g_ops_reports';
  const opsGrpExists = _db.prepare('SELECT 1 FROM chat_groups WHERE id = ?').get(OPS_GROUP_ID);
  if (!opsGrpExists) {
    _db.prepare("INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)")
      .run(OPS_GROUP_ID, '🚛 業務連絡', '🚛', null);
  }
  // 事業本部グループ (2026-05-23 作成) は 2026-07-29 に廃止。
  // 再作成しないこと (管理部・経営管理部も同日廃止。ここで復活させると削除が無効になる)。
  // メンバー: 推進メンバー + 全管理者を自動加入 (推進系GC両方共通、既加入はスキップ)
  const promoterRows = _db.prepare("SELECT id FROM users WHERE is_field_promoter = 1 OR role = 'admin'").all();
  const memInsert = _db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)');
  for (const r of promoterRows) {
    memInsert.run(PROMOTER_GROUP_ID, r.id);
    memInsert.run(WELLNESS_DISC_ID, r.id);
    memInsert.run(OPS_GROUP_ID, r.id);
  }
  // 倉庫推進メンバーも統合後の現場の声 (g_field_voice) に自動加入
  const warehousePromoterRows = _db.prepare("SELECT id FROM users WHERE is_warehouse_promoter = 1").all();
  for (const r of warehousePromoterRows) {
    memInsert.run(PROMOTER_GROUP_ID, r.id);
  }
  // 業務連絡GC: employee_type=admin (管理職) も自動加入
  const opsAdminRows = _db.prepare("SELECT id FROM users WHERE employee_type = 'admin' OR role = 'admin' OR is_field_promoter = 1").all();
  for (const r of opsAdminRows) {
    memInsert.run(OPS_GROUP_ID, r.id);
  }
  // 2026-07-29: 事業本部GCの廃止に伴い、HQ_LOGIN_IDS による自動加入は削除 (再追加しないこと)。
  // 営業所カテゴリ自動付与 (idempotent): 旧名(SU*/IBA*/スズエ) + 新実社名(スタンダード運輸*/茨運*/スズエ電機)
  // ⚠️category='branch' は chat-simple.html の「🏢 営業所グループ」セクションの振り分けに使われる。
  //   ここに入れ忘れると、そのGCは通常グループ側に出てしまう(2026-08-05 施工事業係でこれが起きた)。
  // 2026-08-05: 施工事業係を追加。社名パターンに当てはまらない所属を足すときは必ずここも足すこと。
  _db.prepare(`UPDATE chat_groups SET category = 'branch'
               WHERE (name LIKE 'SU%' OR name LIKE 'IBA%' OR name = 'スズエ'
                      OR name LIKE 'スタンダード運輸%' OR name LIKE '茨運%' OR name = 'スズエ電機'
                      OR name = '施工事業係')
                 AND (category IS NULL OR category = '')`).run();
  // 特殊GCの sort_order を権威的に設定 (idempotent)
  const specialOrders = [
    [OPS_GROUP_ID, 10],
    [WELLNESS_DISC_ID, 30],
    [PROMOTER_GROUP_ID, 40],
  ];
  for (const [gid, n] of specialOrders) {
    _db.prepare('UPDATE chat_groups SET sort_order = ? WHERE id = ?').run(n, gid);
  }
  // dm_group由来 GC: 「管理職」を50、それ以外を100 (default) のまま (ユーザーが個別に並べ替え可能)
  _db.prepare("UPDATE chat_groups SET sort_order = 50 WHERE name = '管理職'").run();
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

  // ===== 事故報告 承認ルート + 構造化対策 + AI見解 + コメント (2026-06-03) =====
  // フロー: 現場責任者が報告 → 所属所長(同 company_code の管理職 / 本社ADMINはフォールバック)が承認 → 全社公開
  // 承認まで非公開 (報告者本人・所属所長・本社管理職のみ閲覧)。
  // 「報告/コメントの形骸化」対策として 直接原因/根本原因/再発防止策/組織的歯止め を構造化必須化し、提出時にAI見解で採点。
  for (const _t of ['vehicle_accident_reports', 'kbc_accident_reports']) {
    ensureColumn(_db, _t, 'reporter_id', 'reporter_id TEXT');                         // 報告者uid (製品事故の未公開閲覧可否を自由記述reporter_nameでなくidで判定)
    ensureColumn(_db, _t, 'branch_code', 'branch_code TEXT');                         // 報告者の所属拠点 (承認スコープ)
    ensureColumn(_db, _t, 'direct_cause', 'direct_cause TEXT');                       // 直接原因 (何が起きたか)
    ensureColumn(_db, _t, 'root_cause', 'root_cause TEXT');                           // 根本原因 (なぜ起きたか/なぜなぜ)
    ensureColumn(_db, _t, 'recurrence_prevention', 'recurrence_prevention TEXT');     // 再発防止策 (本人/現場)
    ensureColumn(_db, _t, 'org_measure', 'org_measure TEXT');                         // 組織的歯止め (仕組みで止める)
    ensureColumn(_db, _t, 'ai_review', 'ai_review TEXT');                             // AI見解 (markdown)
    ensureColumn(_db, _t, 'ai_review_at', 'ai_review_at TEXT');
  }
  _db.exec(`CREATE TABLE IF NOT EXISTS accident_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_kind TEXT NOT NULL,            -- 'vehicle' | 'product'
    report_id INTEGER NOT NULL,
    user_id TEXT,
    user_name TEXT,
    role_label TEXT,                      -- 所長 / 管理職 / 役員 等の表示ラベル
    body TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_accident_comments ON accident_comments(report_kind, report_id, created_at);`);

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

  // 健康管理室 対話型アクションプラン (Phase 1 — 5/5)
  // ユーザーと AI が数往復で実行可能なアクションを共同決定。
  // 5パターン (置換/減らす/やめる/加える/タイミング)、エビデンス範囲限定、医療行為禁則。
  _db.exec(`CREATE TABLE IF NOT EXISTS myplan_dialogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    status TEXT DEFAULT 'active',          -- 'active' / 'finalized' / 'abandoned'
    seed_category TEXT,                    -- 'meal' / 'move' / 'sleep' / 'drink' / 'check' / 'other'
    history_json TEXT NOT NULL DEFAULT '[]',  -- [{role:'ai'|'user', text, choices?, value?, ts}]
    final_action TEXT,                     -- 確定アクション本文 (1〜2行)
    final_pattern TEXT,                    -- 'reduce' / 'stop' / 'swap' / 'add' / 'timing'
    final_evidence TEXT,                   -- 引用エビデンス (ガイドライン名+該当数値)
    final_confidence INTEGER,              -- 自信度 1-10
    final_when TEXT,                       -- 実行予定 (今日/明日/週末/...)
    finalized_consultation_id INTEGER,     -- 既存 myplan_consultations への昇格 ID
    created_at TEXT DEFAULT (datetime('now')),
    finalized_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mpdialog_user ON myplan_dialogs(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_mpdialog_active ON myplan_dialogs(user_id, status);`);

  // ===== 個人プラン v2 (2026-05-20) =====
  // 15基本プランから1つを選び、期間 (3/7/14/30/90日) を決めて毎日 ○/△/✕/休 + 1行コメントで実行管理。
  // AI が日次返答+連続✕で軸変更提案。データなしで新規社員も初日から開始可能。
  _db.exec(`CREATE TABLE IF NOT EXISTS myplan_active_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    basic_plan_id TEXT NOT NULL,            -- 'p01' .. 'p15'
    plan_title TEXT NOT NULL,                -- スナップショット (将来の基本プラン更新に強い)
    plan_action TEXT NOT NULL,
    plan_category TEXT NOT NULL,             -- 'move' / 'meal' / 'sleep' / 'rest' / 'drink' / 'mind'
    period_days INTEGER NOT NULL,            -- 3 / 7 / 14 / 30 / 90
    started_at TEXT DEFAULT (datetime('now','localtime')),
    completed_at TEXT,                       -- 全期間達成 (○/△ 合計 >= period_days * 0.7 とか)
    abandoned_at TEXT,                       -- 軸変更で中止
    status TEXT DEFAULT 'active'             -- 'active' / 'completed' / 'abandoned'
  );
  CREATE INDEX IF NOT EXISTS idx_mpap_user_status ON myplan_active_plans(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_mpap_active ON myplan_active_plans(status, started_at DESC);`);

  _db.exec(`CREATE TABLE IF NOT EXISTS myplan_calendar_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    active_plan_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    log_date TEXT NOT NULL,                  -- 'YYYY-MM-DD' (localtime)
    status TEXT NOT NULL,                    -- 'done' / 'partial' / 'miss' / 'rest'
    comment TEXT,                            -- ユーザー1行コメント (任意)
    ai_reply TEXT,                           -- AI返答 (3行程度)
    ai_axis_change INTEGER DEFAULT 0,        -- 軸変更提案フラグ (連続✕3+で1)
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(active_plan_id, log_date)
  );
  CREATE INDEX IF NOT EXISTS idx_mpcl_plan_date ON myplan_calendar_logs(active_plan_id, log_date DESC);
  CREATE INDEX IF NOT EXISTS idx_mpcl_user ON myplan_calendar_logs(user_id, log_date DESC);`);

  // 2026-08-09: Connect 230 (東京日本橋⇔磐田スズエ電機 双方向ウォーキングイベント) は廃止。
  //   イベント終了済で歩数記録も3件のみ。walk_* テーブルと users.walk_pin ごと撤去した。
  //   退避: /opt/_backup/cohub/attic_20260809/walk_tables_20260809.sql
  // 自動打刻オプション (2026-05-23): PC起動時に自動でpunch_in、退勤も最終ハートビートから自動推定
  ensureColumn(_db, 'users', 'auto_punch_in', 'auto_punch_in INTEGER DEFAULT 0');
  ensureColumn(_db, 'users', 'auto_punch_out', 'auto_punch_out INTEGER DEFAULT 0');

  // ==========================================================
  // 出退勤打刻 + PC起動時刻記録 (2026-05-07: ダウングレード時に追加)
  // 端末固定で社員ID対応の運用前提。打刻時刻と PC起動時刻の差分から
  // 「打刻前作業」を検出する内部統制目的のログ。
  // ==========================================================
  _db.exec(`CREATE TABLE IF NOT EXISTS time_punches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    punch_type TEXT NOT NULL,             -- 'in' / 'out'
    punched_at TEXT DEFAULT (datetime('now', 'localtime')),
    source TEXT DEFAULT 'web',             -- 'web' / 'mobile' / 'auto'
    pc_id TEXT,
    ip_address TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tp_user ON time_punches(user_id, punched_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tp_at ON time_punches(punched_at DESC);

  CREATE TABLE IF NOT EXISTS pc_startup_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    pc_id TEXT,
    started_at TEXT DEFAULT (datetime('now', 'localtime')),
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_psl_user ON pc_startup_logs(user_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_psl_at ON pc_startup_logs(started_at DESC);

  -- ハートビート (2026-05-23): 5分おきPC側からPing、退勤時刻推定用
  CREATE TABLE IF NOT EXISTS pc_heartbeats (
    user_id TEXT NOT NULL,
    pc_id TEXT,
    last_at TEXT DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (user_id, pc_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pcb_user_at ON pc_heartbeats(user_id, last_at DESC);

  -- 既読管理 (2026-05-08): メッセージ単位で誰が読んだかを記録
  CREATE TABLE IF NOT EXISTS message_reads (
    message_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    read_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mr_user ON message_reads(user_id);
  CREATE INDEX IF NOT EXISTS idx_mr_msg ON message_reads(message_id);

  -- 会社メール(IMAP/SMTP)連携の資格情報 (2026-06-01): パスワードはAES-256-GCM暗号化で保存
  CREATE TABLE IF NOT EXISTS user_mail_credentials (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    enc_password TEXT NOT NULL,
    imap_host TEXT DEFAULT 'z114.secure.ne.jp',
    imap_port INTEGER DEFAULT 993,
    smtp_host TEXT DEFAULT 'z114.secure.ne.jp',
    smtp_port INTEGER DEFAULT 465,
    display_name TEXT,
    signature TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  -- CoHub内でのメール既読(サーバーの\\Seenは変更せず、CoHub側だけで既読管理。元メーラーに影響させない)
  CREATE TABLE IF NOT EXISTS cohub_mail_seen (
    user_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    seen_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, message_id)
  );
  -- 迷惑メール(送信者ブロック): このアドレスからのメールをCoHub受信箱に表示しない(サーバーは触らない)
  CREATE TABLE IF NOT EXISTS user_mail_blocklist (
    user_id TEXT NOT NULL,
    address TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, address)
  );
  -- 個別メールの非表示(削除): このmessage_idをCoHub受信箱に表示しない(サーバーは触らない)
  CREATE TABLE IF NOT EXISTS user_mail_hidden (
    user_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, message_id)
  );
  -- メールのラベル(フォルダ): 個人ごと。ルール一致メールは受信箱から外しこのフォルダに表示(skip inbox)
  CREATE TABLE IF NOT EXISTS mail_labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#0d9488',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  -- 自動振り分けルール: from/subject/to を contains/equals/starts で判定し label を付与
  CREATE TABLE IF NOT EXISTS mail_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    label_id INTEGER NOT NULL,
    field TEXT NOT NULL DEFAULT 'from',
    op TEXT NOT NULL DEFAULT 'contains',
    value TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mail_labels_user ON mail_labels(user_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_mail_rules_user ON mail_rules(user_id, sort_order);`);

  // 既存DB向け: 会社メールの差出人名・署名 列を追加
  ensureColumn(_db, 'user_mail_credentials', 'display_name', 'display_name TEXT');
  ensureColumn(_db, 'user_mail_credentials', 'signature', 'signature TEXT');
  // メールフォルダの多層階(入れ子)対応: 親フォルダID (NULL=最上位)
  ensureColumn(_db, 'mail_labels', 'parent_id', 'parent_id INTEGER');
  // マイ運動記録: 匿名ランキングの自分の行に添える「応援ひとこと」(本人が編集・匿名表示)
  ensureColumn(_db, 'user_activity_prefs', 'rank_message', 'rank_message TEXT');

  return _db;
}

module.exports = { getDb };
