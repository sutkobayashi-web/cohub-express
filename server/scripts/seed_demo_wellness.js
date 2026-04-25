// CoHub Wellness デモシード投入スクリプト
// 推進メンバー4名から過去3週間の運管POST 10件、健康管理室GC議論3件、完了済施策2件、進行中1件、候補1件
// 実行: node server/scripts/seed_demo_wellness.js
// 既存データを汚染しないよう、ID範囲を確認してから投入する設計

const path = require('path');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'demo-seed-only';
const { getDb } = require(path.join(__dirname, '..', 'services', 'db'));

const db = getDb();

// 推進メンバーのIDを取得
const promoters = db.prepare(`
  SELECT id, login_id, display_name, company_code FROM users
  WHERE login_id IN ('y_yoshizawa','a_yamada','e_sugai','taketake')
`).all();
if (promoters.length < 4) { console.error('推進メンバー4名揃っていません'); process.exit(1); }

const byLogin = Object.fromEntries(promoters.map(p => [p.login_id, p]));
const ADMIN = byLogin.taketake;

// ヘルパー: N日前の日時 (SQLite datetime形式)
function daysAgo(n, h = 9) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, Math.floor(Math.random() * 60), 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// 既存の demo_seeded フラグでスキップ判定
const seededMarker = db.prepare("SELECT 1 FROM wellness_posts WHERE memo LIKE '%[DEMO_SEED]%' LIMIT 1").get();
if (seededMarker) {
  console.log('既にdemo seedingされています、スキップ');
  process.exit(0);
}

// ============================================================
// 1. 運管POST 10件 (過去3週間想定)
// ============================================================
const posts = [
  // 体調系 (3件)
  { promoter: 'y_yoshizawa', cat: '体調', urg: '中', id_mode: '本人特定可',
    memo: '佐藤さん、朝礼で腰の張り訴え。先週から続いているとのこと。配車を軽めにしてあげたい [DEMO_SEED]', days: 17 },
  { promoter: 'e_sugai', cat: '体調', urg: '中', id_mode: '匿名',
    memo: '50代ドライバー、夏前から疲れが取れにくいとの声。腰痛訴える人が複数 [DEMO_SEED]', days: 12 },
  { promoter: 'y_yoshizawa', cat: '体調', urg: '低', id_mode: '集計のみ',
    memo: '花粉の時期になり目薬持参増加。詰所に常備してほしいとの声 [DEMO_SEED]', days: 8 },

  // 食事系 (3件) - これが施策化される本命
  { promoter: 'a_yamada', cat: '食事', urg: '中', id_mode: '集計のみ',
    memo: '本社周辺、コンビニ以外の昼食選択肢がほぼない。長距離便明けは特に弁当温めたい人多い [DEMO_SEED]', days: 14 },
  { promoter: 'e_sugai', cat: '食事', urg: '中', id_mode: '集計のみ',
    memo: '夜勤明けの食事が偏る。野菜不足の自覚あるが選びにくいという声 [DEMO_SEED]', days: 9 },
  { promoter: 'y_yoshizawa', cat: '食事', urg: '低', id_mode: '本人特定可',
    memo: '田中さん、自分で弁当持参始めた。詰所に電子レンジあれば冷たいまま食べずに済むと [DEMO_SEED]', days: 5 },

  // 睡眠系 (2件)
  { promoter: 'a_yamada', cat: '睡眠', urg: '中', id_mode: '匿名',
    memo: '長距離便ドライバー、仮眠スペースの仕切りが薄く周囲の音気になるという声 [DEMO_SEED]', days: 11 },
  { promoter: 'e_sugai', cat: '睡眠', urg: '低', id_mode: '集計のみ',
    memo: '日勤明けに昼寝したいが詰所が騒がしいとの声、複数人 [DEMO_SEED]', days: 6 },

  // 職場環境 (2件)
  { promoter: 'taketake', cat: '職場環境', urg: '中', id_mode: '集計のみ',
    memo: '埼玉営業所、夏場の事務所暑い。エアコン効きが悪い [DEMO_SEED]', days: 10 },
  { promoter: 'a_yamada', cat: '職場環境', urg: '低', id_mode: '本人特定可',
    memo: '鈴木さん、休憩室の椅子が硬く長時間座れないと [DEMO_SEED]', days: 3 },
];

const insPost = db.prepare(`INSERT INTO wellness_posts
  (poster_id, company_code, category, urgency, identity_mode, memo, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
const seededPostIds = [];
for (const p of posts) {
  const u = byLogin[p.promoter];
  const r = insPost.run(u.id, u.company_code || 'SU_HQ', p.cat, p.urg, p.id_mode, p.memo, daysAgo(p.days));
  seededPostIds.push(r.lastInsertRowid);
}
console.log('✅ POST 10件投入完了 IDs:', seededPostIds);

// ============================================================
// 2. POSTに対応するチャットメッセージ (g_field_voice グループに残す)
// ============================================================
const insMsg = db.prepare(`INSERT INTO messages (sender_id, receiver_id, content, room_code, created_at)
  VALUES (?, NULL, ?, ?, ?)`);
for (let i = 0; i < posts.length; i++) {
  const p = posts[i];
  const u = byLogin[p.promoter];
  const urgMark = p.urg === '高' ? '🔴' : p.urg === '中' ? '🟡' : '🟢';
  const content = `📝 #${seededPostIds[i]} 【${p.cat}】 ${urgMark}${p.urg}\n営業所: ${u.company_code}　/　特定区分: ${p.id_mode}\n─\n${p.memo}`;
  insMsg.run(u.id, content, 'grp_g_field_voice', daysAgo(p.days, 9));
}

// ============================================================
// 3. 健康管理室ディスカッションGC のサンプル議論 3件
// ============================================================
const discussions = [
  { sender: 'taketake', text: '🏥 健康管理室、本日より始動します。現場からの声を月次で議論し、できるところから施策に落としていきます。よろしくお願いします', days: 19 },
  { sender: 'y_yoshizawa', text: '今月は食事系のPOSTが多いですね。本社周辺のコンビニ依存問題、何か手を打てそうです', days: 7 },
  { sender: 'taketake', text: 'まず本社の電子レンジから着手しましょう。AIで集約してみてください', days: 4 },
];
for (const d of discussions) {
  const u = byLogin[d.sender];
  insMsg.run(u.id, d.text, 'grp_g_wellness_disc', daysAgo(d.days, 14));
}
console.log('✅ 健康管理室ディスカッション 3件投入');

// ============================================================
// 4. 完了済施策 2件 (ループが回った実績として)
// ============================================================
const insAction = db.prepare(`INSERT INTO wellness_actions
  (title, description, category, source_post_ids, status, owner_id, budget_jpy, target_date,
   created_by, created_at, approved_by, approved_at, completed_at, announce_message, is_ai_suggested)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const completed1 = insAction.run(
  '本社休憩室に電子レンジ追加',
  '本社周辺のコンビニ依存と弁当温め需要を受け、休憩室に電子レンジを設置。お弁当持参の負担を軽減し、温かい食事の選択肢を確保。',
  '食事',
  JSON.stringify([seededPostIds[3], seededPostIds[5]]),  // 食事POST 2件
  '完了',
  ADMIN.id,
  18000,
  null,
  ADMIN.id,
  daysAgo(13),
  ADMIN.id,
  daysAgo(11),
  daysAgo(2),
  '🏥 健康管理室より\n本社休憩室に電子レンジを追加しました。お弁当の温めにご利用ください。\n（現場の声 #' + seededPostIds[3] + ', #' + seededPostIds[5] + ' → 形にしました）',
  0
);
const completedActionId1 = completed1.lastInsertRowid;
// ロビーアナウンスメッセージも入れる
insMsg.run(ADMIN.id, completed1.title || '🏥 健康管理室より\n本社休憩室に電子レンジを追加しました。お弁当の温めにご利用ください。', 'lobby', daysAgo(2, 17));

const completed2 = insAction.run(
  '埼玉営業所エアコン点検・修理',
  '夏場の事務所温度上昇に対応するため、業者点検と冷媒補充を実施。',
  '職場環境',
  JSON.stringify([seededPostIds[8]]),
  '完了',
  ADMIN.id,
  35000,
  null,
  ADMIN.id,
  daysAgo(8),
  ADMIN.id,
  daysAgo(6),
  daysAgo(1),
  '🏥 健康管理室より\n埼玉営業所のエアコンを点検・冷媒補充しました。涼しくなりました。\n（現場の声 #' + seededPostIds[8] + ' → 形にしました）',
  0
);
insMsg.run(ADMIN.id, '🏥 健康管理室より\n埼玉営業所のエアコンを点検・冷媒補充しました。涼しくなりました。', 'lobby', daysAgo(1, 11));

console.log('✅ 完了施策 2件投入 IDs:', completed1.lastInsertRowid, completed2.lastInsertRowid);

// ============================================================
// 5. 実行中施策 1件
// ============================================================
const inProgress = insAction.run(
  '腰痛予防ストレッチを朝礼に組み込み',
  '50代以上の腰痛訴え増加を受け、産業医監修の3分ストレッチプログラムを朝礼に組み込み。今月から各営業所で順次導入。',
  '体調',
  JSON.stringify([seededPostIds[0], seededPostIds[1]]),
  '実行中',
  byLogin.y_yoshizawa.id,
  0,
  null,
  ADMIN.id,
  daysAgo(5),
  ADMIN.id,
  daysAgo(4),
  null,
  null,
  0
);
console.log('✅ 実行中施策 1件投入 ID:', inProgress.lastInsertRowid);

// ============================================================
// 6. 承認待ち施策 1件 (デモで「承認」ボタンを押せる状態)
// ============================================================
const pending = insAction.run(
  '詰所に花粉対策アイテム常備',
  '花粉時期にドライバーから目薬・マスクの要望多数。詰所4箇所に常備。',
  '体調',
  JSON.stringify([seededPostIds[2]]),
  '承認待ち',
  null,
  8000,
  null,
  byLogin.e_sugai.id,
  daysAgo(2),
  null,
  null,
  null,
  null,
  0
);
console.log('✅ 承認待ち施策 1件投入 ID:', pending.lastInsertRowid);

// ============================================================
// 7. AI候補施策 1件 (AI集約から生まれた候補として)
// ============================================================
const aiCandidate = insAction.run(
  '夜勤明けの野菜セット配布(週2回トライアル)',
  '夜勤明けドライバーの食事偏り対策として、本社/埼玉に週2回(月木)、簡易野菜セット(カット野菜+ドレッシング)を提供。1ヶ月トライアル後に継続判断。',
  '食事',
  JSON.stringify([seededPostIds[4]]),
  '候補',
  null,
  12000,
  null,
  ADMIN.id,
  daysAgo(1),
  null,
  null,
  null,
  null,
  1  // is_ai_suggested
);
console.log('✅ AI候補施策 1件投入 ID:', aiCandidate.lastInsertRowid);

console.log('\n🎉 デモシード完了');
console.log('  運管POST: 10件');
console.log('  健康管理室議論: 3件');
console.log('  完了施策: 2件 (アナウンス済)');
console.log('  実行中施策: 1件');
console.log('  承認待ち施策: 1件');
console.log('  AI候補施策: 1件');
console.log('\n管理画面 (https://cohub.biz-terrace.org/admin) で確認できます');
