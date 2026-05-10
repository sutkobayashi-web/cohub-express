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
const { classifyVehicle, COMPANY_COLORS } = require('../services/takara_helpers');

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
    const company = classifyVehicle(g.vehicle_no);
    return { ...g, ...m, company, company_color: COMPANY_COLORS[company] };
  });
  // 業者別サマリー
  const summary = {};
  for (const v of vehicles) {
    if (!summary[v.company]) summary[v.company] = { count: 0, stops: 0, total_sai: 0 };
    summary[v.company].count++;
    summary[v.company].stops += v.stops.length;
    summary[v.company].total_sai += v.total_sai || 0;
  }
  res.json({ success: true, load_date: ld, vehicles, summary, company_colors: COMPANY_COLORS });
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
