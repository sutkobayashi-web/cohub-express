// 須貝栄二さん: 安全太郎 (bot_safety) の絵柄・顔の作りを参考に、メガネ＋頭にヒヨコ1羽 を加えたアバター
// 実行: GEMINI_API_KEY=... node scripts/regen_sugai_safetystyle.js
const fs = require('fs');
const path = require('path');

const STYLE_REF = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/bot_safety.png');         // 絵柄&顔の作り
const FACE_REF  = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/sugai_crop_face.jpg');     // 須貝本人の顔特徴
const OUT_DIR   = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `添付の **2枚の参照画像** から須貝栄二さんのアバターを生成してください。

【参照画像1 (1枚目: 安全太郎 / 食事投稿のbotアバター) — ここから採用するもの】
- **絵柄・タッチ**: セミリアル/3Dレンダー風、肌の質感はリアル、しっかりした立体感
- **構図と全体の質感**: バストアップ、無地の明るい白〜淡いベージュ背景、暖色の柔らかい光
- **服装の方向性**: ダークネイビーのジャケット/スーツ + 白のインナー (1枚目は赤ネクタイだが、須貝さんはネクタイなしで開襟シャツ + ジャケット)
- **顔の作りの基準**: 60代後半の日本人男性らしい落ち着いた表情の作り方

【参照画像2 (2枚目: 須貝栄二さん本人の実写顔) — ここから採用するもの】
- **顔の構造**: 目の形と間隔、鼻の高さと形、口角の幅、輪郭、頬の張り具合、眉の形を**2枚目の実写に忠実にトレース**
- 1枚目とは別人なので、顔は必ず2枚目の本人に似せる
- **髪型**: 2枚目の実写通り、ごま塩の短髪、生え際がやや後退、こめかみと頭頂が薄め
- **メガネ**: 2枚目の通り**黒縁の四角いフレームを必ず描く** (1枚目にはメガネがないが須貝さんはメガネあり)

【追加要素 — 頭の上のヒヨコ】
- 黄色いふわふわのヒヨコを**ちょうど1羽だけ**、頭頂部の中央にちょこんと乗せる
- ヒヨコのサイズは人物の頭の幅の約3分の1〜2分の1
- **ヒヨコの全身(頭頂から足先まで)が画面フレーム内に完全に収まる**こと
- ヒヨコの頭頂と画面フレーム上端の間に十分な余白 (ヒヨコ本体高さの半分以上)
- 丸くてふわふわ、鮮やかな黄色、オレンジの嘴と足、つぶらな黒い瞳、正面向きで可愛らしい
- ヒヨコは必ず1羽 (2羽以上は禁止)

【表情・構図】
- 表情: 穏やかで誠実な微笑み、口角がわずかに上がる程度 (歯は見せない)
- 正方形フレーム、人物中央、頭頂から胸の上端までのバストアップ
- 視線は正面、視聴者と目が合う

【絶対に避ける】
- 別人になる (顔は2枚目の須貝さん本人の特徴を保つ)
- メガネを描き忘れる
- ヒヨコが2羽以上 / フレーム上端で切れる
- 暗い背景、モノクロ`;

async function callGemini(img1Base64, img1Mime, img2Base64, img2Mime) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { text: '参照画像1 (安全太郎: 絵柄・タッチ・構図の参照):' },
        { inlineData: { mimeType: img1Mime, data: img1Base64 } },
        { text: '参照画像2 (須貝栄二さん本人: 顔・髪・メガネの参照):' },
        { inlineData: { mimeType: img2Mime, data: img2Base64 } }
      ]
    }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.95 }
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
  const img1 = fs.readFileSync(STYLE_REF).toString('base64');
  const img2 = fs.readFileSync(FACE_REF).toString('base64');
  console.log('絵柄参照:', STYLE_REF);
  console.log('顔参照:', FACE_REF);
  const stamp = Date.now();
  for (let i = 0; i < 4; i++) {
    try {
      console.log(`生成 ${i + 1}/4 ...`);
      const data = await callGemini(img1, 'image/png', img2, 'image/jpeg');
      const outPath = path.join(OUT_DIR, `sugai_safetystyle_${stamp + i}.png`);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log('  →', outPath, fs.statSync(outPath).size, 'bytes');
    } catch (e) {
      console.error('  fail:', e.message);
    }
  }
})();
