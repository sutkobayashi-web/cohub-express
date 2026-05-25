// 会議室の円卓背景画像を Gemini で生成
// usage: node server/scripts/gen_meeting_table.js
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const OUT = '/opt/cohub/public/assets/meeting_table.png';

const PROMPT = `現代的な企業の**役員会議室を真上からほぼ俯瞰**で撮影した画像を生成してください。

【構図・カメラ】
- **ほぼ真上から見下ろした俯瞰視点 (top-down, わずかに5度傾けた程度)**
- **必ず 16:9 横長 (1344×768 相当)**
- 部屋の中央に**大きな円形の会議テーブル(直径2.5m相当)**が画面いっぱいに配置される
- テーブルの周囲に**何も置かない (椅子も描かない、人も描かない)**
- テーブルの周囲は床のみが見える(余白として活用)

【テーブル】
- 高級感のある**ダークウォールナットの円卓**(木目あり、艶やかな仕上げ)
- テーブル中央に**小さな観葉植物(モンステラの鉢)とコーヒーカップ2-3個**を控えめに配置
- ノートPC・書類・スマホは置かない (アバターと重ならないよう中央付近のみに小物)

【床・壁(画面端)】
- 床はライトグレーの絨毯または木目フローリング
- 画面の四隅には壁の一部や窓枠が映り込んでも良いが、控えめに
- 天井のダウンライトの光がテーブルに反射

【トーン・雰囲気】
- 落ち着いた経営会議の雰囲気、温かみのある照明
- リアル写真調 (CGっぽさを避ける、商業オフィス雑誌のような実写感)
- ダークブラウン・ベージュ・グリーンの落ち着いた色調

【重要】
- **椅子も人もアバターも描かない** (テーブル周囲は床のみ。後でアバターを上から重ねる)
- 文字・看板・ロゴは入れない
- テーブルの境界線がくっきり見えるよう、テーブルと床のコントラスト確保`;

async function geminiImage(prompt, label) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.85 },
  };
  console.log(`[${label}] Gemini に生成リクエスト送信中…`);
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('API ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('応答にcontent.partsなし');
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) return Buffer.from(inline.data, 'base64');
    if (p.text) console.log(`[${label} text]`, p.text.slice(0, 200));
  }
  throw new Error('画像が返ってきませんでした');
}

(async () => {
  try {
    if (fs.existsSync(OUT)) fs.copyFileSync(OUT, OUT + '.bak.' + Date.now());
    const tmp = OUT + '.raw';
    fs.writeFileSync(tmp, await geminiImage(PROMPT, 'meeting_table'));
    execSync(`ffmpeg -y -i ${tmp} -vf "crop=in_w:in_w*9/16:0:(in_h-in_w*9/16)/2,scale=1344:768" -update 1 -frames:v 1 ${OUT}`, { stdio: 'inherit' });
    fs.unlinkSync(tmp);
    console.log('✅ 円卓画像:', OUT);
  } catch (e) {
    console.error('生成失敗:', e.message);
    process.exit(2);
  }
})();
