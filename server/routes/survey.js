// 推進アンケート — 組織変革ループ 自己評価 (記名・5段階リッカート) 2026-06-26
// 西村さんの推進メンバー向けアンケート(全18問)をCoHub上で回答できるようにする。
// 設問は固定の調査票。回答前に「各設問が何を測るか(9観点)」を提示して理解を促す。
// opinion.js / vote.js の作法を踏襲: authUser + services/db + 未回答バッジ(unread-count)。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

router.use(express.json({ limit: '256kb' }));

// ───────────────────────── 調査票の定義 ─────────────────────────
// 現在アクティブな1本。将来別の調査票を足す場合は SURVEYS に追加し ACTIVE_KEY を切替。
const SCALE = [
  { v: 1, label: '全く\nそう思わない' },
  { v: 2, label: 'あまり\nそう思わない' },
  { v: 3, label: 'どちらとも\n言えない' },
  { v: 4, label: 'やや\nそう思う' },
  { v: 5, label: 'とても\nそう思う' },
];

const SURVEY = {
  key: 'promoter_orgchange_v1',
  title: '推進メンバー アンケート',
  subtitle: '健康づくり活動(CoWell)の進み具合 自己評価',
  intro:
    'このアンケートは、CoWell（健康づくり活動）が職場でどのように進んでいるかを、推進メンバーの皆さんの実感から確かめるものです。\n'
    + '点数の良し悪しを評価するためではなく、活動の「今の状態」を見える化し、次の改善につなげるためのものです。\n'
    + '各設問は、活動が良いサイクルで回るために大切な9つの観点に対応しています。それぞれの観点が「何を意味するのか」を読んだ上で、今のあなたの実感に最も近いものを1つお選びください。',
  // xlsx の同意文をそのまま掲載
  consent: [
    '本アンケートは、健康づくり活動の評価および今後の改善を目的として実施するものです。',
    '回答は自由意思によるものであり、回答しない場合でも不利益は一切ありません。',
    '本調査では、経時的な変化を把握するため、個人識別のための情報を取得しますが、取得した情報は事業評価の目的のみに使用し、個人が特定される形で公表されることはありません。',
    'また、回答内容が人事評価等に利用されることは一切なく、データは適切に管理し、事業評価終了後は規定に基づき適切に廃棄します。',
  ],
  consentCheckLabel: '上記の説明を確認し、調査票の研究・事業評価への利用に同意します。',
  scale: SCALE,
  categories: [
    {
      name: '① 参画・主体性',
      desc: 'あなた自身が「自分ごと」として活動に関われているかを確認します。',
      questions: [
        { n: 1, text: '職場の健康づくりの活動に、自分は主体的に関わっていると感じる' },
        { n: 2, text: '自分の意見や考えを活動の中で発言できている' },
      ],
    },
    {
      name: '② リーダーシップ',
      desc: '活動を引っぱる人がいて、その人がメンバーの声を大切にしているかを確認します。',
      questions: [
        { n: 3, text: '職場には健康づくりを進めるリーダーがいると感じる' },
        { n: 4, text: 'リーダーはメンバーの意見を尊重している' },
      ],
    },
    {
      name: '③ 活動の基盤・体制',
      desc: '話し合いの場や役割分担など、活動を進める「土台」が整っているかを確認します。',
      questions: [
        { n: 5, text: '健康づくりのための話し合いや活動の場が整っている' },
        { n: 6, text: '役割分担が明確で、活動が進めやすい' },
      ],
    },
    {
      name: '④ 課題の明確さ',
      desc: '職場の健康課題がはっきりし、その原因まで理解できているかを確認します。',
      questions: [
        { n: 7, text: '職場の健康課題が明確になっていると感じる' },
        { n: 8, text: 'なぜその課題が起きているのか理解できている' },
      ],
    },
    {
      name: '⑤ 資源・支援',
      desc: '活動に必要な情報・時間・環境などの支援が得られているかを確認します。',
      questions: [
        { n: 9, text: '健康づくりに必要な情報や支援が得られている' },
        { n: 10, text: '時間や環境など、取り組みやすい条件がある' },
      ],
    },
    {
      name: '⑥ 外部との連携',
      desc: '専門家・大学・保健師など、外部の力が活動の役に立っているかを確認します。',
      questions: [
        { n: 11, text: '外部（専門家・大学・保健師など）との連携が役立っている' },
        { n: 12, text: '外部の支援が活動の質を高めている' },
      ],
    },
    {
      name: '⑦ 気づき・行動変容',
      desc: '活動を通じて、自分たちの健康や働き方を見直すきっかけが生まれたかを確認します。',
      questions: [
        { n: 13, text: '自分たちの健康問題について深く考えるようになった' },
        { n: 14, text: 'これまでの生活習慣や働き方を見直す機会があった' },
      ],
    },
    {
      name: '⑧ 改善のサイクル（PDCA）',
      desc: '計画→実施→振り返り→改善のサイクルが回っているかを確認します。',
      questions: [
        { n: 15, text: '活動の計画・実施・振り返りが適切に行われている' },
        { n: 16, text: '改善に向けた話し合いが行われている' },
      ],
    },
    {
      name: '⑨ 成果・持続性',
      desc: '活動が職場に良い影響を生み、これからも続けられる形になっているかを確認します。',
      questions: [
        { n: 17, text: 'この活動が職場全体に良い影響を与えていると感じる' },
        { n: 18, text: '今後も継続できる仕組みになっていると思う' },
      ],
    },
  ],
};
const ALL_QNOS = SURVEY.categories.flatMap(c => c.questions.map(q => q.n)); // [1..18]
const Q_COUNT = ALL_QNOS.length;

// ───────────────────────── スキーマ ─────────────────────────
function ensureSchema() {
  const db = getDb();
  db.prepare(`CREATE TABLE IF NOT EXISTS survey_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    survey_key TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT DEFAULT '',
    department TEXT DEFAULT '',
    consent INTEGER DEFAULT 0,
    answers_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(survey_key, user_id)
  )`).run();
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_survey_resp_key ON survey_responses(survey_key)').run(); } catch (e) {}
}
try { ensureSchema(); } catch (e) { console.warn('[survey] ensureSchema skipped:', e.message); }

// 対象=推進メンバー(現場 or 倉庫)。閲覧結果は推進 or 管理者。個別明細は管理者のみ。
function roleFlags(db, uid) {
  const u = db.prepare(`SELECT display_name, company_code, role, employee_type,
      is_field_promoter, is_warehouse_promoter FROM users WHERE id = ?`).get(uid) || {};
  const isPromoter = !!(u.is_field_promoter || u.is_warehouse_promoter);
  const isAdmin = u.role === 'admin' && u.employee_type === 'admin';
  return { u, isPromoter, isAdmin };
}

// 対象者(推進メンバー)一覧
function targetUsers(db) {
  return db.prepare(`SELECT id, display_name, company_code FROM users
    WHERE (is_field_promoter = 1 OR is_warehouse_promoter = 1) AND role != 'bot'
    ORDER BY company_code, display_name`).all();
}

// ───────────────────────── 未回答バッジ ─────────────────────────
// 対象者であり、アクティブ調査票に未回答なら 1。
router.get('/unread-count', authUser, (req, res) => {
  const db = getDb();
  const { isPromoter } = roleFlags(db, req.uid);
  if (!isPromoter) return res.json({ success: true, count: 0 });
  const done = db.prepare('SELECT 1 FROM survey_responses WHERE survey_key = ? AND user_id = ?').get(SURVEY.key, req.uid);
  res.json({ success: true, count: done ? 0 : 1 });
});

// ───────────────────────── 回答ページ用: 調査票 + 自分の回答 ─────────────────────────
router.get('/active', authUser, (req, res) => {
  const db = getDb();
  const { u, isPromoter, isAdmin } = roleFlags(db, req.uid);
  const mine = db.prepare('SELECT name, department, consent, answers_json, updated_at FROM survey_responses WHERE survey_key = ? AND user_id = ?')
    .get(SURVEY.key, req.uid);
  let my_response = null;
  if (mine) {
    let answers = {};
    try { answers = JSON.parse(mine.answers_json) || {}; } catch (e) {}
    my_response = { name: mine.name, department: mine.department, consent: !!mine.consent, answers, updated_at: mine.updated_at };
  }
  res.json({
    success: true,
    survey: SURVEY,
    is_target: isPromoter,
    can_submit: isPromoter || isAdmin,
    can_view_results: isPromoter || isAdmin,
    can_view_detail: isAdmin,
    prefill: { name: u.display_name || '', department: '' },
    my_response,
  });
});

// ───────────────────────── 回答の保存(1人1件・上書き) ─────────────────────────
router.post('/respond', authUser, (req, res) => {
  const db = getDb();
  const { u, isPromoter, isAdmin } = roleFlags(db, req.uid);
  if (!(isPromoter || isAdmin)) return res.status(403).json({ success: false, msg: 'このアンケートの対象者ではありません' });
  const b = req.body || {};
  if (!b.consent) return res.status(400).json({ success: false, msg: '同意のチェックをお願いします' });
  const name = String(b.name || u.display_name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ success: false, msg: 'お名前を入力してください' });
  const department = String(b.department || '').trim().slice(0, 80);
  // 18問すべて 1..5 で揃っているか
  const ans = (b.answers && typeof b.answers === 'object') ? b.answers : {};
  const clean = {};
  for (const n of ALL_QNOS) {
    const v = parseInt(ans[n], 10);
    if (!(v >= 1 && v <= 5)) return res.status(400).json({ success: false, msg: `設問${n}が未回答です。すべての設問にお答えください` });
    clean[n] = v;
  }
  const exist = db.prepare('SELECT id FROM survey_responses WHERE survey_key = ? AND user_id = ?').get(SURVEY.key, req.uid);
  if (exist) {
    db.prepare("UPDATE survey_responses SET name=?, department=?, consent=1, answers_json=?, updated_at=datetime('now') WHERE id=?")
      .run(name, department, JSON.stringify(clean), exist.id);
  } else {
    db.prepare('INSERT INTO survey_responses (survey_key, user_id, name, department, consent, answers_json) VALUES (?, ?, ?, ?, 1, ?)')
      .run(SURVEY.key, req.uid, name, department, JSON.stringify(clean));
  }
  // 研究同意フラグも本人プロフィールに反映(任意・既存カラム)
  try { db.prepare("UPDATE users SET research_consent=1, research_consent_at=datetime('now') WHERE id=? AND (research_consent IS NULL OR research_consent=0)").run(req.uid); } catch (e) {}
  res.json({ success: true });
});

// ───────────────────────── 結果(集計) ─────────────────────────
// 集計は推進 or 管理者。個別氏名明細は管理者のみ。
router.get('/results', authUser, (req, res) => {
  const db = getDb();
  const { isPromoter, isAdmin } = roleFlags(db, req.uid);
  if (!(isPromoter || isAdmin)) return res.status(403).json({ success: false, msg: '結果の閲覧権限がありません' });

  const rows = db.prepare('SELECT user_id, name, department, answers_json, updated_at FROM survey_responses WHERE survey_key = ?').all(SURVEY.key);
  const parsed = rows.map(r => { let a = {}; try { a = JSON.parse(r.answers_json) || {}; } catch (e) {} return { ...r, answers: a }; });

  // 設問別: 平均・件数・分布[1..5]
  const perQuestion = {};
  for (const n of ALL_QNOS) {
    const vals = parsed.map(p => parseInt(p.answers[n], 10)).filter(v => v >= 1 && v <= 5);
    const dist = [0, 0, 0, 0, 0];
    vals.forEach(v => { dist[v - 1]++; });
    const avg = vals.length ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : null;
    perQuestion[n] = { avg, n: vals.length, dist };
  }
  // 観点別平均(その観点の全設問の回答をまとめて平均)
  const perCategory = SURVEY.categories.map(c => {
    const qns = c.questions.map(q => q.n);
    let sum = 0, cnt = 0;
    parsed.forEach(p => qns.forEach(n => { const v = parseInt(p.answers[n], 10); if (v >= 1 && v <= 5) { sum += v; cnt++; } }));
    return { name: c.name, avg: cnt ? +(sum / cnt).toFixed(2) : null, n: cnt };
  });

  const targets = targetUsers(db);
  const respondedIds = new Set(parsed.map(p => p.user_id));
  const status = targets.map(t => ({
    name: t.display_name, company_code: t.company_code,
    responded: respondedIds.has(t.id),
  }));
  // 対象外(管理者など)からの回答も件数には含める
  const respondent_count = parsed.length;
  const target_count = targets.length;

  const out = {
    success: true,
    survey: { key: SURVEY.key, title: SURVEY.title, subtitle: SURVEY.subtitle, scale: SURVEY.scale, categories: SURVEY.categories },
    respondent_count, target_count,
    responded_targets: status.filter(s => s.responded).length,
    perQuestion, perCategory,
    status,
    can_view_detail: isAdmin,
  };
  // 個別明細(氏名付き)は管理者のみ
  if (isAdmin) {
    out.detail = parsed
      .sort((a, b) => (a.department || '').localeCompare(b.department || ''))
      .map(p => ({ name: p.name, department: p.department, updated_at: p.updated_at, answers: p.answers }));
  }
  res.json(out);
});

module.exports = router;
