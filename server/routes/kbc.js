// 関東BC関連API (2026-04-28 CoLink吸収)
// 日報・クレーム・BC報告・改善施策の4機能を統合
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

function isManager(uid) {
  const r = getDb().prepare('SELECT employee_type, role FROM users WHERE id = ?').get(uid);
  return !!(r && (r.employee_type === 'admin' || r.role === 'admin'));
}

router.post('/_debug', authUser, express.json({ limit: '32kb' }), (req, res) => {
  try {
    const b = req.body || {};
    console.log('[kbc][_debug]', JSON.stringify({ uid: req.uid, ...b }).slice(0, 2000));
  } catch (e) {}
  res.json({ ok: true });
});

// ============================================================
// 日報 (kbc_daily_reports) — 1464件のXLS履歴を含む
// ============================================================
// 直前の日報 (本人 or 指定担当者の最新1件、新規入力のデフォルト値用)
router.get('/daily/last', authUser, (req, res) => {
  const userName = String(req.query.user_name || '').trim();
  const db = getDb();
  const row = userName
    ? db.prepare('SELECT * FROM kbc_daily_reports WHERE user_name = ? ORDER BY report_date DESC, id DESC LIMIT 1').get(userName)
    : db.prepare('SELECT * FROM kbc_daily_reports ORDER BY report_date DESC, id DESC LIMIT 1').get();
  res.json({ success: true, report: row || null });
});

// 月別件数 (タブ切替用)
router.get('/daily/months', authUser, (req, res) => {
  const rows = getDb().prepare(`SELECT substr(report_date, 1, 7) AS month, COUNT(*) AS cnt
                                FROM kbc_daily_reports GROUP BY month ORDER BY month DESC LIMIT 60`).all();
  res.json({ success: true, months: rows });
});

// 月別一覧
router.get('/daily', authUser, (req, res) => {
  const month = String(req.query.month || '').slice(0, 7);
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const db = getDb();
  let sql = `SELECT * FROM kbc_daily_reports`;
  const params = [];
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    sql += ` WHERE substr(report_date, 1, 7) = ?`;
    params.push(month);
  }
  sql += ` ORDER BY report_date DESC, id DESC LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  // 集計 (当月)
  const totals = month
    ? db.prepare(`SELECT COUNT(*) AS days, SUM(shipping_total) AS shipping, SUM(inbound_total) AS inbound,
                         SUM(outbound_total) AS outbound, AVG(workers) AS avg_workers
                  FROM kbc_daily_reports WHERE substr(report_date, 1, 7) = ?`).get(month)
    : null;
  res.json({ success: true, reports: rows, totals });
});

router.get('/daily/:id', authUser, (req, res) => {
  const r = getDb().prepare('SELECT * FROM kbc_daily_reports WHERE id = ?').get(parseInt(req.params.id));
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  res.json({ success: true, report: r });
});

router.post('/daily', authUser, express.json(), (req, res) => {
  const b = req.body || {};
  console.log('[kbc][debug] POST /daily uid=', req.uid, 'user_name=', b.user_name, 'date=', b.report_date, 'bodyKeys=', Object.keys(b||{}).join(','));
  if (!b.report_date) { console.log('[kbc][debug] 400 日付必須'); return res.status(400).json({ success: false, msg: '日付必須' }); }
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const userName = b.user_name || (u && u.display_name) || '不明';
  try {
    const ins = getDb().prepare(`INSERT INTO kbc_daily_reports
      (user_name, report_date, start_time, end_time, break_minutes, staff, temp_workers, part_workers,
       workers, shipping_total, memo,
       floor_1f_in, floor_1f_out, floor_2f_in, floor_2f_out, floor_3f_in, floor_3f_out,
       floor_4f_in, floor_4f_out, floor_5f_in, floor_5f_out,
       inbound_total, outbound_total)
      VALUES (?,?,?,?,?, ?,?,?, ?,?,?,
              ?,?,?,?,?,?, ?,?,?,?,
              ?,?)`).run(
      userName, b.report_date, b.start_time || null, b.end_time || null, b.break_minutes || 60,
      b.staff || 0, b.temp_workers || 0, b.part_workers || 0,
      b.workers || 0, b.shipping_total || 0, b.memo || '',
      b.floor_1f_in || 0, b.floor_1f_out || 0, b.floor_2f_in || 0, b.floor_2f_out || 0,
      b.floor_3f_in || 0, b.floor_3f_out || 0, b.floor_4f_in || 0, b.floor_4f_out || 0,
      b.floor_5f_in || 0, b.floor_5f_out || 0,
      b.inbound_total || 0, b.outbound_total || 0);
    res.json({ success: true, id: ins.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ success: false, msg: 'その日付は既に登録されています' });
    throw e;
  }
});

router.put('/daily/:id', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  console.log('[kbc][debug] PUT /daily/:id uid=', req.uid, 'id=', id, 'bodyKeys=', Object.keys(req.body||{}).join(','));
  const r = getDb().prepare('SELECT id FROM kbc_daily_reports WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const b = req.body || {};
  const editable = ['start_time','end_time','break_minutes','staff','temp_workers','part_workers',
    'workers','shipping_total','memo',
    'floor_1f_in','floor_1f_out','floor_2f_in','floor_2f_out','floor_3f_in','floor_3f_out',
    'floor_4f_in','floor_4f_out','floor_5f_in','floor_5f_out','inbound_total','outbound_total'];
  const updates = [];
  const params = [];
  for (const k of editable) if (b[k] !== undefined) { updates.push(`${k} = ?`); params.push(b[k]); }
  if (!updates.length) return res.json({ success: true });
  params.push(id);
  getDb().prepare(`UPDATE kbc_daily_reports SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

router.delete('/daily/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const r = getDb().prepare('SELECT user_name FROM kbc_daily_reports WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const isOwn = u && r.user_name === u.display_name;
  if (!isManager(req.uid) && !isOwn) return res.status(403).json({ success: false, msg: '本人または管理職のみ削除可' });
  getDb().prepare('DELETE FROM kbc_daily_reports WHERE id = ?').run(id);
  res.json({ success: true });
});

// ============================================================
// クレーム (kbc_claims)
// ============================================================
router.get('/claims', authUser, (req, res) => {
  const month = req.query.month;
  const db = getDb();
  let sql = `SELECT * FROM kbc_claims`;
  const params = [];
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    sql += ` WHERE claim_month = ?`;
    params.push(month);
  }
  sql += ` ORDER BY claim_month DESC, id DESC LIMIT 500`;
  const rows = db.prepare(sql).all(...params);
  // 月別集計
  const byMonth = db.prepare(`SELECT claim_month, COUNT(*) AS cnt, SUM(amount) AS total_amount
                              FROM kbc_claims GROUP BY claim_month ORDER BY claim_month DESC LIMIT 24`).all();
  res.json({ success: true, claims: rows, byMonth });
});

router.post('/claims', authUser, express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.claim_month || !b.product_category) return res.status(400).json({ success: false, msg: '月と商品カテゴリ必須' });
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const ins = getDb().prepare(`INSERT INTO kbc_claims
    (claim_month, product_category, product_name, quantity, amount, area, cause, reporter, memo)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    b.claim_month, b.product_category, b.product_name || null,
    b.quantity || 1, b.amount || 0, b.area || null, b.cause || null,
    b.reporter || (u && u.display_name) || '', b.memo || '');
  res.json({ success: true, id: ins.lastInsertRowid });
});

router.put('/claims/:id', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const b = req.body || {};
  const editable = ['claim_month','product_category','product_name','quantity','amount','area','cause','reporter','memo'];
  const updates = [];
  const params = [];
  for (const k of editable) if (b[k] !== undefined) { updates.push(`${k} = ?`); params.push(b[k]); }
  if (!updates.length) return res.json({ success: true });
  params.push(id);
  getDb().prepare(`UPDATE kbc_claims SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

router.delete('/claims/:id', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ削除可' });
  getDb().prepare('DELETE FROM kbc_claims WHERE id = ?').run(parseInt(req.params.id));
  res.json({ success: true });
});

// ============================================================
// BC報告 (kbc_bc_reports) — 荷主向け事故報告
// ============================================================
router.get('/bc-reports', authUser, (req, res) => {
  const status = req.query.status;
  const db = getDb();
  let sql = `SELECT * FROM kbc_bc_reports`;
  const params = [];
  if (status) { sql += ` WHERE status = ?`; params.push(status); }
  sql += ` ORDER BY created_at DESC LIMIT 200`;
  res.json({ success: true, reports: db.prepare(sql).all(...params) });
});

router.post('/bc-reports', authUser, express.json(), (req, res) => {
  const b = req.body || {};
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const ins = getDb().prepare(`INSERT INTO kbc_bc_reports
    (source_report_id, report_type, occurrence_time, location, product_code, product_name,
     quantity, damaged_item, cause, damage_detail, action_taken, prevention,
     inspection_code, inspection_name, inspection_qty, inspection_detail, inspection_result,
     reporter, status)
    VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?)`).run(
    b.source_report_id || null, b.report_type || '破損', b.occurrence_time || null,
    b.location || null, b.product_code || null, b.product_name || null,
    b.quantity || 1, b.damaged_item || null, b.cause || null, b.damage_detail || null,
    b.action_taken || null, b.prevention || null,
    b.inspection_code || null, b.inspection_name || null, b.inspection_qty || 1,
    b.inspection_detail || null, b.inspection_result || null,
    b.reporter || (u && u.display_name) || '', b.status || 'new');
  res.json({ success: true, id: ins.lastInsertRowid });
});

router.put('/bc-reports/:id', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const b = req.body || {};
  const editable = ['report_type','occurrence_time','location','product_code','product_name',
    'quantity','damaged_item','cause','damage_detail','action_taken','prevention',
    'inspection_code','inspection_name','inspection_qty','inspection_detail','inspection_result',
    'reporter','status','client_comment'];
  const updates = [];
  const params = [];
  for (const k of editable) if (b[k] !== undefined) { updates.push(`${k} = ?`); params.push(b[k]); }
  if (b.status === 'confirmed' && b.confirmed_by !== undefined) {
    updates.push("confirmed_at = datetime('now','localtime')");
    updates.push('confirmed_by = ?'); params.push(b.confirmed_by);
  }
  if (!updates.length) return res.json({ success: true });
  params.push(id);
  getDb().prepare(`UPDATE kbc_bc_reports SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

router.delete('/bc-reports/:id', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ削除可' });
  getDb().prepare('DELETE FROM kbc_bc_reports WHERE id = ?').run(parseInt(req.params.id));
  res.json({ success: true });
});

// ============================================================
// 改善施策 (kbc_action_plans)
// ============================================================
router.get('/action-plans', authUser, (req, res) => {
  const status = req.query.status;
  const db = getDb();
  let sql = `SELECT * FROM kbc_action_plans`;
  const params = [];
  if (status) { sql += ` WHERE status = ?`; params.push(status); }
  sql += ` ORDER BY
    CASE priority WHEN '高' THEN 1 WHEN '中' THEN 2 WHEN '低' THEN 3 ELSE 4 END,
    deadline, id DESC LIMIT 200`;
  res.json({ success: true, plans: db.prepare(sql).all(...params) });
});

router.post('/action-plans', authUser, express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.issue) return res.status(400).json({ success: false, msg: '課題内容必須' });
  const ins = getDb().prepare(`INSERT INTO kbc_action_plans
    (priority, category, issue, action, person, deadline, status)
    VALUES (?,?,?,?,?,?,?)`).run(
    b.priority || '中', b.category || null, b.issue, b.action || null,
    b.person || null, b.deadline || null, b.status || '未着手');
  res.json({ success: true, id: ins.lastInsertRowid });
});

router.put('/action-plans/:id', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const b = req.body || {};
  const editable = ['priority','category','issue','action','person','deadline','status'];
  const updates = [];
  const params = [];
  for (const k of editable) if (b[k] !== undefined) { updates.push(`${k} = ?`); params.push(b[k]); }
  if (!updates.length) return res.json({ success: true });
  params.push(id);
  getDb().prepare(`UPDATE kbc_action_plans SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

router.delete('/action-plans/:id', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ削除可' });
  getDb().prepare('DELETE FROM kbc_action_plans WHERE id = ?').run(parseInt(req.params.id));
  res.json({ success: true });
});

module.exports = router;
