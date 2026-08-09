// 推進メンバー(現場/倉庫)・管理職 向け 現場オンボーディング
// 役割分担: アカウント作成+生年月日は管理者(enroll.js)のまま。
//          ここでは「顔写真(アバター)+初期PIN」だけを自拠点の社員に設定する。
//          → 生年月日など要配慮に触れずに、推進メンバーがキオスク用の顔写真/PINを現場で用意できる。
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateAvatarOne } = require('../services/ai');

// 職種→権限軸(employee_type) (enroll.js と同じ)
const JOB_ROLES = [
  { v: 'driver',        label: 'ドライバー', etype: 'field' },
  { v: 'warehouse',     label: '倉庫荷役',   etype: 'field' },
  { v: 'office',        label: '事務',       etype: 'office' },
  { v: 'construction',  label: '施工',       etype: 'field' },
  { v: 'manufacturing', label: '製造',       etype: 'field' },
];
function etypeForJob(j) { const x = JOB_ROLES.find(r => r.v === j); return x ? x.etype : 'field'; }
// キオスクは顔+PINで入るのでログインIDは自動採番(本人は意識しない)
function genLoginId(db) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (let n = 0; n < 50; n++) {
    let s = 'm_';
    for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
    if (!db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(s)) return s;
  }
  return 'm_' + crypto.randomUUID().slice(0, 10);
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function ensureDir() {
  const dir = path.join(__dirname, '..', '..', 'uploads', 'avatars');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 監査ログ (誰が誰をオンボーディングしたか) — 内部統制用、削除しない
function ensureAuditTable(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS field_enroll_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    action TEXT NOT NULL,
    consent INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
}
function audit(db, operatorId, targetId, action, consent) {
  try { ensureAuditTable(db); db.prepare('INSERT INTO field_enroll_log (operator_id, target_id, action, consent) VALUES (?, ?, ?, ?)').run(operatorId, targetId, action, consent ? 1 : 0); } catch (e) {}
}

function operator(uid) {
  return getDb().prepare('SELECT id, company_code, role, employee_type, is_field_promoter, is_warehouse_promoter, is_manager FROM users WHERE id = ?').get(uid);
}
function isWide(op) {
  return op && (op.role === 'admin' || op.employee_type === 'admin' || !!op.is_manager);
}
function canOnboard(op) {
  if (!op) return false;
  return isWide(op) || !!op.is_field_promoter || !!op.is_warehouse_promoter;
}
// 対象者を設定できるか: 管理職/adminは全社、推進メンバーは自拠点の一般社員のみ(管理職/adminは不可)
function canActOn(op, target) {
  if (!target || target.role === 'bot') return false;
  if (isWide(op)) return true;
  if (target.role === 'admin' || target.is_manager) return false;
  return (op.company_code || '') !== '' && target.company_code === op.company_code;
}

// 自拠点の名簿 (顔写真/PIN設定状況つき)。認証必須・拠点スコープ。
router.get('/roster', authUser, (req, res) => {
  const op = operator(req.uid);
  if (!canOnboard(op)) return res.status(403).json({ success: false, msg: '登録権限がありません' });
  const db = getDb();
  const base = `SELECT id, display_name, company_code, avatar_url, is_manager, role,
      CASE WHEN tablet_pin_hash IS NOT NULL AND tablet_pin_hash <> '' THEN 1 ELSE 0 END AS has_pin,
      CASE WHEN avatar_url IS NOT NULL AND avatar_url <> '' THEN 1 ELSE 0 END AS has_avatar
    FROM users WHERE role != 'bot' AND is_guest_reviewer = 0`;
  let rows;
  if (isWide(op)) rows = db.prepare(base + ' ORDER BY company_code, display_name').all();
  else rows = db.prepare(base + ' AND company_code = ? ORDER BY display_name').all(op.company_code || '');
  res.json({ success: true, can_act_all: isWide(op), own_company: op.company_code, users: rows });
});

// 顔写真 → アバター生成して対象者に保存
router.post('/avatar', authUser, upload.single('photo'), async (req, res) => {
  const op = operator(req.uid);
  if (!canOnboard(op)) return res.status(403).json({ success: false, msg: '登録権限がありません' });
  const db = getDb();
  const targetId = String((req.body && req.body.target_user_id) || '');
  const consent = String((req.body && req.body.consent) || '') === '1';
  const target = db.prepare('SELECT id, company_code, role, is_manager, avatar_url FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ success: false, msg: '対象者が見つかりません' });
  if (!canActOn(op, target)) return res.status(403).json({ success: false, msg: 'この対象者を設定する権限がありません' });
  if (!consent) return res.status(400).json({ success: false, msg: '本人の同意確認が必要です' });
  if (!req.file) return res.status(400).json({ success: false, msg: '写真がありません' });
  try {
    const base64 = req.file.buffer.toString('base64');
    const r = await generateAvatarOne(base64, req.file.mimetype || 'image/jpeg', 'bright');
    const dir = ensureDir();
    const ext = (r.mime_type || '').includes('png') ? 'png' : 'jpg';
    const filename = 'enroll_' + target.id.slice(0, 8) + '_' + Date.now() + '.' + ext;
    fs.writeFileSync(path.join(dir, filename), Buffer.from(r.data, 'base64'));
    const url = '/uploads/avatars/' + filename;
    const prev = target.avatar_url;
    db.prepare("UPDATE users SET avatar_url = ?, avatar_style = 'anime' WHERE id = ?").run(url, target.id);
    // 旧自動生成アバターを掃除
    if (prev && prev.indexOf('/uploads/avatars/') === 0 && prev !== url) {
      try { fs.unlinkSync(path.join(dir, path.basename(prev))); } catch (e) {}
    }
    audit(db, req.uid, target.id, 'avatar', consent);
    res.json({ success: true, avatar_url: url });
  } catch (e) {
    console.error('[field-enroll/avatar]', e);
    res.status(500).json({ success: false, msg: e.message });
  }
});

// ===== タブレット初回設定用: 本人がその場でAIアバターを生成 (未認証キオスク) =====
// gate: 対象が存在・bot/ゲスト以外・PIN未設定(初回設定中)のみ。photoはdataURL(JSON)。認証は不要だが
//       tablet-setup(auth.js)と同じく「未設定ユーザーのみ」に限定して乱用を防ぐ。
router.post('/tablet-avatar', express.json({ limit: '8mb' }), async (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const userId = String(b.user_id || '');
  const photo = String(b.photo || '');
  const target = db.prepare('SELECT id, role, is_guest_reviewer, tablet_pin_hash, avatar_url FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ success: false, msg: '対象者が見つかりません' });
  if (target.role === 'bot' || target.is_guest_reviewer) return res.status(403).json({ success: false, msg: '対象外のユーザーです' });
  if (target.tablet_pin_hash) return res.status(409).json({ success: false, msg: '既にPIN設定済みです' });
  const mm = photo.match(/^data:image\/(png|jpe?g);base64,(.+)$/);
  if (!mm) return res.status(400).json({ success: false, msg: '写真がありません' });
  try {
    const mime = 'image/' + (mm[1].charAt(0) === 'j' ? 'jpeg' : mm[1]);
    const r = await generateAvatarOne(mm[2], mime, 'bright');
    const dir = ensureDir();
    const ext = (r.mime_type || '').includes('png') ? 'png' : 'jpg';
    const filename = 'tablet_' + target.id.slice(0, 8) + '_' + Date.now() + '.' + ext;
    fs.writeFileSync(path.join(dir, filename), Buffer.from(r.data, 'base64'));
    const url = '/uploads/avatars/' + filename;
    const prev = target.avatar_url;
    db.prepare("UPDATE users SET avatar_url = ?, avatar_style = 'anime' WHERE id = ?").run(url, target.id);
    // 直前に生成した候補アバターを掃除 (撮り直し連打の残骸)
    if (prev && prev.indexOf('/uploads/avatars/') === 0 && prev !== url) {
      try { fs.unlinkSync(path.join(dir, path.basename(prev))); } catch (e) {}
    }
    res.json({ success: true, avatar_url: url });
  } catch (e) {
    console.error('[field-enroll/tablet-avatar]', e);
    res.status(500).json({ success: false, msg: e.message || 'アバター生成に失敗しました' });
  }
});

// ===== タブレット拠点セレクタ用の会社一覧 (未認証) =====
// 会社名はDBが正。タブレットのハードコード名を排し、空拠点(新設工場など)もセレクタに出せるように。
// ゲスト用バケット(GUEST/UNIVERSITY/NPO)は現場拠点でないため除外。
router.get('/companies', (req, res) => {
  try {
    const rows = getDb().prepare(
      "SELECT code, name, ring_color FROM companies WHERE code NOT IN ('GUEST','UNIVERSITY','NPO') ORDER BY name"
    ).all();
    res.json({ success: true, companies: rows });
  } catch (e) {
    res.status(500).json({ success: false, msg: e.message });
  }
});

// 初期PIN設定 (4桁・弱いPIN拒否)
router.post('/pin', authUser, express.json(), (req, res) => {
  const op = operator(req.uid);
  if (!canOnboard(op)) return res.status(403).json({ success: false, msg: '登録権限がありません' });
  const b = req.body || {};
  const targetId = String(b.target_user_id || '');
  const pin = String(b.pin || '');
  const consent = !!b.consent;
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ success: false, msg: 'PINは4桁の数字です' });
  if (/^(.)\1{3}$/.test(pin)) return res.status(400).json({ success: false, msg: '同じ数字4桁は使えません (例: 0000)' });
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return res.status(400).json({ success: false, msg: '連続した数字は使えません (例: 1234)' });
  const db = getDb();
  const target = db.prepare('SELECT id, company_code, role, is_manager FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ success: false, msg: '対象者が見つかりません' });
  if (!canActOn(op, target)) return res.status(403).json({ success: false, msg: 'この対象者を設定する権限がありません' });
  const hash = bcrypt.hashSync(pin, 10);
  db.prepare('UPDATE users SET tablet_pin_hash = ? WHERE id = ?').run(hash, target.id);
  audit(db, req.uid, target.id, 'pin', consent);
  res.json({ success: true, msg: '初期PINを設定しました。本人に伝え、後で本人が変更できます。' });
});

// ===== 案A: 推進メンバーが「写真+名前+拠点+職種」で仮登録 → 本人がその場で生年月日/ニックネーム/PINを設定 =====

// 仮登録フォーム用メタ (拠点・職種)。推進メンバーは自拠点のみ。
router.get('/meta', authUser, (req, res) => {
  const op = operator(req.uid);
  if (!canOnboard(op)) return res.status(403).json({ success: false, msg: '登録権限がありません' });
  const db = getDb();
  let companies;
  if (isWide(op)) companies = db.prepare('SELECT code, name FROM companies ORDER BY code').all();
  else companies = db.prepare('SELECT code, name FROM companies WHERE code = ?').all(op.company_code || '');
  // 所属グループ(dm_group)候補 — 新規登録(enroll)と同一の選択肢にするため
  const dmGroups = db.prepare(`
    SELECT dm_group AS name, COUNT(*) AS cnt FROM users
    WHERE dm_group IS NOT NULL AND dm_group != '' AND role != 'bot'
    GROUP BY dm_group ORDER BY cnt DESC, dm_group
  `).all();
  res.json({ success: true, is_wide: isWide(op), own_company: op.company_code, companies, job_roles: JOB_ROLES, dm_groups: dmGroups });
});

// 推進メンバー: 仮登録 (写真→アバター + 表示名 + 拠点 + 職種)。生年月日/PIN/ニックネームは本人が後で設定。
router.post('/provisional', authUser, upload.single('photo'), async (req, res) => {
  const op = operator(req.uid);
  if (!canOnboard(op)) return res.status(403).json({ success: false, msg: '登録権限がありません' });
  const db = getDb();
  const displayName = String((req.body && req.body.display_name) || '').trim();
  const companyCode = String((req.body && req.body.company_code) || '').trim();
  const jobRole = String((req.body && req.body.job_role) || '').trim();
  const consent = String((req.body && req.body.consent) || '') === '1';
  if (!displayName || displayName.length > 80) return res.status(400).json({ success: false, msg: '表示名は1〜80文字で必須' });
  if (!companyCode) return res.status(400).json({ success: false, msg: '拠点を選択してください' });
  if (!JOB_ROLES.some(j => j.v === jobRole)) return res.status(400).json({ success: false, msg: '職種を選択してください' });
  if (!consent) return res.status(400).json({ success: false, msg: '本人の同意確認が必要です' });
  // 拠点スコープ: 推進メンバーは自拠点のみ
  if (!isWide(op) && companyCode !== op.company_code) return res.status(403).json({ success: false, msg: '自拠点のみ登録できます' });
  const c = db.prepare('SELECT code, name FROM companies WHERE code = ?').get(companyCode);
  if (!c) return res.status(400).json({ success: false, msg: '拠点コードが不正です' });

  let avatarUrl = null;
  if (req.file) {
    try {
      const base64 = req.file.buffer.toString('base64');
      const r = await generateAvatarOne(base64, req.file.mimetype || 'image/jpeg', 'bright');
      const dir = ensureDir();
      const ext = (r.mime_type || '').includes('png') ? 'png' : 'jpg';
      const filename = 'enroll_prov_' + Date.now() + '.' + ext;
      fs.writeFileSync(path.join(dir, filename), Buffer.from(r.data, 'base64'));
      avatarUrl = '/uploads/avatars/' + filename;
    } catch (e) { console.error('[field-enroll/provisional avatar]', e); return res.status(500).json({ success: false, msg: 'アバター生成に失敗: ' + e.message }); }
  }

  const id = crypto.randomUUID();
  const loginId = genLoginId(db);
  const employeeType = etypeForJob(jobRole);
  // ログインPWはランダム(本人はキオスクの顔+PINで入るため通常ログインは想定しない)
  const pwHash = bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 10);
  // 所属グループ: フォーム指定(新規登録と同様)。未指定なら拠点名を既定値。
  const dmGroupInput = String((req.body && req.body.dm_group) || '').trim().slice(0, 40);
  const dmGroup = dmGroupInput || c.name || null;
  db.prepare(`INSERT INTO users
    (id, login_id, password_hash, display_name, company_code, role, employee_type, job_role, dm_group, dm_rank, dm_restricted, avatar_url, avatar_style)
    VALUES (?, ?, ?, ?, ?, 'member', ?, ?, ?, 0, 1, ?, ?)`)
    .run(id, loginId, pwHash, displayName, companyCode, employeeType, jobRole, dmGroup, avatarUrl, avatarUrl ? 'anime' : null);
  // 所属グループへ自動加入 (enroll と同様)
  if (dmGroup) {
    try {
      let g = db.prepare('SELECT id FROM chat_groups WHERE name = ?').get(dmGroup);
      let gid = g ? g.id : crypto.randomUUID();
      if (!g) db.prepare('INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)').run(gid, dmGroup, '🏢', req.uid);
      db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(gid, id);
    } catch (e) { console.warn('[field-enroll] group join failed', e.message); }
  }
  audit(db, req.uid, id, 'provisional', consent);
  // 本人が自分で完了するための短命セットアップトークン(45分・この新規ユーザー名義)
  const setupToken = jwt.sign({ uid: id, purpose: 'setup' }, process.env.JWT_SECRET, { expiresIn: '45m' });
  res.json({ success: true, user_id: id, display_name: displayName, avatar_url: avatarUrl, setup_token: setupToken });
});

// 本人: セットアップトークンで 生年月日 + ニックネーム + PIN を自分で設定して完了
router.post('/self-setup', express.json(), (req, res) => {
  const b = req.body || {};
  const tokenStr = String(b.setup_token || '');
  if (!tokenStr) return res.status(400).json({ success: false, msg: 'セットアップ情報がありません' });
  let payload;
  try { payload = jwt.verify(tokenStr, process.env.JWT_SECRET); } catch (e) { return res.status(401).json({ success: false, msg: 'セットアップの有効期限が切れました。推進メンバーに再登録を依頼してください' }); }
  if (!payload || payload.purpose !== 'setup' || !payload.uid) return res.status(401).json({ success: false, msg: 'セットアップ情報が不正です' });

  const nickname = String(b.nickname || '').trim();
  const birthDate = String(b.birth_date || '').trim();
  const pin = String(b.pin || '');
  // ニックネーム
  if (nickname.length < 2 || nickname.length > 20) return res.status(400).json({ success: false, msg: 'ニックネームは2〜20文字で設定してください' });
  if (/[\x00-\x1f\x7f]/.test(nickname)) return res.status(400).json({ success: false, msg: 'ニックネームに使えない文字が含まれています' });
  // 生年月日
  const m = birthDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return res.status(400).json({ success: false, msg: '生年月日はYYYY-MM-DD形式で入力してください' });
  const by = parseInt(m[1]), bm = parseInt(m[2]), bd = parseInt(m[3]);
  if (by < 1900 || by > 2099 || bm < 1 || bm > 12 || bd < 1 || bd > 31) return res.status(400).json({ success: false, msg: '生年月日が不正です' });
  const normBirth = by + '-' + String(bm).padStart(2, '0') + '-' + String(bd).padStart(2, '0');
  // PIN
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ success: false, msg: 'PINは4桁の数字です' });
  if (/^(.)\1{3}$/.test(pin)) return res.status(400).json({ success: false, msg: '同じ数字4桁は使えません (例: 0000)' });
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return res.status(400).json({ success: false, msg: '連続した数字は使えません (例: 1234)' });

  const db = getDb();
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(payload.uid);
  if (!u) return res.status(404).json({ success: false, msg: '対象が見つかりません' });
  const dup = db.prepare('SELECT id FROM users WHERE LOWER(nickname) = LOWER(?) AND id != ?').get(nickname, payload.uid);
  if (dup) return res.status(409).json({ success: false, msg: 'そのニックネームは既に使われています。別のものをお試しください' });
  const pinHash = bcrypt.hashSync(pin, 10);
  db.prepare('UPDATE users SET nickname = ?, birth_date = ?, tablet_pin_hash = ? WHERE id = ?').run(nickname, normBirth, pinHash, payload.uid);
  audit(db, payload.uid, payload.uid, 'self_setup', 1);
  res.json({ success: true, msg: '登録が完了しました。お疲れさまでした！' });
});

module.exports = router;
