// 須貝さんのアバターに ヒヨコ/ひな鳥 1羽 を頭に乗せる (上端で切れない構図、Gemini 2.5 Flash Image)
// 実行: GEMINI_API_KEY=... node scripts/sugai_chick_one.js
const fs = require('fs');
const path = require('path');

const BASE = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/sugai_base.png');
const OUT_DIR = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `この人物画像をベースに、頭の上にヒヨコまたはひな鳥(黄色〜薄黄のふわふわの雛鳥)を**ちょうど1羽だけ**乗せてください。

【最重要 — 構図】
- ヒヨコの**全身(頭頂から足先まで)が画面フレーム内に完全に収まる**こと
- ヒヨコの頭頂と画面フレーム上端の間に、ヒヨコ本体の高さの**約半分以上の余白**を必ず取る (上で切れない)
- ヒヨコは人物の頭頂部にちょこんと座るが、髪の上に少し**沈み込む**ような位置(頭頂より少し下)に配置する。突き出さない
- 必要なら人物全体をフレーム内で少し下に寄せ、上部に十分な空間を確保すること

【ヒヨコの描き方】
- **正確に1羽のみ** (絶対に2羽以上にしない)
- サイズは人物の頭の幅の約3分の1〜2分の1
- 丸くてふわふわ、鮮やかな黄色〜薄黄の体、オレンジ色の小さなくちばしと足、つぶらな黒い瞳
- ひな鳥(まだ羽が生え揃っていない雛)でも可。可愛らしい正面向きまたはやや斜め
- 黒い影や輪郭ではなく、明るく柔らかい色調

【人物・絵柄】
- 人物の顔・表情・髪型・マスク・メガネ・服装・ポーズ・背景は元のまま完全に維持 (一切改変禁止)
- 人物の額や顔は絶対に隠さない
- ヒヨコ以外の要素は何も追加しない (帽子、装飾、テキスト、エフェクト等は不要)
- 元画像のテイスト (アニメ調・線・色調) を完全に維持
- 正方形フレーム`;

async function callGemini(base64) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType: 'image/png', data: base64 } }
      ]
    }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.85 }
  };
  const resp = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error('Gemini ' + resp.status + ' ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline?.data) return inline.data;
  }
  throw new Error('画像生成失敗');
}

(async () => {
  const base64 = fs.readFileSync(BASE).toString('base64');
  console.log('ベース画像:', BASE, fs.statSync(BASE).size, 'bytes');
  const stamp = Date.now();
  for (let i = 0; i < 3; i++) {
    try {
      console.log(`生成 ${i + 1}/3 ...`);
      const data = await callGemini(base64);
      const outPath = path.join(OUT_DIR, `sugai_chick1_v2_${stamp + i}.png`);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log('  →', outPath, fs.statSync(outPath).size, 'bytes');
    } catch (e) {
      console.error('  fail:', e.message);
    }
  }
})();
