// かいぎ出太郎マスコット生成 (Gemini 2.5 Flash Image)
// 実行: node scripts/generate-kaigi-detaro.js
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '/opt/cohub/.env' });

const OUT_DIR = '/opt/cohub/public/img';
const OUT_FILE = path.join(OUT_DIR, 'kaigi-detaro.png');

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('No GEMINI_API_KEY'); process.exit(1); }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const prompt = `日本の会社マスコットキャラクター「かいぎ出太郎」のかわいいイラストを描いてください。

特徴:
- フレンドリーで親しみやすい30代男性会社員、頭が大きめのデフォルメ調(2.5頭身〜3頭身)
- 紺色のスーツに白いワイシャツ、赤いネクタイ
- 胸ポケットの上に「かいぎ出太郎」と書かれた名札(白地に黒文字)
- 右手にクリップボード(ミーティング予定表)を持ち、左手で「こちらどうぞ」と前方を指差すポーズ
- 顔は丸く、優しい笑顔、つぶらな黒い瞳、黒髪短髪
- 映画館の案内係や駅の駅員のようなホスピタリティ感
- 全身が画面内に完全に収まる構図(頭のてっぺんから足先まで)
- 白い背景、正方形フレーム
- 明るく親しみやすい日本アニメ調、はっきりした線、柔らかい配色`;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 1.0,
    }
  };
  console.log('Calling Gemini...');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error('Gemini error:', resp.status, (await resp.text()).slice(0, 500));
    process.exit(1);
  }
  const data = await resp.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  let imgData = null;
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) { imgData = inline.data; break; }
  }
  if (!imgData) { console.error('No image in response'); process.exit(1); }

  fs.writeFileSync(OUT_FILE, Buffer.from(imgData, 'base64'));
  console.log('Written:', OUT_FILE, '(', fs.statSync(OUT_FILE).size, 'bytes )');
})();
