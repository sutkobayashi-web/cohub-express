const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { analyzeFoodImage, generateText } = require('../services/ai');

const CATEGORIES = ['食事', '相談', '雑談', '健康Tips'];

// ── 悩み相談(相談カテゴリ)の一次対応【黒子型 + 3段階トリアージ】 2026-05-26 ──
// AIは公開の自動返信はせず、推進メンバーのグループ(g_field_voice)へ「相談内容+Tier+AI下書き」を流す。
// 表の回答は人が自分の言葉で行う。Tierに応じて push 先(つなぐ先)を変える:
//   Tier1 軽い/一般  → 推進メンバーがピア対応 (AI下書きあり)
//   Tier2 要観察/健康 → 安島さん(NPO法人ヘルスケアネットワーク)へ
//   Tier3 危機/メンタル→ 西村さん(産業医紹介の窓口)+管理者へ。AI助言は出さない
// 設計詳細: docs/悩み相談_AI一次対応とトリアージ設計.md
const CONSULT_PROMOTER_GROUP = 'g_field_voice';
const CONSULT_NPO_LOGIN = 'dalerisu';            // 安島=NPOヘルスケアネットワーク (Tier2のつなぐ先)
const CONSULT_SANGYOI_GW_LOGIN = 's_nishimura';  // 西村=産業医紹介の窓口 (Tier3。傍観者だが危機時のみ)
// 深刻ワード(検知したら問答無用でTier3=AI助言なし・緊急エスカレ)
const CONSULT_SERIOUS_RE = /(死に?たい|消えたい|自殺|リスカ|リストカット|死のう|生きてても|もう限界|限界です|うつ病|鬱|パワハラ|セクハラ|暴力|殴ら|蹴ら|いじめ|ハラスメント|虐待|休職|辞めたい|退職したい)/;

function consultUidByLogin(db, loginId) {
  try { const r = db.prepare('SELECT id FROM users WHERE login_id = ?').get(loginId); return r ? r.id : null; }
  catch (e) { return null; }
}

// 相談内容を Tier 1/2/3 に分類し、Tier1/2 はAI下書きも生成 (深刻ワードは即Tier3)
async function classifyConsult(content) {
  if (CONSULT_SERIOUS_RE.test(content)) return { tier: 3, draft: '' };
  try {
    const prompt =
      'あなたは運送会社の健康推進担当を補佐するアシスタント。社員が匿名投稿した「悩み相談」を分類し回答下書きを作る。\n' +
      '相談内容:\n「' + content.slice(0, 1500) + '」\n\n' +
      'tierの基準:\n' +
      '1=軽い/一般的(寒暖差の頭痛・肩こり・軽い食事や生活の相談など、ピアで十分)\n' +
      '2=要観察/専門寄り(眠れない日が続く・血圧・慢性的な不調・強いストレスなど、健康相談の専門窓口につなぐべき)\n' +
      '3=深刻/危機(希死念慮・ハラスメント・メンタル危機など)\n\n' +
      'draftの方針(医療診断・断定はしない):\n' +
      'tier1: 推進メンバーが本人へそのまま手直しして返せる下書き →【共感】【一般的なアドバイス2-3点】【次の一歩】【回答者向けメモ】\n' +
      'tier2: 「専門の窓口(NPO)におつなぎします」方向。共感+一般情報+つなぐ旨+回答者向けメモ\n' +
      'tier3: draftは空文字\n\n' +
      '次のJSONのみで返答: {"tier":1|2|3,"draft":"日本語の下書き(tier3は空)"}';
    const raw = await generateText(prompt, { responseMimeType: 'application/json', maxTokens: 900, thinkingBudget: 0 });
    const j = JSON.parse(raw);
    const tier = [1, 2, 3].includes(j.tier) ? j.tier : 1;
    const draft = tier === 3 ? '' : String(j.draft || '').trim();
    return { tier, draft };
  } catch (e) {
    return { tier: 1, draft: '(AI下書き生成に失敗: ' + e.message + ')\nお手数ですが内容を読んで対応をお願いします。' };
  }
}

// 相談投稿 → Tier分類 → 推進グループへ記録 + Tier別つなぐ先へpush (非同期・投稿成立を妨げない)
async function notifyConsultToPromoters(app, post) {
  try {
    const db = getDb();
    const content = String(post.content || '').trim();
    if (!content) return;
    const nick = post.is_anonymous
      ? (post.author_nickname ? '🎭 ' + post.author_nickname : '🎭 匿名')
      : (post.author_name || '社員');

    const { tier, draft } = await classifyConsult(content);

    let head, bodyAction, pushTitle, urgent, targets;
    if (tier === 3) {
      head = '🚨 悩み相談【Tier3 / 危機】';
      bodyAction = '─ 対応 ─\nAIの助言は控えます。本人の安全確認を最優先に。\n→ 西村さんが産業医を紹介し、管理者がフォローしてください(必要なら外部相談窓口)。';
      pushTitle = '🚨 悩み相談【Tier3 危機】';
      urgent = true;
      const gw = consultUidByLogin(db, CONSULT_SANGYOI_GW_LOGIN);
      const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND employee_type='admin'").all().map(r => r.id);
      targets = [gw, ...admins];
    } else if (tier === 2) {
      head = '🟡 悩み相談【Tier2 / 要観察】→ 安島さん(NPO法人ヘルスケアネットワーク)へ';
      bodyAction = '─ AI下書き ─\n' + draft;
      pushTitle = '🟡 悩み相談【Tier2】NPO対応案件';
      urgent = false;
      targets = [consultUidByLogin(db, CONSULT_NPO_LOGIN)];
    } else {
      head = '🆘 悩み相談【Tier1】推進メンバーがピア対応 (AI下書き / 返信は人がお願いします)';
      bodyAction = '─ AI下書き ─\n' + draft;
      pushTitle = '🆘 悩み相談【Tier1】';
      urgent = false;
      targets = db.prepare('SELECT user_id FROM chat_group_members WHERE group_id = ?').all(CONSULT_PROMOTER_GROUP).map(r => r.user_id);
    }

    const msgContent = [
      head,
      '投稿者: ' + nick + '　#' + post.id,
      '─ 相談内容 ─',
      content.slice(0, 600),
      bodyAction,
      '→ 「悩み相談」を開いて、あなたの言葉で返信してください: /plaza.html?tab=相談',
    ].join('\n');

    // g_field_voice に記録 (全推進メンバーが見える) — Tierに関わらず投稿
    const roomCode = 'grp_' + CONSULT_PROMOTER_GROUP;
    const msgIns = db.prepare(`INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES ('bot_health', NULL, ?, ?)`).run(msgContent, roomCode);
    const payload = { id: msgIns.lastInsertRowid, from: 'bot_health', group_id: CONSULT_PROMOTER_GROUP, content: msgContent, at: new Date().toISOString(), attach: null };
    const emitG = app && app.locals && app.locals.emitToGroupMembers;
    if (emitG) emitG(CONSULT_PROMOTER_GROUP, 'group:msg', payload);

    // push: Tier別のつなぐ先へ (重複排除)
    const sendPush = app && app.locals && app.locals.sendPushToUser;
    if (sendPush) {
      const seen = new Set();
      for (const uid of targets) {
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        sendPush(uid, {
          title: pushTitle,
          body: content.slice(0, 100),
          tag: 'consult-' + post.id,
          url: '/?g=' + CONSULT_PROMOTER_GROUP,
          requireInteraction: urgent,
        }).catch(() => {});
      }
    }
  } catch (e) { console.warn('[plaza] consult notify fail', e.message); }
}

// 起動時マイグレーション: 追加飲酒記録カラム (写真未反映分の自己申告)
try {
  const db = getDb();
  const cols = new Set(db.prepare('PRAGMA table_info(plaza_posts)').all().map(c => c.name));
  if (!cols.has('extra_alcohol_g')) {
    db.prepare('ALTER TABLE plaza_posts ADD COLUMN extra_alcohol_g REAL DEFAULT 0').run();
    console.log('[plaza] migrated: plaza_posts.extra_alcohol_g');
  }
} catch (e) { console.warn('[plaza] migration skipped:', e.message); }

// 飲酒プリセット (純アルコール g)
// ビール350=14, 中ジョッキ500=20, 日本酒1合=22, ワイン1杯=12, ハイボール=14, 焼酎水割り=20
const ALCOHOL_PRESETS = {
  beer_can_350:  { label: 'ビール缶 350ml',     g: 14 },
  beer_mug_500:  { label: '中ジョッキ 500ml',   g: 20 },
  sake_1go:      { label: '日本酒 1合',          g: 22 },
  wine_glass:    { label: 'ワイン グラス',        g: 12 },
  highball:      { label: 'ハイボール',           g: 14 },
  shochu_mizu:   { label: '焼酎 水割り',         g: 20 },
};
// 反応セット (8種): 👍いいね/❤️推し/😊共感/💪応援/👏すごい/💡参考/🙏ありがとう/😢心配
// 🎉は旧データ互換のため許容（UIには表示しない）
const ALLOWED_EMOJIS = ['👍', '❤️', '😊', '💪', '👏', '💡', '🙏', '😢', '🎉'];
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
    const r1 = db.prepare(`SELECT created_at AS ts, nutrition_scores AS ns, COALESCE(extra_alcohol_g, 0) AS extra_alc FROM plaza_posts
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
    // 追加飲酒(写真未反映分の自己申告)をアルコール総量に加算
    const extra = Number(r.extra_alc || 0);
    if (extra > 0) sm.alc = Math.round((sm.alc + extra) * 10) / 10;
    result.push({ date: (r.ts || '').slice(0, 10), ...sm });
    if (result.length >= 7) break;
  }
  return result;
}

// nutrition_scores JSON に extra_alcohol_g を加算した表示用オブジェクトを返す
function mergeExtraAlcohol(nutritionScoresJson, extraG) {
  const extra = Number(extraG || 0);
  if (!nutritionScoresJson) return nutritionScoresJson;
  if (!extra) return nutritionScoresJson;
  try {
    const ns = typeof nutritionScoresJson === 'string' ? JSON.parse(nutritionScoresJson) : { ...nutritionScoresJson };
    const cur = ns.alcohol;
    let curV = 0;
    if (cur && typeof cur === 'object') curV = Number(cur.value || 0);
    else if (typeof cur === 'number') curV = cur;
    const total = Math.round((curV + extra) * 10) / 10;
    ns.alcohol = { value: total, unit: 'g' };
    ns.has_alcohol = true;
    ns.alcohol_breakdown = { ai_g: curV, extra_g: extra, total_g: total };
    return JSON.stringify(ns);
  } catch (e) {
    return nutritionScoresJson;
  }
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
                    COALESCE(p.extra_alcohol_g, 0) AS extra_alcohol_g,
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
      // 表示用: nutrition_scores に extra_alcohol_g を合算
      nutrition_scores: mergeExtraAlcohol(p.nutrition_scores, p.extra_alcohol_g),
    };
    // 匿名(ニックネーム)投稿: 表示名は本人・他人ともニックネームに統一する。
    //   以前は本人(isAuthor)のとき実名(display_name)のままで、「自分の食事投稿に
    //   ニックネームが表示されない」状態だった(2026-05-25 修正)。「🎭ニックネームで投稿中」
    //   バッジとも整合させ、本人にもニックネームを出す。
    //   他人にはさらに author_id/avatar/company を隠し実名と紐付かないようにする
    //   (本人にはアバター/編集権を残す → is_mine/can_delete は上で設定済み)。
    if (p.is_anonymous) {
      enr.author_name = p.author_nickname ? '🎭 ' + p.author_nickname : '🎭 匿名';
      if (!isAuthor) {
        enr.author_id = null;
        enr.author_avatar = null;
        enr.author_company = null;
      }
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
  res.set('Cache-Control', 'no-store'); // ニックネーム等の表示変更が即反映されるようキャッシュ無効化
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
  post.extra_alcohol_g = 0;

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

  // OS push 配信 (食事/相談 のみ、投稿者本人は除外)。アプリ閉じてても気づける用。
  try {
    if (category === '食事' || category === '相談') {
      const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
      if (sendPush) {
        const titlePrefix = category === '食事' ? '🍱 ひろば' : '💬 ひろば';
        const who = (anonymizedPost.author_nickname || anonymizedPost.author_name || 'どなたか').replace(/^🎭\s*/, '');
        const verbKansai = category === '食事' ? 'メシ載せてくれはったわ' : '相談あげてくれはったわ';
        const body = who + 'さんが' + verbKansai;
        const recipients = getDb().prepare('SELECT DISTINCT user_id FROM push_subscriptions WHERE user_id != ?').all(post.author_id);
        for (const r of recipients) {
          sendPush(r.user_id, {
            title: titlePrefix,
            body,
            tag: 'plaza-new-' + ins.lastInsertRowid,
            url: '/plaza.html',
            alwaysShow: true,
            requireInteraction: true,
            vibrate: [220, 100, 220, 100, 320],
          }).catch(() => {});
        }
      }
    }
  } catch (e) { console.warn('[plaza] push broadcast fail', e.message); }

  // 悩み相談【黒子型】: AIが回答下書きを作り推進グループへ通知 (非同期・投稿成立は妨げない)
  if (category === '相談') {
    notifyConsultToPromoters(req.app, post);
  }

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
  const me = req.uid;
  const rows = getDb().prepare(`SELECT c.id, c.author_id, c.content, c.created_at,
                                       u.nickname AS author_nickname, u.avatar_url AS author_avatar
                                FROM plaza_comments c LEFT JOIN users u ON u.id = c.author_id
                                WHERE c.post_id = ? AND c.deleted_at IS NULL
                                ORDER BY c.id ASC LIMIT 200`).all(id);
  // 匿名性維持(2026-05-27): 返信も🎭ニックネームで統一。実名(display_name)は出さない。
  // 本人以外にはアバター/author_id も隠す (実名・顔写真との紐付け防止)。投稿本体と同方針。
  const comments = rows.map(r => {
    const isSelf = r.author_id === me;
    return {
      id: r.id,
      author_id: isSelf ? r.author_id : null,
      content: r.content,
      created_at: r.created_at,
      author_name: r.author_nickname ? '🎭 ' + r.author_nickname : '🎭 匿名',
      author_avatar: isSelf ? r.author_avatar : null,
      is_mine: isSelf,
    };
  });
  res.json({ success: true, comments });
});

router.post('/posts/:id/comments', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const content = String((req.body && req.body.content) || '').slice(0, MAX_CONTENT).trim();
  if (!content) return res.status(400).json({ success: false, msg: '本文必須' });
  const db = getDb();
  const post = db.prepare('SELECT id, author_id, category FROM plaza_posts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!post) return res.status(404).json({ success: false, msg: '見つかりません' });
  // 食事投稿はコメント禁止 (👍リアクションのみ、マウント/食事ハラスメント防止)
  if (post.category === '食事') {
    return res.status(403).json({ success: false, msg: '食事投稿にはコメントできません (👍のみ)' });
  }
  const ins = db.prepare('INSERT INTO plaza_comments (post_id, author_id, content) VALUES (?, ?, ?)').run(id, req.uid, content);
  const raw = db.prepare(`SELECT c.id, c.author_id, c.content, c.created_at,
                                 u.nickname AS author_nickname, u.avatar_url AS author_avatar
                          FROM plaza_comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = ?`).get(ins.lastInsertRowid);
  // 匿名性維持(2026-05-27): 返信は🎭ニックネームで統一。実名は出さない。
  const anonName = raw.author_nickname ? '🎭 ' + raw.author_nickname : '🎭 匿名';
  // 本人向けレスポンス: 自分のコメントなのでアバター/idは残す
  const mine = { id: raw.id, author_id: raw.author_id, content: raw.content, created_at: raw.created_at,
                 author_name: anonName, author_avatar: raw.author_avatar, is_mine: true };
  // 全員ブロードキャスト用: 実名・顔写真・author_id を伏せた匿名版
  const pub = { id: raw.id, author_id: null, content: raw.content, created_at: raw.created_at,
                author_name: anonName, author_avatar: null, is_mine: false };
  if (post.author_id !== req.uid) {
    const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (sendPush) sendPush(post.author_id, {
      title: '💬 ひろば',
      body: anonName + ': ' + content.slice(0, 80),
      tag: 'plaza-cmt-' + id,
      url: '/plaza.html#post-' + id,
    }).catch(() => {});
  }
  const io = req.app && req.app.locals && req.app.locals.io;
  if (io) io.emit('plaza:comment', { post_id: id, comment: pub });
  res.json({ success: true, comment: mine });
});

// 未読件数 (新着バッジ用、軽量)
// last_plaza_seen_at より新しい他人の投稿数。未設定時はゼロ扱い (初訪問でバッジ氾濫を避ける)
// アーカイブ (cw_posts) は対象外 — 「新着」のみカウント
// 追加飲酒記録 (写真に写っていない後続のドリンクを自己申告)
// body: { delta_g: number } で加算、または { absolute_g: number } で絶対値設定、{ reset: true } でゼロリセット
// プリセット指定: { preset: 'beer_can_350' | 'beer_mug_500' | ... } で対応する g を加算
router.post('/posts/:id/alcohol', authUser, express.json({ limit: '4kb' }), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, msg: 'id不正' });
  const db = getDb();
  const row = db.prepare('SELECT author_id, category, COALESCE(extra_alcohol_g, 0) AS extra, nutrition_scores FROM plaza_posts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (row.author_id !== req.uid) return res.status(403).json({ success: false, msg: '本人のみ編集可' });
  if (row.category !== '食事') return res.status(400).json({ success: false, msg: '食事投稿のみ' });

  const b = req.body || {};
  let newExtra = Number(row.extra) || 0;
  if (b.reset === true) {
    newExtra = 0;
  } else if (b.preset && ALCOHOL_PRESETS[b.preset]) {
    newExtra += ALCOHOL_PRESETS[b.preset].g;
  } else if (typeof b.delta_g === 'number' && isFinite(b.delta_g)) {
    newExtra += b.delta_g;
  } else if (typeof b.absolute_g === 'number' && isFinite(b.absolute_g)) {
    newExtra = b.absolute_g;
  } else {
    return res.status(400).json({ success: false, msg: 'delta_g/absolute_g/preset/reset のいずれかが必要' });
  }
  // 上限/下限ガード (純アルコール 0〜500g)
  if (newExtra < 0) newExtra = 0;
  if (newExtra > 500) newExtra = 500;
  newExtra = Math.round(newExtra * 10) / 10;

  db.prepare('UPDATE plaza_posts SET extra_alcohol_g = ? WHERE id = ?').run(newExtra, id);

  // 表示用合算値を計算して返却
  const merged = mergeExtraAlcohol(row.nutrition_scores, newExtra);
  let breakdown = null;
  try { breakdown = (JSON.parse(merged || '{}')).alcohol_breakdown || null; } catch (e) {}
  res.json({ success: true, extra_alcohol_g: newExtra, nutrition_scores: merged, breakdown });
});

// 飲酒プリセット一覧 (UI 用)
router.get('/alcohol-presets', authUser, (req, res) => {
  res.json({ success: true, presets: ALCOHOL_PRESETS });
});

router.get('/unread-count', authUser, (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT last_plaza_seen_at FROM users WHERE id = ?').get(req.uid) || {};
  if (!u.last_plaza_seen_at) {
    db.prepare("UPDATE users SET last_plaza_seen_at = datetime('now') WHERE id = ?").run(req.uid);
    return res.json({ success: true, count: 0 });
  }
  const row = db.prepare(`SELECT COUNT(*) AS n FROM plaza_posts
                          WHERE deleted_at IS NULL AND author_id != ? AND created_at > ?`)
                .get(req.uid, u.last_plaza_seen_at);
  res.json({ success: true, count: Math.min(row.n || 0, 99) });
});

// 既読化 (plaza.html を開いたタイミングで叩く)
router.post('/mark-seen', authUser, (req, res) => {
  getDb().prepare("UPDATE users SET last_plaza_seen_at = datetime('now') WHERE id = ?").run(req.uid);
  res.json({ success: true });
});

module.exports = router;
