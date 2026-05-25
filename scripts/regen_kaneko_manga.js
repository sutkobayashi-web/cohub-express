// 金子力さん: 実写顔をベースに、漫画タッチを加えた半リアル肖像
// 顔の同一性は崩さず、絵柄を「3Dレンダー風 → セルシェード/漫画ハイブリッド」へ
// 実行: GEMINI_API_KEY=... node scripts/regen_kaneko_manga.js
const fs = require('fs');
const path = require('path');

const SRC_PHOTO = path.resolve('C:/Users/sutko/Desktop/kenko/kaneko_face.jpg');
const OUT_DIR = path.resolve('C:/Users/sutko/AppData/Local/Temp/board_imgs/_avatar_candidates');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `添付の写真の人物 (金子力さん、日本人男性、60代後半〜70代) を、**実写ベースの顔特徴を保ちつつ漫画タッチを加えたハイブリッド肖像アバター**に変換してください。

【最重要 — 顔のイメージを崩さない】
- 添付写真の顔の構造 (目の間隔、鼻の形と高さ、口角の幅、輪郭、頬のふっくら感、額の形、眉の形、耳の位置、白髪の入り方) を**忠実にトレース**
- 別人にしない。写真を見れば本人と一目で分かるレベルで似せる
- 髪型は写真と同じ (ごま塩の短い横分け、白髪が多めに混じる)
- メガネは掛けていない

【絵柄 — 漫画タッチ要素】
- セルシェード/漫画とセミリアルのハイブリッド: 顔の立体感はリアルだが、ハイライト・影は2〜3階調に簡略化したアニメ風セルシェーディング
- 髪の毛は1本1本ではなく、束で描かれた漫画的な流れ (光沢ハイライトあり)
- 目はリアルな配置・形だが、瞳孔と虹彩がやや漫画的にクリアに描かれる
- 線画は柔らかい黒〜茶のアウトライン (太すぎず細すぎず)
- 全体に少し漫画イラスト寄りの軽快さを持たせる (硬い写真風や遺影風を完全に脱する)

【表情・服装】
- 表情: 穏やかで温かい微笑み、口角がしっかり上がる、目尻にうっすら笑い皺。歯を見せすぎない自然な笑み
- 服装: 白い襟付きシャツ (写真と同じ)。ストラップ・社員証・ペン・パソコン・ボトルなどは描かない

【構図・背景】
- 正方形フレーム、人物は中央、頭頂から胸の上端までが入るバストアップ
- 視線は正面、視聴者と目が合う
- 背景は無地の明るいクリーム/淡いベージュ。淡い暖色グラデーション程度はOK
- 暗い背景・モノクロ・セピアは禁止

実写ベースの本人らしさを保ちつつ、軽やかな漫画タッチが入った親しみやすいアバターに仕上げてください。`;

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
  const base64 = fs.readFileSync(SRC_PHOTO).toString('base64');
  console.log('参照写真:', SRC_PHOTO, fs.statSync(SRC_PHOTO).size, 'bytes');
  const stamp = Date.now();
  for (let i = 0; i < 4; i++) {
    try {
      console.log(`生成 ${i + 1}/4 ...`);
      const data = await callGemini(base64);
      const outPath = path.join(OUT_DIR, `kaneko_manga_${stamp + i}.png`);
      fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
      console.log('  →', outPath, fs.statSync(outPath).size, 'bytes');
    } catch (e) {
      console.error('  fail:', e.message);
    }
  }
})();
