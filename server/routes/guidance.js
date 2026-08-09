const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// ===== 指導履歴(ドライバー健康起因の指導・本人承諾・乗務禁止フラグ)テーブルの自己修復 =====
// 「誰が(guided_by)・いつ(guided_at)・どのように(method/content)・なぜ(reason)指導し、
//   本人が承諾したか(consent_*)」を証跡として残す。状況により乗務禁止(ban_*)を付与できる。
try {
  getDb().exec(`CREATE TABLE IF NOT EXISTS driver_guidance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id TEXT NOT NULL,              -- 対象ドライバー users.id
    guided_by TEXT NOT NULL,              -- 指導者 users.id (運管/所長/管理職)
    company_code TEXT,                    -- 対象の拠点(スコープ用)
    guided_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    reason TEXT,                          -- 理由/背景 (例: 高血圧・健診レッド)
    method TEXT,                          -- 指導方法 (面談/口頭/文書/電話 等)
    content TEXT NOT NULL,                -- 指導内容
    consent_status TEXT NOT NULL DEFAULT 'pending',  -- pending / agreed / refused
    consent_at TEXT,
    consent_by TEXT,                      -- 承諾を記録した主体 (本人 or 代理記録した運管)
    consent_method TEXT,                  -- 'self'(本人アプリ) / 'proxy'(対面代理記録)
    consent_note TEXT,
    ban_flag INTEGER NOT NULL DEFAULT 0,  -- 乗務禁止フラグ
    ban_from TEXT,                        -- 乗務禁止 開始日 YYYY-MM-DD
    ban_until TEXT,                       -- 乗務禁止 終了日 YYYY-MM-DD (NULL=無期限)
    ban_lifted_at TEXT,                   -- 解除日時
    ban_lifted_by TEXT,
    ban_lift_note TEXT,                   -- 解除の理由・根拠 (2026-08-05)
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT,
    deleted_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_dg_driver ON driver_guidance(driver_id, guided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dg_ban ON driver_guidance(ban_flag, ban_from, ban_until);`);
} catch (e) { console.warn('[driver_guidance ensure]', e.message); }
// 2026-08-05: 解除の理由・根拠を残せるようにする。
//  ⚠️従来は解除が「誰が・いつ」しか残らず、なぜ乗務可能と判断したかが証跡に無かった。
//  ⚠️CREATE TABLE IF NOT EXISTS では既存DBに列が増えないので ALTER が要る(2回目以降は例外で無視)。
try { getDb().exec('ALTER TABLE driver_guidance ADD COLUMN ban_lift_note TEXT'); } catch (e) { /* 既にあれば無視 */ }

// JST(+9h)基準の当日 YYYY-MM-DD
const jstDate = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function getUser(uid) {
  return getDb().prepare(`SELECT id, display_name, nickname, company_code, role, employee_type,
    is_manager, is_ops_manager, is_branch_head, job_role FROM users WHERE id = ?`).get(uid);
}
function isHQ(u) { return !!(u && (u.role === 'admin' || u.employee_type === 'admin')); }
// 指導できる=運行管理者/所長/管理職/HQ
function isManager(u) {
  return !!(u && (isHQ(u) || u.is_manager || u.is_ops_manager || u.is_branch_head || u.job_role === 'manager'));
}
// 対象ドライバーが閲覧/指導スコープ内か (HQは全拠点、それ以外は自拠点のみ)
function inScope(me, target) {
  if (!target) return false;
  if (isHQ(me)) return true;
  return String(target.company_code || '') === String(me.company_code || '');
}
// 指定日にアクティブな乗務禁止か
function isBanActive(r, d) {
  return !!(r.ban_flag && !r.ban_lifted_at && !r.deleted_at
    && (!r.ban_from || r.ban_from <= d) && (!r.ban_until || r.ban_until >= d));
}
// 指導行に指導者名/対象名等を付与
function decorate(db, rows) {
  const ids = new Set();
  rows.forEach(r => { [r.guided_by, r.driver_id, r.ban_lifted_by, r.consent_by].forEach(x => { if (x) ids.add(x); }); });
  const map = {};
  const arr = [...ids];
  if (arr.length) {
    const ph = arr.map(() => '?').join(',');
    db.prepare(`SELECT id, display_name FROM users WHERE id IN (${ph})`).all(...arr)
      .forEach(u => { map[u.id] = u.display_name; });
  }
  const d = jstDate();
  return rows.map(r => ({
    id: r.id, driver_id: r.driver_id, driver_name: map[r.driver_id] || '(不明)',
    guided_by: r.guided_by, guided_by_name: map[r.guided_by] || '(不明)',
    company_code: r.company_code, guided_at: r.guided_at,
    reason: r.reason, method: r.method, content: r.content,
    consent_status: r.consent_status, consent_at: r.consent_at,
    consent_method: r.consent_method, consent_note: r.consent_note,
    consent_by_name: r.consent_by ? (map[r.consent_by] || '') : null,
    ban_flag: r.ban_flag, ban_from: r.ban_from, ban_until: r.ban_until,
    ban_lifted_at: r.ban_lifted_at, ban_lifted_by_name: r.ban_lifted_by ? (map[r.ban_lifted_by] || '') : null,
    ban_lift_note: r.ban_lift_note,
    ban_active: isBanActive(r, d),
  }));
}

// ============================ 管理者用 ============================

// 対象ドライバーの指導履歴一覧
router.get('/', authUser, (req, res) => {
  const db = getDb();
  const me = getUser(req.uid);
  if (!isManager(me)) return res.status(403).json({ success: false, msg: '管理者のみ閲覧できます' });
  const driverId = String(req.query.driver_id || '');
  if (!driverId) return res.status(400).json({ success: false, msg: 'driver_id が必要です' });
  const driver = db.prepare('SELECT id, display_name, company_code FROM users WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ success: false, msg: 'ドライバーが見つかりません' });
  if (!inScope(me, driver)) return res.status(403).json({ success: false, msg: '権限外の拠点です' });
  const rows = db.prepare(`SELECT * FROM driver_guidance WHERE driver_id = ? AND deleted_at IS NULL
    ORDER BY guided_at DESC, id DESC`).all(driverId);
  res.json({ success: true, driver: { id: driver.id, name: driver.display_name, company_code: driver.company_code }, items: decorate(db, rows) });
});

// 概況: 乗務禁止中 / 承諾待ち / 最近の指導 / ドライバー選択用ロスター
router.get('/overview', authUser, (req, res) => {
  const db = getDb();
  const me = getUser(req.uid);
  if (!isManager(me)) return res.status(403).json({ success: false, msg: '管理者のみ閲覧できます' });
  const hq = isHQ(me);
  const co = hq ? String(req.query.co || '') : (me.company_code || '');
  const useCo = !(hq && !co);
  const coSql = useCo ? ' AND company_code = ?' : '';
  const coArg = useCo ? [co] : [];
  const d = jstDate();

  // 発効中 + 発効前(予定)の乗務禁止を返す(終了済み=ban_until<今日 は除外)。ban_active で発効/予定を判別。
  const bansRaw = db.prepare(`SELECT * FROM driver_guidance WHERE deleted_at IS NULL AND ban_flag=1 AND ban_lifted_at IS NULL
    AND (ban_until IS NULL OR ban_until >= ?)${coSql}
    ORDER BY ban_from DESC, id DESC`).all(d, ...coArg);
  const bans = decorate(db, bansRaw).sort((a, b) => (b.ban_active - a.ban_active));  // 発効中を先頭に
  const pending = db.prepare(`SELECT * FROM driver_guidance WHERE deleted_at IS NULL AND consent_status='pending'${coSql}
    ORDER BY guided_at DESC, id DESC LIMIT 100`).all(...coArg);
  const recent = db.prepare(`SELECT * FROM driver_guidance WHERE deleted_at IS NULL${coSql}
    ORDER BY guided_at DESC, id DESC LIMIT 50`).all(...coArg);

  const rosterSql = `SELECT id, display_name, company_code, job_role FROM users
    WHERE COALESCE(role,'')<>'bot' AND COALESCE(employee_type,'')<>'bot' AND id NOT LIKE 'bot_%'
      AND COALESCE(is_guest_reviewer,0)=0${coSql}
    ORDER BY ${useCo ? 'display_name' : 'company_code, display_name'}`;
  const roster = db.prepare(rosterSql).all(...coArg);

  const companies = hq
    ? db.prepare(`SELECT DISTINCT company_code FROM users WHERE COALESCE(role,'')<>'bot' AND company_code IS NOT NULL AND company_code<>'' ORDER BY company_code`).all().map(x => x.company_code)
    : [me.company_code];

  res.json({ success: true, hq, co, date: d, companies, roster,
    bans, pending: decorate(db, pending), recent: decorate(db, recent) });
});

// 点呼画面バッジ用: 指定日にアクティブな乗務禁止マップ(軽量)
router.get('/bans', authUser, (req, res) => {
  const db = getDb();
  const me = getUser(req.uid);
  if (!isManager(me)) return res.status(403).json({ success: false, msg: '管理者のみ' });
  const hq = isHQ(me);
  const co = hq ? String(req.query.co || '') : (me.company_code || '');
  const useCo = !(hq && !co);
  const coSql = useCo ? ' AND company_code = ?' : '';
  const coArg = useCo ? [co] : [];
  const d = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : jstDate();
  const rows = db.prepare(`SELECT driver_id, reason, ban_from, ban_until FROM driver_guidance
    WHERE deleted_at IS NULL AND ban_flag=1 AND ban_lifted_at IS NULL
    AND (ban_from IS NULL OR ban_from <= ?) AND (ban_until IS NULL OR ban_until >= ?)${coSql}`).all(d, d, ...coArg);
  const map = {};
  rows.forEach(r => { map[r.driver_id] = { reason: r.reason || '', from: r.ban_from || '', until: r.ban_until || '' }; });
  res.json({ success: true, date: d, bans: map });
});

// 指導を記録
router.post('/', authUser, express.json(), (req, res) => {
  const db = getDb();
  const me = getUser(req.uid);
  if (!isManager(me)) return res.status(403).json({ success: false, msg: '管理者のみ記録できます' });
  const b = req.body || {};
  const driverId = String(b.driver_id || '');
  const driver = db.prepare('SELECT id, display_name, company_code FROM users WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ success: false, msg: 'ドライバーが見つかりません' });
  if (!inScope(me, driver)) return res.status(403).json({ success: false, msg: '権限外の拠点です' });
  const content = String(b.content || '').trim();
  if (!content) return res.status(400).json({ success: false, msg: '指導内容を入力してください' });
  const reason = String(b.reason || '').trim() || null;
  const method = String(b.method || '').trim() || null;

  // 乗務禁止
  const banFlag = b.ban_flag ? 1 : 0;
  let banFrom = null, banUntil = null;
  if (banFlag) {
    banFrom = /^\d{4}-\d{2}-\d{2}$/.test(b.ban_from || '') ? b.ban_from : jstDate();
    banUntil = /^\d{4}-\d{2}-\d{2}$/.test(b.ban_until || '') ? b.ban_until : null;
    if (banUntil && banUntil < banFrom) return res.status(400).json({ success: false, msg: '乗務禁止の終了日が開始日より前です' });
  }
  // 承諾(対面でその場で得た場合のみ代理記録。既定は pending=本人がアプリで承諾)
  let consentStatus = 'pending', consentBy = null, consentMethod = null, consentNote = null;
  const c = b.consent || {};
  if (c.status === 'agreed' || c.status === 'refused') {
    consentStatus = c.status; consentBy = me.id; consentMethod = 'proxy'; consentNote = String(c.note || '').trim() || null;
  }

  const info = db.prepare(`INSERT INTO driver_guidance
    (driver_id, guided_by, company_code, reason, method, content, ban_flag, ban_from, ban_until,
     consent_status, consent_by, consent_method, consent_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(driverId, me.id, driver.company_code || null, reason, method, content, banFlag, banFrom, banUntil,
      consentStatus, consentBy, consentMethod, consentNote);
  if (consentStatus !== 'pending') {
    db.prepare(`UPDATE driver_guidance SET consent_at=datetime('now','localtime') WHERE id=?`).run(info.lastInsertRowid);
  }
  const row = db.prepare('SELECT * FROM driver_guidance WHERE id = ?').get(info.lastInsertRowid);
  res.json({ success: true, item: decorate(db, [row])[0] });
});

// 乗務禁止を解除
router.post('/:id/lift-ban', authUser, express.json(), (req, res) => {
  const db = getDb();
  const me = getUser(req.uid);
  if (!isManager(me)) return res.status(403).json({ success: false, msg: '管理者のみ' });
  const row = db.prepare('SELECT * FROM driver_guidance WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!inScope(me, { company_code: row.company_code })) return res.status(403).json({ success: false, msg: '権限外の拠点です' });
  if (!row.ban_flag || row.ban_lifted_at) return res.json({ success: true, already: true });
  // ⚠️解除の根拠は必須。健康起因の乗務制限は、かけた理由と同じくらい外した理由が問われる。
  const note = String((req.body || {}).note || '').trim();
  if (!note) return res.status(400).json({ success: false, msg: '解除の理由・根拠を入力してください' });
  db.prepare(`UPDATE driver_guidance SET ban_lifted_at=datetime('now','localtime'), ban_lifted_by=?,
    ban_lift_note=?, updated_at=datetime('now','localtime') WHERE id=?`).run(me.id, note, row.id);
  res.json({ success: true });
});

// 承諾を代理記録(対面で承諾/拒否を得た場合)
router.post('/:id/consent-proxy', authUser, express.json(), (req, res) => {
  const db = getDb();
  const me = getUser(req.uid);
  if (!isManager(me)) return res.status(403).json({ success: false, msg: '管理者のみ' });
  const status = String((req.body || {}).status || '');
  if (status !== 'agreed' && status !== 'refused') return res.status(400).json({ success: false, msg: 'status不正' });
  const row = db.prepare('SELECT * FROM driver_guidance WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!inScope(me, { company_code: row.company_code })) return res.status(403).json({ success: false, msg: '権限外の拠点です' });
  db.prepare(`UPDATE driver_guidance SET consent_status=?, consent_at=datetime('now','localtime'),
    consent_by=?, consent_method='proxy', consent_note=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(status, me.id, String((req.body || {}).note || '').trim() || null, row.id);
  res.json({ success: true });
});

// 指導の訂正(内容/理由/方法/禁止終了日)
router.patch('/:id', authUser, express.json(), (req, res) => {
  const db = getDb();
  const me = getUser(req.uid);
  if (!isManager(me)) return res.status(403).json({ success: false, msg: '管理者のみ' });
  const row = db.prepare('SELECT * FROM driver_guidance WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!inScope(me, { company_code: row.company_code })) return res.status(403).json({ success: false, msg: '権限外の拠点です' });
  const b = req.body || {};
  const sets = [], args = [];
  if (typeof b.content === 'string' && b.content.trim()) { sets.push('content=?'); args.push(b.content.trim()); }
  if (typeof b.reason === 'string') { sets.push('reason=?'); args.push(b.reason.trim() || null); }
  if (typeof b.method === 'string') { sets.push('method=?'); args.push(b.method.trim() || null); }
  if (typeof b.ban_until === 'string') {
    const bu = /^\d{4}-\d{2}-\d{2}$/.test(b.ban_until) ? b.ban_until : null;
    if (bu && row.ban_from && bu < row.ban_from) return res.status(400).json({ success: false, msg: '終了日が開始日より前です' });
    sets.push('ban_until=?'); args.push(bu);
  }
  if (!sets.length) return res.json({ success: true, nochange: true });
  sets.push("updated_at=datetime('now','localtime')");
  db.prepare(`UPDATE driver_guidance SET ${sets.join(', ')} WHERE id=?`).run(...args, row.id);
  res.json({ success: true });
});

// 指導の削除(誤登録の取り消し・論理削除)
router.delete('/:id', authUser, (req, res) => {
  const db = getDb();
  const me = getUser(req.uid);
  if (!isManager(me)) return res.status(403).json({ success: false, msg: '管理者のみ' });
  const row = db.prepare('SELECT * FROM driver_guidance WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!inScope(me, { company_code: row.company_code })) return res.status(403).json({ success: false, msg: '権限外の拠点です' });
  db.prepare(`UPDATE driver_guidance SET deleted_at=datetime('now','localtime') WHERE id=?`).run(row.id);
  res.json({ success: true });
});

// ============================ 本人(ドライバー)用 ============================

// 自分宛の指導(承諾待ち含む)
router.get('/mine', authUser, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM driver_guidance WHERE driver_id = ? AND deleted_at IS NULL
    ORDER BY guided_at DESC, id DESC LIMIT 50`).all(req.uid);
  const items = decorate(db, rows);
  res.json({ success: true, items, pending_count: items.filter(r => r.consent_status === 'pending').length });
});

// 本人が承諾する / 承諾しない
router.post('/:id/consent', authUser, express.json(), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM driver_guidance WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (row.driver_id !== req.uid) return res.status(403).json({ success: false, msg: '本人のみ承諾できます' });
  if (row.consent_status !== 'pending') return res.json({ success: true, already: true, status: row.consent_status });
  const agree = (req.body || {}).agree !== false;   // 既定=承諾
  db.prepare(`UPDATE driver_guidance SET consent_status=?, consent_at=datetime('now','localtime'),
    consent_by=?, consent_method='self', updated_at=datetime('now','localtime') WHERE id=?`)
    .run(agree ? 'agreed' : 'refused', req.uid, row.id);
  res.json({ success: true, status: agree ? 'agreed' : 'refused' });
});

module.exports = router;
