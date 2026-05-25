// かいぎ出太郎 v2: リーゼント + 艶あり仕上げ
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const path = require('path');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const REF = '/opt/cohub/uploads/avatars/0717f9c9-472d-4f5f-831d-3c54ce019327_cand_bright_1778536175151.png';
const OUT_FULL = '/opt/cohub/public/assets/kaigi_detarou_full.png';
const OUT_ICON = '/opt/cohub/public/assets/kaigi_detarou_icon.png';

const COMMON_RIDE = `
【髪型・最重要 - パンチパーマ (薄め・密着型)】
- **パンチパーマ**: 細かい小さな丸いカールが頭全体に密着するヘアスタイル
- カールは **粒状の小さな丸**、一粒3-5mm程度の極小サイズ
- **髪は頭蓋骨の輪郭にぴったり貼り付く**、外側にハミ出さない (アフロ・ふくらまない)
- トップから側頭部までの厚みは **5mm程度の極薄**、地肌の凹凸が分かるくらい
- **頭の形をなぞるシルエット**、頭部の幅は元の参考画像と同じ (顔の幅より広がらない)
- **生え際は後退気味**、額が広めに見えるくらい
- 髪色: **黒ベース**にシルバーグレーが点々と混じる (白髪交じり)
- ポマードでテカテカに光らせる、ハイライト強め
- 昭和の親方・スナックのマスター・気の良い世話焼きおじさん風

【絶対NG】
- アフロのように膨らんだ髪型は不要
- 頭の輪郭からハミ出る髪はゼロ
- ボリュームを出さない

【顔の特徴は保持】
- 参考画像の **顔の輪郭・目元・笑顔のシワ** はそのまま残す
- 60代日本人男性の貫禄ある優しい表情`;

const PROMPT_FULL = `添付の参考画像 (60代日本人男性、温かい笑顔) を **2頭身のかわいいチビキャラ** にデフォルメしてください。

${COMMON_RIDE}

【キャラ設定】
- 名前: **かいぎ出太郎** (会議の名物議長)
- 性格: 「ワシが取り仕切るで」風の優しい番長キャラ。リーゼントで艶々
- 表情: 自信に満ちた笑顔

【スタイル】
- 2頭身デフォルメ (頭が大きく丸い)
- 全身が映る縦長構図
- かわいいデジタルイラスト調 (Pixar/サンリオ系)
- 線は黒くクッキリ、塗りは柔らかいグラデーション

【衣装・小物】
- 白いビジネスシャツ + ネイビーのスラックス
- 青いストラップの社員証を首から下げる
- 右手に**小さな木製ガベル(議事用の木槌)**を軽く掲げる
- 左手に **クリップボード**を抱える (紙面に ○ △ × の記号)

【背景】
- 完全に白色 (#FFFFFF) の無地、装飾なし
- キャラ以外の物体は描かない (透過処理用)

【絶対禁止】
- **画像内に文字 (日本語・英語・記号・吹き出し・ラベル・名前) を一切描かない**
- 紙のクリップボードも記号は無し (白紙)
- 社員証も白紙、ロゴや文字なし
- キャプション・タイトル・サインなど全て不要
- 文字を入れると不採用です

参考画像の顔を残しつつ、リーゼントの艶を最大限に強調してください。`;

const PROMPT_ICON = `添付の参考画像 (60代日本人男性、温かい笑顔) を **2頭身のかわいいチビキャラ** のバストアップにしてください。

${COMMON_RIDE}

【キャラ設定】
- 名前: **かいぎ出太郎**
- ポーズ: 正面向きバストアップ、片手で軽く挙手 「はい、ご質問は?」

【スタイル】
- 2頭身デフォルメ、頭が大きく丸い
- 正方形構図 (1:1)
- かわいいデジタルイラスト調

【衣装】
- 白いビジネスシャツ + 青いストラップの社員証 (首元にチラ見え)
- 胸ポケットに小さな ○△× ピンバッジ

【背景】
- 完全に白色 (#FFFFFF) の無地
- 装飾なし、後で透過処理する前提

【絶対禁止】
- **画像内に文字 (日本語・英語・記号・吹き出し・ラベル・名前) を一切描かない**
- 社員証カード面は白紙、ロゴ・文字なし
- 胸ポケットのピンバッジも単色のシンプルな丸 (○△× の刻印不要、形は出さない)
- キャプション・名前表示・サインなど全て不要
- 文字を入れると不採用です

リーゼントの艶を強調しつつ、笑顔は愛らしくキープしてください。`;

async function geminiImage(prompt, refPath, label) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const parts = [{ text: prompt }];
  if (refPath && fs.existsSync(refPath)) {
    const refData = fs.readFileSync(refPath).toString('base64');
    const mime = refPath.endsWith('.jpg') || refPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    parts.push({ inlineData: { mimeType: mime, data: refData } });
    console.log(`[${label}] 参考画像添付`);
  }
  const body = {
    contents: [{ parts }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.8 },
  };
  console.log(`[${label}] 生成中...`);
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('API ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const partsR = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!partsR) throw new Error('応答にcontent.partsなし');
  for (const p of partsR) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) return Buffer.from(inline.data, 'base64');
    if (p.text) console.log(`[${label} text]`, p.text.slice(0, 200));
  }
  throw new Error('画像が返ってきませんでした');
}

(async () => {
  try {
    fs.copyFileSync(OUT_FULL, OUT_FULL + '.bak.' + Date.now());
    fs.writeFileSync(OUT_FULL, await geminiImage(PROMPT_FULL, REF, 'full'));
    console.log('✅ 全身:', OUT_FULL);
  } catch (e) { console.error('全身失敗:', e.message); }
  try {
    fs.copyFileSync(OUT_ICON, OUT_ICON + '.bak.' + Date.now());
    fs.writeFileSync(OUT_ICON, await geminiImage(PROMPT_ICON, REF, 'icon'));
    console.log('✅ アイコン:', OUT_ICON);
  } catch (e) { console.error('アイコン失敗:', e.message); }
})().catch(e => { console.error(e); process.exit(2); });
