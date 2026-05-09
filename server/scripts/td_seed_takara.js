// タカラ提案デモ用 過去データ一括投入スクリプト
// 実行: node server/scripts/td_seed_takara.js /path/to/data_dir
// data_dir 直下に DataManagementSearch*.xls (WMS) と 配車結果*.xlsx を置く
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');

const dataDir = process.argv[2] || '/tmp/takara_seed';
const dbPath = process.argv[3] || path.join(__dirname, '..', 'db', 'cohub.db');

if (!fs.existsSync(dataDir)) { console.error('Data dir not found:', dataDir); process.exit(1); }
if (!fs.existsSync(dbPath)) { console.error('DB not found:', dbPath); process.exit(1); }

const db = new Database(dbPath);
console.log('DB:', dbPath);
console.log('Data dir:', dataDir);

const nz = (v) => v === null || v === undefined ? '' : String(v).trim();
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

const files = fs.readdirSync(dataDir).filter(f => /\.(xls|xlsx)$/i.test(f));
const wmsFiles = files.filter(f => /DataManagementSearch/i.test(f));
const dispFiles = files.filter(f => /配車結果/.test(f));

console.log('WMS files:', wmsFiles.length, 'Dispatch files:', dispFiles.length);

const insOrder = db.prepare(`INSERT INTO td_orders
  (import_id, load_date, warehouse_cd, shape_cd, original_vehicle_no, handai_no, site_name, item_cd, item_name, qty, sai, source_route)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insDisp = db.prepare(`INSERT INTO td_dispatch_history
  (import_id, load_date, original_vehicle_no, sequence, site_name, address, time_spec, eta, qty, sai, vehicle_type, transfer_base, company)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const importIns = db.prepare(`INSERT INTO td_imports (type, filename, load_date, row_count, created_by) VALUES (?, ?, ?, ?, 'seed')`);

// --- WMS取込 ---
for (const f of wmsFiles) {
  const fp = path.join(dataDir, f);
  console.log('--- WMS:', f);
  const wb = XLSX.read(fs.readFileSync(fp), { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  if (rows.length < 2) continue;
  const ld = nz(rows[1][0]); if (!ld) continue;
  // 既存上書き
  db.prepare(`DELETE FROM td_orders WHERE load_date = ?`).run(ld);
  const importId = importIns.run('wms', f, ld, rows.length - 1).lastInsertRowid;
  let count = 0;
  const tx = db.transaction(() => {
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const ldd = nz(r[0]); const wh = nz(r[1]), shape = nz(r[2]), veh = nz(r[3]);
      const hn = nz(r[4]), site = nz(r[5]); const ic = nz(r[6]), inm = nz(r[7]);
      const qty = num(r[8]); const sai = num(r[9]); const ow = nz(r[10]), sr = nz(r[11]);
      if (!ldd || !site) continue;
      insOrder.run(importId, ldd, wh, shape, veh, hn, site, ic, inm, qty, sai, sr);
      count++;
    }
  });
  tx();
  console.log(`  load_date=${ld}, rows=${count}`);
}

// --- 配車結果取込 ---
for (const f of dispFiles) {
  const fp = path.join(dataDir, f);
  console.log('--- Dispatch:', f);
  const wb = XLSX.read(fs.readFileSync(fp), { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  let ld = '';
  // 検出: 最初に load_date(配送日) が来る行をスキャン
  for (const r of rows) {
    const company = nz(r[2]);
    if (company === '業者') continue;
    const ldd = nz(r[5]); if (ldd) { ld = ldd; break; }
  }
  if (!ld) { console.warn('  load_date 不明'); continue; }
  db.prepare(`DELETE FROM td_dispatch_history WHERE load_date = ?`).run(ld);
  const importId = importIns.run('dispatch', f, ld, 0).lastInsertRowid;
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const company = nz(r[2]); if (company === '業者') continue;
      const veh = nz(r[3]); if (!veh) continue;
      const ldd = nz(r[5]) || ld;
      const seq = parseInt(r[6]) || null;
      const ts = nz(r[9]);
      const site = nz(r[10]); const addr = nz(r[11]);
      const qty = num(r[12]); const sai = num(r[13]);
      const eta = nz(r[14]);
      // 正規の車種は col22(idx21)。col16は納入数が混入。
      const vt = nz(r[21]); const tb = nz(r[20]);
      let level = '';
      if (ts === '時間指定') level = 'hard';
      else if (ts === '有') level = 'soft';
      insDisp.run(importId, ldd, veh, seq, site, addr, level, eta, qty, sai, vt, tb, company);
      inserted++;
    }
  });
  tx();
  db.prepare(`UPDATE td_imports SET row_count = ? WHERE id = ?`).run(inserted, importId);
  console.log(`  load_date=${ld}, rows=${inserted}`);
}

const stat = db.prepare(`SELECT load_date, COUNT(*) AS rows, COUNT(DISTINCT site_name) AS sites FROM td_orders GROUP BY load_date ORDER BY load_date`).all();
console.log('=== 取込結果 ===');
for (const s of stat) console.log(`  ${s.load_date}: ${s.rows}行 / ${s.sites}現場`);
console.log('Done.');
