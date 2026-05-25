'use strict';
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { db, q } = require('./db');

const PORT = Number(process.env.PORT || 3006);
const ADMIN_PASSWORD = process.env.BCSCAN_ADMIN_PASSWORD || 'change-me';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 60 * 1000;
const DATA_DIR = process.env.BCSCAN_DATA_DIR || path.join(__dirname, 'data');
const DAMAGE_DIR = path.join(DATA_DIR, 'damages');
const DAMAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
fs.mkdirSync(DAMAGE_DIR, { recursive: true });

// Multer: in-memory storage (we write files ourselves after knowing report id)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 3 }
});

const app = express();
app.use(express.json({ limit: '64kb' }));

// ---------- Auth (DB永続化: 再起動を跨いで有効) ----------
const tokens = new Map();
// 起動時にDBから未失効トークンをロード
try {
  const now = Date.now();
  const rows = db.prepare('SELECT token, expires_at FROM admin_tokens WHERE expires_at > ?').all(now);
  rows.forEach(r => tokens.set(r.token, r.expires_at));
  db.prepare('DELETE FROM admin_tokens WHERE expires_at <= ?').run(now);
  if (rows.length) console.log('[bcscan] restored ' + rows.length + ' admin tokens from DB');
} catch (e) { console.warn('[bcscan] token restore failed:', e.message); }

function newToken() {
  const t = crypto.randomBytes(24).toString('hex');
  const exp = Date.now() + TOKEN_TTL_MS;
  tokens.set(t, exp);
  try { db.prepare('INSERT INTO admin_tokens (token, expires_at, created_at) VALUES (?, ?, ?)').run(t, exp, Date.now()); } catch(_) {}
  return t;
}
function validToken(t) {
  if (!t) return false;
  const exp = tokens.get(t);
  if (!exp) return false;
  if (exp < Date.now()) {
    tokens.delete(t);
    try { db.prepare('DELETE FROM admin_tokens WHERE token = ?').run(t); } catch(_) {}
    return false;
  }
  return true;
}
// 1時間ごとに失効トークン掃除
setInterval(() => {
  try { db.prepare('DELETE FROM admin_tokens WHERE expires_at <= ?').run(Date.now()); } catch(_) {}
}, 3600 * 1000);
function adminOnly(req, res, next) {
  // 1. Bearerトークン (Authorization header)
  const h = req.headers.authorization || '';
  let t = h.startsWith('Bearer ') ? h.slice(7) : null;
  // 2. Cookie (bcscan_tok=...) = 主経路
  if (!t || !validToken(t)) {
    const c = req.headers.cookie || '';
    const m = c.match(/(?:^|;\s*)bcscan_tok=([^;]+)/);
    if (m) t = decodeURIComponent(m[1]);
  }
  if (validToken(t)) return next();
  const tokenPrefix = t ? String(t).substring(0,12) + '...' : '(none)';
  console.warn('[auth-401]', req.method, req.path, 'token=' + tokenPrefix, 'map-size=' + tokens.size);
  return res.status(401).json({ error: 'unauthorized' });
}

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'invalid password' });
  }
  const t = newToken();
  // HttpOnly Cookieで認証 (JSから読めない=XSSでも奪われにくい、ブラウザが自動送信)
  res.setHeader('Set-Cookie', 'bcscan_tok=' + t + '; Path=/bcscan/; Max-Age=' + (TOKEN_TTL_MS / 1000) + '; SameSite=Lax; Secure; HttpOnly');
  res.json({ token: t, ttl: TOKEN_TTL_MS });
});

// ログアウトでCookie削除
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'bcscan_tok=; Path=/bcscan/; Max-Age=0; SameSite=Lax; Secure; HttpOnly');
  res.json({ ok: true });
});

// ---------- Session HTTP API (admin) ----------
app.get('/api/sessions/active', adminOnly, (req, res) => {
  res.json(q.listActive.all());
});
app.get('/api/sessions/recent', adminOnly, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(q.listRecent.all(limit));
});
app.get('/api/sessions/:id', adminOnly, (req, res) => {
  const s = q.getSession.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const scans = q.getSessionScans.all(req.params.id, 500);
  res.json({ session: s, scans });
});
app.get('/api/scans/latest', adminOnly, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  res.json(q.latestScans.all(limit));
});
app.get('/api/stats', adminOnly, (req, res) => {
  const dayStart = new Date(); dayStart.setHours(0,0,0,0);
  res.json(q.statsToday.get(dayStart.getTime(), dayStart.getTime()));
});
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// ---------- Damage reports ----------
// Driver upload (no admin token required; driver identifies via session_id OR driver/vehicle form fields)
app.post('/api/damage', upload.array('photos', 3), (req, res) => {
  const body = req.body || {};
  let driverName = String(body.driver_name || '').slice(0, 40).trim();
  let vehicleNo  = String(body.vehicle_no || '').slice(0, 20).trim();
  const sessionId = String(body.session_id || '').slice(0, 32).trim() || null;
  const memo = String(body.memo || '').slice(0, 1000);
  const scanFormat = String(body.scan_format || '').slice(0, 32) || null;
  const scanValue  = String(body.scan_value  || '').slice(0, 256) || null;

  // If session exists, prefer its driver/vehicle
  if (sessionId) {
    const s = q.getSession.get(sessionId);
    if (s) {
      if (!driverName) driverName = s.driver_name;
      if (!vehicleNo)  vehicleNo  = s.vehicle_no;
    }
  }
  if (!driverName) driverName = '名前未設定';
  if (!vehicleNo)  vehicleNo  = '車番未設定';

  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'no photos' });
  }

  const now = Date.now();
  const info = q.insertDamage.run(
    sessionId, driverName, vehicleNo, memo, scanFormat, scanValue, files.length, now
  );
  const id = info.lastInsertRowid;

  // Write photos
  files.forEach((f, idx) => {
    const fp = path.join(DAMAGE_DIR, `${id}_${idx}.jpg`);
    fs.writeFileSync(fp, f.buffer);
  });

  const report = {
    id, session_id: sessionId, driver_name: driverName, vehicle_no: vehicleNo,
    memo, scan_format: scanFormat, scan_value: scanValue,
    photo_count: files.length, created_at: now
  };
  broadcast({ type: 'damage', report });
  res.json({ ok: true, id });
});

app.get('/api/damage', adminOnly, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(q.listDamages.all(limit));
});

// Photo endpoint accepts token via query ?t= as fallback (since <img> can't set headers)
app.get('/api/damage/:id/photo/:n', (req, res) => {
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
  const t = bearer || req.query.t;
  if (!validToken(t)) return res.status(401).end();
  const id = Number(req.params.id);
  const n  = Number(req.params.n);
  if (!Number.isFinite(id) || !Number.isFinite(n) || n < 0 || n > 2) {
    return res.status(400).end();
  }
  const fp = path.join(DAMAGE_DIR, `${id}_${n}.jpg`);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(fp).pipe(res);
});

app.delete('/api/damage/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const d = q.getDamage.get(id);
  if (!d) return res.status(404).json({ error: 'not found' });
  for (let i = 0; i < (d.photo_count || 0); i++) {
    const fp = path.join(DAMAGE_DIR, `${id}_${i}.jpg`);
    try { fs.unlinkSync(fp); } catch {}
  }
  q.deleteDamage.run(id);
  broadcast({ type: 'damage-delete', id });
  res.json({ ok: true });
});

app.post('/api/admin/clear', adminOnly, (req, res) => {
  const scope = (req.body && req.body.scope) || 'ended';
  const tx = db.transaction(() => {
    if (scope === 'all') {
      q.deleteAllScans.run();
      q.deleteAllSessions.run();
    } else {
      // Default: only ended sessions (keep active ones intact)
      db.prepare(`
        DELETE FROM scans WHERE session_id IN
        (SELECT id FROM sessions WHERE ended_at IS NOT NULL)
      `).run();
      db.prepare(`DELETE FROM sessions WHERE ended_at IS NOT NULL`).run();
    }
  });
  tx();
  broadcast({ type: 'refresh' });
  res.json({ ok: true, scope });
});

// ---------- ピッキング (PhaseB) ----------
const xlsx = require('xlsx');

// xls アップロードでピッキング指示を取り込み
const xlsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// 日付正規化: "20260415" / "3/23" / "2026/3/23" → "YYYYMMDD"
function normalizeDate(raw, queryYear) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // 8桁: そのまま
  if (/^\d{8}$/.test(s)) return s;
  // M/D 形式
  const m = s.match(/^(\d{4})?\/?(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const y = m[1] || queryYear || String(new Date().getFullYear());
    return y + String(m[2]).padStart(2,'0') + String(m[3]).padStart(2,'0');
  }
  // Excel シリアル数値 (まれ)
  const n = Number(s);
  if (!isNaN(n) && n > 40000 && n < 60000) {
    const d = new Date((n - 25569) * 86400000);
    return d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  }
  return null;
}

app.post('/api/picking/upload', adminOnly, xlsUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const fileSize = req.file.buffer.length;
    const filename = req.file.originalname || 'unknown.xlsx';
    // デバッグ用: 直近アップロードされたxls原本を保存
    try {
      const dumpPath = path.join(DATA_DIR, 'last_upload_' + Date.now() + '.xlsx');
      fs.writeFileSync(dumpPath, req.file.buffer);
      console.log('[bcscan] upload saved to', dumpPath, 'size=' + req.file.buffer.length);
    } catch (e) { console.warn('[bcscan] dump failed:', e.message); }
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    let totalInserted = 0;
    let firstDate = null;
    const processedSheets = [];
    const tx = db.transaction(() => {
      const now = Date.now();
      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
        if (rows.length === 0) continue;
        const first = rows[0];
        // 明細シートのみ処理: 品名CD と 数量 が両方必要 (サマリ/簡易シートは除外)
        if (!('品名CD' in first) || !('数量' in first)) continue;
        const loadDate = normalizeDate(first['積込日'], req.query.year || new Date().getFullYear()) || new Date().toISOString().slice(0,10).replace(/-/g, '');
        if (!firstDate) firstDate = loadDate;
        q.deletePickingByDate.run(loadDate);
        let sheetInserted = 0;
        for (const r of rows) {
          if (!r['品名CD'] && !r['品名']) continue;
          const route = String(r['積替元号車'] || r['積替'] || '').trim();
          const isDealer = route === '' ? 1 : 0;
          q.insertPicking.run(
            loadDate,
            String(r['倉庫CD'] || ''),
            String(r['出荷形態'] || ''),
            String(r['実号車'] || ''),
            String(r['手配NO'] || ''),
            String(r['現場名'] || ''),
            String(r['品名CD'] || ''),
            String(r['品名'] || ''),
            Number(r['数量'] || 0),
            Number(r['才数'] || 0),
            String(r['出庫倉庫'] || ''),
            route,
            isDealer,
            now
          );
          sheetInserted++;
          totalInserted++;
        }
        processedSheets.push({ sheet: sheetName, rows: sheetInserted });
        // 1明細シート処理したら以降のシートは重複なのでスキップ (xlsが複数コピーを持つ場合の保護)
        break;
      }
    });
    tx();
    try {
      q.insertImportHistory.run(
        'manifest', filename, fileSize, fileHash, firstDate || '',
        JSON.stringify({ count: totalInserted, sheets: processedSheets.length }),
        JSON.stringify({ processed_sheets: processedSheets }),
        req.tokenInfo && req.tokenInfo.user || '', Date.now()
      );
    } catch (e) { console.warn('[bcscan] import_history (manifest) failed:', e.message); }
    res.json({ ok: true, count: totalInserted, load_date: firstDate || '', sheets: processedSheets, filename });
  } catch (e) {
    console.error('picking/upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 着車順→A/B/C...ラベル付与 (arrived_at ASC)
function buildArrivalLabels(arrivalRows) {
  // arrivalRows は arrived_at ASC で並んでいる
  const labels = {};
  arrivalRows.forEach((r, i) => {
    labels[r.route] = {
      order: i + 1,
      label: i < 26 ? String.fromCharCode(65 + i) : ('A' + (i - 25)),
      arrived_at: r.arrived_at
    };
  });
  return labels;
}

// ===== 配車編集 (D&Dによる号車間移動+号車メタ管理) =====
// 配車プラン取得: 号車別に現場タイルをグループ化、車両メタ付与
app.get('/api/picking/dispatch-plan', adminOnly, (req, res) => {
  const date = String(req.query.date || '').replace(/[^\d]/g, '');
  if (!date) return res.status(400).json({ error: 'date required' });
  const sites = db.prepare(`
    SELECT vehicle_no, destination, source_route, is_dealer,
           eta_time, time_spec, delivery_order, transfer_base, company,
           MAX(address) AS address,
           COUNT(*) as items, SUM(quantity) as qty, SUM(size_count) as size,
           SUM(picked_count) as picked
    FROM picking_orders
    WHERE load_date=?
    GROUP BY vehicle_no, destination, source_route
    ORDER BY vehicle_no, source_route, destination
  `).all(date);
  const metas = db.prepare(`SELECT * FROM vehicle_meta WHERE load_date=?`).all(date);
  const metaMap = Object.fromEntries(metas.map(m => [m.vehicle_no, m]));

  // 変更履歴から「現場ごとに号車がどう動いたか」のチェーンを再構築
  // 原号車(最古のbefore)と現号車(最新のafter)を比較し、最終的に原号車に戻っていれば moved=false
  const changeRows = db.prepare(`
    SELECT id, target_id, vehicle_no, destination, field_changes, changed_at, changed_by
    FROM picking_changes
    WHERE load_date=? AND change_type='update' AND field_changes LIKE '%vehicle_no%'
    ORDER BY changed_at ASC
  `).all(date);
  // destination → [{ id, before, after, changed_at, changed_by }]
  const chainByDest = {};
  for (const r of changeRows) {
    try {
      const fc = JSON.parse(r.field_changes || '{}');
      // _undone (過去の取消元) / _undo_of (取消本体) は互いに打ち消し済 → 無視
      if (fc && (fc._undone || fc._undo_of)) continue;
      if (fc && fc.vehicle_no) {
        const dest = r.destination || '';
        if (!chainByDest[dest]) chainByDest[dest] = [];
        chainByDest[dest].push({
          id: r.id,
          before: fc.vehicle_no.before,
          after: fc.vehicle_no.after,
          changed_at: r.changed_at,
          changed_by: r.changed_by,
        });
      }
    } catch(_) {}
  }
  // (current_vehicle | destination) → { from_vehicle: 原号車, change_id, changed_at }
  const movedByKey = {};
  for (const dest of Object.keys(chainByDest)) {
    const chain = chainByDest[dest];
    const origin = chain[0].before;            // 最古の before = 原号車
    const last = chain[chain.length - 1];
    if (last.after === origin) continue;       // 最終的に原号車へ戻った → moved扱いしない
    const key = last.after + '|' + dest;
    movedByKey[key] = {
      from_vehicle: origin,
      change_id: last.id,
      changed_at: last.changed_at,
      changed_by: last.changed_by,
    };
  }

  const vehicles = {};
  sites.forEach(s => {
    if (!vehicles[s.vehicle_no]) {
      vehicles[s.vehicle_no] = {
        vehicle_no: s.vehicle_no,
        company: s.company,
        meta: metaMap[s.vehicle_no] || null,
        sites: []
      };
    }
    const key = s.vehicle_no + '|' + (s.destination || '');
    const mv = movedByKey[key];
    if (mv) {
      s.moved = true;
      s.moved_from = mv.from_vehicle;
      s.change_id = mv.change_id;
      s.moved_at = mv.changed_at;
    }
    vehicles[s.vehicle_no].sites.push(s);
  });
  // 便一覧も返す (ドロップダウンで便変更できるように)
  const routes = db.prepare(`SELECT DISTINCT source_route FROM picking_orders WHERE load_date=? AND source_route IS NOT NULL ORDER BY source_route`).all(date);
  res.json({
    date,
    vehicles: Object.values(vehicles).sort((a,b) => a.vehicle_no.localeCompare(b.vehicle_no)),
    routes: routes.map(r => r.source_route),
  });
});

// 現場を別号車/別便に再割当
app.post('/api/picking/reassign', adminOnly, (req, res) => {
  const { load_date, from_vehicle, destination, source_route, to_vehicle, new_source_route, changed_by } = req.body || {};
  // destinationは空欄(販売店)も有効。未指定は undefined または null のみ弾く
  if (!load_date || !from_vehicle || !to_vehicle) return res.status(400).json({ error: 'missing: load_date/from_vehicle/to_vehicle' });
  if (destination === undefined || destination === null) return res.status(400).json({ error: 'missing: destination' });
  const diffs = {};
  if (from_vehicle !== to_vehicle) diffs.vehicle_no = { before: from_vehicle, after: to_vehicle };
  let sql, args;
  if (new_source_route !== undefined && new_source_route !== source_route) {
    diffs.source_route = { before: source_route || '', after: new_source_route };
    diffs.is_dealer = { before: (source_route === '' || source_route === null) ? 1 : 0, after: new_source_route === '' ? 1 : 0 };
    sql = `UPDATE picking_orders SET vehicle_no=?, source_route=?, is_dealer=? WHERE load_date=? AND vehicle_no=? AND destination=? AND COALESCE(source_route,'')=?`;
    args = [to_vehicle, new_source_route, new_source_route === '' ? 1 : 0, load_date, from_vehicle, destination, source_route || ''];
  } else {
    sql = `UPDATE picking_orders SET vehicle_no=? WHERE load_date=? AND vehicle_no=? AND destination=? AND COALESCE(source_route,'')=?`;
    args = [to_vehicle, load_date, from_vehicle, destination, source_route || ''];
  }
  const info = db.prepare(sql).run(...args);
  if (info.changes > 0 && Object.keys(diffs).length > 0) {
    logPickingChange({
      load_date, change_type: 'update', vehicle_no: to_vehicle, destination,
      field_changes: diffs, changed_by: changed_by || ''
    });
  }
  res.json({ ok: true, updated: info.changes });
});

// 配車変更を取り消す (指定change_id を反転、または load_date の最新変更を1件取り消し)
app.post('/api/picking/undo-reassign', adminOnly, (req, res) => {
  const { change_id, load_date } = req.body || {};
  let change;
  if (change_id) {
    change = db.prepare('SELECT * FROM picking_changes WHERE id = ?').get(change_id);
  } else if (load_date) {
    // その日付の最新 vehicle_no 変更 (undo操作自体 と 既にundone済み を除く)
    change = db.prepare(`
      SELECT * FROM picking_changes
      WHERE load_date=? AND change_type='update' AND field_changes LIKE '%vehicle_no%'
        AND field_changes NOT LIKE '%_undo_of%'
        AND field_changes NOT LIKE '%_undone%'
      ORDER BY changed_at DESC LIMIT 1
    `).get(load_date);
  }
  if (!change) return res.status(404).json({ error: 'change not found' });
  try {
    const fc = JSON.parse(change.field_changes || '{}');
    if (!fc.vehicle_no) return res.status(400).json({ error: 'not a vehicle move' });
    const currentVehicle = fc.vehicle_no.after;
    const originalVehicle = fc.vehicle_no.before;
    if (!originalVehicle || !currentVehicle) return res.status(400).json({ error: 'invalid field_changes' });
    // 現在 currentVehicle にある該当現場を originalVehicle に戻す
    const info = db.prepare(`
      UPDATE picking_orders SET vehicle_no = ?
      WHERE load_date = ? AND vehicle_no = ? AND destination = ?
    `).run(originalVehicle, change.load_date, currentVehicle, change.destination || '');
    if (info.changes === 0) {
      return res.json({ ok: false, error: 'no rows to revert (already moved elsewhere?)' });
    }
    // ログに反映 + 元の change は以降 "undone" 扱いにするためマーク
    logPickingChange({
      load_date: change.load_date, change_type: 'update',
      vehicle_no: originalVehicle, destination: change.destination,
      field_changes: { vehicle_no: { before: currentVehicle, after: originalVehicle }, _undo_of: change.id },
      changed_by: 'undo'
    });
    // 元changeにマーカーを付けて undo-last で再度選ばれないように
    try {
      const fcNew = Object.assign({}, fc, { _undone: true });
      db.prepare('UPDATE picking_changes SET field_changes = ? WHERE id = ?').run(JSON.stringify(fcNew), change.id);
    } catch(_) {}
    res.json({ ok: true, reverted: { from: currentVehicle, to: originalVehicle, destination: change.destination } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 号車メタ (車種・ドライバー・特記) 保存
app.post('/api/picking/vehicle-meta', adminOnly, (req, res) => {
  const { load_date, vehicle_no, vehicle_type, driver_name, notes } = req.body || {};
  if (!load_date || !vehicle_no) return res.status(400).json({ error: 'missing' });
  db.prepare(`
    INSERT INTO vehicle_meta (load_date, vehicle_no, vehicle_type, driver_name, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(load_date, vehicle_no) DO UPDATE SET
      vehicle_type = excluded.vehicle_type,
      driver_name = excluded.driver_name,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(String(load_date), String(vehicle_no), vehicle_type || null, driver_name || null, notes || null, Date.now());
  res.json({ ok: true });
});

// 号車追加 (新規号車を枠だけ作る。現場はドラッグで移動)
app.post('/api/picking/add-vehicle', adminOnly, (req, res) => {
  const { load_date, vehicle_no, company, vehicle_type, driver_name, notes } = req.body || {};
  if (!load_date || !vehicle_no) return res.status(400).json({ error: 'missing' });
  db.prepare(`
    INSERT INTO vehicle_meta (load_date, vehicle_no, vehicle_type, driver_name, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(load_date, vehicle_no) DO NOTHING
  `).run(String(load_date), String(vehicle_no), vehicle_type || null, driver_name || null, notes || null, Date.now());
  res.json({ ok: true });
});

// ===== 配車確定後の手動編集 =====
// 変更履歴を記録するヘルパー
function logPickingChange({ load_date, change_type, target_id, vehicle_no, destination, product_cd, product_name, field_changes, changed_by }) {
  db.prepare(`
    INSERT INTO picking_changes
      (load_date, change_type, target_id, vehicle_no, destination, product_cd, product_name, field_changes, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(load_date || '', change_type, target_id || null, vehicle_no || '', destination || '', product_cd || '', product_name || '', field_changes ? JSON.stringify(field_changes) : null, changed_by || '', Date.now());
}

// 単一行の更新 (部分更新)
app.patch('/api/picking/order/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const row = db.prepare(`SELECT * FROM picking_orders WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const allowed = ['vehicle_no', 'destination', 'product_cd', 'product_name', 'quantity', 'size_count',
                   'source_route', 'is_dealer', 'delivery_order', 'eta_time', 'time_spec', 'transfer_base'];
  const diffs = {};
  const sets = [], vals = [];
  for (const f of allowed) {
    if (f in req.body) {
      const nv = req.body[f];
      if (row[f] != nv) {
        diffs[f] = { before: row[f], after: nv };
        sets.push(f + ' = ?');
        vals.push(nv);
      }
    }
  }
  if (sets.length === 0) return res.json({ ok: true, changes: 0 });
  vals.push(id);
  db.prepare(`UPDATE picking_orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  logPickingChange({
    load_date: row.load_date, change_type: 'update', target_id: id,
    vehicle_no: req.body.vehicle_no || row.vehicle_no,
    destination: req.body.destination || row.destination,
    product_cd: row.product_cd, product_name: row.product_name,
    field_changes: diffs, changed_by: req.body.changed_by || ''
  });
  res.json({ ok: true, changes: sets.length, diffs });
});

// 新規行追加
app.post('/api/picking/order', adminOnly, (req, res) => {
  const b = req.body || {};
  const required = ['load_date', 'vehicle_no', 'product_cd', 'product_name', 'quantity'];
  for (const r of required) if (!b[r] && b[r] !== 0) return res.status(400).json({ error: 'missing: ' + r });
  const info = db.prepare(`
    INSERT INTO picking_orders
      (load_date, warehouse_cd, ship_form, vehicle_no, order_no, destination,
       product_cd, product_name, quantity, size_count, source_warehouse,
       source_route, is_dealer, delivery_order, eta_time, time_spec, transfer_base, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(b.load_date), String(b.warehouse_cd || ''), String(b.ship_form || ''),
    String(b.vehicle_no), String(b.order_no || ''), String(b.destination || ''),
    String(b.product_cd), String(b.product_name), Number(b.quantity), Number(b.size_count || 0),
    String(b.source_warehouse || ''), String(b.source_route || ''),
    (b.source_route || '').trim() === '' ? 1 : 0,
    b.delivery_order || null, b.eta_time || null, b.time_spec || null, b.transfer_base || null,
    Date.now()
  );
  const newId = info.lastInsertRowid;
  logPickingChange({
    load_date: b.load_date, change_type: 'add', target_id: newId,
    vehicle_no: b.vehicle_no, destination: b.destination, product_cd: b.product_cd, product_name: b.product_name,
    field_changes: { initial: { quantity: b.quantity, size_count: b.size_count } },
    changed_by: b.changed_by || ''
  });
  res.json({ ok: true, id: newId });
});

// 削除
app.delete('/api/picking/order/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM picking_orders WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare(`DELETE FROM picking_orders WHERE id = ?`).run(id);
  logPickingChange({
    load_date: row.load_date, change_type: 'delete', target_id: id,
    vehicle_no: row.vehicle_no, destination: row.destination,
    product_cd: row.product_cd, product_name: row.product_name,
    field_changes: { deleted: { quantity: row.quantity, size_count: row.size_count } },
    changed_by: (req.body && req.body.changed_by) || ''
  });
  res.json({ ok: true });
});

// 変更履歴
app.get('/api/picking/changes', adminOnly, (req, res) => {
  const date = String(req.query.date || '').replace(/[^\d]/g, '');
  let rows;
  if (date) {
    rows = db.prepare(`SELECT * FROM picking_changes WHERE load_date=? ORDER BY changed_at DESC LIMIT 200`).all(date);
  } else {
    rows = db.prepare(`SELECT * FROM picking_changes ORDER BY changed_at DESC LIMIT 200`).all();
  }
  // JSON展開
  const out = rows.map(r => Object.assign({}, r, { field_changes: r.field_changes ? JSON.parse(r.field_changes) : null }));
  res.json({ changes: out });
});

// 編集フラグ用: ある現場/号車/明細が変更履歴に存在するかを返す軽量エンドポイント
app.get('/api/picking/edited-ids', (req, res) => {
  const date = String(req.query.date || '').replace(/[^\d]/g, '');
  if (!date) return res.status(400).json({ error: 'date required' });
  const rows = db.prepare(`SELECT DISTINCT target_id, vehicle_no, destination FROM picking_changes WHERE load_date=?`).all(date);
  res.json({ edited_ids: rows.map(r => r.target_id).filter(Boolean), edited_sites: rows.map(r => ({ vehicle: r.vehicle_no, destination: r.destination })) });
});

// 配車確定xls取込 (ETA/配送順/時間指定を既存picking_ordersに付加)
app.post('/api/picking/dispatch/upload', adminOnly, xlsUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const fileSize = req.file.buffer.length;
    const filename = req.file.originalname || 'unknown.xlsx';
    // デバッグ用保存 (健康PJと同じ扱い)
    try {
      const dumpPath = path.join(DATA_DIR, 'last_dispatch_' + Date.now() + '.xlsx');
      fs.writeFileSync(dumpPath, req.file.buffer);
    } catch(_) {}

    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    // 配送日プリスキャン: ファイル内の配送日集合を収集し、ユーザー指定値と突合
    const fileDateCounts = {};
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
      for (const r of rows) {
        const dd = normalizeDate(r['配送日'], req.query.year || new Date().getFullYear());
        if (dd) fileDateCounts[dd] = (fileDateCounts[dd] || 0) + 1;
      }
    }
    const fileDates = Object.keys(fileDateCounts).sort();
    const expected = String(req.body && req.body.expected_delivery_date || '').replace(/[^\d]/g, '');
    if (expected) {
      if (!fileDates.includes(expected)) {
        return res.status(400).json({
          error: 'date_mismatch',
          expected_delivery_date: expected,
          file_delivery_dates: fileDateCounts,
          message: '指定配送日 ' + expected + ' がファイル内に存在しません。ファイル内配送日: ' + fileDates.join(', ')
        });
      }
    }
    let updated = 0, unmatched = 0, firstDate = null;
    const unmatchedSamples = [];
    const matchedSamples = [];
    // 配送日 ±1日 範囲で積込日をマッチ (前日夕積込 / 当日午前積込)
    const stmt = db.prepare(`
      UPDATE picking_orders
      SET delivery_order = ?, eta_time = ?, time_spec = ?, transfer_base = ?, company = ?, address = ?
      WHERE vehicle_no = ?
        AND REPLACE(REPLACE(destination, ' ', ''), '　', '') = ?
        AND load_date IN (?, ?, ?)
    `);
    // 休日跨ぎフォールバック: ±1日で当たらなかった行のみ -3〜+1日まで広げて再試行 (eta未設定行限定で既設ETAは保護)
    const stmtFallback = db.prepare(`
      UPDATE picking_orders
      SET delivery_order = ?, eta_time = ?, time_spec = ?, transfer_base = ?, company = ?, address = ?
      WHERE vehicle_no = ?
        AND REPLACE(REPLACE(destination, ' ', ''), '　', '') = ?
        AND load_date IN (?, ?, ?, ?, ?)
        AND (eta_time IS NULL OR eta_time = '')
    `);
    // 号車→業者 を覚えておき、dispatchにない現場(販売店等)も業者を後埋め
    const vehicleToCompany = {};
    function prevYmd(ymd) {
      const y = +ymd.slice(0,4), m = +ymd.slice(4,6), d = +ymd.slice(6,8);
      const dt = new Date(y, m-1, d); dt.setDate(dt.getDate() - 1);
      return dt.getFullYear() + String(dt.getMonth()+1).padStart(2,'0') + String(dt.getDate()).padStart(2,'0');
    }
    function nextYmd(ymd) {
      const y = +ymd.slice(0,4), m = +ymd.slice(4,6), d = +ymd.slice(6,8);
      const dt = new Date(y, m-1, d); dt.setDate(dt.getDate() + 1);
      return dt.getFullYear() + String(dt.getMonth()+1).padStart(2,'0') + String(dt.getDate()).padStart(2,'0');
    }
    const tx = db.transaction(() => {
      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
        for (const r of rows) {
          const vehicle = String(r['号車'] || '').trim();
          if (!vehicle || vehicle === '号車') continue;
          const destRaw = String(r['納入先名'] || '').trim();
          if (!destRaw) continue;
          const destNorm = destRaw.replace(/[\s　]/g, '');
          const deliveryDate = normalizeDate(r['配送日'], req.query.year || new Date().getFullYear());
          if (!deliveryDate) continue;
          if (expected && deliveryDate !== expected) continue;
          if (!firstDate) firstDate = deliveryDate;
          const order = Number(r['配送順']) || null;
          const eta = String(r['到着予定時間'] || '').trim() || null;
          const timeSpec = String(r['時間指定'] || '').trim() || null;
          const transferBase = String(r['積替基地コード'] || '').trim() || null;
          const company = String(r['業者'] || '').trim() || null;
          const address = String(r['住所'] || '').trim() || null;
          if (company) vehicleToCompany[vehicle] = company;
          const p1 = prevYmd(deliveryDate);
          const p2 = prevYmd(p1);
          const p3 = prevYmd(p2);
          const n1 = nextYmd(deliveryDate);
          let info = stmt.run(order, eta, timeSpec, transferBase, company, address, vehicle, destNorm, p1, deliveryDate, n1);
          if (info.changes === 0) {
            info = stmtFallback.run(order, eta, timeSpec, transferBase, company, address, vehicle, destNorm, p3, p2, p1, deliveryDate, n1);
          }
          if (info.changes > 0) {
            updated += info.changes;
            if (matchedSamples.length < 5000) matchedSamples.push({
              vehicle, dest: destRaw, date: deliveryDate,
              order, eta, time_spec: timeSpec, transfer_base: transferBase, company, address,
              rows: info.changes
            });
          } else {
            unmatched++;
            if (unmatchedSamples.length < 2000) unmatchedSamples.push({
              vehicle, dest: destRaw, date: deliveryDate,
              order, eta, time_spec: timeSpec, transfer_base: transferBase, company, address
            });
          }
        }
      }
    });
    tx();
    // 号車ごと、company未設定のpicking_ordersに業者を補完
    let companyBackfilled = 0;
    const backfill = db.prepare(`UPDATE picking_orders SET company=? WHERE vehicle_no=? AND (company IS NULL OR company='') AND load_date IN (?, ?, ?)`);
    for (const [veh, co] of Object.entries(vehicleToCompany)) {
      if (!firstDate) continue;
      const info = backfill.run(co, veh, prevYmd(firstDate), firstDate, nextYmd(firstDate));
      companyBackfilled += info.changes;
    }
    try {
      q.insertImportHistory.run(
        'dispatch', filename, fileSize, fileHash, firstDate || expected || '',
        JSON.stringify({ updated, unmatched, company_backfilled: companyBackfilled, expected_delivery_date: expected || null, file_delivery_dates: fileDateCounts }),
        JSON.stringify({ matched_samples: matchedSamples, unmatched_samples: unmatchedSamples }),
        req.tokenInfo && req.tokenInfo.user || '', Date.now()
      );
    } catch (e) { console.warn('[bcscan] import_history (dispatch) failed:', e.message); }
    res.json({ ok: true, updated, unmatched, company_backfilled: companyBackfilled, matched_samples: matchedSamples, unmatched_samples: unmatchedSamples, load_date: firstDate || '', filename, expected_delivery_date: expected || null, file_delivery_dates: fileDateCounts });
  } catch (e) {
    console.error('dispatch/upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 取込履歴一覧
app.get('/api/picking/import-history', adminOnly, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const type = req.query.type;
  const rows = type
    ? q.listImportHistoryByType.all(String(type), limit)
    : q.listImportHistory.all(limit);
  res.json({ items: rows.map(r => Object.assign({}, r, { result_summary: safeParse(r.result_summary) })) });
});
function safeParse(s) { try { return s ? JSON.parse(s) : null; } catch(_) { return null; } }
// 取込履歴詳細 (matched/unmatched含む)
app.get('/api/picking/import-history/:id', adminOnly, (req, res) => {
  const row = q.getImportHistory.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(Object.assign({}, row, {
    result_summary: safeParse(row.result_summary),
    result_detail: safeParse(row.result_detail)
  }));
});

// 号車別ダッシュボード
app.get('/api/picking/dashboard', adminOnly, (req, res) => {
  const date = String(req.query.date || '').replace(/[^\d]/g, '');
  if (!date) return res.status(400).json({ error: 'date required' });
  const vehicles = q.vehicleSummary.all(date);
  const arrivedRows = q.arrivalsForDate.all(date);
  const arrived = new Set(arrivedRows.map(a => a.route));
  const arrivalLabels = buildArrivalLabels(arrivedRows);
  const allRoutes = q.routesForDate.all(date).map(r => r.source_route);
  const sessions = q.pickSessionsForDate.all(date);
  const sessionByVehicle = Object.fromEntries(sessions.map(s => [s.vehicle_no, s]));
  const data = vehicles.map(v => {
    const routes = (v.routes || '').split(',').filter(Boolean);
    const needArrival = routes.filter(r => r !== ''); // 空欄は販売店なので便着車不要
    const missing = needArrival.filter(r => !arrived.has(r));
    let status = 'waiting';
    if (missing.length === 0) status = (v.done_lines === v.lines) ? 'done' : 'ready';
    const sess = sessionByVehicle[v.vehicle_no] || null;
    return {
      vehicle_no: v.vehicle_no,
      lines: v.lines,
      sites: v.sites,
      dispatch_matched_sites: v.dispatch_matched_sites || 0,
      total_qty: v.total_qty,
      picked_qty: v.picked_qty,
      done_lines: v.done_lines,
      routes,
      missing_routes: missing,
      has_dealer: !!v.has_dealer,
      status,
      session_started_at: sess ? sess.started_at : null,
      session_ended_at: sess ? sess.ended_at : null,
      session_driver: sess ? sess.driver_name : null,
    };
  });
  res.json({
    date,
    vehicles: data,
    arrived: Array.from(arrived),
    arrival_labels: arrivalLabels,
    all_routes: allRoutes,
    summary: {
      total_vehicles: data.length,
      ready: data.filter(d => d.status === 'ready').length,
      waiting: data.filter(d => d.status === 'waiting').length,
      done: data.filter(d => d.status === 'done').length,
    }
  });
});

// 便着車登録
app.post('/api/picking/arrival', adminOnly, (req, res) => {
  const { date, route, recorded_by } = req.body || {};
  if (!date || !route) return res.status(400).json({ error: 'date and route required' });
  q.insertArrival.run(date, route, Date.now(), recorded_by || '');
  res.json({ ok: true });
});

// 便着車取消
app.delete('/api/picking/arrival', adminOnly, (req, res) => {
  const { date, route } = req.body || {};
  if (!date || !route) return res.status(400).json({ error: 'date and route required' });
  q.deleteArrival.run(date, route);
  res.json({ ok: true });
});

// 号車詳細(現場×便×品目)
app.get('/api/picking/vehicle/:vehicle_no', adminOnly, (req, res) => {
  const date = String(req.query.date || '').replace(/[^\d]/g, '');
  const vehicle = req.params.vehicle_no;
  if (!date) return res.status(400).json({ error: 'date required' });
  const lines = q.vehicleDetail.all(date, vehicle);
  res.json({ date, vehicle_no: vehicle, lines });
});

// ===== ホーム画面用オーバービュー (認証なし・読み取り専用) =====
app.get('/api/picking/overview', (req, res) => {
  const requested = String(req.query.date || new Date().toISOString().slice(0,10).replace(/-/g, '')).replace(/[^\d]/g, '');
  let date = requested;
  let count = db.prepare('SELECT COUNT(*) as c FROM picking_orders WHERE load_date = ?').get(date).c;
  let fallback = false;
  if (count === 0) {
    const latest = db.prepare('SELECT load_date FROM picking_orders ORDER BY load_date DESC LIMIT 1').get();
    if (latest) { date = latest.load_date; fallback = true; }
  }
  if (count === 0 && !fallback) {
    return res.json({ date: requested, requested_date: requested, fallback: false, routes: [], vehicles: [], totals: null });
  }
  const arrivalRows = q.arrivalsForDate.all(date);
  const arrivedSet = new Set(arrivalRows.map(a => a.route));
  const arrivalLabels = buildArrivalLabels(arrivalRows);

  // 便別集計
  const routeRows = db.prepare(`
    SELECT source_route, COUNT(*) as lines, COUNT(DISTINCT vehicle_no) as vehicles_count,
           COUNT(DISTINCT destination) as sites, SUM(quantity) as qty, SUM(size_count) as size,
           SUM(picked_count) as picked,
           MIN(NULLIF(eta_time, '')) as eta_min,
           MAX(NULLIF(eta_time, '')) as eta_max,
           SUM(CASE WHEN time_spec='有' THEN 1 ELSE 0 END) as time_spec_count
    FROM picking_orders WHERE load_date=? GROUP BY source_route ORDER BY source_route
  `).all(date);
  const routes = routeRows.map(r => {
    const label = arrivalLabels[r.source_route];
    const isDealer = r.source_route === '';
    return {
      route: isDealer ? '(販売店)' : r.source_route,
      raw_route: r.source_route || '',
      is_dealer: isDealer,
      arrived: isDealer ? true : arrivedSet.has(r.source_route),
      arrival_label: label ? label.label : null,
      arrival_order: label ? label.order : null,
      arrived_at: label ? label.arrived_at : null,
      lines: r.lines,
      vehicles_count: r.vehicles_count,
      sites: r.sites,
      qty: r.qty,
      size: Math.round((r.size || 0) * 10) / 10,
      picked: r.picked,
      eta_min: r.eta_min || null,
      eta_max: r.eta_max || null,
      time_spec_count: r.time_spec_count || 0,
    };
  });
  // 着車済は着車順、未着車は番号順で並べる
  routes.sort((a,b) => {
    if (a.is_dealer !== b.is_dealer) return a.is_dealer ? 1 : -1;
    if (a.arrived !== b.arrived) return a.arrived ? -1 : 1;
    if (a.arrived && b.arrived) return (a.arrival_order||99) - (b.arrival_order||99);
    return String(a.raw_route).localeCompare(String(b.raw_route));
  });

  // 号車別集計
  const vehicleRows = db.prepare(`
    SELECT vehicle_no,
      COUNT(*) as lines, COUNT(DISTINCT destination) as sites,
      SUM(quantity) as qty, SUM(size_count) as size, SUM(picked_count) as picked,
      GROUP_CONCAT(DISTINCT source_route) as routes_csv,
      (SELECT company FROM picking_orders po2 WHERE po2.vehicle_no = picking_orders.vehicle_no AND po2.load_date=? AND po2.company IS NOT NULL LIMIT 1) as company
    FROM picking_orders WHERE load_date=? GROUP BY vehicle_no ORDER BY vehicle_no
  `).all(date, date);
  const sessions = q.pickSessionsForDate.all(date);
  const sessionMap = Object.fromEntries(sessions.map(s => [s.vehicle_no, s]));
  const vehicles = vehicleRows.map(v => {
    const routesList = (v.routes_csv || '').split(',').filter(x => x !== '');
    const needRoutes = routesList.filter(r => r !== '');
    const missing = needRoutes.filter(r => !arrivedSet.has(r));
    let status = 'waiting';
    const isDone = v.picked >= v.qty && v.qty > 0;
    if (isDone) status = 'done';
    else if (missing.length === 0 || needRoutes.length === 0) status = 'ready';
    const sess = sessionMap[v.vehicle_no];
    return {
      vehicle_no: v.vehicle_no,
      company: v.company || null,
      sites: v.sites, lines: v.lines,
      qty: v.qty, size: Math.round((v.size||0)*10)/10,
      picked: v.picked,
      status,
      routes: routesList,
      routes_with_labels: routesList.map(r => ({
        route: r, label: arrivalLabels[r] ? arrivalLabels[r].label : null, arrived: arrivedSet.has(r)
      })),
      session_started_at: sess ? sess.started_at : null,
      session_ended_at: sess ? sess.ended_at : null,
      session_driver: sess ? sess.driver_name : null,
    };
  });

  // 業者別集計
  const companyRows = db.prepare(`
    SELECT COALESCE(company, '(未設定)') as company, COUNT(DISTINCT vehicle_no) as vehicles_count,
           COUNT(DISTINCT destination) as sites, SUM(quantity) as qty, SUM(picked_count) as picked
    FROM picking_orders WHERE load_date=? GROUP BY COALESCE(company, '(未設定)') ORDER BY vehicles_count DESC
  `).all(date);

  const totals = {
    vehicles: vehicles.length,
    routes: routes.filter(r => !r.is_dealer).length,
    sites: db.prepare("SELECT COUNT(DISTINCT destination) as c FROM picking_orders WHERE load_date=? AND destination != ''").get(date).c,
    lines: vehicles.reduce((s,v) => s + v.lines, 0),
    qty: vehicles.reduce((s,v) => s + (v.qty||0), 0),
    picked: vehicles.reduce((s,v) => s + (v.picked||0), 0),
    size: Math.round(vehicles.reduce((s,v) => s + (v.size||0), 0) * 10)/10,
    done_vehicles: vehicles.filter(v => v.status === 'done').length,
    ready_vehicles: vehicles.filter(v => v.status === 'ready').length,
    waiting_vehicles: vehicles.filter(v => v.status === 'waiting').length,
    arrived_routes: routes.filter(r => r.arrived && !r.is_dealer).length,
  };

  res.json({ date, requested_date: requested, fallback, routes, vehicles, totals, companies: companyRows });
});

// ===== ドライバー用 (認証なし、号車番号で識別) =====
// 当日の号車リスト (データなければ最新登録日で自動フォールバック)
app.get('/api/picking/vehicles', (req, res) => {
  const requested = String(req.query.date || new Date().toISOString().slice(0,10).replace(/-/g, '')).replace(/[^\d]/g, '');
  let date = requested;
  let count = db.prepare('SELECT COUNT(*) as c FROM picking_orders WHERE load_date = ?').get(date).c;
  let fallback = false;
  if (count === 0) {
    // 最新の登録日を探す
    const latest = db.prepare('SELECT load_date FROM picking_orders ORDER BY load_date DESC LIMIT 1').get();
    if (latest) { date = latest.load_date; fallback = true; }
  }
  const rows = db.prepare(`
    SELECT vehicle_no, COUNT(*) as lines, COUNT(DISTINCT destination) as sites,
           SUM(quantity) as qty, SUM(picked_count) as picked
    FROM picking_orders WHERE load_date = ?
    GROUP BY vehicle_no
    ORDER BY vehicle_no
  `).all(date);
  res.json({ requested_date: requested, date, vehicles: rows, fallback });
});

// 号車別ピッキングリスト+着車情報
app.get('/api/picking/driver/:vehicle_no', (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0,10).replace(/-/g, '')).replace(/[^\d]/g, '');
  const vehicle = req.params.vehicle_no;
  const lines = q.vehicleDetail.all(date, vehicle);
  if (lines.length === 0) return res.json({ date, vehicle_no: vehicle, lines: [], sites: [], arrived: [], arrival_labels: {}, company: null });
  // 号車の業者を先頭行から取得
  const company = lines.find(l => l.company)?.company || null;
  const arrivedRows = q.arrivalsForDate.all(date);
  const arrived = new Set(arrivedRows.map(a => a.route));
  const arrivalLabels = buildArrivalLabels(arrivedRows);
  // 変更履歴から編集済み現場セットを作る
  const editedRows = db.prepare(`SELECT DISTINCT vehicle_no, destination FROM picking_changes WHERE load_date=?`).all(date);
  const editedSites = new Set(editedRows.map(e => (e.vehicle_no || '') + '|' + (e.destination || '')));
  // 現場×便でグループ化
  const groups = {};
  for (const l of lines) {
    const key = (l.destination || '_dealer') + '|' + (l.source_route || '');
    if (!groups[key]) {
      const lbl = l.source_route ? arrivalLabels[l.source_route] : null;
      groups[key] = {
        destination: l.destination || '販売店納品',
        source_route: l.source_route || '',
        is_dealer: l.is_dealer ? true : false,
        arrived: l.source_route === '' ? true : arrived.has(l.source_route),
        arrival_order: lbl ? lbl.order : null,
        arrival_label: lbl ? lbl.label : null,
        arrived_at: lbl ? lbl.arrived_at : null,
        delivery_order: l.delivery_order || null,
        eta_time: l.eta_time || null,
        time_spec: l.time_spec || null,
        transfer_base: l.transfer_base || null,
        edited: editedSites.has(vehicle + '|' + (l.destination || '')),
        items: [],
        total_qty: 0,
        picked_qty: 0,
      };
    }
    groups[key].items.push(l);
    groups[key].total_qty += l.quantity;
    groups[key].picked_qty += l.picked_count;
  }
  const sites = Object.values(groups).map(g => Object.assign(g, {
    status: g.picked_qty >= g.total_qty ? 'done' : (g.arrived ? 'ready' : 'waiting')
  }));
  res.json({ date, vehicle_no: vehicle, company, sites, arrived: Array.from(arrived), arrival_labels: arrivalLabels });
});

// ピック1個 (品名CDをスキャンorタップ)
app.post('/api/picking/pick', (req, res) => {
  const { date, vehicle_no, product_cd, destination, delta } = req.body || {};
  if (!date || !vehicle_no || !product_cd) return res.status(400).json({ error: 'missing' });
  const inc = Number(delta) || 1;
  // destination指定があれば一致行のみ、なければvehicle内の最初の未完了行
  let row;
  if (destination) {
    row = db.prepare(`
      SELECT * FROM picking_orders
      WHERE load_date=? AND vehicle_no=? AND product_cd=? AND destination=? AND picked_count < quantity
      ORDER BY id LIMIT 1
    `).get(date, vehicle_no, product_cd, destination);
  } else {
    row = db.prepare(`
      SELECT * FROM picking_orders
      WHERE load_date=? AND vehicle_no=? AND product_cd=? AND picked_count < quantity
      ORDER BY id LIMIT 1
    `).get(date, vehicle_no, product_cd);
  }
  if (!row) {
    // 未完了行がない → 既に完了済(=重複) or そもそも指示に無い(=エラー) を判別
    let exists;
    if (destination) {
      exists = db.prepare(`SELECT 1 FROM picking_orders WHERE load_date=? AND vehicle_no=? AND product_cd=? AND destination=? LIMIT 1`).get(date, vehicle_no, product_cd, destination);
    } else {
      exists = db.prepare(`SELECT 1 FROM picking_orders WHERE load_date=? AND vehicle_no=? AND product_cd=? LIMIT 1`).get(date, vehicle_no, product_cd);
    }
    return res.json({ ok: false, error: exists ? 'already_done' : 'not_found' });
  }
  const newCount = Math.min(row.quantity, row.picked_count + inc);
  const newStatus = newCount >= row.quantity ? 'done' : 'picking';
  db.prepare(`UPDATE picking_orders SET picked_count=?, status=?, picked_at=? WHERE id=?`)
    .run(newCount, newStatus, Date.now(), row.id);
  // 号車全体が完了したら自動でセッション終了
  const remain = db.prepare(`
    SELECT COUNT(*) as c FROM picking_orders
    WHERE load_date=? AND vehicle_no=? AND picked_count < quantity
  `).get(date, vehicle_no).c;
  let summary = null;
  if (remain === 0) {
    q.endPickSession.run(Date.now(), date, vehicle_no);
    const sess = q.getPickSession.get(date, vehicle_no);
    const stats = db.prepare(`
      SELECT SUM(picked_count) as total_picked, COUNT(DISTINCT destination) as sites,
             COUNT(*) as lines, SUM(size_count) as total_size,
             MIN(NULLIF(eta_time, '')) as eta_min,
             MAX(NULLIF(eta_time, '')) as eta_max
      FROM picking_orders WHERE load_date=? AND vehicle_no=?
    `).get(date, vehicle_no);
    const company = db.prepare(`SELECT company FROM picking_orders WHERE load_date=? AND vehicle_no=? AND company IS NOT NULL LIMIT 1`).get(date, vehicle_no);
    summary = {
      vehicle_no, date,
      driver_name: sess ? sess.driver_name : '',
      company: company ? company.company : null,
      started_at: sess ? sess.started_at : null,
      ended_at: sess ? sess.ended_at : null,
      duration_ms: sess ? (sess.ended_at - sess.started_at) : 0,
      total_picked: stats.total_picked || 0,
      sites: stats.sites || 0,
      lines: stats.lines || 0,
      total_size: Math.round((stats.total_size || 0) * 10) / 10,
      eta_min: stats.eta_min || null,
      eta_max: stats.eta_max || null,
    };
    // adminへWS通知
    try { broadcast({ type: 'vehicle-done', summary }); } catch(_) {}
  }
  res.json({ ok: true, line_id: row.id, picked_count: newCount, quantity: row.quantity, status: newStatus,
    product_name: row.product_name, destination: row.destination, vehicle_done: remain === 0, summary });
});

// ===== ピッキング時間計測 =====
// ピッキング開始 (冪等: 既存セッションあればstarted_atを保持)
app.post('/api/picking/session/start', (req, res) => {
  const { date, vehicle_no, driver_name } = req.body || {};
  if (!date || !vehicle_no || !driver_name) return res.status(400).json({ error: 'missing' });
  q.upsertPickSession.run(String(date), String(vehicle_no), String(driver_name).slice(0, 40), Date.now());
  const s = q.getPickSession.get(String(date), String(vehicle_no));
  res.json({ ok: true, session: s });
});

// ピッキング終了 (明示終了。自動終了もpickエンドポイント側で実施)
app.post('/api/picking/session/end', (req, res) => {
  const { date, vehicle_no } = req.body || {};
  if (!date || !vehicle_no) return res.status(400).json({ error: 'missing' });
  q.endPickSession.run(Date.now(), String(date), String(vehicle_no));
  res.json({ ok: true });
});

// ピック取消(誤スキャン用)
app.post('/api/picking/unpick', (req, res) => {
  const { line_id } = req.body || {};
  if (!line_id) return res.status(400).json({ error: 'line_id required' });
  const row = db.prepare(`SELECT * FROM picking_orders WHERE id=?`).get(line_id);
  if (!row) return res.json({ ok: false });
  const newCount = Math.max(0, row.picked_count - 1);
  db.prepare(`UPDATE picking_orders SET picked_count=?, status=? WHERE id=?`)
    .run(newCount, newCount === 0 ? 'pending' : 'picking', line_id);
  res.json({ ok: true, picked_count: newCount });
});

// ---------- HTTP + WS combined server ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' && url.pathname !== '/bcscan/ws' && url.pathname !== '/bcscan/ws/') {
    socket.destroy(); return;
  }
  const role = url.searchParams.get('role'); // 'driver' or 'admin'
  if (role === 'admin') {
    if (!validToken(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
  }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.role = role === 'admin' ? 'admin' : 'driver';
    wss.emit('connection', ws, req);
  });
});

// admins get live broadcasts
const admins = new Set();
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const a of admins) {
    if (a.readyState === 1) a.send(s);
  }
}

wss.on('connection', (ws, req) => {
  if (ws.role === 'admin') {
    admins.add(ws);
    try {
      ws.send(JSON.stringify({ type: 'snapshot', sessions: q.listActive.all() }));
    } catch (_) {}
    ws.on('close', () => admins.delete(ws));
    ws.on('message', () => {});
    return;
  }

  // Driver connection
  let sessionId = null;
  let driverInfo = null;

  const heartbeat = setInterval(() => {
    if (sessionId) {
      q.touchSession.run(Date.now(), sessionId);
    }
  }, 15000);

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    if (msg.type === 'hello') {
      const name = String(msg.driver || '').slice(0, 40).trim() || '名前未設定';
      const vehicle = String(msg.vehicle || '').slice(0, 20).trim() || '車番未設定';
      sessionId = crypto.randomBytes(8).toString('hex');
      driverInfo = { id: sessionId, driver_name: name, vehicle_no: vehicle };
      const now = Date.now();
      q.insertSession.run(sessionId, name, vehicle, now, now);
      ws.send(JSON.stringify({ type: 'session', id: sessionId }));
      broadcast({
        type: 'session-start',
        session: {
          id: sessionId, driver_name: name, vehicle_no: vehicle,
          started_at: now, last_seen: now, scan_total: 0, scan_unique: 0
        }
      });
      return;
    }

    if (!sessionId) return;

    if (msg.type === 'scan') {
      const fmt = String(msg.format || '').slice(0, 32);
      const val = String(msg.value || '').slice(0, 256);
      if (!fmt || !val) return;
      const now = Date.now();
      q.insertScan.run(sessionId, fmt, val, now);
      q.touchSession.run(now, sessionId);
      broadcast({
        type: 'scan',
        session_id: sessionId,
        driver_name: driverInfo.driver_name,
        vehicle_no: driverInfo.vehicle_no,
        format: fmt,
        value: val,
        scanned_at: now
      });
      return;
    }

    if (msg.type === 'heartbeat') {
      q.touchSession.run(Date.now(), sessionId);
      return;
    }

    if (msg.type === 'bye') {
      const now = Date.now();
      q.endSession.run(now, now, sessionId);
      broadcast({ type: 'session-end', id: sessionId, ended_at: now });
      sessionId = null;
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    if (sessionId) {
      const now = Date.now();
      q.endSession.run(now, now, sessionId);
      broadcast({ type: 'session-end', id: sessionId, ended_at: now });
    }
  });
});

// Auto-end stale sessions every 30s
setInterval(() => {
  const cutoff = Date.now() - STALE_MS;
  const info = q.autoEndStale.run(cutoff);
  if (info.changes > 0) {
    broadcast({ type: 'refresh' });
  }
}, 30000);

// Damage retention cleanup: hourly sweep, deletes rows + files older than 90 days
function purgeOldDamages() {
  const cutoff = Date.now() - DAMAGE_RETENTION_MS;
  const rows = q.deleteOldDamages.all(cutoff);
  if (rows.length === 0) return;
  for (const r of rows) {
    for (let i = 0; i < 3; i++) {
      const fp = path.join(DAMAGE_DIR, `${r.id}_${i}.jpg`);
      try { fs.unlinkSync(fp); } catch {}
    }
  }
  const info = q.purgeDamages.run(cutoff);
  console.log(`[bcscan] purged ${info.changes} damage reports older than 90 days`);
}
setInterval(purgeOldDamages, 60 * 60 * 1000);
setTimeout(purgeOldDamages, 30 * 1000);

// ===== 商品マスタAPI (bc-scan視覚補助) =====
server.listen(PORT, '127.0.0.1', () => {
// 商品マスタAPI (bcscan/server.js 末尾に追記する用)
// PRODUCT_DIR を data/products に
const PRODUCT_DIR = path.join(DATA_DIR, 'products');
fs.mkdirSync(PRODUCT_DIR, { recursive: true });

const productUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

// 商品マスタ一覧
app.get('/api/products', (req, res) => {
  const q = String(req.query.q || '').trim();
  let sql = 'SELECT barcode, name, name2, image_path, format, size_info, created_at FROM products';
  const params = [];
  if (q) {
    sql += ' WHERE barcode LIKE ? OR name LIKE ? OR name2 LIKE ?';
    params.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
  }
  sql += ' ORDER BY updated_at DESC LIMIT 10000';
  const rows = db.prepare(sql).all(...params);
  res.json({ success: true, products: rows });
});

// 文字列類似度 (Levenshtein正規化) — OCR結果と商品マスタの照合用
function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n];
}
function _normForCompare(s) {
  return String(s || '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[（）]/g, m => m === '（' ? '(' : ')')
    .replace(/\s+/g, '')
    .toUpperCase();
}
function _similarity(a, b) {
  const A = _normForCompare(a), B = _normForCompare(b);
  const max = Math.max(A.length, B.length);
  if (!max) return 1;
  return 1 - _levenshtein(A, B) / max;
}

// 商品名/品種名OCR (Gemini Vision) — フィールド指定で文脈とマスタ照合先を切替
// field='name' → 商品名(型番系、英数字+カタカナ)
// field='name2' → 品種名(漢字+カタカナ、短い分類用語)
app.post('/api/products/ocr', productUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ success: false, msg: '画像なし' });
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(503).json({ success: false, msg: 'OCR未設定 (GEMINI_API_KEY)' });
    const b64 = req.file.buffer.toString('base64');
    const mime = req.file.mimetype || 'image/jpeg';

    const field = (String(req.body.field || 'name').trim() === 'name2') ? 'name2' : 'name';
    const isName2 = field === 'name2';

    // マスタから例をサンプリング (品種名は重複が多いのでDISTINCT)
    const sampleSql = isName2
      ? 'SELECT DISTINCT name2 AS val FROM products WHERE name2 IS NOT NULL AND length(name2) > 0 ORDER BY RANDOM() LIMIT 14'
      : 'SELECT name AS val FROM products WHERE name IS NOT NULL AND length(name) > 0 ORDER BY RANDOM() LIMIT 14';
    const sampleRows = db.prepare(sampleSql).all();
    const sampleLines = sampleRows.map(r => '・' + r.val).join('\n');

    const prompt = isName2
      ? `この画像は商品ラベルの品種名(分類用語)部分です。書かれている品種名を1行で正確に抽出してください。

【品種名の特徴 (登録済みマスタからの例)】
${sampleLines || '・(マスタ未登録)'}

【厳守ルール】
- 出力は品種名のみ1行。Markdown・引用符・説明文NG
- 文字種は漢字／カタカナ／ひらがな／半角・全角括弧／ハイフン混在
- 漢字の細部に注意 (戸/門, 油/曲, 流/沈, 堅/賢, 板/坂 等の類似形)
- カタカナ混同に注意 (ア⇔マ, シ⇔ツ, ン⇔ソ, セ⇔ヒ, ロ⇔口)
- マスタ例にあるような短い分類用語が想定 (吊戸、洗面天板、レンジフード、ガス台、エンドパネル 等)
- 確実な部分だけ返す。読めない部分は省略OK
- 全く読めない場合は空文字`
      : `この画像は商品ラベルの商品名(型番)部分です。書かれている商品名・型番を1行で正確に抽出してください。

【商品名の特徴 (登録済みマスタからの例)】
${sampleLines || '・(マスタ未登録)'}

【厳守ルール】
- 出力は商品名のみ1行。Markdown・引用符・説明文NG
- 文字種は英数字／カタカナ／半角・全角括弧／ハイフン／スペースの混在
- カタカナの混同に注意 (ア⇔マ, シ⇔ツ, ン⇔ソ, セ⇔ヒ, ラ⇔テ, ハ⇔ル)
- 確実な部分だけ返す。読めない部分は省略OK
- 全く読めない場合は空文字`;

    const body = {
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: mime, data: b64 } }
      ]}],
      generationConfig: { temperature: 0, maxOutputTokens: 120, thinkingConfig: { thinkingBudget: 0 } }
    };
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(key);
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn('[ocr] gemini', r.status, t.slice(0, 200));
      return res.status(502).json({ success: false, msg: 'OCRエラー (' + r.status + ')' });
    }
    const data = await r.json();
    let txt = '';
    try { txt = String(data.candidates[0].content.parts[0].text || '').trim(); } catch (_) {}
    txt = txt.replace(/^["'「『]+|["'」』]+$/g, '').replace(/\r?\n.*$/s, '').trim();

    // マスタとのファジーマッチで類似候補を提示 (品種名はDISTINCTで重複除去)
    let candidates = [];
    if (txt && txt.length >= 1) {
      const allSql = isName2
        ? 'SELECT DISTINCT name2 AS val FROM products WHERE name2 IS NOT NULL AND length(name2) > 0'
        : 'SELECT barcode, name AS val FROM products WHERE name IS NOT NULL AND length(name) > 0';
      const allRows = db.prepare(allSql).all();
      candidates = allRows
        .map(rw => ({ name: rw.val, barcode: rw.barcode || null, sim: _similarity(txt, rw.val) }))
        .filter(c => c.sim >= 0.55)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 3)
        .map(c => ({ name: c.name, barcode: c.barcode, sim: Math.round(c.sim * 100) }));
    }

    res.json({ success: true, field, name: txt, candidates });
  } catch (e) {
    console.error('[ocr] err', e);
    res.status(500).json({ success: false, msg: 'OCR失敗' });
  }
});

// 500円玉を基準にした寸法推定 (Gemini Vision)
// 500円玉直径=26.5mm を基準として商品の幅・高さ・奥行きを推定
app.post('/api/products/measure', productUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ success: false, msg: '画像なし' });
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(503).json({ success: false, msg: 'OCR未設定 (GEMINI_API_KEY)' });
    const b64 = req.file.buffer.toString('base64');
    const mime = req.file.mimetype || 'image/jpeg';

    const prompt = `この画像には商品と日本の500円硬貨が一緒に写っています。
500円硬貨は直径26.5mm・厚さ1.95mmです。これを基準に商品の寸法をmm単位で推定してください。

【出力ルール】
- 厳密にJSONのみで返す (Markdown禁止、説明文禁止、コードブロック禁止)
- スキーマ:
  {
    "found_coin": true/false,
    "width_mm": 整数 or null,
    "height_mm": 整数 or null,
    "depth_mm": 整数 or null,
    "confidence": "高" | "中" | "低",
    "note": "短い補足 (最大40文字)"
  }
- 500円硬貨が画像にない・判別不能なら found_coin: false にして他フィールドはnull
- 商品が硬貨に対して大きすぎる(画面端まで届く)場合は confidence: "低"
- 奥行きが見えない平面画像なら depth_mm: null
- カメラ角度や視差で正確に取れない場合も confidence: "低" にして可能な限り推定
- 推定不能な軸は null`;

    const body = {
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: mime, data: b64 } }
      ]}],
      generationConfig: {
        temperature: 0, maxOutputTokens: 200,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 }
      }
    };
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(key);
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn('[measure] gemini', r.status, t.slice(0, 200));
      return res.status(502).json({ success: false, msg: '寸法推定エラー (' + r.status + ')' });
    }
    const data = await r.json();
    let txt = '';
    try { txt = String(data.candidates[0].content.parts[0].text || '').trim(); } catch (_) {}
    // JSONブロック除去 (Markdown混入対策)
    txt = txt.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch (e) {
      console.warn('[measure] JSON parse fail:', txt.slice(0, 200));
      return res.status(502).json({ success: false, msg: 'AI応答解析失敗', raw: txt });
    }
    if (!parsed.found_coin) {
      return res.json({ success: false, msg: '500円玉が認識できませんでした。一緒に写るようにもう一度撮影してください' });
    }
    res.json({
      success: true,
      dimensions: {
        width_mm: parsed.width_mm,
        height_mm: parsed.height_mm,
        depth_mm: parsed.depth_mm,
        confidence: parsed.confidence || '中',
        note: parsed.note || '',
      },
    });
  } catch (e) {
    console.error('[measure] err', e);
    res.status(500).json({ success: false, msg: '寸法推定失敗' });
  }
});

// 商品マスタ取得 (ピッキング時のスキャン後表示用)
app.get('/api/products/:barcode', (req, res) => {
  const row = db.prepare('SELECT * FROM products WHERE barcode = ?').get(req.params.barcode);
  if (!row) return res.json({ success: false, msg: '未登録' });
  res.json({ success: true, product: row });
});

// 商品マスタ写真
app.get('/api/products/:barcode/photo', (req, res) => {
  const row = db.prepare('SELECT image_path FROM products WHERE barcode = ?').get(req.params.barcode);
  if (!row || !row.image_path) return res.status(404).send('No photo');
  const fp = path.join(PRODUCT_DIR, row.image_path);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found');
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(fp);
});

// 商品マスタ登録/更新
app.post('/api/products', productUpload.single('photo'), (req, res) => {
  const barcode = String(req.body.barcode || '').trim();
  const name = String(req.body.name || '').trim();
  const name2 = String(req.body.name2 || '').trim();
  const format = String(req.body.format || '').trim();
  const sizeInfo = String(req.body.size_info || '').trim();
  const createdBy = String(req.body.created_by || '').trim();
  if (!barcode || !name) return res.status(400).json({ success: false, msg: 'バーコードと商品名は必須' });
  if (barcode.length > 60 || name.length > 200 || name2.length > 200) return res.status(400).json({ success: false, msg: '入力が長すぎます' });

  let imagePath = null;
  if (req.file && req.file.buffer) {
    const ext = '.jpg';
    imagePath = `${barcode.replace(/[^a-zA-Z0-9_\-]/g, '_')}${ext}`;
    fs.writeFileSync(path.join(PRODUCT_DIR, imagePath), req.file.buffer);
  }

  const now = Date.now();
  const existing = db.prepare('SELECT image_path FROM products WHERE barcode = ?').get(barcode);
  if (existing) {
    db.prepare(`UPDATE products SET name = ?, name2 = ?, format = ?, size_info = ?, image_path = COALESCE(?, image_path), updated_at = ? WHERE barcode = ?`)
      .run(name, name2, format, sizeInfo, imagePath, now, barcode);
  } else {
    db.prepare(`INSERT INTO products (barcode, name, name2, image_path, format, size_info, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(barcode, name, name2, imagePath, format, sizeInfo, createdBy, now, now);
  }
  res.json({ success: true, barcode, name });
});

// 商品マスタ削除
app.delete('/api/products/:barcode', adminOnly, (req, res) => {
  const barcode = req.params.barcode;
  const row = db.prepare('SELECT image_path FROM products WHERE barcode = ?').get(barcode);
  if (row && row.image_path) {
    const fp = path.join(PRODUCT_DIR, row.image_path);
    if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch (e) {}
  }
  db.prepare('DELETE FROM products WHERE barcode = ?').run(barcode);
  res.json({ success: true });
});
  console.log('[bcscan] listening on 127.0.0.1:' + PORT);
});
