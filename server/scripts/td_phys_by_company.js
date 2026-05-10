// 物理車両単位 × 業者別 集計
// sequence=1 で新物理車両判定、号車番号→業者分類
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'db', 'cohub.db');
const db = new Database(dbPath, { readonly: true });

function classify(vehNo) {
  if (!vehNo) return '不明';
  const s = String(vehNo).trim();
  if (/^[AB][0-9]/.test(s)) return 'ｶｰﾚﾝﾄ';
  const n = parseInt(s, 10);
  if (isNaN(n)) return '不明';
  if ((n >= 200 && n <= 390) || (n >= 400 && n <= 590)) return 'スタ運';
  if (n >= 600 && n <= 899) return 'スタ運(土)';
  if (n >= 961 && n <= 969) return '昭栄';
  if (n >= 981 && n <= 989) return '昭栄';
  if (n >= 950 && n <= 959) return '施工引取';
  if (n >= 971 && n <= 979) return '施工引取';
  return 'その他';
}

const days = db.prepare(`SELECT DISTINCT load_date FROM td_dispatch_history WHERE load_date GLOB '[0-9]*' ORDER BY load_date`).all().map(r => r.load_date);

console.log('==================================================');
console.log('  物理車両単位 × 業者別 集計  (sequence=1で物理車両を区切る)');
console.log('==================================================\n');

const summary = { 'スタ運': [], '昭栄': [], 'ｶｰﾚﾝﾄ': [], '施工引取': [], 'その他': [] };

for (const day of days) {
  const rows = db.prepare(`SELECT * FROM td_dispatch_history WHERE load_date = ? ORDER BY id`).all(day);
  // 物理車両を区切る (sequence=1で新しい物理車両、業者ごとに集計)
  const physByCo = {};  // company -> Set<rep_vehicle_no>
  let curPhys = null;
  let curCo = null;
  for (const r of rows) {
    if (r.sequence === 1 || !r.sequence || !curPhys) {
      curPhys = r.original_vehicle_no;
      curCo = classify(curPhys);
    }
    if (!physByCo[curCo]) physByCo[curCo] = new Set();
    physByCo[curCo].add(curPhys);
  }
  console.log(`### ${day} ###`);
  for (const co of ['スタ運', '昭栄', 'ｶｰﾚﾝﾄ', '施工引取', 'その他']) {
    const set = physByCo[co] || new Set();
    if (set.size === 0) continue;
    console.log(`  ${co}: ${set.size}物理車両  (代表号車: ${[...set].slice(0, 5).join(', ')}${set.size > 5 ? '...' : ''})`);
    summary[co].push(set.size);
  }
  console.log('');
}

console.log('==================================================');
console.log('  業者別 平均物理車両数 (受領済6日分)');
console.log('==================================================');
for (const co of ['スタ運', '昭栄', 'ｶｰﾚﾝﾄ', '施工引取', 'その他']) {
  if (!summary[co].length) continue;
  const avg = summary[co].reduce((a, b) => a + b, 0) / summary[co].length;
  const min = Math.min(...summary[co]);
  const max = Math.max(...summary[co]);
  console.log(`  ${co}: 平均 ${avg.toFixed(1)}台 (最小${min} / 最大${max}) / 配車結果上 ${summary[co].length}日`);
}

// WMSには載っているが配車結果に出てこない引取号車も別途集計
console.log('\n==================================================');
console.log('  WMS側 施工引取号車数 (配車対象外だがピッキング対象)');
console.log('==================================================');
for (const day of days) {
  const r = db.prepare(`
    SELECT COUNT(DISTINCT original_vehicle_no) AS vehs, COUNT(*) AS items, ROUND(SUM(sai),0) AS sai
    FROM td_orders
    WHERE load_date = ?
      AND ((CAST(original_vehicle_no AS INTEGER) BETWEEN 950 AND 959)
        OR (CAST(original_vehicle_no AS INTEGER) BETWEEN 971 AND 979))
  `).get(day);
  console.log(`  ${day}: ${r.vehs}号車 / ${r.items}品目 / ${r.sai || 0}才`);
}
