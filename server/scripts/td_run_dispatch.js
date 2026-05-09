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
  console.log('WMS現場数:', sites.length, '合計才数:', sites.reduce((a, s) => a + (s.sai || 0), 0).toFixed(0));
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
- **1台あたり 1〜3現場が基本**、同方面で束ねる
- **合計才数は車種容量上限を絶対超えないこと**
- **時間指定の現場 + その住所周辺の時間指定なし現場をまとめて1台に組む** ← 最重要
- 配送終了後は座間に戻る前提でルート設計

【時間指定+住所ヒント (Logistarが組んだ${dispatchHints.length}現場、地理推論の起点に)】
${hintLines}

※ 上記の住所を地理的アンカーとして、下記WMS全現場を「方面束ね」してください。
※ WMS現場名と時間指定ヒントの納入先名は表記が異なる場合あり(類推OK)。
※ WMS現場リストにのみ存在する現場(時間指定なし)も、住所推定で同方面の時間指定ストップの号車に組み込んでください。

【使用可能な実号車プール】
${fleetLines}

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
