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

  // xlsx順 (id ASC) で走査。sequence=1 で新しい物理車両、2,3,... は同車両の追加ストップ
  const rows = db.prepare(`SELECT * FROM td_dispatch_history WHERE load_date = ? ORDER BY id`).all(ld);
  if (!rows.length) { console.log(`  ${ld}: 配車履歴なし`); continue; }

  // 物理車両ごとの代表号車・車種を判定
  const physVehMap = new Map();  // physical_vehicle_no -> { vehicle_type, stops_count }
  let currentPhys = null;
  const enriched = [];
  for (const r of rows) {
    const seq = r.sequence;
    if (seq === 1 || !seq || !currentPhys) {
      // 新しい物理車両の開始
      currentPhys = r.original_vehicle_no;
      if (!physVehMap.has(currentPhys)) {
        physVehMap.set(currentPhys, { vehicle_type: r.vehicle_type || '', stops: 0 });
      }
    }
    const m = physVehMap.get(currentPhys);
    m.stops++;
    // 車種が空なら後続行のものを代表車種として補完
    if (!m.vehicle_type && r.vehicle_type) m.vehicle_type = r.vehicle_type;
    enriched.push({ ...r, phys_vehicle_no: currentPhys });
  }

  const tx = db.transaction(() => {
    // stops 投入 (物理車両号車にまとめて入れる)
    for (const r of enriched) {
      insDisp.run(
        ld, r.phys_vehicle_no,
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
    // meta 投入 (物理車両ごと、driver_token 自動発行)
    for (const [veh, info] of physVehMap) {
      insMeta.run(ld, veh, info.vehicle_type || '', gen8());
    }
  });
  tx();
  const stats = db.prepare(`SELECT COUNT(*) AS stops, COUNT(DISTINCT vehicle_no) AS vehicles FROM td_dispatches WHERE load_date = ?`).get(ld);
  const vts = db.prepare(`SELECT vehicle_type, COUNT(*) AS c FROM td_dispatch_meta WHERE load_date = ? GROUP BY vehicle_type ORDER BY c DESC`).all(ld);
  console.log(`  ${ld}: ${stats.vehicles}台 / ${stats.stops}ストップ / 車種: ${vts.map(v => `${v.vehicle_type || '(空)'}=${v.c}`).join(', ')}`);
}

console.log('Done.');
