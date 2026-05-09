// AI配車生成をCLIで実行 (admin画面なしでサーバーから直接)
// 実行: node server/scripts/td_run_dispatch.js <YYYYMMDD>
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { getDb } = require('../services/db');
const { generateText } = require('../services/ai');

const ld = process.argv[2];
if (!/^\d{8}$/.test(ld || '')) { console.error('Usage: node td_run_dispatch.js YYYYMMDD'); process.exit(1); }

const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const gen8 = () => crypto.randomBytes(6).toString('base64url');

(async () => {
  const db = getDb();
  // AI入力: WMS全現場(主入力) + 配車結果の時間指定/住所ヒント
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
  let sites = wmsSites.length ? wmsSites : db.prepare(`
    SELECT site_name, address, time_spec, eta, qty, sai
    FROM td_dispatch_history WHERE load_date = ? AND site_name <> ''
  `).all(ld);
  if (!sites.length) { console.error('No data for load_date', ld); process.exit(1); }

  // (n)つき大型現場の自動分割
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
  console.log('WMS現場数(分割後):', sites.length, '合計才数:', sites.reduce((a, s) => a + (s.sai || 0), 0).toFixed(0));
  console.log('(n)つき分割元現場:', splitOriginCount, '件');
  console.log('時間指定ヒント:', dispatchHints.length, '件');

  // 過去履歴から「実号車番号」と「平均車種」を取得 (AIに投入する実号車プール)
  const fleet = db.prepare(`
    SELECT DISTINCT original_vehicle_no AS vehicle_no, vehicle_type
    FROM td_dispatch_history
    WHERE original_vehicle_no <> ''
      AND vehicle_type IN ('2tｼｮｰﾄ','2tｽﾘﾑ','2tｼｮｰﾄ平ﾎﾞﾃﾞｨ','2t平ﾎﾞﾃﾞｨ','2t')
    ORDER BY original_vehicle_no
  `).all();
  console.log('実号車プール:', fleet.length, '台');

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

  const fleetLines = fleet.map(f => `${f.vehicle_no} (${f.vehicle_type})`).join(', ');

  const totalSai = sites.reduce((a, s) => a + (s.sai || 0), 0).toFixed(0);
  const minVehicles = Math.ceil(totalSai / 200);
  const prompt = `あなたは座間積替倉庫(神奈川県座間市)を起点とする首都圏配送の配車プランナーです。

【🚨 厳守 — 才数容量(積載量)・実運用準拠】
1台の合計才数(saiの合計)は以下の上限を**絶対に**超えてはなりません:
- 軽ﾊﾞﾝ ≤ 30才
- ハイエース ≤ 80才
- 2tｽﾘﾑ ≤ 150才
- 2tｼｮｰﾄ ≤ 180才
- 2tｼｮｰﾄ平ﾎﾞﾃﾞｨ ≤ 200才
- 2t ≤ 250才
- 2t平ﾎﾞﾃﾞｨ ≤ 280才
- 2ワイド ≤ 280才

【🌍 GHG排出量・脱炭素経営 (SBTi認定済 1.5℃)】
車両別排出係数(目安 g-CO2/km): 軽ﾊﾞﾝ約120 / ハイエース約200 / 2tｼｮｰﾄ約400 / 2t系約500
**才数に応じた最小サイズ車種選択**:
- ≤30才 → 軽ﾊﾞﾝ優先
- 31〜80才 → ハイエース優先
- 81〜180才 → 2tｼｮｰﾄ
- 181〜250才 → 2t / 2t平ﾎﾞﾃﾞｨ
**1日に軽ﾊﾞﾝ・ハイエースを1台以上必ず活用** (大型車に小ロットだけ載せるのはGHG浪費)

【📐 当日の規模感】
- WMS総才数: 約${totalSai}才
- 必要号車数の下限: 約${minVehicles}台
- **目標台数: 35〜70台/日** (人手実態と同等規模)
- 実運用1日: 35〜70台。これより極端に少ない出力は才数違反の証拠。

【その他の制約】
- 起点・終点: 座間倉庫
- 時間指定厳守(🔒): ETA±15分 / 時間希望(⏰): ±60分
- **1台あたり 1〜3現場**、4現場以上禁止
- 同方面束ね優先、座間帰着前提

【時間指定+住所ヒント (Logistarが組んだ${dispatchHints.length}現場)】
${hintLines}
※ 住所を地理アンカーに WMS全現場を方面束ね。表記揺れ可。

【使用可能な実号車プール】
${fleetLines}

【WMS全配送先 (load_date=${ld}, 計${sites.length}現場、site_nameは入力どおり一字一句変更しない)】
${siteListLines}

【📋 出力前自己チェック】
1. 各号車のsai合計が車種上限以下
2. 全${sites.length}件のWMS現場が必ずどこかの号車に含まれる
3. 時間指定厳守(🔒)はETA順

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

  console.log('Geminiに問い合わせ中...');
  const out = await generateText(prompt, {
    model: 'gemini-2.5-flash',
    temperature: 0.3,
    maxTokens: 60000,
    responseMimeType: 'application/json',
  });
  let plan;
  try { plan = JSON.parse(out); }
  catch (e) { console.error('JSON parse error:', out.slice(0, 200)); process.exit(1); }
  console.log('AI応答受信。号車数:', (plan.vehicles || []).length);

  // 🚨 才数オーバーの自動分割
  const CAPACITY = { '軽ﾊﾞﾝ': 30, 'ハイエース': 80, '2tｽﾘﾑ': 150, '2tｼｮｰﾄ': 180, '2tｼｮｰﾄ平ﾎﾞﾃﾞｨ': 200, '2t': 250, '2t平ﾎﾞﾃﾞｨ': 280, '2ワイド': 280 };
  const splitVehicles = [];
  let splitCount = 0;
  const usedVehicles = new Set((plan.vehicles || []).map(v => v.vehicle_no));
  const availablePool = fleet.filter(f => !usedVehicles.has(f.vehicle_no)).map(f => f.vehicle_no);
  let poolIdx = 0;
  for (const v of (plan.vehicles || [])) {
    const cap = CAPACITY[v.vehicle_type] || 150;
    const stops = v.stops || [];
    const totalSai = stops.reduce((a, s) => a + (parseFloat(s.sai) || 0), 0);
    if (totalSai <= cap) { splitVehicles.push(v); continue; }
    let buf = []; let bufSai = 0;
    const buckets = [];
    for (const s of stops) {
      const ssai = parseFloat(s.sai) || 0;
      if (bufSai + ssai > cap && buf.length > 0) { buckets.push(buf); buf = []; bufSai = 0; }
      buf.push(s); bufSai += ssai;
    }
    if (buf.length) buckets.push(buf);
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
  if (splitCount > 0) console.log(`才数オーバー検出 → ${splitCount}台に分割補正`);
  // 既存をクリア
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
  console.log('保存完了');
  console.log('summary:', plan.summary || '');
  // 結果表示
  const meta = db.prepare(`SELECT vehicle_no, vehicle_type, driver_token FROM td_dispatch_meta WHERE load_date = ? ORDER BY vehicle_no`).all(ld);
  console.log('=== 配車URL一覧 ===');
  for (const m of meta) {
    console.log(`号車${m.vehicle_no} (${m.vehicle_type || '車種未定'}): https://cohub.biz-terrace.org/takara/driver?t=${m.driver_token}`);
  }
})();
