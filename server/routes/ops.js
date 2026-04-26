const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const CATEGORIES = ['車両不具合', '事故・ヒヤリハット', '遅延', '荷主トラブル', 'その他'];
const URGENCIES = ['低', '中', '高'];
const STATUSES = ['受付', '対応中', '完了', '却下'];

// 全件閲覧/担当割当権限: 管理職 or 推進メンバー (運管型)
function canManage(uid) {
  const u = getDb().prepare('SELECT employee_type, role, is_field_promoter FROM users WHERE id = ?').get(uid);
  if (!u) return false;
  return u.employee_type === 'admin' || u.role === 'admin' || !!u.is_field_promoter;
}

// 画像保存
const opsDir = path.join(__dirname, '..', '..', 'uploads', 'ops');
if (!fs.existsSync(opsDir)) fs.mkdirSync(opsDir, { recursive: true });
const opsUpload = multer({
  storage: multer.diskStorage({
    destination: opsDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').slice(0, 8) || '.jpg').replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype || '')) return cb(new Error('画像のみ'));
    cb(null, true);
  },
});

// メタ
router.get('/meta', authUser, (req, res) => {
  res.json({
    success: true,
    can_manage: canManage(req.uid),
    categories: CATEGORIES,
    urgencies: URGENCIES,
    statuses: STATUSES,
  });
});

// 投稿 (誰でも)
router.post('/reports', authUser, opsUpload.single('image'), (req, res) => {
  const b = req.body || {};
  const category = String(b.category || '').trim();
  if (!CATEGORIES.includes(category)) return res.status(400).json({ success: false, msg: 'カテゴリ不正' });
  const urgency = URGENCIES.includes(b.urgency) ? b.urgency : '中';
  const vehicleNo = String(b.vehicle_no || '').slice(0, 30).trim();
  const location = String(b.location || '').slice(0, 100).trim();
  const description = String(b.description || '').slice(0, 1000).trim();
  const imageUrl = req.file ? '/uploads/ops/' + req.file.filename : null;
  if (!description && !imageUrl) return res.status(400).json({ success: false, msg: '内容または写真を入力してください' });
  const db = getDb();
  const ins = db.prepare(`INSERT INTO ops_reports
    (reporter_id, category, urgency, vehicle_no, location, description, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.uid, category, urgency, vehicleNo || null, location || null, description, imageUrl);
  const id = ins.lastInsertRowid;
  const rep = db.prepare(`SELECT r.*, u.display_name AS reporter_name, u.company_code AS reporter_company
                          FROM ops_reports r LEFT JOIN users u ON u.id = r.reporter_id WHERE r.id = ?`).get(id);

  // realtime + 管理者/推進メンバーへPush通知
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('ops:new', { report: rep });
  const recipients = db.prepare("SELECT id FROM users WHERE employee_type='admin' OR role='admin' OR is_field_promoter=1").all();
  const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
  const urgIcon = urgency === '高' ? '🔴' : urgency === '中' ? '🟡' : '🟢';
  if (sendPush) {
    for (const r of recipients) {
      if (r.id === req.uid) continue;
      sendPush(r.id, {
        title: `🚛 ${urgIcon}${urgency} [${category}]`,
        body: (vehicleNo ? '車両' + vehicleNo + ' / ' : '') + (description || '写真添付').slice(0, 100),
        tag: 'ops-' + id,
        url: '/ops.html#r-' + id,
      }).catch(() => {});
    }
  }
  res.json({ success: true, report: rep });
});

// 一覧 (管理職/推進=全件、それ以外=自分のみ)
router.get('/reports', authUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const status = req.query.status;
  const scope = req.query.scope || 'auto';  // auto | mine | all
  const db = getDb();
  const allowAll = canManage(req.uid);
  const showAll = scope === 'all' && allowAll;
  let sql = `SELECT r.*, u.display_name AS reporter_name, u.company_code AS reporter_company,
                    a.display_name AS assignee_name
             FROM ops_reports r
             LEFT JOIN users u ON u.id = r.reporter_id
             LEFT JOIN users a ON a.id = r.assignee_id
             WHERE 1=1`;
  const params = [];
  if (!showAll && (scope === 'mine' || !allowAll)) {
    sql += ' AND r.reporter_id = ?';
    params.push(req.uid);
  }
  if (status && STATUSES.includes(status)) {
    sql += ' AND r.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY r.id DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  // コメント数取得
  if (rows.length) {
    const ids = rows.map(r => r.id);
    const ph = ids.map(() => '?').join(',');
    const cnts = db.prepare(`SELECT report_id, COUNT(*) AS c FROM ops_comments WHERE report_id IN (${ph}) GROUP BY report_id`).all(...ids);
    const map = Object.fromEntries(cnts.map(x => [x.report_id, x.c]));
    for (const r of rows) r.comment_count = map[r.id] || 0;
  }
  res.json({ success: true, reports: rows, can_manage: allowAll });
});

// 未対応件数 (管理職/推進向けバッジ用)
router.get('/pending-count', authUser, (req, res) => {
  if (!canManage(req.uid)) return res.json({ success: true, count: 0 });
  const r = getDb().prepare(`SELECT COUNT(*) AS c FROM ops_reports WHERE status IN ('受付', '対応中')`).get();
  res.json({ success: true, count: r.c });
});

// 単件詳細
router.get('/reports/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const r = db.prepare(`SELECT r.*, u.display_name AS reporter_name, u.company_code AS reporter_company,
                               a.display_name AS assignee_name
                        FROM ops_reports r
                        LEFT JOIN users u ON u.id = r.reporter_id
                        LEFT JOIN users a ON a.id = r.assignee_id WHERE r.id = ?`).get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  // 投稿者本人 or canManage
  if (r.reporter_id !== req.uid && !canManage(req.uid)) {
    return res.status(403).json({ success: false, msg: '権限なし' });
  }
  res.json({ success: true, report: r });
});

// ステータス変更系
function changeStatus(id, status, fields) {
  const db = getDb();
  const set = ['status = ?'];
  const params = [status];
  if (fields) {
    for (const k of Object.keys(fields)) {
      set.push(`${k} = ?`);
      params.push(fields[k]);
    }
  }
  params.push(id);
  db.prepare(`UPDATE ops_reports SET ${set.join(', ')} WHERE id = ?`).run(...params);
}

// 自分に担当割当 (受付→対応中)
router.post('/reports/:id/assign', authUser, (req, res) => {
  if (!canManage(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const r = db.prepare('SELECT * FROM ops_reports WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (r.status === '完了' || r.status === '却下') return res.status(400).json({ success: false, msg: 'クローズ済みです' });
  changeStatus(id, '対応中', { assignee_id: req.uid });
  // 投稿者へ通知
  const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
  const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  if (sendPush && r.reporter_id !== req.uid) {
    sendPush(r.reporter_id, {
      title: '🛠 対応開始',
      body: (me && me.display_name ? me.display_name : '担当者') + ' があなたの報告 #' + id + ' の対応を開始しました',
      tag: 'ops-assign-' + id,
      url: '/ops.html#r-' + id,
    }).catch(() => {});
  }
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('ops:update', { id });
  res.json({ success: true });
});

// 完了
router.post('/reports/:id/complete', authUser, express.json(), (req, res) => {
  if (!canManage(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const note = String((req.body && req.body.note) || '').slice(0, 500);
  const db = getDb();
  const r = db.prepare('SELECT * FROM ops_reports WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  changeStatus(id, '完了', { resolution_note: note, resolved_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  // 投稿者へ通知
  const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
  if (sendPush && r.reporter_id !== req.uid) {
    sendPush(r.reporter_id, {
      title: '✅ 対応完了',
      body: '報告 #' + id + ' が完了しました' + (note ? ': ' + note.slice(0, 80) : ''),
      tag: 'ops-done-' + id,
      url: '/ops.html#r-' + id,
    }).catch(() => {});
  }
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('ops:update', { id });
  res.json({ success: true });
});

// 却下
router.post('/reports/:id/reject', authUser, express.json(), (req, res) => {
  if (!canManage(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const note = String((req.body && req.body.note) || '').slice(0, 500);
  changeStatus(id, '却下', { resolution_note: note });
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('ops:update', { id });
  res.json({ success: true });
});

// コメント一覧
router.get('/reports/:id/comments', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const r = db.prepare('SELECT reporter_id FROM ops_reports WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (r.reporter_id !== req.uid && !canManage(req.uid)) {
    return res.status(403).json({ success: false, msg: '権限なし' });
  }
  const rows = db.prepare(`SELECT c.*, u.display_name AS author_name, u.avatar_url AS author_avatar
                           FROM ops_comments c LEFT JOIN users u ON u.id = c.author_id
                           WHERE c.report_id = ? ORDER BY c.id ASC LIMIT 200`).all(id);
  res.json({ success: true, comments: rows });
});

// コメント
router.post('/reports/:id/comments', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const content = String((req.body && req.body.content) || '').slice(0, 500).trim();
  if (!content) return res.status(400).json({ success: false, msg: '本文必須' });
  const db = getDb();
  const r = db.prepare('SELECT reporter_id, assignee_id FROM ops_reports WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (r.reporter_id !== req.uid && !canManage(req.uid)) {
    return res.status(403).json({ success: false, msg: '権限なし' });
  }
  const ins = db.prepare('INSERT INTO ops_comments (report_id, author_id, content) VALUES (?, ?, ?)').run(id, req.uid, content);
  const c = db.prepare(`SELECT c.*, u.display_name AS author_name, u.avatar_url AS author_avatar
                        FROM ops_comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = ?`).get(ins.lastInsertRowid);
  // 関係者通知 (投稿者+担当者+管理者陣 から自分除く)
  const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
  const targets = new Set();
  if (r.reporter_id && r.reporter_id !== req.uid) targets.add(r.reporter_id);
  if (r.assignee_id && r.assignee_id !== req.uid) targets.add(r.assignee_id);
  if (sendPush) {
    for (const t of targets) {
      sendPush(t, {
        title: '💬 業務連絡コメント',
        body: (c.author_name || '誰か') + ': ' + content.slice(0, 80),
        tag: 'ops-cmt-' + id,
        url: '/ops.html#r-' + id,
      }).catch(() => {});
    }
  }
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('ops:comment', { report_id: id, comment: c });
  res.json({ success: true, comment: c });
});

module.exports = router;
