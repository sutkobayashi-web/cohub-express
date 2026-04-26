const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { analyzeFoodImage } = require('../services/ai');

const CATEGORIES = ['食事', '相談', '雑談', '健康Tips'];
const ALLOWED_EMOJIS = ['❤️', '🎉', '👍', '😊', '👏'];
const MAX_CONTENT = 500;

const plazaDir = path.join(__dirname, '..', '..', 'uploads', 'plaza');
if (!fs.existsSync(plazaDir)) fs.mkdirSync(plazaDir, { recursive: true });
const plazaUpload = multer({
  storage: multer.diskStorage({
    destination: plazaDir,
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

router.get('/meta', authUser, (req, res) => {
  res.json({ success: true, categories: CATEGORIES });
});

// 一覧 (新着順、過去アーカイブと統合表示)
router.get('/posts', authUser, (req, res) => {
  const cat = req.query.category;
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const before = parseInt(req.query.before) || null;
  const includeArchive = req.query.archive !== '0';
  const db = getDb();

  let sql = `SELECT p.id, p.author_id, p.category, p.content, p.image_url, p.nutrition_scores,
                    p.ai_comment, p.created_at,
                    u.display_name AS author_name, u.avatar_url AS author_avatar, u.company_code AS author_company
             FROM plaza_posts p LEFT JOIN users u ON u.id = p.author_id
             WHERE p.deleted_at IS NULL`;
  const params = [];
  if (cat && CATEGORIES.includes(cat)) { sql += ' AND p.category = ?'; params.push(cat); }
  if (before) { sql += ' AND p.id < ?'; params.push(before); }
  sql += ' ORDER BY p.id DESC LIMIT ?';
  params.push(limit);
  const newPosts = db.prepare(sql).all(...params);

  const ids = newPosts.map(p => p.id);
  const me = req.uid;
  let reactions = [];
  let cmtMap = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    reactions = db.prepare(`SELECT post_id, emoji, user_id FROM plaza_reactions WHERE post_id IN (${ph})`).all(...ids);
    const cnts = db.prepare(`SELECT post_id, COUNT(*) AS c FROM plaza_comments WHERE post_id IN (${ph}) AND deleted_at IS NULL GROUP BY post_id`).all(...ids);
    cmtMap = Object.fromEntries(cnts.map(x => [x.post_id, x.c]));
  }
  const enriched = newPosts.map(p => {
    const rxs = reactions.filter(r => r.post_id === p.id);
    const counts = {}; const mine = {};
    for (const e of ALLOWED_EMOJIS) { counts[e] = 0; mine[e] = false; }
    for (const r of rxs) {
      if (counts[r.emoji] !== undefined) counts[r.emoji]++;
      if (r.user_id === me && mine[r.emoji] !== undefined) mine[r.emoji] = true;
    }
    return {
      ...p,
      kind: 'plaza',
      reactions: counts,
      my_reactions: mine,
      comment_count: cmtMap[p.id] || 0,
      can_delete: p.author_id === me,
    };
  });

  // 初回のみ過去アーカイブ (cw_posts) も取り込んで時系列マージ
  let archive = [];
  if (includeArchive && !before) {
    let asql = `SELECT cp.cw_post_id AS id, cp.cw_user_id AS author_cw_id, cp.content,
                       cp.image_url, cp.nutrition_scores, cp.category, cp.cw_created_at AS created_at,
                       cu.cohub_uid AS author_id, cu.nickname AS cw_nickname, cu.real_name AS cw_real_name,
                       u.display_name AS author_name, u.avatar_url AS author_avatar, u.company_code AS author_company
                FROM cw_posts cp
                LEFT JOIN cw_users cu ON cu.cw_id = cp.cw_user_id
                LEFT JOIN users u ON u.id = cu.cohub_uid
                WHERE 1=1`;
    const aparams = [];
    if (cat && CATEGORIES.includes(cat)) { asql += ' AND cp.category = ?'; aparams.push(cat); }
    asql += ' ORDER BY cp.cw_created_at DESC LIMIT 30';
    archive = db.prepare(asql).all(...aparams).map(p => ({
      ...p,
      kind: 'archive',
      author_name: p.author_name || p.cw_real_name || p.cw_nickname,
      reactions: {}, my_reactions: {}, comment_count: 0, can_delete: false,
    }));
  }
  const merged = [...enriched, ...archive].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, limit);
  res.json({ success: true, posts: merged });
});

// 投稿
router.post('/posts', authUser, plazaUpload.single('image'), async (req, res) => {
  const category = String((req.body && req.body.category) || '').trim();
  if (!CATEGORIES.includes(category)) return res.status(400).json({ success: false, msg: 'カテゴリ不正' });
  const content = String((req.body && req.body.content) || '').slice(0, MAX_CONTENT).trim();
  const imageUrl = req.file ? '/uploads/plaza/' + req.file.filename : null;
  if (!content && !imageUrl) return res.status(400).json({ success: false, msg: '本文または画像が必要' });

  // 食事カテゴリ + 画像あり → AI 栄養分析を試行 (失敗しても投稿は成立)
  let nutritionScores = null;
  let aiComment = null;
  if (category === '食事' && req.file) {
    try {
      const buf = fs.readFileSync(req.file.path);
      const r = await analyzeFoodImage(buf, req.file.mimetype, content);
      if (r && r.scores) nutritionScores = JSON.stringify(r.scores);
      if (r && r.comment) aiComment = r.comment;
    } catch (e) { console.warn('food AI fail:', e.message); }
  }

  const db = getDb();
  const ins = db.prepare(`INSERT INTO plaza_posts (author_id, category, content, image_url, nutrition_scores, ai_comment)
    VALUES (?, ?, ?, ?, ?, ?)`).run(req.uid, category, content, imageUrl, nutritionScores, aiComment);
  const post = db.prepare(`SELECT p.*, u.display_name AS author_name, u.avatar_url AS author_avatar, u.company_code AS author_company
                           FROM plaza_posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.id = ?`).get(ins.lastInsertRowid);
  post.kind = 'plaza';
  post.reactions = Object.fromEntries(ALLOWED_EMOJIS.map(e => [e, 0]));
  post.my_reactions = Object.fromEntries(ALLOWED_EMOJIS.map(e => [e, false]));
  post.comment_count = 0;
  post.can_delete = true;

  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('plaza:new', { post });
  res.json({ success: true, post });
});

// 削除 (本人のみ)
router.delete('/posts/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const p = db.prepare('SELECT author_id FROM plaza_posts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!p) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (p.author_id !== req.uid) return res.status(403).json({ success: false, msg: '本人のみ削除可' });
  db.prepare("UPDATE plaza_posts SET deleted_at = datetime('now') WHERE id = ?").run(id);
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('plaza:delete', { id });
  res.json({ success: true });
});

// リアクション (トグル)
router.post('/posts/:id/react', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const emoji = String((req.body && req.body.emoji) || '');
  if (!ALLOWED_EMOJIS.includes(emoji)) return res.status(400).json({ success: false, msg: '不正' });
  const db = getDb();
  const post = db.prepare('SELECT id, author_id FROM plaza_posts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!post) return res.status(404).json({ success: false, msg: '見つかりません' });
  const exists = db.prepare('SELECT 1 FROM plaza_reactions WHERE post_id=? AND user_id=? AND emoji=?').get(id, req.uid, emoji);
  let added;
  if (exists) {
    db.prepare('DELETE FROM plaza_reactions WHERE post_id=? AND user_id=? AND emoji=?').run(id, req.uid, emoji);
    added = false;
  } else {
    db.prepare('INSERT INTO plaza_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)').run(id, req.uid, emoji);
    added = true;
    if (post.author_id !== req.uid) {
      const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
      const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
      if (sendPush) sendPush(post.author_id, {
        title: emoji + ' ひろば',
        body: (me && me.display_name ? me.display_name : '誰か') + ' があなたの投稿にリアクション',
        tag: 'plaza-react-' + id,
        url: '/plaza.html#post-' + id,
      }).catch(() => {});
    }
  }
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('plaza:react', { post_id: id, emoji, user_id: req.uid, added });
  res.json({ success: true, added });
});

// コメント一覧
router.get('/posts/:id/comments', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const rows = getDb().prepare(`SELECT c.id, c.author_id, c.content, c.created_at,
                                       u.display_name AS author_name, u.avatar_url AS author_avatar
                                FROM plaza_comments c LEFT JOIN users u ON u.id = c.author_id
                                WHERE c.post_id = ? AND c.deleted_at IS NULL
                                ORDER BY c.id ASC LIMIT 200`).all(id);
  res.json({ success: true, comments: rows });
});

router.post('/posts/:id/comments', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const content = String((req.body && req.body.content) || '').slice(0, MAX_CONTENT).trim();
  if (!content) return res.status(400).json({ success: false, msg: '本文必須' });
  const db = getDb();
  const post = db.prepare('SELECT id, author_id FROM plaza_posts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!post) return res.status(404).json({ success: false, msg: '見つかりません' });
  const ins = db.prepare('INSERT INTO plaza_comments (post_id, author_id, content) VALUES (?, ?, ?)').run(id, req.uid, content);
  const c = db.prepare(`SELECT c.*, u.display_name AS author_name, u.avatar_url AS author_avatar
                        FROM plaza_comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = ?`).get(ins.lastInsertRowid);
  if (post.author_id !== req.uid) {
    const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (sendPush) sendPush(post.author_id, {
      title: '💬 ひろば',
      body: (c.author_name || '誰か') + ': ' + content.slice(0, 80),
      tag: 'plaza-cmt-' + id,
      url: '/plaza.html#post-' + id,
    }).catch(() => {});
  }
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('plaza:comment', { post_id: id, comment: c });
  res.json({ success: true, comment: c });
});

module.exports = router;
