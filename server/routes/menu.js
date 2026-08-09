// ヘルスと一緒にメニューを考える — 会話形式の献立提案 (2026-07-24)
// 過去の食事傾向・不足栄養素・入手元(コンビニ/自炊/惣菜/外食)を踏まえ、AIヘルスアドバイザーが
// 会話で献立を一緒に決める。数値はカロリー表(food_items.json)に揃える。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateText, computeNutritionTargets, ageFromBirth } = require('../services/ai');

// カロリー表の品目 (数値の拠り所)。読み込み失敗は空。
let FOOD_ITEMS = [];
try { FOOD_ITEMS = require('../data/food_items.json'); } catch (e) { FOOD_ITEMS = []; }
function refBlock() {
  if (!FOOD_ITEMS.length) return '';
  const by = {};
  for (const it of FOOD_ITEMS) { (by[it[3]] = by[it[3]] || []).push(it[1] + '≈' + it[2] + 'kcal'); }
  return Object.keys(by).map(c => `【${c}】` + by[c].join('、')).join('\n');
}

const SRC_LABEL = { conbini: 'コンビニ', homemade: '自炊', eatout: '外食', deli: '惣菜（買って詰める）', cafeteria: '社員食堂', bento: 'お弁当（持参）', other: 'その他' };
const MEAL_LABEL = { breakfast: '朝食', lunch: '昼食', dinner: '夕食', snack: 'おやつ', midnight: '夜食', other: 'その他' };

// 直近14日の本人の食事(栄養スコア)を集計 → 平均/不足傾向
function trend(uid) {
  const db = getDb();
  let rows = [];
  try {
    rows = db.prepare(`SELECT nutrition_scores AS ns, food_source AS src, COALESCE(extra_alcohol_g,0) AS ea
      FROM plaza_posts WHERE author_id=? AND category='食事' AND nutrition_scores IS NOT NULL AND deleted_at IS NULL
      AND created_at >= datetime('now','-14 days') ORDER BY created_at DESC LIMIT 20`).all(uid);
  } catch (e) {}
  const val = (s, k) => { const x = s && s[k]; return (x && typeof x === 'object') ? Number(x.value) || 0 : (typeof x === 'number' ? x : 0); };
  const agg = { kcal: 0, protein: 0, veg: 0, salt: 0, fiber: 0, alc: 0, n: 0 };
  const srcCount = {};
  for (const r of rows) {
    let s; try { s = JSON.parse(r.ns); } catch { continue; }
    agg.kcal += val(s, 'calories'); agg.protein += val(s, 'protein'); agg.veg += val(s, 'vitamin');
    agg.salt += val(s, 'salt'); agg.fiber += val(s, 'fiber'); agg.alc += val(s, 'alcohol') + (Number(r.ea) || 0);
    agg.n++;
    if (r.src) srcCount[r.src] = (srcCount[r.src] || 0) + 1;
  }
  return { agg, srcCount, count: rows.length };
}

function trendSummary(uid) {
  const db = getDb();
  const u = db.prepare('SELECT sex, height_cm, activity_pal, birth_date, nickname FROM users WHERE id=?').get(uid) || {};
  const w = db.prepare('SELECT weight_kg FROM user_activity_prefs WHERE user_id=?').get(uid) || {};
  const T = computeNutritionTargets({ sex: u.sex, height_cm: u.height_cm, weight_kg: w.weight_kg, age: ageFromBirth(u.birth_date), pal: u.activity_pal });
  const { agg, srcCount, count } = trend(uid);
  const lines = [];
  const focus = [];
  if (agg.n >= 2) {
    const avg = (x) => Math.round(x / agg.n);
    const a = { kcal: avg(agg.kcal), protein: avg(agg.protein), veg: avg(agg.veg), salt: Math.round(agg.salt / agg.n * 10) / 10, fiber: avg(agg.fiber) };
    lines.push(`直近${agg.n}食の平均/食: 約${a.kcal}kcal・たんぱく質${a.protein}g・野菜${a.veg}g・塩分${a.salt}g・食物繊維${a.fiber}g`);
    if (a.protein < T.protein.min * 0.8) focus.push('たんぱく質が不足ぎみ');
    if (a.veg < T.veg.min * 0.8) focus.push('野菜が不足ぎみ');
    if (a.fiber < T.fiber.min * 0.8) focus.push('食物繊維が不足ぎみ');
    if (a.salt > T.salt.max * 1.1) focus.push('塩分が多め');
    if (a.kcal > T.kcal.max * 1.15) focus.push('カロリーが多め');
    else if (a.kcal < T.kcal.min * 0.8) focus.push('カロリーが少なめ');
    if (agg.alc / agg.n >= 15) focus.push('お酒が多めの日が続いている');
  } else {
    lines.push('食事投稿の記録はまだ少なめ（傾向は控えめに扱う）');
  }
  const srcTop = Object.keys(srcCount).sort((x, y) => srcCount[y] - srcCount[x])[0];
  if (srcTop) lines.push(`最近の入手元で多いのは「${SRC_LABEL[srcTop] || srcTop}」`);
  return {
    nickname: (u.nickname && u.nickname.trim()) || '',
    targetLine: T.personalized ? `1食の目安: 約${T.kcal.min}〜${T.kcal.max}kcal / たんぱく質${T.protein.min}g以上 / 野菜${T.veg.min}g以上 / 塩分${T.salt.max}g未満` : '1食の目安: 一般的な範囲で',
    trendLines: lines.join('\n'),
    focus,
    basis: T.basis || '',
    hasTrend: agg.n >= 2,
  };
}

function parseJSON(txt) {
  if (!txt) return null;
  let t = String(txt).trim().replace(/^```json\s*|^```\s*|\s*```$/g, '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch { return null; }
}

// 避けたい食材の検出 (2026-08-02)
// ⚠️「必ず献立を出す」を優先すると、AIがアレルゲンを含む品を出してしまうことがあった
//    (実測: 小麦・乳を避ける指定でパスタ＋チーズを提案)。安全側に倒して機械的に弾く。
const ALLERGEN_WORDS = {
  '卵': ['卵', 'たまご', '玉子', 'タマゴ', 'オムレツ', 'オムライス', 'たまご焼', '玉子焼', 'マヨネーズ', 'プリン', '茶碗蒸'],
  '乳': ['乳', 'ミルク', 'チーズ', '牛乳', 'バター', 'クリーム', 'ヨーグルト', 'グラタン', 'ドリア', 'ラテ', 'アイス'],
  '小麦': ['パン', 'パスタ', 'スパゲ', 'うどん', 'ラーメン', '麺', 'ピザ', '餃子', 'フライ', '天ぷら', 'から揚', '唐揚', 'ケーキ', 'ハンバーグ', 'グラタン', 'ドリア', 'お好み焼', 'たこ焼'],
  'そば': ['そば', '蕎麦', 'ソバ'],
  '落花生': ['ピーナ', '落花生', 'ナッツ'],
  'えび': ['えび', 'エビ', '海老'],
  'かに': ['かに', 'カニ', '蟹'],
  '大豆': ['大豆', '豆腐', '納豆', '味噌', 'みそ', '豆乳', '枝豆', '油揚', '厚揚', 'がんも', 'きなこ', '醤油'],
  '魚': ['魚', '鮭', 'サーモン', 'さば', 'サバ', '鯖', 'まぐろ', 'マグロ', 'ツナ', 'しらす', 'たら', 'タラ', 'ぶり', 'ブリ', 'あじ', 'アジ', 'いわし', '鰻', 'うなぎ', 'かつお', '鰹'],
  '生もの': ['刺身', 'さしみ', '寿司', 'すし', '生ハム', 'ユッケ', 'カルパッチョ', 'タルタル', '生卵', '半熟'],
  '辛い': ['辛', 'キムチ', '麻婆', 'カレー', 'チゲ', 'ペペロン', 'タバスコ'],
  '脂っこい': ['揚げ', 'フライ', 'から揚', '唐揚', '天ぷら', 'カツ', 'とんかつ', 'テリヤキ', '豚バラ', 'ラーメン', 'グラタン'],
};
// 献立の品名に、避けたい食材のキーワードが含まれていないか調べる
function findAllergenHits(menu, allergies) {
  if (!menu || !Array.isArray(menu.items) || !allergies || !allergies.length) return [];
  const hits = [];
  const names = menu.items.map(x => String((x && x.name) || '')).concat([String(menu.title || '')]);
  for (const a of allergies) {
    const words = ALLERGEN_WORDS[a];
    if (!words) continue;                      // 「その他」など自由記述は機械判定しない
    for (const n of names) {
      for (const w of words) {
        if (n.indexOf(w) !== -1) { hits.push({ allergy: a, word: w, name: n }); break; }
      }
      if (hits.length && hits[hits.length - 1].allergy === a) break;
    }
  }
  return hits;
}

router.post('/chat', authUser, express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const meal = MEAL_LABEL[String(body.meal || '')] ? String(body.meal) : '';
    const source = SRC_LABEL[String(body.source || '')] ? String(body.source) : '';
    const rawHist = Array.isArray(body.history) ? body.history.slice(-12) : [];
    const history = rawHist
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
      .map(m => ({ role: m.role, text: m.text.slice(0, 600) }));

    const ctx = trendSummary(req.uid);
    const nickPart = ctx.nickname ? `相手の呼び名: ${ctx.nickname}さん（最初の一言でだけ軽く呼びかけてよい。毎回は不要）\n` : '';
    const pick = [];
    if (meal) pick.push('今回の食事: ' + MEAL_LABEL[meal]);
    if (source) pick.push('今日の入手元: ' + SRC_LABEL[source]);
    const prefs = Array.isArray(body.prefs) ? body.prefs.filter(x => typeof x === 'string').map(x => x.replace(/[\r\n]/g, ' ').trim().slice(0, 24)).filter(Boolean).slice(0, 12) : [];
    if (prefs.length) pick.push('希望・気分: ' + prefs.join('、'));
    const shop = typeof body.shop === 'string' ? body.shop.replace(/[\r\n]/g, ' ').trim().slice(0, 24) : '';
    if (shop) pick.push('お店: ' + shop + '（このお店で選べるメニューに絞って提案する）');
    const allergies = Array.isArray(body.allergies) ? body.allergies.filter(x => typeof x === 'string').map(x => x.replace(/[\r\n]/g, ' ').trim().slice(0, 24)).filter(Boolean).slice(0, 12) : [];
    if (allergies.length) pick.push('⚠️避ける（アレルギー・苦手）: ' + allergies.join('、') + ' ← これらは絶対に献立に含めない');

    const sys =
      'あなたは運送会社の健康アプリCoWellの「ヘルスアドバイザー なぎさ（ヘルス）」。ドライバーと会話しながら“今日の一食の献立”を一緒に決めます。\n' +
      '話し方: やさしい敬語・親しみやすく短め（2〜4文）。専門用語は噛み砕く。説教・否定はしない。相手の生活（お仕事・不規則になりがちな食事）に寄り添う。絵文字は控えめ（0〜1個）。\n' +
      '進め方: ①相手の状況（入手元・気分・時間）を1つずつ確認しながら、②具体的な献立を“実名の品”で提案する（例: サラダチキン＋鮭おにぎり＋味噌汁）。③相手の反応で微調整する。会話が固まってきたら「これにしますか？」と確認する。\n' +
      '入手元での出し分け: コンビニ=棚にある実名の商品と選び方／自炊=すぐ作れる簡単レシピと味付け／惣菜=スーパーで選ぶ総菜の組み合わせ／外食=定食や単品の選び方。\n' +
      '不足栄養素があれば、その一食で自然に補える形にする（例: たんぱく質不足→鶏肉・卵・魚・豆を1品）。数値(kcal)は“およそ”で良く、下の目安表の値に大きく矛盾しないように。\n' +
      '避ける指定: 「避ける（アレルギー・苦手）」に挙がった食材・アレルゲンは、提案する品や材料に絶対に含めない。外食・コンビニ・惣菜を勧める時は「念のため、原材料表示もご確認くださいね」と一言添える。お店が指定された時は、そのお店で実際に頼めるメニュー名で提案する。\n' +
      '安全: 持病・薬・アレルギー・妊娠等が疑われる話は「かかりつけ医・産業医・栄養士へ」と一言添える。医療診断はしない。\n\n' +
      '── この人のデータ（本人には数字を並べ立てず、会話に自然に溶かす）──\n' +
      nickPart +
      (pick.length ? pick.join(' / ') + '\n' : '') +
      ctx.targetLine + '\n' +
      ctx.trendLines + '\n' +
      (ctx.focus.length ? '気にかけたい点: ' + ctx.focus.join('、') + '\n' : '') +
      '\n── カロリーの目安（数値の拠り所）──\n' + refBlock() + '\n\n' +
      '── 出力形式（必ずJSONのみ・前後に文章を付けない）──\n' +
      '{\n' +
      '  "reply": "ヘルスの発話（2〜4文）",\n' +
      '  "chips": ["相手が次にタップしやすい短い返事や指定を2〜4個（例: もっと簡単に / 野菜を増やす / コンビニで / これにする）"],\n' +
      '  "menu": null または { "trend": "あなたの食事傾向から見た寄り添いの一言（下の傾向データに基づき、例:『最近は野菜が少なめでしたので、今回はしっかり補えるようにしました』。数字の羅列はせず要点だけ。データが少なければ一般的で優しい一言）", "title": "献立名", "items": [{"name":"品名","kcal":数値}], "total_kcal": 数値, "why": "この献立にした理由を一言（不足の補い方に触れる）" }\n' +
      '}\n' +
      'menuは現時点のいちばん有力な提案を入れる（会話途中でも部分提案でよい）。まだ何も決まっていない最初だけnull可。\nmenuを出す時、上の傾向データに実際の食事記録がある場合のみ trend に「あなたの食事傾向から〜」の寄り添い一言を入れる（判断の根拠として先に示す）。記録が「まだ少なめ」の人は trend を必ず空文字にし、食事傾向には一切触れない（無い傾向を語らない）。';

    let convo;
    if (!history.length) {
      convo = '（会話開始。まず相手に寄り添う一言＋「今日は何を食べる予定？どこで買う（作る）か」を、上のpick済み情報があればそれを踏まえて聞く。pickで入手食事が既に決まっていれば、いきなり具体的な候補を1つ出して反応を伺ってよい。）';
    } else {
      convo = history.map(m => (m.role === 'user' ? 'ドライバー' : 'ヘルス') + ': ' + m.text).join('\n') + '\nヘルス:';
    }

    // force_menu: 「この内容で考えてもらう」ボタン経由。希望が多い/矛盾していても必ず1案出す。
    //  ⚠️チェックを多く付けると確認質問だけ返って献立が出ないことがあったため (2026-08-02 社長指摘)
    // 「これにする」等で決まったら、同じ献立を出し直さず締める (2026-08-02)
    // ⚠️確定後もforce_menuが効いていると、同じ回答を延々と繰り返す。
    const CONFIRM_RE = /(これにする|それにする|これでいく|それでいく|これで(お願い|いく|決|いい)|決まり|決定|これがいい|それがいい|いいね、?これ|オッケー|ＯＫ|^ok$|^はい$)/i;
    const lastUser = history.filter(m => m.role === 'user').slice(-1)[0];
    const confirming = !!(lastUser && CONFIRM_RE.test(String(lastUser.text || '').trim()));
    // 「別の案も見たい」= 出し直しの要求。質問で返さず、直前と違う組み合わせを必ず出す。
    const ALT_RE = /(別の案|他の案|ほかの案|別のを|他のを|違うの|別案|もう一つ|もう1つ|他には|ほかには)/;
    const wantAlt = !!(lastUser && ALT_RE.test(String(lastUser.text || '').trim())) && !confirming;
    const forceMenu = (!!(body.force_menu) || wantAlt) && !confirming;
    const forceLine = forceMenu
      ? '\n\n【重要】今回は利用者が「この内容で考えてもらう」を押しました。質問だけで終わらせず、**必ず menu を出す**（nullにしない）。希望が多い・互いに矛盾する場合は、優先順位をあなたが決めて（安全・アレルギー除外＞不足栄養＞体調のラクさ＞好み）、いちばん現実的な1案にまとめる。迷いは reply で一言添えるだけにして、提案は必ず添える。'
      : '';
    const altLine = wantAlt
      ? '\n\n【重要】利用者は「別の案」を求めています。質問を返さず、**直前に出した献立とは違う組み合わせ**の献立を必ず1案出す（主菜や主食を変える）。前と同じ品名を並べ直さない。'
      : '';
    // 確定の合図: もう提案し直さず、短く締める
    const closeLine = confirming
      ? '\n\n【重要】利用者は直前の献立で決めました。**同じ献立をもう一度提案し直さない**（menu は必ず null にする）。'
        + 'reply は「決まりましたね」の確認＋その献立で気をつける点や食べ方のコツを一言＋「いってらっしゃい」等のねぎらい、の2〜3文で締める。'
        + 'chips は ["別の案も見たい", "終わる"] のような短い選択肢にする。'
      : '';
    let out = await generateText(sys + forceLine + altLine + closeLine + '\n\n── これまでの会話 ──\n' + convo, { thinkingBudget: 0 });
    let j = parseJSON(out);
    // 献立必須なのに出なかったら、1回だけ強く再要求する
    if (forceMenu && (!j || !j.menu)) {
      try {
        out = await generateText(sys + forceLine + altLine + closeLine + '\n\n── これまでの会話 ──\n' + convo
          + '\n\n（前回の応答には menu が入っていませんでした。今度は必ず menu を入れて、具体的な品名とkcalで1案を出してください。）', { thinkingBudget: 0 });
        const j2 = parseJSON(out);
        if (j2 && j2.menu) j = j2;
        else if (j2 && !j) j = j2;
      } catch (e) { console.warn('[menu] force retry fail:', e.message); }
    }
    if (!j || typeof j.reply !== 'string') {
      j = { reply: (out || 'すみません、もう一度お願いできますか？').toString().slice(0, 400), chips: [], menu: null };
    }
    // 正規化・サニタイズ
    const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
    const resp = {
      reply: clean(j.reply).slice(0, 500),
      chips: Array.isArray(j.chips) ? j.chips.filter(c => typeof c === 'string').map(c => clean(c).slice(0, 24)).slice(0, 4) : [],
      menu: null,
    };
    if (j.menu && typeof j.menu === 'object' && Array.isArray(j.menu.items)) {
      resp.menu = {
        trend: ctx.hasTrend ? clean(j.menu.trend).slice(0, 200) : '',
        title: clean(j.menu.title).slice(0, 40),
        items: j.menu.items.filter(x => x && x.name).map(x => ({ name: clean(x.name).slice(0, 40), kcal: Math.max(0, Math.min(3000, Math.round(Number(x.kcal) || 0))) })).slice(0, 8),
        total_kcal: Math.max(0, Math.min(5000, Math.round(Number(j.menu.total_kcal) || 0))),
        why: clean(j.menu.why).slice(0, 160),
      };
      if (!resp.menu.total_kcal && resp.menu.items.length) resp.menu.total_kcal = resp.menu.items.reduce((a, b) => a + b.kcal, 0);
    }
    // 確定後にAIがまた献立を返してきたら捨てる (同じ回答の繰り返しを機械的に止める)
    if (confirming && resp.menu) { console.log('[menu] confirmed -> drop repeated menu'); resp.menu = null; }
    // 避けたい食材が入っていないか点検 → 入っていたら1回だけ作り直させる
    let hits = findAllergenHits(resp.menu, allergies);
    if (hits.length) {
      console.warn('[menu] allergen hit:', hits.map(h => h.allergy + '/' + h.word + '@' + h.name).join(', '));
      try {
        const ng = hits.map(h => '「' + h.name + '」は' + h.allergy + 'を含みます').join('。');
        const out2 = await generateText(sys + forceLine + altLine + closeLine + '\n\n── これまでの会話 ──\n' + convo
          + '\n\n（前回の提案は避ける指定に違反していました: ' + ng + '。これらの食材・料理は絶対に使わず、別の献立を出し直してください。'
          + '該当する材料を一切含まない品だけで組み立ててください。）', { thinkingBudget: 0 });
        const j3 = parseJSON(out2);
        if (j3 && j3.menu && Array.isArray(j3.menu.items)) {
          const cand = {
            trend: ctx.hasTrend ? clean(j3.menu.trend).slice(0, 200) : '',
            title: clean(j3.menu.title).slice(0, 40),
            items: j3.menu.items.filter(x => x && x.name).map(x => ({ name: clean(x.name).slice(0, 40), kcal: Math.max(0, Math.min(3000, Math.round(Number(x.kcal) || 0))) })).slice(0, 8),
            total_kcal: Math.max(0, Math.min(5000, Math.round(Number(j3.menu.total_kcal) || 0))),
            why: clean(j3.menu.why).slice(0, 160),
          };
          if (!cand.total_kcal && cand.items.length) cand.total_kcal = cand.items.reduce((a, b) => a + b.kcal, 0);
          if (!findAllergenHits(cand, allergies).length) {
            resp.menu = cand;
            if (typeof j3.reply === 'string' && j3.reply.trim()) resp.reply = clean(j3.reply).slice(0, 500);
            hits = [];
          }
        }
      } catch (e) { console.warn('[menu] allergen retry fail:', e.message); }
      if (hits.length) {
        // 直らなければ献立は出さない (避ける指定の方を優先する)
        resp.menu = null;
        resp.reply = '申し訳ありません。避けたい食材が多く、条件を全部満たす組み合わせがうまく作れませんでした。'
          + '避けたいものを少し減らすか、お店や入手元を変えていただけると、安全にご提案できます。';
        resp.chips = ['避けたいものを見直す', 'お店を変える', 'おまかせで考えて'];
      }
    }
    res.json(resp);
  } catch (e) {
    console.warn('[menu/chat]', e && e.message);
    res.status(503).json({ reply: '', chips: [], menu: null, retryable: true, error: e.message });
  }
});

module.exports = router;
