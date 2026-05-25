// 号車番号→業者分類 集計スクリプト
// スタンダード運輸: 200-390
// 昭栄サービス: 961-969, 981-989
// ｶｰﾚﾝﾄｻｰﾋﾞｽ: A0-A9, B0-B9 (頭文字A/B + 数字)
// 施工業者引取: 950-959, 971-979
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'db', 'cohub.db');
const db = new Database(dbPath, { readonly: true });

function classify(vehNo) {
  if (!vehNo) return '不明';
  const s = String(vehNo).trim();
  // ｶｰﾚﾝﾄ: A* / B*
  if (/^[AB][0-9]/.test(s)) return 'ｶｰﾚﾝﾄｻｰﾋﾞｽ';
  // 数字のみ
  const n = parseInt(s, 10);
  if (isNaN(n)) return '不明';
  if (n >= 200 && n <= 390) return 'スタンダード運輸';
  if (n >= 961 && n <= 969) return '昭栄サービス';
  if (n >= 981 && n <= 989) return '昭栄サービス';
  if (n >= 950 && n <= 959) return '施工業者引取';
  if (n >= 971 && n <= 979) return '施工業者引取';
  return 'その他';
}

console.log('==================================================');
console.log(' 号車→業者 分類集計  (受領済 6日分)');
console.log('==================================================\n');

// === 1) WMS側 (td_orders 実号車) ===
console.log('### ① WMS実号車別 (td_orders) ###');
const wmsRows = db.prepare(`
  SELECT load_date, original_vehicle_no, COUNT(*) AS items, ROUND(SUM(sai),0) AS sai
  FROM td_orders WHERE load_date GLOB '[0-9]*' AND original_vehicle_no <> ''
  GROUP BY load_date, original_vehicle_no
`).all();
const wmsCo = {};
for (const r of wmsRows) {
  const c = classify(r.original_vehicle_no);
  if (!wmsCo[c]) wmsCo[c] = { vehicles: new Set(), items: 0, sai: 0, days: new Set() };
  wmsCo[c].vehicles.add(r.original_vehicle_no);
  wmsCo[c].items += r.items;
  wmsCo[c].sai += r.sai;
  wmsCo[c].days.add(r.load_date);
}
for (const [co, d] of Object.entries(wmsCo).sort((a, b) => b[1].sai - a[1].sai)) {
  console.log(`  ${co}: ${d.vehicles.size}号車種 / ${d.items}行 / ${d.sai.toFixed(0)}才 (${d.days.size}日分)`);
}

// === 2) 配車結果側 (td_dispatch_history) ===
console.log('\n### ② 配車結果(人手)別 (td_dispatch_history) ###');
const histRows = db.prepare(`
  SELECT load_date, original_vehicle_no, COUNT(*) AS stops, ROUND(SUM(sai),0) AS sai
  FROM td_dispatch_history WHERE load_date GLOB '[0-9]*' AND original_vehicle_no <> ''
  GROUP BY load_date, original_vehicle_no
`).all();
const histCo = {};
for (const r of histRows) {
  const c = classify(r.original_vehicle_no);
  if (!histCo[c]) histCo[c] = { vehicles: new Set(), stops: 0, sai: 0, days: new Set() };
  histCo[c].vehicles.add(r.original_vehicle_no);
  histCo[c].stops += r.stops;
  histCo[c].sai += r.sai;
  histCo[c].days.add(r.load_date);
}
for (const [co, d] of Object.entries(histCo).sort((a, b) => b[1].sai - a[1].sai)) {
  console.log(`  ${co}: ${d.vehicles.size}号車種 / ${d.stops}ストップ / ${d.sai.toFixed(0)}才 (${d.days.size}日分)`);
}

// === 3) 4/24 1日分の詳細 (代表例として) ===
console.log('\n### ③ 4/24 配車結果 業者別号車一覧 ###');
const day = '20260424';
const dayRows = db.prepare(`
  SELECT original_vehicle_no, vehicle_type, sequence, site_name, ROUND(sai,0) AS sai
  FROM td_dispatch_history WHERE load_date = ? AND original_vehicle_no <> ''
  ORDER BY id
`).all(day);
const byCo = {};
const lastVehSeq = {};  // 同号車の物理車両カウント (sequence=1で新車両)
let physVehCount = {};
let curPhys = null;
for (const r of dayRows) {
  if (r.sequence === 1 || !r.sequence) curPhys = r.original_vehicle_no;
  const c = classify(r.original_vehicle_no);
  if (!byCo[c]) byCo[c] = { vehicles: new Set(), physVehs: new Set(), stops: 0, sai: 0, vehList: new Map() };
  byCo[c].vehicles.add(r.original_vehicle_no);
  byCo[c].physVehs.add(curPhys);
  byCo[c].stops++;
  byCo[c].sai += r.sai;
  if (!byCo[c].vehList.has(r.original_vehicle_no)) byCo[c].vehList.set(r.original_vehicle_no, { vt: r.vehicle_type || '', stops: 0, sai: 0 });
  const v = byCo[c].vehList.get(r.original_vehicle_no);
  v.stops++; v.sai += r.sai;
}
for (const [co, d] of Object.entries(byCo).sort((a, b) => b[1].sai - a[1].sai)) {
  console.log(`\n--- ${co} (${d.physVehs.size}物理車両 / ${d.vehicles.size}配送号車種 / ${d.stops}ストップ / ${d.sai.toFixed(0)}才) ---`);
  const arr = [...d.vehList.entries()].sort((a, b) => {
    const an = parseInt(a[0]) || 0; const bn = parseInt(b[0]) || 0;
    if (a[0][0] !== b[0][0] && /[A-Z]/.test(a[0][0])) return a[0].localeCompare(b[0]);
    return an - bn;
  });
  for (const [veh, info] of arr.slice(0, 20)) {
    console.log(`  号車${veh}: ${info.vt || '(空)'} / ${info.stops}stop / ${info.sai.toFixed(0)}才`);
  }
  if (arr.length > 20) console.log(`  ... 他${arr.length - 20}号車`);
}
