// 須貝栄二さん: 現アバター (eitarostyle) の顔を維持しつつ、金子さんの漫画タッチに変換 + 頭のヒヨコ維持
// 実行: GEMINI_API_KEY=... node scripts/regen_sugai_kaneko_touch.js
const fs = require('fs');
const path = require('path');

const TOUCH_REF = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/kaneko_touch_ref.png'); // 金子さんの漫画タッチ
const FACE_REF  = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/sugai_face_ref.png');   // 須貝の現アバター (顔+ヒヨコ)
const OUT_DIR   = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `添付の **2枚の参照画像** から須貝栄二さんのアバターを生成してください。

【参照画像1 (1枚目: 金子さんの漫画タッチアバター) — ここから採用するもの】
- **絵柄・タッチを完全コピー**: セルシェード/漫画とセミリアルのハイブリッド
- 顔の立体感はリアル、ハイライト・影は2〜3階調に簡略化したアニメ風セルシェーディング
- 髪の毛は1本1本ではなく束で描かれた漫画的な流れ、光沢ハイライトあり
- 線画は柔らかい黒〜茶のアウトライン (太すぎず細すぎず)
- 全体に軽快な漫画イラスト感
- 背景: 無地の明るいクリーム/淡いベージュ
- 肌のトーン: 健康的でやや日焼け気味の暖色
- **金子さんの絵柄と同レベルの漫画タッチを必ず再現** (3Dレンダー寄りの写真風に戻さない)

【参照画像2 (2枚目: 須貝さんの現アバター) — ここから採用するもの】
- **顔・髪型・服装・構図・ヒヨコ** はこの2枚目をそのまま再現
- 顔の構造 (目、鼻、口角、輪郭、頬の張り、眉) は2枚目に忠実
- ごま塩の短髪、黒縁の四角いメガネ
- ダークネイビーのジャケット (中にチェックシャツ見え)
- 頭頂部に黄色いヒヨコ1羽 (2枚目通り) — 形状・配置はそのまま、ただし**漫画タッチで再描画**
- 表情: 穏やかで誠実な微笑み (歯見せず)

【最重要】
- **顔は2枚目の須貝さんを維持**、**絵柄は1枚目の金子さんの漫画タッチに変換**
- 2枚目の3Dレンダー風から1枚目のセルシェード/漫画ハイブリッドへタッチ転換
- ヒヨコは消さない、ただし漫画タッチで描く (黄色いふわふわ、オレンジの嘴と足、つぶらな黒い瞳)

【構図】
- 正方形フレーム、バストアップ (頭頂から胸の上端まで)
- ヒヨコの全身がフレーム内に収まる (上で切れない、上部余白あり)
- 視線は正面

【絶対に避ける】
- 3Dレンダー写真風に仕上がる (必ず漫画タッチ)
- ヒヨコを消す
- メガネを描き忘れる
- 別人になる
- 暗い背景`;

async function callGemini(img1Base64, img1Mime, img2Base64, img2Mime) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { text: '参照画像1 (金子さんの漫画タッチ — 絵柄をこれに合わせる):' },
        { inlineData: { mimeType: img1Mime, data: img1Base64 } },
        { text: '参照画像2 (須貝さんの現アバター — 顔・ヒヨコ・構図はこれを維持):' },
        { inlineData: { mimeType: img2Mime, data: img2Base64 } }
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
    if (inline?.data) return inline.data;
  }
  throw new Error('画像生成失敗');
}

(async () => {
  const img1 = fs.readFileSync(TOUCH_REF).toString('base64');
  const img2 = fs.readFileSync(FACE_REF).toString('base64');
  console.log('タッチ参照:', TOUCH_REF);
  console.log('顔/構図参照:', FACE_REF);
  const stamp = Date.now();
  for (let i = 0; i < 4; i++) {
    try {
      console.log(`生成 ${i + 1}/4 ...`);
      const data = await callGemini(img1, 'image/png', img2, 'image/png');
      const outPath = path.join(OUT_DIR, `sugai_kanekotouch_${stamp + i}.png`);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log('  →', outPath, fs.statSync(outPath).size, 'bytes');
    } catch (e) {
      console.error('  fail:', e.message);
    }
  }
})();
