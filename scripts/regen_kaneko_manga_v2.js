// 金子力さん v2: 髪型=旧3Dレンダー (kaneko_base.png), 顔=実写 (kaneko_face.jpg), 絵柄=漫画タッチ
// 実行: GEMINI_API_KEY=... node scripts/regen_kaneko_manga_v2.js
const fs = require('fs');
const path = require('path');

const HAIR_REF = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/kaneko_base.png'); // 元の3Dレンダー (髪型用)
const FACE_REF = path.resolve('C:/Users/sutko/Desktop/kenko/kaneko_face.jpg');                  // 実写 (顔の特徴用)
const OUT_DIR  = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `添付の **2枚の参照画像** から金子力さんのアバターを生成してください。

【参照画像1 (1枚目, 3Dレンダー風アバター) — ここから採用するもの】
- **髪型**: 短く整えた横分け、生え際の形、白髪と黒髪の分布、額の出方を**この1枚目に忠実に**従う
- 髪の流れ・分け目の位置・サイドの刈り上げ感は1枚目と同じ

【参照画像2 (2枚目, 実写写真) — ここから採用するもの】
- **顔の構造**: 目の間隔、目の形、鼻の高さと形、口角の幅、輪郭、頬のふっくら感、眉の形、耳の位置を**この2枚目の実写に忠実にトレース**
- 顔だけは実写の本人の特徴に必ず似せる (別人にしない)
- 表情: 実写の自然な微笑みを参考に、穏やかで温かい笑顔 (口角がしっかり上がる、目尻にうっすら笑い皺、歯はわずかに見える程度)

【絵柄 — 漫画タッチ (これは必ず守る)】
- セルシェード/漫画とセミリアルのハイブリッド
- 顔の立体感はリアルだが、ハイライト・影は2〜3階調に簡略化したアニメ風セルシェーディング
- 髪の毛は1本1本ではなく束で描かれた漫画的な流れ (光沢ハイライトあり)
- 線画は柔らかい黒〜茶のアウトライン (太すぎず細すぎず)
- 全体に軽快な漫画イラスト感

【服装・構図】
- 服装: 白い襟付きシャツのみ。ストラップ・社員証・ペン・パソコンなどは**描かない**
- 正方形フレーム、人物は中央、頭頂から胸の上端までが入るバストアップ
- 視線は正面、視聴者と目が合う
- 背景は無地の明るいクリーム/淡いベージュ

【絶対に避ける】
- 別人になる (顔は2枚目の実写の特徴を保つ)
- 髪型が違う (髪型は1枚目の3Dレンダーを保つ)
- 3Dレンダー風の写真寄り仕上げ (漫画タッチを保つ)
- ストラップ・社員証を描く
- 暗い背景・モノクロ・遺影風`;

async function callGemini(img1Base64, img1Mime, img2Base64, img2Mime) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { text: '参照画像1 (3Dレンダー、髪型の参照):' },
        { inlineData: { mimeType: img1Mime, data: img1Base64 } },
        { text: '参照画像2 (実写、顔の特徴と表情の参照):' },
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
  const img1 = fs.readFileSync(HAIR_REF).toString('base64');
  const img2 = fs.readFileSync(FACE_REF).toString('base64');
  console.log('髪型参照:', HAIR_REF, fs.statSync(HAIR_REF).size, 'bytes');
  console.log('顔参照:', FACE_REF, fs.statSync(FACE_REF).size, 'bytes');
  const stamp = Date.now();
  for (let i = 0; i < 4; i++) {
    try {
      console.log(`生成 ${i + 1}/4 ...`);
      const data = await callGemini(img1, 'image/png', img2, 'image/jpeg');
      const outPath = path.join(OUT_DIR, `kaneko_manga_v2_${stamp + i}.png`);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log('  →', outPath, fs.statSync(outPath).size, 'bytes');
    } catch (e) {
      console.error('  fail:', e.message);
    }
  }
})();
