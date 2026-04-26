const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const CATEGORIES = ['安全教育', '業務マニュアル', '経営メッセージ', '新人教育', 'その他'];
const MAX_VIDEO_MB = 200;

function canUpload(uid) {
  const u = getDb().prepare('SELECT employee_type, role FROM users WHERE id = ?').get(uid);
  return !!(u && (u.employee_type === 'admin' || u.role === 'admin'));
}

function userMatchesTarget(uid, target) {
  if (!target || target === 'all') return true;
  const u = getDb().prepare('SELECT company_code, role, employee_type FROM users WHERE id = ?').get(uid);
  if (!u) return false;
  const [kind, val] = String(target).split(':');
  if (kind === 'company') return u.company_code === val;
  if (kind === 'building') return u.employee_type === val;
  return false;
}

const videoDir = path.join(__dirname, '..', '..', 'uploads', 'videos');
if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: videoDir,
    filename: (req, file, cb) => {
      const isThumb = file.fieldname === 'thumbnail';
      const ext = (path.extname(file.originalname || '').slice(0, 8) || (isThumb ? '.jpg' : '.mp4')).replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, (isThumb ? 't_' : 'v_') + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'thumbnail') {
      if (!/^image\//.test(file.mimetype || '')) return cb(new Error('サムネは画像のみ'));
    } else if (file.fieldname === 'video') {
      if (!/^video\//.test(file.mimetype || '')) return cb(new Error('動画ファイルのみ'));
    }
    cb(null, true);
  },
});

router.get('/meta', authUser, (req, res) => {
  res.json({
    success: true,
    can_upload: canUpload(req.uid),
    categories: CATEGORIES,
    max_size_mb: MAX_VIDEO_MB,
  });
});

// 一覧 (自分宛のみ + 視聴状況)
router.get('/', authUser, (req, res) => {
  const cat = req.query.category;
  const db = getDb();
  let sql = `SELECT v.*, u.display_name AS uploader_name, vv.completed_at, vv.last_position_sec
             FROM videos v
             LEFT JOIN users u ON u.id = v.uploaded_by
             LEFT JOIN video_views vv ON vv.video_id = v.id AND vv.user_id = ?
             WHERE v.deleted_at IS NULL`;
  const params = [req.uid];
  if (cat && CATEGORIES.includes(cat)) {
    sql += ' AND v.category = ?';
    params.push(cat);
  }
  sql += ' ORDER BY v.id DESC LIMIT 200';
  const all = db.prepare(sql).all(...params);
  const filtered = all.filter(v => userMatchesTarget(req.uid, v.target));
  res.json({ success: true, videos: filtered, can_upload: canUpload(req.uid) });
});

// アップロード (管理者)
router.post('/', authUser, videoUpload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), (req, res) => {
  if (!canUpload(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみアップロード可' });
  const b = req.body || {};
  const title = String(b.title || '').slice(0, 200).trim();
  if (!title) return res.status(400).json({ success: false, msg: 'タイトル必須' });
  const videoFile = req.files && req.files.video && req.files.video[0];
  if (!videoFile) return res.status(400).json({ success: false, msg: '動画ファイル必須' });
  const thumbFile = req.files && req.files.thumbnail && req.files.thumbnail[0];
  const description = String(b.description || '').slice(0, 1000);
  const category = CATEGORIES.includes(b.category) ? b.category : 'その他';
  const target = String(b.target || 'all').slice(0, 50);
  const isRequired = b.is_required === '1' || b.is_required === true ? 1 : 0;
  const ins = getDb().prepare(`INSERT INTO videos
    (title, description, category, file_url, thumbnail_url, file_size, uploaded_by, is_required, target)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    title, description, category,
    '/uploads/videos/' + videoFile.filename,
    thumbFile ? '/uploads/videos/' + thumbFile.filename : null,
    videoFile.size,
    req.uid, isRequired, target
  );
  const id = ins.lastInsertRowid;
  // 必須視聴/経営メッセージは Push通知 (対象全員)
  if (isRequired || category === '経営メッセージ') {
    const targets = getDb().prepare('SELECT id FROM users').all();
    const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (sendPush) {
      for (const t of targets) {
        if (!userMatchesTarget(t.id, target)) continue;
        sendPush(t.id, {
          title: '🎬 ' + (isRequired ? '【必須視聴】' : '') + title,
          body: category + ' / 動画ライブラリに追加されました',
          tag: 'video-' + id,
          url: '/videos.html#v-' + id,
        }).catch(() => {});
      }
    }
  }
  res.json({ success: true, id });
});

// 視聴記録 (再生開始/進捗/完了)
router.post('/:id/view', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const pos = parseInt((req.body && req.body.position_sec) || 0);
  const completed = req.body && req.body.completed ? 1 : 0;
  const db = getDb();
  const v = db.prepare('SELECT id, duration_sec FROM videos WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!v) return res.status(404).json({ success: false, msg: '見つかりません' });
  db.prepare(`INSERT INTO video_views (video_id, user_id, last_position_sec)
              VALUES (?, ?, ?)
              ON CONFLICT(video_id, user_id) DO UPDATE SET last_position_sec = excluded.last_position_sec`)
    .run(id, req.uid, pos);
  if (completed) {
    db.prepare(`UPDATE video_views SET completed_at = datetime('now') WHERE video_id = ? AND user_id = ? AND completed_at IS NULL`)
      .run(id, req.uid);
  }
  res.json({ success: true });
});

// 動画の長さを更新 (再生時に取得した duration を保存)
router.post('/:id/duration', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const sec = parseInt((req.body && req.body.duration_sec) || 0);
  if (!sec) return res.json({ success: true });
  getDb().prepare('UPDATE videos SET duration_sec = ? WHERE id = ? AND duration_sec = 0').run(sec, id);
  res.json({ success: true });
});

// 視聴率 (管理職)
router.get('/:id/views', authUser, (req, res) => {
  if (!canUpload(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const v = db.prepare('SELECT * FROM videos WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!v) return res.status(404).json({ success: false, msg: '見つかりません' });
  const allUsers = db.prepare('SELECT id, display_name, company_code FROM users').all();
  const targets = allUsers.filter(u => userMatchesTarget(u.id, v.target));
  const views = db.prepare('SELECT user_id, started_at, completed_at, last_position_sec FROM video_views WHERE video_id = ?').all(id);
  const map = Object.fromEntries(views.map(x => [x.user_id, x]));
  const rows = targets.map(u => ({
    user_id: u.id, display_name: u.display_name, company_code: u.company_code,
    started_at: map[u.id] && map[u.id].started_at,
    completed_at: map[u.id] && map[u.id].completed_at,
    last_position_sec: map[u.id] && map[u.id].last_position_sec,
  }));
  res.json({
    success: true, video: v,
    target_count: targets.length,
    started_count: rows.filter(r => r.started_at).length,
    completed_count: rows.filter(r => r.completed_at).length,
    rows,
  });
});

// 削除
router.delete('/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const v = db.prepare('SELECT uploaded_by FROM videos WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!v) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (v.uploaded_by !== req.uid && !canUpload(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  db.prepare("UPDATE videos SET deleted_at = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
});

module.exports = router;
