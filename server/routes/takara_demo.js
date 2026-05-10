// タカラスタンダード一括請負プロトタイプ (2026-05-09 月曜提案用)
// WMS取込 → AI配車生成 → 号車別QR/ドライバー画面 → 荷主追跡 までの一気通貫プロト
// 既存bcscan/cohubのデータには触れず、td_* テーブル群で完全分離
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateText } = require('../services/ai');
const { generateTextClaude, normalizeVehicleType } = require('../services/ai_claude');
const { classifyVehicle, COMPANY_COLORS, DEPOTS, depotForCompany } = require('../services/takara_helpers');
const { solveVRP } = require('../services/ortools');
const { geocode, inKanto } = require('../services/geocoder');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });

// 簡易な車種別才数容量 (デモ用デフォルト)
const VEHICLE_CAPACITY = {
  '2tショート': 80, '2tロング': 100, '3t': 120, '3tユニック': 120, '4t': 160, '4tユニック': 160,
  default: 100,
};

function isAdmin(uid) {
  const u = getDb().prepare('SELECT role, employee_type FROM users WHERE id = ?').get(uid);
  return !!(u && (u.role === 'admin' || u.employee_type === 'admin'));
}

function gen8() { return crypto.randomBytes(6).toString('base64url'); }
function nz(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

// ============================================================
// 取込: WMS xls (12列フォーマット)
// 列: 積込日 | 倉庫CD | 出荷形態 | 実号車 | 手配NO | 現場名 | 品名CD | 品名 | 数量 | 才数 | 出庫倉庫 | 積替元号車
// ============================================================
router.post('/import-wms', authUser, upload.single('file'), (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  if (!req.file) return res.status(400).json({ success: false, msg: 'ファイルが添付されていません' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    if (rows.length < 2) return res.status(400).json({ success: false, msg: 'データ行がありません' });
    // 1行目=ヘッダー、2行目以降=データ
    const db = getDb();
    let loadDate = '';
    const ins = db.prepare(`INSERT INTO td_orders
      (import_id, load_date, warehouse_cd, shape_cd, original_vehicle_no, handai_no, site_name, item_cd, item_name, qty, sai, source_route)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const importIns = db.prepare(`INSERT INTO td_imports (type, filename, load_date, row_count, created_by) VALUES ('wms', ?, ?, ?, ?)`);
    const insertMany = db.transaction((dataRows) => {
      const importId = importIns.run(req.file.originalname || '', dataRows[0] && dataRows[0][0] || '', dataRows.length, req.uid).lastInsertRowid;
      let count = 0;
      for (const r of dataRows) {
        const ld = nz(r[0]); if (!loadDate) loadDate = ld;
        const wh = nz(r[1]), shape = nz(r[2]), veh = nz(r[3]), hn = nz(r[4]), site = nz(r[5]);
        const ic = nz(r[6]), inm = nz(r[7]); const qty = num(r[8]); const sai = num(r[9]);
        const ow = nz(r[10]), sr = nz(r[11]);
        if (!ld || !site) continue;
        ins.run(importId, ld, wh, shape, veh, hn, site, ic, inm, qty, sai, sr);
        count++;
      }
      return { importId, count };
    });
    // 既存同日のデータを上書き
    if (rows.length >= 2) {
      const ld0 = nz(rows[1][0]);
      if (ld0) db.prepare(`DELETE FROM td_orders WHERE load_date = ?`).run(ld0);
    }
    const { importId, count } = insertMany(rows.slice(1));
    res.json({ success: true, import_id: importId, load_date: loadDate, row_count: count });
  } catch (e) {
    console.error('[takara import-wms]', e);
    res.status(500).json({ success: false, msg: 'WMS取込失敗: ' + e.message });
  }
});

// ============================================================
// 取込: 配車結果 (教師データ・参考用)
// 列: ... | 業者 | 号車 | 営業所CD | 配送日 | 配送順 | 返品 | 倉庫CD | 時間指定 | 納入先名 | 住所 | 数量 | 才数 | 到着予定時間 | 車種 | ...
// 実際は2列空白から始まる213行ぐらい (4/24例)
// ============================================================
router.post('/import-dispatch', authUser, upload.single('file'), (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  if (!req.file) return res.status(400).json({ success: false, msg: 'ファイルが添付されていません' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

    // ヘッダー行を動的に探す ("業者" "号車" "時間指定" のいずれか含む最初の行)
    let headerIdx = -1;
    for (let i = 0; i < Math.min(8, rows.length); i++) {
      const r = (rows[i] || []).map(c => String(c || '').trim());
      if (r.includes('業者') || r.includes('号車') || r.includes('時間指定')) { headerIdx = i; break; }
    }
    const headerVals = headerIdx >= 0 ? (rows[headerIdx] || []).map(c => String(c || '').trim()) : [];
    // デフォルト列マップ (ユーザー指定の旧仕様)
    const cm = { company: 2, vehicle: 3, date: 5, seq: 6, timeSpec: 9, site: 10, address: 11, qty: 12, sai: 13, eta: 14, vehType: 21, transferBase: 20 };
    // ヘッダー名で動的上書き
    headerVals.forEach((h, i) => {
      if (h === '業者') cm.company = i;
      else if (h === '号車' || h === '車番' || h === '号車番号') cm.vehicle = i;
      else if (h === '配送日' || h === '配送日付') cm.date = i;
      else if (h === '配送順' || h === '配車順' || h === '順') cm.seq = i;
      else if (h === '時間指定' || h === '指定') cm.timeSpec = i;
      else if (h === '納入先' || h === '現場名' || h === '届先' || h === '配送先') cm.site = i;
      else if (h === '住所' || h === '住所等' || h === '所在地') cm.address = i;
      else if (h === '数量' || h === '個数') cm.qty = i;
      else if (h === '才数' || h === 'サイ数' || h === 'M3') cm.sai = i;
      else if (h === 'ETA' || h === '到着予定' || h === '時刻') cm.eta = i;
      else if (h === '車種' || h === '車両タイプ') cm.vehType = i;
      else if (h === '積替基地' || h === '基地' || h === '積替') cm.transferBase = i;
    });
    console.log('[import-dispatch] header idx=' + headerIdx + ' map=', cm, 'header values=', headerVals.slice(0, 22));

    const db = getDb();
    const ins = db.prepare(`INSERT INTO td_dispatch_history
      (import_id, load_date, original_vehicle_no, sequence, site_name, address, time_spec, eta, qty, sai, vehicle_type, transfer_base, company)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const importIns = db.prepare(`INSERT INTO td_imports (type, filename, load_date, row_count, created_by) VALUES ('dispatch', ?, ?, ?, ?)`);
    let loadDate = '';
    let inserted = 0;
    let hardCount = 0, softCount = 0, emptyCount = 0;
    const tsSamples = [];
    const importId = importIns.run(req.file.originalname || '', '', 0, req.uid).lastInsertRowid;
    const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;
    for (let i = startIdx; i < rows.length; i++) {
      const r = rows[i] || [];
      const company = nz(r[cm.company]);
      if (company === '業者') continue;
      const veh = nz(r[cm.vehicle]); if (!veh) continue;
      const ld = nz(r[cm.date]); if (!loadDate) loadDate = ld;
      const seq = parseInt(r[cm.seq]) || null;
      const ts = nz(r[cm.timeSpec]);
      if (tsSamples.length < 10 && ts) tsSamples.push(ts);
      const site = nz(r[cm.site]);
      const addr = nz(r[cm.address]);
      const qty = num(r[cm.qty]); const sai = num(r[cm.sai]);
      let eta = nz(r[cm.eta]);
      if (/^\d{4}$/.test(eta)) eta = eta.slice(0, 2) + ':' + eta.slice(2);
      const vt = nz(r[cm.vehType]);
      const tb = nz(r[cm.transferBase]);
      let level = '';
      // 時間指定の柔軟判定: 「時間指定」「指定」「●」等→hard, 「有」「○」→soft
      if (ts === '時間指定' || ts === '指定' || ts === '●' || ts === '時指' || ts === '★') { level = 'hard'; hardCount++; }
      else if (ts === '有' || ts === '○' || ts === '◯') { level = 'soft'; softCount++; }
      else emptyCount++;
      ins.run(importId, ld, veh, seq, site, addr, level, eta, qty, sai, vt, tb, company);
      inserted++;
    }
    db.prepare(`UPDATE td_imports SET load_date = ?, row_count = ? WHERE id = ?`).run(loadDate, inserted, importId);
    res.json({
      success: true, import_id: importId, load_date: loadDate, row_count: inserted,
      time_spec_stats: { hard: hardCount, soft: softCount, empty: emptyCount },
      ts_samples: tsSamples,
      detected_columns: cm,
      header_values: headerVals.slice(0, 22),
    });
  } catch (e) {
    console.error('[takara import-dispatch]', e);
    res.status(500).json({ success: false, msg: '配車結果取込失敗: ' + e.message });
  }
});

// 取込済日付一覧
router.get('/dates', authUser, (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const rows = getDb().prepare(`
    SELECT load_date,
      COUNT(DISTINCT site_name) AS site_count,
      COUNT(*) AS row_count,
      SUM(sai) AS total_sai
    FROM td_orders
    WHERE load_date <> ''
    GROUP BY load_date ORDER BY load_date DESC
  `).all();
  res.json({ success: true, dates: rows });
});

// 当日の現場集約
router.get('/sites/:load_date', authUser, (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const ld = req.params.load_date;
  // WMSから現場集約 + 過去配車履歴の住所/時間指定をJOIN
  const rows = getDb().prepare(`
    SELECT o.site_name,
      COUNT(*) AS item_count,
      SUM(o.qty) AS qty,
      SUM(o.sai) AS sai,
      MIN(o.original_vehicle_no) AS hint_vehicle,
      (SELECT address FROM td_dispatch_history h WHERE h.site_name = o.site_name ORDER BY h.id DESC LIMIT 1) AS address_hint,
      (SELECT time_spec FROM td_dispatch_history h WHERE h.site_name = o.site_name AND h.load_date = ? ORDER BY h.id DESC LIMIT 1) AS time_spec_today,
      (SELECT eta FROM td_dispatch_history h WHERE h.site_name = o.site_name AND h.load_date = ? ORDER BY h.id DESC LIMIT 1) AS eta_today
    FROM td_orders o
    WHERE o.load_date = ?
    GROUP BY o.site_name
    ORDER BY SUM(o.sai) DESC
  `).all(ld, ld, ld);
  res.json({ success: true, load_date: ld, sites: rows });
});

// ============================================================
// AI配車生成 (Geminiで時間指定+周辺最適化を組ませる)
// 入力: load_date
// 出力: td_dispatches に配車プラン保存 + JSON返却
// ============================================================
// ============================================================
// ルート地図用 ジオコード (Nominatim) + マップデータ取得
// ============================================================
router.post('/geocode/:load_date', authUser, express.json(), async (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const ld = req.params.load_date;
  const force = !!(req.body && req.body.force);
  const db = getDb();

  // viewbox外 (関東外) のキャッシュは強制クリーンアップ
  const dirty = db.prepare(`SELECT address, lat, lng FROM td_geocache WHERE lat IS NOT NULL`).all();
  let purged = 0;
  for (const d of dirty) {
    if (!inKanto(d.lat, d.lng)) {
      db.prepare(`DELETE FROM td_geocache WHERE address = ?`).run(d.address);
      purged++;
    }
  }
  // force=1なら全削除して再取得
  if (force) {
    const n = db.prepare(`SELECT COUNT(*) AS c FROM td_geocache`).get().c;
    db.prepare(`DELETE FROM td_geocache`).run();
    purged += n;
  }

  // 配車中の住所一覧 (重複除去)
  const stops = db.prepare(`SELECT DISTINCT address FROM td_dispatches WHERE load_date = ? AND address <> ''`).all(ld);
  const histAddrs = db.prepare(`SELECT DISTINCT address FROM td_dispatch_history WHERE address <> ''`).all();
  const all = new Set([...stops.map(s => s.address), ...histAddrs.map(h => h.address)]);
  let processed = 0, hits = 0, fails = 0, cached = 0;
  res.json({ success: true, msg: `ジオコード処理開始 (${all.size}件 / 関東外キャッシュ${purged}件削除)`, count: all.size, purged });
  (async () => {
    for (const addr of all) {
      processed++;
      const r = await geocode(addr);
      if (r) {
        hits++;
        if (r.cached) cached++;
      } else fails++;
    }
    console.log(`[geocode] ${ld} done: ${hits}/${all.size} hits (cache${cached}), fails ${fails}, purged ${purged}`);
  })().catch(e => console.error('geocode error', e));
});

// 単発住所のジオコード状況取得
router.get('/geocode-status/:load_date', authUser, (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const ld = req.params.load_date;
  const stops = getDb().prepare(`SELECT DISTINCT address FROM td_dispatches WHERE load_date = ? AND address <> ''`).all(ld);
  let total = stops.length, hit = 0, fail = 0, pending = 0;
  for (const s of stops) {
    const c = getDb().prepare(`SELECT lat, accuracy FROM td_geocache WHERE address = ?`).get(s.address);
    if (!c) pending++;
    else if (c.lat != null) hit++;
    else fail++;
  }
  res.json({ success: true, total, hit, fail, pending });
});

// ルート地図用データ (各号車のストップに緯度経度を付与)
router.get('/route-map/:load_date', authUser, (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const ld = req.params.load_date;
  const stops = getDb().prepare(`SELECT * FROM td_dispatches WHERE load_date = ? ORDER BY vehicle_no, sequence`).all(ld);
  const meta = getDb().prepare(`SELECT * FROM td_dispatch_meta WHERE load_date = ?`).all(ld);
  const cacheRows = getDb().prepare(`SELECT * FROM td_geocache`).all();
  const cache = new Map(cacheRows.map(c => [c.address, c]));
  // 号車別グループ化
  const byVeh = new Map();
  for (const s of stops) {
    if (!byVeh.has(s.vehicle_no)) byVeh.set(s.vehicle_no, { vehicle_no: s.vehicle_no, stops: [], total_sai: 0 });
    const g = byVeh.get(s.vehicle_no);
    const c = cache.get(s.address || '');
    g.stops.push({
      ...s,
      lat: c && c.lat != null ? c.lat : null,
      lng: c && c.lng != null ? c.lng : null,
      geo_accuracy: c ? c.accuracy : null,
    });
    g.total_sai += s.sai || 0;
  }
  const vehicles = [...byVeh.values()].map(g => {
    const m = meta.find(x => x.vehicle_no === g.vehicle_no) || {};
    const cls = classifyVehicle(g.vehicle_no);
    const geocoded = g.stops.filter(s => s.lat != null).length;
    return { ...g, ...m, company: cls.company, delivery_day: cls.delivery_day, geocoded_count: geocoded };
  });
  // 拠点一覧 (業者ごとに切替) + 各号車に depot 紐付
  for (const v of vehicles) {
    const dep = depotForCompany(v.company);
    v.depot_key = dep.key;
    v.depot = dep;
  }
  res.json({ success: true, load_date: ld, depots: DEPOTS, vehicles });
});

// ============================================================
// 車種マスタ
// ============================================================
router.get('/vehicle-types', authUser, (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const rows = getDb().prepare(`SELECT * FROM td_vehicle_types ORDER BY sort_order, vehicle_type`).all();
  res.json({ success: true, types: rows });
});

router.post('/vehicle-types', authUser, express.json(), (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const types = (req.body && req.body.types) || [];
  if (!Array.isArray(types)) return res.status(400).json({ success: false, msg: 'types は配列必須' });
  const db = getDb();
  const upsert = db.prepare(`INSERT INTO td_vehicle_types
    (vehicle_type, capacity_sai, return_by_min, max_stops, is_active, sort_order, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(vehicle_type) DO UPDATE SET
      capacity_sai = excluded.capacity_sai,
      return_by_min = excluded.return_by_min,
      max_stops = excluded.max_stops,
      is_active = excluded.is_active,
      sort_order = excluded.sort_order,
      notes = excluded.notes,
      updated_at = datetime('now')`);
  const tx = db.transaction(() => {
    for (const t of types) {
      const vt = String(t.vehicle_type || '').trim();
      if (!vt) continue;
      upsert.run(vt,
        Math.max(1, parseInt(t.capacity_sai) || 100),
        Math.max(0, parseInt(t.return_by_min) || 840),
        Math.max(1, parseInt(t.max_stops) || 6),
        t.is_active ? 1 : 0,
        parseInt(t.sort_order) || 100,
        String(t.notes || ''),
      );
    }
  });
  tx();
  res.json({ success: true, count: types.length });
});

router.delete('/vehicle-types/:vt', authUser, (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  getDb().prepare(`DELETE FROM td_vehicle_types WHERE vehicle_type = ?`).run(req.params.vt);
  res.json({ success: true });
});

// ============================================================
// WMS → td_dispatches 反映 (タカラ配車を素直に画面化)
// 物理車両単位の集約は Logistar履歴があれば適用、なければ号車番号=1物理車両
// ============================================================
// 配送日計算: WMS積込日(N) → Logistar配送日(N+1)、金曜なら土曜+月曜
function calcDeliveryDates(wmsDate) {
  if (!/^\d{8}$/.test(wmsDate)) return [];
  const y = +wmsDate.slice(0,4), m = +wmsDate.slice(4,6) - 1, d = +wmsDate.slice(6,8);
  const dt = new Date(y, m, d);
  const dow = dt.getDay();  // 0=日, 5=金, 6=土
  const fmt = (x) => x.getFullYear() + String(x.getMonth()+1).padStart(2,'0') + String(x.getDate()).padStart(2,'0');
  if (dow === 5) {  // 金曜=土曜+月曜
    const sat = new Date(dt); sat.setDate(sat.getDate() + 1);
    const mon = new Date(dt); mon.setDate(mon.getDate() + 3);
    return [fmt(sat), fmt(mon)];
  }
  if (dow === 6) {  // 土曜=月曜
    const mon = new Date(dt); mon.setDate(mon.getDate() + 2);
    return [fmt(mon)];
  }
  if (dow === 0) {  // 日曜=月曜
    const mon = new Date(dt); mon.setDate(mon.getDate() + 1);
    return [fmt(mon)];
  }
  // 平日: 翌日
  const next = new Date(dt); next.setDate(next.getDate() + 1);
  return [fmt(next)];
}

router.post('/from-wms/:load_date', authUser, express.json(), (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const ld = req.params.load_date;
  const db = getDb();
  const orderRows = db.prepare(`SELECT * FROM td_orders WHERE load_date = ? ORDER BY original_vehicle_no, id`).all(ld);
  if (!orderRows.length) return res.status(400).json({ success: false, msg: 'WMSデータがありません' });

  // 施工引取分(950-959/971-979)は配車対象外
  const isPickupOnly = (vno) => {
    const n = parseInt(vno, 10);
    return !isNaN(n) && ((n >= 950 && n <= 959) || (n >= 971 && n <= 979));
  };

  // 翌日 (or 金曜なら土+月) のLogistarを「時間指定マスター」として参照
  const deliveryDates = calcDeliveryDates(ld);
  const histRows = deliveryDates.length
    ? db.prepare(`SELECT * FROM td_dispatch_history WHERE load_date IN (${deliveryDates.map(()=>'?').join(',')}) ORDER BY load_date, id`).all(...deliveryDates)
    : [];
  // 物理車両マップ: 配送日ごとに sequence=1区切りで集約
  const physMap = new Map();  // (delivery_date::dispatch_no) → phys_vehicle_no
  const physInfo = new Map();  // phys_vehicle_no → {vehicle_type, eta_first, etc}
  let curPhys = null, curDate = null;
  for (const r of histRows) {
    if (r.load_date !== curDate) { curDate = r.load_date; curPhys = null; }
    if (r.sequence === 1 || !r.sequence || !curPhys) curPhys = r.original_vehicle_no;
    if (curPhys) {
      physMap.set(`${r.load_date}::${r.original_vehicle_no}`, curPhys);
      if (!physInfo.has(curPhys)) physInfo.set(curPhys, { vehicle_type: r.vehicle_type, delivery_date: r.load_date });
    }
  }

  // site_name 正規化: 空白除去・敬称/期間記号除去で表記揺れに対応
  const normalizeSite = (s) => String(s || '')
    .replace(/[\s　]+/g, '')
    .replace(/様|殿|邸|建売|号棟|号室|期|号/g, '')
    .toLowerCase()
    .trim();
  // 「時間指定マスター」: 翌日Logistarから 時間指定(hard) マークの現場のみ抽出
  const tFixedMap = new Map();  // normalize(site_name) → {eta, address, vehicle_no(物理), original_vehicle_no, vehicle_type}
  for (const h of histRows) {
    const k = normalizeSite(h.site_name);
    if (!k || !h.site_name || h.site_name.includes('ルート配送専用')) continue;
    if (h.time_spec === 'hard' && !tFixedMap.has(k)) {
      tFixedMap.set(k, {
        eta: h.eta || '',
        address: h.address || '',
        vehicle_no: physMap.get(`${h.load_date}::${h.original_vehicle_no}`) || h.original_vehicle_no,
        original_vehicle_no: h.original_vehicle_no,
        vehicle_type: h.vehicle_type || '',
        delivery_date: h.load_date,
      });
    }
  }
  // 過去履歴の住所キャッシュ (補完用)
  const addrMap = new Map();
  const allHistForAddr = db.prepare(`SELECT site_name, address FROM td_dispatch_history WHERE address <> ''`).all();
  for (const h of allHistForAddr) {
    const k = normalizeSite(h.site_name);
    if (k && !addrMap.has(k)) addrMap.set(k, h.address);
  }

  // 履歴の vehicle_type (代表号車別)
  const vtMap = new Map();
  for (const r of histRows) {
    const phys = physMap.get(`${r.load_date}::${r.original_vehicle_no}`) || r.original_vehicle_no;
    if (!vtMap.has(phys) && r.vehicle_type) vtMap.set(phys, (r.vehicle_type || '').split('／')[0].trim());
  }

  // WMS現場を集約 (1現場=1ストップ、qty/sai合算)
  const stopMap = new Map();
  for (const o of orderRows) {
    if (isPickupOnly(o.original_vehicle_no)) continue;
    const veh = String(o.original_vehicle_no || '').trim();
    if (!veh) continue;
    const key = o.site_name || '';
    if (!stopMap.has(key)) {
      stopMap.set(key, {
        original_vehicle_no_wms: veh,
        site_name: o.site_name || '',
        sai: 0, qty: 0,
      });
    }
    const s = stopMap.get(key);
    s.sai += parseFloat(o.sai) || 0;
    s.qty += parseFloat(o.qty) || 0;
  }
  const stops = [...stopMap.values()];

  // 住所候補抽出 (site_name自体に地名が含まれる場合)
  const extractLocation = (name) => {
    if (!name) return '';
    let s = String(name).trim();
    const slash = s.split(/[／\/]/);
    if (slash.length >= 2) s = slash[0];
    s = s.replace(/(様|殿|邸)$/, '').trim();
    if (/[区市町丁目県号棟号室]/.test(s)) return s;
    return '';
  };

  // ===== 時間指定 vs ルート便 分類 =====
  const timeFixedStops = [];
  const routeStops = [];
  for (const s of stops) {
    const k = normalizeSite(s.site_name);
    const tf = tFixedMap.get(k);
    if (tf) {
      // 時間指定: Logistarに記録あり
      s.time_spec = 'hard';
      s.eta = tf.eta;
      s.address = tf.address || addrMap.get(k) || extractLocation(s.site_name);
      s.vehicle_no = tf.vehicle_no;  // Logistar由来の物理車両号車
      s.kind = 'fixed';
      timeFixedStops.push(s);
    } else {
      // ルート便: 9:00-16:00で割付
      s.time_spec = null;
      s.address = addrMap.get(k) || extractLocation(s.site_name) || '';
      s.kind = 'route';
      routeStops.push(s);
    }
  }

  // ===== 時間指定車両: 物理車両単位でグルーピング =====
  // 車種マスタから容量取得
  const vehTypeMaster = new Map();
  for (const t of db.prepare(`SELECT * FROM td_vehicle_types WHERE is_active = 1`).all()) {
    vehTypeMaster.set(t.vehicle_type, t);
  }
  const matchVehType = (raw) => {
    const s = (raw || '').trim();
    if (vehTypeMaster.has(s)) return vehTypeMaster.get(s);
    for (const [k, v] of vehTypeMaster) if (s.includes(k) || (k && s.includes(k))) return v;
    return vehTypeMaster.get('2tｼｮｰﾄ') || { capacity_sai: 100, max_stops: 6 };
  };

  // 時間指定車両: Logistarの物理車両単位で構築
  const fixedVehMap = new Map();
  for (const s of timeFixedStops) {
    if (!fixedVehMap.has(s.vehicle_no)) {
      const vt = matchVehType(vtMap.get(s.vehicle_no) || '');
      fixedVehMap.set(s.vehicle_no, {
        vehicle_no: s.vehicle_no,
        vehicle_type: vtMap.get(s.vehicle_no) || vt.vehicle_type || '2tｼｮｰﾄ',
        capacity: vt.capacity_sai,
        max_stops: vt.max_stops || 12,
        stops: [], total_sai: 0, is_route_only: false,
      });
    }
    const v = fixedVehMap.get(s.vehicle_no);
    v.stops.push(s); v.total_sai += s.sai || 0;
  }

  // ===== 方面コード判定 (時間指定先と同方面のルート便のみ混載) =====
  // 座間中心→各方面。時間指定先と「同じ方面 or 経由地点になる方面」のみ混載許可
  // 例: 横須賀(SE)時間指定 → SE方面のルート便だけ混載 (小田原SW方面は積まない)
  const DIRECTION_MAP = [
    ['横須賀', 'SE'], ['三浦', 'SE'], ['逗子', 'SE'], ['葉山', 'SE'], ['鎌倉', 'SE'],
    ['横浜市金沢', 'SE'], ['磯子', 'SE'], ['港南', 'SE'], ['栄区', 'SE'], ['戸塚', 'SE'],
    ['藤沢', 'S'], ['茅ヶ崎', 'S'], ['茅ケ崎', 'S'], ['寒川', 'S'],
    ['平塚', 'SW'], ['二宮', 'SW'], ['小田原', 'SW'], ['南足柄', 'SW'], ['大磯', 'SW'], ['足柄', 'SW'],
    ['伊勢原', 'W'], ['厚木', 'W'], ['秦野', 'W'], ['愛川', 'W'], ['清川', 'W'],
    ['相模原', 'N'], ['大和', 'N'], ['海老名', 'N'], ['綾瀬', 'N'], ['座間', 'C'],
    ['町田', 'NW'], ['八王子', 'NW'], ['多摩', 'NW'], ['日野', 'NW'],
    ['川崎', 'NE'], ['大田', 'NE'], ['品川', 'NE'], ['目黒', 'NE'], ['世田谷', 'NE'], ['杉並', 'NE'],
    ['東京都', 'NE'],
    ['鶴見', 'E'], ['神奈川区', 'E'], ['西区', 'E'], ['中区', 'E'], ['南区', 'E'], ['保土ヶ谷', 'E'],
    ['保土ケ谷', 'E'], ['港北', 'E'], ['緑区', 'E'], ['青葉', 'E'], ['都筑', 'E'], ['泉区', 'E'],
    ['横浜市', 'E'],
  ];
  function detectDirection(addr) {
    if (!addr) return 'X';  // 不明
    for (const [prefix, dir] of DIRECTION_MAP) if (addr.includes(prefix)) return dir;
    return 'X';
  }
  // 各時間指定車両の代表方面 = ストップの方面の最頻
  for (const v of fixedVehMap.values()) {
    const dirCount = {};
    for (const s of v.stops) {
      const d = detectDirection(s.address || s.site_name);
      dirCount[d] = (dirCount[d] || 0) + 1;
    }
    let bestDir = 'X', bestN = 0;
    for (const [d, n] of Object.entries(dirCount)) if (n > bestN && d !== 'X') { bestDir = d; bestN = n; }
    v.direction = bestDir;
  }

  // 14時帰庫可能エリア (座間から近距離片道1h以内)
  // SE/S/SW (横須賀・藤沢・小田原) は遠方=14時帰庫困難 → 第二候補に含めない
  const CLOSE_DIRECTIONS = new Set(['N', 'W', 'E', 'NW', 'NE', 'C']);

  const fixedArr = [...fixedVehMap.values()];
  routeStops.sort((a, b) => (b.sai || 0) - (a.sai || 0));
  const remainingRoute = [];
  const MAX_STOPS_MIXED = 14;  // 時間指定+混載 合計件数上限
  for (const s of routeStops) {
    const sDir = detectDirection(s.address || s.site_name);
    let target = null;
    let stage = 0;
    // 1段目: 同方面の時間指定車両 (時間指定先→座間 道中ルート)
    if (sDir !== 'X') {
      let bestFree = -1;
      for (const v of fixedArr) {
        if (v.direction !== sDir) continue;
        const free = v.capacity - v.total_sai;
        if (free < (s.sai || 0)) continue;
        if (v.stops.length >= MAX_STOPS_MIXED) continue;
        if (free > bestFree) { target = v; bestFree = free; stage = 1; }
      }
    }
    // 2段目: ルート便が14時帰庫可能エリア → 容量空き最大の時間指定車両 (方面不問)
    if (!target && CLOSE_DIRECTIONS.has(sDir)) {
      let bestFree = -1;
      for (const v of fixedArr) {
        const free = v.capacity - v.total_sai;
        if (free < (s.sai || 0)) continue;
        if (v.stops.length >= MAX_STOPS_MIXED) continue;
        if (free > bestFree) { target = v; bestFree = free; stage = 2; }
      }
    }
    if (target) {
      s.vehicle_no = target.vehicle_no;
      s.kind = 'route_mixed';
      s.mix_stage = stage;
      target.stops.push(s);
      target.total_sai += s.sai || 0;
    } else {
      remainingRoute.push(s);
    }
  }

  // 時間指定車両のストップ順並べ替え: ETA順 + ルート便(ETA空)は末尾に挿入してETA振付
  for (const v of fixedArr) {
    const fixed = v.stops.filter(s => s.kind !== 'route_mixed').sort((a,b)=>(a.eta||'').localeCompare(b.eta||''));
    const mixed = v.stops.filter(s => s.kind === 'route_mixed');
    // 時間指定の後 (最後ETA+30分間隔) にルート便を配置
    const lastEtaMin = fixed.length ? (() => { const m = (fixed[fixed.length-1].eta || '').match(/(\d{1,2}):(\d{2})/); return m ? +m[1]*60 + +m[2] : 9*60; })() : 9*60;
    mixed.forEach((s, i) => {
      const t = lastEtaMin + 30 + i * 30;
      const hh = Math.floor(t / 60), mm = t % 60;
      s.eta = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
    });
    v.stops = [...fixed, ...mixed];
    v.stops.forEach((s, i) => s.sequence = i + 1);
  }

  // ===== 残ったルート便のみ専用車両 =====
  const ROUTE_CAP = 80;
  const ROUTE_MAX_STOPS = 14;
  const routeVehicles = [];
  remainingRoute.sort((a, b) => (b.sai || 0) - (a.sai || 0));
  for (const s of remainingRoute) {
    let placed = false;
    for (const v of routeVehicles) {
      if (v.total_sai + (s.sai || 0) <= v.capacity && v.stops.length < ROUTE_MAX_STOPS) {
        v.stops.push(s); v.total_sai += s.sai || 0; placed = true; break;
      }
    }
    if (!placed) {
      routeVehicles.push({
        vehicle_no: `ルート補完${routeVehicles.length + 1}`,
        capacity: ROUTE_CAP, vehicle_type: 'ルート便',
        stops: [s], total_sai: s.sai || 0, is_route_only: true, max_stops: ROUTE_MAX_STOPS,
      });
    }
  }
  for (const v of routeVehicles) {
    const n = v.stops.length;
    const startMin = 9*60, endMin = 16*60;
    const interval = n > 1 ? Math.floor((endMin - startMin) / n) : 60;
    v.stops.forEach((s, i) => {
      const m = startMin + i * interval;
      const hh = Math.floor(m / 60), mm = m % 60;
      s.eta = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
      s.sequence = i + 1;
      s.vehicle_no = v.vehicle_no;
    });
  }

  // 統合
  const allVehicles = [...fixedArr, ...routeVehicles];

  // DB反映
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM td_dispatches WHERE load_date = ?`).run(ld);
    db.prepare(`DELETE FROM td_dispatch_meta WHERE load_date = ?`).run(ld);
    const insStop = db.prepare(`INSERT INTO td_dispatches
      (load_date, vehicle_no, sequence, site_name, address, eta, time_spec, qty, sai, notes, ai_reason, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
    const insMeta = db.prepare(`INSERT OR REPLACE INTO td_dispatch_meta
      (load_date, vehicle_no, vehicle_type, driver_token, status, driver_name)
      VALUES (?, ?, ?, ?, 'draft', '')`);
    for (const v of allVehicles) {
      insMeta.run(ld, v.vehicle_no, v.vehicle_type || '', gen8());
      const reason = v.is_route_only ? 'ルート便 (9-16時補完)' : `時間指定車両 (Logistar由来)`;
      for (const s of v.stops) {
        const note = v.is_route_only ? 'ルート便' : (s.original_vehicle_no_wms !== v.vehicle_no ? `(WMS#${s.original_vehicle_no_wms})` : '');
        insStop.run(ld, v.vehicle_no, s.sequence, s.site_name, s.address || '',
          s.eta || '', s.time_spec || null, s.qty || 0, s.sai || 0, note, reason);
      }
    }
  });
  tx();

  const mixedCount = fixedArr.reduce((a, v) => a + v.stops.filter(s => s.kind === 'route_mixed').length, 0);
  res.json({
    success: true,
    msg: `WMS反映: 時間指定車両${fixedVehMap.size}台 (時間指定${timeFixedStops.length}件+混載${mixedCount}件) / 補完便${routeVehicles.length}台/${remainingRoute.length}件 = 計${allVehicles.length}台`,
    delivery_dates: deliveryDates,
    time_fixed: { vehicles: fixedVehMap.size, stops: timeFixedStops.length, mixed_route: mixedCount },
    route_supplement: { vehicles: routeVehicles.length, stops: remainingRoute.length },
    total_vehicles: allVehicles.length,
  });
});

// ============================================================
// OR-Tools 骨組み配車生成 (Phase A)
// 業者×配送日で号車プールを分離 → CVRP+TW でストップを割付
// 結果は td_dispatches に UPSERT (既存の AI/手動データを上書き)
// ============================================================
router.post('/ortools-plan/:load_date', authUser, express.json(), async (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const ld = req.params.load_date;
  const dayFilter = (req.body && req.body.delivery_day) || null;  // '平日' / '土曜' / null=両方
  const timeLimit = parseInt(req.body && req.body.time_limit_sec) || 20;
  const db = getDb();

  // 1) WMS現場集約 (現場名で1ストップに集約)
  const orderRows = db.prepare(`SELECT * FROM td_orders WHERE load_date = ?`).all(ld);
  if (!orderRows.length) return res.status(400).json({ success: false, msg: 'WMSデータが取り込まれていません' });

  // 施工引取分(950-959/971-979)は配車対象外
  const isPickupOnly = (vno) => {
    const n = parseInt(vno, 10);
    return !isNaN(n) && ((n >= 950 && n <= 959) || (n >= 971 && n <= 979));
  };

  const siteMap = new Map();  // 現場名+元号車 → {id, site_name, sai, qty, original_vehicle_no, items}
  for (const o of orderRows) {
    if (isPickupOnly(o.original_vehicle_no)) continue;
    const key = `${o.site_name || ''}__${o.original_vehicle_no || ''}`;
    if (!siteMap.has(key)) {
      siteMap.set(key, { id: siteMap.size + 1, site_name: o.site_name, original_vehicle_no: o.original_vehicle_no, sai: 0, qty: 0, items: [] });
    }
    const s = siteMap.get(key);
    s.sai += parseFloat(o.sai) || 0;
    s.qty += parseFloat(o.qty) || 0;
    s.items.push({ name: o.product_name, qty: o.qty, sai: o.sai });
  }
  let stops = [...siteMap.values()];

  // 2) 配車履歴 td_dispatch_history から site_name→address・time_spec マップ作成 (近い日付ほど優先)
  const histRows = db.prepare(`SELECT site_name, address, time_spec, eta FROM td_dispatch_history WHERE address <> '' OR time_spec IS NOT NULL`).all();
  const addrMap = new Map();
  const tspecMap = new Map();
  for (const h of histRows) {
    if (h.address && !addrMap.has(h.site_name)) addrMap.set(h.site_name, h.address);
    if (h.time_spec && !tspecMap.has(h.site_name)) tspecMap.set(h.site_name, { time_spec: h.time_spec, eta: h.eta });
  }
  for (const s of stops) {
    s.address = addrMap.get(s.site_name) || '';
    const t = tspecMap.get(s.site_name);
    if (t) { s.time_spec = t.time_spec; s.hint_eta = t.eta; }
    s.service_min = 25;
  }

  // 3) 配送日種別ごとに分割
  const splitByDay = (orig) => classifyVehicle(orig).delivery_day;
  if (dayFilter) stops = stops.filter(s => splitByDay(s.original_vehicle_no) === dayFilter);

  // 4) 号車プール: 配車履歴の 物理車両 (sequence=1で区切る) から業者×配送日 でユニーク化
  // 車種マスタ td_vehicle_types を参照して capacity/return_by_min を決定
  const typeMaster = new Map();
  for (const t of db.prepare(`SELECT * FROM td_vehicle_types WHERE is_active = 1`).all()) {
    typeMaster.set(t.vehicle_type, t);
  }
  const matchType = (raw) => {
    const s = (raw || '').trim();
    if (typeMaster.has(s)) return typeMaster.get(s);
    for (const [k, v] of typeMaster) if (s.includes(k)) return v;
    for (const [k, v] of typeMaster) if (k.includes(s) && s) return v;
    return typeMaster.get('2tｼｮｰﾄ') || { vehicle_type: '2tｼｮｰﾄ', capacity_sai: 100, return_by_min: 840 };
  };

  const allHist = db.prepare(`SELECT * FROM td_dispatch_history ORDER BY load_date, id`).all();
  const physVehicles = new Map();
  let curPhys = null;
  for (const r of allHist) {
    if (r.sequence === 1 || !r.sequence) curPhys = r.original_vehicle_no;
    if (!curPhys) continue;
    const cls = classifyVehicle(curPhys);
    if (!cls.company || cls.company === '施工引取' || cls.company === 'その他') continue;
    if (dayFilter && cls.delivery_day !== dayFilter) continue;
    const key = `${cls.company}__${cls.delivery_day}__${curPhys}`;
    if (!physVehicles.has(key)) {
      const rawVt = (r.vehicle_type || '').split('／')[0].trim() || '2tｼｮｰﾄ';
      const tm = matchType(rawVt);
      physVehicles.set(key, {
        id: curPhys,
        company: cls.company,
        delivery_day: cls.delivery_day,
        vehicle_type: tm.vehicle_type,
        capacity_sai: tm.capacity_sai,
        return_by_min: tm.return_by_min,
      });
    }
  }
  const allVehicles = [...physVehicles.values()];
  if (!allVehicles.length) return res.status(400).json({ success: false, msg: '号車プールが空です。配車履歴を取り込んでください' });

  // 5) 業者×depotで分割呼び出し (スタ運/昭栄→座間, ｶｰﾚﾝﾄ→東扇島)
  // ストップは original_vehicle_no から業者を判定して振り分け
  const groups = {};  // company → { depot, vehicles, stops }
  for (const v of allVehicles) {
    if (!groups[v.company]) {
      const dep = depotForCompany(v.company);
      groups[v.company] = { depot: dep, vehicles: [], stops: [] };
    }
    groups[v.company].vehicles.push(v);
  }
  for (const s of stops) {
    const cls = classifyVehicle(s.original_vehicle_no);
    if (!cls.company || !groups[cls.company]) continue;  // 該当業者の号車プールがなければスキップ
    groups[cls.company].stops.push(s);
  }

  // 6) 業者ごとに solveVRP 呼び出し → 結果統合
  const allAssignments = [];
  const allUnassigned = [];
  let totalStats = { total_stops: 0, assigned_stops: 0, vehicles_used_real: 0, vehicles_used_charter: 0, total_sai_assigned: 0 };
  const groupResults = {};

  for (const [company, g] of Object.entries(groups)) {
    if (!g.stops.length) continue;
    const payload = {
      depot_address: g.depot.address,
      vehicles: g.vehicles,
      stops: g.stops.map(s => ({
        id: s.id, site_name: s.site_name, address: s.address || '', sai: s.sai, qty: s.qty,
        time_spec: s.time_spec || null, service_min: s.service_min,
      })),
      time_limit_sec: timeLimit,
      charter_max: 5,
      charter_capacity: 600,
      day_start_min: 7 * 60,
      day_end_min: 18 * 60,
    };
    try {
      const r = await solveVRP(payload, { timeoutSec: timeLimit + 30 });
      if (!r.success) {
        groupResults[company] = { error: r.msg || 'no solution' };
        continue;
      }
      groupResults[company] = { stats: r.stats, depot: g.depot.name };
      // 庸車IDに会社名サフィックスを付けて衝突回避
      for (const a of r.assignments) {
        if (a.is_charter) a.vehicle_id = `庸車-${company}-${a.vehicle_id.replace('庸車-','')}`;
        a.depot = g.depot.key;
      }
      allAssignments.push(...r.assignments);
      allUnassigned.push(...(r.unassigned || []).map(u => ({ ...u, company })));
      totalStats.total_stops += r.stats.total_stops;
      totalStats.assigned_stops += r.stats.assigned_stops;
      totalStats.vehicles_used_real += r.stats.vehicles_used_real;
      totalStats.vehicles_used_charter += r.stats.vehicles_used_charter;
      totalStats.total_sai_assigned += r.stats.total_sai_assigned;
    } catch (e) {
      groupResults[company] = { error: e.message };
    }
  }

  // 7) DB 反映
  const tx = db.transaction(() => {
    if (dayFilter) {
      const targets = db.prepare(`SELECT DISTINCT vehicle_no FROM td_dispatches WHERE load_date = ?`).all(ld);
      for (const t of targets) {
        const cls = classifyVehicle(t.vehicle_no);
        if (cls.delivery_day === dayFilter) {
          db.prepare(`DELETE FROM td_dispatches WHERE load_date = ? AND vehicle_no = ?`).run(ld, t.vehicle_no);
        }
      }
    } else {
      db.prepare(`DELETE FROM td_dispatches WHERE load_date = ?`).run(ld);
      db.prepare(`DELETE FROM td_dispatch_meta WHERE load_date = ?`).run(ld);
    }
    const insStop = db.prepare(`INSERT INTO td_dispatches
      (load_date, vehicle_no, sequence, site_name, address, eta, time_spec, qty, sai, notes, ai_reason, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
    const insMeta = db.prepare(`INSERT OR REPLACE INTO td_dispatch_meta
      (load_date, vehicle_no, vehicle_type, driver_token, status, driver_name)
      VALUES (?, ?, ?, ?, 'draft', '')`);
    for (const a of allAssignments) {
      insMeta.run(ld, a.vehicle_id, a.vehicle_type || '', gen8());
      for (const s of a.stops) {
        const stopList = Object.values(groups).flatMap(g => g.stops);
        const orig = stopList.find(x => x.id === s.stop_id);
        const reason = `OR-Tools骨組み (${a.depot || '座間'}起点)`;
        insStop.run(ld, a.vehicle_id, s.sequence, s.site_name, s.address || '',
          s.eta || '', s.time_spec || null, orig?.qty || 0, orig?.sai || 0, '', reason);
      }
    }
  });
  tx();

  res.json({
    success: true,
    msg: `OR-Tools配車完了: ${totalStats.assigned_stops}/${totalStats.total_stops}件 / 実車${totalStats.vehicles_used_real}台 / 庸車${totalStats.vehicles_used_charter}台`,
    stats: totalStats,
    by_company: groupResults,
    unassigned: allUnassigned,
  });
});

router.post('/generate-dispatch', authUser, express.json(), async (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const ld = String((req.body && req.body.load_date) || '').trim();
  if (!/^\d{8}$/.test(ld)) return res.status(400).json({ success: false, msg: 'load_date は YYYYMMDD' });

  const db = getDb();
  // AI入力: WMS全現場(品目集計) + 配車結果の時間指定/住所ヒント を結合
  //  - WMS = 当日の全配送先 (時間指定なしも含む)
  //  - 配車結果 = Logistarで時間指定が組まれた分のみ (住所付き)
  //  → AIには両方を渡し、配車結果の住所を地理推定の手がかりに、
  //    WMS全現場を時間指定+周辺組込で一括配車させる
  const wmsSites = db.prepare(`
    SELECT site_name, SUM(qty) AS qty, SUM(sai) AS sai
    FROM td_orders WHERE load_date = ? AND site_name <> ''
    GROUP BY site_name
  `).all(ld);
  const dispatchHints = db.prepare(`
    SELECT site_name, address, time_spec, eta, sai
    FROM td_dispatch_history WHERE load_date = ? AND time_spec IN ('hard', 'soft')
    ORDER BY eta
  `).all(ld);
  // sites = WMS全現場 (AIの主入力)
  let sites = wmsSites.length ? wmsSites : db.prepare(`
    SELECT site_name, address, time_spec, eta, qty, sai
    FROM td_dispatch_history WHERE load_date = ? AND site_name <> ''
  `).all(ld);
  if (!sites.length) return res.status(400).json({ success: false, msg: '当日のデータがありません (WMSも配車結果も未取込)' });

  // (n)つき大型現場の自動分割: 集合住宅n戸まとめは複数台に分散配送が前提
  // 例: 神奈川区栗田谷(12) 508才 → 12分割 (各42才) で AIに渡す
  const expandedSites = [];
  let splitOriginCount = 0;
  for (const s of sites) {
    const m = s.site_name.match(/[(（](\d+)[)）]/);
    if (m) {
      const n = parseInt(m[1]);
      if (n >= 2 && (s.sai || 0) > 100) {
        const eachSai = Math.round((s.sai || 0) / n * 10) / 10;
        const eachQty = Math.round((s.qty || 0) / n);
        for (let i = 1; i <= n; i++) {
          expandedSites.push({
            ...s,
            site_name: `${s.site_name} 第${i}/${n}便`,
            sai: eachSai,
            qty: eachQty,
          });
        }
        splitOriginCount++;
        continue;
      }
    }
    expandedSites.push(s);
  }
  sites = expandedSites;

  // ジョブ起票
  const requestProvider = String((req.body && req.body.provider) || 'gemini').trim();
  const jobId = db.prepare(`INSERT INTO td_dispatch_jobs (load_date, status, request_summary, created_by) VALUES (?, 'running', ?, ?)`)
    .run(ld, JSON.stringify({ site_count: sites.length, total_sai: sites.reduce((a, s) => a + (s.sai || 0), 0), provider: requestProvider }), req.uid).lastInsertRowid;

  try {
    // 過去履歴から「実号車番号」と「実車種」を取得 (AIに投入する実号車プール)
    const fleet = db.prepare(`
      SELECT DISTINCT original_vehicle_no AS vehicle_no, vehicle_type
      FROM td_dispatch_history
      WHERE original_vehicle_no <> ''
        AND vehicle_type IN ('2tｼｮｰﾄ','2tｽﾘﾑ','2tｼｮｰﾄ平ﾎﾞﾃﾞｨ','2t平ﾎﾞﾃﾞｨ','2t')
      ORDER BY original_vehicle_no
    `).all();
    const fleetLines = fleet.map(f => `${f.vehicle_no} (${f.vehicle_type})`).join(', ');

    // プロンプト: WMS全現場をAI主入力、配車結果(時間指定+住所)をヒントとして渡す
    const wmsLines = sites.map((s, i) =>
      `${i + 1}. ${s.site_name} | 才数${(s.sai || 0).toFixed(1)} 数量${(s.qty || 0).toFixed(0)}`
    ).join('\n');
    const hintLines = dispatchHints.length
      ? dispatchHints.map((h, i) => {
          const tag = h.time_spec === 'hard' ? '🔒厳守' : '⏰希望';
          return `${i + 1}. 「${h.site_name}」 ${tag}${h.eta ? ' ' + h.eta : ''} / 才数${(h.sai || 0).toFixed(0)} / 住所:${h.address || '不明'}`;
        }).join('\n')
      : '(時間指定ヒントなし)';
    const siteListLines = wmsLines;

    const totalSai = sites.reduce((a, s) => a + (s.sai || 0), 0).toFixed(0);
    const minVehicles = Math.ceil(totalSai / 200);  // 平均200才/台と仮定して下限
    const prompt = `あなたは座間積替倉庫(神奈川県座間市)を起点とする首都圏配送の配車プランナーです。
タカラスタンダード様の住宅設備機器を首都圏に2t車両で配送するルートを組成します。

【🚨 絶対厳守 — 才数容量(積載量)】
1台の合計才数(saiの合計)は以下の上限を**絶対に**超えてはなりません(超過=配車不可):
- 軽ﾊﾞﾝ ≤ 30才
- ハイエース ≤ 80才
- 2tｽﾘﾑ ≤ 150才
- 2tｼｮｰﾄ ≤ 180才
- 2tｼｮｰﾄ平ﾎﾞﾃﾞｨ ≤ 200才
- 2t ≤ 250才
- 2t平ﾎﾞﾃﾞｨ ≤ 280才
- 2ワイド ≤ 280才

⚠️ 才数を必ず暗算で検算してから配車を確定。1才でも超えたら別号車に分割せよ。

【🚨 絶対厳守 — 車種表記の完全一致】
車種は以下8種類のいずれかを**そのまま**記載。誤記禁止(例: 「2tｼｮｴﾄ」「2t SHORT」「2tショート」等は全部NG):
**軽ﾊﾞﾝ / ハイエース / 2tｽﾘﾑ / 2tｼｮｰﾄ / 2tｼｮｰﾄ平ﾎﾞﾃﾞｨ / 2t / 2t平ﾎﾞﾃﾞｨ / 2ワイド**

【🚨 絶対厳守 — 常用車両台数で完結】
スタンダード運輸の常用車両は **1日 約60-70台** が固定上限です。
- 配車プランの **総号車数は60-75台に収める** (これを超えるのは禁止)
- 配車を分割しすぎるな (1台あたり3-5現場が普通)
- 才数容量を多少超えても (実態の人手は1台250-290才も普通)、台数を増やしてはいけない
- それでも収まらなければ summary に「庸車◯台必要」と明記して該当現場を警告
- 庸車警告対象は vehicle_no を "庸車-1", "庸車-2" として末尾にまとめる

【🚨 絶対厳守 — 14:00座間帰庫 (2t系車両)】
2t系車両 (2tｽﾘﾑ/2tｼｮｰﾄ/2tｼｮｰﾄ平ﾎﾞﾃﾞｨ/2t/2t平ﾎﾞﾃﾞｨ/2ワイド) は
**遅くとも14:00までに座間倉庫へ帰庫必須** (午後の積込作業のため、2回転運用)。
- 最終ストップETA + 配送・移動時間 ≤ 13:30 を目処に組成
- 14:00超のルートは **軽ﾊﾞﾝ・ハイエースに振る** (午後便扱い)
- 朝便+昼便の2回転を前提に午前で2t系業務完結

【🚐 必須 — 軽ﾊﾞﾝ・ハイエース 常用車両として必ず複数台稼働】
軽ﾊﾞﾝ・ハイエースは**常用車両**であり、毎日必ず複数台稼働:
- **時間指定が無い納品先は 軽ﾊﾞﾝ・ハイエースに優先割当** (才数大小問わず)
- 1日 軽ﾊﾞﾝ最低2台、ハイエース最低2台 必須
- 14:00以降の配送・午後便・小ロットを担当(2t系の補完)

【🌍 GHG排出量・脱炭素経営 (SBTi認定済 1.5℃)】
排出係数 g-CO2/km: 軽ﾊﾞﾝ約120 / ハイエース約200 / 2tｼｮｰﾄ約400 / 2t系約500
時間指定なし小ロットは軽ﾊﾞﾝ・ハイエースで GHG最小化

【📐 当日の規模感】
- WMS総才数: 約${totalSai}才
- 必要号車数の下限: 約${minVehicles}台 (平均200才/台で計算)
- **目標台数: 35〜70台/日** (人手実態と同等の規模で組成)
- **実運用は1日 35〜70台**。これより極端に少ない出力は才数違反の証拠。

【その他の制約】
- 起点・終点: 座間倉庫
- 時間指定厳守(🔒): ETA±15分以内
- 時間希望(⏰): ETA±60分許容
- **1台あたり 1〜3現場**:
  - 大型(才数150才超単独) → 1現場/台
  - 同方面で容量内に収まる場合のみ 2〜3現場/台
  - 4現場以上は禁止
- 同方面束ね優先 (時間指定の住所周辺に時間指定なし現場を組み込む)
- 座間帰着前提

【時間指定+住所ヒント (Logistarが組んだ${dispatchHints.length}現場、地理推論の起点)】
${hintLines}

※ 上記の住所を地理的アンカーに、下記WMS全現場を方面束ね。
※ 表記揺れ可。WMSのみ存在する現場(時間指定なし)も同方面の号車に組み込む。

【使用可能な実号車プール】
${fleetLines}

【WMS全配送先 (load_date=${ld}, 計${sites.length}現場、site_nameは入力どおり一字一句変更しない)】
${siteListLines}

【📋 出力前の自己チェック】
出力する前に以下を必ず確認:
1. 各号車の sai合計 を計算し、車種上限以下であることを確認
2. 違反があれば、その号車を分割
3. 全WMS現場(${sites.length}件)が必ずどこかの号車に含まれている
4. 時間指定厳守(🔒)の現場が ETA順に並んでいる

【出力フォーマット (JSONのみ、それ以外何も書かない)】
{
  "vehicles": [
    {
      "vehicle_no": "401",
      "vehicle_type": "軽ﾊﾞﾝ|ハイエース|2tｽﾘﾑ|2tｼｮｰﾄ|2tｼｮｰﾄ平ﾎﾞﾃﾞｨ|2t|2t平ﾎﾞﾃﾞｨ|2ワイド",
      "stops": [
        {
          "sequence": 1,
          "site_name": "(納入先名 入力リストのものをそのまま、改変禁止)",
          "eta": "0800",
          "time_spec": "hard|soft|null",
          "qty": 27,
          "sai": 97,
          "reason": "時間指定厳守、神奈川中部、軽ﾊﾞﾝ可"
        }
      ]
    }
  ],
  "summary": "号車数X台 (軽ﾊﾞﾝY/ハイエースZ/2t系W)、平均◯ストップ、推定GHG排出量◯kg-CO2、座間帰着前提"
}

【📋 出力前の自己チェック】
1. 各号車の合計才数 ≤ 車種上限
2. **才数に応じた最小サイズ車種** を選択(GHG最小化)
3. **軽ﾊﾞﾝ・ハイエースを1台以上**含む
4. 全${sites.length}件のWMS現場が必ずどこかの号車に含まれる
5. 時間指定厳守(🔒)はETA順`;

    // provider切替: 'gemini' (default) | 'claude-haiku' | 'claude-sonnet' | 'claude-opus' | 'hybrid'
    const provider = String((req.body && req.body.provider) || 'gemini').trim();
    const claudeModelMap = {
      'claude-haiku': 'claude-haiku-4-5-20251001',
      'claude-sonnet': 'claude-sonnet-4-6',
      'claude-opus': 'claude-opus-4-7',
    };
    let out;
    if (provider in claudeModelMap) {
      out = await generateTextClaude(prompt, {
        model: claudeModelMap[provider],
        temperature: 0.3,
        maxTokens: 32000,
        responseMimeType: 'application/json',
      });
    } else if (provider === 'hybrid') {
      // Geminiが第一案、Claude Sonnetで才数検証+補正
      const first = await generateText(prompt, {
        model: 'gemini-2.5-flash',
        temperature: 0.3,
        maxTokens: 60000,
        responseMimeType: 'application/json',
      });
      const verifyPrompt = `以下はAIが組成した配車プランJSONです。
このプランを検証し、才数オーバー(車種上限超え)や(n)つき大型現場の取り違えがあれば修正してください。

【車種容量上限】
- 軽ﾊﾞﾝ ≤ 30才, ハイエース ≤ 80才
- 2tｽﾘﾑ ≤ 150才, 2tｼｮｰﾄ ≤ 180才
- 2tｼｮｰﾄ平ﾎﾞﾃﾞｨ ≤ 200才, 2t ≤ 250才
- 2t平ﾎﾞﾃﾞｨ ≤ 280才, 2ワイド ≤ 280才

【入力プラン】
${first}

【検証手順】
1. 各号車の sai合計 を計算 → 上限超過なら同方面で別号車に分割
2. 軽ﾊﾞﾝ・ハイエース が1台以上含まれているか確認、不足なら 30才以下/80才以下の現場を抽出して割当
3. 修正済みプランを **同じJSONフォーマット** で返す (それ以外何も書かない)`;
      out = await generateTextClaude(verifyPrompt, {
        model: 'claude-sonnet-4-6',
        temperature: 0.2,
        maxTokens: 32000,
        responseMimeType: 'application/json',
      });
    } else {
      out = await generateText(prompt, {
        model: 'gemini-2.5-flash',
        temperature: 0.3,
        maxTokens: 60000,
        responseMimeType: 'application/json',
      });
    }

    let plan;
    try { plan = JSON.parse(out); } catch (e) {
      throw new Error('AI応答のJSON解析失敗: ' + (out || '').slice(0, 200));
    }

    // 🚨 才数オーバーチェック+自動分割
    const CAPACITY = { '軽ﾊﾞﾝ': 30, 'ハイエース': 80, '2tｽﾘﾑ': 150, '2tｼｮｰﾄ': 180, '2tｼｮｰﾄ平ﾎﾞﾃﾞｨ': 200, '2t': 250, '2t平ﾎﾞﾃﾞｨ': 280, '2ワイド': 280 };
    const splitVehicles = [];
    let splitCount = 0;
    // 利用可能な号車プールから既使用以外を取得
    const usedVehicles = new Set((plan.vehicles || []).map(v => v.vehicle_no));
    const availablePool = fleet.filter(f => !usedVehicles.has(f.vehicle_no)).map(f => f.vehicle_no);
    let poolIdx = 0;

    // 1.3倍までの過積載は実態として許容(人手も250-290才あり)、台数増を避ける
    const HARD_OVERFLOW_RATIO = 1.4;
    for (const v of (plan.vehicles || [])) {
      v.vehicle_type = normalizeVehicleType(v.vehicle_type);
      const cap = CAPACITY[v.vehicle_type] || 150;
      const stops = v.stops || [];
      const totalSai = stops.reduce((a, s) => a + (parseFloat(s.sai) || 0), 0);
      // 容量1.4倍以下なら分割しない (実態許容)
      if (totalSai <= cap * HARD_OVERFLOW_RATIO) {
        splitVehicles.push(v);
        continue;
      }
      // 超過: 順番に詰めて、超えたら次の号車に
      let buf = []; let bufSai = 0;
      const buckets = [];
      for (const s of stops) {
        const ssai = parseFloat(s.sai) || 0;
        if (bufSai + ssai > cap && buf.length > 0) {
          buckets.push(buf);
          buf = []; bufSai = 0;
        }
        buf.push(s); bufSai += ssai;
      }
      if (buf.length) buckets.push(buf);
      // 1個目は元号車、以降は予備プールから
      buckets.forEach((b, i) => {
        const vehNo = i === 0 ? v.vehicle_no : (availablePool[poolIdx++] || (v.vehicle_no + '_split' + i));
        splitVehicles.push({
          vehicle_no: vehNo,
          vehicle_type: v.vehicle_type,
          stops: b.map((s, j) => ({ ...s, sequence: j + 1 })),
        });
        if (i > 0) splitCount++;
      });
    }
    plan.vehicles = splitVehicles;
    if (splitCount > 0) {
      plan.summary = (plan.summary || '') + ` /[サーバ側で${splitCount}台分割: 才数オーバー自動補正]`;
    }

    // 既存当日のAI配車をクリアして再保存
    db.prepare(`DELETE FROM td_dispatches WHERE load_date = ?`).run(ld);
    db.prepare(`DELETE FROM td_dispatch_meta WHERE load_date = ?`).run(ld);
    const insDisp = db.prepare(`INSERT INTO td_dispatches
      (load_date, vehicle_no, sequence, site_name, address, eta, time_spec, qty, sai, ai_reason, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
    const insMeta = db.prepare(`INSERT OR IGNORE INTO td_dispatch_meta
      (load_date, vehicle_no, vehicle_type, driver_token, status) VALUES (?, ?, ?, ?, 'draft')`);
    const tx = db.transaction(() => {
      for (const v of (plan.vehicles || [])) {
        const veh = String(v.vehicle_no || '').trim();
        if (!veh) continue;
        // 住所を sites リストから補完
        for (const stop of (v.stops || [])) {
          const site = String(stop.site_name || '').trim();
          const sm = sites.find(s => s.site_name === site);
          insDisp.run(
            ld, veh,
            parseInt(stop.sequence) || null,
            site,
            sm ? (sm.address || '') : '',
            String(stop.eta || ''),
            stop.time_spec === 'hard' ? 'hard' : (stop.time_spec === 'soft' ? 'soft' : null),
            num(stop.qty) || (sm ? sm.qty : 0),
            num(stop.sai) || (sm ? sm.sai : 0),
            String(stop.reason || '').slice(0, 200),
          );
        }
        insMeta.run(ld, veh, String(v.vehicle_type || '').slice(0, 30), gen8());
      }
    });
    tx();
    db.prepare(`UPDATE td_dispatch_jobs SET status = 'success', finished_at = datetime('now'), response_raw = ? WHERE id = ?`)
      .run(out.slice(0, 8000), jobId);
    res.json({ success: true, job_id: jobId, summary: plan.summary || '', vehicle_count: (plan.vehicles || []).length, provider: requestProvider });
  } catch (e) {
    db.prepare(`UPDATE td_dispatch_jobs SET status = 'failed', finished_at = datetime('now'), error_msg = ? WHERE id = ?`)
      .run(e.message.slice(0, 500), jobId);
    console.error('[takara generate]', e);
    res.status(500).json({ success: false, msg: 'AI配車生成失敗: ' + e.message });
  }
});

// 配車プラン取得 (号車別グループ)
router.get('/plan/:load_date', authUser, (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const ld = req.params.load_date;
  const stops = getDb().prepare(`SELECT * FROM td_dispatches WHERE load_date = ? ORDER BY vehicle_no, sequence`).all(ld);
  const meta = getDb().prepare(`SELECT * FROM td_dispatch_meta WHERE load_date = ? ORDER BY vehicle_no`).all(ld);
  // 号車別グループ
  const byVeh = new Map();
  for (const s of stops) {
    if (!byVeh.has(s.vehicle_no)) byVeh.set(s.vehicle_no, { vehicle_no: s.vehicle_no, stops: [], total_sai: 0, total_qty: 0 });
    const g = byVeh.get(s.vehicle_no);
    g.stops.push(s); g.total_sai += s.sai || 0; g.total_qty += s.qty || 0;
  }
  const vehicles = [...byVeh.values()].map(g => {
    const m = meta.find(x => x.vehicle_no === g.vehicle_no) || {};
    const cls = classifyVehicle(g.vehicle_no);
    return { ...g, ...m, company: cls.company, delivery_day: cls.delivery_day, company_color: COMPANY_COLORS[cls.company] };
  });
  // 業者別+配送日種別 サマリー
  const summary = {};
  for (const v of vehicles) {
    if (!summary[v.company]) summary[v.company] = { count: 0, stops: 0, total_sai: 0 };
    summary[v.company].count++;
    summary[v.company].stops += v.stops.length;
    summary[v.company].total_sai += v.total_sai || 0;
  }
  // 配送日別 (平日/土曜)
  const byDelivery = { '平日': { count: 0, sai: 0 }, '土曜': { count: 0, sai: 0 } };
  for (const v of vehicles) {
    if (v.delivery_day && byDelivery[v.delivery_day]) {
      byDelivery[v.delivery_day].count++;
      byDelivery[v.delivery_day].sai += v.total_sai || 0;
    }
  }
  res.json({ success: true, load_date: ld, vehicles, summary, by_delivery: byDelivery, company_colors: COMPANY_COLORS });
});

// 施工引取号車のWMS品目一覧 (配車対象外だがピッキング対象)
router.get('/pickup/:load_date', authUser, (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const ld = req.params.load_date;
  const rows = getDb().prepare(`
    SELECT original_vehicle_no AS vehicle_no, site_name, item_cd, item_name, qty, sai
    FROM td_orders
    WHERE load_date = ?
      AND ((CAST(original_vehicle_no AS INTEGER) BETWEEN 950 AND 959)
        OR (CAST(original_vehicle_no AS INTEGER) BETWEEN 971 AND 979))
    ORDER BY original_vehicle_no, sai DESC
  `).all(ld);
  // 号車別グループ化
  const byVeh = new Map();
  for (const r of rows) {
    if (!byVeh.has(r.vehicle_no)) byVeh.set(r.vehicle_no, { vehicle_no: r.vehicle_no, items: [], total_sai: 0, sites: new Set() });
    const g = byVeh.get(r.vehicle_no);
    g.items.push(r);
    g.total_sai += r.sai || 0;
    if (r.site_name) g.sites.add(r.site_name);
  }
  const vehicles = [...byVeh.values()].map(g => ({ ...g, sites: [...g.sites] }));
  res.json({ success: true, load_date: ld, vehicles, total_items: rows.length });
});

// ストップを別号車/時間に移動 (ガントチャート D&D 用)
router.patch('/dispatch/:id', authUser, express.json(), (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const id = parseInt(req.params.id);
  const { vehicle_no, sequence, eta, notes } = req.body || {};
  const db = getDb();
  const cur = db.prepare(`SELECT * FROM td_dispatches WHERE id = ?`).get(id);
  if (!cur) return res.status(404).json({ success: false, msg: 'ストップが見つかりません' });
  const updates = [];
  const params = [];
  if (vehicle_no !== undefined) { updates.push('vehicle_no = ?'); params.push(String(vehicle_no).trim()); }
  if (sequence !== undefined) { updates.push('sequence = ?'); params.push(parseInt(sequence) || null); }
  if (eta !== undefined) { updates.push('eta = ?'); params.push(String(eta).trim()); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push(String(notes).slice(0, 200)); }
  updates.push("updated_at = datetime('now')");
  if (updates.length === 1) return res.json({ success: true });  // updated_at のみ
  params.push(id);
  db.prepare(`UPDATE td_dispatches SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  // 別号車に移動した場合、移動先のmetaが無ければ自動作成
  if (vehicle_no !== undefined && vehicle_no !== cur.vehicle_no) {
    const m = db.prepare(`SELECT 1 FROM td_dispatch_meta WHERE load_date = ? AND vehicle_no = ?`).get(cur.load_date, vehicle_no);
    if (!m) {
      db.prepare(`INSERT INTO td_dispatch_meta (load_date, vehicle_no, vehicle_type, driver_token, status) VALUES (?, ?, '', ?, 'draft')`)
        .run(cur.load_date, vehicle_no, gen8());
    }
  }
  res.json({ success: true, dispatch: { ...cur, vehicle_no: vehicle_no ?? cur.vehicle_no, sequence: sequence ?? cur.sequence, eta: eta ?? cur.eta } });
});

// 新規ストップ追加 (自社他社貨物用)
router.post('/dispatch/:load_date', authUser, express.json(), (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const ld = req.params.load_date;
  const b = req.body || {};
  const veh = String(b.vehicle_no || '').trim();
  if (!veh) return res.status(400).json({ success: false, msg: '号車必須' });
  const ins = getDb().prepare(`INSERT INTO td_dispatches
    (load_date, vehicle_no, sequence, site_name, address, eta, time_spec, qty, sai, notes, ai_reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '自社追加(他社貨物)', 'pending')`).run(
      ld, veh, parseInt(b.sequence) || null, String(b.site_name || ''), String(b.address || ''),
      String(b.eta || ''), b.time_spec || null,
      parseFloat(b.qty) || 0, parseFloat(b.sai) || 0,
      String(b.notes || ''),
    );
  res.json({ success: true, id: ins.lastInsertRowid });
});

// ストップ削除
router.delete('/dispatch/:id', authUser, (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  getDb().prepare(`DELETE FROM td_dispatches WHERE id = ?`).run(parseInt(req.params.id));
  res.json({ success: true });
});

// 確定 (status=confirmed)
router.post('/confirm/:load_date', authUser, express.json(), (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const ld = req.params.load_date;
  getDb().prepare(`UPDATE td_dispatch_meta SET status = 'confirmed', confirmed_at = datetime('now') WHERE load_date = ? AND status = 'draft'`).run(ld);
  res.json({ success: true });
});

// 号車情報更新 (車種・ドライバー名・電話)
router.patch('/meta/:load_date/:vehicle_no', authUser, express.json(), (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const { vehicle_type, driver_name, driver_phone } = req.body || {};
  const ld = req.params.load_date; const veh = req.params.vehicle_no;
  // upsert
  const exists = getDb().prepare(`SELECT 1 FROM td_dispatch_meta WHERE load_date = ? AND vehicle_no = ?`).get(ld, veh);
  if (!exists) {
    getDb().prepare(`INSERT INTO td_dispatch_meta (load_date, vehicle_no, vehicle_type, driver_name, driver_phone, driver_token, status) VALUES (?, ?, ?, ?, ?, ?, 'draft')`)
      .run(ld, veh, nz(vehicle_type), nz(driver_name), nz(driver_phone), gen8());
  } else {
    const updates = []; const params = [];
    if (vehicle_type !== undefined) { updates.push('vehicle_type = ?'); params.push(nz(vehicle_type)); }
    if (driver_name !== undefined) { updates.push('driver_name = ?'); params.push(nz(driver_name)); }
    if (driver_phone !== undefined) { updates.push('driver_phone = ?'); params.push(nz(driver_phone)); }
    if (updates.length) {
      params.push(ld, veh);
      getDb().prepare(`UPDATE td_dispatch_meta SET ${updates.join(', ')} WHERE load_date = ? AND vehicle_no = ?`).run(...params);
    }
  }
  res.json({ success: true });
});

// ============================================================
// ドライバー側 (QRトークン認証)
// ============================================================
router.get('/driver/:token', (req, res) => {
  const token = req.params.token;
  const db = getDb();
  const meta = db.prepare(`SELECT * FROM td_dispatch_meta WHERE driver_token = ? ORDER BY load_date DESC LIMIT 1`).get(token);
  if (!meta) return res.status(404).json({ success: false, msg: '配車が見つかりません' });
  const stops = db.prepare(`SELECT * FROM td_dispatches WHERE load_date = ? AND vehicle_no = ? ORDER BY sequence`).all(meta.load_date, meta.vehicle_no);
  res.json({ success: true, meta, stops });
});

// ドライバー進捗更新 (status: enroute/arrived/done)
router.post('/driver/:token/progress', express.json(), (req, res) => {
  const token = req.params.token;
  const { dispatch_id, status } = req.body || {};
  if (!['enroute', 'arrived', 'done'].includes(status)) return res.status(400).json({ success: false, msg: 'status不正' });
  const db = getDb();
  const meta = db.prepare(`SELECT * FROM td_dispatch_meta WHERE driver_token = ?`).get(token);
  if (!meta) return res.status(404).json({ success: false, msg: 'トークン不正' });
  const d = db.prepare(`SELECT id FROM td_dispatches WHERE id = ? AND load_date = ? AND vehicle_no = ?`).get(parseInt(dispatch_id), meta.load_date, meta.vehicle_no);
  if (!d) return res.status(404).json({ success: false, msg: 'ストップ不正' });
  db.prepare(`UPDATE td_dispatches SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, d.id);
  // メタの started_at/completed_at 自動更新
  if (status === 'enroute' && !meta.started_at) {
    db.prepare(`UPDATE td_dispatch_meta SET started_at = datetime('now'), status = 'in_progress' WHERE driver_token = ?`).run(token);
  }
  if (status === 'done') {
    const remaining = db.prepare(`SELECT COUNT(*) AS c FROM td_dispatches WHERE load_date = ? AND vehicle_no = ? AND status != 'done'`).get(meta.load_date, meta.vehicle_no);
    if (remaining.c === 0) {
      db.prepare(`UPDATE td_dispatch_meta SET completed_at = datetime('now'), status = 'completed' WHERE driver_token = ?`).run(token);
    }
  }
  res.json({ success: true });
});

// ============================================================
// 荷主側 (荷主トークン認証)
// ============================================================
router.get('/shipper/:token/:load_date', (req, res) => {
  const token = req.params.token;
  const ld = req.params.load_date;
  const db = getDb();
  const sh = db.prepare(`SELECT * FROM td_shipper_tokens WHERE token = ?`).get(token);
  if (!sh) return res.status(404).json({ success: false, msg: 'トークン不正' });
  db.prepare(`UPDATE td_shipper_tokens SET last_seen_at = datetime('now') WHERE token = ?`).run(token);
  const stops = db.prepare(`SELECT * FROM td_dispatches WHERE load_date = ? ORDER BY vehicle_no, sequence`).all(ld);
  const meta = db.prepare(`SELECT * FROM td_dispatch_meta WHERE load_date = ?`).all(ld);
  // 集計
  const byVeh = new Map();
  for (const s of stops) {
    if (!byVeh.has(s.vehicle_no)) byVeh.set(s.vehicle_no, { vehicle_no: s.vehicle_no, stops: [] });
    byVeh.get(s.vehicle_no).stops.push(s);
  }
  const vehicles = [...byVeh.values()].map(g => {
    const m = meta.find(x => x.vehicle_no === g.vehicle_no) || {};
    const total = g.stops.length;
    const done = g.stops.filter(s => s.status === 'done').length;
    const arrived = g.stops.filter(s => s.status === 'arrived').length;
    const enroute = g.stops.filter(s => s.status === 'enroute').length;
    return {
      vehicle_no: g.vehicle_no,
      driver_name: m.driver_name || '',
      vehicle_type: m.vehicle_type || '',
      status: m.status || 'draft',
      total, done, arrived, enroute,
      progress_pct: total ? Math.round(done / total * 100) : 0,
      stops: g.stops.map(s => ({ sequence: s.sequence, site_name: s.site_name, eta: s.eta, status: s.status })),
    };
  });
  res.json({ success: true, shipper: sh.shipper_name, load_date: ld, vehicles });
});

// 荷主トークン一覧 (admin用)
router.get('/shipper-tokens', authUser, (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const rows = getDb().prepare(`SELECT * FROM td_shipper_tokens ORDER BY created_at DESC`).all();
  res.json({ success: true, tokens: rows });
});

module.exports = router;
