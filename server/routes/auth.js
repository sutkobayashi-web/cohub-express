const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../services/db');
const { generateToken, authUser, hasValidSession, verifyToken } = require('../middleware/auth');
const { audit, clientIp } = require('../services/audit');
const { issueDeviceToken, deviceOf } = require('../services/net');

// 2026-07-21: 初回PIN設定(tablet-setup)を事業所ネットワークからのみ許可する。
// 従来は無認証で user_id を渡すだけでPIN未設定者のアカウントを乗っ取れた。
// 許可IPは .env の TABLET_SETUP_ALLOW_IPS (カンマ区切り) で運用中に追加できる。
// 各要素は前方一致のため "116.67." や IPv6 の "240d:0:6736:2700:" も書ける。
function isSetupAllowedIp(req) {
  const list = String(process.env.TABLET_SETUP_ALLOW_IPS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return true; // 未設定なら従来動作 (締め出し事故の防止)
  const ip = String(clientIp(req) || '').replace(/^::ffff:/, '');
  return list.some(a => ip === a || ip.indexOf(a) === 0);
}

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
  if (!user) { audit(req, 'login_fail', { target: 'id=' + login_id }); return res.status(401).json({ success: false, msg: 'IDまたはパスワードが違います' }); }
  if (!bcrypt.compareSync(password, user.password_hash)) {
    audit(req, 'login_fail', { actor_id: user.id, actor_name: user.display_name, target: 'wrong_pw' });
    return res.status(401).json({ success: false, msg: 'IDまたはパスワードが違います' });
  }
  audit(req, 'login', { actor_id: user.id, actor_name: user.display_name, target: 'password' });
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
  const u = getDb().prepare('SELECT id, login_id, display_name, company_code, dm_group, role, employee_type, job_role, avatar_url, is_field_promoter, is_warehouse_promoter, is_manager, is_ops_manager, is_branch_head, is_guest_reviewer, guest_org, birth_date, nickname, consent_version, consent_accepted_at, research_consent, research_consent_at FROM users WHERE id = ?').get(req.uid);
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
      is_ops_manager: !!u.is_ops_manager,
      is_branch_head: !!u.is_branch_head,
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
// ?co=拠点コード が付くと、その拠点の社員のみ返す (営業所専用タブレットでの他拠点氏名露出を防ぐ)
// 設置端末(共用タブレット)の登録 (2026-08-04)。
// 事業所ネットワークからの1回きりの登録で端末トークンを発行し、以後はIPが変わっても名簿を読めるようにする。
// ※実測で拠点のグローバルIPは1か月半に2回入れ替わっていたため、IP許可リストの運用は続かない。
router.post('/device-register', express.json(), (req, res) => {
  // 事業所ネットワークからの登録に加え、『共用タブレットとしてPINログインできた端末』も認める。
  // ⚠️許可IPリストが全拠点を網羅できていないため(実測で2拠点が漏れていた)。PINを打って入れた
  //   端末＝現物が拠点にある端末とみなす。個人スマホ(?personal=1)は dev='mobile' なので通らない。
  let kioskSession = false, kioskUid = null;
  try {
    const _t = (req.headers.authorization || '').replace('Bearer ', '');
    if (_t) { const _p = verifyToken(_t); kioskSession = !!(_p && _p.dev === 'kiosk'); kioskUid = _p && _p.uid; }
  } catch (e) { kioskSession = false; }
  if (!isSetupAllowedIp(req) && !kioskSession) {
    audit(req, 'device_register_denied', { target: 'ip=' + clientIp(req) });
    return res.status(403).json({ success: false, msg: '端末の登録は事業所のネットワークから行ってください' });
  }
  const b = req.body || {};
  // 拠点が指定されていなければ、ログインした人の所属から補う。
  // (名前選択画面で拠点フィルタを選ばずに使うと空になり、一覧で見分けが付かなかった)
  let co = String(b.co || '').trim();
  if (!co && kioskUid) {
    try { const _u = getDb().prepare('SELECT company_code FROM users WHERE id = ?').get(kioskUid); co = (_u && _u.company_code) || ''; } catch (e) {}
  }
  const token = issueDeviceToken(getDb(), {
    companyCode: co || null,
    label: String(b.label || '').trim() || null,
    ip: clientIp(req),
  });
  audit(req, 'device_register', { target: 'co=' + (co || '-') });
  res.json({ success: true, device_token: token });
});

router.get('/tablet-roster', (req, res) => {
  // ⚠️この名簿はログイン前(共用タブレットの名前選択)に読むため無認証だが、
  //   全社員の氏名がそのまま返る。URLを知っていれば社外からも取得できたので、
  //   事業所ネットワーク(TABLET_SETUP_ALLOW_IPS)かログイン済みに限る (2026-08-04)。
  // ⚠️2026-08-04: 一度403にしたところ、許可リストに入っていない拠点の端末が実利用で弾かれた。
  //   まずは検知モード(通すが記録する)でどのIPが必要かを集め、.envを揃えてから閉める。
  //   authz.js の POLICY と同じ手順(検知→確認→enforce)。
  // 2026-08-04: 全拠点のタブレットが登録されたので検知モードを終了し、未登録の端末を閉める。
  //  通すのは ①登録済みの設置端末 ②事業所ネットワーク ③ログイン済み のいずれか。
  //  ⚠️弾かれた端末も、事業所ネットワークで開いてPINログインすれば自動登録されて復旧する。
  const dev = deviceOf(getDb(), req);
  if (!dev && !isSetupAllowedIp(req) && !hasValidSession(req)) {
    audit(req, 'tablet_roster_denied', { target: 'ip=' + clientIp(req) });
    return res.status(403).json({ success: false, code: 'device_unregistered',
      msg: 'この端末は登録されていません。事業所のネットワークで開いてから、もう一度お試しください' });
  }
  // 端末に拠点が紐づいていればその拠点だけ返す(万一漏れても被害をその拠点に限る)。
  const co = (dev && dev.company_code) ? dev.company_code : (req.query.co || '').toString().trim();
  const rows = getDb().prepare(`
    SELECT id, display_name, company_code, avatar_url,
           CASE WHEN tablet_pin_hash IS NOT NULL AND tablet_pin_hash <> '' THEN 1 ELSE 0 END AS has_pin
    FROM users
    WHERE role != 'bot'
      AND is_guest_reviewer = 0
      ${co ? 'AND company_code = ?' : ''}
    ORDER BY company_code, display_name
  `).all(...(co ? [co] : []));
  // 端末トークンの状態をクライアントに返す。unknown=失効/知らないトークンを持っている状態。
  // ⚠️これが無いと、失効させた端末は localStorage に古いトークンを抱えたまま再登録できず、
  //   永久に未登録のままになる(2026-08-04 実機を失効させて判明)。
  const devState = dev ? 'ok' : (req.headers['x-device-token'] ? 'unknown' : 'none');
  // 端末に拠点が紐づいている場合はそれを返す。画面側は拠点セレクタをその拠点に固定する
  // (選べるのに選んでも変わらないと「ロックされている」と見えるため)。
  res.json({ success: true, users: rows, device: devState, device_company: (dev && dev.company_code) || null });
});

// タブレットPINログイン
// 4桁PINの総当たり対策: 対象者ごとの連続失敗をDBに永続化 (再起動でリセットされない) + /tablet-login にIP制限(index.js)
const PIN_MAX_FAILS = 5, PIN_LOCK_MS = 10 * 60 * 1000;
router.post('/tablet-login', express.json(), (req, res) => {
  const { user_id, pin } = req.body || {};
  if (!user_id || !pin) return res.status(400).json({ success: false, msg: '対象者とPINを入力してください' });
  if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ success: false, msg: 'PINは4桁の数字です' });
  const now = Date.now();
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!user) return res.status(401).json({ success: false, msg: '対象者が見つかりません' });
  if (user.tablet_pin_lock_until && now < user.tablet_pin_lock_until) {
    audit(req, 'tablet_login_locked', { actor_id: user_id });
    return res.status(429).json({ success: false, msg: 'PINの誤りが続いたため一時的にロックされています。約' + Math.ceil((user.tablet_pin_lock_until - now) / 60000) + '分後に再度お試しください' });
  }
  if (!user.tablet_pin_hash) return res.status(401).json({ success: false, msg: 'PIN未設定です。管理者に連絡してください' });
  if (!bcrypt.compareSync(String(pin), user.tablet_pin_hash)) {
    let count = (user.tablet_pin_fail_count || 0) + 1;
    let until = null;
    if (count >= PIN_MAX_FAILS) { until = now + PIN_LOCK_MS; count = 0; }
    db.prepare('UPDATE users SET tablet_pin_fail_count = ?, tablet_pin_lock_until = ? WHERE id = ?').run(count, until, user.id);
    audit(req, 'tablet_login_fail', { actor_id: user.id, actor_name: user.display_name });
    return res.status(401).json({ success: false, msg: 'PINが違います' });
  }
  db.prepare('UPDATE users SET tablet_pin_fail_count = 0, tablet_pin_lock_until = NULL WHERE id = ?').run(user.id); // 成功でリセット
  audit(req, 'tablet_login', { actor_id: user.id, actor_name: user.display_name });
  const sid = crypto.randomBytes(16).toString('hex');
  // ⭐2026-08-02 (社長): 個人スマホ(?personal=1)は『モバイル枠』、共用タブレットは『キオスク枠』。
  //   ⚠️以前は両方モバイル扱いで、同じ人がタブレットと自分のスマホを使うと互いを蹴り合い、
  //     書きかけの事故報告が消えていた。枠を分けることで併用できる。
  const personal = !!(req.body && req.body.personal);
  const dev = personal ? 'mobile' : 'kiosk';
  if (personal) {
    db.prepare("UPDATE users SET mobile_session_token = ?, session_token = ?, last_seen_at = datetime('now') WHERE id = ?").run(sid, sid, user.id);
  } else {
    db.prepare("UPDATE users SET kiosk_session_token = ?, last_seen_at = datetime('now') WHERE id = ?").run(sid, user.id);
  }
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
    // 2026-07-21: pc/mobile のセッションが残り、ログアウト後も旧トークンが最大30日有効だった
    getDb().prepare("UPDATE users SET session_token = NULL, pc_session_token = NULL, mobile_session_token = NULL WHERE id = ?").run(payload.uid);
    // 2026-07-21: ログアウトが監査ログに残っていなかった (ログインだけ記録されていた)
    try {
      const _u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(payload.uid);
      audit(req, 'logout', { actor_id: payload.uid, actor_name: _u && _u.display_name, target: 'dev=' + (payload.dev || 'unknown') });
    } catch (e) { /* 監査失敗で本処理は止めない */ }
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


// ============================================================
// タブレット初回設定: PIN未設定者がタブレットで顔写真を撮影し、
// 自分でニックネーム＋4桁PINを設定してそのままログインする。
// 本人確認は事務所運用前提で省略(タップした本人が設定)。生年月日はマイページで本人入力。
// ============================================================
router.post('/tablet-setup', express.json({ limit: '8mb' }), (req, res) => {
  if (!isSetupAllowedIp(req)) {
    audit(req, 'tablet_setup_denied', { target: 'ip=' + clientIp(req) });
    return res.status(403).json({ success: false, msg: '初回のPIN設定は事業所のネットワークから行ってください。設置端末で設定するか、担当者にご連絡ください' });
  }
  audit(req, 'tablet_setup', { target: 'user_id=' + String((req.body || {}).user_id || '') });
  const fs = require('fs');
  const path = require('path');
  const { user_id, nickname, pin, photo } = req.body || {};
  if (!user_id || !pin) return res.status(400).json({ success: false, msg: '必要項目を入力してください' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!user) return res.status(404).json({ success: false, msg: '対象者が見つかりません' });
  if (user.role === 'bot' || user.is_guest_reviewer) return res.status(403).json({ success: false, msg: '対象外のアカウントです' });
  if (user.tablet_pin_hash) return res.status(409).json({ success: false, msg: '既にPIN設定済みです。アバターをタップしてPINでログインしてください' });
  // PIN強度チェック (tablet-pin と同基準)
  const p = String(pin);
  if (!/^\d{4}$/.test(p)) return res.status(400).json({ success: false, msg: 'PINは4桁の数字です' });
  if (/^(.)\1{3}$/.test(p)) return res.status(400).json({ success: false, msg: '同じ数字4桁は使えません (例: 0000)' });
  if ('0123456789'.includes(p) || '9876543210'.includes(p)) return res.status(400).json({ success: false, msg: '連続した数字は使えません (例: 1234)' });
  // ニックネーム: 入力があれば検証して更新、無ければ既存維持
  let nick = user.nickname;
  const nn = String(nickname || '').trim();
  if (nn) {
    if (nn.length < 2 || nn.length > 20) return res.status(400).json({ success: false, msg: 'ニックネームは2〜20文字です' });
    if (/[\x00-\x1f\x7f]/.test(nn)) return res.status(400).json({ success: false, msg: 'ニックネームに使えない文字があります' });
    const dup = db.prepare('SELECT id FROM users WHERE LOWER(nickname) = LOWER(?) AND id != ?').get(nn, user_id);
    if (dup) return res.status(409).json({ success: false, msg: 'そのニックネームは既に使われています' });
    nick = nn;
  }
  // 顔写真(任意): dataURL を検証して /uploads/avatars/ に保存しアバターに
  let avatarUrl = user.avatar_url;
  if (photo && typeof photo === 'string' && photo.indexOf('data:image/') === 0) {
    try {
      const m = photo.match(/^data:image\/(png|jpe?g);base64,(.+)$/);
      if (m) {
        const ext = m[1].charAt(0) === 'j' ? 'jpg' : 'png';
        const buf = Buffer.from(m[2], 'base64');
        const isJpg = buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8;
        const isPng = buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
        if (buf.length > 0 && buf.length <= 6 * 1024 * 1024 && ((ext === 'jpg' && isJpg) || (ext === 'png' && isPng))) {
          const dir = path.join(__dirname, '..', '..', 'uploads', 'avatars');
          fs.mkdirSync(dir, { recursive: true });
          const filename = 'tablet_' + user.id.slice(0, 8) + '_' + Date.now() + '.' + ext;
          fs.writeFileSync(path.join(dir, filename), buf);
          avatarUrl = '/uploads/avatars/' + filename;
        }
      }
    } catch (e) { console.warn('[tablet-setup avatar]', e.message); }
  }
  const hash = bcrypt.hashSync(p, 10);
  db.prepare('UPDATE users SET nickname = ?, tablet_pin_hash = ?, avatar_url = ? WHERE id = ?').run(nick, hash, avatarUrl, user_id);
  // そのままログイン (tablet-login と同等のセッション発行)
  const sid = crypto.randomBytes(16).toString('hex');
  const setupPersonal = !!(req.body && req.body.personal);   // 初回設定も個人スマホと共用タブレットで枠を分ける
  const setupDev = setupPersonal ? 'mobile' : 'kiosk';
  if (setupPersonal) {
    db.prepare("UPDATE users SET mobile_session_token = ?, session_token = ?, last_seen_at = datetime('now') WHERE id = ?").run(sid, sid, user.id);
  } else {
    db.prepare("UPDATE users SET kiosk_session_token = ?, last_seen_at = datetime('now') WHERE id = ?").run(sid, user.id);
  }
  db.prepare("INSERT INTO positions (user_id, x, y, status) VALUES (?, ?, ?, 'online') ON CONFLICT(user_id) DO UPDATE SET status='online', updated_at=datetime('now')")
    .run(user.id, 400 + Math.floor(Math.random() * 200) - 100, 300 + Math.floor(Math.random() * 200) - 100);
  const token = generateToken({ uid: user.id, role: user.role, sid, dev: setupDev });
  const needsConsent = user.role !== 'bot' && user.consent_version !== CONSENT_VERSION;
  res.json({
    success: true,
    token,
    user: {
      uid: user.id, login_id: user.login_id, display_name: user.display_name,
      company_code: user.company_code, role: user.role,
      employee_type: user.employee_type || 'office', avatar_url: avatarUrl,
      job_role: user.job_role || null,
      is_field_promoter: !!user.is_field_promoter, is_warehouse_promoter: !!user.is_warehouse_promoter,
      is_guest_reviewer: !!user.is_guest_reviewer,
      nickname: nick || null, needs_nickname_setup: !nick,
      consent_version: user.consent_version || null, needs_consent: needsConsent,
      current_consent_version: CONSENT_VERSION,
    },
  });
});

// 本人による生年月日の入力/更新 (マイページ)
router.post('/birth-date', authUser, express.json(), (req, res) => {
  const raw = String((req.body && req.body.birth_date) || '').trim();
  const m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return res.status(400).json({ success: false, msg: '生年月日は YYYY-MM-DD 形式で入力してください' });
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return res.status(400).json({ success: false, msg: '日付が不正です' });
  const norm = m[1] + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  getDb().prepare('UPDATE users SET birth_date = ? WHERE id = ?').run(norm, req.uid);
  res.json({ success: true, birth_date: norm, msg: '生年月日を保存しました' });
});

module.exports = router;
