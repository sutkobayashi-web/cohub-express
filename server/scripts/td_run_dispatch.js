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
  const sites = db.prepare(`
    SELECT o.site_name,
      SUM(o.qty) AS qty,
      SUM(o.sai) AS sai,
      (SELECT address FROM td_dispatch_history h WHERE h.site_name = o.site_name ORDER BY h.id DESC LIMIT 1) AS address,
      (SELECT time_spec FROM td_dispatch_history h WHERE h.site_name = o.site_name AND h.load_date = ? ORDER BY h.id DESC LIMIT 1) AS time_spec,
      (SELECT eta FROM td_dispatch_history h WHERE h.site_name = o.site_name AND h.load_date = ? ORDER BY h.id DESC LIMIT 1) AS eta
    FROM td_orders o WHERE o.load_date = ?
    GROUP BY o.site_name
  `).all(ld, ld, ld);
  if (!sites.length) { console.error('No data for load_date', ld); process.exit(1); }
  console.log('現場数:', sites.length, '合計才数:', sites.reduce((a, s) => a + (s.sai || 0), 0).toFixed(0));

  // 過去履歴から「実号車番号」と「平均車種」を取得 (AIに投入する実号車プール)
  const fleet = db.prepare(`
    SELECT DISTINCT original_vehicle_no AS vehicle_no, vehicle_type
    FROM td_dispatch_history
    WHERE original_vehicle_no <> ''
      AND vehicle_type IN ('2tｼｮｰﾄ','2tｽﾘﾑ','2tｼｮｰﾄ平ﾎﾞﾃﾞｨ','2t平ﾎﾞﾃﾞｨ','2t')
    ORDER BY original_vehicle_no
  `).all();
  console.log('実号車プール:', fleet.length, '台');

  const siteListLines = sites.map((s, i) => {
    const ts = s.time_spec === 'hard' ? '🔒時間指定厳守' : s.time_spec === 'soft' ? '⏰希望帯' : '指定なし';
    return `${i + 1}. ${s.site_name} | 才数${(s.sai || 0).toFixed(1)} 数量${(s.qty || 0).toFixed(0)} | ${ts} ${s.eta ? '希望' + s.eta : ''} | 住所:${s.address || '推定'}`;
  }).join('\n');

  const fleetLines = fleet.map(f => `${f.vehicle_no} (${f.vehicle_type})`).join(', ');

  const prompt = `あなたは座間積替倉庫(神奈川県座間市)を起点とする首都圏配送の配車プランナーです。
タカラスタンダード様の住宅設備機器を首都圏に配送する2t車両のルートを組成します。

【絶対制約】
- 起点・終点: 座間倉庫
- 時間指定厳守(🔒)の現場: 希望ETA±15分以内で訪問
- 時間希望(⏰)の現場: できるだけ希望帯を守る (±60分許容)
- **車種は2t車のみ** (4t/3tユニック等は存在しない):
  - 2tｼｮｰﾄ (容量目安: 約45才)
  - 2tｽﾘﾑ (容量目安: 約40才)
  - 2tｼｮｰﾄ平ﾎﾞﾃﾞｨ (容量目安: 約45才・大型品向け)
  - 2t平ﾎﾞﾃﾞｨ (容量目安: 約50才)
  - 2t (容量目安: 約45才)
- 各号車1日 **3〜6現場、合計才数50才以下** が現実的
- 時間指定がある現場 + その近隣の指定なし現場をまとめて1台に組む
- 配送終了後は座間に戻る前提でルート設計

【使用可能な実号車プール (この中から号車番号を選ぶこと)】
${fleetLines}
※ 上記が当日全車稼働を前提。1日 ${fleet.length} 台前後の運用が標準。

【配送先 (load_date=${ld}, 計${sites.length}現場)】
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
          "site_name": "(現場名 入力リストのものをそのまま)",
          "eta": "0800",
          "time_spec": "hard|soft|null",
          "qty": 27,
          "sai": 27,
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
    maxTokens: 16000,
    responseMimeType: 'application/json',
  });
  let plan;
  try { plan = JSON.parse(out); }
  catch (e) { console.error('JSON parse error:', out.slice(0, 200)); process.exit(1); }

  console.log('AI応答受信。号車数:', (plan.vehicles || []).length);
  // 既存をクリア
  db.prepare(`DELETE FROM td_dispatches WHERE load_date = ?`).run(ld);
  db.prepare(`DELETE FROM td_dispatch_meta WHERE load_date = ?`).run(ld);
  const insDisp = db.prepare(`INSERT INTO td_dispatches
    (load_date, vehicle_no, sequence, site_name, address, eta, time_spec, qty, sai, ai_reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);
  const insMeta = db.prepare(`INSERT INTO td_dispatch_meta
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
