const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../services/db');
const { generateToken, authUser } = require('../middleware/auth');

// 利用規約・プライバシーポリシー バージョン
// ポリシー本文を変更したらここを更新 → 全ユーザーに再同意を要求
const CONSENT_VERSION = '2.0.0_20260513';

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

// デバイス種別判定 (User-Agent)
// 戻り値: 'pc' または 'mobile' のみ (デスクトップブラウザかスマホ/タブレットか)
// iPad は mobile 扱い (近年のiPadは PC モードを名乗ることがあるが、業務用としては携帯端末扱い)
function deviceTypeFromUA(ua) {
  ua = String(ua || '');
  if (/iPad|iPhone|Android|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i.test(ua)) return 'mobile';
  return 'pc';
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
  const dev = deviceTypeFromUA(req.headers['user-agent']);
  // 同一デバイス種別の旧セッションは上書き (PC+モバイルは並行ログイン可、PC2台目は旧PCをキック)
  // 注意: 旧互換フィールド session_token は触らない。新規デバイス別ログインで旧トークンを巻き添えキックしないため
  if (dev === 'mobile') {
    db.prepare("UPDATE users SET mobile_session_token = ?, last_seen_at = datetime('now') WHERE id = ?").run(sid, user.id);
  } else {
    db.prepare("UPDATE users SET pc_session_token = ?, last_seen_at = datetime('now') WHERE id = ?").run(sid, user.id);
  }
  db.prepare(`INSERT INTO positions (user_id, x, y, status) VALUES (?, ?, ?, 'online')
    ON CONFLICT(user_id) DO UPDATE SET status='online', updated_at=datetime('now')`)
    .run(user.id, 400 + Math.floor(Math.random() * 200) - 100, 300 + Math.floor(Math.random() * 200) - 100);
  const token = generateToken({ uid: user.id, role: user.role, sid, dev });
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
      job_role: user.job_role || null,
      is_field_promoter: !!user.is_field_promoter,
      is_warehouse_promoter: !!user.is_warehouse_promoter,
      is_manager: !!user.is_manager,
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
  const u = getDb().prepare('SELECT id, login_id, display_name, company_code, dm_group, role, employee_type, job_role, avatar_url, is_field_promoter, is_warehouse_promoter, is_manager, is_guest_reviewer, guest_org, birth_date, nickname, consent_version, consent_accepted_at, research_consent, research_consent_at FROM users WHERE id = ?').get(req.uid);
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
      job_role: u.job_role || null,
      is_field_promoter: !!u.is_field_promoter,
      is_warehouse_promoter: !!u.is_warehouse_promoter,
      is_manager: !!u.is_manager,
      is_guest_reviewer: !!u.is_guest_reviewer,
      guest_org: u.guest_org || null,
      birth_date: u.birth_date || null,
      nickname: u.nickname || null,
      dm_group: u.dm_group || null,
      needs_nickname_setup: !u.nickname,
      consent_version: u.consent_version || null,
      consent_accepted_at: u.consent_accepted_at || null,
      research_consent: !!u.research_consent,
      research_consent_at: u.research_consent_at || null,
      needs_consent: needsConsent,
      current_consent_version: CONSENT_VERSION,
    },
  });
});

// 利用規約・プライバシーポリシー 同意エンドポイント
// 必須3項目 (ログ/個人情報/ポリシー) + 任意1項目 (帝京大学 共同研究データ提供)
router.post('/consent', authUser, express.json(), (req, res) => {
  const b = req.body || {};
  const acceptedLog = !!b.accepted_log;
  const acceptedPrivacy = !!b.accepted_privacy;
  const acceptedPolicy = !!b.accepted_policy;
  // 任意項目: 帝京大学公衆衛生学研究科との共同研究データ提供 (opt-in、デフォルトOFF)
  const acceptedResearch = !!b.accepted_research;
  if (!acceptedLog || !acceptedPrivacy || !acceptedPolicy) {
    return res.status(400).json({ success: false, msg: '必須3項目すべてに同意が必要です' });
  }
  // クライアントから送られたバージョンが現行と一致することを確認 (古いポリシーへの同意を防ぐ)
  if (b.version && b.version !== CONSENT_VERSION) {
    return res.status(409).json({ success: false, msg: 'ポリシーが更新されました。画面を再読み込みしてください', current: CONSENT_VERSION });
  }
  const db = getDb();
  const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').toString().split(',')[0].trim().slice(0, 64);
  const ua = String(req.headers['user-agent'] || '').slice(0, 256);
  // 監査ログに記録 (削除しない)
  db.prepare(`INSERT INTO consent_logs (user_id, consent_version, accepted_log, accepted_privacy, accepted_policy, accepted_research, ip_address, user_agent)
              VALUES (?, ?, 1, 1, 1, ?, ?, ?)`).run(req.uid, CONSENT_VERSION, acceptedResearch ? 1 : 0, ip, ua);
  // ユーザーレコード更新 (research_consent は本人の選択を保存)
  db.prepare(`UPDATE users SET
    consent_version = ?,
    consent_accepted_at = datetime('now'),
    research_consent = ?,
    research_consent_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
    WHERE id = ?`)
    .run(CONSENT_VERSION, acceptedResearch ? 1 : 0, acceptedResearch ? 1 : 0, req.uid);
  res.json({ success: true, version: CONSENT_VERSION, research_consent: acceptedResearch });
});

// 研究参加同意の単独更新 (設定画面からいつでも撤回/再同意可能)
router.post('/research-consent', authUser, express.json(), (req, res) => {
  const accepted = !!(req.body && req.body.accepted);
  const db = getDb();
  const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').toString().split(',')[0].trim().slice(0, 64);
  const ua = String(req.headers['user-agent'] || '').slice(0, 256);
  // 監査用に変更を consent_logs にも記録 (本ポリシー必須3項目は前回の値を引き継ぐ)
  db.prepare(`INSERT INTO consent_logs (user_id, consent_version, accepted_log, accepted_privacy, accepted_policy, accepted_research, ip_address, user_agent)
              VALUES (?, ?, 1, 1, 1, ?, ?, ?)`).run(req.uid, CONSENT_VERSION, accepted ? 1 : 0, ip, ua);
  db.prepare(`UPDATE users SET
    research_consent = ?,
    research_consent_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
    WHERE id = ?`).run(accepted ? 1 : 0, accepted ? 1 : 0, req.uid);
  res.json({ success: true, research_consent: accepted });
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
  // パスワード変更: 全デバイスのセッションを無効化し、現在のデバイス分だけ新トークン発行
  const sid = crypto.randomBytes(16).toString('hex');
  const dev = deviceTypeFromUA(req.headers['user-agent']);
  // 全デバイス無効化(両カラムNULL+session_tokenはこのデバイスのみ)
  if (dev === 'mobile') {
    db.prepare('UPDATE users SET password_hash = ?, pc_session_token = NULL, mobile_session_token = ?, session_token = ? WHERE id = ?').run(newHash, sid, sid, u.id);
  } else {
    db.prepare('UPDATE users SET password_hash = ?, pc_session_token = ?, mobile_session_token = NULL, session_token = ? WHERE id = ?').run(newHash, sid, sid, u.id);
  }
  const token = generateToken({ uid: u.id, role: (req.user && req.user.role) || 'member', sid, dev });
  res.json({ success: true, token, msg: 'パスワードを変更しました' });
});

// 所属 (dm_group) 変更 (本人のみ)
router.post('/dm-group', authUser, express.json(), (req, res) => {
  const dg = String((req.body && req.body.dm_group) || '').trim();
  if (dg.length === 0 || dg.length > 40) {
    return res.status(400).json({ success: false, msg: '所属は1〜40文字で入力してください' });
  }
  if (/[ -]/.test(dg)) {
    return res.status(400).json({ success: false, msg: '使えない文字が含まれています' });
  }
  const db = getDb();
  db.prepare('UPDATE users SET dm_group = ? WHERE id = ?').run(dg, req.uid);
  res.json({ success: true, dm_group: dg });
});

// 既存所属の候補リスト取得 (本人用のドロップダウン)
router.get('/dm-groups', authUser, (req, res) => {
  const rows = getDb().prepare("SELECT dm_group, COUNT(*) AS n FROM users WHERE dm_group IS NOT NULL AND dm_group <> '' AND COALESCE(role,'')<>'bot' GROUP BY dm_group ORDER BY n DESC").all();
  res.json({ success: true, groups: rows.map(r => r.dm_group) });
});

// ポリシー評価専用 (リアルタイムバー表示用)
router.post('/check-password', authUser, express.json(), (req, res) => {
  const { password } = req.body || {};
  const db = getDb();
  const u = db.prepare('SELECT login_id, display_name FROM users WHERE id = ?').get(req.uid);
  const errors = evaluatePassword(password || '', u && u.login_id, u && u.display_name);
  res.json({ success: errors.length === 0, errors });
});

// ============================================================
// タブレットキオスク用ログイン (2026-05-12)
// PC環境のない社員向け: 事務所設置タブレットでアバター選択 + 4桁PIN
// ============================================================

// 全社員ロスター (タブレット選択画面用、認証不要だが個人情報は最小限)
router.get('/tablet-roster', (req, res) => {
  const rows = getDb().prepare(`
    SELECT id, display_name, company_code, avatar_url,
           CASE WHEN tablet_pin_hash IS NOT NULL AND tablet_pin_hash <> '' THEN 1 ELSE 0 END AS has_pin
    FROM users
    WHERE role != 'bot'
      AND is_guest_reviewer = 0
    ORDER BY company_code, display_name
  `).all();
  res.json({ success: true, users: rows });
});

// タブレットPINログイン
router.post('/tablet-login', express.json(), (req, res) => {
  const { user_id, pin } = req.body || {};
  if (!user_id || !pin) return res.status(400).json({ success: false, msg: '対象者とPINを入力してください' });
  if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ success: false, msg: 'PINは4桁の数字です' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!user) return res.status(401).json({ success: false, msg: '対象者が見つかりません' });
  if (!user.tablet_pin_hash) return res.status(401).json({ success: false, msg: 'PIN未設定です。管理者に連絡してください' });
  if (!bcrypt.compareSync(String(pin), user.tablet_pin_hash)) {
    return res.status(401).json({ success: false, msg: 'PINが違います' });
  }
  const sid = crypto.randomBytes(16).toString('hex');
  const dev = 'mobile'; // タブレットキオスクログインは常にモバイル種別
  db.prepare("UPDATE users SET mobile_session_token = ?, session_token = ?, last_seen_at = datetime('now') WHERE id = ?").run(sid, sid, user.id);
  db.prepare(`INSERT INTO positions (user_id, x, y, status) VALUES (?, ?, ?, 'online')
    ON CONFLICT(user_id) DO UPDATE SET status='online', updated_at=datetime('now')`)
    .run(user.id, 400 + Math.floor(Math.random() * 200) - 100, 300 + Math.floor(Math.random() * 200) - 100);
  const token = generateToken({ uid: user.id, role: user.role, sid, dev });
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
      job_role: user.job_role || null,
      is_field_promoter: !!user.is_field_promoter,
      is_warehouse_promoter: !!user.is_warehouse_promoter,
      is_guest_reviewer: !!user.is_guest_reviewer,
      nickname: user.nickname || null,
      needs_nickname_setup: !user.nickname,
      consent_version: user.consent_version || null,
      needs_consent: needsConsent,
      current_consent_version: CONSENT_VERSION,
    },
  });
});

// 本人による4桁PIN設定/変更 (タブレットログイン用)
router.post('/tablet-pin', authUser, express.json(), (req, res) => {
  const { new_pin, current_password } = req.body || {};
  if (!new_pin) return res.status(400).json({ success: false, msg: '新しいPINを入力してください' });
  if (!/^\d{4}$/.test(String(new_pin))) return res.status(400).json({ success: false, msg: 'PINは4桁の数字で設定してください' });
  // 連続/同一は弱いPINとして拒否 (例: 0000, 1234, 4321)
  const p = String(new_pin);
  if (/^(.)\1{3}$/.test(p)) return res.status(400).json({ success: false, msg: '同じ数字4桁は使えません (例: 0000)' });
  const seq = '0123456789'; const seqRev = '9876543210';
  if (seq.includes(p) || seqRev.includes(p)) return res.status(400).json({ success: false, msg: '連続した数字は使えません (例: 1234)' });
  const db = getDb();
  const u = db.prepare('SELECT password_hash, tablet_pin_hash FROM users WHERE id = ?').get(req.uid);
  if (!u) return res.status(404).json({ success: false, msg: 'ユーザーが見つかりません' });
  // 初回設定は不要、既存PIN差し替え時は念のためログインパスワード確認 (誤操作防止)
  if (u.tablet_pin_hash && current_password) {
    if (!bcrypt.compareSync(current_password, u.password_hash)) {
      return res.status(401).json({ success: false, msg: 'ログインパスワードが違います' });
    }
  }
  const hash = bcrypt.hashSync(p, 10);
  db.prepare('UPDATE users SET tablet_pin_hash = ? WHERE id = ?').run(hash, req.uid);
  res.json({ success: true, msg: 'タブレットPINを設定しました' });
});

router.post('/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.json({ success: true });
  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    getDb().prepare("UPDATE users SET session_token = NULL WHERE id = ?").run(payload.uid);
    getDb().prepare("UPDATE positions SET status='offline', updated_at=datetime('now') WHERE user_id = ?").run(payload.uid);
    // 該当uidの全socketを切断 (plaza:new等の継続通知を止める)
    const io = req.app && req.app.locals && req.app.locals.io;
    if (io) {
      let kicked = 0;
      for (const [sid, s] of io.sockets.sockets) {
        try {
          const t = (s.handshake && s.handshake.auth && s.handshake.auth.token) || '';
          if (!t) continue;
          const p = jwt.verify(t, process.env.JWT_SECRET);
          if (p && p.uid === payload.uid) {
            try { s.emit('session:loggedout'); } catch (_) {}
            s.disconnect(true);
            kicked++;
          }
        } catch (_) {}
      }
      if (kicked) console.log('[auth] logout: kicked', kicked, 'sockets for', payload.uid);
    }
  } catch (e) {}
  res.json({ success: true });
});

module.exports = router;
