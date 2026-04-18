const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../services/db');
const { generateToken } = require('../middleware/auth');

router.post('/login', (req, res) => {
  const { login_id, password } = req.body;
  if (!login_id || !password) return res.status(400).json({ success: false, msg: 'IDとパスワードを入力してください' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE login_id = ?').get(login_id);
  if (!user) return res.status(401).json({ success: false, msg: 'IDまたはパスワードが違います' });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ success: false, msg: 'IDまたはパスワードが違います' });
  }
  const sid = crypto.randomBytes(16).toString('hex');
  db.prepare("UPDATE users SET session_token = ?, last_seen_at = datetime('now') WHERE id = ?").run(sid, user.id);
  db.prepare(`INSERT INTO positions (user_id, x, y, status) VALUES (?, ?, ?, 'online')
    ON CONFLICT(user_id) DO UPDATE SET status='online', updated_at=datetime('now')`)
    .run(user.id, 400 + Math.floor(Math.random() * 200) - 100, 300 + Math.floor(Math.random() * 200) - 100);
  const token = generateToken({ uid: user.id, role: user.role, sid });
  res.json({
    success: true,
    token,
    user: {
      uid: user.id,
      login_id: user.login_id,
      display_name: user.display_name,
      company_code: user.company_code,
      role: user.role,
      avatar_url: user.avatar_url,
    }
  });
});

router.post('/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.json({ success: true });
  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    getDb().prepare("UPDATE users SET session_token = NULL WHERE id = ?").run(payload.uid);
    getDb().prepare("UPDATE positions SET status='offline', updated_at=datetime('now') WHERE user_id = ?").run(payload.uid);
  } catch (e) {}
  res.json({ success: true });
});

module.exports = router;
