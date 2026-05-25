// 須貝栄二さんのアバターを顔クロップ写真ベースで再生成
// 使い方: GEMINI_API_KEY=... node scripts/regen_sugai_from_crop.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const USER_ID = '0da5798c-335e-42f4-8842-c08630453ffd';
const SRC_PHOTO = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/sugai_crop_face.jpg');
const OUT_DIR = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `添付の写真は須貝栄二さん (日本人男性、60代後半〜70代) の顔写真です。この人物の顔の特徴を忠実にトレースしてセミリアル/3Dレンダー風のバストアップ肖像アバターを生成してください。

【写真から忠実に拾うべき特徴 — 必ず反映】
- 髪型: ごま塩の短髪、生え際がやや後退、こめかみと頭頂の髪が薄め
- メガネ: 黒縁の四角いフレーム (必ず描く)
- 顔立ち: やや長めの輪郭、頬骨が見える、口元は引き締まり気味、目尻に微かな笑い皺
- 表情: 穏やかで誠実な微笑み、口角がわずかに上がる程度 (歯は見せない)
- 体格: 細身〜中肉、肩幅は普通
- 服装: 白い襟付きシャツの上にダークネイビーのテーラードジャケット

【絵柄 — 重要】
- セミリアル/3Dレンダー (ピクサー風) の高品質バストアップ肖像
- 肌の質感はリアル、皺やシミ、髪の白髪も自然に再現
- 完全実写ではなく、暖かみのある柔らかい光と色調
- 正方形フレーム、人物は中央、頭頂から胸の上端までが入る構図
- 視線は正面 (添付写真は横向きですが、生成は正面向き)
- 背景は無地の白〜淡いベージュ
- ストラップ、社員証、テキスト、ロゴ、看板は描かない

参照写真の顔の構造 (目の間隔、鼻の形、口の幅、輪郭) を本人だと一目で分かるレベルで忠実に再現してください。`;

async function callGemini(photoBase64, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType, data: photoBase64 } }
      ]
    }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.9 }
  };
  const resp = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error('Gemini ' + resp.status + ' ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline?.data) return { data: inline.data, mime: inline.mimeType || 'image/png' };
  }
  throw new Error('画像生成失敗');
}

(async () => {
  if (!fs.existsSync(SRC_PHOTO)) {
    console.error('写真がありません:', SRC_PHOTO);
    process.exit(1);
  }
  const buf = fs.readFileSync(SRC_PHOTO);
  const mimeType = 'image/jpeg';
  console.log('参照写真読込:', SRC_PHOTO, buf.length, 'bytes');
  const photoBase64 = buf.toString('base64');

  const stamp = Date.now();
  for (let i = 0; i < 4; i++) {
    try {
      console.log(`生成 ${i + 1}/4 ...`);
      const out = await callGemini(photoBase64, mimeType);
      const outPath = path.join(OUT_DIR, `sugai_${USER_ID}_v2_${stamp + i}.png`);
      fs.writeFileSync(outPath, Buffer.from(out.data, 'base64'));
      console.log('  →', outPath, fs.statSync(outPath).size, 'bytes');
    } catch (e) {
      console.error('  fail:', e.message);
    }
  }
  console.log('完了:', OUT_DIR);
})();
