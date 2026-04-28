// 健康管理室の一人称視点画像 + ヘルスアドバイザー立ち姿を Gemini で生成
// usage: node server/scripts/gen_wellness_room.js
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const ROOM_OUT = '/opt/cohub/public/assets/floor_wellness_room.png';
const ADVISOR_OUT = '/opt/cohub/public/assets/concierge_health_full.png';

const ROOM_PROMPT = `現代的な企業内の**健康管理室・産業保健相談室**の**一人称視点**画像を生成してください。

【視点・構図】
- 部屋に入って机に向かう人間の目線(身長170cm)
- **必ず 16:9 横長アスペクト比** (1344×768 px)
- 中央〜やや右に**白い相談デスク**(腰高、明るい木目縁)、その奥にヘルスアドバイザーが立つスペース
- デスクの背後の壁は**淡い緑(セージグリーン)とオフホワイト**のツートン、医療系の落ち着いた色調
- 壁にシンプルな**心電図/聴診器/緑十字のアイコン**または「Wellness」の控えめな文字
- 左側に**待合エリア**(クリーム色のソファ1-2席+小さな丸テーブル+観葉植物)
- 右奥にエレベーター(2基、シルバー枠)
- 床はライトグレーの大判タイル、天井は白くダウンライトが点在

【トーン・雰囲気】
- 清潔感・安心感のあるクリニック風(冷たすぎない、温かみあり)
- 朝の柔らかい光が左の窓から差し込む
- リアル写真調 (CG・イラスト風ではなく、実写風レンダリング)
- 落ち着いたグリーン+ホワイト基調、医療施設のような清潔感
- 観葉植物(モンステラやポトス)を配置

【重要】
- アドバイザー本人の**顔は描かないでください** (後で別アバターを重ねる予定なのでデスクは無人で生成)
- 文字・看板・追加ロゴは入れない (壁の控えめなアイコンか「Wellness」のみ可)
- デスクの上はスッキリ (PCモニター、観葉植物、書類トレー程度可)`;

const ADVISOR_PROMPT = `**産業保健の AI ヘルスアドバイザー**のキャラクター立ち姿を生成してください。

【キャラクター】
- 30代前半の落ち着いた印象の女性 (アジア系)
- 短めのボブヘア
- **白衣**または**淡い水色のスクラブ(医療用ユニフォーム)**を着用
- 名札は無地でOK (架空の社員と区別するため固有名は無し)
- 表情: 優しく真摯、相談しやすい雰囲気
- ポーズ: 正面向きで両手を体の前で軽く組む、または片手を胸に当てる

【スタイル】
- リアル写真調 (Pixar/アニメではない、実写ベース)
- 全身が入る縦長構図 (頭から足まで、背景は**完全に白 #FFFFFF**)
- 背景に余計な装飾やグラデーションを入れない (透過処理用)
- 立ち姿の影も最小限

【重要】
- 背景は**真っ白(無地)**にしてください (後でクライアント側で透過処理します)
- キャラクター以外の物体(机、椅子、医療器具等)を入れない
- 顔は具体的すぎない、誰にでも親しみやすい平均的な造形`;

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
  // 1. 部屋画像 (1344×768 にクロップ)
  try {
    if (fs.existsSync(ROOM_OUT)) fs.copyFileSync(ROOM_OUT, ROOM_OUT + '.bak.' + Date.now());
    const tmpRoom = ROOM_OUT + '.raw';
    fs.writeFileSync(tmpRoom, await geminiImage(ROOM_PROMPT, 'wellness_room'));
    execSync(`ffmpeg -y -i ${tmpRoom} -vf "crop=in_w:in_w*9/16:0:(in_h-in_w*9/16)/2,scale=1344:768" -update 1 -frames:v 1 ${ROOM_OUT}`, { stdio: 'inherit' });
    fs.unlinkSync(tmpRoom);
    console.log('✅ 部屋画像:', ROOM_OUT);
  } catch (e) {
    console.error('部屋画像失敗:', e.message);
  }
  // 2. アドバイザー立ち姿
  try {
    if (fs.existsSync(ADVISOR_OUT)) fs.copyFileSync(ADVISOR_OUT, ADVISOR_OUT + '.bak.' + Date.now());
    fs.writeFileSync(ADVISOR_OUT, await geminiImage(ADVISOR_PROMPT, 'advisor'));
    console.log('✅ アドバイザー:', ADVISOR_OUT);
  } catch (e) {
    console.error('アドバイザー失敗:', e.message);
  }
})().catch(e => { console.error(e); process.exit(2); });
