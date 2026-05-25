// 須貝栄二さん: 現アバター(eitarostyle)を唯一の入力とし、プロンプトのみで漫画タッチに変換
// 顔は絶対に変えない (金子さんとの混線を避ける)
// 実行: GEMINI_API_KEY=... node scripts/regen_sugai_manga_solo.js
const fs = require('fs');
const path = require('path');

const BASE = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/sugai_face_ref.png'); // = 現アバター eitarostyle
const OUT_DIR = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `添付の画像は須貝栄二さんのアバター(セミリアル/3Dレンダー風)です。**この画像の人物の顔・髪型・服装・メガネ・頭の上のヒヨコ・構図を完全に維持**したまま、**絵柄(タッチ)だけ**をセミリアル → 漫画ハイブリッドに変換してください。

【最重要 — 顔のイメージは絶対に崩さない】
- 添付画像の人物の顔の構造 (目の形と間隔、鼻の形、口角、輪郭、頬の張り、眉、耳、ごま塩の生え際) を**完全にそのまま**維持
- 別人にしない。元のアバターと一目で同じ人物だと分かるレベルで保つ
- 黒縁の四角いメガネは同じ位置・形で必ず描く
- ダークネイビーのジャケットと中のチェックシャツも同じ
- 頭頂部の黄色いヒヨコ1羽も同じ位置・大きさで維持 (ふわふわ、オレンジの嘴と足、黒い瞳)

【変える点 — 絵柄のみ】
- セミリアル/3Dレンダー → **セルシェード/漫画ハイブリッド**へタッチ変換
- 顔の立体感はリアルだが、ハイライト・影は2〜3階調に簡略化したアニメ風セルシェーディング
- 髪の毛は1本1本ではなく束で描かれた漫画的な流れ、光沢ハイライトあり
- 線画は柔らかい黒〜茶のアウトライン (太すぎず細すぎず)
- 軽快な漫画イラスト感を出す
- 背景は無地の明るいクリーム/淡いベージュ (元と同じ方向性)

【絶対に避ける】
- 顔の構造を変える / 別人になる
- メガネを描き忘れる / 形を変える
- ヒヨコを消す / 位置を変える
- 服装を変える
- 写真寄りの3Dレンダー仕上げに戻る (必ず漫画タッチ)

正方形フレーム、構図 (頭頂から胸の上端まで、ヒヨコの上に余白) も元と同じ。`;

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
  console.log('ベースアバター:', BASE);
  const stamp = Date.now();
  for (let i = 0; i < 4; i++) {
    try {
      console.log(`生成 ${i + 1}/4 ...`);
      const data = await callGemini(base64);
      const outPath = path.join(OUT_DIR, `sugai_manga_solo_${stamp + i}.png`);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log('  →', outPath, fs.statSync(outPath).size, 'bytes');
    } catch (e) {
      console.error('  fail:', e.message);
    }
  }
})();
