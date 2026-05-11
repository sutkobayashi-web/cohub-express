// 金子力さんのアバター再生成 (写真ベース、bright タッチ維持)
// 使い方: node scripts/regen_kaneko_avatar.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const USER_ID = '0717f9c9-472d-4f5f-831d-3c54ce019327';
const DISPLAY_NAME = '金子　力';
const SRC_PHOTO = path.resolve('C:/Users/sutko/Desktop/kenko/kaneko_face.jpg');
const OUT_DIR = path.resolve('C:/Users/sutko/Desktop/kenko/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `以下の写真の人物 (${DISPLAY_NAME} さん、日本人男性、50代後半〜60代) を、明るく親しみやすい日本アニメ調のキャラクターイラストに変換してください。

【写真から忠実に拾うべき特徴 — 必ず反映】
- メガネは掛けていません（メガネを描かないこと）
- 髪型: 黒髪に白髪が混じったごま塩、短くやや横分け、額がやや出ている
- 表情: 満面の笑み、歯が見える、目尻に皺ができるほどの自然な笑顔（無表情・真顔は禁止）
- 顔立ち: 頬がふっくらしていて柔らかい印象、丸めの輪郭、たくましい体格
- 服装: 白い襟付きシャツ、首元から胸にかけて青いストラップ（社員証または老眼鏡を下げているもの）が掛かっている

【絵柄】
- クリアな線、鮮やかで温かみのある色調、優しい笑顔のアニメ調イラスト
- 正方形フレーム、人物は中央、顔と肩から胸までが入る構図
- 背景は白または透明

人物本人だと一目で分かる似顔絵レベルで、ふっくらした頬と歯を見せる笑顔を必ず再現してください。`;

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
  const mimeType = SRC_PHOTO.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  console.log('写真読込:', SRC_PHOTO, buf.length, 'bytes,', mimeType);
  const photoBase64 = buf.toString('base64');

  // 3枚生成して一番良さそうなのを選ぶ用に candidates 出力
  const stamp = Date.now();
  for (let i = 0; i < 3; i++) {
    try {
      console.log(`生成 ${i + 1}/3 ...`);
      const out = await callGemini(photoBase64, mimeType);
      const outPath = path.join(OUT_DIR, `${USER_ID}_cand_bright_${stamp + i}.png`);
      fs.writeFileSync(outPath, Buffer.from(out.data, 'base64'));
      console.log('  →', outPath, fs.statSync(outPath).size, 'bytes');
    } catch (e) {
      console.error('  fail:', e.message);
    }
  }
  console.log('完了');
})();
