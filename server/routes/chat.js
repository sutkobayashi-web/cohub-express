const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// 自分の24h以内の会話履歴（本人のみ閲覧）
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
      AND m.created_at > datetime('now', '-24 hours')
    ORDER BY m.created_at DESC
    LIMIT 500
  `).all(req.uid, req.uid);
  res.json({ success: true, messages: rows });
});

module.exports = router;
