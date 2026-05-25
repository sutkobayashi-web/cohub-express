// 金子力さんの現アバターをベースに、表情だけを「遺影感」から「穏やかな温かい笑顔」へ調整
// 顔のイメージは現アバターから崩さない
// 実行: GEMINI_API_KEY=... node scripts/regen_kaneko_softsmile.js
const fs = require('fs');
const path = require('path');

const BASE = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/kaneko_base.png');
const OUT_DIR = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `添付の画像は金子力さんのアバター(セミリアル/3Dレンダー風)です。**この画像の人物の顔、髪型、服装、構図、絵柄を完全に維持**したまま、**表情と全体の雰囲気だけ**を微調整してください。

【最重要 — 顔のイメージは絶対に崩さない】
- 添付画像の顔の構造 (目の間隔、鼻の形、口の位置、輪郭、頬のふっくら感、額の形、髪の色と分け目、白髪の入り方) を**完全にそのまま**維持
- 別人にしない。元のアバターと一目で同じ人物だと分かるレベルで保つ
- 髪型、ヘアスタイル、白髪の量と位置は同じ
- 服装も同じ (白いポロシャツ、首にかけたストラップなど元の通り) — 変えない

【変える点 — これだけ調整】
- **表情**: 現状は無表情で硬く「遺影」のような印象。これを「穏やかで温かい微笑み」に変える。口角を少し上げ、目尻にうっすら笑い皺。歯は無理に見せない自然な微笑み程度で十分
- **顔の色味**: 健康的な暖色のトーン (頬にうっすら血色)
- **背景と光**: 無地のままだが、明るく暖かい光がほんのり入る (硬い真っ白でなく、淡いベージュ〜クリーム系のあたたかい背景)
- **全体の印象**: 仕事中の温和な経営者・上司として、親しみやすく信頼感のある雰囲気

【絶対に避ける】
- 別人になる
- 顔の構造を変える
- 大笑い・歯を全開にする (やりすぎ)
- 服装や髪型を変える
- モノクロ・セピア調・暗い背景

正方形フレーム、構図 (頭頂から胸の上端まで) も元と同じ。`;

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
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.7 }
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
  console.log('ベースアバター:', BASE, fs.statSync(BASE).size, 'bytes');
  const stamp = Date.now();
  for (let i = 0; i < 4; i++) {
    try {
      console.log(`生成 ${i + 1}/4 ...`);
      const data = await callGemini(base64);
      const outPath = path.join(OUT_DIR, `kaneko_softsmile_${stamp + i}.png`);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log('  →', outPath, fs.statSync(outPath).size, 'bytes');
    } catch (e) {
      console.error('  fail:', e.message);
    }
  }
})();
