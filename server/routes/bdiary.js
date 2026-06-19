// 元祖Ｂさんの愛の日記 (2026-06-16)
// 闘病中の社員Bさんが、声→まとめる君→大ボタンで日記を投稿。全登録メンバーが応援・コメント。
// 精神面の配慮: ノルマ/連続記録/プレッシャー指標なし。弱音サイン検知時は見守り役(推進メンバー=金子専務含む)へ静かに通知。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const AUTHOR_LABEL = 'Bさん'; // 実名は出さない
const UP_DIR = path.join('/opt/cohub/uploads/bdiary');
try { fs.mkdirSync(UP_DIR, { recursive: true }); } catch (e) {}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UP_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '') || '.jpg').slice(0, 8);
      cb(null, 'b' + Date.now() + '_' + Math.round(Math.random() * 1e6) + ext);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
});

function ensureTables() {
  const db = getDb();
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS bdiary_config (key TEXT PRIMARY KEY, value TEXT)`).run();
    db.prepare(`CREATE TABLE IF NOT EXISTS bdiary_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id TEXT NOT NULL,
      body TEXT,
      photo_url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      hidden INTEGER DEFAULT 0
    )`).run();
    // 種別: 'diary'=Bさんの日記(Bさん表示) / 'cheer'=みんなの応援メッセージ(発信者名を表示)
    try { db.prepare(`ALTER TABLE bdiary_posts ADD COLUMN kind TEXT DEFAULT 'diary'`).run(); } catch (e) {}
    db.prepare(`CREATE TABLE IF NOT EXISTS bdiary_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      hidden INTEGER DEFAULT 0
    )`).run();
    db.prepare(`CREATE TABLE IF NOT EXISTS bdiary_reactions (
      post_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '❤️',
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (post_id, user_id, emoji)
    )`).run();
    // 旧スキーマ(post_id,user_idのみ=単一❤応援)からの移行: emoji列が無ければ作り直す
    const rinfo = db.prepare('PRAGMA table_info(bdiary_reactions)').all();
    if (!rinfo.some(c => c.name === 'emoji')) {
      db.exec(`
        ALTER TABLE bdiary_reactions RENAME TO bdiary_reactions_old;
        CREATE TABLE bdiary_reactions (post_id INTEGER NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '❤️', created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (post_id, user_id, emoji));
        INSERT OR IGNORE INTO bdiary_reactions (post_id, user_id, emoji, created_at) SELECT post_id, user_id, '❤️', created_at FROM bdiary_reactions_old;
        DROP TABLE bdiary_reactions_old;
      `);
    }
    db.prepare(`CREATE TABLE IF NOT EXISTS bdiary_seen (user_id TEXT PRIMARY KEY, last_seen_at TEXT)`).run();
  } catch (e) { console.warn('[bdiary] ensureTables:', e.message); }
}
// 日記に合う温かいリアクション6種(ひろば流)
const ALLOWED_EMOJIS = ['👍', '❤️', '😊', '💪', '👏', '🙏'];
try { ensureTables(); } catch (e) {}

function getAuthorId(db) {
  const r = db.prepare(`SELECT value FROM bdiary_config WHERE key='author_id'`).get();
  return r ? r.value : null;
}
function isPrivileged(db, uid) {
  try {
    const u = db.prepare(`SELECT role, employee_type, is_manager FROM users WHERE id = ?`).get(uid);
    return !!u && (u.is_manager === 1 || u.role === 'admin' || u.employee_type === 'admin');
  } catch (e) { return false; }
}
// 日記を書けるのは本人(Bさん)だけ。代理投稿は廃止(2026-06-19)。
// 応援したい人は実名の「応援メッセージ」(/cheer)で佐藤さんに届ける。
function canPost(db, uid) {
  const author = getAuthorId(db);
  return !!author && uid === author;
}

// 弱音/危機のサイン (見守り役へ静かに通知)。誤検知は許容(温かい声かけのきっかけ)。
const DISTRESS = ['死にたい', '消えたい', 'いなくなりたい', 'もう無理', 'もうだめ', 'もうダメ', '生きてても', '生きる意味', 'さよなら', 'お別れ', '限界', '耐えられ', '助けて', 'つらすぎ', '苦しくて', '怖くて'];
function checkDistress(text) {
  const t = String(text || '');
  return DISTRESS.some(k => t.includes(k));
}
function notifyWatchers(req, postId, snippet) {
  try {
    const db = getDb();
    const watchers = db.prepare(`SELECT id FROM users WHERE is_field_promoter = 1`).all().map(r => r.id);
    if (!watchers.length) return;
    const emit = req.app && req.app.locals && req.app.locals.emitToUser;
    const dmIns = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')");
    const msg = `🍀 「元祖Ｂさんの愛の日記」に、少し気にかけたい言葉がありました。\nそっと様子を気にかけて、よければ励ましの一言を。\n→ /bdiary.html`;
    for (const uid of watchers) {
      try {
        const r = dmIns.run('bot_promoter', uid, msg);
        if (emit) emit(uid, 'dm:msg', { id: r.lastInsertRowid, from: 'bot_promoter', to: uid, content: msg, at: new Date().toISOString() });
      } catch (e) {}
    }
  } catch (e) { console.warn('[bdiary] notifyWatchers:', e.message); }
}

// ===== フィード取得 (全登録メンバー閲覧可) + 既読更新 =====
router.get('/', authUser, (req, res) => {
  const db = getDb();
  const author = getAuthorId(db);
  const authorUser = author ? db.prepare(`SELECT avatar_url FROM users WHERE id = ?`).get(author) : null;
  const posts = db.prepare(`SELECT p.id, p.author_id, p.body, p.photo_url, p.created_at, COALESCE(p.kind,'diary') AS kind, u.display_name AS sender_name, u.avatar_url AS sender_avatar
    FROM bdiary_posts p LEFT JOIN users u ON u.id = p.author_id
    WHERE p.hidden = 0 ORDER BY p.created_at DESC, p.id DESC LIMIT 100`).all();
  const reactions = db.prepare(`SELECT post_id, emoji, COUNT(*) c, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) mine FROM bdiary_reactions GROUP BY post_id, emoji`).all(req.uid);
  const rmap = {};
  reactions.forEach(r => {
    if (!rmap[r.post_id]) rmap[r.post_id] = { counts: {}, mine: {} };
    rmap[r.post_id].counts[r.emoji] = r.c;
    if (r.mine > 0) rmap[r.post_id].mine[r.emoji] = true;
  });
  const comments = db.prepare(`
    SELECT c.id, c.post_id, c.body, c.created_at, u.display_name, u.avatar_url
    FROM bdiary_comments c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.hidden = 0 ORDER BY c.created_at ASC`).all();
  const cmap = {}; comments.forEach(c => { (cmap[c.post_id] = cmap[c.post_id] || []).push({ id: c.id, name: c.display_name || '', avatar: c.avatar_url || '', body: c.body, created_at: c.created_at }); });
  // 既読更新
  try { db.prepare(`INSERT INTO bdiary_seen (user_id, last_seen_at) VALUES (?, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET last_seen_at = datetime('now')`).run(req.uid); } catch (e) {}
  const priv = isPrivileged(db, req.uid); // 管理職は不適切投稿をモデレーション削除可
  res.json({
    success: true,
    title: '元祖Ｂさんの愛の日記',
    author_label: AUTHOR_LABEL,
    author_avatar: (authorUser && authorUser.avatar_url) || '',
    author_set: !!author,
    is_author: !!author && req.uid === author,
    can_post: canPost(db, req.uid),
    allowed_emojis: ALLOWED_EMOJIS,
    me: req.uid,
    posts: posts.map(p => ({
      id: p.id,
      kind: p.kind,
      body: p.body || '',
      photo_url: p.photo_url || '',
      created_at: p.created_at,
      sender_name: p.kind === 'cheer' ? (p.sender_name || 'メンバー') : '',
      sender_avatar: p.kind === 'cheer' ? (p.sender_avatar || '') : '',
      can_delete: p.author_id === req.uid || priv,
      reactions: (rmap[p.id] && rmap[p.id].counts) || {},
      my_reactions: (rmap[p.id] && rmap[p.id].mine) || {},
      comments: cmap[p.id] || [],
    })),
  });
});

// 新着(未読)件数 — ホームバッジ用 (本人の投稿で、最後に見た時刻より新しいもの)
router.get('/unread-count', authUser, (req, res) => {
  const db = getDb();
  const seen = db.prepare(`SELECT last_seen_at FROM bdiary_seen WHERE user_id = ?`).get(req.uid);
  const since = seen ? seen.last_seen_at : '1970-01-01';
  const r = db.prepare(`SELECT COUNT(*) c FROM bdiary_posts WHERE hidden = 0 AND created_at > ?`).get(since);
  res.json({ success: true, count: r.c || 0 });
});

// 投稿 (本人 or 代理)
router.post('/', authUser, upload.single('photo'), (req, res) => {
  const db = getDb();
  if (!canPost(db, req.uid)) return res.status(403).json({ success: false, msg: '投稿権限がありません' });
  const body = String((req.body && req.body.body) || '').trim().slice(0, 4000);
  const photo = req.file ? '/uploads/bdiary/' + req.file.filename : null;
  if (!body && !photo) return res.status(400).json({ success: false, msg: '本文か写真を入れてください' });
  const author = getAuthorId(db) || req.uid; // 代理投稿でも著者はBさん名義
  const r = db.prepare(`INSERT INTO bdiary_posts (author_id, body, photo_url) VALUES (?, ?, ?)`).run(author, body, photo);
  // 弱音サイン → 見守り役へ静かに通知
  if (checkDistress(body)) notifyWatchers(req, r.lastInsertRowid, body);
  res.json({ success: true, id: r.lastInsertRowid });
});

// 応援メッセージ (全メンバーが投稿可・発信者名を表示。写真添付可。Bさんが書かない日もみんなの応援で賑わう)
router.post('/cheer', authUser, upload.single('photo'), (req, res) => {
  const db = getDb();
  const body = String((req.body && req.body.body) || '').trim().slice(0, 1000);
  const photo = req.file ? '/uploads/bdiary/' + req.file.filename : null;
  if (!body && !photo) return res.status(400).json({ success: false, msg: '応援メッセージか写真を入れてください' });
  const r = db.prepare(`INSERT INTO bdiary_posts (author_id, body, photo_url, kind) VALUES (?, ?, ?, 'cheer')`).run(req.uid, body, photo);
  res.json({ success: true, id: r.lastInsertRowid });
});

// リアクション(絵文字) トグル
router.post('/:id/react', authUser, express.json(), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const emoji = String((req.body && req.body.emoji) || '');
  if (!ALLOWED_EMOJIS.includes(emoji)) return res.status(400).json({ success: false, msg: '不正なリアクション' });
  const post = db.prepare(`SELECT id FROM bdiary_posts WHERE id = ? AND hidden = 0`).get(id);
  if (!post) return res.status(404).json({ success: false, msg: '見つかりません' });
  const exists = db.prepare(`SELECT 1 FROM bdiary_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?`).get(id, req.uid, emoji);
  if (exists) db.prepare(`DELETE FROM bdiary_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?`).run(id, req.uid, emoji);
  else db.prepare(`INSERT OR IGNORE INTO bdiary_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)`).run(id, req.uid, emoji);
  const c = db.prepare(`SELECT COUNT(*) c FROM bdiary_reactions WHERE post_id = ? AND emoji = ?`).get(id, emoji).c;
  res.json({ success: true, emoji, count: c, mine: !exists });
});

// コメント(励まし)
router.post('/:id/comment', authUser, express.json(), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const post = db.prepare(`SELECT id FROM bdiary_posts WHERE id = ? AND hidden = 0`).get(id);
  if (!post) return res.status(404).json({ success: false, msg: '見つかりません' });
  const body = String((req.body && req.body.body) || '').trim().slice(0, 1000);
  if (!body) return res.status(400).json({ success: false, msg: 'メッセージを入力してください' });
  const r = db.prepare(`INSERT INTO bdiary_comments (post_id, user_id, body) VALUES (?, ?, ?)`).run(id, req.uid, body);
  res.json({ success: true, id: r.lastInsertRowid });
});

// 投稿を隠す (日記=本人/管理職、応援メッセージ=書いた本人 or 管理職)
router.delete('/:id', authUser, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const post = db.prepare(`SELECT author_id, COALESCE(kind,'diary') AS kind FROM bdiary_posts WHERE id = ?`).get(id);
  if (!post) return res.json({ success: true });
  const own = post.author_id === req.uid; // 自分の投稿(本人の日記 or 自分の応援)
  if (!own && !isPrivileged(db, req.uid)) return res.status(403).json({ success: false, msg: '権限がありません' });
  db.prepare(`UPDATE bdiary_posts SET hidden = 1 WHERE id = ?`).run(id);
  res.json({ success: true });
});

// コメントを隠す (本人 or 管理職)
router.delete('/comment/:cid', authUser, (req, res) => {
  const db = getDb();
  const cid = parseInt(req.params.cid);
  const c = db.prepare(`SELECT user_id FROM bdiary_comments WHERE id = ?`).get(cid);
  if (!c) return res.json({ success: true });
  if (c.user_id !== req.uid && !isPrivileged(db, req.uid)) return res.status(403).json({ success: false, msg: '権限がありません' });
  db.prepare(`UPDATE bdiary_comments SET hidden = 1 WHERE id = ?`).run(cid);
  res.json({ success: true });
});

// 著者(Bさん)アカウントの設定 — 管理職/ADMINのみ
router.post('/set-author', authUser, express.json(), (req, res) => {
  const db = getDb();
  if (!isPrivileged(db, req.uid)) return res.status(403).json({ success: false, msg: '権限がありません' });
  const uid = String((req.body && req.body.user_id) || '').trim();
  const u = uid ? db.prepare(`SELECT id, display_name FROM users WHERE id = ?`).get(uid) : null;
  if (!u) return res.status(400).json({ success: false, msg: '対象ユーザーが見つかりません' });
  db.prepare(`INSERT INTO bdiary_config (key, value) VALUES ('author_id', ?) ON CONFLICT(key) DO UPDATE SET value = ?`).run(uid, uid);
  res.json({ success: true, author: u.display_name });
});

module.exports = router;
