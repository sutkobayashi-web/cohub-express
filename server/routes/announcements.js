const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const LEVELS = ['normal', 'important', 'urgent'];

// 告知作成権限: 管理職 (employee_type='admin') または system admin
function canCreate(uid) {
  const u = getDb().prepare('SELECT employee_type, role FROM users WHERE id = ?').get(uid);
  return !!(u && (u.employee_type === 'admin' || u.role === 'admin'));
}

// 対象判定: target='all' | 'company:CODE' | 'building:office|field' | 'role:admin' など
function userMatchesTarget(uid, target) {
  if (!target || target === 'all') return true;
  const u = getDb().prepare('SELECT company_code, role, employee_type FROM users WHERE id = ?').get(uid);
  if (!u) return false;
  const [kind, val] = String(target).split(':');
  if (kind === 'company') return u.company_code === val;
  if (kind === 'building') return u.employee_type === val;  // office | field | admin
  if (kind === 'role') return u.role === val;
  return false;
}

// 自分宛の有効告知一覧 (新着順、デフォルトは未削除のみ)
router.get('/', authUser, (req, res) => {
  const onlyUnread = req.query.unread === '1';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const db = getDb();
  const all = db.prepare(`SELECT a.*, u.display_name AS author_name,
                                 r.read_at, r.acked_at
                          FROM announcements a
                          LEFT JOIN users u ON u.id = a.author_id
                          LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
                          WHERE a.deleted_at IS NULL
                            AND (a.expires_at IS NULL OR a.expires_at >= datetime('now'))
                          ORDER BY a.id DESC LIMIT ?`).all(req.uid, limit);
  const filtered = all.filter(a => userMatchesTarget(req.uid, a.target));
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
      return res.json({ success: true, announcement: a });
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

// 新規作成 (管理職)
router.post('/', authUser, express.json(), (req, res) => {
  if (!canCreate(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ作成可' });
  const b = req.body || {};
  const title = String(b.title || '').slice(0, 100).trim();
  const body = String(b.body || '').slice(0, 4000).trim();
  if (!title || !body) return res.status(400).json({ success: false, msg: 'タイトルと本文は必須' });
  const level = LEVELS.includes(b.level) ? b.level : 'normal';
  const requiresAck = b.requires_ack ? 1 : 0;
  const target = String(b.target || 'all').slice(0, 50);
  const expiresAt = b.expires_at ? String(b.expires_at).slice(0, 30) : null;
  const db = getDb();
  const ins = db.prepare(`INSERT INTO announcements
    (author_id, title, body, level, requires_ack, target, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.uid, title, body, level, requiresAck, target, expiresAt);
  const id = ins.lastInsertRowid;

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
  if (b.target !== undefined) { updates.push('target = ?'); params.push(String(b.target).slice(0, 50)); }
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
