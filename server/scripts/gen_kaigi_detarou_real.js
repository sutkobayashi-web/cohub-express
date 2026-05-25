// かいぎ出太郎キャラ生成 v2 (リアル路線・金子力さん本人写真ベース)
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const path = require('path');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const REF = '/tmp/chikara_ref.png';
const OUT_FULL = '/opt/cohub/public/assets/kaigi_detarou_full.png';
const OUT_ICON = '/opt/cohub/public/assets/kaigi_detarou_icon.png';

const PROMPT_FULL = `**重要任務: 添付の参考写真の人物を、写真にそっくりそのままの顔で 3D フォトリアル全身像にしてください。**

【絶対遵守事項】
これは「キャラ化」ではなく「写真の人物を 3D 化」する仕事です。デフォルメ・若返り・美化・笑顔追加は **すべて禁止**。
写真の人物の顔・髪・目・口・年齢・肌・骨格を **指紋レベルで忠実に再現** してください。

【写真の人物の特徴 — 完全コピーすること】
- 60代後半〜70代の日本人男性
- **白髪が大半を占めたグレーヘア**、サイドは黒みが残る、**やや薄くなった頭頂部、後ろに撫で付けた髪型**
- **しっかりとした面長気味の顔**、頬には年齢相応の落ち着き(やや下がった頬肉)
- **目: 二重、目尻が大きく下がる、目の下に薄い隈/たるみ**、まなざしは落ち着いて少し疲れたような穏やかさ
- **眉: やや太め、黒**
- 口: **閉じている、口角は水平〜やや下がり気味、微笑みは無し**
- **肌: 年齢相応の質感、目尻と額にうっすら皺、頬の毛穴感**
- **表情: 真顔またはごくわずかな落ち着いた表情。笑顔・歯見せ・キラキラ目・かわいい目は厳禁**

【スタイル】
- **写実的な 3D CG**(映画 VFX のデジタルダブル風、Unreal MetaHuman / 3D scan 風)
- **イラスト調の柔らかさは抑え、肌の質感や陰影は写真ベース**
- 全身が縦長フレームに収まる構図
- 自然なライティング、ニュートラルな光

【衣装・小物】
- 白のビジネスシャツ(襟付き)
- 紺またはグレーのスラックス
- **青いストラップの社員証**を首から下げる
- **ガベル(木槌)は持たせない** — 持っていたら失敗

【右手のポーズ — 重要】
- **右手を軽く前方〜胸の前に上げ、親指を立てた "サムズアップ(GOOD/ナイス)" のポーズ**
- 拳を握り親指だけピンと立てる、いわゆる👍ジェスチャー
- 「ナイスですね!」「OK!」と承認・励ます仕草

【左手のポーズ — 重要】
- **左手にクリップボードを持ち、紙面がカメラに向くよう体の前で軽く掲げて「見てください」と紹介する仕草**
- 紙面に ○ △ × の記号がはっきり見える角度
- 「これが出席表です」と紹介・プレゼンする姿勢

【背景】
- **完全に白色 #FFFFFF の無地**
- 真下に薄い影のみ

【NG リスト — 出力にこれらが含まれたら失敗】
× 子供っぽい・若返らせた顔
× 大きな笑顔、歯見せ、キラキラした目
× 漫画/アニメ調の誇張(目を大きくする・頬を赤くする等)
× 別人の顔
× オールバックを「ふわっとした髪」に変える

参考写真の人物の **そのままの顔** を 3D 化した全身像を出してください。`;

const PROMPT_ICON = `**重要任務: 添付の参考写真の人物を、写真にそっくりそのままの顔で 3D フォトリアルなバストアップにしてください。**

【絶対遵守事項】
これは「キャラ化」ではなく「写真の人物を 3D 化」する仕事です。デフォルメ・若返り・美化・笑顔追加は **すべて禁止**。
写真の顔を **指紋レベルで忠実に再現** してください。

【写真の人物の特徴 — 完全コピー】
- 60代後半〜70代の日本人男性
- **白髪が大半のグレーヘア、サイドに黒みが残る、やや薄くなった頭頂部、後ろに撫で付け**
- **面長気味の顔、年齢相応の頬の落ち着き**
- **目: 二重、目尻が下がる、目の下に隈/たるみ**、穏やかで少し疲れた落ち着いた眼差し
- 口: **閉じている、口角は水平、微笑みなし**
- **肌: 年齢相応、目尻と額に皺、頬の質感**
- **表情: 真顔か、ごくわずかな落ち着き。笑顔・歯見せ・キラキラ目は厳禁**

【スタイル】
- **写実的な 3D CG**(映画 VFX のデジタルダブル風、Unreal MetaHuman 風)
- イラスト調の柔らかさ抑制、肌の質感を写真ベースに

【ポーズ — 重要】
- **右手を軽く胸の前に上げ、親指を立てた "サムズアップ(GOOD/ナイス)" のポーズ**
- 拳を握り親指だけピンと立てる、👍ジェスチャー
- 親指がはっきり画面に映る角度で
- 表情は真顔〜口を閉じた微笑み (歯見せ NG)

【衣装】
- 白のビジネスシャツ
- **青いストラップの社員証**

【背景】
- **完全に白色 #FFFFFF の無地**

【NG — これらが入ったら失敗】
× 若返り・子供っぽい顔
× 大きな笑顔、歯見せ、キラキラ目
× アニメ/漫画調の誇張
× 別人の顔

写真の人物の **そのままの顔** を 3D 化してください。`;

async function geminiImage(prompt, refPath, label) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const parts = [{ text: prompt }];
  if (refPath && fs.existsSync(refPath)) {
    const refData = fs.readFileSync(refPath).toString('base64');
    const mime = refPath.endsWith('.jpg') || refPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    parts.push({ inlineData: { mimeType: mime, data: refData } });
    console.log(`[${label}] 参考画像: ${path.basename(refPath)} (${(refData.length / 1024).toFixed(0)}KB)`);
  }
  const body = { contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.2 } };
  console.log(`[${label}] Gemini 生成中...`);
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('API ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const partsR = data.candidates?.[0]?.content?.parts;
  if (!partsR) throw new Error('応答にpartsなし');
  for (const p of partsR) {
    const inline = p.inlineData || p.inline_data;
    if (inline?.data) return Buffer.from(inline.data, 'base64');
    if (p.text) console.log(`[${label} text]`, p.text.slice(0, 200));
  }
  throw new Error('画像なし');
}

(async () => {
  try {
    if (fs.existsSync(OUT_FULL)) fs.copyFileSync(OUT_FULL, OUT_FULL + '.bak.' + Date.now());
    fs.writeFileSync(OUT_FULL, await geminiImage(PROMPT_FULL, REF, 'full'));
    console.log('✅ 全身:', OUT_FULL);
  } catch (e) { console.error('全身失敗:', e.message); }
  try {
    if (fs.existsSync(OUT_ICON)) fs.copyFileSync(OUT_ICON, OUT_ICON + '.bak.' + Date.now());
    fs.writeFileSync(OUT_ICON, await geminiImage(PROMPT_ICON, REF, 'icon'));
    console.log('✅ アイコン:', OUT_ICON);
  } catch (e) { console.error('アイコン失敗:', e.message); }
})().catch(e => { console.error(e); process.exit(2); });
