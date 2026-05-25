// かいぎ出太郎キャラ生成 (金子 力さんのアバターを参考に2頭身チビ議長)
// usage: node server/scripts/gen_kaigi_detarou.js
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const path = require('path');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const REF = '/opt/cohub/uploads/avatars/0717f9c9-472d-4f5f-831d-3c54ce019327_cand_bright_1778536175151.png';
const OUT_FULL = '/opt/cohub/public/assets/kaigi_detarou_full.png';
const OUT_ICON = '/opt/cohub/public/assets/kaigi_detarou_icon.png';

const PROMPT_FULL = `添付の参考画像 (シルバーグレーヘアで温かみのある笑顔の60代日本人男性、襟付き白シャツ+青いストラップの社員証) の **顔の特徴**(髪型・目元・笑顔の輪郭・年齢感)を**忠実に保ちながら**、その人を **2頭身のかわいいチビキャラ**に変換してください。

【キャラ設定】
- 名前: **かいぎ出太郎** (会議の議長キャラ)
- 役職: 会議の名物議長。日程調整の達人
- 表情: 自信に満ちた優しい笑顔、決断力ある眼差し
- 性格: 真面目で頼れる、でも親しみやすい

【スタイル】
- **2頭身デフォルメ** (頭が体と同じくらい大きい、ぽっちゃりかわいい)
- 全身が映る縦長構図
- 高解像度のかわいいデジタルイラスト調 (Pixar/サンリオ系)
- 線は黒く明瞭、塗りは柔らかいグラデーション

【衣装・小物】
- **白いビジネスシャツ**+ ベージュまたはネイビーのスラックス
- **青いストラップの社員証**を首から下げる (参考画像と同じ)
- 右手に**小さな木製ガベル(議事用の木槌)**を持って軽く掲げる
- 左手に **クリップボードと紙の出席表**を抱える
- 紙には ○ △ × の記号が書かれていて、議長らしさを表現

【背景】
- **完全に白色 (#FFFFFF) の無地**にしてください
- グラデーション・装飾・影は最小限 (キャラの真下の薄い影だけOK)
- 後で透過処理する想定なので、キャラ以外の物体は描かない

【重要】
- 参考画像の人物の **髪 (シルバーグレー、短髪)・目の形・笑顔のシワ感** を残してください
- 顔は2頭身デフォルメで丸く愛らしく、ただし参考人物だと分かる程度に
- 全身がフレームに収まる構図`;

const PROMPT_ICON = `添付の参考画像 (シルバーグレーヘアで温かみのある笑顔の60代日本人男性) の **顔の特徴**(髪型・笑顔)を**忠実に保ちながら**、その人を **2頭身のかわいいチビキャラの上半身アップ**にしてください。

【キャラ設定】
- 名前: **かいぎ出太郎** (会議の議長キャラクター)
- 表情: 親しみやすい笑顔、目はキラッと輝く
- ポーズ: 正面向きでバストアップ、片手で軽く挙手して「はい、ご質問は?」と振り向く動き

【スタイル】
- **2頭身デフォルメ** (頭が大きく丸い)
- **正方形構図** (1:1)
- 高解像度のかわいいデジタルイラスト調
- 線は黒く明瞭、塗りは柔らかい

【衣装】
- 白いビジネスシャツ
- **青いストラップの社員証** (首元にチラ見え)
- 胸ポケットに小さな ○△× ピンバッジ

【背景】
- **完全に白色 (#FFFFFF) の無地**
- 装飾なし、後で透過処理する前提

【重要】
- 参考画像のシルバーグレー短髪・優しい笑顔の輪郭を残す
- アイコン用なので顔が中心に大きく入る構図`;

async function geminiImage(prompt, refPath, label) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const parts = [{ text: prompt }];
  if (refPath && fs.existsSync(refPath)) {
    const refData = fs.readFileSync(refPath).toString('base64');
    const mime = refPath.endsWith('.jpg') || refPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    parts.push({ inlineData: { mimeType: mime, data: refData } });
    console.log(`[${label}] 参考画像添付: ${path.basename(refPath)} (${(refData.length / 1024).toFixed(0)}KB)`);
  }
  const body = {
    contents: [{ parts }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.7 },
  };
  console.log(`[${label}] Gemini 生成リクエスト送信中...`);
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('API ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const partsR = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!partsR) throw new Error('応答にcontent.partsなし: ' + JSON.stringify(data).slice(0, 300));
  for (const p of partsR) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) return Buffer.from(inline.data, 'base64');
    if (p.text) console.log(`[${label} text]`, p.text.slice(0, 250));
  }
  throw new Error('画像が返ってきませんでした');
}

(async () => {
  // 1. 全身像
  try {
    if (fs.existsSync(OUT_FULL)) fs.copyFileSync(OUT_FULL, OUT_FULL + '.bak.' + Date.now());
    fs.writeFileSync(OUT_FULL, await geminiImage(PROMPT_FULL, REF, 'full'));
    console.log('✅ 全身:', OUT_FULL);
  } catch (e) {
    console.error('全身失敗:', e.message);
  }
  // 2. アイコン (バストアップ)
  try {
    if (fs.existsSync(OUT_ICON)) fs.copyFileSync(OUT_ICON, OUT_ICON + '.bak.' + Date.now());
    fs.writeFileSync(OUT_ICON, await geminiImage(PROMPT_ICON, REF, 'icon'));
    console.log('✅ アイコン:', OUT_ICON);
  } catch (e) {
    console.error('アイコン失敗:', e.message);
  }
})().catch(e => { console.error(e); process.exit(2); });
