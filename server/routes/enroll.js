// 管理職向け 社員簡易登録 (写真→アバター→登録)
// 権限: role='admin' かつ employee_type='admin' のみ (= authAdmin と同等)
// 生年月日を扱う関係で、推進メンバー(is_field_promoter/is_warehouse_promoter)からは権限剥奪 (2026-05-22)
// 拠点制限: role!='admin' は自分の company_code のみ登録可
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateAvatarOne } = require('../services/ai');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function ensureDir() {
  const dir = path.join(__dirname, '..', '..', 'uploads', 'avatars');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function canEnroll(uid) {
  const u = getDb().prepare('SELECT employee_type, role FROM users WHERE id = ?').get(uid);
  if (!u) return false;
  // 管理職のみ。推進メンバーは生年月日露出を避けるため除外。
  return u.role === 'admin' && u.employee_type === 'admin';
}

// 紛らわしい0/O/1/l/I を除外した英数8文字
function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

// 職種 → employee_type(権限軸) の自動マッピング
const JOB_ROLES = [
  { v: 'driver',        label: 'ドライバー',     etype: 'field' },
  { v: 'warehouse',     label: '倉庫荷役',       etype: 'field' },
  { v: 'office',        label: '事務',           etype: 'office' },
  { v: 'construction',  label: '施工',           etype: 'field' },
  { v: 'manufacturing', label: '製造',           etype: 'field' },
];
function etypeForJob(jobRole) {
  const j = JOB_ROLES.find(x => x.v === jobRole);
  return j ? j.etype : 'field';
}

// メタ: 拠点・職種・所属グループ候補
router.get('/meta', authUser, (req, res) => {
  if (!canEnroll(req.uid)) return res.status(403).json({ success: false, msg: '登録権限がありません' });
  const db = getDb();
  const me = db.prepare('SELECT company_code, role FROM users WHERE id = ?').get(req.uid);
  let companies;
  if (me.role === 'admin') {
    companies = db.prepare('SELECT code, name, ring_color FROM companies ORDER BY code').all();
  } else {
    companies = db.prepare('SELECT code, name, ring_color FROM companies WHERE code = ?').all(me.company_code || '');
  }
  // 既存の所属(dm_group)候補。拠点会社名と一致するものを優先表示しつつ、
  // 既存のグループ名 (NPO法人/大学・研究機関/管理職 等) も選択肢に含める
  const dmGroups = db.prepare(`
    SELECT dm_group AS name, COUNT(*) AS cnt FROM users
    WHERE dm_group IS NOT NULL AND dm_group != '' AND role != 'bot'
    GROUP BY dm_group ORDER BY cnt DESC, dm_group
  `).all();
  res.json({
    success: true,
    is_admin: me.role === 'admin',
    own_company: me.company_code,
    companies,
    job_roles: JOB_ROLES,
    dm_groups: dmGroups,
  });
});

// アバター生成 (1枚・明るめアニメ調)
router.post('/generate-avatar', authUser, upload.single('photo'), async (req, res) => {
  if (!canEnroll(req.uid)) return res.status(403).json({ success: false, msg: '登録権限がありません' });
  try {
    if (!req.file) return res.status(400).json({ success: false, msg: '写真が添付されていません' });
    const base64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';
    const r = await generateAvatarOne(base64, mimeType, 'bright');
    const dir = ensureDir();
    const ext = (r.mime_type || '').includes('png') ? 'png' : 'jpg';
    const filename = 'enroll_' + req.uid.slice(0, 8) + '_' + Date.now() + '.' + ext;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, Buffer.from(r.data, 'base64'));
    res.json({ success: true, avatar_url: '/uploads/avatars/' + filename });
  } catch (e) {
    console.error('[enroll/generate-avatar]', e);
    res.status(500).json({ success: false, msg: e.message });
  }
});

// アバター候補破棄 (登録キャンセル時)
router.post('/discard-avatar', authUser, express.json(), (req, res) => {
  const url = String((req.body && req.body.avatar_url) || '');
  if (!url || !url.startsWith('/uploads/avatars/enroll_')) {
    return res.status(400).json({ success: false, msg: '不正なURL' });
  }
  try {
    const p = path.join(__dirname, '..', '..', url.replace(/^\//, ''));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {}
  res.json({ success: true });
});

// 社員登録
router.post('/user', authUser, express.json(), (req, res) => {
  if (!canEnroll(req.uid)) return res.status(403).json({ success: false, msg: '登録権限がありません' });
  const b = req.body || {};
  const loginId = String(b.login_id || '').trim().toLowerCase();
  const displayName = String(b.display_name || '').trim();
  const nickname = String(b.nickname || '').trim();
  const companyCode = String(b.company_code || '').trim();
  const jobRole = String(b.job_role || '').trim();
  const birthDate = b.birth_date ? String(b.birth_date).trim() : null;
  const avatarUrl = String(b.avatar_url || '').trim();
  const dmGroupInput = String(b.dm_group || '').trim();

  if (!/^[a-z0-9_.-]{3,30}$/.test(loginId)) {
    return res.status(400).json({ success: false, msg: 'login_idは英小文字+数字+_-.のみ、3〜30文字' });
  }
  if (!displayName || displayName.length > 80) {
    return res.status(400).json({ success: false, msg: '表示名は1〜80文字で必須' });
  }
  if (!nickname || nickname.length < 2 || nickname.length > 20) {
    return res.status(400).json({ success: false, msg: 'ニックネームは2〜20文字で必須' });
  }
  if (/[\x00-\x1f\x7f]/.test(nickname)) {
    return res.status(400).json({ success: false, msg: 'ニックネームに使えない文字が含まれています' });
  }
  if (!companyCode) return res.status(400).json({ success: false, msg: '拠点を選択してください' });
  if (!JOB_ROLES.some(j => j.v === jobRole)) {
    return res.status(400).json({ success: false, msg: '職種を選択してください' });
  }
  if (avatarUrl && !avatarUrl.startsWith('/uploads/avatars/enroll_')) {
    return res.status(400).json({ success: false, msg: 'アバターURLが不正' });
  }
  // 生年月日 必須 (Box健診データ突合のため)
  if (!birthDate) return res.status(400).json({ success: false, msg: '生年月日は必須です (健診データ突合のため)' });
  const m = birthDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return res.status(400).json({ success: false, msg: '生年月日はYYYY-MM-DD形式で入力' });
  const by = parseInt(m[1]), bm = parseInt(m[2]), bd = parseInt(m[3]);
  if (by < 1900 || by > 2099 || bm < 1 || bm > 12 || bd < 1 || bd > 31) {
    return res.status(400).json({ success: false, msg: '生年月日が不正です' });
  }
  const normalizedBirth = by + '-' + String(bm).padStart(2, '0') + '-' + String(bd).padStart(2, '0');
  const employeeType = etypeForJob(jobRole);

  const db = getDb();
  const me = db.prepare('SELECT company_code, role FROM users WHERE id = ?').get(req.uid);
  if (me.role !== 'admin' && companyCode !== me.company_code) {
    return res.status(403).json({ success: false, msg: '他拠点への登録権限がありません' });
  }
  const c = db.prepare('SELECT code, name FROM companies WHERE code = ?').get(companyCode);
  if (!c) return res.status(400).json({ success: false, msg: '拠点コードが不正' });
  const exists = db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(loginId);
  if (exists) return res.status(409).json({ success: false, msg: 'このログインIDは既に使われています' });
  // ニックネーム重複 (大小無視・完全一致)
  const dupNick = db.prepare('SELECT id FROM users WHERE LOWER(nickname) = LOWER(?)').get(nickname);
  if (dupNick) return res.status(409).json({ success: false, msg: 'そのニックネームは既に使われています' });

  // 所属(dm_group) 未指定なら拠点名(companies.name)を既定値とする
  const dmGroup = dmGroupInput || c.name || '';

  const password = generatePassword();
  const hash = bcrypt.hashSync(password, 10);
  const id = crypto.randomUUID();
  // 新規一般社員: dm_restricted=1 (部署内DMに限定する安全側デフォルト)
  db.prepare(`INSERT INTO users
    (id, login_id, password_hash, display_name, nickname, company_code, role, employee_type, job_role, dm_group, dm_rank, dm_restricted, birth_date, avatar_url, avatar_style)
    VALUES (?, ?, ?, ?, ?, ?, 'member', ?, ?, ?, 0, 1, ?, ?, ?)`)
    .run(id, loginId, hash, displayName, nickname, companyCode, employeeType, jobRole, dmGroup || null, normalizedBirth, avatarUrl || null, avatarUrl ? 'anime' : null);

  // 所属(dm_group)に対応する chat_groups に自動加入。無ければ作成。
  // (admin.js /auto-assign-from-company と同じロジックの個人版)
  let joinedGroup = null;
  if (dmGroup) {
    try {
      let g = db.prepare('SELECT id FROM chat_groups WHERE name = ?').get(dmGroup);
      let gid;
      if (g) {
        gid = g.id;
      } else {
        gid = crypto.randomUUID();
        db.prepare('INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)')
          .run(gid, dmGroup, '🏢', req.uid);
      }
      db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(gid, id);
      joinedGroup = dmGroup;
    } catch (e) {
      console.warn('[enroll] chat group join failed', e.message);
    }
  }

  res.json({
    success: true,
    user: {
      id, login_id: loginId, display_name: displayName, nickname,
      company_code: companyCode, job_role: jobRole, avatar_url: avatarUrl || null,
      dm_group: dmGroup || null,
    },
    joined_group: joinedGroup,
    initial_password: password,
  });
});

module.exports = router;
