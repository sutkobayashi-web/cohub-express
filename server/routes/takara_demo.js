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
    const db = getDb();
    const ins = db.prepare(`INSERT INTO td_dispatch_history
      (import_id, load_date, original_vehicle_no, sequence, site_name, address, time_spec, eta, qty, sai, vehicle_type, transfer_base, company)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const importIns = db.prepare(`INSERT INTO td_imports (type, filename, load_date, row_count, created_by) VALUES ('dispatch', ?, ?, ?, ?)`);
    let loadDate = '';
    let inserted = 0;
    const importId = importIns.run(req.file.originalname || '', '', 0, req.uid).lastInsertRowid;
    for (const r of rows) {
      // 列インデックス: 業者=2, 号車=3, 営業所=4, 配送日=5, 配送順=6, 返品=7, 倉庫CD=8, 時間指定=9, 納入先=10, 住所=11, 数量=12, 才数=13, ETA=14, 車種=15, 備考=16, 受取り=17, 機種=18, 助手=19, 積替基地=20
      const company = nz(r[2]);
      if (company === '業者') continue; // ヘッダー
      const veh = nz(r[3]); if (!veh) continue;
      const ld = nz(r[5]); if (!loadDate) loadDate = ld;
      const seq = parseInt(r[6]) || null;
      const ts = nz(r[9]); // '時間指定'(hard) or '有'(soft) or ''
      const site = nz(r[10]);
      const addr = nz(r[11]);
      const qty = num(r[12]); const sai = num(r[13]);
      const eta = nz(r[14]);
      // col16(idx15)は「車種」見出しだが実データは納入数(2か所等)が混入。
      // 正規の車種は col22(idx21)。col21(idx20)は積替基地コード。
      const vt = nz(r[21]);
      const tb = nz(r[20]);
      // 時間指定の正規化
      let level = '';
      if (ts === '時間指定') level = 'hard';
      else if (ts === '有') level = 'soft';
      ins.run(importId, ld, veh, seq, site, addr, level, eta, qty, sai, vt, tb, company);
      inserted++;
    }
    db.prepare(`UPDATE td_imports SET load_date = ?, row_count = ? WHERE id = ?`).run(loadDate, inserted, importId);
    res.json({ success: true, import_id: importId, load_date: loadDate, row_count: inserted });
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

  // ジョブ起票
  const jobId = db.prepare(`INSERT INTO td_dispatch_jobs (load_date, status, request_summary, created_by) VALUES (?, 'running', ?, ?)`)
    .run(ld, JSON.stringify({ site_count: sites.length, total_sai: sites.reduce((a, s) => a + (s.sai || 0), 0) }), req.uid).lastInsertRowid;

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

    const prompt = `あなたは座間積替倉庫(神奈川県座間市)を起点とする首都圏配送の配車プランナーです。
タカラスタンダード様の住宅設備機器を首都圏に2t車両で配送するルートを組成します。

【絶対制約】
- 起点・終点: 座間倉庫
- 時間指定厳守(🔒)の現場: 希望ETA±15分以内で訪問
- 時間希望(⏰)の現場: できるだけ希望帯を守る (±60分許容)
- **車種は2t車のみ**。容量上限の目安(実運用準拠):
  - 2tｼｮｰﾄ (上限150才)
  - 2tｽﾘﾑ (上限120才)
  - 2tｼｮｰﾄ平ﾎﾞﾃﾞｨ (上限180才・大型品向け)
  - 2t平ﾎﾞﾃﾞｨ (上限200才・大型品向け)
  - 2t (上限150才)
- **1台あたり 1〜3現場が基本** (実運用準拠、同方面で束ねる):
  - 大型物件(150才超)単独 → 1現場/台
  - 同方面 (徒歩/車で近接) で 2〜3現場/台 を束ねる
  - 4件以上は近距離・小ロットの特殊ケースのみ
- **合計才数は車種容量上限を絶対超えないこと**。超えるなら別号車に分割
- **時間指定の現場 + その住所周辺の時間指定なし現場をまとめて1台に組む** ← 最重要
- 配送終了後は座間に戻る前提でルート設計

【時間指定+住所ヒント (Logistarが組んだ${dispatchHints.length}現場、これを地理推論の起点に)】
${hintLines}

※ 上記の住所を地理的アンカーとして、下記WMS全現場を「方面束ね」してください。
※ WMS現場名と時間指定ヒントの納入先名は表記が異なる場合があります(例:WMS「保川」=ヒント「神奈川県横浜市保土ケ谷区...」のような対応)。
※ 表記揺れがあれば類推OK。WMS現場リストにのみ存在する現場(時間指定なし)も、住所推定で同方面の時間指定ストップの号車に組み込んでください。

【使用可能な実号車プール (この中から号車番号を選ぶこと)】
${fleetLines}
※ 上記が当日全車稼働を前提。実運用では1日50〜70台台前後 (現場の物量で増減)。

【WMS全配送先 (load_date=${ld}, 計${sites.length}現場、site_nameは入力どおり一字一句変更しない)】
${siteListLines}

【出力フォーマット (JSONのみ、それ以外何も書かない)】
{
  "vehicles": [
    {
      "vehicle_no": "401",
      "vehicle_type": "2tｼｮｰﾄ",
      "stops": [
        {
          "sequence": 1,
          "site_name": "(納入先名 入力リストのものをそのまま、改変禁止)",
          "eta": "0800",
          "time_spec": "hard|soft|null",
          "qty": 27,
          "sai": 97,
          "reason": "時間指定厳守、神奈川中部"
        }
      ]
    }
  ],
  "summary": "号車数X台、平均◯ストップ、座間帰着前提で計画"
}`;

    const out = await generateText(prompt, {
      model: 'gemini-2.5-flash',
      temperature: 0.3,
      maxTokens: 16000,
      responseMimeType: 'application/json',
    });

    let plan;
    try { plan = JSON.parse(out); } catch (e) {
      throw new Error('AI応答のJSON解析失敗: ' + (out || '').slice(0, 200));
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
    res.json({ success: true, job_id: jobId, summary: plan.summary || '', vehicle_count: (plan.vehicles || []).length });
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
    return { ...g, ...m };
  });
  res.json({ success: true, load_date: ld, vehicles });
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
