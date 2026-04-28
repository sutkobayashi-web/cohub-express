// 受付AI 葵 を実写風に再生成 (旧:漫画調アニメ → 新:ヘルスアドバイザーと同じ実写トーン)
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const OUT = '/opt/cohub/public/assets/concierge_aoi_full.png';

const PROMPT = `**運送会社の受付係 葵 (Aoi)** のキャラクター立ち姿を生成してください。

【キャラクター】
- 20代後半の親しみやすい印象の女性 (アジア系)
- 黒〜ダークブラウンのセミロングヘア (肩より少し下)
- **薄いネイビーまたはダークグレーのビジネススーツ**(ジャケット+スカートまたはパンツ)
- 白のシャツまたはブラウス
- 名札は無地 (固有名は描かない)
- 表情: にこやかで丁寧、明るく親しみやすい受付係らしい雰囲気
- ポーズ: 正面向きで**右手を肩の高さあたりまで持ち上げ、手のひらを上向きにして「こちらへどうぞ」と案内する仕草**
  · 左手は体の横に自然に下ろすか、軽く腰のあたりに添える
  · 右肘は軽く曲げ、右手は胸〜肩の高さで前方に開く (受付係らしいエスコート姿勢)

【スタイル — ヘルスアドバイザー画像と統一】
- **リアル写真調** (アニメ・漫画・Pixar調ではない、実写ベースの写真風レンダリング)
- 全身が入る縦長構図 (頭から足まで、背景は**完全に白 #FFFFFF**)
- 自然な肌の質感、立体感のある陰影
- 立ち姿の影は最小限

【重要】
- 背景は**真っ白(無地)**にしてください (後でクライアント側で透過処理します)
- キャラクター以外の物体(机、椅子、受付カウンター等)を入れない
- 顔は具体的すぎない、誰にでも親しみやすい平均的な造形
- アニメ・漫画・イラスト風は禁止 (リアルな写真風で)`;

async function geminiImage(prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.85 },
  };
  console.log('Gemini に葵(実写風)生成リクエスト送信中…');
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('API ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('応答にcontent.partsなし');
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) return Buffer.from(inline.data, 'base64');
    if (p.text) console.log('[text]', p.text.slice(0, 200));
  }
  throw new Error('画像が返ってきませんでした');
}

(async () => {
  if (fs.existsSync(OUT)) fs.copyFileSync(OUT, OUT + '.bak.' + Date.now());
  fs.writeFileSync(OUT, await geminiImage(PROMPT));
  console.log('✅ 葵(実写風)生成完了:', OUT);
})().catch(e => { console.error(e); process.exit(2); });
