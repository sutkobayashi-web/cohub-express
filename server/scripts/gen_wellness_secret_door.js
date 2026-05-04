// 健康管理室の一人称視点画像を「推進カフェへの隠し扉」付きで再生成
// usage: node server/scripts/gen_wellness_secret_door.js
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const { execSync } = require('child_process');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const ROOM_OUT = '/opt/cohub/public/assets/floor_wellness_room.png';

const ROOM_PROMPT = `現代的な企業内の**健康管理室・産業保健ラウンジ**の**一人称視点**画像を生成してください。
**最重要**: 部屋の右側に「推進カフェへの隠し扉」を配置し、扉までの動線を開けておくこと (**デスク等の家具で扉を遮らない**)。

【視点・構図】
- 部屋に入って中央を見る人間の目線 (身長170cm)
- **必ず 16:9 横長アスペクト比** (1344×768 px)
- 部屋の中央〜右側は **広く開けたフロア空間** (家具なし、扉まで歩ける動線)
- 床はライトグレーの大判タイル、天井は白くダウンライト点在
- 壁は**淡い緑 (セージグリーン) + オフホワイト**のツートン

【家具配置 (左側のみ、右半分は完全に開ける)】
- **左側のみ** (横方向 0%〜35%) に待合エリア:
  - クリーム色のラウンジソファ 1脚 (画面左端・横向き)
  - 小さな丸サイドテーブル 1台
  - 大きな観葉植物 (モンステラ等) 1株
- **デスクや受付カウンターは描かない** (相談はソファで会話する想定)
- 左奥の壁に小さな「Wellness」のサインのみ (控えめ)

【★ 隠し扉 (画面右側、最重要要素)】
- **画面の右側 (横方向 75%〜95%、縦方向 25%〜90%) に木製の単扉**
- ドアのデザイン: **ダークウォルナットの木製扉**、銅色アンティークノブ、扉上に黄銅プレート
- 扉の上に **「☕ Staff Lounge」の真鍮プレート看板** (英字のみ、Garamond風)
- 扉の左脇 (扉と中央の間) に **マクラメ吊り植木鉢** を1つ
- 扉の周囲は壁紙と微妙に色味が違い 「秘密の隠し扉」感
- 扉が半開きで **奥にカフェの暖色照明** がチラっと漏れる演出
- 扉の大きさは画面全高の 60-70% (人が通れる十分なサイズ)
- **扉までの床は何も置かず開けておくこと** (ソファ等で隠さない)

【トーン・雰囲気】
- 左半分 = 清潔感のあるラウンジ (グリーン+ホワイト)
- 右半分 = 静かな扉までの開けた動線 + 暖色を漏らす扉の対比
- 朝の柔らかい光が左奥の窓から差し込む
- リアル写真調 (CG・イラスト風ではなく、実写風レンダリング)

【重要・厳守】
- **人物は一切描かない** (後で別レイヤーでアバター重ねる)
- **デスク・受付カウンター・PC・大型棚は描かない** (扉の動線を遮るため)
- 文字・看板は「Wellness」と扉上「Staff Lounge」のみ
- 扉が一目で見え、かつ歩いて辿り着ける動線が確保された構図
- 旧画像 (扉前にデスク有り) と差し替わるので、明確に違う「開放型ラウンジ+扉」レイアウトで生成すること`;

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
