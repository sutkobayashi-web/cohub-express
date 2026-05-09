// 配車結果(人手)を td_dispatches/td_dispatch_meta に忠実に転記
// 実行: node server/scripts/td_seed_real_dispatch.js [YYYYMMDD or all]
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('../services/db');

const arg = process.argv[2] || 'all';
const gen8 = () => crypto.randomBytes(6).toString('base64url');

const db = getDb();

const dates = arg === 'all'
  ? db.prepare(`SELECT DISTINCT load_date FROM td_dispatch_history WHERE load_date GLOB '[0-9]*' ORDER BY load_date`).all().map(r => r.load_date)
  : [arg];

console.log('対象日:', dates.join(', '));

const insDisp = db.prepare(`INSERT INTO td_dispatches
  (load_date, vehicle_no, sequence, site_name, address, eta, time_spec, qty, sai, ai_reason, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
const insMeta = db.prepare(`INSERT OR IGNORE INTO td_dispatch_meta
  (load_date, vehicle_no, vehicle_type, driver_token, status) VALUES (?, ?, ?, ?, 'draft')`);

for (const ld of dates) {
  // 既存の td_dispatches/meta をクリア (人手配車で上書き)
  db.prepare(`DELETE FROM td_dispatches WHERE load_date = ?`).run(ld);
  db.prepare(`DELETE FROM td_dispatch_meta WHERE load_date = ?`).run(ld);

  const rows = db.prepare(`SELECT * FROM td_dispatch_history WHERE load_date = ? ORDER BY original_vehicle_no, sequence, id`).all(ld);
  if (!rows.length) { console.log(`  ${ld}: 配車履歴なし`); continue; }

  // 号車別に車種をまとめる (車種は号車に1つ)
  const vehTypeMap = new Map();
  for (const r of rows) {
    if (r.vehicle_type && r.vehicle_type !== '車種' && !vehTypeMap.has(r.original_vehicle_no)) {
      vehTypeMap.set(r.original_vehicle_no, r.vehicle_type);
    }
  }

  const tx = db.transaction(() => {
    // stops 投入
    for (const r of rows) {
      insDisp.run(
        ld, r.original_vehicle_no,
        r.sequence || null,
        r.site_name || '',
        r.address || '',
        r.eta || '',
        r.time_spec || null,
        r.qty || 0,
        r.sai || 0,
        '人手配車(実績)',
      );
    }
    // meta 投入 (号車別、driver_token 自動発行)
    for (const [veh, vt] of vehTypeMap) {
      insMeta.run(ld, veh, vt, gen8());
    }
    // 車種が空の号車もメタ投入 (driver_tokenだけは発行)
    const allVehs = [...new Set(rows.map(r => r.original_vehicle_no))];
    for (const v of allVehs) {
      if (!vehTypeMap.has(v)) {
        insMeta.run(ld, v, '', gen8());
      }
    }
  });
  tx();
  const stats = db.prepare(`SELECT COUNT(*) AS stops, COUNT(DISTINCT vehicle_no) AS vehicles FROM td_dispatches WHERE load_date = ?`).get(ld);
  const vts = db.prepare(`SELECT vehicle_type, COUNT(*) AS c FROM td_dispatch_meta WHERE load_date = ? GROUP BY vehicle_type ORDER BY c DESC`).all(ld);
  console.log(`  ${ld}: ${stats.vehicles}台 / ${stats.stops}ストップ / 車種: ${vts.map(v => `${v.vehicle_type || '(空)'}=${v.c}`).join(', ')}`);
}

console.log('Done.');
