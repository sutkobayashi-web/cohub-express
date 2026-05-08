// 拠点管理者向け 社員簡易登録 (写真→アバター→登録)
// 権限: role='admin' / employee_type='admin' / is_field_promoter / is_warehouse_promoter
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
  const u = getDb().prepare('SELECT employee_type, role, is_field_promoter, is_warehouse_promoter FROM users WHERE id = ?').get(uid);
  if (!u) return false;
  return u.role === 'admin' || u.employee_type === 'admin' || !!u.is_field_promoter || !!u.is_warehouse_promoter;
}

// 紛らわしい0/O/1/l/I を除外した英数8文字
function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

// メタ: 拠点・配属候補・雇用区分
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
  const dmGroups = db.prepare("SELECT DISTINCT dm_group FROM users WHERE dm_group IS NOT NULL AND dm_group != '' ORDER BY dm_group").all().map(r => r.dm_group);
  res.json({
    success: true,
    is_admin: me.role === 'admin',
    own_company: me.company_code,
    companies,
    dm_groups: dmGroups,
    employee_types: [{ v: 'office', label: '事務' }, { v: 'field', label: '現場' }],
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
  const companyCode = String(b.company_code || '').trim();
  const employeeType = String(b.employee_type || 'field').trim();
  const dmGroup = String(b.dm_group || '').trim().slice(0, 40) || null;
  const birthDate = b.birth_date ? String(b.birth_date).trim() : null;
  const avatarUrl = String(b.avatar_url || '').trim();

  if (!/^[a-z0-9_.-]{3,30}$/.test(loginId)) {
    return res.status(400).json({ success: false, msg: 'login_idは英小文字+数字+_-.のみ、3〜30文字' });
  }
  if (!displayName || displayName.length > 80) {
    return res.status(400).json({ success: false, msg: '表示名は1〜80文字で必須' });
  }
  if (!companyCode) return res.status(400).json({ success: false, msg: '拠点を選択してください' });
  if (!['office', 'field'].includes(employeeType)) {
    return res.status(400).json({ success: false, msg: '雇用区分が不正' });
  }
  if (avatarUrl && !avatarUrl.startsWith('/uploads/avatars/enroll_')) {
    return res.status(400).json({ success: false, msg: 'アバターURLが不正' });
  }
  // 生年月日 YYYY-MM-DD
  if (birthDate) {
    const m = birthDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) return res.status(400).json({ success: false, msg: '生年月日はYYYY-MM-DDで入力' });
  }

  const db = getDb();
  const me = db.prepare('SELECT company_code, role FROM users WHERE id = ?').get(req.uid);
  if (me.role !== 'admin' && companyCode !== me.company_code) {
    return res.status(403).json({ success: false, msg: '他拠点への登録権限がありません' });
  }
  const c = db.prepare('SELECT code FROM companies WHERE code = ?').get(companyCode);
  if (!c) return res.status(400).json({ success: false, msg: '拠点コードが不正' });
  const exists = db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(loginId);
  if (exists) return res.status(409).json({ success: false, msg: 'このログインIDは既に使われています' });

  const password = generatePassword();
  const hash = bcrypt.hashSync(password, 10);
  const id = crypto.randomUUID();
  // 新規一般社員: dm_restricted=1 (部署内DMに限定する安全側デフォルト)
  db.prepare(`INSERT INTO users
    (id, login_id, password_hash, display_name, company_code, role, employee_type, dm_group, dm_rank, dm_restricted, birth_date, avatar_url, avatar_style)
    VALUES (?, ?, ?, ?, ?, 'member', ?, ?, 0, 1, ?, ?, ?)`)
    .run(id, loginId, hash, displayName, companyCode, employeeType, dmGroup, birthDate, avatarUrl || null, avatarUrl ? 'anime' : null);

  // dm_group 指定でチャットグループ自動加入 (なければ作成)
  if (dmGroup) {
    try {
      const grp = db.prepare("SELECT id FROM chat_groups WHERE name = ?").get(dmGroup);
      let gid;
      if (grp) gid = grp.id;
      else {
        gid = 'g_' + crypto.randomUUID().slice(0, 8);
        db.prepare("INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, '🏢', ?)").run(gid, dmGroup, req.uid);
      }
      db.prepare("INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)").run(gid, id);
    } catch (e) { console.warn('[enroll dm_group]', e.message); }
  }

  res.json({
    success: true,
    user: {
      id, login_id: loginId, display_name: displayName,
      company_code: companyCode, avatar_url: avatarUrl || null,
    },
    initial_password: password,
  });
});

module.exports = router;
