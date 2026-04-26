// チャレンジ管理 + KPI 記録 (CoWell移植 minimum viable)
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const STATUSES = ['draft', 'active', 'closed'];

function isManager(uid) {
  const u = getDb().prepare('SELECT employee_type, role, is_field_promoter FROM users WHERE id = ?').get(uid);
  return !!(u && (u.employee_type === 'admin' || u.role === 'admin' || u.is_field_promoter));
}

// チャレンジ一覧
router.get('/', authUser, (req, res) => {
  const status = req.query.status;
  const db = getDb();
  let sql = `SELECT c.*,
    (SELECT COUNT(*) FROM challenge_participants WHERE challenge_id = c.id) AS participant_count,
    (SELECT COUNT(*) FROM challenge_participants WHERE challenge_id = c.id AND user_id = ?) AS i_joined
    FROM challenges c WHERE c.deleted_at IS NULL`;
  const params = [req.uid];
  if (status && STATUSES.includes(status)) { sql += ' AND c.status = ?'; params.push(status); }
  sql += ' ORDER BY c.id DESC LIMIT 100';
  res.json({ success: true, challenges: db.prepare(sql).all(...params) });
});

// 詳細 (KPI集計付き)
router.get('/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const c = db.prepare(`SELECT c.*,
    (SELECT COUNT(*) FROM challenge_participants WHERE challenge_id = c.id) AS participant_count,
    (SELECT COUNT(*) FROM challenge_participants WHERE challenge_id = c.id AND user_id = ?) AS i_joined
    FROM challenges c WHERE c.id = ? AND c.deleted_at IS NULL`).get(req.uid, id);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  // 直近30日のKPI集計
  const records = db.prepare(`SELECT user_id, record_date, kpi_values AS values FROM kpi_records WHERE challenge_id = ? ORDER BY record_date DESC LIMIT 1000`).all(id);
  res.json({ success: true, challenge: c, records });
});

// 作成 (管理職/推進)
router.post('/', authUser, express.json(), (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const b = req.body || {};
  const title = String(b.title || '').slice(0, 200).trim();
  if (!title) return res.status(400).json({ success: false, msg: 'タイトル必須' });
  const kpiItems = Array.isArray(b.kpi_items) ? b.kpi_items : [];
  const ins = getDb().prepare(`INSERT INTO challenges (theme_id, title, description, icon, period_start, period_end, kpi_items, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    b.theme_id || null, title,
    String(b.description || '').slice(0, 1000),
    String(b.icon || '💪').slice(0, 8),
    b.period_start || null, b.period_end || null,
    JSON.stringify(kpiItems), STATUSES.includes(b.status) ? b.status : 'draft', req.uid
  );
  res.json({ success: true, id: ins.lastInsertRowid });
});

// 更新
router.put('/:id', authUser, express.json(), (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const b = req.body || {};
  const fields = []; const params = [];
  if (b.title !== undefined) { fields.push('title = ?'); params.push(String(b.title).slice(0, 200)); }
  if (b.description !== undefined) { fields.push('description = ?'); params.push(String(b.description).slice(0, 1000)); }
  if (b.icon !== undefined) { fields.push('icon = ?'); params.push(String(b.icon).slice(0, 8)); }
  if (b.period_start !== undefined) { fields.push('period_start = ?'); params.push(b.period_start || null); }
  if (b.period_end !== undefined) { fields.push('period_end = ?'); params.push(b.period_end || null); }
  if (b.kpi_items !== undefined) { fields.push('kpi_items = ?'); params.push(JSON.stringify(b.kpi_items || [])); }
  if (b.status !== undefined && STATUSES.includes(b.status)) { fields.push('status = ?'); params.push(b.status); }
  if (!fields.length) return res.json({ success: true, msg: '変更なし' });
  params.push(id);
  getDb().prepare(`UPDATE challenges SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// 削除
router.delete('/:id', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  getDb().prepare("UPDATE challenges SET deleted_at = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
});

// 参加
router.post('/:id/join', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const c = db.prepare('SELECT id, status FROM challenges WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (c.status !== 'active') return res.status(400).json({ success: false, msg: '開催中のチャレンジのみ参加可' });
  db.prepare('INSERT OR IGNORE INTO challenge_participants (challenge_id, user_id) VALUES (?, ?)').run(id, req.uid);
  res.json({ success: true });
});

router.post('/:id/leave', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  getDb().prepare('DELETE FROM challenge_participants WHERE challenge_id = ? AND user_id = ?').run(id, req.uid);
  res.json({ success: true });
});

// KPI記録投稿
router.post('/:id/kpi', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const c = db.prepare('SELECT id, status FROM challenges WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  // 参加者チェック (自動参加)
  db.prepare('INSERT OR IGNORE INTO challenge_participants (challenge_id, user_id) VALUES (?, ?)').run(id, req.uid);
  const b = req.body || {};
  const date = String(b.record_date || new Date().toISOString().slice(0, 10));
  const values = (b.values && typeof b.values === 'object') ? b.values : {};
  const comment = String(b.comment || '').slice(0, 500);
  db.prepare(`INSERT INTO kpi_records (challenge_id, user_id, record_date, kpi_values, comment)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(challenge_id, user_id, record_date) DO UPDATE SET kpi_values=excluded.kpi_values, comment=excluded.comment`)
    .run(id, req.uid, date, JSON.stringify(values), comment);
  res.json({ success: true });
});

// 自分のKPI記録
router.get('/:id/my-kpi', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const rows = getDb().prepare(`SELECT record_date, kpi_values AS values, comment, created_at FROM kpi_records
    WHERE challenge_id = ? AND user_id = ? ORDER BY record_date DESC LIMIT 60`).all(id, req.uid);
  res.json({ success: true, records: rows });
});

// 全体ダッシュボード (管理職/推進)
router.get('/:id/dashboard', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const c = db.prepare('SELECT * FROM challenges WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  const participants = db.prepare(`SELECT cp.user_id, u.display_name, u.company_code,
    (SELECT COUNT(*) FROM kpi_records WHERE challenge_id = cp.challenge_id AND user_id = cp.user_id) AS record_count,
    (SELECT MAX(record_date) FROM kpi_records WHERE challenge_id = cp.challenge_id AND user_id = cp.user_id) AS last_record_date
    FROM challenge_participants cp LEFT JOIN users u ON u.id = cp.user_id
    WHERE cp.challenge_id = ? ORDER BY u.display_name`).all(id);
  const records = db.prepare(`SELECT user_id, record_date, kpi_values AS values FROM kpi_records WHERE challenge_id = ? ORDER BY record_date`).all(id);
  res.json({ success: true, challenge: c, participants, records });
});

module.exports = router;
