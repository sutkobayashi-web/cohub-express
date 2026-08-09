// 受付AI葵の "その人だけ" のログイン一言。
// 2026-07-23 初版: 昨日の帰庫点呼(つかれ/からだスコア)・昨日の運転アラートから気づかいの一言を生成。
// 2026-07-27 改訂: 「毎日同じでは飽きる」(社長)→ 話題を複数持ち、その人・その日で選び分ける。
//   ① 話題(トピック)を材料ごとに集める → ② 直近に使った話題を外して1つ選ぶ → ③ AIが言い回しを変えて生成。
//   選択は uid と日付から決めるので、同じ日に再ログインしても同じ、翌日は別の話題になる。
//   ⚠️共用タブレットで音声で読み上げられる。血圧・体重などの具体的な数値、病名、他人の情報は絶対に出さない。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateText } = require('../services/ai');

// JST の YYYY-MM-DD (offsetDays 日ずらし)
function jstDate(offsetDays) {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + (offsetDays || 0));
  return d.toISOString().slice(0, 10);
}
// 1970-01-01 からの経過日数(JST)。日替わりの話題ローテーションに使う。
function jstDayNo() {
  return Math.floor((Date.now() + 9 * 3600 * 1000) / 86400000);
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0;
  return h;
}

// 生成した一言の履歴(=当日キャッシュ 兼 直近の話題/言い回しの重複回避)
function ensureTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS aoi_greeting_log (
    uid TEXT NOT NULL,
    rec_date TEXT NOT NULL,
    topic TEXT,
    mood TEXT,
    line TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (uid, rec_date)
  )`);
  // 当日の何回目のログインかを数える(2回目以降は挨拶を短く変えるため) 2026-07-27
  try { getDb().exec('ALTER TABLE aoi_greeting_log ADD COLUMN visits INTEGER DEFAULT 0'); } catch (e) {}
  try { getDb().exec('ALTER TABLE aoi_greeting_log ADD COLUMN last_at TEXT'); } catch (e) {}
}
try { ensureTable(); } catch (e) { console.warn('[aoi] table init', e.message); }

// 当日の来訪回数を1つ進めて返す。
// ⚠️greetNow は同じログインの中で二重に呼ばれることがある(kiosk自動+初回タッチ)ので、
//   前回から10分以内は「同じ来訪」とみなして数えない。
function touchVisit(uid, today) {
  const db = getDb();
  db.prepare(`INSERT INTO aoi_greeting_log (uid, rec_date, visits, last_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(uid, rec_date) DO UPDATE SET
      visits = COALESCE(visits, 0) + (CASE WHEN last_at IS NULL OR last_at < datetime('now', '-10 minutes') THEN 1 ELSE 0 END),
      last_at = CASE WHEN last_at IS NULL OR last_at < datetime('now', '-10 minutes') THEN datetime('now') ELSE last_at END`)
    .run(uid, today);
  const row = db.prepare('SELECT visits FROM aoi_greeting_log WHERE uid = ? AND rec_date = ?').get(uid, today);
  return Math.max(1, (row && row.visits) || 1);
}

// 拠点の天気(既存の /api/weather を内部から利用・30分キャッシュ付き)。取れなければ null。
async function fetchWeather(companyCode) {
  try {
    const port = process.env.PORT || 3007;
    const r = await fetch(`http://127.0.0.1:${port}/api/weather?loc=${encodeURIComponent(companyCode || '')}`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || !d.success) return null;
    return d;   // { place, temp, hi, lo, icon, desc } = weather.js の返り値
  } catch (e) { return null; }
}

// ===== 共有カレンダーの「その人の予定」 (2026-07-27 社長要望) =====
// ⭐読み上げるのは **本人が登録した予定だけ** (created_by = 本人)。
//   グループ宛に共有された他人の予定は読まない = 共用タブレットで声に出しても本人の情報しか出ない。
//   ⚠️ここはAIに書かせない。時刻や件名を作文されると事故になるので、素のデータから定型文で組む。
const SCHED_MAX = 3;   // 声に出すのは3件まで(それ以上は「ほか○件」)

// '2026-07-27 14:30' → 14時30分 / '2026-07-27' (終日) → null
function timeSay(startAt) {
  const m = String(startAt || '').match(/\s(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  return mi ? `${h}時${mi}分` : `${h}時`;
}
// 件名の頭に付いた自分の名字(「吉沢　有休…」「青木B 面接…」)は読み上げでは省く。
// 記号は読み上げが不自然になるので落とす(表示側は元のまま)。
function titleSay(title, surname) {
  let t = String(title || '').trim();
  if (surname && t.startsWith(surname)) {
    t = t.slice(surname.length).replace(/^[\s　_・:：-]+/, '');
    t = t.replace(/^[A-Za-z][\s　]+/, '');   // 「青木B 面接」の B のような1文字の識別子
  }
  // 読み上げ用の整形: 半角カナ→全角(NFKC)、記号は読み上げると不自然なので置き換える
  try { t = t.normalize('NFKC'); } catch (e) {}
  return t
    .replace(/MTG/gi, 'ミーティング')
    .replace(/[&＆]/g, 'と')
    .replace(/[:：]/g, '、')
    .replace(/[_|｜]/g, ' ')
    .replace(/[\s　]+/g, ' ')
    .trim();
}
function schedSentence(head, rows, surname) {
  if (!rows.length) return { text: '', say: '' };
  const show = rows.slice(0, SCHED_MAX);
  const rest = rows.length - show.length;
  // 件名自体が「終日業務処理」のように終日で始まる場合は「終日 終日業務処理」と重ねない
  const allDayHead = r => (Number(r.all_day) && !/^終日/.test(String(r.title || '').trim()));
  const partsShow = show.map(r => {
    const t = Number(r.all_day) ? (allDayHead(r) ? '終日 ' : '') : (timeSay(r.start_at) ? timeSay(r.start_at) + 'から ' : '');
    return t + String(r.title || '').trim();
  });
  const partsSay = show.map(r => {
    const t = Number(r.all_day) ? (allDayHead(r) ? '終日、' : '') : (timeSay(r.start_at) ? timeSay(r.start_at) + 'から、' : '');
    return t + titleSay(r.title, surname);
  });
  const tail = rest > 0 ? `、ほか ${rest}件` : '';
  return {
    text: `${head}は ${partsShow.join('、')}${tail} の予定です。`,
    say: `${head}は、${partsSay.join('。')}${tail}、の予定です。`,
  };
}

// 今日(まだ終わっていないもの)と明日の予定。予定が無ければ空文字。
function collectSchedule(uid, surname) {
  const db = getDb();
  const today = jstDate(0);
  const tomorrow = jstDate(1);
  // 終日は 'YYYY-MM-DD'、時刻ありは 'YYYY-MM-DD HH:MM' で入っている
  const pick = (day, onlyRemaining) => {
    let rows = [];
    try {
      rows = db.prepare(`SELECT id, title, category, start_at, end_at, all_day
                         FROM shared_calendar_events
                         WHERE deleted_at IS NULL AND created_by = ? AND substr(start_at, 1, 10) = ?
                         ORDER BY all_day DESC, start_at`).all(uid, day);
    } catch (e) { console.warn('[aoi sched]', e.message); return []; }
    if (!onlyRemaining) return rows;
    // 今日ぶんは、もう終わった予定を読み上げても意味がないので落とす
    const nowHm = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 16);
    return rows.filter(r => {
      if (Number(r.all_day)) return true;
      const end = String(r.end_at || '').slice(11, 16);
      const start = String(r.start_at || '').slice(11, 16);
      return (end || start) >= nowHm;
    });
  };
  const t = pick(today, true);
  const n = pick(tomorrow, false);
  return {
    today: Object.assign({ count: t.length }, schedSentence('今日', t, surname)),
    tomorrow: Object.assign({ count: n.length }, schedSentence('明日', n, surname)),
  };
}

// ===== 材料あつめ =====
// 返り値: [{ topic, mood, fact, guide }] 上から優先(安全・体調は必ず優先)
async function collectTopics(uid) {
  const db = getDb();
  const u = db.prepare('SELECT display_name, company_code, job_role, birth_date FROM users WHERE id = ?').get(uid) || {};
  const today = jstDate(0);
  const yst = jstDate(-1);
  const week = jstDate(-6);
  const must = [];    // 必ず優先する話題(安全/疲労)
  const pool = [];    // 日替わりで選ぶ話題

  // ① 昨日の帰庫点呼 (つかれ/からだスコア 0-10、ふだん=5)
  const kiko = db.prepare(
    'SELECT fatigue_score, body_score FROM tenko_kiko WHERE driver_id = ? AND rec_date = ? ORDER BY id DESC LIMIT 1'
  ).get(uid, yst) || {};
  // ② 直近の運転アラート (driving_alerts は user_id 無 → 氏名を空白無視で突合。日付はスラッシュ混在を正規化)
  // ⚠️「昨日」限定だと、休み明け等で翌日ログインしない人には一度も伝わらない → 直近3日を見て、
  //    そのアラート日について まだ触れていない ときだけ1回伝える(毎日蒸し返さない)。
  const al = db.prepare(
    "SELECT REPLACE(substr(occurred_at,1,10),'/','-') AS d, COUNT(*) AS c FROM driving_alerts "
    + "WHERE REPLACE(substr(occurred_at,1,10),'/','-') >= ? AND REPLACE(substr(occurred_at,1,10),'/','-') <= ? "
    + "AND REPLACE(REPLACE(driver_name,' ',''),'　','') = REPLACE(REPLACE(?,' ',''),'　','') GROUP BY d ORDER BY d DESC LIMIT 1"
  ).get(jstDate(-3), yst, u.display_name || '');
  if (al && al.c > 0) {
    const told = db.prepare("SELECT 1 AS x FROM aoi_greeting_log WHERE uid = ? AND topic = 'alert' AND rec_date > ?").get(uid, al.d);
    if (!told) {
      must.push({
        topic: 'alert', mood: 'caution',
        fact: `${al.d === yst ? '昨日' : '先日'}、運転アラート（速度・急操作など）が ${al.c}件 あった`,
        guide: '責めずに、今日は安全運転をはっきり促す。文末は必ず「安全運転で(を)」の方向でまとめる。単に「気をつけて」で終わらせない。'
      });
    }
  }
  if (kiko.fatigue_score != null && kiko.fatigue_score >= 6) {
    must.push({
      topic: 'fatigue', mood: 'concern',
      fact: `昨日の帰庫点呼での「つかれ度」は10段階で${kiko.fatigue_score}（ふだんの5より疲れ気味）`
        + (kiko.body_score != null ? `、「からだの調子」は${kiko.body_score}（5がふだん、大きいほど不調）` : ''),
      guide: '昨日の疲れを気づかい、今日は無理をしないよう優しく伝える。'
    });
  }

  // ③ お誕生日(今日) ※月日一致
  if (u.birth_date && String(u.birth_date).length >= 10 && String(u.birth_date).slice(5, 10) === today.slice(5, 10)) {
    must.push({
      topic: 'birthday', mood: 'greet',
      fact: '今日はこの人の誕生日',
      guide: 'さりげなくお祝いする。年齢には触れない。1文で短く、そのあと今日一日を気づかう。'
    });
  }

  // ④ 昨日の帰庫点呼が良好(つかれ5以下)＝ねぎらい
  if (kiko.fatigue_score != null && kiko.fatigue_score <= 5) {
    pool.push({
      topic: 'kiko_ok', mood: 'greet',
      fact: `昨日の帰庫点呼での「つかれ度」は${kiko.fatigue_score}（5がふだん通り。それ以下は楽・好調）で、昨日は無事に乗務を終えている`,
      guide: '昨日の調子の良さに触れ、今日も無理なくいきましょう、と前向きに。'
    });
  }

  // ⑤ 体調チェックの継続 (tenko_records = 朝の体調チェック)
  const ckDates = db.prepare(
    'SELECT DISTINCT rec_date FROM tenko_records WHERE target_id = ? AND rec_date >= ? ORDER BY rec_date DESC'
  ).all(uid, week).map((r) => r.rec_date);
  let streak = 0;
  for (let i = 0; i < 7; i++) { if (ckDates.indexOf(jstDate(-1 - i)) >= 0) streak++; else break; }
  if (streak >= 3) {
    pool.push({
      topic: 'check_streak', mood: 'greet',
      fact: `体調チェックを ${streak}日 続けて記録している`,
      guide: '続いていることをさりげなく認めて労う。褒めすぎず、健康の数値や結果には触れない。今日もどうぞ、と軽く。'
    });
  } else if (ckDates.length === 0) {
    pool.push({
      topic: 'check_invite', mood: 'greet',
      fact: 'この1週間、体調チェックの記録がない',
      guide: '責めたり急かしたりせず、「よかったら体調チェックもどうぞ」と軽く誘う。義務のように言わない。'
    });
  }

  // ⑥ 食事の記録(ひろば投稿)
  const meal = db.prepare(
    "SELECT COUNT(*) c FROM plaza_posts WHERE author_id = ? AND deleted_at IS NULL AND meal_type IS NOT NULL AND substr(datetime(created_at,'+9 hours'),1,10) >= ?"
  ).get(uid, week) || { c: 0 };
  if (meal.c >= 2) {
    pool.push({
      topic: 'meal', mood: 'greet',
      fact: `この1週間で食事の記録を ${meal.c}回 投稿している`,
      guide: '食事を記録していることに軽く触れて労う。カロリーや栄養の評価・指導はしない。'
    });
  }

  // ⑦ 自分の投稿に昨日ついた ♡ (匿名の投稿なので「誰から」は絶対に言わない)
  const rx = db.prepare(
    "SELECT COUNT(*) c FROM plaza_reactions r JOIN plaza_posts p ON p.id = r.post_id "
    + "WHERE p.author_id = ? AND r.user_id <> ? AND substr(datetime(r.created_at,'+9 hours'),1,10) = ?"
  ).get(uid, uid, yst) || { c: 0 };
  if (rx.c > 0) {
    pool.push({
      topic: 'reaction', mood: 'greet',
      fact: `昨日、この人のひろば投稿に「いいね(♡)」が ${rx.c}件 ついた`,
      guide: '反応があったことを嬉しく伝える。誰がつけたかは絶対に言わない(匿名のため)。'
    });
  }

  // ⑧ 天気(拠点別)。材料が無い日でも必ず何か言えるようにする常設の話題。
  const w = await fetchWeather(u.company_code);
  if (w) {
    const t = [];
    if (w.desc) t.push(String(w.desc));
    if (w.hi != null) t.push(`最高気温${w.hi}度`);
    if (w.lo != null) t.push(`最低気温${w.lo}度`);
    pool.push({
      topic: 'weather', mood: 'greet',
      fact: `今日の${w.place || 'この地域'}の天気は ${t.join('・')}`,
      guide: '天気にあわせた体調の気づかいを一言。暑ければ水分と休憩、雨なら足元と車間、寒ければ温かくして、など。天気予報の読み上げにならないように。'
    });
  }

  // ⑨ 季節・曜日(常設)
  const dow = ['日', '月', '火', '水', '木', '金', '土'][new Date(Date.now() + 9 * 3600 * 1000).getUTCDay()];
  const mon = Number(today.slice(5, 7));
  const season = mon <= 2 || mon === 12 ? '冬' : mon <= 5 ? '春' : mon <= 8 ? '夏' : '秋';
  pool.push({
    topic: 'season', mood: 'greet',
    fact: `今日は${mon}月の${dow}曜日（季節は${season}）`,
    guide: '季節や曜日の感じに合わせた、短いねぎらいと体調の気づかい。曜日の説明はしない。'
  });

  return { must, pool, driver: u.job_role === 'driver' };
}

// AIの出力が「ひとこと」として使えるかの検査。解説・複数案・見出しが混ざったものは捨てる。
function sane(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (t.length > 120) return false;
  if ((t.match(/\n/g) || []).length >= 2) return false;
  if (/[*#]|承知|以下に|ご提案|パターン|案[0-9０-９]|メッセージを(作成|生成)|状況別|---/.test(t)) return false;
  return true;
}

// ===== 一言を作る (テスト用にエクスポート) =====
async function buildGreeting(uid, opts) {
  const db = getDb();
  const today = jstDate(0);
  const force = !!(opts && opts.force);

  // 当日ぶんは保存済みのものを返す(共用タブレットで同じ日に何度もログインしても同じ挨拶)
  if (!force) {
    const cached = db.prepare('SELECT line, mood FROM aoi_greeting_log WHERE uid = ? AND rec_date = ?').get(uid, today);
    if (cached && cached.line) return { line: cached.line, mood: cached.mood || 'greet', cached: true };
  }

  const { must, pool } = await collectTopics(uid);
  // 直近5日に使った話題・言い回し(重複回避に使う)
  const hist = db.prepare(
    'SELECT topic, line FROM aoi_greeting_log WHERE uid = ? AND rec_date < ? ORDER BY rec_date DESC LIMIT 5'
  ).all(uid, today);
  const recent = new Set(hist.slice(0, 4).map((h) => h.topic));

  let pick = must[0];
  if (!pick) {
    let cands = pool.filter((c) => !recent.has(c.topic));
    if (!cands.length) cands = pool;
    if (!cands.length) return { line: '', mood: 'greet' };
    // uid と日付で決める = 人によって違い、日が変われば変わる(同じ日は何度でも同じ)
    pick = cands[(hashStr(uid) + jstDayNo()) % cands.length];
  }

  const avoid = hist.map((h) => h.line).filter(Boolean).slice(0, 3);
  // ⚠️プロンプトは「条件の列挙」だけにすると、モデルが状況別の"案"を並べた解説文を返すことがある
  //   (2026-07-27 検証で発生)。① 何を1つ作るのかを冒頭で言い切る ② 話題は1つだけ渡す
  //   ③ 出力形式を最後に強く縛る ④ それでも変な文が来たら sane() で弾いて定型文に落とす、の4段構え。
  const prompt =
    'あなたは運送会社の受付AI「葵」です。従業員がタブレットにログインした瞬間に、葵が声でかける「ひとこと」を1つだけ書いてください。\n\n'
    + `【今日の話題】${pick.fact}\n`
    + `【伝え方】${pick.guide}\n\n`
    + '【条件】\n'
    + '- 1〜2文、60文字程度まで。話し言葉のやさしい敬語。絵文字は使わない。\n'
    + '- 共感・いたわり・気づかいのみ。「頑張れ」「疲れて当然」は禁止。指導・説教・評価はしない。\n'
    + '- 名前や「おはようございます」「お疲れ様です」などの挨拶は書かない（挨拶はシステムが別に付ける）。\n'
    + '- 血圧・体重などの数値、病名、健康の結果、他人の情報は書かない（共用タブレットで音声で読み上げられるため）。\n'
    + (avoid.length ? `- 次の言い回しは最近使ったので、書き出しも語尾も変えること:\n  ・${avoid.join('\n  ・')}\n` : '')
    + '\n【出力】ひとことの本文だけを1つ。見出し・前置き・箇条書き・複数案・説明・かぎ括弧は禁止。';

  let line = '';
  try {
    const raw = (await generateText(prompt, { thinkingBudget: 0, temperature: 0.95, maxTokens: 200 }) || '').trim();
    if (sane(raw)) {
      line = raw.replace(/^["「『]+|["」』]+$/g, '').replace(/\s*\n+\s*/g, ' ');
      // 念のため、AIが付けた「○○さん、」や冒頭の挨拶を除去(挨拶はgreetNowが担う)
      line = line.replace(/^[^、。]{0,12}さん[、,]\s*/, '')
        .replace(/^(おはようございます|お疲れ様です|おつかれさまです|こんにちは)[。、]?\s*/g, '')
        .trim().slice(0, 160);
    }
  } catch (e) { line = ''; }

  // AI失敗時のフォールバック(話題ごと・日替わりで表現を変える)
  if (!line) {
    const FB = {
      alert: ['昨日は 運転アラートが ありましたね。今日は いつも以上に 安全運転で お願いしますね。', '昨日の アラート、気にしすぎず、今日は 車間と スピードに 気を配って 安全運転で いきましょう。'],
      fatigue: ['昨日は おつかれ気味でしたね。今日は 無理なく いきましょう。', '昨日の 疲れは 残っていませんか。今日は こまめに 休みながら いきましょう。'],
      birthday: ['お誕生日 おめでとうございます。今日が よい一日に なりますように。'],
      kiko_ok: ['昨日も 一日 おつかれさまでした。今日も 無理なく いきましょう。', '昨日は 調子が よさそうでしたね。今日も その調子で いきましょう。'],
      check_streak: ['体調チェック、続いていますね。今日も 無理なく いきましょう。', '毎日の 記録、ありがとうございます。今日も ご自愛くださいね。'],
      check_invite: ['よかったら 体調チェックも どうぞ。今日も 無理なく いきましょう。'],
      meal: ['食事の記録、続いていますね。今日も 無理なく いきましょう。'],
      reaction: ['昨日の 投稿に いいねが ついていましたよ。今日も 無理なく いきましょう。'],
      weather: ['今日も 体調に 気を配って、無理なく いきましょう。'],
      season: ['今日も 無理なく いきましょう。水分も こまめに どうぞ。']
    };
    const arr = FB[pick.topic] || FB.season;
    line = arr[(hashStr(uid) + jstDayNo()) % arr.length];
  }

  const mood = pick.mood || 'greet';
  try {
    // ⚠️INSERT OR REPLACE は visits/last_at を消してしまうので UPSERT で本文だけ更新する
    db.prepare(`INSERT INTO aoi_greeting_log (uid, rec_date, topic, mood, line) VALUES (?,?,?,?,?)
      ON CONFLICT(uid, rec_date) DO UPDATE SET topic = excluded.topic, mood = excluded.mood, line = excluded.line`)
      .run(uid, today, pick.topic, mood, line);
  } catch (e) { console.warn('[aoi] log', e.message); }
  return { line, mood, topic: pick.topic };
}

router.get('/greeting', authUser, async (req, res) => {
  let visit = 1;
  try { visit = touchVisit(req.uid, jstDate(0)); } catch (e) { console.warn('[aoi visit]', e.message); }
  // 予定はAIの一言とは別枠。2回目以降のログインでも今日の残りは知らせたいので毎回返す。
  let schedule = { today: { count: 0, text: '', say: '' }, tomorrow: { count: 0, text: '', say: '' } };
  try {
    const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {};
    const surname = String(u.display_name || '').split(/[\s　]/)[0] || '';
    schedule = collectSchedule(req.uid, surname);
  } catch (e) { console.warn('[aoi schedule]', e.message); }
  try {
    // 2回目以降は本文をクライアントが短く組み立てる(AI生成は初回ぶんだけ=無駄打ちしない)
    if (visit >= 2) return res.json({ line: '', mood: 'greet', visit, schedule });
    const out = await buildGreeting(req.uid);
    res.json({ line: out.line || '', mood: out.mood || 'greet', visit, schedule });
  } catch (e) {
    console.warn('[aoi greeting]', e.message);
    res.json({ line: '', mood: 'greet', visit, schedule });
  }
});

module.exports = router;
module.exports.buildGreeting = buildGreeting;   // 動作確認スクリプト用
module.exports.collectSchedule = collectSchedule;
