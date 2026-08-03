// ============================================================
// 朝の健康チェック 日次サマリーの自動集計・配信 (2026-07-31)
//  社長指示「朝の健康状態のチェック状態を毎日集計して配信」。
//  ・毎朝 SEND_HOUR時(JST)に当日分を集計し、🏥健康管理室ディスカッションへ
//    「健康推進室(bot_wellness_office)」名義で投稿する。
//  ・数字の土俵は健康点検ボード(GET /api/tenko/board)と完全に同じ。
//    実施判定 isCheckDone / 対象者(roster)の定義はこのファイルを唯一の実装とし、
//    routes/tenko.js からも同じ関数を使う(二重定義で数字がズレるのを防ぐ)。
//  ・⚠️個人名は出さない(健康情報)。要フォロー者は件数だけ出し、氏名は
//    権限のある健康点検ボードで見てもらう。[[feedback_health_feed_deidentify]]
//  ・月曜は 2026-07-28 に本文で予告した「前週(平日5日)のまとめ」も併せて配信する
//    (これまで手動配信だった週次レポートの自動化)。
// ============================================================
const { getDb } = require('./db');

const SENDER_ID = 'bot_wellness_office';            // 健康推進室 (role=bot・実施率の分母には入らない)
const DEFAULT_GROUPS = ['g_wellness_disc'];         // 🏥 健康管理室ディスカッション
const DEFAULT_HOUR = 10;                            // 配信時刻(JST) — 朝礼・点呼が一巡した頃
const LAST_KEY = 'health_daily_report_last';        // 最後に配信したJST日付 (冪等キー)
const HOUR_KEY = 'health_daily_report_hour';        // 配信時刻の上書き (app_settings)
const GROUP_KEY = 'health_daily_report_groups';     // 配信先グループidの上書き (カンマ区切り)
const BOARD_URL = 'https://cohub.biz-terrace.org/health-check-board.html';

// ---------- 日付ヘルパ (すべてJST基準) ----------
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const jstDate = () => jstNow().toISOString().slice(0, 10);
const jstHour = () => jstNow().getUTCHours();
const WD = ['日', '月', '火', '水', '木', '金', '土'];
function dayOfWeek(ymd) { return new Date(ymd + 'T00:00:00Z').getUTCDay(); }
function isWeekday(ymd) { const w = dayOfWeek(ymd); return w >= 1 && w <= 5; }
function ymdShift(ymd, days) {
  const t = new Date(ymd + 'T00:00:00Z').getTime() + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function mdLabel(ymd) {
  return `${parseInt(ymd.slice(5, 7), 10)}月${parseInt(ymd.slice(8, 10), 10)}日(${WD[dayOfWeek(ymd)]})`;
}
function mdShort(ymd) {
  return `${parseInt(ymd.slice(5, 7), 10)}/${parseInt(ymd.slice(8, 10), 10)}(${WD[dayOfWeek(ymd)]})`;
}

// ---------- 設定 (app_settings で運用中に変更可) ----------
function setting(key) {
  try {
    const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row && row.value != null ? String(row.value).trim() : '';
  } catch (e) { return ''; }
}
function putSetting(key, value) {
  try {
    getDb().prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
  } catch (e) { console.warn('[health-daily] setting save fail', key, e.message); }
}
function sendHour() { const h = parseInt(setting(HOUR_KEY), 10); return (h >= 0 && h <= 23) ? h : DEFAULT_HOUR; }
function targetGroups() {
  const s = setting(GROUP_KEY);
  const list = s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
  return list.length ? list : DEFAULT_GROUPS;
}

// ---------- 実施判定 (健康点検ボードと共通の唯一の定義) ----------
// 点呼(運管・倉庫)は記録があれば実施。セルフは health_json か condition が入って初めて実施。
// (血圧だけの自己記録は「体調チェック未実施」)
function isCheckDone(r) {
  if (!r) return false;
  if (r.mode && r.mode !== 'self') return true;
  const hj = (r.health_json == null) ? '' : String(r.health_json).trim();
  const hasHealth = hj !== '' && hj !== 'null' && hj !== '{}';
  const hasCond = r.condition != null && String(r.condition).trim() !== '';
  return hasHealth || hasCond;
}

// 対象者(分母): bot・ゲストレビュアーを除く全社員。ボードの roster と同一条件。
// ⚠️ボードとの唯一の違い: 動作確認用アカウント(company_code='TEST')だけは配信文から外す
//   (実在しない人が「拠点0%」として毎朝並ぶのを避けるため。差は1名)。
const ROSTER_SQL = `SELECT id, display_name, company_code FROM users
  WHERE COALESCE(role,'')<>'bot' AND COALESCE(employee_type,'')<>'bot'
    AND id NOT LIKE 'bot_%' AND COALESCE(is_guest_reviewer,0)=0
    AND COALESCE(company_code,'')<>'TEST'`;

function loadRoster(db) { return db.prepare(ROSTER_SQL).all(); }

// 拠点コード → 表示名 (companies マスタ。無ければコードのまま)
function companyNames(db) {
  const map = {};
  try { db.prepare('SELECT code, name FROM companies').all().forEach(c => { map[c.code] = c.name; }); } catch (e) {}
  return map;
}

// ---------- 1日分の集計 ----------
// 「気になる回答」の判定。8項目のうち、値が下記に該当したら1件と数える。
const FLAGS = [
  { key: 'breakfast', label: '🍚 朝食を食べていない', hit: v => v === 'no' },
  { key: 'sleep6h', label: '🛌 睡眠6時間未満', hit: v => v === 'no' },
  { key: 'three_meals', label: '🍽️ 3食食べていない', hit: v => v === 'no' },
  { key: 'hydration', label: '💧 水分補給できていない', hit: v => v === 'no' },
  { key: 'wakeup', label: '🌅 目覚めがすっきりしない', hit: v => v === 'no' },
  { key: 'facial_color', label: '🌡️ 顔色が良くない', hit: v => v === 'tired' || v === 'red' || v === 'pale' },
  { key: 'pain', label: '🦴 体の痛みあり', hit: v => !!v && v !== 'no' },
  { key: 'concern', label: '💭 気になることあり', hit: v => !!v && v !== 'no' },
];

// ---------- 全項目の内訳 (2026-08-03 帝京大 西村さんの依頼) ----------
//  「こまめな水分補給の実施率は毎回」「可能なら全項目の結果も」。
//  ⚠️該当者が0人でも省略しない=毎回同じ8項目が同じ順で並ぶようにする(推移を追えるようにするため)。
//  ⚠️個人名は出さない方針は従来どおり。出すのは人数と割合、痛み等は部位の内訳まで。
const YESNO_ITEMS = [
  { key: 'hydration',   label: '💧 こまめに水分補給' },
  { key: 'breakfast',   label: '🍚 朝食を食べた' },
  { key: 'three_meals', label: '🍽️ 3食きちんと食べた' },
  { key: 'sleep6h',     label: '🛌 6時間以上寝た' },
  { key: 'wakeup',      label: '🌅 朝の目覚めスッキリ' },
];
const BREAKDOWN_ITEMS = [
  { key: 'facial_color', label: '🌡️ 顔色', ok: ['normal', 'unknown'],
    v: { tired: '疲れ気味', red: '赤い', pale: '青白い' } },
  { key: 'pain', label: '🦴 体の痛み', ok: ['no'],
    v: { low_back: '腰', shoulder: '肩・首', joint: '関節', severe: '強い痛み' } },
  { key: 'concern', label: '💭 気になること', ok: ['no'],
    v: { health: '体調', family: '家族', work: '職場', money: 'お金', other: 'その他' } },
];

function statsFor(db, date, roster) {
  const recs = db.prepare('SELECT * FROM tenko_records WHERE rec_date = ?').all(date);
  const byTarget = {}; recs.forEach(r => { byTarget[r.target_id] = r; });
  const byCo = {};
  roster.forEach(m => {
    const co = m.company_code || '(未設定)';
    byCo[co] = byCo[co] || { total: 0, done: 0 };
    byCo[co].total++;
  });
  let done = 0, uMid = 0, uHigh = 0, bpHigh = 0;
  const flags = {}; FLAGS.forEach(f => { flags[f.key] = 0; });
  const items = {};   // key → { 回答値: 人数 } (全項目の内訳)
  roster.forEach(m => {
    const r = byTarget[m.id];
    if (!isCheckDone(r)) return;
    done++;
    const co = m.company_code || '(未設定)';
    byCo[co].done++;
    if (r.urgency === '高') uHigh++; else if (r.urgency === '中') uMid++;
    if ((r.bp_systolic && r.bp_systolic >= 160) || (r.bp_diastolic && r.bp_diastolic >= 100)) bpHigh++;
    let h = {}; try { h = JSON.parse(r.health_json || '{}') || {}; } catch (e) {}
    FLAGS.forEach(f => { if (f.hit(h[f.key])) flags[f.key]++; });
    [...YESNO_ITEMS, ...BREAKDOWN_ITEMS].forEach(it => {
      const v = h[it.key];
      if (v == null || v === '') return;             // 未回答は分母に入れない
      items[it.key] = items[it.key] || {};
      items[it.key][v] = (items[it.key][v] || 0) + 1;
    });
  });
  const total = roster.length;
  // 当日の体調記録のうち、まだ誰も声かけ・対応をしていない件数 (tenko-manage の未確認キューと同じ土俵)
  let unhandled = 0;
  try {
    unhandled = (db.prepare(`SELECT COUNT(*) AS n FROM wellness_posts w
      JOIN tenko_records t ON t.wellness_post_id = w.id
      WHERE t.rec_date = ? AND COALESCE(w.ack_status,'未対応') = '未対応'`).get(date) || {}).n || 0;
  } catch (e) {}
  return { date, total, done, rate: total ? done * 100 / total : 0, uMid, uHigh, bpHigh, unhandled, flags, items, byCo };
}

// 直近 lookback 日の平日だけの平均実施率 (土日は運行が少なく実施が激減するため除外)
function weekdayAverage(db, date, lookback, roster) {
  const days = [];
  for (let i = 1; i <= lookback; i++) {
    const d = ymdShift(date, -i);
    if (isWeekday(d)) days.push(d);
  }
  if (!days.length) return null;
  const rates = days.map(d => statsFor(db, d, roster).rate);
  return { days: days.length, rate: rates.reduce((a, b) => a + b, 0) / rates.length };
}

// 直前の営業日(平日)
function prevWeekday(date) {
  let d = ymdShift(date, -1);
  for (let i = 0; i < 7 && !isWeekday(d); i++) d = ymdShift(d, -1);
  return d;
}

const pct = n => Math.round(n) + '%';

// ---------- 本文の組み立て ----------
function buildReport(dateOpt) {
  const db = getDb();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateOpt || '') ? dateOpt : jstDate();
  const roster = loadRoster(db);
  const s = statsFor(db, date, roster);
  const names = companyNames(db);
  const L = [];

  L.push('🏥 朝の健康チェック 日次サマリー');
  // 「◯時点」は集計を実行した実時刻 (自動配信=既定10:00 / 手動プレビュー=その時刻)
  const nowHM = date === jstDate()
    ? `${String(jstNow().getUTCHours()).padStart(2, '0')}:${String(jstNow().getUTCMinutes()).padStart(2, '0')}時点`
    : '終日集計';
  L.push(`📅 ${mdLabel(date)} ${nowHM}`);
  L.push('');
  L.push('【実施状況】');
  L.push(`実施 ${s.done}名 / 対象 ${s.total}名 (${pct(s.rate)})`);
  const pw = prevWeekday(date);
  const pwS = statsFor(db, pw, roster);
  const avg = weekdayAverage(db, date, 14, roster);
  const cmp = [`前営業日 ${mdShort(pw)} ${pwS.done}名 ${pct(pwS.rate)}`];
  if (avg) cmp.push(`直近平日${avg.days}日平均 ${pct(avg.rate)}`);
  L.push('　' + cmp.join(' ／ '));
  if (!isWeekday(date)) L.push('　※土日は運行が少ないため参考値です');

  // 要フォロー (件数のみ・氏名は出さない)
  L.push('');
  L.push('【要フォロー】');
  if (s.uHigh || s.uMid || s.bpHigh) {
    if (s.uHigh) L.push(`　🔴 緊急度「高」${s.uHigh}名`);
    if (s.uMid) L.push(`　🟡 緊急度「中」${s.uMid}名`);
    if (s.bpHigh) L.push(`　🩸 血圧160/100以上 ${s.bpHigh}名`);
    L.push(`　📌 このうち まだ声かけ・対応の記録がない人 ${s.unhandled}名`);
    L.push('　→ 対象者の氏名は健康点検ボードでご確認のうえ、声かけ・対応をお願いします');
    L.push('　　 ' + BOARD_URL);
  } else {
    L.push('　なし (緊急度「中」「高」・高血圧の該当者はいません)');
  }

  // 実施者の回答 — 全8項目を毎回同じ順で (2026-08-03 西村さん依頼)
  if (s.done) {
    L.push('');
    L.push(`【実施者${s.done}名の回答】できている率`);
    YESNO_ITEMS.forEach(it => {
      const c = s.items[it.key] || {};
      const yes = c.yes || 0, ans = yes + (c.no || 0);
      L.push(ans ? `　${it.label} ${pct(yes * 100 / ans)} (${yes}/${ans}名)` : `　${it.label} 回答なし`);
    });
    L.push('　－ 以下は「該当した人」－');
    BREAKDOWN_ITEMS.forEach(it => {
      const c = s.items[it.key] || {};
      const ans = Object.values(c).reduce((a, b) => a + b, 0);
      if (!ans) { L.push(`　${it.label} 回答なし`); return; }
      const hit = Object.entries(c).filter(([v]) => it.ok.indexOf(v) < 0);
      const n = hit.reduce((a, [, v]) => a + v, 0);
      if (!n) { L.push(`　${it.label} なし (0/${ans}名)`); return; }
      const uchi = hit.sort((a, b) => b[1] - a[1]).map(([v, c2]) => `${it.v[v] || v}${c2}`).join('・');
      L.push(`　${it.label} ${n}名 (${pct(n * 100 / ans)}) — ${uchi}`);
    });
  }

  // 拠点別
  const cos = Object.entries(s.byCo).map(([code, v]) => ({
    code, name: names[code] || code, total: v.total, done: v.done,
    rate: v.total ? v.done * 100 / v.total : 0,
  })).filter(c => c.total > 0).sort((a, b) => b.rate - a.rate);
  L.push('');
  L.push('【拠点別 実施率】');
  cos.forEach(c => {
    const mark = c.rate >= 80 ? '🟢' : (c.rate >= 50 ? '🟡' : '🔴');
    L.push(`　${mark} ${c.name} ${pct(c.rate)} (${c.done}/${c.total})`);
  });
  const low = cos.filter(c => c.rate < 50 && c.total >= 3);
  if (low.length) L.push(`　⚠️ 未実施が多い拠点: ${low.map(c => c.name).join('・')} — 朝の声かけをお願いします`);

  // 月曜は前週(平日5日)のまとめも (2026-07-28に本文で予告した週次レポート)
  if (dayOfWeek(date) === 1) {
    const wk = [];
    for (let i = 7; i >= 3; i--) { const d = ymdShift(date, -i); if (isWeekday(d)) wk.push(d); }
    if (wk.length) {
      const per = wk.map(d => statsFor(db, d, roster));
      const wRate = per.reduce((a, x) => a + x.rate, 0) / per.length;
      const wDone = per.reduce((a, x) => a + x.done, 0) / per.length;
      L.push('');
      L.push(`📊 【前週のまとめ】${mdLabel(wk[0])}〜${mdLabel(wk[wk.length - 1])} (平日${wk.length}日)`);
      L.push(`　全社平均 ${pct(wRate)} (平日平均 ${Math.round(wDone * 10) / 10}名 / ${s.total}名)`);
      const coAvg = {};
      per.forEach(p => Object.entries(p.byCo).forEach(([code, v]) => {
        coAvg[code] = coAvg[code] || { sum: 0, n: 0, total: v.total };
        coAvg[code].sum += v.total ? v.done * 100 / v.total : 0; coAvg[code].n++;
      }));
      const ranked = Object.entries(coAvg).map(([code, v]) => ({
        name: names[code] || code, total: v.total, rate: v.n ? v.sum / v.n : 0,
      })).filter(c => c.total > 0).sort((a, b) => b.rate - a.rate);
      if (ranked.length) {
        L.push('　良い拠点: ' + ranked.slice(0, 3).map(c => `${c.name} ${pct(c.rate)}`).join(' / '));
        L.push('　課題の拠点: ' + ranked.slice(-3).reverse().map(c => `${c.name} ${pct(c.rate)}`).join(' / '));
      }
    }
  }

  L.push('');
  L.push('※このサマリーは毎朝自動配信しています。個人の実施状況・体調は健康点検ボードでご確認ください。');
  return { date, text: L.join('\n'), stats: s };
}

// ---------- 配信 ----------
// グループチャットへ「健康推進室」名義で投稿する。DB直INSERTだけだと未読/Push/リアルタイムが
// 動かないので、chat:group ハンドラと同じ手順(INSERT → group:msg → sendPushToUser)を踏む。
function postToGroup(locals, groupId, content) {
  const db = getDb();
  const roomCode = 'grp_' + groupId;
  const dup = db.prepare(`SELECT id FROM messages WHERE sender_id=? AND room_code=? AND content=?
    AND created_at > datetime('now','-6 hours') ORDER BY id DESC LIMIT 1`).get(SENDER_ID, roomCode, content);
  if (dup) { console.log('[health-daily] duplicate skipped', groupId, dup.id); return null; }
  const ins = db.prepare(`INSERT INTO messages (sender_id, receiver_id, content, room_code)
    VALUES (?, NULL, ?, ?)`).run(SENDER_ID, content, roomCode);
  const sender = db.prepare(`SELECT u.display_name, u.avatar_url, u.company_code, c.ring_color
    FROM users u LEFT JOIN companies c ON c.code = u.company_code WHERE u.id = ?`).get(SENDER_ID) || {};
  const payload = {
    id: ins.lastInsertRowid, from: SENDER_ID, group_id: groupId, content,
    at: new Date().toISOString(), attach: null,
    sender_name: sender.display_name || '健康推進室', sender_avatar: sender.avatar_url || '',
    sender_company: sender.company_code || '', sender_ring: sender.ring_color || '',
  };
  try { if (locals && locals.emitToGroupMembers) locals.emitToGroupMembers(groupId, 'group:msg', payload); } catch (e) {}
  const groupName = (db.prepare('SELECT name FROM chat_groups WHERE id = ?').get(groupId) || {}).name || 'グループ';
  if (locals && locals.sendPushToUser) {
    db.prepare('SELECT user_id FROM chat_group_members WHERE group_id = ?').all(groupId).forEach(m => {
      locals.sendPushToUser(m.user_id, {
        title: '[' + groupName + '] ' + (sender.display_name || '健康推進室'),
        body: '朝の健康チェック 日次サマリー', tag: 'health-daily', url: '/?g=' + groupId,
      }).catch(() => {});
    });
  }
  return ins.lastInsertRowid;
}

// 当日分を集計して配信。force=true なら未配信フラグに関係なく送る(手動配信/再送用)。
function sendDaily(locals, opts) {
  const o = opts || {};
  const r = buildReport(o.date);
  const ids = [];
  for (const gid of targetGroups()) {
    const id = postToGroup(locals, gid, r.text);
    if (id) ids.push({ group_id: gid, message_id: id });
  }
  if (!o.date || o.date === jstDate()) putSetting(LAST_KEY, r.date);
  console.log('[health-daily] sent', r.date, JSON.stringify(ids));
  return { date: r.date, sent: ids, text: r.text, stats: r.stats };
}

// 定期tick (index.jsから10分間隔で呼ぶ)。JSTで配信時刻を過ぎていて、その日まだ未配信なら送る。
let _running = false;
function tick(locals) {
  if (_running) return;
  _running = true;
  try {
    const today = jstDate();
    if (setting(LAST_KEY) === today) return;      // 今日は配信済み
    if (jstHour() < sendHour()) return;           // まだ配信時刻前
    sendDaily(locals, {});
  } catch (e) {
    console.warn('[health-daily] tick fail', e.message);
  } finally { _running = false; }
}

module.exports = {
  isCheckDone, buildReport, sendDaily, tick,
  jstDate, sendHour, targetGroups, lastSent: () => setting(LAST_KEY),
};
