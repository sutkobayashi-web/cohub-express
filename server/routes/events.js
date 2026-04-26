const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

function canManage(uid) {
  const u = getDb().prepare('SELECT employee_type, role FROM users WHERE id = ?').get(uid);
  return !!(u && (u.employee_type === 'admin' || u.role === 'admin'));
}

// 開催中のイベント一覧
router.get('/', authUser, (req, res) => {
  const rows = getDb().prepare(`SELECT * FROM events
    WHERE deleted_at IS NULL
      AND (start_date IS NULL OR start_date <= date('now'))
      AND (end_date IS NULL OR end_date >= date('now'))
    ORDER BY sort_order DESC, id DESC`).all();
  res.json({ success: true, events: rows });
});

// 全件 (管理者向け、終了済も含む)
router.get('/all', authUser, (req, res) => {
  if (!canManage(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const rows = getDb().prepare(`SELECT * FROM events WHERE deleted_at IS NULL ORDER BY id DESC`).all();
  res.json({ success: true, events: rows });
});

// 新規 (管理職)
router.post('/', authUser, express.json(), (req, res) => {
  if (!canManage(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ' });
  const b = req.body || {};
  const title = String(b.title || '').slice(0, 200).trim();
  if (!title) return res.status(400).json({ success: false, msg: 'タイトル必須' });
  const ins = getDb().prepare(`INSERT INTO events (title, description, icon, url, is_external, start_date, end_date, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    title,
    String(b.description || '').slice(0, 1000),
    String(b.icon || '🎉').slice(0, 8),
    String(b.url || '').slice(0, 500) || null,
    b.is_external ? 1 : 0,
    b.start_date || null,
    b.end_date || null,
    parseInt(b.sort_order) || 0
  );
  res.json({ success: true, id: ins.lastInsertRowid });
});

router.put('/:id', authUser, express.json(), (req, res) => {
  if (!canManage(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ' });
  const id = parseInt(req.params.id);
  const b = req.body || {};
  const fields = []; const params = [];
  for (const k of ['title', 'description', 'icon', 'url', 'is_external', 'start_date', 'end_date', 'sort_order']) {
    if (b[k] !== undefined) {
      fields.push(`${k} = ?`);
      params.push(k === 'is_external' ? (b[k] ? 1 : 0) : (k === 'sort_order' ? parseInt(b[k]) || 0 : b[k] || null));
    }
  }
  if (!fields.length) return res.json({ success: true, msg: '変更なし' });
  params.push(id);
  getDb().prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

router.delete('/:id', authUser, (req, res) => {
  if (!canManage(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ' });
  const id = parseInt(req.params.id);
  getDb().prepare("UPDATE events SET deleted_at = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
});

module.exports = router;
