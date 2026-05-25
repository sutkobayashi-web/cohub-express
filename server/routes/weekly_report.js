// 業務週報 (2026-05-25): 営業所責任者向け。提出・閲覧とも管理職(is_manager)のみ。
// 編集・削除は作成者本人 または role=admin。売上は手入力(予算比はフロントで自動算出)。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

function requireManager(req, res, next) {
  const u = getDb().prepare('SELECT is_manager, role, display_name FROM users WHERE id = ?').get(req.uid);
  if (!u || !u.is_manager) {
    return res.status(403).json({ success: false, msg: 'この機能は管理職以上のみ利用できます' });
  }
  req._me = u;
  next();
}
function clampStr(v, n) { return v == null ? null : String(v).slice(0, n); }
function toInt(v) { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return isNaN(n) ? null : n; }
function toNum(v) { if (v === '' || v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n; }

router.get('/access', authUser, (req, res) => {
  const u = getDb().prepare('SELECT is_manager FROM users WHERE id = ?').get(req.uid);
  res.json({ success: true, allowed: !!(u && u.is_manager) });
});

// 一覧 (新しい順)
router.get('/', authUser, requireManager, (req, res) => {
  const rows = getDb().prepare(`SELECT w.*, u.avatar_url AS created_by_avatar
    FROM weekly_reports w LEFT JOIN users u ON u.id = w.created_by
    WHERE w.deleted_at IS NULL
    ORDER BY w.report_date DESC, w.id DESC LIMIT 100`).all();
  res.json({ success: true, reports: rows });
});

// ダッシュボード集計 (月間・年間の売上進捗)。提出済み週報の手入力売上を集計。
// 集計基準日 = COALESCE(period_to, report_date)。年間は会計年度(4月開始)。
router.get('/dashboard', authUser, requireManager, (req, res) => {
  const db = getDb();
  const office = (req.query.office || '').trim();
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const pad = n => String(n).padStart(2, '0');
  const monthStart = `${y}-${pad(m)}-01`, monthEnd = `${y}-${pad(m)}-31`;
  const fyStartYear = (m >= 4) ? y : y - 1;
  const fyStart = `${fyStartYear}-04-01`, fyEnd = `${fyStartYear + 1}-03-31`;
  const agg = (from, to) => {
    let sql = `SELECT COALESCE(SUM(sales_budget),0) AS budget, COALESCE(SUM(sales_actual),0) AS actual, COUNT(*) AS n
      FROM weekly_reports WHERE deleted_at IS NULL
        AND date(COALESCE(period_to, report_date)) >= ? AND date(COALESCE(period_to, report_date)) <= ?`;
    const p = [from, to];
    if (office) { sql += ' AND office = ?'; p.push(office); }
    return db.prepare(sql).get(...p);
  };
  // 月間の運行KPI: 所属台数・休車台数の合計から稼働率/休車率を算出 + 最新の台数
  const round1 = v => v == null ? null : Math.round(v * 10) / 10;
  let kpi = {};
  try {
    let ksql = `SELECT COALESCE(SUM(fleet_count),0) AS fleet, COALESCE(SUM(idle_count),0) AS idle
      FROM weekly_reports WHERE deleted_at IS NULL
        AND date(COALESCE(period_to, report_date)) >= ? AND date(COALESCE(period_to, report_date)) <= ?`;
    const kp = [monthStart, monthEnd];
    if (office) { ksql += ' AND office = ?'; kp.push(office); }
    const k = db.prepare(ksql).get(...kp) || { fleet: 0, idle: 0 };
    // 最新提出の台数 (時点値)
    let lsql = `SELECT fleet_count, idle_count FROM weekly_reports WHERE deleted_at IS NULL AND fleet_count IS NOT NULL`;
    const lp = [];
    if (office) { lsql += ' AND office = ?'; lp.push(office); }
    lsql += ' ORDER BY COALESCE(period_to, report_date) DESC, id DESC LIMIT 1';
    const latest = db.prepare(lsql).get(...lp) || {};
    const op = k.fleet > 0 ? round1((k.fleet - k.idle) / k.fleet * 100) : null;
    const ir = k.fleet > 0 ? round1(k.idle / k.fleet * 100) : null;
    kpi = {
      operation_rate: op, idle_rate: ir,
      fleet_count: latest.fleet_count != null ? latest.fleet_count : null,
      idle_count: latest.idle_count != null ? latest.idle_count : null,
    };
  } catch (e) { kpi = {}; }
  // 営業所の選択肢 (進捗の絞り込み用)
  let offices = [];
  try { offices = db.prepare(`SELECT DISTINCT office FROM weekly_reports WHERE deleted_at IS NULL AND office IS NOT NULL AND office <> '' ORDER BY office`).all().map(r => r.office); } catch (e) {}
  res.json({
    success: true,
    month_label: `${y}年${m}月`, fy_label: `${fyStartYear}年度`,
    month: agg(monthStart, monthEnd),
    fiscal_year: agg(fyStart, fyEnd),
    month_kpi: kpi,
    offices,
  });
});

// 週次トレンド (直近12週)。予算比・売上・違反件数の推移。営業所フィルタ可。
router.get('/trend', authUser, requireManager, (req, res) => {
  const office = (req.query.office || '').trim();
  let sql = `SELECT date(COALESCE(period_to, report_date)) AS wk,
      COALESCE(SUM(sales_budget),0) AS budget, COALESCE(SUM(sales_actual),0) AS actual,
      COALESCE(SUM(violations),0) AS violations, COUNT(*) AS n
    FROM weekly_reports
    WHERE deleted_at IS NULL AND COALESCE(period_to, report_date) IS NOT NULL`;
  const p = [];
  if (office) { sql += ' AND office = ?'; p.push(office); }
  sql += ` GROUP BY wk ORDER BY wk ASC`;
  let rows = [];
  try { rows = getDb().prepare(sql).all(...p); } catch (e) { rows = []; }
  rows = rows.slice(-12);
  res.json({ success: true, trend: rows });
});

// 1件
router.get('/:id', authUser, requireManager, (req, res) => {
  const r = getDb().prepare('SELECT * FROM weekly_reports WHERE id = ? AND deleted_at IS NULL').get(parseInt(req.params.id));
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  res.json({ success: true, report: r });
});

// コメント/質問 一覧
router.get('/:id/comments', authUser, requireManager, (req, res) => {
  const rows = getDb().prepare(`SELECT c.*, u.avatar_url AS author_avatar
    FROM weekly_report_comments c LEFT JOIN users u ON u.id = c.author_id
    WHERE c.report_id = ? ORDER BY c.created_at ASC`).all(parseInt(req.params.id));
  res.json({ success: true, comments: rows });
});

// コメント/質問 投稿 → 作成者へ自動DM+プッシュ(回答はチャットで)
router.post('/:id/comments', authUser, requireManager, express.json(), (req, res) => {
  const db = getDb();
  const rid = parseInt(req.params.id);
  const rep = db.prepare('SELECT id, office, period_from, period_to, created_by FROM weekly_reports WHERE id = ? AND deleted_at IS NULL').get(rid);
  if (!rep) return res.status(404).json({ success: false, msg: '週報が見つかりません' });
  const body = (req.body && req.body.body || '').toString().trim();
  if (!body) return res.status(400).json({ success: false, msg: '内容を入力してください' });
  const ins = db.prepare('INSERT INTO weekly_report_comments (report_id, author_id, author_name, body) VALUES (?, ?, ?, ?)')
    .run(rid, req.uid, clampStr(req._me.display_name, 80), clampStr(body, 2000));
  // 作成者へ自動DM+プッシュ (自分の週報への自分のコメントは除外)
  if (rep.created_by && rep.created_by !== req.uid) {
    const sendDm = req.app && req.app.locals && req.app.locals.sendDm;
    if (sendDm) {
      const ref = `【業務週報へのコメント】${rep.office || ''}（${rep.period_from || ''}〜${rep.period_to || ''}）について、${req._me.display_name}さんから:\n\n${body}\n\n（このままチャットでご回答ください）`;
      sendDm(req.uid, rep.created_by, ref, { title: '📊 週報へのコメント・質問', url: '/chat?dm=' + req.uid });
    }
  }
  res.json({ success: true, id: ins.lastInsertRowid });
});

// 新規提出
router.post('/', authUser, requireManager, express.json(), (req, res) => {
  const b = req.body || {};
  const office = clampStr(b.office, 60);
  if (!office) return res.status(400).json({ success: false, msg: '営業所は必須です' });
  const ins = getDb().prepare(`INSERT INTO weekly_reports
    (office, report_date, period_from, period_to, issue_practical, result_practical,
     violations, finance_note, sales_budget, sales_actual,
     fleet_count, idle_count, created_by, created_by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    office,
    clampStr(b.report_date, 10),
    clampStr(b.period_from, 10),
    clampStr(b.period_to, 10),
    clampStr(b.issue_practical, 500),
    clampStr(b.result_practical, 5000),
    toInt(b.violations) || 0,
    clampStr(b.finance_note, 5000),
    toInt(b.sales_budget),
    toInt(b.sales_actual),
    toInt(b.fleet_count),
    toInt(b.idle_count),
    req.uid,
    clampStr(req._me.display_name, 80)
  );
  res.json({ success: true, id: ins.lastInsertRowid });
});

// 更新 (作成者 or admin)
router.put('/:id', authUser, requireManager, express.json(), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const r = db.prepare('SELECT created_by FROM weekly_reports WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (r.created_by !== req.uid && req._me.role !== 'admin') {
    return res.status(403).json({ success: false, msg: '編集できるのは作成者または管理者のみです' });
  }
  const b = req.body || {};
  const map = {
    office: v => clampStr(v, 60), report_date: v => clampStr(v, 10),
    period_from: v => clampStr(v, 10), period_to: v => clampStr(v, 10),
    issue_practical: v => clampStr(v, 500), result_practical: v => clampStr(v, 5000),
    violations: v => toInt(v) || 0, finance_note: v => clampStr(v, 5000),
    sales_budget: v => toInt(v), sales_actual: v => toInt(v),
    fleet_count: v => toInt(v), idle_count: v => toInt(v),
  };
  const fields = [], params = [];
  for (const k of Object.keys(map)) {
    if (b[k] !== undefined) { fields.push(`${k} = ?`); params.push(map[k](b[k])); }
  }
  if (!fields.length) return res.json({ success: true, msg: '変更なし' });
  fields.push(`updated_at = datetime('now','localtime')`);
  params.push(id);
  db.prepare('UPDATE weekly_reports SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
  res.json({ success: true });
});

// 削除 (論理削除。作成者 or admin)
router.delete('/:id', authUser, requireManager, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const r = db.prepare('SELECT created_by FROM weekly_reports WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (r.created_by !== req.uid && req._me.role !== 'admin') {
    return res.status(403).json({ success: false, msg: '削除できるのは作成者または管理者のみです' });
  }
  db.prepare(`UPDATE weekly_reports SET deleted_at = datetime('now','localtime') WHERE id = ?`).run(id);
  res.json({ success: true });
});

module.exports = router;
