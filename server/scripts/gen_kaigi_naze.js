// かいぎ出太郎「なんで?」ポーズ (首かしげ・腕組み・悩み顔) for help.html
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const apiKey = process.env.GEMINI_API_KEY;
const REF = '/tmp/chikara_ref.png';
const OUT = '/opt/cohub/public/assets/kaigi_detarou_naze.png';

const PROMPT = `**重要任務: 添付の参考写真の人物を、写真にそっくりそのままの顔で 3D フォトリアル全身像にしてください。**

【絶対遵守事項】
これは「キャラ化」ではなく「写真の人物を 3D 化」する仕事です。デフォルメ・若返り・美化は禁止。
写真の人物の顔・髪・目・口・年齢を **指紋レベルで忠実に再現** してください。

【写真の人物の特徴 — 完全コピー】
- 60代後半〜70代の日本人男性
- **白髪が大半のグレーヘア、サイドに黒みが残る、やや薄い頭頂部、後ろに撫で付け**
- **やや面長の顔、年齢相応の頬の落ち着き**
- **目: 二重、目尻が下がる、目の下に隈/たるみ**
- 眉: やや太め、黒
- **肌: 年齢相応、目尻と額に皺**

【ポーズ — 重要】
- **首を少しだけ左に傾げる**(かしげる、考える仕草)
- **両腕を胸の前で組む**(腕組み、腕を交差させる)
- 体重を片足にかけ、ややリラックスして考え込む立ち姿
- 顔は正面〜やや斜め

【表情 — 重要】
- **「なんで?」と疑問に思っている顔**
- 眉を少し寄せる、口は閉じてやや真一文字か小さく開く
- 困惑・悩み・不思議そう、でも怒りや不機嫌ではない
- 「むぅ…」と腑に落ちない感じ
- 大きな笑顔・歯見せは禁止

【衣装・小物】
- 白のビジネスシャツ(襟付き)
- 紺またはグレーのスラックス
- **青いストラップの社員証**を首から下げる
- ガベル・クリップボードは持たない

【スタイル】
- **写実的な 3D CG**(映画 VFX のデジタルダブル風、Unreal MetaHuman 風)
- 全身が縦長フレームに収まる構図
- 自然なライティング

【背景】
- **完全に白色 #FFFFFF の無地**
- キャラの真下に薄い影だけ

【NG リスト】
× 笑顔、歯見せ、キラキラ目
× 漫画/アニメ調の誇張
× 若返り
× 別人の顔
× 怒っている表情(困惑・疑問のみ)`;

(async () => {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const refData = fs.readFileSync(REF).toString('base64');
  const body = {
    contents: [{ parts: [{ text: PROMPT }, { inlineData: { mimeType: 'image/png', data: refData } }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.3 },
  };
  console.log('生成中...');
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('API ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline?.data) {
      fs.writeFileSync(OUT, Buffer.from(inline.data, 'base64'));
      console.log('保存:', OUT);
      return;
    }
    if (p.text) console.log('text:', p.text.slice(0, 200));
  }
  throw new Error('画像なし');
})().catch(e => console.error(e.message));
