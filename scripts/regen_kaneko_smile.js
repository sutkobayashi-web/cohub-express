// 金子力さんの新アバター: 遺影感を払拭、満面の笑みの明るいセミリアル肖像
// 実行: GEMINI_API_KEY=... node scripts/regen_kaneko_smile.js
const fs = require('fs');
const path = require('path');

const USER_ID = '0717f9c9-472d-4f5f-831d-3c54ce019327';
const SRC_PHOTO = path.resolve('C:/Users/sutko/Desktop/kenko/kaneko_face.jpg');
const OUT_DIR = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `添付の写真の人物 (金子　力 さん、日本人男性、60代後半〜70代) を、明るく親しみやすい**セミリアル/3Dレンダー (ピクサー風) の高品質バストアップ肖像アバター**に変換してください。

【最重要 — 本人の顔のイメージを崩さない】
- 添付写真の本人の**顔の構造(目の間隔、鼻の形と高さ、口角の幅、輪郭、耳の位置、眉の形)を忠実にトレース**すること
- 別人にしない。写真を見れば本人と一目で分かるレベルで似せる
- 顔つきの個性 (頬のふっくら感、額の形、目尻の柔らかさ) を保つこと

【写真から忠実に拾うべき特徴】
- メガネは掛けていません（メガネを描かないこと）
- 髪型: 黒髪に白髪が多く混じったごま塩、短く整えた横分け、額がやや出ている
- 表情: **満面の笑み、歯がしっかり見える、目尻に深い笑い皺ができる自然で温かい笑顔**。無表情・硬い表情は絶対に禁止。写真と同じレベルの大きな笑顔を必ず再現
- 顔立ち: 頬がふっくらして柔らかい印象、丸めの輪郭、たくましい肩幅
- 服装: 白い襟付きシャツ (写真と同じ)
- ストラップや社員証、ボトル、ペン、ノートパソコンなどは描かない

【絵柄】
- セミリアル/3Dレンダー (ピクサー風) のクオリティ
- 暖色の柔らかい光、明るく親しみやすい色調、肌の質感はリアルだが暖かい
- 正方形フレーム、人物は中央、頭頂から胸の上端までが入る構図
- 視線は正面、視聴者と目が合う
- 背景は無地の明るい白〜淡いベージュ、人物の輪郭にうっすら暖色のグロー
- 影は柔らかく、コントラストは強すぎない (硬い肖像写真にしない)

【絶対に避けること】
- 無表情・口を閉じた真顔・硬い表情 (遺影風の印象になるため)
- モノクロやセピア調
- 暗い背景
- 黒い喪服や黒スーツ

写真と同じくらいの **満面の笑み** を必ず再現してください。`;

async function callGemini(base64) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType: 'image/jpeg', data: base64 } }
      ]
    }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 1.0 }
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
  const base64 = fs.readFileSync(SRC_PHOTO).toString('base64');
  console.log('参照写真:', SRC_PHOTO, fs.statSync(SRC_PHOTO).size, 'bytes');
  const stamp = Date.now();
  for (let i = 0; i < 4; i++) {
    try {
      console.log(`生成 ${i + 1}/4 ...`);
      const data = await callGemini(base64);
      const outPath = path.join(OUT_DIR, `kaneko_smile_${stamp + i}.png`);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log('  →', outPath, fs.statSync(outPath).size, 'bytes');
    } catch (e) {
      console.error('  fail:', e.message);
    }
  }
})();
