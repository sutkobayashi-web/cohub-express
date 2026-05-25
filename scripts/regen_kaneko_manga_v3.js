// 金子力さん v3: 髪型=旧3D, 顔=実写, 輪郭=本人忠実(ふっくら丸顔), 肌=日焼けゴルフおやじ調, 絵柄=漫画
// 実行: GEMINI_API_KEY=... node scripts/regen_kaneko_manga_v3.js
const fs = require('fs');
const path = require('path');

const HAIR_REF = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/kaneko_base.png');
const FACE_REF = path.resolve('C:/Users/sutko/Desktop/kenko/kaneko_face.jpg');
const OUT_DIR  = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `添付の **2枚の参照画像** から金子力さんのアバターを生成してください。

【参照画像1 (1枚目, 3Dレンダー風アバター) — ここから採用するもの】
- **髪型のみ**: 短く整えた横分け、生え際の形、白髪と黒髪の分布、額の出方を**この1枚目に忠実に**従う

【参照画像2 (2枚目, 実写写真) — ここから採用するもの】
- **顔の構造**: 目の形と間隔、鼻の形、口角の幅、眉の形、耳の位置を**2枚目の実写に忠実にトレース**
- **輪郭**: 2枚目の写真にある**丸みのある四角顔 (頬がしっかりふっくらして、エラがやや張る、顎ラインは丸め)** を必ず再現。前回生成のような細長い・卵型の輪郭にしない
- 顔幅は広め、頬の肉感をしっかり表現
- 表情: 穏やかで温かい微笑み (口角しっかり上がる、目尻に笑い皺、歯わずかに見える程度)

【肌の色味 — 重要】
- **日焼けしたゴルフ好きの経営者風**の肌色: 全体的にやや浅黒い、温かみのあるオークル〜ライトブラウン寄り
- 頬と鼻先にうっすら日焼けのトーン (赤みも少し)
- 真っ白・青白い肌は禁止
- ただし不自然な暗さにはしない、健康的な日焼けトーン

【絵柄 — 漫画タッチ (維持)】
- セルシェード/漫画とセミリアルのハイブリッド
- 顔の立体感はリアルだが、ハイライト・影は2〜3階調に簡略化したアニメ風セルシェーディング
- 髪は束で描かれた漫画的な流れ、光沢ハイライトあり
- 線画は柔らかい黒〜茶のアウトライン

【服装・構図】
- 服装: 白い襟付きシャツのみ。ストラップ・社員証・ペン・パソコンは描かない
- 正方形フレーム、人物中央、頭頂から胸の上端までのバストアップ
- 視線は正面、視聴者と目が合う
- 背景は無地の明るいクリーム/淡いベージュ

【絶対に避ける】
- 細長い・卵型の輪郭 (本人は丸顔寄り)
- 青白い・白すぎる肌
- 別人になる
- 3Dレンダー風の写真寄り仕上げ
- ストラップ描写、暗い背景`;

async function callGemini(img1Base64, img1Mime, img2Base64, img2Mime) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { text: '参照画像1 (3Dレンダー、髪型のみ参照):' },
        { inlineData: { mimeType: img1Mime, data: img1Base64 } },
        { text: '参照画像2 (実写、顔の構造・輪郭・表情の参照):' },
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
  const img1 = fs.readFileSync(HAIR_REF).toString('base64');
  const img2 = fs.readFileSync(FACE_REF).toString('base64');
  console.log('髪型参照:', HAIR_REF);
  console.log('顔参照:', FACE_REF);
  const stamp = Date.now();
  for (let i = 0; i < 4; i++) {
    try {
      console.log(`生成 ${i + 1}/4 ...`);
      const data = await callGemini(img1, 'image/png', img2, 'image/jpeg');
      const outPath = path.join(OUT_DIR, `kaneko_manga_v3_${stamp + i}.png`);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log('  →', outPath, fs.statSync(outPath).size, 'bytes');
    } catch (e) {
      console.error('  fail:', e.message);
    }
  }
})();
