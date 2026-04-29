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

// AI 応答 (5セクション/旧形式) を統一フォーマット文字列に整形
// 出力例: "【良い点】\n...\n\n【悪い点】\n...\n\n..."
function formatAdvisorSections(r) {
  if (!r || typeof r !== 'object') return null;
  const SECTIONS = [
    ['good', '良い点'], ['bad', '悪い点'], ['improve', '改善点'],
    ['trend', 'あなたの傾向'], ['try', 'やってみよう！'],
  ];
  const parts = [];
  for (const [k, label] of SECTIONS) {
    const v = typeof r[k] === 'string' ? r[k].trim() : '';
    if (v) parts.push('【' + label + '】\n' + v);
  }
  if (parts.length) return parts.join('\n\n').slice(0, 2000);
  // 旧形式フォールバック
  if (typeof r.comment_health === 'string' && r.comment_health.trim()) {
    return '【AIヘルスアドバイザー】\n' + r.comment_health.trim().slice(0, 1500);
  }
  if (typeof r.comment_nutrition === 'string' && r.comment_nutrition.trim()) {
    return '【AI栄養アドバイザー】\n' + r.comment_nutrition.trim().slice(0, 1500);
  }
  if (r.comment != null) {
    return (typeof r.comment === 'string' ? r.comment : Object.values(r.comment).filter(v => typeof v === 'string').join(' / ')).slice(0, 1500);
  }
  return null;
}

// 過去7日(最大7件)の食事ログを収集 (CoHub plaza_posts + CoWell Classic ミラー cw_posts)
// AI ヘルスアドバイザーに傾向ベースの次回提案をさせるための要約配列を返す
function collectRecentMeals(uid) {
  const db = getDb();
  const rows = [];
  // 1) CoHub plaza_posts (本人の食事カテゴリ)
  try {
    const r1 = db.prepare(`SELECT created_at AS ts, nutrition_scores AS ns FROM plaza_posts
      WHERE author_id=? AND category='食事' AND nutrition_scores IS NOT NULL AND deleted_at IS NULL
      AND created_at >= datetime('now','-7 days')
      ORDER BY created_at DESC LIMIT 7`).all(uid);
    rows.push(...r1);
  } catch (e) {}
  // 2) CoWell Classic ミラー (cw_users で cohub_uid=uid のレコードに紐づく cw_posts)
  try {
    const cwIds = db.prepare(`SELECT cw_id FROM cw_users WHERE cohub_uid=?`).all(uid).map(r => r.cw_id);
    if (cwIds.length) {
      const ph = cwIds.map(() => '?').join(',');
      const r2 = db.prepare(`SELECT cw_created_at AS ts, nutrition_scores AS ns FROM cw_posts
        WHERE cw_user_id IN (${ph}) AND category LIKE '%食事%' AND nutrition_scores IS NOT NULL
        AND cw_created_at >= datetime('now','-7 days')
        ORDER BY cw_created_at DESC LIMIT 7`).all(...cwIds);
      rows.push(...r2);
    }
  } catch (e) {}
  // 統合・新着順・要約
  rows.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const summarize = (ns) => {
    let s; try { s = typeof ns === 'string' ? JSON.parse(ns) : ns; } catch { return null; }
    const v = (k) => { const x = s && s[k]; return (x && typeof x === 'object') ? Number(x.value) : (typeof x === 'number' ? x : 0); };
    return {
      kcal: v('calories'), protein: v('protein'), fat: v('fat'), carbs: v('carbs'),
      veg: v('vitamin'), ca: v('mineral'), salt: v('salt'), fiber: v('fiber'), alc: v('alcohol'),
    };
  };
  const result = [];
  for (const r of rows) {
    const sm = summarize(r.ns);
    if (!sm) continue;
    result.push({ date: (r.ts || '').slice(0, 10), ...sm });
    if (result.length >= 7) break;
  }
  return result;
}

// 一覧 (新着順、過去アーカイブと統合表示)
router.get('/posts', authUser, (req, res) => {
  const cat = req.query.category;
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const before = parseInt(req.query.before) || null;
  const includeArchive = req.query.archive !== '0';
  const db = getDb();

  let sql = `SELECT p.id, p.author_id, p.category, p.content, p.image_url, p.nutrition_scores,
                    p.ai_comment, p.is_anonymous, p.created_at,
                    u.display_name AS author_name, u.avatar_url AS author_avatar, u.company_code AS author_company,
                    u.nickname AS author_nickname
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
    const isAuthor = p.author_id === me;
    const enr = {
      ...p,
      kind: 'plaza',
      reactions: counts,
      my_reactions: mine,
      comment_count: cmtMap[p.id] || 0,
      can_delete: isAuthor,
      is_mine: isAuthor,
    };
    // 匿名投稿: 投稿者本人以外には author_id/name/avatar/company を隠す
    // ニックネームが設定されていれば表示 (本人のみ実名と紐付け可能)
    if (p.is_anonymous && !isAuthor) {
      enr.author_id = null;
      enr.author_name = p.author_nickname ? '🎭 ' + p.author_nickname : '🎭 匿名';
      enr.author_avatar = null;
      enr.author_company = null;
    }
    delete enr.author_nickname;
    return enr;
  });

  // 初回のみ過去アーカイブ (cw_posts) も取り込んで時系列マージ
  // CoWell の category (🍱 食事・栄養 等) を plaza の category (食事 等) に正規化
  const CW_CAT_NORMALIZE = `CASE
    WHEN cp.category LIKE '%食事%' OR cp.category LIKE '%栄養%' THEN '食事'
    WHEN cp.category LIKE '%相談%' OR cp.category LIKE '%提案%' THEN '相談'
    WHEN cp.category LIKE '%Tips%' OR cp.category LIKE '%ヒント%' THEN '健康Tips'
    ELSE '雑談'
  END`;
  // CoWell の image_url を cohub 経由のプロキシに書き換え
  // (CoWellは Cross-Origin-Resource-Policy: same-origin を返すので直リン不可)
  function rewriteCwImage(url) {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    if (url.startsWith('/uploads/')) {
      const fname = url.replace(/^\/uploads\//, '');
      return '/api/cw-archive/img/' + encodeURIComponent(fname);
    }
    return url;
  }
  let archive = [];
  if (includeArchive && !before) {
    let asql = `SELECT cp.cw_post_id AS id, cp.cw_user_id AS author_cw_id, cp.content,
                       cp.image_url, cp.nutrition_scores, cp.analysis, ${CW_CAT_NORMALIZE} AS category,
                       cp.category AS cw_orig_category, cp.nickname AS cw_post_nickname,
                       cp.cw_created_at AS created_at,
                       cu.cohub_uid AS author_id, cu.nickname AS cw_nickname, cu.real_name AS cw_real_name
                FROM cw_posts cp
                LEFT JOIN cw_users cu ON cu.cw_id = cp.cw_user_id
                WHERE 1=1`;
    const aparams = [];
    if (cat && CATEGORIES.includes(cat)) {
      asql += ` AND ${CW_CAT_NORMALIZE} = ?`;
      aparams.push(cat);
    }
    asql += ' ORDER BY cp.cw_created_at DESC LIMIT 80';
    archive = db.prepare(asql).all(...aparams).map(p => {
      // CoWellのプライバシー保持: nicknameのみ表示、実名は出さない
      // 画像URLはCoWell本体に書き換え、「【写真】なし」placeholderは画像があれば隠す
      const nick = p.cw_post_nickname || p.cw_nickname || '匿名';
      let content = p.content || '';
      if (content.startsWith('【写真】なし')) content = content.replace(/^【写真】なし/, '').trim();
      else if (content.startsWith('【写真】')) content = content.replace(/^【写真】/, '').trim();
      return {
        ...p,
        kind: 'archive',
        content: content,
        image_url: rewriteCwImage(p.image_url),
        ai_comment: p.analysis || null,  // CoWell の分析テキストをコメントとして渡す
        author_name: nick + ' (CoWell)',
        author_avatar: null,  // CoHubアバターを出すと実名アバターが見えてしまう
        author_company: null,
        is_cowell_archive: true,
        is_anonymous: 0,
        is_mine: false,
        reactions: {}, my_reactions: {}, comment_count: 0, can_delete: false,
      };
    });
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
  const isAnonymous = (req.body && (req.body.is_anonymous === '1' || req.body.is_anonymous === 'true')) ? 1 : 0;

  // 食事カテゴリ + 画像あり → AI 栄養分析を試行 (失敗しても投稿は成立)
  // CoWell 互換フォーマット ({calories:{value,unit}, protein:{value,unit}, ... confidence:{level,reason}}) で保存
  let nutritionScores = null;
  let aiComment = null;
  if (category === '食事' && req.file) {
    console.log('[plaza] AI analysis start: file=' + req.file.filename + ' mime=' + req.file.mimetype);
    try {
      const buf = fs.readFileSync(req.file.path);
      // 過去7日の食事ログを収集 (CoHub plaza_posts + CoWell Classic ミラー cw_posts)
      const recentMeals = collectRecentMeals(req.uid);
      console.log('[plaza] recent meals for trend:', recentMeals.length);
      const r = await analyzeFoodImage(buf, req.file.mimetype, content, recentMeals);
      if (r && typeof r === 'object') {
        // 5セクション形式 (good/bad/improve/trend/try) を結合保存
        // 旧形式 (comment_nutrition/comment_health/comment) もフォールバック
        aiComment = formatAdvisorSections(r);
        // CoWellフォーマットの数値項目を抽出してJSON保存
        const NUTRI_KEYS = ['calories', 'protein', 'fat', 'carbs', 'vitamin', 'mineral', 'salt', 'fiber', 'alcohol'];
        const scores = {};
        let hasAny = false;
        for (const k of NUTRI_KEYS) {
          if (r[k] != null) {
            scores[k] = r[k];
            hasAny = true;
          }
        }
        if (r.has_alcohol != null) scores.has_alcohol = !!r.has_alcohol;
        if (r.confidence != null) scores.confidence = r.confidence;
        if (hasAny) nutritionScores = JSON.stringify(scores);
      }
      console.log('[plaza] AI done: scores=' + (nutritionScores ? 'YES' : 'no') + ' comment_len=' + (aiComment ? aiComment.length : 0));
    } catch (e) { console.warn('[plaza] food AI fail:', e.message); }
  }

  const db = getDb();
  const ins = db.prepare(`INSERT INTO plaza_posts (author_id, category, content, image_url, nutrition_scores, ai_comment, is_anonymous)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.uid, category, content, imageUrl, nutritionScores, aiComment, isAnonymous);
  const post = db.prepare(`SELECT p.*, u.display_name AS author_name, u.avatar_url AS author_avatar, u.company_code AS author_company, u.nickname AS author_nickname
                           FROM plaza_posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.id = ?`).get(ins.lastInsertRowid);
  post.kind = 'plaza';
  post.reactions = Object.fromEntries(ALLOWED_EMOJIS.map(e => [e, 0]));
  post.my_reactions = Object.fromEntries(ALLOWED_EMOJIS.map(e => [e, false]));
  post.comment_count = 0;
  post.can_delete = true;
  post.is_mine = true;

  // 全員配信用の匿名化版 (本人以外向け、ニックネームがあれば表示)
  const anonymizedPost = isAnonymous ? {
    ...post,
    author_id: null,
    author_name: post.author_nickname ? '🎭 ' + post.author_nickname : '🎭 匿名',
    author_avatar: null,
    author_company: null,
    author_nickname: undefined,
    is_mine: false,
    can_delete: false,
  } : post;
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('plaza:new', { post: anonymizedPost });
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
