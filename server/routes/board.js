const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { execFile, execFileSync } = require('child_process');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// ===== PDF サムネ / 閲覧ページ画像生成 (poppler pdftoppm) =====
// 命名規則: 添付が /uploads/board/F.pdf のとき
//   サムネ  = F.pdf.thumb.jpg (1ページ目・小)
//   各ページ = F.pdf.p1.jpg, F.pdf.p2.jpg ... (アプリ内ビューア用)
const PDF_MAX_PAGES = 20;
function pdfPageCount(absPdf) {
  try {
    const out = execFileSync('pdfinfo', [absPdf], { timeout: 15000 }).toString();
    const m = out.match(/^Pages:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : 0;
  } catch (_) { return 0; }
}
// 1ページ目サムネを同期生成 (軽量・投稿直後の一覧表示に間に合わせる)
function generatePdfThumb(absPdf) {
  try {
    execFileSync('pdftoppm', ['-jpeg', '-singlefile', '-f', '1', '-l', '1', '-scale-to', '480', absPdf, absPdf + '.thumb'], { timeout: 20000 });
    return true;
  } catch (_) { return false; }
}
// 閲覧用の各ページ画像を非同期で順次生成 (イベントループを塞がない)
function generatePdfPages(absPdf) {
  const pages = Math.min(pdfPageCount(absPdf) || 1, PDF_MAX_PAGES);
  let n = 1;
  const next = () => {
    if (n > pages) return;
    const p = n++;
    execFile('pdftoppm', ['-jpeg', '-singlefile', '-f', String(p), '-l', String(p), '-scale-to', '1100', absPdf, absPdf + '.p' + p], { timeout: 30000 }, () => next());
  };
  next();
}

// 反応セット (8種): 👍いいね/❤️推し/😊共感/💪応援/👏すごい/💡参考/🙏ありがとう/😢心配
// 🎉は旧データ互換のため許容（UIには表示しない）
const ALLOWED_EMOJIS = ['👍', '❤️', '😊', '💪', '👏', '💡', '🙏', '😢', '🎉'];
const MAX_CONTENT = 280;
// サークル活動を掲示板に反映(circle_id付き)。既存DBへ列を後付け。
try { getDb().prepare('ALTER TABLE board_posts ADD COLUMN circle_id TEXT').run(); } catch (e) {}

// ⭐2026-07-31 (社長指示): サークルの投稿は「サークル内だけ」に限定する。
//   掲示板一覧・What's new・掲示板の未読カウントには出さない (circle_id 付きは除外)。
//   見えるのは circles.html の活動報告 (?circle_id=... 指定) で、かつ そのサークルのメンバーのみ。
function isCircleMember(db, circleId, uid) {
  try {
    const c = db.prepare('SELECT id, lead_uid FROM chat_groups WHERE id = ? AND is_circle = 1').get(circleId);
    if (!c) return false;
    if (c.lead_uid === uid) return true;
    return !!db.prepare('SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ?').get(circleId, uid);
  } catch (e) { return false; }
}

const MAX_COMMENT = 280;

// 掲示板画像保存 (チャット添付と分離)
const boardDir = path.join(__dirname, '..', '..', 'uploads', 'board');
if (!fs.existsSync(boardDir)) fs.mkdirSync(boardDir, { recursive: true });
const boardUpload = multer({
  storage: multer.diskStorage({
    destination: boardDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').slice(0, 8) || '.jpg').replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB (PDF対応)
  fileFilter: (req, file, cb) => {
    const mt = file.mimetype || '';
    if (/^image\//.test(mt) || mt === 'application/pdf') return cb(null, true);
    cb(new Error('画像またはPDFのみアップロード可'));
  },
});

// 投稿一覧 (新しい順)
router.get('/posts', authUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = parseInt(req.query.before) || null;
  const db = getDb();
  let sql = `SELECT p.id, p.author_id, p.content, p.image_url, p.created_at, p.circle_id,
                    u.display_name AS author_name, u.avatar_url AS author_avatar, u.company_code AS author_company,
                    g.name AS circle_name, g.icon AS circle_icon, g.lead_uid AS circle_lead
             FROM board_posts p LEFT JOIN users u ON u.id = p.author_id
             LEFT JOIN chat_groups g ON g.id = p.circle_id AND g.is_circle = 1
             WHERE p.deleted_at IS NULL`;
  const params = [];
  if (before) { sql += ' AND p.id < ?'; params.push(before); }
  const circleId = (req.query.circle_id || '').toString();
  if (circleId) {
    // サークル指定 = そのサークルのメンバーだけが読める
    if (!isCircleMember(db, circleId, req.uid)) return res.status(403).json({ success: false, msg: 'このサークルのメンバーのみ閲覧できます' });
    sql += ' AND p.circle_id = ?'; params.push(circleId);
  } else {
    // 通常の掲示板一覧にはサークルの投稿を出さない
    sql += " AND (p.circle_id IS NULL OR p.circle_id = '')";
  }
  sql += ' ORDER BY p.id DESC LIMIT ?';
  params.push(limit);
  const posts = db.prepare(sql).all(...params);
  if (!posts.length) return res.json({ success: true, posts: [] });

  const ids = posts.map(p => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const reactions = db.prepare(`SELECT post_id, emoji, user_id FROM board_reactions WHERE post_id IN (${placeholders})`).all(...ids);
  const commentCounts = db.prepare(`SELECT post_id, COUNT(*) AS c FROM board_comments WHERE post_id IN (${placeholders}) AND deleted_at IS NULL GROUP BY post_id`).all(...ids);
  const ccMap = Object.fromEntries(commentCounts.map(r => [r.post_id, r.c]));

  const me = req.uid;
  const enriched = posts.map(p => {
    const rxs = reactions.filter(r => r.post_id === p.id);
    const counts = {};
    const mine = {};
    for (const e of ALLOWED_EMOJIS) { counts[e] = 0; mine[e] = false; }
    for (const r of rxs) {
      if (counts[r.emoji] !== undefined) counts[r.emoji]++;
      if (r.user_id === me && mine[r.emoji] !== undefined) mine[r.emoji] = true;
    }
    return {
      ...p,
      reactions: counts,
      my_reactions: mine,
      comment_count: ccMap[p.id] || 0,
      can_delete: p.author_id === me || (!!p.circle_lead && p.circle_lead === me),
    };
  });
  res.json({ success: true, posts: enriched });
});

// 投稿 (画像 or PDF添付対応)
router.post('/posts', authUser, boardUpload.single('image'), (req, res) => {
  const content = String((req.body && req.body.content) || '').slice(0, MAX_CONTENT).trim();
  const imageUrl = req.file ? '/uploads/board/' + req.file.filename : null;
  if (!content && !imageUrl) return res.status(400).json({ success: false, msg: '本文または添付ファイルが必要です' });
  // PDF添付ならサムネ(同期)+閲覧ページ(非同期)を生成
  if (req.file && /\.pdf$/i.test(req.file.filename)) {
    const absPdf = path.join(boardDir, req.file.filename);
    generatePdfThumb(absPdf);
    generatePdfPages(absPdf);
  }
  const db = getDb();
  // サークル活動として反映する場合: circle_id を検証(実在サークル & 投稿者がメンバー)
  let validCircle = null;
  const reqCircle = String((req.body && req.body.circle_id) || '').trim();
  if (reqCircle) {
    const c = db.prepare('SELECT id FROM chat_groups WHERE id = ? AND is_circle = 1').get(reqCircle);
    const isMember = c && db.prepare('SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ?').get(reqCircle, req.uid);
    if (!c || !isMember) return res.status(403).json({ success: false, msg: 'このサークルに投稿できるのはメンバーのみです' });
    validCircle = reqCircle;
  }
  const ins = db.prepare(`INSERT INTO board_posts (author_id, content, image_url, circle_id) VALUES (?, ?, ?, ?)`)
    .run(req.uid, content, imageUrl, validCircle);
  const post = db.prepare(`SELECT p.id, p.author_id, p.content, p.image_url, p.created_at, p.circle_id,
                                  u.display_name AS author_name, u.avatar_url AS author_avatar, u.company_code AS author_company,
                                  g.name AS circle_name, g.icon AS circle_icon, g.lead_uid AS circle_lead
                           FROM board_posts p LEFT JOIN users u ON u.id = p.author_id
                           LEFT JOIN chat_groups g ON g.id = p.circle_id AND g.is_circle = 1 WHERE p.id = ?`).get(ins.lastInsertRowid);
  // 全社realtime通知 (Socket.IO)
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('board:new', { post });
  res.json({ success: true, post });
});

// 削除 (本人のみ、論理削除)
router.delete('/posts/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const p = db.prepare('SELECT author_id, circle_id FROM board_posts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!p) return res.status(404).json({ success: false, msg: '見つかりません' });
  let allowed = p.author_id === req.uid;
  if (!allowed && p.circle_id) {
    const g = db.prepare('SELECT lead_uid FROM chat_groups WHERE id = ?').get(p.circle_id);
    if (g && g.lead_uid === req.uid) allowed = true;   // サークル投稿は発起人(リーダー)も削除可
  }
  if (!allowed) return res.status(403).json({ success: false, msg: '本人または発起人のみ削除可' });
  db.prepare("UPDATE board_posts SET deleted_at = datetime('now') WHERE id = ?").run(id);
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('board:delete', { id });
  res.json({ success: true });
});

// リアクション (トグル)
router.post('/posts/:id/react', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const emoji = String((req.body && req.body.emoji) || '');
  if (!ALLOWED_EMOJIS.includes(emoji)) return res.status(400).json({ success: false, msg: 'リアクション不正' });
  const db = getDb();
  const post = db.prepare('SELECT id, author_id, content, circle_id FROM board_posts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!post) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (post.circle_id && !isCircleMember(db, post.circle_id, req.uid)) return res.status(403).json({ success: false, msg: 'このサークルのメンバーのみ操作できます' });
  const exists = db.prepare('SELECT 1 FROM board_reactions WHERE post_id=? AND user_id=? AND emoji=?').get(id, req.uid, emoji);
  let added;
  if (exists) {
    db.prepare('DELETE FROM board_reactions WHERE post_id=? AND user_id=? AND emoji=?').run(id, req.uid, emoji);
    added = false;
  } else {
    db.prepare('INSERT INTO board_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)').run(id, req.uid, emoji);
    added = true;
    // 投稿者へPush通知 (自分以外、トグル追加時のみ)
    if (post.author_id !== req.uid) {
      const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
      const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
      if (sendPush) sendPush(post.author_id, {
        title: emoji + ' リアクション',
        body: (me && me.display_name ? me.display_name : '誰か') + ' があなたの投稿にリアクションしました',
        tag: 'board-react-' + id,
        url: '/board.html#post-' + id,
      }).catch(() => {});
    }
  }
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('board:react', { post_id: id, emoji, user_id: req.uid, added });
  res.json({ success: true, added });
});

// コメント一覧
router.get('/posts/:id/comments', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  {
    const db0 = getDb();
    const pp = db0.prepare('SELECT circle_id FROM board_posts WHERE id = ?').get(id);
    if (pp && pp.circle_id && !isCircleMember(db0, pp.circle_id, req.uid)) return res.status(403).json({ success: false, msg: 'このサークルのメンバーのみ閲覧できます' });
  }
  // 掲示板は業務用のため投稿もコメントも実名(display_name)で統一 (2026-07-17 小林指示: 中途半端な匿名は本人が特定できてしまうため実名化)。
  const rows = getDb().prepare(`SELECT c.id, c.author_id, c.content, c.created_at,
                                       COALESCE(NULLIF(u.display_name, ''), NULLIF(u.nickname, ''), '匿名') AS author_name,
                                       NULL AS author_avatar
                                FROM board_comments c
                                LEFT JOIN users u ON u.id = c.author_id
                                LEFT JOIN board_posts p ON p.id = c.post_id
                                WHERE c.post_id = ? AND c.deleted_at IS NULL
                                ORDER BY c.id ASC LIMIT 200`).all(id);
  res.json({ success: true, comments: rows });
});

// コメント投稿
router.post('/posts/:id/comments', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const content = String((req.body && req.body.content) || '').slice(0, MAX_COMMENT).trim();
  if (!content) return res.status(400).json({ success: false, msg: '本文必須' });
  const db = getDb();
  const post = db.prepare('SELECT id, author_id, content, circle_id FROM board_posts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!post) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (post.circle_id && !isCircleMember(db, post.circle_id, req.uid)) return res.status(403).json({ success: false, msg: 'このサークルのメンバーのみ操作できます' });
  const ins = db.prepare('INSERT INTO board_comments (post_id, author_id, content) VALUES (?, ?, ?)').run(id, req.uid, content);
  const comment = db.prepare(`SELECT c.id, c.author_id, c.content, c.created_at,
                                     COALESCE(NULLIF(u.display_name, ''), NULLIF(u.nickname, ''), '匿名') AS author_name,
                                     NULL AS author_avatar
                              FROM board_comments c
                              LEFT JOIN users u ON u.id = c.author_id
                              LEFT JOIN board_posts p ON p.id = c.post_id
                              WHERE c.id = ?`).get(ins.lastInsertRowid);
  // 投稿者通知
  if (post.author_id !== req.uid) {
    const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (sendPush) sendPush(post.author_id, {
      title: '💬 コメント',
      body: (comment.author_name || '誰か') + ': ' + content.slice(0, 80),
      tag: 'board-cmt-' + id,
      url: '/board.html#post-' + id,
    }).catch(() => {});
  }
  // 同じ投稿に他にコメントしていた人にも通知 (会話継続の感覚)
  const others = db.prepare(`SELECT DISTINCT author_id FROM board_comments WHERE post_id = ? AND author_id != ? AND author_id != ?`).all(id, req.uid, post.author_id);
  const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
  for (const o of others) {
    if (sendPush) sendPush(o.author_id, {
      title: '💬 コメントが追加されました',
      body: (comment.author_name || '誰か') + ': ' + content.slice(0, 80),
      tag: 'board-cmt-' + id + '-' + o.author_id,
      url: '/board.html#post-' + id,
    }).catch(() => {});
  }
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('board:comment', { post_id: id, comment });
  res.json({ success: true, comment });
});

// コメント削除 (本人のみ)
router.delete('/comments/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const c = db.prepare('SELECT author_id FROM board_comments WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (c.author_id !== req.uid) return res.status(403).json({ success: false, msg: '本人のみ削除可' });
  db.prepare("UPDATE board_comments SET deleted_at = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
});

// 未読件数 (新着バッジ用、軽量)
// last_board_seen_at より新しい他人の投稿数。未設定時はゼロ扱い (初訪問でバッジ氾濫を避ける)
router.get('/unread-count', authUser, (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT last_board_seen_at FROM users WHERE id = ?').get(req.uid) || {};
  if (!u.last_board_seen_at) {
    // 初回はゼロ件として扱い、現在時刻を埋め込む (以降の新着のみカウント)
    db.prepare("UPDATE users SET last_board_seen_at = datetime('now') WHERE id = ?").run(req.uid);
    return res.json({ success: true, count: 0 });
  }
  const row = db.prepare(`SELECT COUNT(*) AS n FROM board_posts
                          WHERE deleted_at IS NULL AND (circle_id IS NULL OR circle_id = '')
                            AND author_id != ? AND created_at > ?`)
                .get(req.uid, u.last_board_seen_at);
  res.json({ success: true, count: Math.min(row.n || 0, 99) });
});

// 既読化 (board.html を開いたタイミングで叩く)
router.post('/mark-seen', authUser, (req, res) => {
  getDb().prepare("UPDATE users SET last_board_seen_at = datetime('now') WHERE id = ?").run(req.uid);
  res.json({ success: true });
});

module.exports = router;
