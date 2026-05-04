// 健康管理室の一人称視点画像を「推進カフェへの隠し扉」付きで再生成
// usage: node server/scripts/gen_wellness_secret_door.js
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const { execSync } = require('child_process');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const ROOM_OUT = '/opt/cohub/public/assets/floor_wellness_room.png';

const ROOM_PROMPT = `現代的な企業内の**健康管理室・産業保健相談室**の**一人称視点**画像を生成してください。
**重要な追加要素**: 部屋の右奥に「推進カフェへの隠し扉」を必ず配置すること。

【視点・構図】
- 部屋に入って机に向かう人間の目線(身長170cm)
- **必ず 16:9 横長アスペクト比** (1344×768 px)
- 中央〜やや左寄りに**白い相談デスク**(腰高、明るい木目縁)、その奥にヘルスアドバイザーが立つスペース
- デスクの背後の壁は**淡い緑(セージグリーン)とオフホワイト**のツートン
- 壁にシンプルな**心電図/聴診器/緑十字のアイコン**または「Wellness」の控えめな文字
- 左側に**待合エリア**(クリーム色のソファ1-2席+小さな丸テーブル+観葉植物)
- 床はライトグレーの大判タイル、天井は白くダウンライトが点在

【★ 隠し扉 (必ず描く、最重要要素)】
- **画面の右側 (横方向 78%〜92%、縦方向 30%〜85%) に小さなドア**を配置
- ドアのデザイン: **ダークウォルナットの木製単扉**、銅色アンティークノブ、扉の上部に黄銅プレート
- 扉の上に小さな**「☕ Staff Lounge」の真鍮プレート看板**(英字のみ、文字は控えめでも可読、フォント Garamond 風)
- 扉の脇に**コーヒー豆の入ったマクラメ植木鉢**を1つ置いて隠れ家ヒント
- 扉の周囲は壁紙と微妙にトーンが違い「秘密の隠し扉」感を出す
- 扉自体は半開きでも閉じてても良いが、**奥にカフェの暖色照明がチラっと漏れる**演出があると良い
- ドア自体の大きさは画面全高の約 50-55% (人が通れるサイズ感)
- 室内とドアの世界観の対比: 健康管理室=明るい医療系、ドアの奥=暖色木目カフェ

【トーン・雰囲気】
- 清潔感・安心感のあるクリニック風
- 朝の柔らかい光が左の窓から差し込む
- リアル写真調 (CG・イラスト風ではなく、実写風レンダリング)
- 落ち着いたグリーン+ホワイト基調

【重要・厳守】
- アドバイザー本人の**顔・人物は描かない** (デスクは無人、ドアの前にも人物配置しない)
- 文字・看板は「Wellness」と扉上の「Staff Lounge」のみ
- デスクの上はスッキリ (PCモニター、観葉植物、書類トレー程度可)
- 旧画像 (隠し扉なし) と置き換わるので、扉が一目で分かる位置・サイズで描くこと`;

async function geminiImage(prompt, label) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.9 },
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
    if (fs.existsSync(ROOM_OUT)) fs.copyFileSync(ROOM_OUT, ROOM_OUT + '.bak.' + Date.now());
    const tmpRoom = ROOM_OUT + '.raw';
    fs.writeFileSync(tmpRoom, await geminiImage(ROOM_PROMPT, 'wellness_room_secret'));
    execSync(`ffmpeg -y -i ${tmpRoom} -vf "crop=in_w:in_w*9/16:0:(in_h-in_w*9/16)/2,scale=1344:768" -update 1 -frames:v 1 ${ROOM_OUT}`, { stdio: 'inherit' });
    fs.unlinkSync(tmpRoom);
    console.log('✅ 健康管理室+隠し扉:', ROOM_OUT);
  } catch (e) {
    console.error('失敗:', e.message);
    process.exit(2);
  }
})();
