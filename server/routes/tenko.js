const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
// 通達の配信対象判定は announcements.js を唯一の実装とする (自前複製をやめた・2026-07-30)
const { userMatchesTarget } = require('./announcements');

// 帰庫点呼(乗務後・ドライバー自己申告の補助ツール)テーブルの自己修復
try {
  getDb().exec(`CREATE TABLE IF NOT EXISTS tenko_kiko (
    id INTEGER PRIMARY KEY AUTOINCREMENT, rec_date TEXT NOT NULL, driver_id TEXT NOT NULL, driver_name TEXT,
    company_code TEXT, kiko_at TEXT, alcohol_used INTEGER DEFAULT 1, alcohol_detected INTEGER DEFAULT 0,
    operation_issue INTEGER DEFAULT 0, operation_note TEXT, relief_note TEXT, note TEXT, wellness_post_id INTEGER,
    approved_by TEXT, approved_by_name TEXT, approved_at TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE INDEX IF NOT EXISTS idx_kiko_day ON tenko_kiko(rec_date, company_code);`);
} catch (e) { console.warn('[tenko_kiko ensure]', e.message); }
// 乗務後の体調・疲労(fatigue_level: fine/tired/very_tired)を後付け(既存テーブルにも追加)
try { getDb().exec("ALTER TABLE tenko_kiko ADD COLUMN fatigue_level TEXT"); } catch (e) {}
// KPI用の0〜10自己評価(fatigue_score=つかれ / body_score=からだ。いずれも10=しんどい)
try { getDb().exec("ALTER TABLE tenko_kiko ADD COLUMN fatigue_score INTEGER"); } catch (e) {}
try { getDb().exec("ALTER TABLE tenko_kiko ADD COLUMN body_score INTEGER"); } catch (e) {}
// 2026-07-27: 「交替運転者への連絡」(2運行なし=不要)を廃止し、代わりに以下を聞く。
//  hiyari      = 今日のヒヤリハット(0/1)・hiyari_note = その場面 → 安全会議/労働安全の材料
//  wait_level  = 荷待ち・荷役の時間(none / lt60 / gt60)・wait_note = 荷主・現場名
//                → 改正貨物法24条の6(2028-06 荷待ち時間等の記録義務化)の下準備＋運賃交渉の実データ
// ⚠️relief_note は過去データが入っているため列は残す(新規には書かない)。
try { getDb().exec("ALTER TABLE tenko_kiko ADD COLUMN hiyari INTEGER DEFAULT 0"); } catch (e) {}
try { getDb().exec("ALTER TABLE tenko_kiko ADD COLUMN hiyari_note TEXT"); } catch (e) {}
try { getDb().exec("ALTER TABLE tenko_kiko ADD COLUMN wait_level TEXT"); } catch (e) {}
try { getDb().exec("ALTER TABLE tenko_kiko ADD COLUMN wait_note TEXT"); } catch (e) {}
// 2026-07-27: 帰宅前の健康状態把握を全職種へ。job_kind=driver/warehouse/manufacturing/office。
// 職種固有の回答(腰痛・作業中の体調異変・時間外・目肩腰・こころ)は extra_json にJSONで保持。
// ⚠️つかれ/からだ(fatigue_score/body_score)は全職種で同じ列＝KPI・平常値・エスカレを共通化する。
try { getDb().exec("ALTER TABLE tenko_kiko ADD COLUMN job_kind TEXT"); } catch (e) {}
try { getDb().exec("ALTER TABLE tenko_kiko ADD COLUMN extra_json TEXT"); } catch (e) {}
// 🔴高リスク者への対応時に点呼者が記録する「声かけ・処置内容」メモ
try { getDb().exec("ALTER TABLE wellness_posts ADD COLUMN ack_note TEXT"); } catch (e) {}
// 2026-08-03: 乗務ゲートの「15分安静後の再測1回」を扱うための当日値。
//  bp_peak_sys/dia = その日に出た最も悪い値 (再測で下がっても「一度出た事実」を消さない)
//  bp_count        = その日に血圧を記録した回数 (再測は1回まで=2回目で判断確定)
try { getDb().exec("ALTER TABLE tenko_records ADD COLUMN bp_peak_sys INTEGER"); } catch (e) {}
try { getDb().exec("ALTER TABLE tenko_records ADD COLUMN bp_peak_dia INTEGER"); } catch (e) {}
try { getDb().exec("ALTER TABLE tenko_records ADD COLUMN bp_count INTEGER DEFAULT 0"); } catch (e) {}

const FIELD_VOICE_GROUP = 'g_field_voice';
// JST(+9h)基準の当日 YYYY-MM-DD
const jstDate = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
// SQLite datetime('now')(UTC)を JST の HH:MM に変換(実施時刻の表示用)
const jstHM = (utc) => {
  if (!utc) return '';
  try {
    const t = new Date(String(utc).replace(' ', 'T') + 'Z').getTime();
    return Number.isFinite(t) ? new Date(t + 9 * 3600 * 1000).toISOString().slice(11, 16) : '';
  } catch (e) { return ''; }
};
// YYYY-MM-DD から n日前の YYYY-MM-DD
const ymdMinus = (ymd, n) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
};

function getOperator(uid) {
  return getDb().prepare(
    `SELECT id, display_name, company_code, employee_type, job_role,
            is_field_promoter, is_warehouse_promoter, is_tenko_operator,
            is_ops_manager, is_branch_head, is_guest_reviewer
     FROM users WHERE id = ?`
  ).get(uid);
}
// 点呼者/管理者か (予め選出: フラグ or 管理職 or manager or 推進 or 運行管理者 or 所長副所長)
// ⚠️社外ゲスト(研究閲覧)もここを通す。書き込みは middleware/authz.js の研究閲覧モードが
//   全APIまとめて403にするので、ここで通るのは参照だけ。氏名も同層で匿名化される。
function isOperator(u) {
  return !!(u && (u.is_tenko_operator || u.employee_type === 'admin' || u.job_role === 'manager'
    || u.is_field_promoter || u.is_warehouse_promoter || u.is_ops_manager || u.is_branch_head
    || u.is_guest_reviewer));
}

// 2026-07-21 追加: 他拠点のデータを閲覧/更新できてしまう穴を塞ぐための共通判定。
// 全拠点を横断できるのは本社admin・推進メンバーのみ。それ以外は自拠点に固定する。
function canCrossCompany(u) {
  return !!(u && (u.employee_type === 'admin' || u.is_field_promoter || u.is_warehouse_promoter
    || u.is_guest_reviewer));   // 研究閲覧は全拠点を横断(参照のみ・氏名は匿名)
}
// クライアント指定の company を検証し、権限が無ければ自拠点へ強制的に読み替える
function scopedCompany(u, requested) {
  const req = String(requested || '').trim();
  const own = String((u && u.company_code) || '').trim();
  if (!req) return own;
  if (canCrossCompany(u) || req === own) return req;
  return own;
}

// 体調回答の重み付け (点呼)。wellness聞き取りカード(8項目)と整合する severity 0/1/2 方式。
// 投票決定5項目(hydration/breakfast/three_meals/sleep6h/wakeup=Yes/No)はセルフ点検でurgency非加算(s=0)。
const SEV = {
  facial_color: { normal: 0, tired: 1, red: 2, pale: 2, unknown: 0 },
  pain:         { no: 0, low_back: 1, shoulder: 1, joint: 1, severe: 2 },
  // 「気になる(concern)」は psychosocial(仕事/家族/お金の悩み等)で医療的な緊急度と毛色が違うため、
  // urgency には一切加算しない(全て0)。記録は health_json に残りボードの集計(tally)で把握する。
  // (2026-06-30 方針B: 取締役が毎日「職場」を選び work:2 で毎日🔴高Pushされていた誤判定を是正)
  concern:      { no: 0, health: 0, family: 0, work: 0, money: 0, other: 0 },
};
// 血圧の重み (管理者記入)。160/100以上=高(運行要注意), 140/90以上=中
function bpSeverity(sys, dia) {
  if ((sys && sys >= 160) || (dia && dia >= 100)) return 2;
  if ((sys && sys >= 140) || (dia && dia >= 90)) return 1;
  return 0;
}

// ============================================================
// 乗務ゲート (2026-08-03 社長判断)
//  点呼・自己チェックで測った血圧から「当日の乗務可否」の目安フラグを立てる。
//  数値は日本高血圧学会の分類に合わせる (Ⅲ度=180/110以上・Ⅱ度=160/100以上)。
//    3 stop    : 収縮期180以上 or 拡張期110以上 → 当日の乗務は見合わせ・受診勧奨
//    2 recheck : 収縮期160以上 or 拡張期100以上 → 15分安静後に再測。再測でも超過なら長距離・夜間から外す
//    1 watch   : 収縮期140以上 or 拡張期 90以上 → 経過観察
//  ⚠️自覚症状(体調=悪い / 強い痛み)は数値にかかわらず stop 扱い。
//  ⚠️これは運行管理者の判断を支援する「表示フラグ」であり、システムが乗務を自動的に止めるものではない。
//    実際の乗務可否・乗務禁止の登録は従来どおり driver_guidance(指導・乗務禁止)で行う。
//  ⚠️ドライバー以外にも数値の判定は返すが、乗務に関する文言(action)は出さない。
// ============================================================
// 2026-08-03 追記: 1回の数値で決め打たない。数値によるものは「15分安静後の再測1回」を挟む。
//  ⚠️ただし再測で下がっても、その日に一度出た事実は消さない(bp_peak_*)＝長距離・夜間からは外す。
//  ⚠️再測は1回まで(bp_count>=2で確定)。低い値が出るまで測り直すのは判断ではなく数字合わせ。
//  ⚠️自覚症状(体調不良の申告・強い痛み)は再測の対象外＝即 stop。症状は測り直しても消えない。
const GATE_STATUS = {
  symptom_check: { pill: '🔶要確認',    action: '本人に状況を確認し、乗務の可否を判断してください。確認するまで乗務させないでください。確認した内容は対応記録に残してください。' },
  stop_final:   { pill: '🚫乗務不可',   action: '本日の乗務は見合わせてください。必要に応じて受診を勧めてください。' },
  stop_recheck: { pill: '🚫要再測',     action: '15分安静にしてから、1回だけ再測してください。再測でも 180/110 以上なら本日の乗務は見合わせてください。' },
  restrict:     { pill: '⚠️長距離・夜間NG', action: '本日は長距離・夜間の乗務から外してください（この日一度、基準を大きく超えた記録があります）。' },
  recheck:      { pill: '⚠️要再測',     action: '15分安静にしてから再測してください。再測でも超えている場合は長距離・夜間の乗務から外してください。' },
  watch:        { pill: '注意',         action: '数値が高めです。体調をひとこと確認してください。' },
  ok:           { pill: '',             action: '' },
};
function bpGateLevel(sys, dia) {
  if ((sys && sys >= 180) || (dia && dia >= 110)) return 3;
  if ((sys && sys >= 160) || (dia && dia >= 100)) return 2;
  if ((sys && sys >= 140) || (dia && dia >= 90)) return 1;
  return 0;
}
// 症状の扱い (2026-08-03 見直し)
//  ⚠️血圧180/110は客観的な数値なので機械が判定できる。一方「強い痛み」「体調が悪い」は本人の
//    主観申告で、部位も程度も分からない。これを同じ🚫にすると運行管理者に「痛いと言われたら
//    必ず乗務不可」を強いることになり、実務に合わず、やがて申告されなくなる。
//    (2026-08-03 宮内さんの例=慢性腰痛がベースにあり、severe は年数回の悪化サイン)
//    → 症状は原則 🔶要確認(運管が本人に確認して判断)。運転中の意識障害に直結するものだけ 🚫。
//  ⚠️⚠️聞くのは「症状の中身」ではなく「乗務への影響」。病名・診断・治療内容は聞かない・持たない。
//    部位を聞くのは、胸/頭(急性の循環器・神経症状の可能性)を拾うために必要な最小限だから。
//    「答えたくない」(skip)を選べる。選んでも不利益にはせず、🔶要確認として運管が口頭で確かめる。
const HARD_PAIN_SITE = { chest: '胸', head: '頭' };
function symptomAssess(health, condition) {
  const h = health || {};
  const hard = [], check = [];
  if (h.pain === 'severe') {
    if (HARD_PAIN_SITE[h.pain_site]) hard.push('強い痛み（' + HARD_PAIN_SITE[h.pain_site] + '）');
    else if (h.pain_drive === 'yes') hard.push('強い痛み（運転に支障あり）');
    else check.push('強い痛み');
  }
  // 2026-08-03: 「今日の仕事」= 本人の意思表示。症状を聞かずに手を挙げられる導線。
  //  ⚠️健康情報ではなく本人の申し出なので、プライバシー上いちばん安全でいちばん確実な信号。
  //  本人が「今日は難しい」と言っているのに乗せるのは事業者として通らない → hard。
  if (h.duty_intent === 'stop') hard.push('本人から「今日は難しい」との申し出');
  else if (h.duty_intent === 'consult') check.push('本人から相談の申し出');
  if (condition === 'bad') check.push('体調不良の申告');   // 旧項目(後方互換)
  return { hard: hard.length ? hard : null, check: check.length ? check : null };
}
// opts = { peakSys, peakDia, count }  当日の最悪値と測定回数 (tenko_records の bp_peak_*/bp_count)
function dutyGate(jobRole, sys, dia, health, condition, opts) {
  opts = opts || {};
  const isDriver = jobRole === 'driver';
  const count = opts.count || 0;
  const level = bpGateLevel(sys, dia);                     // 数値だけのレベル(症状は加えない)
  const reasons = [];
  if (level >= 1) reasons.push(`血圧 ${sys || '-'}/${dia || '-'}`);
  const sym = symptomAssess(health, condition);
  if (sym.hard) reasons.push(...sym.hard);
  if (sym.check) reasons.push(...sym.check);
  // その日の最悪レベル。再測で下がっても一度出た事実は残す。⚠️症状ではピークを上げない。
  const peakLevel = Math.max(level, bpGateLevel(opts.peakSys, opts.peakDia));

  let status;
  if (sym.hard) status = 'stop_final';                     // 胸/頭の強い痛み・運転に支障あり
  else if (level >= 3) status = (count >= 2) ? 'stop_final' : 'stop_recheck';
  else if (peakLevel >= 3) { status = 'restrict'; reasons.push('本日ピーク ' + (opts.peakSys || '-') + '/' + (opts.peakDia || '-')); }
  else if (sym.check) status = 'symptom_check';            // 運管が本人に確認して判断
  else if (level === 2) status = (count >= 2) ? 'restrict' : 'recheck';
  else if (level === 1) status = 'watch';
  else status = 'ok';

  const g = GATE_STATUS[status];
  // 🔶要確認のときも、血圧側の指示(再測など)があれば併記する
  let action = g.action;
  if (status === 'stop_final' && !sym.hard && count >= 2) action = '再測でも基準を超えています。' + action;
  if (status === 'symptom_check' && level >= 1) action += ' ' + GATE_STATUS[level === 2 ? 'recheck' : 'watch'].action;
  // 乗務の文言(pill/action)はドライバーにだけ返す。事務・倉庫に「乗務不可」と出ると意味が通らない。
  return { level, peak_level: peakLevel, count, status,
           pill: isDriver ? g.pill : '', action: isDriver ? action : '',
           driver: isDriver, reasons };
}
// 当日の最悪値・測定回数を更新する。
// ⚠️同じ数値の再送信(メモだけ直して再保存 等)は測定回数に数えない=再測1回のカウントが狂わないように。
function bpProgress(prior, sys, dia) {
  const pc = (prior && prior.bp_count) || 0;
  const same = !!(prior && prior.bp_systolic === sys && prior.bp_diastolic === dia);
  let count = pc;
  if (sys && dia && !same) count = pc + 1;
  else if (sys && dia && !pc) count = 1;                    // 既存データ(列追加前)の救済
  let ps = (prior && prior.bp_peak_sys) || null;
  let pd = (prior && prior.bp_peak_dia) || null;
  if (!ps && prior && prior.bp_systolic) { ps = prior.bp_systolic; pd = prior.bp_diastolic; }
  if (sys && dia) {
    const a = bpGateLevel(ps, pd), b = bpGateLevel(sys, dia);
    if (!ps || b > a || (b === a && sys > (ps || 0))) { ps = sys; pd = dia; }
  }
  return { count, peakSys: ps, peakDia: pd };
}
// 2026-08-01 (社長指摘): 「血圧が正常なのに🔴高のPOSTが来る」。
//   判定は血圧だけでなく健康点検の回答(痛み/顔色/体調)からも上がるが、POST本文には血圧しか
//   書いていなかったため、受け取った側が高の理由を読み取れなかった。
//   → 高/中の根拠(重み1以上の項目)を本文に明記する。判定に加算しない項目も参考として添える。
const SEV_LABEL = {
  facial_color: { label: '顔色', v: { tired: '疲れて見える', red: '赤い', pale: '青白い' } },
  pain:         { label: '痛み', v: { low_back: '腰', shoulder: '肩', joint: '関節', severe: '強い痛み' } },
};
const REF_LABEL = {
  hydration:   { no: '水分がとれていない' },
  breakfast:   { no: '朝食を食べていない' },
  three_meals: { no: '1日3食とれていない' },
  sleep6h:     { no: '睡眠6時間未満' },
  wakeup:      { no: '起床時すっきりしない' },
};
const CONCERN_LABEL = { health: '健康', family: '家族', work: '仕事', money: 'お金', other: 'その他' };
// urgency を押し上げた項目 (重み1以上)
function urgencyReasons(health, condition) {
  const out = [];
  if (condition === 'bad') out.push('体調: 悪い');
  if (health) for (const k of Object.keys(SEV_LABEL)) {
    const val = health[k];
    const w = (SEV[k] && SEV[k][val] != null) ? SEV[k][val] : 0;
    if (w >= 1) out.push(SEV_LABEL[k].label + ': ' + (SEV_LABEL[k].v[val] || val));
  }
  return out;
}
// 判定には加算しないが、状況把握のために添える項目
function healthRefNotes(health) {
  const out = [];
  if (!health) return out;
  for (const k of Object.keys(REF_LABEL)) {
    const t = REF_LABEL[k][health[k]];
    if (t) out.push(t);
  }
  if (health.concern && health.concern !== 'no' && CONCERN_LABEL[health.concern]) {
    out.push('気になること: ' + CONCERN_LABEL[health.concern]);
  }
  return out;
}
// ============================================================
// 気にかけボードに出す「やさしい理由」 (2026-08-03 吉沢さん指摘の是正)
//  ⚠️⚠️理由は memo の文字列一致で作ってはいけない。自己チェック/朝礼の memo は
//    血圧を入力していれば値が正常でも必ず「血圧 105/64」の文字を含むため、
//    /血圧/ に当たった全員が「血圧が高め」と表示されていた
//    (2026-08-03 立石さん=105/64の正常値・実際の気がかりは肩の痛み)。
//    → 判定と同じ根拠 (structured_json の health/bp) から作る。
//  ⚠️プライバシー: このボードは推進メンバーも見る。痛みの部位など症状の中身は出さない
//    (buildConditionDetail と同じ方針)。部位は点呼管理の当日表(運管)でのみ見せる。
function careReason(structuredJson) {
  let sj = null;
  try { sj = structuredJson ? JSON.parse(structuredJson) : null; } catch (e) { return null; }
  if (!sj) return null;
  const h = sj.health || {};
  const bp = sj.bp || {};
  const out = [];
  const bs = bpSeverity(bp.sys, bp.dia);
  if (bs >= 2) out.push('血圧が高い');
  else if (bs === 1) out.push('血圧が高め');
  if (h.pain === 'severe') out.push('強い痛みの訴え');
  else if (h.pain && h.pain !== 'no') out.push('体の痛みの訴え');
  if (h.facial_color === 'pale' || h.facial_color === 'red') out.push('顔色が気になる');
  else if (h.facial_color === 'tired') out.push('疲れて見える');
  if (h.duty_intent === 'stop' || h.duty_intent === 'consult') out.push('本人から乗務の申し出');
  if (sj.condition === 'bad') out.push('体調がすぐれない');
  if (!out.length) return null;         // 根拠が拾えない時はフロントの従来ロジックに任せる
  return out.slice(0, 2).join('・');
}

// POST本文の共通組み立て。血圧/メモ に 根拠 と 参考 を足す。
function buildConditionDetail(o) {
  const lines = [];
  // 乗務ゲート該当は本文の先頭に明記する (受け取った側が「何をすべきか」を即断できるように)。
  // ⚠️⚠️プライバシー: この本文は「現場の声」グループ(推進メンバー複数名)のチャットに流れる。
  //   痛みの部位など症状の細かい内容は載せず、判定と次の一手だけにする。
  //   詳細(pain_site/pain_drive)は health_json に持ち、点呼管理の当日表(運管・管理職)でのみ見せる。
  if (o.gate && o.gate.driver && o.gate.status !== 'ok' && o.gate.status !== 'watch') {
    lines.push(o.gate.pill + ' ' + o.gate.action);
  }
  const head = [o.bpHigh ? ('⚠️' + o.bpText + '(高血圧)') : o.bpText, o.note].filter(Boolean).join(' / ');
  if (head) lines.push(head);
  const reasons = urgencyReasons(o.health, o.condition);
  if (reasons.length) lines.push('⚠️ ' + reasons.join(' ／ '));
  const refs = healthRefNotes(o.health);
  if (refs.length) lines.push('(参考: ' + refs.join('・') + ')');
  return lines.length ? lines.join('\n') : '(メモなし)';
}

function deriveUrgency(mode, health, condition, bp) {
  let max = 0;
  // 8項目の観察系(顔色/痛み/気になる)から severity を算出 (点呼・朝礼共通)
  if (health) for (const k of Object.keys(SEV)) {
    const s = (SEV[k] && SEV[k][health[k]] != null) ? SEV[k][health[k]] : 0;
    if (s > max) max = s;
  }
  // 朝礼の体調(condition)後方互換
  if (condition === 'bad') max = Math.max(max, 2);
  // 点呼は血圧も加味 (管理者記入)
  if (mode === 'tenko') {
    const bs = bpSeverity(bp && bp.sys, bp && bp.dia);
    if (bs > max) max = bs;
  }
  return max >= 2 ? '高' : max >= 1 ? '中' : '低';
}

// 営業所ロスター + 本日の実施状況
router.get('/roster', authUser, (req, res) => {
  const op = getOperator(req.uid);
  if (!isOperator(op)) return res.status(403).json({ success: false, msg: '点呼者・管理者のみ利用できます' });
  const db = getDb();
  const company = scopedCompany(op, req.query.company);   // 2026-07-21 他拠点指定を遮断
  const date = jstDate();
  const members = db.prepare(`
    SELECT id, display_name, avatar_url, job_role, company_code, role, employee_type
    FROM users
    WHERE company_code = ?
      AND COALESCE(status,'active') NOT IN ('deleted','archived')
      AND COALESCE(role,'') <> 'bot' AND COALESCE(employee_type,'') <> 'bot' AND id NOT LIKE 'bot_%'
    ORDER BY COALESCE(dm_rank,0) DESC, display_name COLLATE NOCASE
  `).all(company);
  const recs = db.prepare(
    'SELECT target_id, mode, urgency, tokai_done, condition, health_json, bp_systolic, bp_diastolic, pulse, updated_at FROM tenko_records WHERE rec_date = ? AND company_code = ?'
  ).all(date, company);
  const recMap = {}; recs.forEach(r => { recMap[r.target_id] = r; });
  // 各人の未読通達件数 — 点呼で「伝達すべきことが残っている人」を点呼者に見せるため (2026-07-21)
  const unreadMap = {};
  try {
    const anns = db.prepare(`SELECT id, target, requires_ack FROM announcements
      WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at >= datetime('now'))`).all();
    if (anns.length && members.length) {
      const ph = members.map(() => '?').join(',');
      const reads = db.prepare(`SELECT announcement_id, user_id, read_at, acked_at FROM announcement_reads
        WHERE user_id IN (${ph})`).all(...members.map(m => m.id));
      const rk = {}; reads.forEach(r => { rk[r.user_id + '|' + r.announcement_id] = r; });
      members.forEach(m => {
        let c = 0;
        for (const a of anns) {
          if (!noticeMatches(m, a.target)) continue;
          const r = rk[m.id + '|' + a.id];
          if (!r || !r.read_at || (a.requires_ack && !r.acked_at)) c++;
        }
        unreadMap[m.id] = c;
      });
    }
  } catch (e) { console.warn('[tenko roster unread notices]', e.message); }
  const items = members.map(m => {
    const r = recMap[m.id];
    // done=運管の点呼済み(mode!=='self')。本人の自己申告のみ(mode==='self')は self_done として区別し、
    // 点呼画面で「本人申告済み」を出し、運管が内容を確認して点呼記録(=上書き)できるようにする。
    const operatorDone = !!(r && r.mode !== 'self');
    const selfOnly = !!(r && r.mode === 'self');
    let self = null;
    if (selfOnly) {
      let h = null; try { h = r.health_json ? JSON.parse(r.health_json) : null; } catch (e) {}
      self = {
        condition: r.condition || null, health: h || {},
        bp: { sys: r.bp_systolic || null, dia: r.bp_diastolic || null, pulse: r.pulse || null },
        at: r.updated_at || null,
      };
    }
    return {
      id: m.id, name: m.display_name, avatar: m.avatar_url || '', job_role: m.job_role || '',
      mode: (m.job_role === 'driver') ? 'tenko' : 'chorei',
      done: operatorDone, self_done: selfOnly, self, urgency: r ? r.urgency : null,
      unread_notices: unreadMap[m.id] || 0,
    };
  });
  const companies = db.prepare("SELECT code, name FROM companies WHERE code NOT IN ('ADMIN','GUEST','NPO','UNIVERSITY') ORDER BY name").all();
  res.json({
    success: true, date, company, companies,
    total: items.length, done: items.filter(i => i.done).length, items,
    me: { id: op.id, name: op.display_name },
  });
});

// 本日の連絡・安全一言 取得/設定
router.get('/brief', authUser, (req, res) => {
  const op = getOperator(req.uid);
  if (!isOperator(op)) return res.status(403).json({ success: false, msg: '権限なし' });
  const company = scopedCompany(op, req.query.company);   // 2026-07-21 他拠点指定を遮断
  const row = getDb().prepare('SELECT message FROM tenko_briefs WHERE rec_date = ? AND company_code = ?').get(jstDate(), company);
  res.json({ success: true, message: row ? row.message : '' });
});
router.post('/brief', authUser, express.json(), (req, res) => {
  const op = getOperator(req.uid);
  if (!isOperator(op)) return res.status(403).json({ success: false, msg: '権限なし' });
  const company = scopedCompany(op, req.body && req.body.company);   // 2026-07-21 他拠点への書込を遮断
  const message = String((req.body && req.body.message) || '').slice(0, 500);
  getDb().prepare(`INSERT INTO tenko_briefs (rec_date, company_code, message, set_by, updated_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(rec_date, company_code) DO UPDATE SET
      message = excluded.message, set_by = excluded.set_by, updated_at = excluded.updated_at`)
    .run(jstDate(), company, message, op.id);
  res.json({ success: true });
});

// 点呼・朝礼の記録 (1日1回, 上書き)。不調(中/高)は現場の声へ自動連携
router.post('/checkin', authUser, express.json(), (req, res) => {
  const op = getOperator(req.uid);
  if (!isOperator(op)) return res.status(403).json({ success: false, msg: '点呼者・管理者のみ利用できます' });
  const db = getDb();
  const b = req.body || {};
  const target = db.prepare('SELECT id, display_name, company_code, job_role FROM users WHERE id = ?').get(String(b.target_id || ''));
  if (!target) return res.status(404).json({ success: false, msg: '対象者が見つかりません' });
  // 2026-07-21: 対象者の拠点を検証していなかったため、他拠点の社員の点呼記録（血圧・体調）を
  // 任意に作成・上書きできた。本社admin/推進以外は自拠点のみ。
  if (!canCrossCompany(op) && String(target.company_code || '') !== String(op.company_code || '')) {
    return res.status(403).json({ success: false, msg: '他拠点の社員は登録できません' });
  }

  const mode = (target.job_role === 'driver') ? 'tenko' : 'chorei';
  const tokaiDone = b.tokai_done ? 1 : 0;
  const condition = b.condition ? String(b.condition).slice(0, 16) : null;
  const health = (b.health && typeof b.health === 'object') ? b.health : null;
  const note = String(b.note || '').slice(0, 300);
  // 血圧 (管理者が点呼時に記入。東海電子非連動)
  const toInt = (v) => { const n = parseInt(v, 10); return (Number.isFinite(n) && n > 0 && n < 400) ? n : null; };
  const bpSys = toInt(b.bp_systolic), bpDia = toInt(b.bp_diastolic), pulse = toInt(b.pulse);
  const urgency = deriveUrgency(mode, health, condition, { sys: bpSys, dia: bpDia });
  const date = jstDate();

  const bpText = (bpSys || bpDia) ? `血圧 ${bpSys || '-'}/${bpDia || '-'}${pulse ? ` 脈${pulse}` : ''}` : '';
  const bpHigh = bpSeverity(bpSys, bpDia) >= 2;
  // 当日の最悪値・測定回数を引き継ぐ(再測1回の判定に使う)
  const priorRec = db.prepare('SELECT bp_systolic, bp_diastolic, bp_peak_sys, bp_peak_dia, bp_count FROM tenko_records WHERE rec_date = ? AND target_id = ?').get(date, target.id);
  const prog = bpProgress(priorRec, bpSys, bpDia);
  const gate = dutyGate(target.job_role, bpSys, bpDia, health, condition, prog);

  // 不調 → 現場の声へ連携。投稿元は本人の職種で分ける
  // (2026-08-03: 製造スタッフの声が「倉庫」に入っていたため 製造 を追加。事務は従来どおり倉庫扱い)
  let wpId = null;
  if (urgency === '中' || urgency === '高') {
    try {
      const sourceType = mode === 'tenko' ? '運管' : (target.job_role === 'manufacturing' ? '製造' : '倉庫');
      const detail = buildConditionDetail({ bpText: bpText, bpHigh: bpHigh, note: note, health: health, condition: condition, gate: gate });
      const memo = `【${mode === 'tenko' ? '点呼' : '朝礼'}】${target.display_name}さんの体調確認: ${detail}`;
      const ins = db.prepare(`INSERT INTO wellness_posts
        (poster_id, company_code, category, urgency, identity_mode, memo, source_type, subject_user_id, structured_json)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(op.id, target.company_code || '', '体調', urgency, '本人特定可', memo, sourceType,
             target.id, JSON.stringify({ health, condition, bp: { sys: bpSys, dia: bpDia, pulse } }));
      wpId = ins.lastInsertRowid;
      // 中🟡 はチャット着信を出さず、点呼管理モーダルの未確認バッジ(ack)に集約。高🔴 のみ即時チャット+Push。
      if (urgency === '高') {
        const content = `📝 #${wpId} 【体調】 🔴高\n営業所: ${target.company_code || '-'}　/　${mode === 'tenko' ? '点呼' : '朝礼'}: ${target.display_name}\n─\n${detail}`;
        const msgIns = db.prepare('INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, NULL, ?, ?)')
          .run(op.id, content, 'grp_' + FIELD_VOICE_GROUP);
        if (req.app && req.app.locals && req.app.locals.emitToGroupMembers) {
          req.app.locals.emitToGroupMembers(FIELD_VOICE_GROUP, 'group:msg', {
            id: msgIns.lastInsertRowid, from: op.id, group_id: FIELD_VOICE_GROUP,
            content, at: new Date().toISOString(), attach: null,
          });
        }
      }
    } catch (e) { console.warn('[tenko→wellness]', e.message); }
  }

  db.prepare(`INSERT INTO tenko_records
    (rec_date, target_id, operator_id, company_code, mode, tokai_done, condition, health_json, urgency, note,
     bp_systolic, bp_diastolic, pulse, bp_peak_sys, bp_peak_dia, bp_count, wellness_post_id, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(rec_date, target_id) DO UPDATE SET
      operator_id = excluded.operator_id, mode = excluded.mode, tokai_done = excluded.tokai_done,
      condition = excluded.condition, health_json = excluded.health_json, urgency = excluded.urgency,
      note = excluded.note, bp_systolic = excluded.bp_systolic, bp_diastolic = excluded.bp_diastolic, pulse = excluded.pulse,
      bp_peak_sys = excluded.bp_peak_sys, bp_peak_dia = excluded.bp_peak_dia, bp_count = excluded.bp_count,
      wellness_post_id = COALESCE(excluded.wellness_post_id, tenko_records.wellness_post_id),
      updated_at = datetime('now')`)
    .run(date, target.id, op.id, target.company_code || '', mode, tokaiDone, condition,
         health ? JSON.stringify(health) : null, urgency, note, bpSys, bpDia, pulse,
         prog.peakSys, prog.peakDia, prog.count, wpId);

  res.json({ success: true, urgency, escalated: !!wpId, bp_high: bpHigh, gate });
});

// ============================================================
// 自己チェック (一般社員が自分で記録)。点呼・健康点検と同じ tenko_records に mode='self' で合流。
// 不調(中/高)・高血圧は点呼と同様「現場の声」へ自動連携(推進メンバーが把握)。本人の血圧履歴(bp_records)にも記録。
// ※点呼者が実施した当日の点呼記録は上書きしない(WHERE mode='self')。点呼者の記録が優先。
// ============================================================
router.post('/self-checkin', authUser, express.json(), (req, res) => {
  const db = getDb();
  const me = db.prepare('SELECT id, display_name, company_code, job_role FROM users WHERE id = ?').get(req.uid);
  if (!me) return res.status(404).json({ success: false, msg: 'ユーザーが見つかりません' });
  const b = req.body || {};
  const health = (b.health && typeof b.health === 'object') ? b.health : null;
  const condition = b.condition ? String(b.condition).slice(0, 16) : null;
  const note = (b.note != null) ? String(b.note).slice(0, 300) : null;
  const toInt = (v) => { const n = parseInt(v, 10); return (Number.isFinite(n) && n > 0 && n < 400) ? n : null; };
  const bpSys = toInt(b.bp_systolic), bpDia = toInt(b.bp_diastolic), pulse = toInt(b.pulse);
  if (!health && !(bpSys && bpDia)) return res.status(400).json({ success: false, msg: '健康点検または血圧を入力してください' });
  const date = jstDate();

  // 当日の既存self記録を取得し「部分更新」する=今回送られなかった項目(健康点検/血圧/メモ/体調)は
  // 既存値を保持(例: 血圧だけ入れ直しても朝の健康点検が消えない・逆も同様)。urgencyは実効値で再計算。
  const URANK = { '低': 0, '中': 1, '高': 2 };
  const prior = db.prepare("SELECT health_json, condition, note, bp_systolic, bp_diastolic, pulse, bp_peak_sys, bp_peak_dia, bp_count, wellness_post_id FROM tenko_records WHERE rec_date = ? AND target_id = ? AND mode = 'self'").get(date, me.id);
  let priorHealth = null;
  if (prior && prior.health_json) { try { priorHealth = JSON.parse(prior.health_json); } catch (e) {} }
  const effHealth = health || priorHealth;
  const effCondition = condition || (prior && prior.condition) || null;
  const effNote = (note != null && note !== '') ? note : ((prior && prior.note) || '');
  const effBpSys = bpSys || (prior && prior.bp_systolic) || null;
  const effBpDia = bpDia || (prior && prior.bp_diastolic) || null;
  const effPulse = pulse || (prior && prior.pulse) || null;

  const urgency = deriveUrgency('tenko', effHealth, effCondition, { sys: effBpSys, dia: effBpDia }); // 'tenko'指定でbpも加味
  const bpText = (effBpSys || effBpDia) ? `血圧 ${effBpSys || '-'}/${effBpDia || '-'}${effPulse ? ` 脈${effPulse}` : ''}` : '';
  const bpHigh = bpSeverity(effBpSys, effBpDia) >= 2;
  // 再測1回の判定用。今回送られてきた値(bpSys/bpDia)で回数を数える=既存値の持ち回りは数えない。
  const prog = bpProgress(prior, bpSys, bpDia);
  const gate = dutyGate(me.job_role, effBpSys, effBpDia, effHealth, effCondition, prog);

  // 同日2回目以降は新規バッジを作らず既存postを再利用(都度配信の防止)。
  // ただし悪化(中→高)時のみ既存postを高へ引き上げ・未対応へ戻し、現場の声へ1回だけ通知(急変見落とし防止)。
  let priorWp = null;
  if (prior && prior.wellness_post_id) {
    priorWp = db.prepare('SELECT id, urgency FROM wellness_posts WHERE id = ?').get(prior.wellness_post_id);
  }
  let wpId = priorWp ? priorWp.id : null;
  if (urgency === '中' || urgency === '高') {
    try {
      const worsened = !priorWp || URANK[urgency] > URANK[priorWp.urgency || '低'];
      const detail = buildConditionDetail({ bpText: bpText, bpHigh: bpHigh, note: effNote, health: effHealth, condition: effCondition, gate: gate });
      const memo = `【自己チェック】${me.display_name}さんの体調: ${detail}`;
      const sj = JSON.stringify({ health: effHealth, condition: effCondition, bp: { sys: effBpSys, dia: effBpDia, pulse: effPulse } });
      if (!priorWp) {
        const ins = db.prepare(`INSERT INTO wellness_posts
          (poster_id, company_code, category, urgency, identity_mode, memo, source_type, subject_user_id, structured_json)
          VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(me.id, me.company_code || '', '体調', urgency, '本人特定可', memo, 'セルフ', me.id, sj);
        wpId = ins.lastInsertRowid;
      } else if (worsened) {
        db.prepare("UPDATE wellness_posts SET urgency = ?, memo = ?, structured_json = ?, ack_status = '未対応' WHERE id = ?")
          .run(urgency, memo, sj, priorWp.id);
        wpId = priorWp.id;
      }
      // 中🟡 はチャット着信を出さず未確認バッジ(ack)に集約。
      // 高🔴 は「新規 or 中→高に悪化」した時だけ即時チャット+Push(同日同レベルの再通知はしない)。
      if (urgency === '高' && worsened) {
        const content = `📝 #${wpId} 【体調】 🔴高\n営業所: ${me.company_code || '-'}　/　自己チェック: ${me.display_name}\n─\n${detail}`;
        const msgIns = db.prepare('INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, NULL, ?, ?)')
          .run(me.id, content, 'grp_' + FIELD_VOICE_GROUP);
        if (req.app && req.app.locals && req.app.locals.emitToGroupMembers) {
          req.app.locals.emitToGroupMembers(FIELD_VOICE_GROUP, 'group:msg', {
            id: msgIns.lastInsertRowid, from: me.id, group_id: FIELD_VOICE_GROUP,
            content, at: new Date().toISOString(), attach: null,
          });
        }
      }
    } catch (e) { console.warn('[self-checkin→wellness]', e.message); }
  }

  db.prepare(`INSERT INTO tenko_records
    (rec_date, target_id, operator_id, company_code, mode, tokai_done, condition, health_json, urgency, note,
     bp_systolic, bp_diastolic, pulse, bp_peak_sys, bp_peak_dia, bp_count, wellness_post_id, updated_at)
    VALUES (?,?,?,?,'self',0,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(rec_date, target_id) DO UPDATE SET
      operator_id = excluded.operator_id, condition = excluded.condition, health_json = excluded.health_json,
      urgency = excluded.urgency, note = excluded.note, bp_systolic = excluded.bp_systolic,
      bp_diastolic = excluded.bp_diastolic, pulse = excluded.pulse,
      bp_peak_sys = excluded.bp_peak_sys, bp_peak_dia = excluded.bp_peak_dia, bp_count = excluded.bp_count,
      wellness_post_id = COALESCE(excluded.wellness_post_id, tenko_records.wellness_post_id), updated_at = datetime('now')
    WHERE tenko_records.mode = 'self'`)
    .run(date, me.id, me.id, me.company_code || '', effCondition, effHealth ? JSON.stringify(effHealth) : null, urgency, effNote,
         effBpSys, effBpDia, effPulse, prog.peakSys, prog.peakDia, prog.count, wpId);

  if (bpSys && bpDia) {
    try {
      db.prepare(`INSERT INTO bp_records (user_id, systolic, diastolic, pulse, measured_at, memo) VALUES (?,?,?,?,?,?)`)
        .run(me.id, bpSys, bpDia, pulse, new Date(Date.now() + 32400000).toISOString().slice(0, 19).replace('T', ' '), '自己チェック'); // measured_atはJST(+9h)で保存(履歴は生表示のため)
    } catch (e) {}
  }
  res.json({ success: true, urgency, escalated: !!wpId, bp_high: bpHigh, gate });
});

// 体調チェック「実施(済)」判定。⚠️「行が存在する」だけでは済にしない:
//  ・点呼者記録(mode≠self)=点呼時に健康点検を実施済 → 済(ドライバー自動済み・二重入力回避)
//  ・自己記録(mode=self)=実際に健康点検(health_json)or 体調(condition)を入れた時のみ済
//  ・血圧だけの自己記録(マイヘルスの血圧をボードへ反映した行 health.js /bp 等)は体調チェック未実施扱い
// これが無いと、血圧を1件測っただけで「体調チェック済み」になってしまう(2026-07-04 小林さん報告)。
// ⚠️2026-07-31: 実装は services/health_daily.js に一本化 (日次サマリー配信と数字がズレないように)。
const healthDaily = require('../services/health_daily');
const isCheckDone = healthDaily.isCheckDone;

// ============================================================
// 点呼の「指示・伝達」パート (2026-07-21)
//  健康点検だけで点呼が終わってしまい、通達やメッセージが未確認のまま乗務に出る、という
//  実運用の穴を塞ぐ。体調チェックの直後にこの内容を必ず提示して確認させる。
//  返すもの: 営業所の今日の連絡(brief) / 未読の通達 / 未読メッセージ(DM・グループ)件数
// ============================================================
// 通達の配信対象判定。announcements.js の実装に委譲する。
// ⚠️2026-07-30まではここに複製があり、'company:'/'building:'/'role:' の旧方式しか
//   見ていなかった。そのため現行方式の 'dmg:'(営業所宛)・'dmgr:'・'jobrole:'・
//   'user(s):'(個人宛) が全て「対象外」になり、営業所宛の通達が点呼ブリーフィングに
//   出ていなかった。複製をやめたので今後の方式追加(複数拠点の '|' 連結など)にも追随する。
// ⚠️uid を渡すこと: 委譲先が必要な列(dm_group 等)を自分で引き直すので、呼び出し側の
//   SELECT列が足りずに取りこぼす事故を防げる。
function noticeMatches(u, target) {
  if (!target || target === 'all') return true;
  if (!u || !u.id) return false;
  return userMatchesTarget(u.id, target);
}
function briefingFor(uid) {
  const db = getDb();
  const u = db.prepare('SELECT id, display_name, company_code, role, employee_type, job_role FROM users WHERE id = ?').get(uid);
  if (!u) return null;
  const brow = db.prepare('SELECT message FROM tenko_briefs WHERE rec_date = ? AND company_code = ?').get(jstDate(), u.company_code || '');
  const rows = db.prepare(`SELECT a.id, a.title, a.body, a.level, a.requires_ack, a.target, a.created_at,
                                  a.attachments, au.display_name AS author_name, r.read_at, r.acked_at
                           FROM announcements a
                           LEFT JOIN users au ON au.id = a.author_id
                           LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
                           WHERE a.deleted_at IS NULL
                             AND (a.expires_at IS NULL OR a.expires_at >= datetime('now'))
                           ORDER BY a.id DESC LIMIT 100`).all(uid);
  const notices = rows
    .filter(a => !a.read_at || (a.requires_ack && !a.acked_at))   // 先に未読で絞る(判定はDB参照あり)
    .filter(a => noticeMatches(u, a.target))
    .slice(0, 10)
    .map(a => {
      let n = 0; try { const t = JSON.parse(a.attachments || '[]'); n = Array.isArray(t) ? t.length : 0; } catch (e) {}
      return {
        id: a.id, title: a.title, body: String(a.body || '').slice(0, 1200), level: a.level,
        requires_ack: !!a.requires_ack, author_name: a.author_name || '', created_at: a.created_at,
        attachments: n,
      };
    });
  // 未読メッセージ (chat.js /unread-count と同じ条件: 60日以内・bot送信DMは除外)
  const g = db.prepare(`SELECT COUNT(*) AS c FROM chat_groups g
    JOIN chat_group_members gm ON gm.group_id = g.id AND gm.user_id = ?
    JOIN messages m ON m.room_code = 'grp_' || g.id AND m.sender_id != ?
      AND m.created_at > datetime('now','-60 days') AND m.created_at > gm.joined_at
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?)`).get(uid, uid, uid);
  const d = db.prepare(`SELECT COUNT(*) AS c FROM messages
    WHERE room_code = 'dm' AND receiver_id = ? AND sender_id != ? AND sender_id NOT LIKE 'bot_%'
      AND created_at > datetime('now','-60 days')
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = id AND r.user_id = ?)`).get(uid, uid, uid);
  return {
    brief: (brow && brow.message) ? brow.message : '',
    notices, dm_unread: d.c || 0, group_unread: g.c || 0,
  };
}
// 本人用 (体調チェック直後に表示)
router.get('/briefing', authUser, (req, res) => {
  const b = briefingFor(req.uid);
  if (!b) return res.status(404).json({ success: false, msg: 'ユーザーが見つかりません' });
  res.json(Object.assign({ success: true }, b));
});
// 提示した通達をまとめて既読(要確認のものは確認済み)にする。
// 「読んだことにする」ボタンではなく、画面で本文を出し切ってから押させる前提。
router.post('/briefing/confirm', authUser, express.json(), (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(n => parseInt(n, 10)).filter(Number.isFinite).slice(0, 20) : [];
  const db = getDb();
  const read = db.prepare(`INSERT INTO announcement_reads (announcement_id, user_id) VALUES (?, ?)
    ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at = COALESCE(read_at, datetime('now'))`);
  const ack = db.prepare(`INSERT INTO announcement_reads (announcement_id, user_id, acked_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at = COALESCE(read_at, datetime('now')), acked_at = datetime('now')`);
  let n = 0;
  for (const id of ids) {
    const a = db.prepare('SELECT id, requires_ack FROM announcements WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!a) continue;
    (a.requires_ack ? ack : read).run(id, req.uid);
    n++;
  }
  res.json({ success: true, confirmed: n });
});

// ============================================================
// 自分の本日の実施状況 (ホーム最上部「今日の体調チェック」カード用)。
// 済判定は isCheckDone (血圧のみ/行の有無だけでは済にしない)。
// ============================================================
router.get('/my-today', authUser, (req, res) => {
  try {
    const date = jstDate();
    const r = getDb().prepare(
      "SELECT mode, urgency, health_json, condition FROM tenko_records WHERE rec_date = ? AND target_id = ? LIMIT 1"
    ).get(date, req.uid);
    res.json({ success: true, done: isCheckDone(r), mode: r ? r.mode : null, urgency: r ? r.urgency : null });
  } catch (e) {
    res.json({ success: true, done: false });
  }
});

// 共用ログイン画面(未認証)用: 今日「出勤(ログイン)」した人の id 一覧=アバターにバッジ。
// ①今日ログイン(詳細ページ=login / 共用タブレット=tablet_login) ②今日 体調チェック済み(セッション継続で
// login記録が無い場合の保険)の和集合。健康詳細は返さない(idのみ)。
router.get('/checkedin-today', (req, res) => {
  try {
    const date = jstDate();
    const seen = {};
    // ① 今日ログインした人(audit_log)。created_at=UTC → +9h でJST日付比較。
    const logins = getDb().prepare(
      "SELECT DISTINCT actor_id FROM audit_log WHERE action IN ('login','tablet_login') AND date(created_at, '+9 hours') = ? AND actor_id IS NOT NULL"
    ).all(date);
    logins.forEach(r => { if (r.actor_id) seen[r.actor_id] = 1; });
    // ② 今日 体調チェックを済ませた人(念のため合算)
    const checks = getDb().prepare(
      "SELECT target_id, mode, health_json, condition FROM tenko_records WHERE rec_date = ?"
    ).all(date);
    checks.forEach(r => { if (isCheckDone(r)) seen[r.target_id] = 1; });
    // ③ 今日アクティブ(オンライン)=socket接続で last_seen_at 更新。前日以前ログインでセッション継続=①に載らない人を拾う。
    const active = getDb().prepare(
      "SELECT id FROM users WHERE last_seen_at IS NOT NULL AND date(last_seen_at, '+9 hours') = ?"
    ).all(date);
    active.forEach(r => { seen[r.id] = 1; });
    res.json({ success: true, ids: Object.keys(seen) });
  } catch (e) {
    res.json({ success: true, ids: [] });
  }
});

// ============================================================
// 健康点検ボード (推進メンバー・管理職向け): 当日の実施状況・未実施者・項目別傾向・血圧/不調を拠点スコープで集計。
// 点呼(operator)と自己チェック(self)の両方を横断。毎日の励行確認(未実施フォロー)が主目的。
// ============================================================
function getViewer(uid) {
  return getDb().prepare(`SELECT id, display_name, company_code, employee_type, role, is_manager, job_role,
    is_field_promoter, is_warehouse_promoter, is_tenko_operator, is_ops_manager, is_branch_head, is_guest_reviewer
    FROM users WHERE id = ?`).get(uid);
}
function canViewBoard(u) {
  return !!(u && (u.is_manager || u.role === 'admin' || u.employee_type === 'admin' || u.job_role === 'manager'
    || u.is_field_promoter || u.is_warehouse_promoter || u.is_tenko_operator || u.is_ops_manager || u.is_branch_head
    || u.is_guest_reviewer));
}
// 本人以外の血圧推移を閲覧できるユーザー (社長指示 2026-07-18: 小林 猛・吉沢 佑也 の2名のみ)。
// 健康情報ゆえ最小権限。ここに載っている人だけが全社員の推移を見られる。
// 研究閲覧(社外ゲスト)か。書き込み禁止・氏名匿名化は middleware/authz.js が全APIで強制する。
function isResearchViewer(uid) {
  const u = getDb().prepare('SELECT is_guest_reviewer FROM users WHERE id = ?').get(uid);
  return !!(u && u.is_guest_reviewer);
}
const BP_TREND_VIEWERS = [
  '7cf1bd9c-5c97-495d-84e8-5339583a5e6c', // 小林 猛
  'b097b512-468b-4161-a273-2e96ee589960'  // 吉沢 佑也
];
const HC_LABELS = { hydration:'水分補給', breakfast:'朝食', three_meals:'3食', sleep6h:'6時間睡眠', wakeup:'目覚め', facial_color:'顔色', pain:'体の痛み', concern:'気になる' };
// 管理者が追加した「健康チェックの追加質問」(app_settings key='health_custom_items' の配列JSON)を返す。
// 各要素 = { key:'cx_1', q:'質問文', opts:[[label,value],...] }。読取専用ヘルパ(GET /health-items・/board で共用)。
function getHealthCustomItems() {
  try {
    const row = getDb().prepare("SELECT value FROM app_settings WHERE key = 'health_custom_items'").get();
    if (!row || !row.value) return [];
    const arr = JSON.parse(row.value);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
router.get('/board', authUser, (req, res) => {
  const db = getDb();
  const me = getViewer(req.uid);
  if (!canViewBoard(me)) return res.status(403).json({ success: false, msg: 'この画面は推進メンバー・管理職のみ閲覧できます' });
  const hq = !!(me.role === 'admin' || me.employee_type === 'admin' || me.is_guest_reviewer); // 本社ADMIN(と研究閲覧のゲスト)は全拠点
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : jstDate();
  const co = hq ? String(req.query.co || '') : (me.company_code || '');
  const rosterSql = `SELECT id, display_name, company_code, job_role, avatar_url FROM users
    WHERE COALESCE(role,'')<>'bot' AND COALESCE(employee_type,'')<>'bot' AND id NOT LIKE 'bot_%' AND COALESCE(is_guest_reviewer,0)=0`;
  const roster = (hq && !co)
    ? db.prepare(rosterSql + ' ORDER BY company_code, display_name').all()
    : db.prepare(rosterSql + ' AND company_code = ? ORDER BY display_name').all(co);
  const recs = (hq && !co)
    ? db.prepare('SELECT * FROM tenko_records WHERE rec_date = ?').all(date)
    : db.prepare('SELECT * FROM tenko_records WHERE rec_date = ? AND company_code = ?').all(date, co);
  const byTarget = {}; recs.forEach(r => { byTarget[r.target_id] = r; });
  // 標準8項目 + 管理者の追加質問 を集計対象にする(追加質問の回答もボードの傾向に反映)。
  const customItems = getHealthCustomItems();
  const itemLabels = Object.assign({}, HC_LABELS);
  customItems.forEach(it => { if (it && it.key) itemLabels[it.key] = it.q; });
  const tally = {}; let done = 0, uMid = 0, uHigh = 0, bpHigh = 0, gStop = 0, gRecheck = 0, gRestrict = 0, gCheck = 0;
  const entries = roster.map(m => {
    const r = byTarget[m.id];
    if (!r) return { uid: m.id, name: m.display_name, company_code: m.company_code, job_role: m.job_role, done: false };
    // 実施(済)は isCheckDone 準拠。血圧だけの自己記録は体調チェック未実施(血圧・不調は下に表示は残す)。
    const checkDone = isCheckDone(r);
    if (checkDone) done++;
    if (r.urgency === '中') uMid++; else if (r.urgency === '高') uHigh++;
    if ((r.bp_systolic && r.bp_systolic >= 160) || (r.bp_diastolic && r.bp_diastolic >= 100)) bpHigh++;
    let h = {}; try { h = JSON.parse(r.health_json || '{}') || {}; } catch (e) {}
    // 乗務ゲート (ドライバーのみ件数に計上)
    const gate = dutyGate(m.job_role, r.bp_systolic, r.bp_diastolic, h, r.condition,
      { peakSys: r.bp_peak_sys, peakDia: r.bp_peak_dia, count: r.bp_count });
    if (gate.driver) {
      if (gate.status === 'stop_final' || gate.status === 'stop_recheck') gStop++;
      else if (gate.status === 'symptom_check') gCheck++;
      else if (gate.status === 'restrict') gRestrict++;
      else if (gate.status === 'recheck') gRecheck++;
    }
    Object.keys(itemLabels).forEach(k => { if (h[k] != null && h[k] !== '') { tally[k] = tally[k] || {}; tally[k][h[k]] = (tally[k][h[k]] || 0) + 1; } });
    return { uid: m.id, name: m.display_name, company_code: m.company_code, done: checkDone,
      source: r.mode, urgency: r.urgency, done_at: jstHM(r.updated_at),
      bp: (r.bp_systolic || r.bp_diastolic) ? { s: r.bp_systolic, d: r.bp_diastolic, p: r.pulse } : null,
      gate, health: h, condition: r.condition, note: r.note };
  });
  const total = roster.length;
  const companies = hq
    ? db.prepare(`SELECT DISTINCT company_code FROM users WHERE COALESCE(role,'')<>'bot' AND company_code IS NOT NULL AND company_code<>'' ORDER BY company_code`).all().map(x => x.company_code)
    : [me.company_code];
  // 血圧推移(本人以外)の閲覧は指定2名のみ。フロントは trend_access が真の時だけ氏名を📈リンク化する。
  const trendAccess = BP_TREND_VIEWERS.includes(req.uid) || !!(me && me.is_guest_reviewer);
  res.json({ success: true, date, hq, co, total, done, not_done: total - done,
    rate: total ? Math.round(done * 1000 / total) / 10 : 0, trend_access: trendAccess,
    urgency: { mid: uMid, high: uHigh }, bp_high: bpHigh,
    gate_stop: gStop, gate_recheck: gRecheck, gate_restrict: gRestrict, gate_check: gCheck,
    item_labels: itemLabels, tally, entries, companies });
});

// ============================================================
// 点呼POST 一括管理 (2026-06-25): 当日表 + 累計集計 + 未確認キュー を1本で返す。
// 中🟡 のチャット非通知化に伴い、ここで未確認バッジ + 一括ack を提供。
// 対象は点呼由来(運管/倉庫/セルフ)。拠点スコープは canViewBoard 準拠(本社ADMIN=全拠点)。
// ============================================================
const TENKO_SOURCES = ['運管', '倉庫', '製造', '帰庫', 'セルフ'];
router.get('/manage', authUser, (req, res) => {
  const db = getDb();
  const me = getViewer(req.uid);
  if (!canViewBoard(me)) return res.status(403).json({ success: false, msg: 'この画面は推進メンバー・管理職のみ閲覧できます' });
  const hq = !!(me.role === 'admin' || me.employee_type === 'admin' || me.is_guest_reviewer);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : jstDate();
  const co = hq ? String(req.query.co || '') : (me.company_code || '');
  const period = (req.query.period === 'week') ? 'week' : 'month';
  const days = period === 'week' ? 7 : 30;
  const since = ymdMinus(date, days - 1);
  const allCo = hq && !co;

  // --- 当日表 (roster + tenko_records + ack状態) ---
  const rosterSql = `SELECT id, display_name, company_code, job_role, avatar_url FROM users
    WHERE COALESCE(role,'')<>'bot' AND COALESCE(employee_type,'')<>'bot' AND id NOT LIKE 'bot_%' AND COALESCE(is_guest_reviewer,0)=0`;
  const roster = allCo
    ? db.prepare(rosterSql + ' ORDER BY company_code, display_name').all()
    : db.prepare(rosterSql + ' AND company_code = ? ORDER BY display_name').all(co);
  const recs = allCo
    ? db.prepare('SELECT * FROM tenko_records WHERE rec_date = ?').all(date)
    : db.prepare('SELECT * FROM tenko_records WHERE rec_date = ? AND company_code = ?').all(date, co);
  const wpIds = recs.map(r => r.wellness_post_id).filter(Boolean);
  // 誰が確認・対応(声かけ)したかも返す (2026-07-28 社長「対応した社員の名前を右わきに表示」)
  const ackMap = {}, ackNoteMap = {}, ackWhoMap = {}, ackAtMap = {};
  if (wpIds.length) {
    const ph = wpIds.map(() => '?').join(',');
    db.prepare(`SELECT w.id, w.ack_status, w.ack_note, w.ack_at, u.display_name AS ack_by_name
                FROM wellness_posts w
                LEFT JOIN users u ON u.id = w.ack_by
                WHERE w.id IN (${ph})`).all(...wpIds)
      .forEach(w => {
        ackMap[w.id] = w.ack_status || '未対応';
        ackNoteMap[w.id] = w.ack_note || '';
        ackWhoMap[w.id] = w.ack_by_name || '';
        ackAtMap[w.id] = jstHM(w.ack_at);   // ack_at はUTC保存
      });
  }
  const byTarget = {}; recs.forEach(r => { byTarget[r.target_id] = r; });
  let done = 0, uMid = 0, uHigh = 0, bpHigh = 0, gStop = 0, gRecheck = 0, gRestrict = 0, gCheck = 0;
  const entries = roster.map(m => {
    const r = byTarget[m.id];
    if (!r) return { uid: m.id, name: m.display_name, company_code: m.company_code, job_role: m.job_role, done: false };
    done++;
    if (r.urgency === '中') uMid++; else if (r.urgency === '高') uHigh++;
    if ((r.bp_systolic && r.bp_systolic >= 160) || (r.bp_diastolic && r.bp_diastolic >= 100)) bpHigh++;
    let h = {}; try { h = JSON.parse(r.health_json || '{}') || {}; } catch (e) {}
    // 乗務ゲート (2026-08-03)。当日表の血圧欄に 🚫/⚠️ を出すための判定。件数はドライバーのみ。
    const gate = dutyGate(m.job_role, r.bp_systolic, r.bp_diastolic, h, r.condition,
      { peakSys: r.bp_peak_sys, peakDia: r.bp_peak_dia, count: r.bp_count });
    if (gate.driver) {
      if (gate.status === 'stop_final' || gate.status === 'stop_recheck') gStop++;
      else if (gate.status === 'symptom_check') gCheck++;
      else if (gate.status === 'restrict') gRestrict++;
      else if (gate.status === 'recheck') gRecheck++;
    }
    return { uid: m.id, name: m.display_name, company_code: m.company_code, job_role: m.job_role, done: true,
      source: r.mode, urgency: r.urgency, done_at: jstHM(r.updated_at),
      bp: (r.bp_systolic || r.bp_diastolic) ? { s: r.bp_systolic, d: r.bp_diastolic, p: r.pulse } : null,
      gate, health: h, condition: r.condition, note: r.note,
      wp_id: r.wellness_post_id || null,
      ack_status: r.wellness_post_id ? (ackMap[r.wellness_post_id] || '未対応') : null,
      ack_note: r.wellness_post_id ? (ackNoteMap[r.wellness_post_id] || '') : '',
      ack_by_name: r.wellness_post_id ? (ackWhoMap[r.wellness_post_id] || '') : '',
      ack_at: r.wellness_post_id ? (ackAtMap[r.wellness_post_id] || '') : '' };
  });
  const total = roster.length;

  // --- 未確認キュー (点呼由来・未対応・期間内)。バッジ件数も兼ねる ---
  const coClause = allCo ? '' : ' AND wp.company_code = ?';
  const srcPh = TENKO_SOURCES.map(() => '?').join(',');
  const queueArgs = [...TENKO_SOURCES, since + ' 00:00:00'].concat(allCo ? [] : [co]);
  const queue = db.prepare(`SELECT wp.id, wp.urgency, wp.memo, wp.source_type, wp.company_code,
      substr(wp.created_at,1,16) AS at, u.display_name AS subject
    FROM wellness_posts wp LEFT JOIN users u ON u.id = wp.subject_user_id
    WHERE wp.category IN ('体調','帰庫点呼') AND COALESCE(wp.ack_status,'未対応')='未対応'
      AND wp.source_type IN (${srcPh}) AND wp.created_at >= ?${coClause}
    ORDER BY CASE wp.urgency WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, wp.id DESC LIMIT 300`).all(...queueArgs);
  const unhandled = queue.length;

  // --- 累計 (期間: 実施率推移 + 中/高件数推移 + 頻発者 + 項目傾向) ---
  const recRange = allCo
    ? db.prepare(`SELECT rec_date, target_id, urgency, health_json FROM tenko_records WHERE rec_date >= ? AND rec_date <= ?`).all(since, date)
    : db.prepare(`SELECT rec_date, target_id, urgency, health_json FROM tenko_records WHERE rec_date >= ? AND rec_date <= ? AND company_code = ?`).all(since, date, co);
  const series = {}, freq = {}, tally = {};
  recRange.forEach(r => {
    const d = series[r.rec_date] = series[r.rec_date] || { date: r.rec_date, done: 0, mid: 0, high: 0 };
    d.done++;
    if (r.urgency === '中') { d.mid++; freq[r.target_id] = (freq[r.target_id] || 0) + 1; }
    else if (r.urgency === '高') { d.high++; freq[r.target_id] = (freq[r.target_id] || 0) + 1; }
    let h = {}; try { h = JSON.parse(r.health_json || '{}') || {}; } catch (e) {}
    Object.keys(HC_LABELS).forEach(k => { if (h[k] != null) { tally[k] = tally[k] || {}; tally[k][h[k]] = (tally[k][h[k]] || 0) + 1; } });
  });
  const rate_series = Object.values(series).sort((a, b) => a.date < b.date ? -1 : 1)
    .map(d => ({ date: d.date, done: d.done, mid: d.mid, high: d.high, rate: total ? Math.round(d.done * 1000 / total) / 10 : 0 }));
  const nameMap = {}; roster.forEach(m => { nameMap[m.id] = m.display_name; });
  const freqTop = Object.entries(freq).map(([uid, c]) => ({ uid, count: c })).sort((a, b) => b.count - a.count).slice(0, 10);
  const missing = freqTop.map(f => f.uid).filter(id => !nameMap[id]);
  if (missing.length) {
    const ph = missing.map(() => '?').join(',');
    db.prepare(`SELECT id, display_name FROM users WHERE id IN (${ph})`).all(...missing).forEach(u => { nameMap[u.id] = u.display_name; });
  }
  const frequent = freqTop.map(f => ({ uid: f.uid, name: nameMap[f.uid] || '(不明)', count: f.count }));

  const companies = hq
    ? db.prepare(`SELECT DISTINCT company_code FROM users WHERE COALESCE(role,'')<>'bot' AND company_code IS NOT NULL AND company_code<>'' ORDER BY company_code`).all().map(x => x.company_code)
    : [me.company_code];

  res.json({
    success: true, date, period, since, hq, co,
    today: { total, done, not_done: total - done, rate: total ? Math.round(done * 1000 / total) / 10 : 0,
      urgency: { mid: uMid, high: uHigh }, bp_high: bpHigh,
      gate_stop: gStop, gate_recheck: gRecheck, gate_restrict: gRestrict, gate_check: gCheck, entries },
    unhandled, queue,
    cumulative: { item_labels: HC_LABELS, rate_series, frequent, tally },
    companies,
  });
});

// 未確認の一括確認/対応 (拠点スコープ内のみ)
router.post('/ack', authUser, express.json(), (req, res) => {
  const db = getDb();
  const me = getViewer(req.uid);
  if (!canViewBoard(me)) return res.status(403).json({ success: false, msg: '権限がありません' });
  const hq = !!(me.role === 'admin' || me.employee_type === 'admin' || me.is_guest_reviewer);
  const ids = Array.isArray(req.body && req.body.post_ids)
    ? req.body.post_ids.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n)) : [];
  const status = ['未対応', '確認済', '対応済'].includes(req.body && req.body.status) ? req.body.status : null;
  if (!ids.length || !status) return res.status(400).json({ success: false, msg: 'post_ids と status が必要です' });
  // 🔴高リスク者の対応時に点呼者が記録する「声かけ・処置内容」。空なら既存メモは温存(上書きしない)。
  const note = String((req.body && req.body.note) || '').trim().slice(0, 1000);
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, company_code FROM wellness_posts WHERE id IN (${ph})`).all(...ids);
  const allowed = rows.filter(r => hq || r.company_code === me.company_code).map(r => r.id);
  if (!allowed.length) return res.status(403).json({ success: false, msg: '対象が拠点スコープ外です' });
  const ph2 = allowed.map(() => '?').join(',');
  const at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (note) {
    db.prepare(`UPDATE wellness_posts SET ack_status=?, ack_by=?, ack_at=?, ack_note=? WHERE id IN (${ph2})`).run(status, me.id, at, note, ...allowed);
  } else {
    db.prepare(`UPDATE wellness_posts SET ack_status=?, ack_by=?, ack_at=? WHERE id IN (${ph2})`).run(status, me.id, at, ...allowed);
  }
  res.json({ success: true, updated: allowed.length, status });
});

// ===== かんたんモード(タブレット)からの「現場の声」報告 (2026-07-03) =====
// 一般社員がタブレットの簡易ページから困りごと・気づきを報告 → 現場の声(g_field_voice)へ投稿し推進/管理職へ配信。
router.post('/field-report', authUser, express.json(), (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ success: false, msg: '報告内容を入力してください' });
  const db = getDb();
  const u = db.prepare('SELECT id, display_name, company_code FROM users WHERE id = ?').get(req.uid) || {};
  const content = `📣 【現場の声】${u.display_name || ''}さん（${u.company_code || '-'}）\n─\n${text}`;
  const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, NULL, ?, ?)")
    .run(req.uid, content, 'grp_' + FIELD_VOICE_GROUP);
  try {
    if (req.app && req.app.locals && req.app.locals.emitToGroupMembers) {
      req.app.locals.emitToGroupMembers(FIELD_VOICE_GROUP, 'group:msg', {
        id: ins.lastInsertRowid, from: req.uid, group_id: FIELD_VOICE_GROUP,
        content, at: new Date().toISOString(), attach: null,
      });
    }
  } catch (e) { console.warn('[field-report emit]', e.message); }
  res.json({ success: true, id: ins.lastInsertRowid });
});

// ===== 帰庫点呼(乗務後点呼) ドライバー自己申告の補助ツール (2026-07-09) =====
// ※認定された自動点呼ソフトではない。点呼の主体は運行管理者(ボード上で承認=点呼執行者)。
// JST(+9h)基準の 'YYYY-MM-DD HH:MM'
const jstStamp = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');

// 帰庫点呼の葵コメント生成。本人の前回/直近平均/当日の営業所平均を踏まえ、毎回変化する ねぎらい文。
// ⚠️「疲れて当然」等 疲労を軽視する表現は禁止(ハラスメント)。共感・いたわりのみ。「頑張れ」等の叱咤もしない。
function buildKikoComment(db, me, date, fScore, bScore, jobKind) {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const isDrv = (jobKind || 'driver') === 'driver';
  const bossWord = isDrv ? '運行管理者' : '管理者';
  const parts = [];
  parts.push(pick(isDrv
    ? ['今日も 一日 おつかれさまでした。', '今日も 安全運転 ありがとうございました。', 'おかえりなさい。今日も おつかれさまでした。']
    : ['今日も 一日 おつかれさまでした。', '今日も お仕事 ありがとうございました。', '今日も よく 頑張られましたね。おつかれさまでした。']));
  if (fScore == null) return parts.join(' ');

  let prevF = null, avgF = null, brA = null;
  try {
    const p = db.prepare("SELECT fatigue_score FROM tenko_kiko WHERE driver_id=? AND rec_date<? AND fatigue_score IS NOT NULL ORDER BY rec_date DESC, id DESC LIMIT 1").get(me.id, date);
    prevF = p ? p.fatigue_score : null;
    const a = db.prepare("SELECT AVG(fatigue_score) a, COUNT(*) c FROM tenko_kiko WHERE driver_id=? AND rec_date<? AND rec_date>=date(?,'-30 day') AND fatigue_score IS NOT NULL").get(me.id, date, date);
    avgF = (a && a.c >= 3 && a.a != null) ? a.a : null;
    const br = db.prepare("SELECT AVG(fatigue_score) a, COUNT(*) c FROM tenko_kiko WHERE company_code=? AND rec_date=? AND fatigue_score IS NOT NULL").get(me.company_code || '', date);
    brA = (br && br.c >= 2 && br.a != null) ? br.a : null;
  } catch (e) {}

  if (fScore >= 9) {
    parts.push(pick(['かなり お疲れの ようですね。よく 頑張られました。', '今日は とても お疲れの ようです。本当に おつかれさまでした。']));
    parts.push('ご無理は 禁物です。'+bossWord+'にも お伝えしました。今夜は 早めに 休んでください。');
  } else {
    if (prevF != null && fScore <= prevF - 2) parts.push(pick(['きのうより 楽そうで 何よりです。', 'きのうより 元気そうですね。']));
    else if (prevF != null && fScore >= prevF + 2) parts.push(pick(['きのうより 少し お疲れが 出ている かもしれませんね。', 'きのうより お疲れの ようですね。']));
    else if (avgF != null && fScore <= avgF - 2) parts.push('いつもより 楽そうで 何よりです。');
    else if (avgF != null && fScore >= avgF + 2) parts.push(pick(['いつもより お疲れの ようですね。', 'いつもより 少し お疲れが 出ているかも しれません。']));
    else parts.push(pick(['今日も よく 頑張られました。', 'いつも 安定していて さすがです。']));
    if (fScore >= 6 || (bScore != null && bScore >= 6)) parts.push(pick(['今夜は 早めに 休んで、しっかり 睡眠を とってください。', 'ぬるめの お風呂で 体を ほぐし、水分も とりましょう。']));
    else parts.push(pick(['水分を コップ1杯 とって、ひと息 つきましょう。', '首と 肩を ゆっくり 回して、体を ほぐしましょう。', 'ゆっくり 深呼吸を 3回。お疲れを リセットしましょう。']));
  }
  if (bScore != null && bScore >= 7 && fScore < 9) parts.push('体の 調子が 気になる ときは、無理を せず 早めに 休んでくださいね。');
  if (brA != null && brA >= 6 && fScore >= 5) parts.push(pick(['今日は 営業所の みんなも お疲れ気味です。おたがいさま、どうぞ 無理を なさらずに。', '今日は みんな よく 頑張った 一日でした。おたがい ゆっくり 休みましょう。']));
  return parts.join(' ');
}

// ドライバーが帰庫時に自己申告 (アルコール検知有無/運行状況/ヒヤリハット/荷待ち時間/つかれ・からだ)。
// 検知あり・異常は運管へ即エスカレ。
router.post('/kiko', authUser, express.json(), (req, res) => {
  const db = getDb();
  const me = getOperator(req.uid);
  if (!me) return res.status(401).json({ success: false });
  const b = req.body || {};
  const alcoholDetected = b.alcohol_detected ? 1 : 0;
  const operationIssue = b.operation_issue ? 1 : 0;
  const opNote = (b.operation_note || '').toString().slice(0, 500) || null;
  const reliefNote = (b.relief_note || '').toString().slice(0, 500) || null;   // 旧「交替連絡」互換(新UIからは送られない)
  const hiyari = b.hiyari ? 1 : 0;
  const hiyariNote = (b.hiyari_note || '').toString().slice(0, 500) || null;
  const waitLevel = ['none', 'lt60', 'gt60'].includes(b.wait_level) ? b.wait_level : null;
  const waitNote = (b.wait_note || '').toString().slice(0, 200) || null;
  const note = (b.note || '').toString().slice(0, 500) || null;
  // 職種は本人のマスタから決める(クライアント値は信用しない)。driver以外は法定点呼ではない「帰る前のチェック」。
  const jobKind = me.job_role === 'driver' ? 'driver'
    : me.job_role === 'warehouse' ? 'warehouse'
      : me.job_role === 'manufacturing' ? 'manufacturing' : 'office';
  // 職種固有の回答。ホワイトリスト検証してから extra_json に格納。
  const pick = (v, list) => (list.includes(v) ? v : null);
  const clampMind = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null; };
  const extra = {
    pain: pick(b.pain, ['none', 'mild', 'hard']),
    pain_note: (b.pain_note || '').toString().slice(0, 200) || null,
    symptom: pick(b.symptom, ['none', 'dizzy', 'irritation']),
    symptom_note: (b.symptom_note || '').toString().slice(0, 200) || null,
    overtime: pick(b.overtime, ['none', 'lt1', 'gt2']),
    eye: pick(b.eye, ['none', 'mild', 'hard']),
    mind_score: clampMind(b.mind_score),
  };
  Object.keys(extra).forEach((k) => { if (extra[k] == null) delete extra[k]; });
  const extraJson = Object.keys(extra).length ? JSON.stringify(extra) : null;
  // 0〜10の自己評価(10=しんどい)。つかれ=fatigue_score / からだ=body_score
  const clamp10 = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null; };
  const fScore = clamp10(b.fatigue_score);
  const bScore = clamp10(b.body_score);
  // 互換のため段階(fatigue_level)も導出(fine/tired/very_tired)
  const fatigue = fScore == null
    ? (['fine', 'tired', 'very_tired'].includes(b.fatigue_level) ? b.fatigue_level : null)
    : (fScore >= 9 ? 'very_tired' : fScore >= 4 ? 'tired' : 'fine');
  const highFatigue = fScore != null && fScore >= 9;
  const highBody = bScore != null && bScore >= 9;
  const date = jstDate();

  // 職種固有のエスカレ条件(2026-07-27)。
  //  倉庫=腰・肩・ひざの痛みが「つらい」/ 製造=作業中の体調の異変あり(化学物質・粉じん・暑熱) / 事務=こころ9以上。
  //  ⚠️ヒヤリハットと時間外は通知しない(ヒヤリは"報告すると騒ぎになる"と報告が止まる。時間外は勤怠側で見る)。
  const hardPain = extra.pain === 'hard';
  const hasSymptom = extra.symptom && extra.symptom !== 'none';
  const lowMind = extra.mind_score != null && extra.mind_score >= 9;
  const KIND_LABEL = { driver: '帰庫点呼', warehouse: '帰る前のチェック（倉庫）', manufacturing: '帰る前のチェック（製造）', office: '帰る前のチェック（事務）' };
  const kindLabel = KIND_LABEL[jobKind];
  const issueLabel = jobKind === 'driver' ? '運行の異常あり' : '設備・荷・製品の異常あり';
  const selfLabel = jobKind === 'driver' ? '乗務後の自己申告' : '退勤前の自己申告';

  // 🔴酒気帯び検知 / ⚠️異常 / 😫つかれ・からだが9以上 / 職種固有 は運管(現場の声グループ)へ即通知
  let wpId = null;
  if (alcoholDetected || operationIssue || highFatigue || highBody || hardPain || hasSymptom || lowMind) {
    try {
      const flags = [];
      if (alcoholDetected) flags.push('🔴 酒気帯び 検知あり');
      if (operationIssue) flags.push('⚠️ ' + issueLabel + (opNote ? '（' + opNote + '）' : ''));
      if (highFatigue) flags.push(`😫 つかれ ${fScore}/10（${selfLabel}）`);
      if (highBody) flags.push(`🩹 からだの不調 ${bScore}/10（${selfLabel}）`);
      if (hardPain) flags.push('💪 腰・肩・ひざの痛みが「つらい」' + (extra.pain_note ? '（' + extra.pain_note + '）' : ''));
      if (hasSymptom) flags.push('😵 作業中の体調の異変（' + (extra.symptom === 'dizzy' ? 'めまい・頭痛' : '目やのどの刺激') + '）' + (extra.symptom_note ? '（' + extra.symptom_note + '）' : ''));
      if (lowMind) flags.push(`🫧 こころの調子 ${extra.mind_score}/10（${selfLabel}）`);
      // 酒気帯び・異常=高、体調系のみ=中
      const urg = (alcoholDetected || operationIssue) ? '高' : '中';
      const memo = `【${kindLabel}】${me.display_name}さん: ${flags.join(' / ')}`;
      const insWp = db.prepare(`INSERT INTO wellness_posts
        (poster_id, company_code, category, urgency, identity_mode, memo, source_type, subject_user_id, structured_json)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(me.id, me.company_code || '', '帰庫点呼', urg, '本人特定可', memo, '帰庫', me.id,
             JSON.stringify({ job_kind: jobKind, alcohol_detected: !!alcoholDetected, operation_issue: !!operationIssue, operation_note: opNote, fatigue_score: fScore, body_score: bScore, fatigue_level: fatigue, extra }));
      wpId = insWp.lastInsertRowid;
      const icon = jobKind === 'driver' ? '🚚' : jobKind === 'warehouse' ? '📦' : jobKind === 'manufacturing' ? '🏭' : '🏢';
      const content = `${icon} ${kindLabel} #${wpId}\n営業所: ${me.company_code || '-'}　${jobKind === 'driver' ? '運転者' : '本人'}: ${me.display_name}\n─\n${flags.join('\n')}`;
      const msgIns = db.prepare('INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, NULL, ?, ?)')
        .run(me.id, content, 'grp_' + FIELD_VOICE_GROUP);
      if (req.app && req.app.locals && req.app.locals.emitToGroupMembers) {
        req.app.locals.emitToGroupMembers(FIELD_VOICE_GROUP, 'group:msg', {
          id: msgIns.lastInsertRowid, from: me.id, group_id: FIELD_VOICE_GROUP,
          content, at: new Date().toISOString(), attach: null,
        });
      }
    } catch (e) { console.warn('[kiko escalate]', e.message); }
  }

  const ins = db.prepare(`INSERT INTO tenko_kiko
    (rec_date, driver_id, driver_name, company_code, kiko_at, alcohol_used, alcohol_detected, operation_issue,
     operation_note, relief_note, note, fatigue_level, fatigue_score, body_score, wellness_post_id,
     hiyari, hiyari_note, wait_level, wait_note, job_kind, extra_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(date, me.id, me.display_name, me.company_code || '', jstStamp(),
         b.alcohol_used === 0 ? 0 : 1, alcoholDetected, operationIssue, opNote, reliefNote, note, fatigue, fScore, bScore, wpId,
         hiyari, hiyariNote, waitLevel, waitNote, jobKind, extraJson);

  // 葵の日替わりコメント(本人の前回/平均/営業所平均を踏まえた ねぎらい)
  let aoiComment = '';
  try { aoiComment = buildKikoComment(db, me, date, fScore, bScore, jobKind); } catch (e) { console.warn('[kiko comment]', e.message); }

  res.json({ success: true, id: ins.lastInsertRowid, escalated: !!wpId, aoi_comment: aoiComment });
});

// 管理者/点呼者: 当日の帰庫点呼一覧 (本社admin/推進は全拠点・他は自拠点)
router.get('/kiko', authUser, (req, res) => {
  const db = getDb();
  const me = getOperator(req.uid);
  if (!isOperator(me)) return res.status(403).json({ success: false, msg: '点呼者・管理者のみ' });
  const date = String(req.query.date || jstDate()).slice(0, 10);
  const crossView = canCrossCompany(me);
  // 2026-07-21: ?co= が指定されると crossView 判定を通らず、他拠点の帰庫点呼
  // (酒気帯び・疲労・体調・稼働時間)を実名付きで閲覧できた
  const co = crossView ? (req.query.co || '') : '';
  // 出庫(乗務前点呼=当日の tenko_records)〜帰庫までの稼働時間を算出。
  // ⚠️tenko_records.created_at はUTC・kiko_at はJST → 出庫を +9時間 でJST化して差分。
  // rec_date+target_id はユニークなので当日1件のみ結合。
  let sql = `SELECT k.*,
      datetime(r.created_at, '+9 hours') AS depart_at,
      CAST(round((julianday(k.kiko_at) - julianday(datetime(r.created_at, '+9 hours'))) * 1440) AS INTEGER) AS work_minutes
    FROM tenko_kiko k
    LEFT JOIN tenko_records r ON r.target_id = k.driver_id AND r.rec_date = k.rec_date
    WHERE k.rec_date = ?`;
  const params = [date];
  if (co) { sql += ' AND k.company_code = ?'; params.push(co); }
  else if (!crossView) { sql += ' AND k.company_code = ?'; params.push(me.company_code || ''); }
  sql += ' ORDER BY k.kiko_at DESC, k.id DESC';
  const items = db.prepare(sql).all(...params);
  // 各ドライバーの「平常値」を併記用に付与(直近30日・当日より前・3件以上の平均)。
  // ⚠️鹿島など習慣的に高得点を出す人がいるため、当日値だけでなく本人の平常も並べて運管が判断できるように。
  try {
    const ids = [...new Set(items.map(i => i.driver_id))];
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const base = {};
      db.prepare(`SELECT driver_id,
          AVG(fatigue_score) af, COUNT(fatigue_score) cf,
          AVG(body_score) ab, COUNT(body_score) cb
        FROM tenko_kiko
        WHERE driver_id IN (${ph}) AND rec_date >= date(?, '-30 day') AND rec_date < ?
        GROUP BY driver_id`).all(...ids, date, date)
        .forEach(b => { base[b.driver_id] = b; });
      const r1 = (v, c) => (c >= 3 && v != null) ? Math.round(v * 10) / 10 : null;   // 3件以上でのみ平常値を出す
      items.forEach(i => {
        const b = base[i.driver_id];
        i.fatigue_base = b ? r1(b.af, b.cf) : null;
        i.body_base = b ? r1(b.ab, b.cb) : null;
      });
    }
  } catch (e) { console.warn('[kiko base]', e.message); }
  res.json({ success: true, date, items });
});

// 点呼執行者(運管)による帰庫点呼の承認
router.post('/kiko/:id/approve', authUser, (req, res) => {
  const db = getDb();
  const me = getOperator(req.uid);
  if (!isOperator(me)) return res.status(403).json({ success: false, msg: '点呼者・管理者のみ' });
  const id = parseInt(req.params.id);
  const at = jstStamp();
  const r = db.prepare('UPDATE tenko_kiko SET approved_by=?, approved_by_name=?, approved_at=? WHERE id=?')
    .run(me.id, me.display_name, at, id);
  if (!r.changes) return res.status(404).json({ success: false, msg: '対象なし' });
  res.json({ success: true, approved_at: at, approved_by_name: me.display_name });
});

// ===== 🧰 職種(job_role)の設定 2026-07-27 =====
// 「帰る前のチェック」の内容は職種で決まるが、既存社員の職種を直せるのは管理画面(6名限定)だけだった。
// → 現場を分かっている 点呼者・管理職・推進・所長(isOperator) が自拠点ぶんを直せるようにする。
// ⚠️変えられるのは driver/warehouse/manufacturing/office の4つだけ。
//   manager/executive(役職)は権限に直結するので対象外(表示のみ・変更は管理画面)。
//   employee_type も触らない(詳細画面の可否など権限に直結するため)。
const JOB_ROLE_EDITABLE = ['driver', 'warehouse', 'manufacturing', 'office'];

router.get('/job-roles', authUser, (req, res) => {
  const db = getDb();
  const me = getOperator(req.uid);
  if (!isOperator(me)) return res.status(403).json({ success: false, msg: '点呼者・管理者のみ' });
  const crossView = canCrossCompany(me);
  const co = crossView ? String(req.query.co || '') : String(me.company_code || '');
  let sql = `SELECT id, display_name, company_code, job_role, employee_type
    FROM users WHERE status != '退職' AND employee_type != 'bot'`;
  const params = [];
  if (co) { sql += ' AND company_code = ?'; params.push(co); }
  sql += " ORDER BY (job_role IS NULL OR job_role = '') DESC, company_code, display_name";
  const items = db.prepare(sql).all(...params);
  res.json({ success: true, cross: crossView, co, editable: JOB_ROLE_EDITABLE, items });
});

router.post('/job-role', authUser, express.json(), (req, res) => {
  const db = getDb();
  const me = getOperator(req.uid);
  if (!isOperator(me)) return res.status(403).json({ success: false, msg: '点呼者・管理者のみ' });
  const uid = String((req.body && req.body.user_id) || '');
  const jr = String((req.body && req.body.job_role) || '');
  if (!JOB_ROLE_EDITABLE.includes(jr)) return res.status(400).json({ success: false, msg: '職種の指定が不正です' });
  const t = db.prepare('SELECT id, display_name, company_code, job_role, employee_type FROM users WHERE id = ?').get(uid);
  if (!t) return res.status(404).json({ success: false, msg: '対象が見つかりません' });
  // 自拠点のみ(本社admin・推進は全拠点)
  if (!canCrossCompany(me) && String(t.company_code || '') !== String(me.company_code || '')) {
    return res.status(403).json({ success: false, msg: '自分の拠点の方のみ変更できます' });
  }
  // 役職者(manager/executive)は管理画面でのみ変更可
  if (t.job_role === 'manager' || t.job_role === 'executive') {
    return res.status(403).json({ success: false, msg: '管理職・役員の職種は管理画面でのみ変更できます' });
  }
  db.prepare('UPDATE users SET job_role = ? WHERE id = ?').run(jr, uid);
  try {
    require('../services/audit').audit(req, 'job_role_update', {
      actor_name: me.display_name,
      target: `${t.display_name}(${t.company_code || '-'}) ${t.job_role || '未設定'} → ${jr}`,
    });
  } catch (e) { console.warn('[job_role audit]', e.message); }
  res.json({ success: true, job_role: jr });
});

// ===== 帰庫点呼のお知らせ (管理者が入力したテキストを帰庫点呼画面で葵が読み上げる) 2026-07-09 =====
// app_settings(key='kiko_notice')に {text, by, at} をJSONで保持。
// 読取=ドライバーも見る/聞くので authUser のみ。編集=点呼者・管理者。
router.get('/kiko/notice', authUser, (req, res) => {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = 'kiko_notice'").get();
  let data = { text: '', by: '', at: '' };
  if (row && row.value) {
    try { data = JSON.parse(row.value); } catch (e) { data = { text: row.value, by: '', at: '' }; }
  }
  res.json({ success: true, notice: data.text || '', updated_by_name: data.by || '', updated_at: data.at || '' });
});

router.post('/kiko/notice', authUser, express.json(), (req, res) => {
  const me = getOperator(req.uid);
  if (!isOperator(me)) return res.status(403).json({ success: false, msg: '点呼者・管理者のみ' });
  const text = String(req.body && req.body.notice != null ? req.body.notice : '').slice(0, 2000);
  const at = jstStamp();
  const value = JSON.stringify({ text, by: me.display_name || '', at });
  getDb().prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('kiko_notice', ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(value);
  res.json({ success: true, notice: text, updated_by_name: me.display_name, updated_at: at });
});

// ===== ドライバー本人: 本日の帰庫点呼の実施状況 (タブレットで「まだです」と促す用) 2026-07-14 =====
// authUser のみ(本人分のみ)。当日(JST)の tenko_kiko が1件でもあれば done。
router.get('/kiko/mine', authUser, (req, res) => {
  try {
    const date = jstDate();
    const row = getDb().prepare(
      "SELECT COUNT(*) c, MAX(kiko_at) last_at FROM tenko_kiko WHERE driver_id = ? AND rec_date = ?"
    ).get(req.uid, date);
    res.json({ success: true, done: !!(row && row.c > 0), count: row ? row.c : 0, last_at: row ? row.last_at : null });
  } catch (e) {
    res.json({ success: true, done: false, count: 0 });
  }
});

// ===== 健康チェックの追加質問 (管理者が任意に追加→朝の体調チェックに反映) 2026-07-14 =====
// app_settings(key='health_custom_items')に配列JSONを保持。
// 読取=全員(ドライバーが回答を描画する)。編集=推進メンバー・管理職(canViewBoard)。
router.get('/health-items', authUser, (req, res) => {
  res.json({ success: true, items: getHealthCustomItems() });
});

router.post('/health-items', authUser, express.json(), (req, res) => {
  const me = getViewer(req.uid);
  if (!canViewBoard(me)) return res.status(403).json({ success: false, msg: '推進メンバー・管理職のみ編集できます' });
  const raw = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  const items = [];
  const used = {};
  raw.slice(0, 12).forEach((it, i) => {
    const q = String((it && it.q) || '').trim().slice(0, 100);
    if (!q) return;
    let opts = (Array.isArray(it && it.opts) ? it.opts : []).map((o) => {
      const label = String((Array.isArray(o) ? o[0] : (o && o.label)) || '').trim().slice(0, 24);
      let value = String((Array.isArray(o) ? o[1] : (o && o.value)) || '').trim().slice(0, 24);
      if (!value) value = label;
      return label ? [label, value] : null;
    }).filter(Boolean).slice(0, 8);
    if (!opts.length) opts = [['はい', 'yes'], ['いいえ', 'no']];
    // 既存キーは温存(過去回答との対応を保つ)。無効/重複時のみ採番。
    let key = String((it && it.key) || '').trim();
    if (!/^cx_[A-Za-z0-9]{1,16}$/.test(key) || used[key]) key = 'cx_' + (i + 1);
    while (used[key]) key = key + 'x';
    used[key] = 1;
    items.push({ key, q, opts });
  });
  const value = JSON.stringify(items);
  const at = jstStamp();
  getDb().prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('health_custom_items', ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(value);
  res.json({ success: true, items, updated_by_name: me.display_name, updated_at: at });
});

// ===== 気にかけダッシュボード (2026-07-15) =====
// 管理職を"活動(コメント件数)"でなく"ケア(声かけ・未対応の拾い)"で見るための集計。
// 現場の声(wellness_posts)の ack を「声をかけた」記録として流用: 未対応=まだ声をかけていない気がかり / 対応済=声かけ実績。
// canViewBoard(管理職/推進/所長/運管)のみ。本社adminは全拠点、他は自拠点スコープ。
router.get('/care-board', authUser, (req, res) => {
  const db = getDb();
  const me = getViewer(req.uid);
  if (!canViewBoard(me)) return res.status(403).json({ success: false, msg: 'この画面は推進メンバー・管理職のみ閲覧できます' });
  const hq = !!(me.role === 'admin' || me.employee_type === 'admin' || me.is_guest_reviewer);
  const co = hq ? String(req.query.co || '') : (me.company_code || '');
  const scoped = !(hq && !co);       // true=拠点で絞る
  const P = scoped ? [co] : [];

  // ① 未対応の気がかり(まだ声をかけていない) 古い順
  const pending = db.prepare(
    `SELECT w.id, w.company_code, w.category, w.urgency, w.source_type, w.memo, w.created_at, w.subject_user_id,
            w.structured_json,
            u.display_name AS subject_name,
            CAST(julianday('now') - julianday(w.created_at) AS INTEGER) AS days
     FROM wellness_posts w LEFT JOIN users u ON u.id = w.subject_user_id
     WHERE COALESCE(w.ack_status,'未対応')='未対応'` + (scoped ? ' AND w.company_code = ?' : '') +
    ` ORDER BY w.created_at ASC LIMIT 100`
  ).all(...P)
    // 理由は判定と同じ根拠(structured_json)から作る。⚠️memoの文字列一致で作らないこと(careReason参照)。
    // structured_json 自体は返さない(健康回答の生データをボードに流さない)。
    .map(({ structured_json, ...r }) => ({ ...r, reason: careReason(structured_json) }));

  // ② 営業所別: 未対応 / 直近30日の声かけ(対応済)
  const byOffice = db.prepare(
    `SELECT company_code,
       SUM(CASE WHEN COALESCE(ack_status,'未対応')='未対応' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN ack_status='対応済' AND ack_at >= datetime('now','-30 day') THEN 1 ELSE 0 END) AS cared30
     FROM wellness_posts WHERE 1=1` + (scoped ? ' AND company_code = ?' : '') +
    ` GROUP BY company_code ORDER BY pending DESC, cared30 DESC`
  ).all(...P);

  // ③ 対応者別(直近30日): 誰が声をかけたか = 気にかけている管理職
  const byHandler = db.prepare(
    `SELECT w.ack_by, u.display_name AS handler_name, COUNT(*) AS cared
     FROM wellness_posts w LEFT JOIN users u ON u.id = w.ack_by
     WHERE w.ack_status='対応済' AND w.ack_at >= datetime('now','-30 day') AND w.ack_by IS NOT NULL`
       + (scoped ? ' AND w.company_code = ?' : '') +
    ` GROUP BY w.ack_by ORDER BY cared DESC LIMIT 30`
  ).all(...P);

  // ④ 帰庫点呼で疲労が高め傾向の運転者(直近7日・3件以上・平均>=7) = 声かけ候補(埋もれ防止)
  const highFatigue = db.prepare(
    `SELECT driver_id, driver_name, company_code, ROUND(AVG(fatigue_score),1) AS avg_fatigue, COUNT(*) AS n
     FROM tenko_kiko WHERE rec_date >= date('now','-7 day') AND fatigue_score IS NOT NULL`
       + (scoped ? ' AND company_code = ?' : '') +
    ` GROUP BY driver_id HAVING n >= 3 AND avg_fatigue >= 7 ORDER BY avg_fatigue DESC LIMIT 30`
  ).all(...P);

  const sumPending = byOffice.reduce((s, o) => s + (o.pending || 0), 0);
  const sumCared30 = byOffice.reduce((s, o) => s + (o.cared30 || 0), 0);
  const companies = hq
    ? db.prepare(`SELECT DISTINCT company_code FROM users WHERE COALESCE(role,'')<>'bot' AND company_code IS NOT NULL AND company_code<>'' ORDER BY company_code`).all().map(x => x.company_code)
    : [me.company_code];

  res.json({ success: true, hq, co, companies,
    totals: { pending: sumPending, cared30: sumCared30 },
    pending, by_office: byOffice, by_handler: byHandler, high_fatigue: highFatigue });
});

// ============================================================
// 点呼時の参考: その人の直近2週間の平均血圧 (2026-08-03 社長指示)
//  目的は「いつもは基準内なのに今日だけ高い＝急変の可能性」を拾うこと。
//  ⚠️⚠️平均が高いことは、今日の高値を見逃してよい理由には絶対にならない。
//     「この人はいつも高いから」は健康起因事故の典型的な前段。画面にも明記する。
//  権限: 点呼者・管理者、かつ自拠点のみ(本社admin/推進は全拠点)。
//        推移そのもの(全記録)は従来どおり BP_TREND_VIEWERS の2名限定=ここでは平均値だけ返す。
// ============================================================
router.get('/bp-recent', authUser, (req, res) => {
  const op = getOperator(req.uid);
  if (!isOperator(op)) return res.status(403).json({ success: false, msg: '点呼者・管理者のみ利用できます' });
  const db = getDb();
  const uid = String(req.query.uid || '');
  const target = db.prepare('SELECT id, company_code FROM users WHERE id = ?').get(uid);
  if (!target) return res.status(404).json({ success: false, msg: '対象が見つかりません' });
  if (!canCrossCompany(op) && String(target.company_code || '') !== String(op.company_code || '')) {
    return res.status(403).json({ success: false, msg: '他拠点の社員は参照できません' });
  }
  const days = 14;
  const since = new Date(Date.now() + 32400000 - (days - 1) * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT systolic s, diastolic d FROM bp_records
    WHERE user_id = ? AND substr(measured_at,1,10) >= ? AND systolic > 0 AND diastolic > 0`).all(uid, since);
  if (!rows.length) return res.json({ success: true, days, n: 0 });
  const avg = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const S = rows.map(r => r.s), D = rows.map(r => r.d);
  const avgS = avg(S), avgD = avg(D);
  res.json({ success: true, days, n: rows.length, avg_s: avgS, avg_d: avgD,
    max_s: Math.max(...S), max_d: Math.max(...D), avg_level: bpGateLevel(avgS, avgD) });
});

// 個人の血圧推移を確認する (2026-07-18・健康点検ボードからのドリルイン)。
// 権限=BP_TREND_VIEWERS の2名のみ(小林 猛・吉沢 佑也)。全拠点の社員を閲覧可。
router.get('/bp-trend', authUser, (req, res) => {
  const db = getDb();
  // 本人以外の血圧推移を見られるのは指定2名のみ (社長指示 2026-07-18)。
  // + 社外ゲスト(研究閲覧・2026-08-03 社長判断)。氏名は authz の研究閲覧モードで匿名化される。
  if (!BP_TREND_VIEWERS.includes(req.uid) && !isResearchViewer(req.uid)) {
    return res.status(403).json({ success: false, msg: '他の方の血圧推移は閲覧できません' });
  }
  const uid = String(req.query.uid || '');
  const target = db.prepare('SELECT id, display_name, company_code FROM users WHERE id = ?').get(uid);
  if (!target) return res.status(404).json({ success: false, msg: '対象が見つかりません' });
  // all=1 のときは期間で絞らず全記録 (半年より前の記録がある人に全データを見せる)。
  const all = String(req.query.all || '') === '1';
  let days = parseInt(req.query.days);
  if (!days || days < 7 || days > 3650) days = 120;
  const since = all ? '0000-01-01' : new Date(Date.now() + 32400000 - days * 86400000).toISOString().slice(0, 10);
  const lim = all ? 3000 : 600;
  const records = db.prepare(`SELECT systolic, diastolic, pulse, measured_at, memo
    FROM bp_records WHERE user_id = ? AND substr(measured_at,1,10) >= ?
    ORDER BY measured_at ASC LIMIT ${lim}`).all(uid, since)
    .filter(r => r.measured_at && r.systolic && r.diastolic);
  const om = db.prepare('SELECT MIN(measured_at) m FROM bp_records WHERE user_id = ?').get(uid);
  res.json({ success: true, days, all, oldest: om && om.m, name: target.display_name, company_code: target.company_code, records });
});

// タブレットの パーソナル掲示板 用: 本人宛DMのうち、公式3系統
// (運行管理=is_ops_manager/is_tenko_operator/is_branch_head、管理部=employee_type'admin'、
//  健康推進=is_field_promoter/is_warehouse_promoter) の担当者からの未読を返す。
// 個人間の私的DMは載せない(共用タブレットのため公式連絡のみ)。
router.get('/official-messages', authUser, (req, res) => {
  const db = getDb();
  const uid = req.uid;
  const official = db.prepare(`SELECT id FROM users WHERE
      is_ops_manager = 1 OR is_tenko_operator = 1 OR is_branch_head = 1
      OR employee_type = 'admin' OR is_field_promoter = 1 OR is_warehouse_promoter = 1`).all().map(r => r.id);
  if (!official.length) return res.json({ success: true, messages: [] });
  const ph = official.map(() => '?').join(',');
  // 既読も含めて返す(未読=掲示板に表示 / 既読=過去履歴フォルダへ)。read フラグ付き。
  const rows = db.prepare(
    `SELECT m.id, m.sender_id, m.content, m.created_at, m.attach_url, m.attach_type, m.attach_name,
            u.display_name AS sender_name,
            EXISTS(SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?) AS read_flag
     FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.room_code = 'dm' AND m.receiver_id = ? AND m.sender_id IN (${ph})
       AND m.created_at > datetime('now','-30 days')
     ORDER BY m.id DESC LIMIT 40`
  ).all(uid, uid, ...official);
  res.json({
    success: true,
    messages: rows.map(m => ({
      id: m.id, sender_name: m.sender_name || '',
      content: String(m.content || '').slice(0, 800),
      created_at: m.created_at, read: !!m.read_flag,
      attach_url: m.attach_url || '', attach_type: m.attach_type || '', attach_name: m.attach_name || '',
    })),
  });
});

// ============================================================
// 朝の健康チェック 日次サマリー (2026-07-31)
//  集計・本文・配信の実装は services/health_daily.js。自動配信は毎朝(既定 10:00 JST)に
//  🏥健康管理室ディスカッションへ「健康推進室」名義で1回だけ。ここは
//   ・GET  /api/tenko/daily-report          … 配信せずに本文を確認 (ボード閲覧権限)
//   ・POST /api/tenko/daily-report/send     … その場で配信 (本社ADMINのみ・date指定可)
// ============================================================
router.get('/daily-report', authUser, (req, res) => {
  const me = getViewer(req.uid);
  if (!canViewBoard(me)) return res.status(403).json({ success: false, msg: 'この機能は推進メンバー・管理職のみです' });
  try {
    const r = healthDaily.buildReport(req.query.date);
    res.json({ success: true, date: r.date, text: r.text, stats: r.stats,
      send_hour: healthDaily.sendHour(), groups: healthDaily.targetGroups(), last_sent: healthDaily.lastSent() });
  } catch (e) { res.status(500).json({ success: false, msg: e.message }); }
});
router.post('/daily-report/send', authUser, (req, res) => {
  const me = getViewer(req.uid);
  if (!(me && (me.role === 'admin' || me.employee_type === 'admin'))) {
    return res.status(403).json({ success: false, msg: 'この操作は管理者のみです' });
  }
  try {
    const r = healthDaily.sendDaily(req.app.locals, { date: (req.body && req.body.date) || '' });
    res.json({ success: true, date: r.date, sent: r.sent, text: r.text });
  } catch (e) { res.status(500).json({ success: false, msg: e.message }); }
});

module.exports = router;
