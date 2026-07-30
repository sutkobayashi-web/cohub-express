const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { audit } = require('../services/audit');

const LEVELS = ['normal', 'important', 'urgent'];

// 通達作成権限: 管理部の固定6名のみ (2026-05-21)
//   吉沢佑也, 小林猛, 須貝栄二, 後藤裕司, 金子力, 岡田恭司
const ALLOWED_CREATORS = new Set([
  'b097b512-468b-4161-a273-2e96ee589960', // 吉沢　佑也
  '7cf1bd9c-5c97-495d-84e8-5339583a5e6c', // 小林　猛
  '0da5798c-335e-42f4-8842-c08630453ffd', // 須貝　栄二
  '918f29f1-a030-4176-af28-a694067ffefc', // 後藤　裕司
  '0717f9c9-472d-4f5f-831d-3c54ce019327', // 金子　力
  '4c170870-33f5-45d6-a0dd-760adee79526', // 岡田　恭司
]);
function canCreate(uid) { return ALLOWED_CREATORS.has(uid); }
router.get('/can-create', authUser, (req, res) => {
  res.json({ success: true, can_create: canCreate(req.uid) });
});

// 親会社グループ (旧 group: target の後方互換用): company_code 接頭辞で判定
function groupOf(code) {
  const c = String(code || '');
  if (/^SUZUE/.test(c)) return 'SUZUE';
  if (/^SU(_|$)/.test(c)) return 'SU';
  if (/^IBA/.test(c)) return 'IBA';
  return 'ETC';
}

// 送付先ディレクトリ (作成者のみ): 営業所(DM分類 dm_group)→役職職種(job_role)→個人 のカスケード用
router.get('/directory', authUser, (req, res) => {
  if (!canCreate(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const db = getDb();
  const rows = db.prepare(`SELECT id, display_name, dm_group, job_role
                           FROM users
                           WHERE role != 'bot' AND COALESCE(status, 'active') = 'active'
                           ORDER BY display_name`).all();
  const users = rows.map(u => ({ id: u.id, name: u.display_name, office: u.dm_group || '', role: u.job_role || '' }));
  // 営業所(dm_group)一覧 — 実在するもののみ、未設定は末尾
  const officeCount = {};
  for (const u of users) officeCount[u.office] = (officeCount[u.office] || 0) + 1;
  const offices = Object.keys(officeCount)
    .map(k => ({ key: k, name: k || '（営業所未設定）', count: officeCount[k] }))
    .sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : String(a.name).localeCompare(String(b.name), 'ja')));
  res.json({ success: true, offices, users });
});

// 添付ファイル保存
const attachDir = path.join(__dirname, '..', '..', 'uploads', 'announcements');
if (!fs.existsSync(attachDir)) fs.mkdirSync(attachDir, { recursive: true });
const ALLOWED_MIME = /^(image\/|application\/pdf$|application\/vnd\.openxmlformats-officedocument\.|application\/msword$|application\/vnd\.ms-(excel|powerpoint)$|text\/plain$|text\/csv$)/;
const attachUpload = multer({
  storage: multer.diskStorage({
    destination: attachDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').slice(0, 10) || '').replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.test(file.mimetype || '')) return cb(null, true);
    cb(new Error('PDF/画像/Office/テキストのみ添付可'));
  },
});

// 起動時スキーマ移行: attachments 列追加
try {
  const db = getDb();
  const cols = new Set(db.prepare('PRAGMA table_info(announcements)').all().map(c => c.name));
  if (!cols.has('attachments')) {
    db.prepare("ALTER TABLE announcements ADD COLUMN attachments TEXT").run();
    console.log('[announcements] migrated: attachments column');
  }
} catch (e) { console.warn('[announcements] migration skipped:', e.message); }

function parseAttachments(row) {
  if (!row) return row;
  let atts = [];
  if (row.attachments) {
    try { atts = JSON.parse(row.attachments); if (!Array.isArray(atts)) atts = []; } catch (e) { atts = []; }
  }
  row.attachments = atts;
  return row;
}

// 対象判定: target='all' | 'company:CODE' | 'building:office|field' | 'role:admin' など
function userMatchesTarget(uid, target) {
  if (!target || target === 'all') return true;
  const u = getDb().prepare('SELECT company_code, role, employee_type, dm_group, job_role FROM users WHERE id = ?').get(uid);
  if (!u) return false;
  // 値に日本語(空白含む)が入るため split(':') ではなく最初の ':' で分割
  const t = String(target);
  const ci = t.indexOf(':');
  const kind = ci < 0 ? t : t.slice(0, ci);
  const val = ci < 0 ? '' : t.slice(ci + 1);
  // 現行方式: 営業所(DM分類) → 役職職種 → 個人
  if (kind === 'user') return uid === val;                       // 個人宛(単数)
  if (kind === 'users') return val.split(',').includes(uid);     // 個人宛(複数)
  if (kind === 'dmg') return (u.dm_group || '') === val;         // 営業所 (dm_group)
  if (kind === 'jobrole') return (u.job_role || '') === val;     // 役職・職種 (全社横断)
  if (kind === 'dmgr') {                                         // 営業所 × 役職職種
    const at = val.indexOf('@');
    if (at < 0) return false;
    return (u.dm_group || '') === val.slice(0, at) && (u.job_role || '') === val.slice(at + 1);
  }
  // 旧方式 (既存通達の後方互換)
  if (kind === 'company') return u.company_code === val;
  if (kind === 'building') return u.employee_type === val;      // office | field | admin
  if (kind === 'role') return u.role === val;
  if (kind === 'group') return groupOf(u.company_code) === val; // 親会社グループ
  return false;
}

// 通達一覧 (新着順、過去通達も含めて全件表示)
router.get('/', authUser, (req, res) => {
  const onlyUnread = req.query.unread === '1';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const db = getDb();
  // 期限フィルタは外す: 過去通達も閲覧可能 (2026-05-21)
  const all = db.prepare(`SELECT a.*, u.display_name AS author_name,
                                 r.read_at, r.acked_at
                          FROM announcements a
                          LEFT JOIN users u ON u.id = a.author_id
                          LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
                          WHERE a.deleted_at IS NULL
                          ORDER BY a.id DESC LIMIT ?`).all(req.uid, limit);
  const filtered = all.filter(a => userMatchesTarget(req.uid, a.target)).map(parseAttachments);
  const list = onlyUnread ? filtered.filter(a => !a.read_at) : filtered;
  res.json({ success: true, announcements: list });
});

// 未読件数 (バッジ表示用、軽量)
router.get('/unread-count', authUser, (req, res) => {
  const db = getDb();
  const all = db.prepare(`SELECT a.id, a.target, a.level, a.requires_ack, r.read_at, r.acked_at
                          FROM announcements a
                          LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
                          WHERE a.deleted_at IS NULL
                            AND (a.expires_at IS NULL OR a.expires_at >= datetime('now'))`).all(req.uid);
  let count = 0;
  let hasUnackedImportant = false;
  for (const a of all) {
    if (!userMatchesTarget(req.uid, a.target)) continue;
    const unread = !a.read_at;
    const needsAck = a.requires_ack && !a.acked_at;
    if (unread || needsAck) count++;
    if ((a.level === 'important' || a.level === 'urgent') && (unread || needsAck)) {
      hasUnackedImportant = true;
    }
  }
  res.json({ success: true, count, has_important_unread: hasUnackedImportant });
});

// 重要/緊急の未確認告知1件 (強制ポップアップ用、最も重要な1件を返す)
router.get('/popup-next', authUser, (req, res) => {
  const db = getDb();
  const all = db.prepare(`SELECT a.*, u.display_name AS author_name,
                                 r.read_at, r.acked_at
                          FROM announcements a
                          LEFT JOIN users u ON u.id = a.author_id
                          LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
                          WHERE a.deleted_at IS NULL
                            AND (a.expires_at IS NULL OR a.expires_at >= datetime('now'))
                            AND a.level IN ('important', 'urgent')
                          ORDER BY (a.level = 'urgent') DESC, a.id DESC`).all(req.uid);
  for (const a of all) {
    if (!userMatchesTarget(req.uid, a.target)) continue;
    const unread = !a.read_at;
    const needsAck = a.requires_ack && !a.acked_at;
    if (unread || needsAck) {
      return res.json({ success: true, announcement: parseAttachments(a) });
    }
  }
  res.json({ success: true, announcement: null });
});

// 既読マーク
router.post('/:id/read', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT id FROM announcements WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  db.prepare(`INSERT INTO announcement_reads (announcement_id, user_id) VALUES (?, ?)
              ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at = datetime('now')`)
    .run(id, req.uid);
  res.json({ success: true });
});

// 確認ボタン押下
router.post('/:id/ack', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT id, requires_ack FROM announcements WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!a.requires_ack) return res.status(400).json({ success: false, msg: 'この告知は確認不要です' });
  db.prepare(`INSERT INTO announcement_reads (announcement_id, user_id, acked_at)
              VALUES (?, ?, datetime('now'))
              ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at = COALESCE(read_at, datetime('now')), acked_at = datetime('now')`)
    .run(id, req.uid);
  res.json({ success: true });
});

// 新規作成 (管理部6名のみ、PDF/画像/Office添付可、最大5件・各30MB)
router.post('/', authUser, (req, res, next) => {
  // 認可チェックを先に (multer 起動前に弾く)
  if (!canCreate(req.uid)) return res.status(403).json({ success: false, msg: '通達作成は管理部のみ可能です' });
  attachUpload.array('files', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, msg: err.message || 'アップロード失敗' });
    next();
  });
}, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').slice(0, 100).trim();
  const body = String(b.body || '').slice(0, 4000).trim();
  if (!title || !body) return res.status(400).json({ success: false, msg: 'タイトルと本文は必須' });
  const level = LEVELS.includes(b.level) ? b.level : 'normal';
  const requiresAck = (b.requires_ack === '1' || b.requires_ack === 'true' || b.requires_ack === true) ? 1 : 0;
  const target = String(b.target || 'all').slice(0, 4000);  // users: 複数IDで長くなるため
  const expiresAt = b.expires_at ? String(b.expires_at).slice(0, 30) : null;
  const atts = (req.files || []).map(f => ({
    url: '/uploads/announcements/' + f.filename,
    name: String(f.originalname || '').slice(0, 200),
    mime: f.mimetype || '',
    size: f.size || 0,
  }));
  const attsJson = atts.length ? JSON.stringify(atts) : null;
  const db = getDb();
  const ins = db.prepare(`INSERT INTO announcements
    (author_id, title, body, level, requires_ack, target, expires_at, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.uid, title, body, level, requiresAck, target, expiresAt, attsJson);
  const id = ins.lastInsertRowid;
  audit(req, 'announce_create', { target: 'id=' + id + ' [' + level + '] ' + title.slice(0, 40) });

  // 全社realtime + Push通知
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('announcement:new', { id, level, requires_ack: requiresAck, title });
  // Push通知 (重要/緊急は全員、normalは送らない)
  if (level === 'important' || level === 'urgent') {
    const targets = db.prepare('SELECT id, company_code, role, employee_type FROM users').all();
    const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
    const icon = level === 'urgent' ? '🚨' : '📢';
    if (sendPush) {
      for (const t of targets) {
        if (!userMatchesTarget(t.id, target)) continue;
        sendPush(t.id, {
          title: `${icon} ${title}`,
          body: body.slice(0, 120),
          tag: 'announce-' + id,
          url: '/announcements.html#a-' + id,
        }).catch(() => {});
      }
    }
  }
  res.json({ success: true, id });
});

// 更新 (作成者または管理職)
router.put('/:id', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (a.author_id !== req.uid && !canCreate(req.uid)) {
    return res.status(403).json({ success: false, msg: '権限なし' });
  }
  const b = req.body || {};
  const updates = [];
  const params = [];
  if (b.title !== undefined) { updates.push('title = ?'); params.push(String(b.title).slice(0, 100)); }
  if (b.body !== undefined) { updates.push('body = ?'); params.push(String(b.body).slice(0, 4000)); }
  if (b.level !== undefined && LEVELS.includes(b.level)) { updates.push('level = ?'); params.push(b.level); }
  if (b.requires_ack !== undefined) { updates.push('requires_ack = ?'); params.push(b.requires_ack ? 1 : 0); }
  if (b.target !== undefined) { updates.push('target = ?'); params.push(String(b.target).slice(0, 4000)); }
  if (b.expires_at !== undefined) { updates.push('expires_at = ?'); params.push(b.expires_at || null); }
  if (!updates.length) return res.json({ success: true, msg: '変更なし' });
  params.push(id);
  db.prepare(`UPDATE announcements SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// 削除 (作成者または管理職、論理削除)
router.delete('/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT author_id FROM announcements WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (a.author_id !== req.uid && !canCreate(req.uid)) {
    return res.status(403).json({ success: false, msg: '権限なし' });
  }
  db.prepare("UPDATE announcements SET deleted_at = datetime('now') WHERE id = ?").run(id);
  audit(req, 'announce_delete', { target: 'id=' + id });
  res.json({ success: true });
});

// 既読率/未読者リスト (作成者または管理職)
router.get('/:id/reads', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (a.author_id !== req.uid && !canCreate(req.uid)) {
    return res.status(403).json({ success: false, msg: '権限なし' });
  }
  // 対象ユーザー全件
  const allUsers = db.prepare('SELECT id, display_name, company_code, role, employee_type FROM users').all();
  const targets = allUsers.filter(u => userMatchesTarget(u.id, a.target));
  const reads = db.prepare('SELECT user_id, read_at, acked_at FROM announcement_reads WHERE announcement_id = ?').all(id);
  const readMap = Object.fromEntries(reads.map(r => [r.user_id, r]));
  const result = targets.map(u => ({
    user_id: u.id,
    display_name: u.display_name,
    company_code: u.company_code,
    read_at: readMap[u.id] && readMap[u.id].read_at,
    acked_at: readMap[u.id] && readMap[u.id].acked_at,
  }));
  const readCount = result.filter(r => r.read_at).length;
  const ackCount = result.filter(r => r.acked_at).length;
  res.json({
    success: true,
    announcement: a,
    target_count: targets.length,
    read_count: readCount,
    ack_count: ackCount,
    rows: result,
  });
});

module.exports = router;
// 共有タブレットの未読バッジ(routes/tablet.js)から対象判定を再利用するため公開 (2026-07-30)
module.exports.userMatchesTarget = userMatchesTarget;
