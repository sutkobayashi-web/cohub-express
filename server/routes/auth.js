const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../services/db');
const { generateToken, authUser } = require('../middleware/auth');

// パスワードポリシー (強度評価)
function evaluatePassword(pw, loginId, displayName) {
  const errors = [];
  if (!pw || pw.length < 10) errors.push('10文字以上にしてください');
  if (pw && pw.length > 100) errors.push('100文字以下にしてください');
  if (pw && !/[a-z]/.test(pw)) errors.push('英小文字 (a-z) を含めてください');
  if (pw && !/[A-Z]/.test(pw)) errors.push('英大文字 (A-Z) を含めてください');
  if (pw && !/[0-9]/.test(pw)) errors.push('数字 (0-9) を含めてください');
  if (pw && !/[!-/:-@[-`{-~]/.test(pw)) errors.push('記号 (! @ # $ など) を含めてください');
  if (pw && /(.)\1{2,}/.test(pw)) errors.push('同じ文字の3連続は禁止 (例: aaa)');
  if (pw && loginId && pw.toLowerCase().includes(String(loginId).toLowerCase())) errors.push('ログインIDを含めないでください');
  if (pw && displayName && String(displayName).length >= 2 && pw.toLowerCase().includes(String(displayName).toLowerCase())) errors.push('表示名を含めないでください');
  // よくある弱いパターン
  const weak = ['password', '12345', 'qwerty', 'abc123', 'admin', 'letmein', 'cohub', 'welcome'];
  if (pw) {
    const lower = pw.toLowerCase();
    for (const w of weak) if (lower.includes(w)) { errors.push('予測されやすい単語を含んでいます (例: ' + w + ')'); break; }
  }
  return errors;
}

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
      employee_type: user.employee_type || 'office',
      avatar_url: user.avatar_url,
      is_field_promoter: !!user.is_field_promoter,
    }
  });
});

// 自分の最新ユーザー情報 (フラグ追加時に既存ログイン中ユーザーが再取得できるよう)
router.get('/me', authUser, (req, res) => {
  const u = getDb().prepare('SELECT id, login_id, display_name, company_code, role, employee_type, avatar_url, is_field_promoter FROM users WHERE id = ?').get(req.uid);
  if (!u) return res.status(404).json({ success: false, msg: 'ユーザーが見つかりません' });
  res.json({
    success: true,
    user: {
      uid: u.id,
      login_id: u.login_id,
      display_name: u.display_name,
      company_code: u.company_code,
      role: u.role,
      employee_type: u.employee_type || 'office',
      avatar_url: u.avatar_url,
      is_field_promoter: !!u.is_field_promoter,
    },
  });
});

// パスワード変更 (本人のみ)
router.post('/change-password', authUser, express.json(), (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ success: false, msg: '現在と新しいパスワードを入力してください' });
  }
  const db = getDb();
  const u = db.prepare('SELECT id, login_id, display_name, password_hash FROM users WHERE id = ?').get(req.uid);
  if (!u) return res.status(404).json({ success: false, msg: 'ユーザーが見つかりません' });
  if (!bcrypt.compareSync(current_password, u.password_hash)) {
    return res.status(401).json({ success: false, msg: '現在のパスワードが違います' });
  }
  if (current_password === new_password) {
    return res.status(400).json({ success: false, msg: '新しいパスワードは現在と同じにはできません' });
  }
  const errors = evaluatePassword(new_password, u.login_id, u.display_name);
  if (errors.length) {
    return res.status(400).json({ success: false, msg: errors.join(' / '), errors });
  }
  const newHash = bcrypt.hashSync(new_password, 10);
  // 全セッション無効化(同時ログイン排除) + 新トークン発行
  const sid = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET password_hash = ?, session_token = ? WHERE id = ?').run(newHash, sid, u.id);
  const token = generateToken({ uid: u.id, role: (req.user && req.user.role) || 'member', sid });
  res.json({ success: true, token, msg: 'パスワードを変更しました' });
});

// ポリシー評価専用 (リアルタイムバー表示用)
router.post('/check-password', authUser, express.json(), (req, res) => {
  const { password } = req.body || {};
  const db = getDb();
  const u = db.prepare('SELECT login_id, display_name FROM users WHERE id = ?').get(req.uid);
  const errors = evaluatePassword(password || '', u && u.login_id, u && u.display_name);
  res.json({ success: errors.length === 0, errors });
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
