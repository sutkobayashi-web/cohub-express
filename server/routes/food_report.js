// マンスリー栄養レポート (2026-06-17)
// 食事投稿(plaza_posts category=食事)の nutrition_scores を1か月分集計し、Gemini で
// 「サマリー/栄養分析/傾向/来月の心がけ/将来の警鐘/応援」を生成。本人＋推進メンバーが閲覧。
// 毎月自動(前月分)＋手動生成。閾値=月10件以上。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateText, computeNutritionTargets, ageFromBirth, NUTRI_TOL } = require('../services/ai');

// 許容範囲 (2026-08-07)。目安を少し外れただけの食事は「不足/オーバー」に数えない。
// 数値そのものは services/ai.js の NUTRI_TOL が唯一の設定箇所。
const TOL_PCT = Math.round(NUTRI_TOL * 100);
const LOW = (min) => (min == null ? null : min * (1 - NUTRI_TOL));   // これを下回ったら「不足」
const HIGH = (max) => (max == null ? null : max * (1 + NUTRI_TOL));  // これを上回ったら「多い」

// 対象ユーザーの個別1食目標 (未入力なら一律目標)。集計/プロンプトで使用。
function getUserTargets(uid) {
  const db = getDb();
  const u = db.prepare('SELECT sex, height_cm, activity_pal, birth_date FROM users WHERE id = ?').get(uid) || {};
  const w = db.prepare('SELECT weight_kg FROM user_activity_prefs WHERE user_id = ?').get(uid) || {};
  return computeNutritionTargets({ sex: u.sex, height_cm: u.height_cm, weight_kg: w.weight_kg, age: ageFromBirth(u.birth_date), pal: u.activity_pal });
}

const MIN_MEALS = 10; // 「ある程度蓄積」の目安
// 1食あたりの目標値 (analyzeFoodImage と統一)
const TARGETS = {
  kcal: { min: 450, max: 650, label: 'カロリー', unit: 'kcal' },
  protein: { min: 20, label: 'たんぱく質', unit: 'g' },
  fat: { min: 12, max: 18, label: '脂質', unit: 'g' },
  carbs: { min: 69, max: 89, label: '炭水化物', unit: 'g' },
  veg: { min: 120, label: '野菜', unit: 'g' },
  ca: { min: 227, label: 'カルシウム', unit: 'mg' },
  salt: { max: 2.5, label: '食塩相当量', unit: 'g' },
  fiber: { min: 7, label: '食物繊維', unit: 'g' },
};

function isManagerUid(uid) {
  const u = getDb().prepare('SELECT employee_type, is_field_promoter FROM users WHERE id = ?').get(uid);
  return !!(u && u.employee_type === 'admin');
}
function isPromoterUid(uid) {
  const u = getDb().prepare('SELECT employee_type, is_field_promoter FROM users WHERE id = ?').get(uid);
  return !!(u && (u.is_field_promoter === 1 || u.employee_type === 'admin'));
}
// 本人 or 推進メンバー(管理職含む) なら対象ユーザーのレポートを閲覧/生成できる
function canAccess(viewerUid, targetUid) {
  return viewerUid === targetUid || isPromoterUid(viewerUid);
}

function ymOf(date) { return date.toISOString().slice(0, 7); }
function prevYm() {
  const d = new Date();
  d.setDate(1); d.setMonth(d.getMonth() - 1);
  return ymOf(d);
}
function ymRange(ym) {
  // ym='YYYY-MM' → [start, endExclusive] の 'YYYY-MM-DD' 文字列
  const [y, m] = ym.split('-').map(Number);
  const start = `${ym}-01`;
  const nm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [start, `${nm}-01`];
}
function ymLabel(ym) { const [y, m] = ym.split('-'); return `${y}年${Number(m)}月`; }

function numOf(x) { return (x && typeof x === 'object') ? Number(x.value) || 0 : (typeof x === 'number' ? x : 0); }

// 指定ユーザー・指定月の食事投稿を集計
function aggregateMonth(uid, ym) {
  const db = getDb();
  const [start, end] = ymRange(ym);
  const rows = db.prepare(
    `SELECT created_at, content, nutrition_scores, COALESCE(extra_alcohol_g,0) AS extra_alc
     FROM plaza_posts
     WHERE author_id=? AND category='食事' AND nutrition_scores IS NOT NULL AND deleted_at IS NULL
       AND created_at >= ? AND created_at < ?
     ORDER BY created_at ASC`
  ).all(uid, start, end);

  const meals = [];
  for (const r of rows) {
    let s; try { s = JSON.parse(r.nutrition_scores); } catch (e) { continue; }
    const alc = Math.round((numOf(s.alcohol) + Number(r.extra_alc || 0)) * 10) / 10;
    meals.push({
      date: (r.created_at || '').slice(0, 10),
      kcal: numOf(s.calories), protein: numOf(s.protein), fat: numOf(s.fat), carbs: numOf(s.carbs),
      veg: numOf(s.vitamin), ca: numOf(s.mineral), salt: numOf(s.salt), fiber: numOf(s.fiber), alc,
      note: String(r.content || '').slice(0, 40),
    });
  }
  const n = meals.length;
  const sum = (k) => meals.reduce((a, m) => a + (Number(m[k]) || 0), 0);
  const avg = (k) => n ? Math.round((sum(k) / n) * 10) / 10 : 0;
  const days = new Set(meals.map(m => m.date)).size;
  const alcoholMeals = meals.filter(m => m.alc > 0).length;
  const alcoholDays = new Set(meals.filter(m => m.alc > 0).map(m => m.date)).size;
  const alcoholTotalG = Math.round(meals.reduce((a, m) => a + (Number(m.alc) || 0), 0) * 10) / 10;
  const alcoholPerDrinkDay = alcoholDays ? Math.round(alcoholTotalG / alcoholDays * 10) / 10 : 0;

  const TGT = getUserTargets(uid); // 個別目標 (未入力なら一律)
  return {
    ym, meal_count: n, days_logged: days,
    avg: { kcal: avg('kcal'), protein: avg('protein'), fat: avg('fat'), carbs: avg('carbs'), veg: avg('veg'), ca: avg('ca'), salt: avg('salt'), fiber: avg('fiber'), alc: avg('alc') },
    counts: {
      // ★許容範囲 (2026-08-07): 目安を少し外れただけの食事は「不足/オーバー」に数えない。
      //   1でも外れたら1件として数えていたため、月次の「野菜不足○件」が実態より多く出ていた。
      veg_low: meals.filter(m => m.veg < LOW(TGT.veg.min)).length,
      salt_high: meals.filter(m => m.salt > HIGH(TGT.salt.max)).length,
      fiber_low: meals.filter(m => m.fiber < LOW(TGT.fiber.min)).length,
      ca_low: meals.filter(m => m.ca < LOW(TGT.ca.min)).length,
      cal_high: meals.filter(m => m.kcal > HIGH(TGT.kcal.max)).length,
      fat_high: meals.filter(m => m.fat > HIGH(TGT.fat.max)).length,
      alcohol_meals: alcoholMeals, alcohol_days: alcoholDays,
      alcohol_total_g: alcoholTotalG, alcohol_per_drink_day: alcoholPerDrinkDay,
    },
    // tol = 許容範囲。画面(food-report.html)もこれを読んで同じ判定にする。
    targets: Object.assign({}, TGT, { tol: NUTRI_TOL }),
    meals,
  };
}

// ===== 受診用 食事傾向シート (2026-07-30) =====
// 定期受診している社員が、食事の傾向を医師に見せられるようにする。
// ⚠️ 数値は写真からの推定。AIの助言は含めず、集計した事実だけを返す。
// ⚠️ 本人のみ (推進メンバー/管理職は canAccess 経由で支援目的の閲覧可)。
function aggregateDoctor(uid, days) {
  const db = getDb();
  const d = Math.min(Math.max(parseInt(days, 10) || 90, 14), 365);
  const rows = db.prepare(
    `SELECT created_at, content, meal_type, food_source, nutrition_scores, COALESCE(extra_alcohol_g,0) AS extra_alc
       FROM plaza_posts
      WHERE author_id=? AND category='食事' AND nutrition_scores IS NOT NULL AND deleted_at IS NULL
        AND created_at >= datetime('now', ?)
      ORDER BY created_at ASC`).all(uid, '-' + d + ' days');

  const meals = [];
  for (const r of rows) {
    let s; try { s = JSON.parse(r.nutrition_scores); } catch (e) { continue; }
    if (!s) continue;
    const kcal = numOf(s.calories);
    if (!(kcal > 0)) continue;                 // 解析失敗/飲み物のみ(0kcal)は平均から除く
    const carbs = numOf(s.carbs), fiber = numOf(s.fiber);
    meals.push({
      at: r.created_at, date: (r.created_at || '').slice(0, 10),
      hour: Number((r.created_at || '').slice(11, 13)) + 9,   // created_atはUTC → JST
      meal_type: r.meal_type || null, food_source: r.food_source || null,
      kcal, protein: numOf(s.protein), fat: numOf(s.fat), carbs,
      veg: numOf(s.vitamin), ca: numOf(s.mineral), salt: numOf(s.salt), fiber,
      sugar: Math.round((carbs - fiber) * 10) / 10,           // 糖質=炭水化物-食物繊維 (表示上の導出値)
      alc: Math.round((numOf(s.alcohol) + Number(r.extra_alc || 0)) * 10) / 10,
      conf: (s.confidence && Number(s.confidence.level)) || null,
    });
  }
  const n = meals.length;
  const avg = (k) => n ? Math.round((meals.reduce((a, m) => a + (Number(m[k]) || 0), 0) / n) * 10) / 10 : 0;
  const KEYS = ['kcal', 'protein', 'fat', 'carbs', 'sugar', 'veg', 'ca', 'salt', 'fiber'];
  const A = {}; KEYS.forEach(k => { A[k] = avg(k); });

  const targets = getUserTargets(uid);
  // 目安から外れた食事の件数 (医師が「頻度」で判断できるように)
  const over = {
    salt: meals.filter(m => m.salt > HIGH(targets.salt.max)).length,
    kcal_high: meals.filter(m => m.kcal > HIGH(targets.kcal.max)).length,
    kcal_low: meals.filter(m => m.kcal < LOW(targets.kcal.min)).length,
    fat_high: meals.filter(m => m.fat > HIGH(targets.fat.max)).length,
    fiber_low: meals.filter(m => m.fiber < LOW(targets.fiber.min)).length,
    veg_low: meals.filter(m => m.veg < LOW(targets.veg.min)).length,
    ca_low: meals.filter(m => m.ca < LOW(targets.ca.min)).length,
  };
  // 食事区分・入手元・信憑性の内訳
  const cnt = (arr, key) => arr.reduce((o, m) => { const k = m[key] || '(未設定)'; o[k] = (o[k] || 0) + 1; return o; }, {});
  const days_logged = new Set(meals.map(m => m.date)).size;
  // 飲酒
  const alcDays = new Set(meals.filter(m => m.alc > 0).map(m => m.date));
  const alcTotal = Math.round(meals.reduce((a, m) => a + m.alc, 0) * 10) / 10;
  // 日別の食塩・エネルギー (医師が推移を見るため)
  const byDate = {};
  for (const m of meals) {
    const o = byDate[m.date] || (byDate[m.date] = { date: m.date, n: 0, kcal: 0, salt: 0, sugar: 0, alc: 0 });
    o.n++; o.kcal += m.kcal; o.salt += m.salt; o.sugar += m.sugar; o.alc += m.alc;
  }
  const daily = Object.values(byDate).map(o => ({
    date: o.date, n: o.n,
    kcal: Math.round(o.kcal), salt: Math.round(o.salt * 10) / 10,
    sugar: Math.round(o.sugar * 10) / 10, alc: Math.round(o.alc * 10) / 10,
  }));
  // 血圧 (あれば同じ紙に載せる。医師にとって食塩と併せて見る価値が高い)
  const bp = db.prepare(
    `SELECT COUNT(*) n, ROUND(AVG(systolic),0) sys, ROUND(AVG(diastolic),0) dia,
            MAX(substr(measured_at,1,10)) last
       FROM bp_records WHERE user_id=? AND measured_at >= datetime('now', ?)`).get(uid, '-' + d + ' days') || {};

  return {
    days: d, meal_count: n, days_logged,
    period: { from: meals.length ? meals[0].date : null, to: meals.length ? meals[n - 1].date : null },
    // tol = 許容範囲。over の件数は「目安から±tolを超えて外れた食事」だけを数えている。
    avg: A, targets, over, tol: NUTRI_TOL,
    meal_types: cnt(meals, 'meal_type'), sources: cnt(meals, 'food_source'),
    confidence: meals.reduce((o, m) => { const k = 'lv' + (m.conf || 0); o[k] = (o[k] || 0) + 1; return o; }, {}),
    alcohol: { days: alcDays.size, total_g: alcTotal, per_drink_day: alcDays.size ? Math.round(alcTotal / alcDays.size * 10) / 10 : 0 },
    daily,
    bp: (bp.n > 0) ? bp : null,
  };
}

// GET /api/food-report/doctor?days=90&user_id=(任意・推進のみ)
router.get('/doctor', authUser, (req, res) => {
  const target = (req.query.user_id || req.uid).toString();
  if (target !== req.uid && !canAccess(req.uid, target)) {
    return res.status(403).json({ success: false, msg: '閲覧権限がありません' });
  }
  const u = getDb().prepare('SELECT display_name, birth_date, sex, height_cm FROM users WHERE id=?').get(target) || {};
  const w = getDb().prepare('SELECT weight_kg FROM user_activity_prefs WHERE user_id=?').get(target) || {};
  const data = aggregateDoctor(target, req.query.days);
  res.json({
    success: true,
    person: {
      name: u.display_name || '', birth_date: u.birth_date || null,
      age: ageFromBirth(u.birth_date), sex: u.sex || null,
      height_cm: u.height_cm || null, weight_kg: w.weight_kg || null,
    },
    ...data,
  });
});

// 集計から Gemini 用プロンプト
function buildPrompt(name, metrics) {
  const a = metrics.avg, c = metrics.counts, n = metrics.meal_count;
  const line = (m) => `${m.date}: ${m.kcal}kcal P${m.protein} F${m.fat} C${m.carbs} 野菜${m.veg}g Ca${m.ca}mg 塩${m.salt}g 繊維${m.fiber}g 酒${m.alc}g`;
  const mealLines = metrics.meals.slice(0, 45).map(line).join('\n');
  const t = metrics.targets || {};
  const tgtLine = (t && t.kcal)
    ? `カロリー${t.kcal.min}-${t.kcal.max}kcal / たんぱく質${t.protein.min}g / 脂質${t.fat.min}-${t.fat.max}g / 炭水化物${t.carbs.min}-${t.carbs.max}g / 野菜${t.veg.min}g / カルシウム${t.ca.min}mg / 食塩${t.salt.max}g未満 / 食物繊維${t.fiber.min}g`
    : `カロリー450-650kcal / たんぱく質20g / 脂質12-18g / 炭水化物69-89g / 野菜120g / カルシウム227mg / 食塩2.5g未満 / 食物繊維7g`;
  return `あなたは管理栄養士兼ヘルスアドバイザーの「なぎさ」です。社員「${name}」さんの${ymLabel(metrics.ym)}の食事記録(${n}件)を分析し、月次レポートを作成してください。温かく前向きに、しかし健康課題は事実として誠実に伝えます。専門用語は避け、本人が読んで行動したくなる文章で。
${t.personalized ? '※目標はこの方の体格に合わせた個別目安です。栄養分析はこの個別目標を基準に評価してください。⚠️プライバシー厳守: マイページの個人情報(性別・年齢・生年月日・身長・体重・活動量)および推定必要カロリー等の個人数値はレポート本文に一切書かないこと。\n' : ''}
【1食あたりの目標${t.personalized ? '(この方の体格に合わせた個別目安)' : '(一般の参考値)'}】${tgtLine}
★許容範囲: 上の目標から**±${TOL_PCT}%以内のズレは「適量」**として扱う。写真からの推定には量の見積り誤差があるため、
わずかな超過/不足を「多い」「足りない」と書かない。指摘するのは${TOL_PCT}%を超えて外れているものだけにする。
(下の「内訳」の件数も、この許容範囲を超えて外れた食事だけを数えている)

【今月の平均(1食あたり)】
カロリー${a.kcal}kcal / たんぱく質${a.protein}g / 脂質${a.fat}g / 炭水化物${a.carbs}g / 野菜${a.veg}g / カルシウム${a.ca}mg / 食塩${a.salt}g / 食物繊維${a.fiber}g / アルコール${a.alc}g
記録: ${n}件 / ${metrics.days_logged}日
内訳: 野菜不足の食事${c.veg_low}件 / 塩分オーバー${c.salt_high}件 / 食物繊維不足${c.fiber_low}件 / カルシウム不足${c.ca_low}件 / 高カロリー${c.cal_high}件 / 脂質過多${c.fat_high}件
【飲酒】飲酒した日 ${c.alcohol_days}日 / ${metrics.days_logged}日中、飲酒した食事 ${c.alcohol_meals}件、純アルコール総量 約${c.alcohol_total_g}g (飲酒日あたり平均 約${c.alcohol_per_drink_day}g/日)
※飲酒の目安: 厚生労働省「節度ある適度な飲酒」=1日あたり純アルコール約20g(ビール中瓶1本/日本酒1合/缶チューハイ(7%)350ml 程度)、週2日程度の休肝日が望ましい。純アルコール60g/日以上は生活習慣病リスクを高める多量飲酒。

【食事ログ(最大45件)】
${mealLines}

以下のJSONのみを出力(前後に文章を付けない):
{
 "summary": "今月のサマリー。記録をねぎらいつつ全体像を150-220字で。",
 "nutrition_analysis": "栄養分析。目標と比べて何が足り/過剰かを数値根拠つきで200-300字。",
 "alcohol": "飲酒(お酒)についての分析と助言。140-240字。飲酒日数・量・休肝日の有無を上記データと厚労省の目安(約20g/日・週2日の休肝日)に照らして具体的に評価し、肝臓や生活習慣病への影響にも触れる。飲酒がほとんど無い場合は『飲酒は控えめで良い習慣です』と前向きに。",
 "tendencies": "食習慣の傾向。曜日/時間帯/偏りの癖を具体的に180-260字。良い癖も挙げる。",
 "next_month": ["来月心がけたい具体行動を3つ。各40-70字。実在する料理名や置き換え例を入れる。飲酒が多めなら休肝日など飲酒に関する目標も1つ入れる。"],
 "future_warning": "このままの食習慣・飲酒習慣が続いた場合に将来起こりうる身体の変化への警鐘。200-320字。飲酒が多めの場合は肝機能(脂肪肝・肝障害)への影響にも必ず言及。ただし【重要】医療診断ではなく一般的な生活習慣リスクとして表現し、断定を避け、最後に必ず『気になる症状があれば健康診断や医療機関で相談を』という趣旨の一文を添える。",
 "cheer": "締めの応援メッセージ。80-140字。"
}`;
}

// レポート生成(集計→AI→保存)。返り値 {metrics, report}
async function generateReport(uid, ym) {
  const db = getDb();
  const metrics = aggregateMonth(uid, ym);
  if (metrics.meal_count < MIN_MEALS) {
    const e = new Error(`${ymLabel(ym)}の食事記録が${metrics.meal_count}件です(${MIN_MEALS}件以上で作成できます)`);
    e.code = 'TOO_FEW';
    throw e;
  }
  const u = db.prepare('SELECT display_name, nickname FROM users WHERE id = ?').get(uid) || {};
  const name = u.display_name || u.nickname || '社員';
  const raw = await generateText(buildPrompt(name, metrics), { responseMimeType: 'application/json', maxTokens: 2200, temperature: 0.6 });
  let report;
  try { report = JSON.parse(raw); } catch (e) {
    const m = raw.match(/\{[\s\S]*\}/); report = m ? JSON.parse(m[0]) : null;
  }
  if (!report) throw new Error('レポート生成に失敗しました(AI応答の解析エラー)');
  if (!Array.isArray(report.next_month)) report.next_month = report.next_month ? [String(report.next_month)] : [];
  if (typeof report.alcohol !== 'string') report.alcohol = report.alcohol ? String(report.alcohol) : '';

  const id = 'FMR-' + uid.slice(0, 8) + '-' + ym.replace('-', '');
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  // 集計の数値(グラフ用)はAIでなく実測を保存
  const metricsForStore = { ym: metrics.ym, meal_count: metrics.meal_count, days_logged: metrics.days_logged, avg: metrics.avg, counts: metrics.counts };
  db.prepare(
    `INSERT INTO food_monthly_reports (id, user_id, ym, meal_count, metrics_json, report_json, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET meal_count=excluded.meal_count, metrics_json=excluded.metrics_json, report_json=excluded.report_json, created_at=excluded.created_at`
  ).run(id, uid, ym, metrics.meal_count, JSON.stringify(metricsForStore), JSON.stringify(report), now);
  return { id, metrics: metricsForStore, report };
}

// 自動生成対象(指定月に MIN_MEALS 件以上 かつ 未作成 のユーザーID配列)
function listAutoTargets(ym) {
  const db = getDb();
  const [start, end] = ymRange(ym);
  const rows = db.prepare(
    `SELECT author_id AS uid, COUNT(*) n FROM plaza_posts
     WHERE category='食事' AND nutrition_scores IS NOT NULL AND deleted_at IS NULL
       AND created_at >= ? AND created_at < ?
     GROUP BY author_id HAVING n >= ?`
  ).all(start, end, MIN_MEALS);
  const out = [];
  for (const r of rows) {
    const exists = db.prepare('SELECT 1 FROM food_monthly_reports WHERE user_id=? AND ym=?').get(r.uid, ym);
    if (!exists) out.push(r.uid);
  }
  return out;
}

function loadReport(uid, ym) {
  const r = getDb().prepare('SELECT * FROM food_monthly_reports WHERE user_id=? AND ym=?').get(uid, ym);
  if (!r) return null;
  let metrics = {}, report = {};
  try { metrics = JSON.parse(r.metrics_json || '{}'); } catch (e) {}
  try { report = JSON.parse(r.report_json || '{}'); } catch (e) {}
  return { id: r.id, ym: r.ym, meal_count: r.meal_count, created_at: r.created_at, metrics, report };
}

// 指定ユーザーが食事投稿した月の一覧(件数つき・新しい順)
function monthsForUser(uid) {
  return getDb().prepare(
    `SELECT substr(created_at,1,7) AS ym, COUNT(*) n FROM plaza_posts
     WHERE author_id=? AND category='食事' AND nutrition_scores IS NOT NULL AND deleted_at IS NULL
     GROUP BY ym ORDER BY ym DESC`
  ).all(uid);
}

// ===== API =====
router.get('/init', authUser, (req, res) => {
  const db = getDb();
  const me = db.prepare('SELECT id, display_name FROM users WHERE id=?').get(req.uid) || {};
  const promoter = isPromoterUid(req.uid);
  const myMonths = monthsForUser(req.uid);
  const myReports = db.prepare('SELECT ym FROM food_monthly_reports WHERE user_id=? ORDER BY ym DESC').all(req.uid).map(r => r.ym);
  res.json({
    success: true,
    me: { uid: req.uid, name: me.display_name || '', is_promoter: promoter },
    min_meals: MIN_MEALS,
    my_months: myMonths, my_reports: myReports,
  });
});

// 推進メンバー向け: メンバーごとの食事件数(今月/先月)とレポート有無
router.get('/members', authUser, (req, res) => {
  if (!isPromoterUid(req.uid)) return res.status(403).json({ success: false, msg: '推進メンバーのみ閲覧できます' });
  const db = getDb();
  const thisYm = new Date().toISOString().slice(0, 7);
  const lastYm = prevYm();
  const cnt = (ym) => {
    const [s, e] = ymRange(ym);
    const rows = db.prepare(`SELECT author_id AS uid, COUNT(*) n FROM plaza_posts WHERE category='食事' AND nutrition_scores IS NOT NULL AND deleted_at IS NULL AND created_at>=? AND created_at<? GROUP BY author_id`).all(s, e);
    const m = {}; rows.forEach(r => m[r.uid] = r.n); return m;
  };
  const tc = cnt(thisYm), lc = cnt(lastYm);
  const uids = new Set([...Object.keys(tc), ...Object.keys(lc)]);
  const items = [];
  for (const uid of uids) {
    const u = db.prepare('SELECT display_name FROM users WHERE id=?').get(uid);
    if (!u) continue;
    const reports = db.prepare('SELECT ym FROM food_monthly_reports WHERE user_id=? ORDER BY ym DESC').all(uid).map(r => r.ym);
    items.push({ uid, name: u.display_name, this_month: tc[uid] || 0, last_month: lc[uid] || 0, reports });
  }
  items.sort((a, b) => (b.this_month + b.last_month) - (a.this_month + a.last_month));
  res.json({ success: true, this_ym: thisYm, last_ym: lastYm, items });
});

// レポート取得 (本人 or 推進メンバー)
router.get('/get', authUser, (req, res) => {
  const targetUid = req.query.user_id || req.uid;
  const ym = req.query.ym;
  if (!ym) return res.status(400).json({ success: false, msg: '月(ym)を指定してください' });
  if (!canAccess(req.uid, targetUid)) return res.status(403).json({ success: false, msg: '閲覧権限がありません' });
  const rep = loadReport(targetUid, ym);
  if (!rep) return res.json({ success: false, msg: 'レポート未作成' });
  const u = getDb().prepare('SELECT display_name FROM users WHERE id=?').get(targetUid) || {};
  res.json({ success: true, target: { uid: targetUid, name: u.display_name || '' }, report: rep });
});

// レポート生成 (本人 or 推進メンバーが対象者を指定)
router.post('/generate', authUser, express.json(), async (req, res) => {
  const targetUid = (req.body && req.body.user_id) || req.uid;
  const ym = req.body && req.body.ym;
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return res.status(400).json({ success: false, msg: '月(ym=YYYY-MM)を指定してください' });
  if (!canAccess(req.uid, targetUid)) return res.status(403).json({ success: false, msg: '作成権限がありません' });
  try {
    const out = await generateReport(targetUid, ym);
    res.json({ success: true, report: out });
  } catch (e) {
    res.status(e.code === 'TOO_FEW' ? 400 : 500).json({ success: false, msg: e.message || '生成に失敗しました' });
  }
});

// レポート完成を対象者へ通知 (bot_health DM + リアルタイム + プッシュ)。推進メンバー/管理職が送信。
router.post('/notify', authUser, express.json(), (req, res) => {
  const targetUid = (req.body && req.body.user_id) || req.uid;
  const ym = req.body && req.body.ym;
  if (!ym) return res.status(400).json({ success: false, msg: '月(ym)を指定してください' });
  if (!isPromoterUid(req.uid)) return res.status(403).json({ success: false, msg: '推進メンバーのみ通知できます' });
  const db = getDb();
  if (!loadReport(targetUid, ym)) return res.status(400).json({ success: false, msg: 'レポートが未作成です' });
  const msg = '📊 ' + ymLabel(ym) + 'のマンスリー栄養レポートができました！\nこの1か月の食事の栄養分析・傾向・来月の心がけをまとめています。\nホームの🏥Health →「📊 マンスリー栄養レポート」から見てね。\n→ https://cohub.biz-terrace.org/food-report.html';
  try {
    const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES ('bot_health', ?, ?, 'dm')").run(targetUid, msg);
    const emitToUser = req.app && req.app.locals && req.app.locals.emitToUser;
    if (emitToUser) emitToUser(targetUid, 'dm:msg', { id: ins.lastInsertRowid, from: 'bot_health', to: targetUid, content: msg, at: new Date().toISOString(), attach: null });
    const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (sendPush) sendPush(targetUid, { title: '📊 マンスリー栄養レポート', body: ymLabel(ym) + 'の栄養レポートができました', tag: 'food-monthly', url: '/food-report.html' }).catch(() => {});
  } catch (e) { return res.status(500).json({ success: false, msg: e.message }); }
  res.json({ success: true });
});


// ===== おしらせ用の「要点だけ」テキスト (2026-08-01 社長指示) =====
// 従来は bot_health 名義のDMで本文リンクだけを送っていたが、bot_ 名義はチャットのDM一覧から
// 除外されるため誰にも見えていなかった。notice_food 名義で「🔔 おしらせ」欄に出し、
// 要点(記録数・1食平均・気になる点2つ)だけを見せて本編へ誘導する。
const NOTICE_FLAGS = [
  { key: 'salt_high', label: '塩分が多め' },
  { key: 'fat_high',  label: '脂質が多め' },
  { key: 'cal_high',  label: 'カロリーが多め' },
  { key: 'veg_low',   label: '野菜が少なめ' },
  { key: 'fiber_low', label: '食物繊維が不足' },
  { key: 'ca_low',    label: 'カルシウムが不足' },
];

function noticeText(uid, ym) {
  const row = getDb().prepare('SELECT metrics_json FROM food_monthly_reports WHERE user_id=? AND ym=?').get(uid, ym);
  if (!row) return null;
  let m = {};
  try { m = JSON.parse(row.metrics_json || '{}'); } catch (e) { m = {}; }
  const avg = m.avg || {}, c = m.counts || {}, meals = m.meal_count || 0;
  const L = [];
  L.push('📊 ' + ymLabel(ym) + 'のマンスリー栄養レポートができました');
  L.push('');
  L.push('記録 ' + meals + '件 / ' + (m.days_logged || 0) + '日');
  const avgParts = [];
  if (avg.kcal) avgParts.push(Math.round(avg.kcal) + 'kcal');
  if (avg.protein) avgParts.push('たんぱく質 ' + avg.protein + 'g');
  if (avg.salt) avgParts.push('塩分 ' + avg.salt + 'g');
  if (avg.veg) avgParts.push('野菜 ' + Math.round(avg.veg) + 'g');
  if (avgParts.length) L.push('1食あたりの平均: ' + avgParts.join(' ・ '));
  const flags = NOTICE_FLAGS
    .map(f => ({ label: f.label, n: c[f.key] || 0 }))
    .filter(f => f.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 2);
  if (flags.length) {
    L.push('気になる点: ' + flags.map(f => f.label + '(' + f.n + '/' + meals + '食)').join(' ・ '));
  } else {
    L.push('大きな偏りは見られませんでした。この調子で続けましょう。');
  }
  L.push('');
  L.push('→ 分析の全文・傾向・来月の心がけは 🍱 マンスリー栄養レポート で読めます');
  L.push('/food-report.html');
  return L.join('\n');
}


module.exports = router;
module.exports.generateReport = generateReport;
module.exports.listAutoTargets = listAutoTargets;
module.exports.prevYm = prevYm;
module.exports.ymLabel = ymLabel;

module.exports.noticeText = noticeText;
module.exports.NOTICE_SENDER = 'notice_food';
