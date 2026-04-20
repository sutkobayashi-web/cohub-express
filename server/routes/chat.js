const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser, authAdmin } = require('../middleware/auth');

// 自分の60日以内の会話履歴（本人のみ閲覧）
router.get('/history', authUser, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.id, m.sender_id, m.receiver_id, m.content, m.created_at,
           us.display_name AS sender_name, us.company_code AS sender_company,
           ur.display_name AS receiver_name
    FROM messages m
    LEFT JOIN users us ON us.id = m.sender_id
    LEFT JOIN users ur ON ur.id = m.receiver_id
    WHERE (m.sender_id = ? OR m.receiver_id = ? OR m.receiver_id IS NULL)
      AND m.created_at > datetime('now', '-60 days')
    ORDER BY m.created_at DESC
    LIMIT 500
  `).all(req.uid, req.uid);
  res.json({ success: true, messages: rows });
});

// 指定フロアのチャット履歴 直近100件（全ユーザー）
router.get('/recent', authUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const room = (req.query.room || 'lobby').toString();
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.id, m.sender_id, m.content, m.has_mention, m.created_at,
           u.display_name AS sender_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_code = ? AND m.created_at > datetime('now', '-60 days')
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(room, limit);
  res.json({ success: true, messages: rows.reverse() });
});

// 管理者向け全文検索（内部統制モニタリング）
router.get('/admin/search', authAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const q = (req.query.q || '').toString().trim();
  const senderId = (req.query.sender_id || '').toString().trim();
  const since = (req.query.since || '').toString().trim();
  const until = (req.query.until || '').toString().trim();
  const onlyMention = req.query.mention === '1';
  const room = (req.query.room || '').toString().trim();

  let sql = `SELECT m.id, m.sender_id, m.content, m.room_code, m.has_mention, m.created_at,
             u.display_name AS sender_name, u.login_id AS sender_login, u.company_code AS sender_company
             FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE 1=1`;
  const params = [];
  if (q) { sql += ' AND m.content LIKE ?'; params.push('%' + q + '%'); }
  if (senderId) { sql += ' AND m.sender_id = ?'; params.push(senderId); }
  if (since) { sql += ' AND m.created_at >= ?'; params.push(since); }
  if (until) { sql += " AND m.created_at <= ? || ' 23:59:59'"; params.push(until); }
  if (onlyMention) { sql += ' AND m.has_mention = 1'; }
  if (room) { sql += ' AND m.room_code = ?'; params.push(room); }
  sql += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = getDb().prepare(sql).all(...params);

  // 合計件数も返す
  let countSql = 'SELECT COUNT(*) as c FROM messages m WHERE 1=1';
  const countParams = [];
  if (q) { countSql += ' AND m.content LIKE ?'; countParams.push('%' + q + '%'); }
  if (senderId) { countSql += ' AND m.sender_id = ?'; countParams.push(senderId); }
  if (since) { countSql += ' AND m.created_at >= ?'; countParams.push(since); }
  if (until) { countSql += " AND m.created_at <= ? || ' 23:59:59'"; countParams.push(until); }
  if (onlyMention) { countSql += ' AND m.has_mention = 1'; }
  if (room) { countSql += ' AND m.room_code = ?'; countParams.push(room); }
  const totalRow = getDb().prepare(countSql).get(...countParams);

  res.json({ success: true, messages: rows, total: totalRow.c });
});

// DM履歴（自分と指定相手）
router.get('/dm/:peerId', authUser, (req, res) => {
  const peerId = req.params.peerId;
  const rows = getDb().prepare(`
    SELECT m.id, m.sender_id, m.receiver_id, m.content, m.created_at
    FROM messages m
    WHERE m.room_code = 'dm'
      AND ((m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?))
      AND m.created_at > datetime('now', '-60 days')
    ORDER BY m.created_at DESC
    LIMIT 200
  `).all(req.uid, peerId, peerId, req.uid);
  res.json({ success: true, messages: rows.reverse() });
});

// DMの相手一覧（最新のやり取り順）
router.get('/dm', authUser, (req, res) => {
  const rows = getDb().prepare(`
    SELECT u.id AS peer_id, u.display_name, u.avatar_url, u.company_code, l.last_at
    FROM users u
    JOIN (
      SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS peer_id,
             MAX(created_at) AS last_at
      FROM messages
      WHERE room_code='dm' AND (sender_id = ? OR receiver_id = ?)
      GROUP BY peer_id
    ) l ON l.peer_id = u.id
    ORDER BY l.last_at DESC LIMIT 50
  `).all(req.uid, req.uid, req.uid);
  res.json({ success: true, peers: rows });
});

// フロア一覧
router.get('/floors', authUser, (req, res) => {
  const rows = getDb().prepare('SELECT code, name FROM floors ORDER BY sort_order').all();
  res.json({ success: true, floors: rows });
});

// ホワイトボード内容取得 (会議室入室時)
router.get('/wb/:room', authUser, (req, res) => {
  const row = getDb().prepare('SELECT content, updated_at, updated_by FROM whiteboards WHERE room_code = ?').get(req.params.room);
  res.json({ success: true, content: row ? row.content : '', updated_at: row ? row.updated_at : null });
});

module.exports = router;
