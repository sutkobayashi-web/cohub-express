const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../services/db');
const { generateToken, authUser } = require('../middleware/auth');

// 利用規約・プライバシーポリシー バージョン
// ポリシー本文を変更したらここを更新 → 全ユーザーに再同意を要求
const CONSENT_VERSION = '1.0.0_20260427';

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
  // bot系はそもそも対人ログイン経路に乗らないが念のため除外
  const needsConsent = user.role !== 'bot' && user.consent_version !== CONSENT_VERSION;
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
      is_warehouse_promoter: !!user.is_warehouse_promoter,
      is_guest_reviewer: !!user.is_guest_reviewer,
      guest_org: user.guest_org || null,
      birth_date: user.birth_date || null,
      nickname: user.nickname || null,
      needs_nickname_setup: !user.nickname,
      consent_version: user.consent_version || null,
      consent_accepted_at: user.consent_accepted_at || null,
      needs_consent: needsConsent,
      current_consent_version: CONSENT_VERSION,
    }
  });
});

// 自分の最新ユーザー情報 (フラグ追加時に既存ログイン中ユーザーが再取得できるよう)
router.get('/me', authUser, (req, res) => {
  const u = getDb().prepare('SELECT id, login_id, display_name, company_code, role, employee_type, avatar_url, is_field_promoter, is_warehouse_promoter, is_guest_reviewer, guest_org, birth_date, nickname, consent_version, consent_accepted_at FROM users WHERE id = ?').get(req.uid);
  if (!u) return res.status(404).json({ success: false, msg: 'ユーザーが見つかりません' });
  const needsConsent = u.role !== 'bot' && u.consent_version !== CONSENT_VERSION;
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
      is_warehouse_promoter: !!u.is_warehouse_promoter,
      is_guest_reviewer: !!u.is_guest_reviewer,
      guest_org: u.guest_org || null,
      birth_date: u.birth_date || null,
      nickname: u.nickname || null,
      needs_nickname_setup: !u.nickname,
      consent_version: u.consent_version || null,
      consent_accepted_at: u.consent_accepted_at || null,
      needs_consent: needsConsent,
      current_consent_version: CONSENT_VERSION,
    },
  });
});

// 利用規約・プライバシーポリシー 同意エンドポイント
// 3項目すべてチェックされている必要あり (UI側でも検証するが、サーバー側でも必須化)
router.post('/consent', authUser, express.json(), (req, res) => {
  const b = req.body || {};
  const acceptedLog = !!b.accepted_log;
  const acceptedPrivacy = !!b.accepted_privacy;
  const acceptedPolicy = !!b.accepted_policy;
  if (!acceptedLog || !acceptedPrivacy || !acceptedPolicy) {
    return res.status(400).json({ success: false, msg: '3つの項目すべてに同意が必要です' });
  }
  // クライアントから送られたバージョンが現行と一致することを確認 (古いポリシーへの同意を防ぐ)
  if (b.version && b.version !== CONSENT_VERSION) {
    return res.status(409).json({ success: false, msg: 'ポリシーが更新されました。画面を再読み込みしてください', current: CONSENT_VERSION });
  }
  const db = getDb();
  const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').toString().split(',')[0].trim().slice(0, 64);
  const ua = String(req.headers['user-agent'] || '').slice(0, 256);
  // 監査ログに記録 (削除しない)
  db.prepare(`INSERT INTO consent_logs (user_id, consent_version, accepted_log, accepted_privacy, accepted_policy, ip_address, user_agent)
              VALUES (?, ?, 1, 1, 1, ?, ?)`).run(req.uid, CONSENT_VERSION, ip, ua);
  // ユーザーレコード更新
  db.prepare("UPDATE users SET consent_version = ?, consent_accepted_at = datetime('now') WHERE id = ?")
    .run(CONSENT_VERSION, req.uid);
  res.json({ success: true, version: CONSENT_VERSION });
});

// 同意履歴 (本人のみ閲覧可) — 設定画面で「いつ何に同意したか」を確認できる
router.get('/consent/history', authUser, (req, res) => {
  const rows = getDb().prepare(`SELECT consent_version, accepted_at, ip_address
                                  FROM consent_logs WHERE user_id = ? ORDER BY accepted_at DESC LIMIT 20`).all(req.uid);
  res.json({ success: true, current_version: CONSENT_VERSION, history: rows });
});

// ニックネーム設定 (本人のみ、初回ログイン時に強制)
router.post('/nickname', authUser, express.json(), (req, res) => {
  const nick = String((req.body && req.body.nickname) || '').trim();
  if (nick.length < 2 || nick.length > 20) {
    return res.status(400).json({ success: false, msg: 'ニックネームは2〜20文字で設定してください' });
  }
  // 禁止文字: 制御文字
  if (/[\x00-\x1f\x7f]/.test(nick)) {
    return res.status(400).json({ success: false, msg: '使えない文字が含まれています' });
  }
  const db = getDb();
  // 重複チェック (大文字小文字無視で完全一致)
  const dupe = db.prepare('SELECT id FROM users WHERE LOWER(nickname) = LOWER(?) AND id != ?').get(nick, req.uid);
  if (dupe) return res.status(400).json({ success: false, msg: 'そのニックネームは既に使われています。別のものをお試しください' });
  db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nick, req.uid);
  res.json({ success: true, nickname: nick });
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
