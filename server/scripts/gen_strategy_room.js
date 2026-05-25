// 健康戦略室 — 推進メンバー専用ディスカッションルームを Gemini で再生成
// usage: node server/scripts/gen_strategy_room.js
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const { execSync } = require('child_process');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const ROOM_OUT = '/opt/cohub/public/assets/floor_promoter_club.png';

const ROOM_PROMPT = `現代的な企業内の**「健康戦略室」 (Strategy Room) — 推進メンバーが議論する小さな会議室**の**一人称視点**画像を生成してください。
カフェではなく、**ディスカッション用の作戦会議室**として描くこと。

【視点・構図】
- 部屋に入って正面を見る人間の目線 (身長170cm)
- **必ず 16:9 横長アスペクト比** (1344×768 px)
- 部屋は**正方形に近い4角形**、奥行き感は適度 (廊下感NG)
- 画面上半分(縦方向 0%〜45%) に**広い壁面**が見える構図 — ここに後でCanvasオーバーレイで大型ダッシュボードを重ねる
  → **画面上部の壁は何も置かず、淡いオフホワイト〜セージグリーンの単色壁面のみ** (掲示物・絵・棚・ロゴNG)
- 画面下半分は議論用の家具

【中央〜下半分の家具】
- **画面中央〜手前**: **大きな楕円〜長方形の木製ミーティングテーブル** (ダークウォルナット天板)
  - 周囲に**4〜6脚のモダンな椅子** (黒革+メタル脚 / グレーファブリック+木脚)
  - テーブル上に**ノートPC 2台 / マグカップ 2個 / 紙資料 1束 / 観葉植物 (小)** を散らしておく (打合せ中のスナップ感)
- 椅子は人物なし、空席

【両側壁】
- 左壁: **ホワイトボード**1枚 (中サイズ、付箋数枚は薄く貼ってあるが内容は読めない程度)
- 右壁: **本棚**1つ (健康経営/組織開発の書籍が数冊ナナメに並ぶ) + 大型観葉植物 (パキラやモンステラ) 1株
- 左奥に**大きな窓** (柔らかい朝の自然光が差し込む、外の緑が薄く見える)

【床・天井】
- 床: ヘリンボーン張りの淡いオーク無垢材
- 天井: 白いダウンライト+ペンダントライト1灯 (温かい白色光)

【トーン・雰囲気】
- 上品・知的・落ち着いた**戦略会議室** (cozy strategy war-room)
- ナチュラルウッド+セージグリーン+ダーク家具のバランス
- リアル写真調 (CG・イラスト風NG)
- カフェのカウンター/エスプレッソマシン/バー/酒瓶/コーヒーグッズ等は**絶対に描かない**

【重要・厳守】
- **人物は一切描かない**
- **画面上半分の壁面は単色の無地** (ここにダッシュボードを重ねるため)
- カフェ要素禁止 (バーカウンター、酒、コーヒーマシン、エプロンの店主などはNG)
- ロゴ・看板・キャッチコピー・テキストは入れない
- 受付カウンターやデスクは描かない (議論用テーブルのみ)`;

async function geminiImage(prompt, label) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.85 },
  };
  console.log(`[${label}] Gemini に生成リクエスト送信中…`);
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('API ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('応答にcontent.partsなし');
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) return Buffer.from(inline.data, 'base64');
    if (p.text) console.log(`[${label} text]`, p.text.slice(0, 200));
  }
  throw new Error('画像が返ってきませんでした');
}

(async () => {
  try {
    if (fs.existsSync(ROOM_OUT)) fs.copyFileSync(ROOM_OUT, ROOM_OUT + '.bak.' + Date.now());
    const tmpRoom = ROOM_OUT + '.raw';
    fs.writeFileSync(tmpRoom, await geminiImage(ROOM_PROMPT, 'strategy_room'));
    execSync(`ffmpeg -y -i ${tmpRoom} -vf "crop=in_w:in_w*9/16:0:(in_h-in_w*9/16)/2,scale=1344:768" -update 1 -frames:v 1 ${ROOM_OUT}`, { stdio: 'inherit' });
    fs.unlinkSync(tmpRoom);
    console.log('✅ 健康戦略室:', ROOM_OUT);
  } catch (e) {
    console.error('部屋画像失敗:', e.message);
  }
})().catch(e => { console.error(e); process.exit(2); });
