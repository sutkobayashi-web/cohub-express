const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { analyzeFoodImage, generateText, computeNutritionTargets, ageFromBirth, regenFoodComment } = require('../services/ai');

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
      '→ 「悩み相談」を開いて、あなたの言葉で返信してください: https://cohub.biz-terrace.org/plaza.html?tab=相談',
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
  shochu_1go:    { label: '焼酎 1合',            g: 36 },
  chuhai_can:    { label: '缶チューハイ 350',     g: 14 },
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
                    p.ai_comment, p.is_anonymous, p.created_at, p.meal_type,
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
  // 管理職(employee_type=admin)はモデレーションのため全投稿を削除可
  const _viewer = db.prepare('SELECT employee_type FROM users WHERE id = ?').get(me);
  const meIsManager = !!(_viewer && _viewer.employee_type === 'admin');
  let reactions = [];
  let cmtMap = {};
  let cmtListMap = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    reactions = db.prepare(`SELECT post_id, emoji, user_id FROM plaza_reactions WHERE post_id IN (${ph})`).all(...ids);
    const cnts = db.prepare(`SELECT post_id, COUNT(*) AS c FROM plaza_comments WHERE post_id IN (${ph}) AND deleted_at IS NULL GROUP BY post_id`).all(...ids);
    cmtMap = Object.fromEntries(cnts.map(x => [x.post_id, x.c]));
    const crows = db.prepare(`SELECT c.id, c.post_id, c.author_id, c.content, c.created_at, u.nickname AS author_nickname
                              FROM plaza_comments c LEFT JOIN users u ON u.id = c.author_id
                              WHERE c.post_id IN (${ph}) AND c.deleted_at IS NULL ORDER BY c.id ASC`).all(...ids);
    for (const r of crows) {
      const isSelf = r.author_id === me;
      (cmtListMap[r.post_id] = cmtListMap[r.post_id] || []).push({
        id: r.id, author_id: isSelf ? r.author_id : null, content: r.content, created_at: r.created_at,
        author_name: r.author_nickname ? '🎭 ' + r.author_nickname : '🎭 匿名', author_avatar: null, is_mine: isSelf,
      });
    }
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
      comments: cmtListMap[p.id] || [],
      can_delete: isAuthor || meIsManager,
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
      enr.author_avatar = null; // ★本人にも実アバターを出さない (#4: 自分の顔が公開されている不安の払拭)。本人判別は is_mine で
      if (!isAuthor) {
        enr.author_id = null;
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
  // 食事区分 (朝食/昼食/夕食/おやつ)。おやつはAI評価で「一食」でなく「間食」として扱う。
  const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
  const mealType = MEAL_TYPES.includes(String((req.body && req.body.meal_type) || '').trim())
    ? String(req.body.meal_type).trim() : null;

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
      // 個別の栄養目標 (性別/年齢/身長/体重 → 推定必要量)。未入力なら一律目標にフォールバック。
      const _db = getDb();
      const _bu = _db.prepare('SELECT sex, height_cm, activity_pal, birth_date FROM users WHERE id = ?').get(req.uid) || {};
      const _bw = _db.prepare('SELECT weight_kg FROM user_activity_prefs WHERE user_id = ?').get(req.uid) || {};
      const foodTargets = computeNutritionTargets({ sex: _bu.sex, height_cm: _bu.height_cm, weight_kg: _bw.weight_kg, age: ageFromBirth(_bu.birth_date), pal: _bu.activity_pal });
      console.log('[plaza] targets personalized=' + foodTargets.personalized);
      const r = await analyzeFoodImage(buf, req.file.mimetype, content, recentMeals, foodTargets, mealType);
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
  const ins = db.prepare(`INSERT INTO plaza_posts (author_id, category, content, image_url, nutrition_scores, ai_comment, is_anonymous, meal_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.uid, category, content, imageUrl, nutritionScores, aiComment, isAnonymous, mealType);
  const post = db.prepare(`SELECT p.*, u.display_name AS author_name, u.avatar_url AS author_avatar, u.company_code AS author_company, u.nickname AS author_nickname
                           FROM plaza_posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.id = ?`).get(ins.lastInsertRowid);
  post.kind = 'plaza';
  post.reactions = Object.fromEntries(ALLOWED_EMOJIS.map(e => [e, 0]));
  post.my_reactions = Object.fromEntries(ALLOWED_EMOJIS.map(e => [e, false]));
  post.comment_count = 0;
  post.can_delete = true;
  post.is_mine = true;
  post.extra_alcohol_g = 0;
  // ★匿名カテゴリは本人にも🎭・アバターNULLで返す (#4: 自分の顔が公開されている不安の払拭)。本人判別は is_mine
  if (isAnonymous) {
    post.author_avatar = null;
    post.author_name = post.author_nickname ? '🎭 ' + post.author_nickname : '🎭 匿名';
  }

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

// 削除 (本人 or 管理職)
router.delete('/posts/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const p = db.prepare('SELECT author_id FROM plaza_posts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!p) return res.status(404).json({ success: false, msg: '見つかりません' });
  const viewer = db.prepare('SELECT employee_type FROM users WHERE id = ?').get(req.uid);
  const isManager = !!(viewer && viewer.employee_type === 'admin');
  if (p.author_id !== req.uid && !isManager) return res.status(403).json({ success: false, msg: '削除権限がありません（本人または管理職のみ）' });
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
      author_avatar: null, // ★本人にも実アバターを出さない (#4)。本人判別は is_mine
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
  // 食事投稿も 2026-07-17 よりコメント(レス)可 (社長指示: 交流/エンゲージメント優先。旧=👍のみマウント防止)。
  const ins = db.prepare('INSERT INTO plaza_comments (post_id, author_id, content) VALUES (?, ?, ?)').run(id, req.uid, content);
  const raw = db.prepare(`SELECT c.id, c.author_id, c.content, c.created_at,
                                 u.nickname AS author_nickname, u.avatar_url AS author_avatar
                          FROM plaza_comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = ?`).get(ins.lastInsertRowid);
  // 匿名性維持(2026-05-27): 返信は🎭ニックネームで統一。実名は出さない。
  const anonName = raw.author_nickname ? '🎭 ' + raw.author_nickname : '🎭 匿名';
  // 本人向けレスポンス: 自分のコメントなのでアバター/idは残す
  const mine = { id: raw.id, author_id: raw.author_id, content: raw.content, created_at: raw.created_at,
                 author_name: anonName, author_avatar: null, is_mine: true };
  // 全員ブロードキャスト用: 実名・顔写真・author_id を伏せた匿名版
  const pub = { id: raw.id, author_id: null, content: raw.content, created_at: raw.created_at,
                author_name: anonName, author_avatar: null, is_mine: false };
  if (post.author_id !== req.uid) {
    // 2026-07-20: レスの内容を DM でも本人に届ける (Push見逃し対策・社長要望)。
    // 送信者 = 'notice_plaza' (おしらせ専用アカウント)。role='bot' なので社員一覧/点呼名簿には出ないが、
    // id が 'bot_' で始まらないので DM一覧・未読バッジには出る (bot_%名義DMは意図的に非表示=届かない)。
    // 匿名性維持: 差出人はコメント者本人ではなく、本文に🎭ニックネームのみ。
    // 表示名はホームのカード名に合わせる (「ひろば」は開発上の呼び名でユーザーには通じない)
    const CAT_LABEL = { '食事': '🍱 食事投稿', '相談': '🆘 悩み相談', '雑談': '💭 雑談', '健康Tips': '💡 健康Tips' };
    const label = CAT_LABEL[post.category] || '📝 みんなの投稿';
    const postUrl = '/plaza.html?tab=' + encodeURIComponent(post.category || '食事') + '#post-' + id;
    try {
      const dmBody = ['💬 あなたの「' + label + '」にコメントが届きました', '',
        anonName, '「' + content.slice(0, 200) + '」', '',
        '→ 投稿を開いて返信する: https://cohub.biz-terrace.org' + postUrl,
        '(このおしらせに返信しても相手には届きません)'].join('\n');
      const dmIns = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES ('notice_plaza', ?, ?, 'dm')")
        .run(post.author_id, dmBody);
      const emitToUser = req.app && req.app.locals && req.app.locals.emitToUser;
      if (emitToUser) emitToUser(post.author_id, 'dm:msg', {
        id: dmIns.lastInsertRowid, from: 'notice_plaza', to: post.author_id,
        content: dmBody, at: new Date().toISOString(), attach: null,
      });
    } catch (e) { console.warn('[plaza comment dm] fail:', e.message); }
    const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (sendPush) sendPush(post.author_id, {
      title: '💬 ' + label + 'にコメント',
      body: anonName + ': ' + content.slice(0, 80),
      tag: 'plaza-cmt-' + id,
      url: postUrl,
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
  // clear_ai: AIの誤検出時。保存済み nutrition_scores のアルコールを0/has_alcohol=falseに書き換え、追加分も0に
  if (b.clear_ai === true) {
    let nsJson = row.nutrition_scores;
    try {
      const ns = typeof nsJson === 'string' ? JSON.parse(nsJson) : { ...(nsJson || {}) };
      ns.alcohol = { value: 0, unit: 'g' };
      ns.has_alcohol = false;
      delete ns.alcohol_breakdown;
      nsJson = JSON.stringify(ns);
    } catch (e) {}
    db.prepare('UPDATE plaza_posts SET extra_alcohol_g = 0, nutrition_scores = ? WHERE id = ?').run(nsJson, id);
    return res.json({ success: true, extra_alcohol_g: 0, nutrition_scores: nsJson, breakdown: null });
  }
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

// ── 食事傾向のひとこと (解説の特別感用: 飲酒/禁酒・おかず傾向を本人の履歴から) ──
// AIヘルスアドバイザーの音声解説の冒頭に「ふだんの傾向」を1文添え、"あなたを分かっている"感を出す。
const _tendencyCache = new Map(); // key: author_id|YYYY-MM-DD -> tendency文字列 (日次キャッシュ)
function _stripEmoji(s) {
  return String(s || '').replace(/[←-⇿⌀-➿⬀-⯿️\u{1F000}-\u{1FAFF}]/gu, '').replace(/\s+/g, ' ').trim();
}
// nutrition_scores は新形式(ネスト {value,unit}) と旧形式(フラット数値) が混在 → 両対応で数値取得
function _nutVal(x) {
  if (x == null) return null;
  if (typeof x === 'object') { const v = Number(x.value); return isNaN(v) ? null : v; }
  const n = Number(x); return isNaN(n) ? null : n;
}
router.get('/posts/:id/tendency', authUser, async (req, res) => {
  try {
    const db = getDb();
    const post = db.prepare("SELECT author_id, category FROM plaza_posts WHERE id = ? AND deleted_at IS NULL").get(req.params.id);
    if (!post || post.category !== '食事') return res.json({ success: true, tendency: '' });
    const author = post.author_id;
    const dayKey = new Date().toISOString().slice(0, 10);
    const cacheKey = author + '|' + dayKey;
    if (_tendencyCache.has(cacheKey)) return res.json({ success: true, tendency: _tendencyCache.get(cacheKey) });

    // 本人の食事投稿(直近90日・最大40件)を集計
    const rows = db.prepare(`SELECT content, nutrition_scores, extra_alcohol_g, created_at
      FROM plaza_posts WHERE author_id = ? AND category = '食事' AND deleted_at IS NULL
      AND created_at >= datetime('now','-90 days')
      ORDER BY created_at DESC LIMIT 40`).all(author);
    if (rows.length < 3) { _tendencyCache.set(cacheKey, ''); return res.json({ success: true, tendency: '' }); }

    let n = 0, drink = 0, vegSum = 0, vegN = 0, protSum = 0, protN = 0, saltSum = 0, saltN = 0, fibSum = 0, fibN = 0;
    const recentDrink = []; // 新しい順
    const contents = [];
    for (const r of rows) {
      n++;
      let ns = {};
      try { ns = r.nutrition_scores ? JSON.parse(r.nutrition_scores) : {}; } catch (e) {}
      const alcV = _nutVal(ns.alcohol);
      const hasAlc = !!(ns.has_alcohol === true || (alcV && alcV > 0) || (Number(r.extra_alcohol_g) > 0));
      if (hasAlc) drink++;
      recentDrink.push(hasAlc);
      const veg = _nutVal(ns.vitamin); if (veg != null) { vegSum += veg; vegN++; }
      const prot = _nutVal(ns.protein); if (prot != null) { protSum += prot; protN++; }
      const salt = _nutVal(ns.salt); if (salt != null) { saltSum += salt; saltN++; }
      const fib = _nutVal(ns.fiber); if (fib != null) { fibSum += fib; fibN++; }
      if (r.content) contents.push(String(r.content).replace(/\s+/g, ' ').slice(0, 40));
    }
    const drinkRate = Math.round((drink / n) * 100);
    const recentNoAlc = drink > 0 && recentDrink.slice(0, 5).every(f => !f); // 以前は飲むが最近は禁酒
    const vegAvg = vegN ? Math.round(vegSum / vegN) : null;
    const protAvg = protN ? Math.round(protSum / protN) : null;
    const saltAvg = saltN ? Math.round((saltSum / saltN) * 10) / 10 : null;
    const fibAvg = fibN ? Math.round((fibSum / fibN) * 10) / 10 : null;

    let tendency = '';
    try {
      const prompt = `あなたは健康管理室のアドバイザー。ある社員の食事記録${n}件の傾向データから、その人の「ふだんの食事傾向」を親しみを込めて日本語で1文だけ述べてください。飲酒/禁酒の傾向と、おかず(野菜・たんぱく)の傾向を自然に織り込む。断定や説教はせず、あたたかく。40文字以内。医療診断はしない。絵文字は使わない。
データ: 記録${n}件, 飲酒あり${drink}件(${drinkRate}%)${recentNoAlc ? ', 最近は飲酒なしが続く' : ''}, 野菜平均${vegAvg}g(目標120), たんぱく平均${protAvg}g(目標20), 塩分平均${saltAvg}g(目標2.5未満), 食物繊維平均${fibAvg}g(目標7)
最近の食事メモ: ${contents.slice(0, 6).join(' / ')}
出力は1文のみ。「ですね」等でやわらかく締める。`;
      const out = await generateText(prompt, { temperature: 0.6, maxTokens: 200, thinkingBudget: 0 });
      tendency = _stripEmoji(String(out || '').split(/\n/)[0]).replace(/^[「『]|[」』]$/g, '').slice(0, 70);
    } catch (e) {
      // ルールベース fallback
      const parts = [];
      if (recentNoAlc) parts.push('この頃はお酒を控えていらっしゃいます');
      else if (drinkRate >= 50) parts.push('晩酌を楽しまれる日が多め');
      else if (drinkRate <= 15) parts.push('お酒は控えめな傾向');
      if (vegAvg != null && vegAvg >= 110) parts.push('野菜のおかずをしっかり摂っています');
      else if (vegAvg != null && vegAvg < 80) parts.push('野菜のおかずがもう少しあるとよい傾向');
      else if (protAvg != null && protAvg >= 20) parts.push('たんぱくのおかずをよく摂っています');
      tendency = parts.length ? ('ふだんは' + parts.join('、') + 'ね。') : '';
    }
    _tendencyCache.set(cacheKey, tendency);
    if (_tendencyCache.size > 500) { const k = _tendencyCache.keys().next().value; _tendencyCache.delete(k); }
    res.json({ success: true, tendency });
  } catch (e) {
    console.warn('[tendency]', e && e.message);
    res.json({ success: true, tendency: '' });
  }
});

// 過去の食事投稿を「今の個別目標」で再診断 (本人のみ・画像は再解析せず保存済み栄養値を評価し直す)
router.post('/posts/:id/rediagnose', authUser, express.json(), async (req, res) => {
  try {
    const db = getDb();
    const post = db.prepare("SELECT id, author_id, category, content, nutrition_scores FROM plaza_posts WHERE id = ? AND deleted_at IS NULL").get(req.params.id);
    if (!post) return res.status(404).json({ success: false, msg: '投稿が見つかりません' });
    if (post.author_id !== req.uid) return res.status(403).json({ success: false, msg: '本人の投稿のみ再診断できます' });
    if (post.category !== '食事' || !post.nutrition_scores) return res.status(400).json({ success: false, msg: '栄養データのある食事投稿のみ対象です' });
    let scores; try { scores = JSON.parse(post.nutrition_scores); } catch (e) { return res.status(400).json({ success: false, msg: '栄養データを読めません' }); }
    // 本人の個別目標
    const bu = db.prepare('SELECT sex, height_cm, activity_pal, birth_date FROM users WHERE id = ?').get(req.uid) || {};
    const bw = db.prepare('SELECT weight_kg FROM user_activity_prefs WHERE user_id = ?').get(req.uid) || {};
    const targets = computeNutritionTargets({ sex: bu.sex, height_cm: bu.height_cm, weight_kg: bw.weight_kg, age: ageFromBirth(bu.birth_date), pal: bu.activity_pal });
    const recentMeals = collectRecentMeals(req.uid);
    const obj = await regenFoodComment(scores, targets, post.content, recentMeals);
    const newComment = formatAdvisorSections(obj);
    if (!newComment) return res.status(500).json({ success: false, msg: '再診断に失敗しました' });
    db.prepare('UPDATE plaza_posts SET ai_comment = ? WHERE id = ? AND author_id = ?').run(newComment, post.id, req.uid);
    res.json({ success: true, ai_comment: newComment, personalized: targets.personalized, basis: targets.basis });
  } catch (e) {
    console.warn('[rediagnose]', e && e.message);
    res.status(500).json({ success: false, msg: '再診断エラー' });
  }
});

module.exports = router;
