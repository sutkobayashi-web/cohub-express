// 須貝栄二さん: 栄太郎 (eitaro_stuffed) の顔・絵柄を強く参考にしたアバター + 頭にヒヨコ1羽
// 実行: GEMINI_API_KEY=... node scripts/regen_sugai_eitarostyle.js
const fs = require('fs');
const path = require('path');

const STYLE_REF = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/eitaro_stuffed.png');     // 栄太郎フルボディ
const FACE_REF  = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/sugai_crop_face.jpg');     // 須貝本人の顔
const OUT_DIR   = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `添付の **2枚の参照画像** から須貝栄二さんのアバターを生成してください。

【参照画像1 (1枚目: 栄太郎キャラクター) — ここから採用するもの】
- **絵柄・タッチ**: セミリアル/3Dレンダー風、肌の質感はリアル、暖色の柔らかい光、無地の明るい背景
- **顔の作り方の方向性**: 60代後半の日本人男性、ごま塩の短髪、生え際がやや後退、黒縁の四角いメガネ
- **服装の方向性**: ダークネイビーの上着 + 落ち着いた雰囲気
- 1枚目のキャラクターと**ほぼ同じ顔立ち**で構わない (須貝さんはこのキャラとそっくり)

【参照画像2 (2枚目: 須貝栄二さん本人の実写顔) — 顔の同一性チェック用】
- 1枚目をベースにしつつ、目・鼻・口・輪郭が2枚目の実写と一致するよう微調整
- 必ず本人と一目で分かるレベルに

【追加要素 — 頭の上のヒヨコ 1羽】
- 黄色いふわふわのヒヨコを**ちょうど1羽だけ**、頭頂部の中央にちょこんと乗せる
- ヒヨコのサイズは人物の頭の幅の約3分の1〜2分の1
- **ヒヨコの全身(頭頂から足先まで)が画面フレーム内に完全に収まる**こと
- ヒヨコの頭頂と画面フレーム上端の間に十分な余白 (ヒヨコ本体高さの半分以上)
- 丸くてふわふわ、鮮やかな黄色、オレンジの嘴と足、つぶらな黒い瞳、正面向きで可愛らしい
- ヒヨコは必ず1羽 (2羽以上は禁止)

【構図】
- 正方形フレーム、**バストアップ** (頭頂から胸の上端まで)。栄太郎は全身だが、生成は胸まで
- 視線は正面〜やや上、視聴者と目が合う
- 表情: 穏やかで誠実な微笑み、口角がわずかに上がる程度 (歯は見せない)
- 背景は無地の明るい白〜淡いベージュ

【絶対に避ける】
- メガネを描き忘れる (黒縁四角フレーム必須)
- ヒヨコが2羽以上 / フレーム上端で切れる
- 暗い背景、モノクロ
- 全身ショットにする (バストアップにする)`;

async function callGemini(img1Base64, img1Mime, img2Base64, img2Mime) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { text: '参照画像1 (栄太郎: 顔・絵柄・タッチの主参照):' },
        { inlineData: { mimeType: img1Mime, data: img1Base64 } },
        { text: '参照画像2 (須貝栄二さん本人: 顔の同一性確認用):' },
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
  console.log('絵柄/顔主参照:', STYLE_REF);
  console.log('実写参照:', FACE_REF);
  const stamp = Date.now();
  for (let i = 0; i < 4; i++) {
    try {
      console.log(`生成 ${i + 1}/4 ...`);
      const data = await callGemini(img1, 'image/png', img2, 'image/jpeg');
      const outPath = path.join(OUT_DIR, `sugai_eitarostyle_${stamp + i}.png`);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log('  →', outPath, fs.statSync(outPath).size, 'bytes');
    } catch (e) {
      console.error('  fail:', e.message);
    }
  }
})();
