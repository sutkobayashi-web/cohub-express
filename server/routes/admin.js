const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../services/db');
const { authAdmin } = require('../middleware/auth');

// ユーザー一覧
router.get('/users', authAdmin, (req, res) => {
  const rows = getDb().prepare(`SELECT u.id, u.login_id, u.display_name, u.company_code, u.role, u.avatar_url,
    u.last_seen_at, p.status FROM users u LEFT JOIN positions p ON p.user_id = u.id ORDER BY u.created_at DESC`).all();
  res.json({ success: true, users: rows });
});

// ユーザー作成（1件）
router.post('/users', authAdmin, (req, res) => {
  const { login_id, display_name, company_code, password, role } = req.body;
  if (!login_id || !display_name || !company_code || !password) {
    return res.status(400).json({ success: false, msg: '必須項目が不足しています' });
  }
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(login_id);
  if (exists) return res.status(400).json({ success: false, msg: 'このログインIDは既に使われています' });
  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (id, login_id, password_hash, display_name, company_code, role)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, login_id, hash, display_name, company_code, role || 'member');
  res.json({ success: true, id });
});

// CSV一括登録
router.post('/users/bulk', authAdmin, (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ success: false, msg: 'CSVが空です' });
  const lines = csv.trim().split(/\r?\n/);
  const db = getDb();
  const results = { created: 0, skipped: 0, errors: [] };
  const insert = db.prepare(`INSERT INTO users (id, login_id, password_hash, display_name, company_code, role)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const txn = db.transaction(() => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      // フォーマット: login_id,display_name,company_code,password[,role]
      const parts = line.split(',').map(s => s.trim());
      if (parts.length < 4) { results.errors.push(`行${i+1}: 列不足`); continue; }
      const [login_id, display_name, company_code, password, role] = parts;
      const exists = db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(login_id);
      if (exists) { results.skipped++; continue; }
      const id = crypto.randomUUID();
      const hash = bcrypt.hashSync(password, 10);
      insert.run(id, login_id, hash, display_name, company_code, role || 'member');
      results.created++;
    }
  });
  txn();
  res.json({ success: true, ...results });
});

// パスワードリセット
router.post('/users/:id/password', authAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ success: false, msg: 'パスワードを指定してください' });
  const hash = bcrypt.hashSync(password, 10);
  const r = getDb().prepare('UPDATE users SET password_hash = ?, session_token = NULL WHERE id = ?').run(hash, req.params.id);
  res.json({ success: r.changes > 0 });
});

// ユーザー削除
router.delete('/users/:id', authAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM positions WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').run(req.params.id, req.params.id);
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: r.changes > 0 });
});

module.exports = router;
