// 金子力さん・須貝栄二さんのアバターを掲示板写真ベースで再生成 (セミリアル/3Dレンダー風)
// 使い方: node scripts/regen_kaneko_sugai_from_board.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const SRC_PHOTO = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/golf2.jpeg');
const OUT_DIR = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const TARGETS = [
  {
    user_id: '0717f9c9-472d-4f5f-831d-3c54ce019327',
    short: 'kaneko',
    display_name: '金子　力',
    position: '画像の右側に座っている人物',
    prompt_features: `【参照写真からの特徴 — 必ず反映】
- 画像の右側 (右端) に椅子に座っている男性
- 60代後半〜70代の日本人男性
- 髪型: 短く整えた白髪が多めのごま塩、額は広め
- 表情: 落ち着いた優しい笑み (歯はほぼ見せない自然な微笑)
- 顔立ち: 頬がふっくらしてやや丸みのある輪郭、たくましい肩幅
- 服装: 白い襟付きポロシャツ、ベージュ系のチノパン (パンツは描いても省略でも可)
- 持ち物: メガネは掛けていない`,
  },
  {
    user_id: '0da5798c-335e-42f4-8842-c08630453ffd',
    short: 'sugai',
    display_name: '須貝　栄二',
    position: '画像の左側に座っている人物',
    prompt_features: `【参照写真からの特徴 — 必ず反映】
- 画像の左側に椅子に座っている男性
- 50代後半〜60代の日本人男性
- 髪型: 黒髪に白髪が少し混じる、短めの自然な分け目
- 表情: 穏やかで誠実な微笑、口角が少し上がる程度
- 顔立ち: 細身〜中肉、シャープな顎ライン
- 服装: 白いシャツの上にダークネイビーのジャケット (テーラードブレザー)
- 持ち物: 黒縁のメガネを掛けている (必ず描く)`,
  },
];

const STYLE_BLOCK = `【絵柄 — 共通】
- セミリアル (3Dレンダー / ピクサー風) の高品質バストアップ肖像
- やや写真寄りだが完全実写ではなく、柔らかい質感と暖かい色調
- 自然光、肌の質感はリアル、皺やシミも自然に再現
- 正方形フレーム、人物は中央、頭頂から胸の上端までが入る構図
- 背景は無地の白〜淡いベージュ (人物のみが主役)
- 浮ついた飾り、エフェクト、テキスト、ロゴ、看板は一切描かない
- ストラップや社員証は描かない

人物本人だと一目で分かる似顔絵レベルで仕上げてください。`;

function buildPrompt(target) {
  return `添付の写真には2名の日本人男性が写っています。今回は **${target.position}** (${target.display_name} さん) のみを抽出して、その人物のセミリアル/3Dレンダー風のバストアップ肖像アバターを生成してください。

${target.prompt_features}

${STYLE_BLOCK}`;
}

async function callGemini(prompt, photoBase64, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
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

  const stamp = Date.now();
  for (const t of TARGETS) {
    console.log(`\n=== ${t.display_name} (${t.short}) ===`);
    const prompt = buildPrompt(t);
    for (let i = 0; i < 3; i++) {
      try {
        console.log(`  生成 ${i + 1}/3 ...`);
        const out = await callGemini(prompt, photoBase64, mimeType);
        const outPath = path.join(OUT_DIR, `${t.short}_${t.user_id}_cand_${stamp + i}.png`);
        fs.writeFileSync(outPath, Buffer.from(out.data, 'base64'));
        console.log('    →', outPath, fs.statSync(outPath).size, 'bytes');
      } catch (e) {
        console.error('    fail:', e.message);
      }
    }
  }
  console.log('\n完了:', OUT_DIR);
})();
