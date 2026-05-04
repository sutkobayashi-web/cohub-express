// 健康管理室の一人称視点画像を「推進カフェへの隠し扉」付きで再生成
// usage: node server/scripts/gen_wellness_secret_door.js
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const { execSync } = require('child_process');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const ROOM_OUT = '/opt/cohub/public/assets/floor_wellness_room.png';
const ADVISOR_OUT = '/opt/cohub/public/assets/concierge_health_full.png';

const ROOM_PROMPT = `現代的な企業内の**健康管理室 (奥行きのある正方形に近い相談ルーム)** の**一人称視点**画像を生成してください。
**最重要**: 廊下のような細長い空間に見せず、**正面の壁が見える奥行きのある部屋**として描くこと。
正面の壁 (奥) に**ホワイトボード**、左壁にラウンジ、右壁に隠し扉という三方の構成。

【視点・構図】
- 部屋に入って正面を見る人間の目線 (身長170cm)
- **必ず 16:9 横長アスペクト比** (1344×768 px)
- 部屋は**正方形に近い4角形**、奥行き感は適度 (廊下感NG)
- 正面の壁 (奥) が画面の縦方向 30〜70% を占める広い壁面として見える構図
- 左壁は手前から斜めに、右壁は手前から斜めに、両側壁は緩やかなパース

【正面の壁 (奥)】
- **超大型ホワイトボード** を中央〜左寄りに掛ける
  - 横幅は **画面横方向の 60% 以上** (画面横幅の60%、約810px相当)
  - 高さは **画面縦方向の 65% 以上** (画面縦の65%、約500px相当)
  - 木製フレーム+ホワイト面、表面はやや反射控えめ
  - ホワイトボードの**上端は天井近く**、**下端は床近くまで**届く存在感
  - ホワイトボードの上に「Wellness」の控えめなサイン
  - ホワイトボードに**何も書かない**(後でCanvas overlay で動的に上書きするため真っ白)
  - フレーム左右の余白は最小限 (壁の主役)
- 壁の下半分は**淡いセージグリーン**、上半分は**オフホワイト**のツートン

【左壁・手前左 (待合)】
- クリーム色のラウンジソファ 1脚 (画面左端、視点側に少し向ける)
- 小さな丸サイドテーブル 1台
- 大きな観葉植物 (モンステラ等) 1株
- 左奥の壁に小さな窓、朝の光が差し込む

【★ 右壁の隠し扉 (推進サロン入口)】
- **画面右側 (横方向 78%〜95%、縦方向 25%〜85%) に木製の単扉**
- **ダークウォルナット**の木製扉、銅色アンティークノブ
- 扉上に **「☕ Staff Lounge」の真鍮プレート看板** (英字、Garamond 風)
- 扉の左脇 (扉と中央の間) に**マクラメ吊り植木鉢** 1つ
- 扉が**少し半開き**で、中からカフェの**暖色オレンジ照明**がチラっと漏れる演出
- 扉と部屋の壁の境界に微妙な木目の段差で「隠し感」
- 扉の大きさは画面全高の 60〜70%

【床・天井】
- 床はライトグレーの大判タイル
- 天井は白でダウンライトが点在 (一様で柔らかい光)

【トーン・雰囲気】
- 清潔感のある産業保健ラウンジ
- 左半分 = グリーン+ホワイト+朝光
- 右半分 = 隠し扉の暖色対比
- リアル写真調 (CG・イラスト風NG)

【重要・厳守】
- **人物は一切描かない**
- **デスク・受付カウンター・PC・大型棚は描かない**
- **廊下のような細長い空間にしない** (正方形に近い部屋として描く)
- 正面の壁にホワイトボードが見える構図 (奥行き感が伝わる)
- 文字は「Wellness」と扉上「Staff Lounge」のみ`;

// 5/4 (再): ヘルスアドバイザー — 若返り+ショート+グラマラス、全身を必ず入れる
const ADVISOR_PROMPT = `**産業保健の AI ヘルスアドバイザー**の**若い女性**キャラクター**全身**立ち姿を生成してください。
**最重要**: 必ず**頭のてっぺんから靴のつま先まで全身を1枚に収める縦長構図**。胸像/上半身切れの構図は絶対NG。

【キャラクター】
- **20代後半**の親しみやすい印象の女性 (アジア系)
- **ショートカット** (耳が見える短めのボブ〜ベリーショート、サイドはすっきり、襟足はタイト)
- 髪色は自然な黒〜ダークブラウン
- 表情: 明るく爽やか、信頼できる優しい笑顔 (口角少し上)
- **体型: 健康的でグラマラス** — メリハリのあるバスト/ウエスト/ヒップのライン、痩せすぎず女性らしい曲線美
- **淡い水色のスクラブ (医療用ユニフォーム)** 上下:
  - 上はやや体のラインに沿った Vネック または スクープネックでウエストの絞りが分かる
  - パンツはストレートまたは少しテーパード、丈は足首あたり
  - 裾から白いスニーカー (足元まで必ず描く)
- 名札は無地、固有名は無し
- ポーズ: 正面向きで両手を体の前で軽く重ねる (相談を歓迎する姿勢)。**両足は床に着いて見える**こと
- アクセサリー控えめ (ピアスや細いネックレス程度OK)

【構図 (最重要)】
- **キャンバスの上端から下端まで頭〜足が完全に収まる縦長フルショット**
- 頭の上に少し余白、足元に少し床の影 (または余白)
- 上半身だけ・腰までで切れる構図はNG
- アスペクト比は縦長 (3:4 〜 9:16 程度の縦長キャンバス)

【スタイル】
- リアル写真調 (Pixar/アニメではない、実写ベース)
- 背景は**完全に純白 #FFFFFF** (アンチエイリアスでも他色を混ぜない、グラデ禁止)
- 背景に余計な装飾やグラデーションを入れない (後でクライアント側で四隅から flood-fill 透過処理するため)
- 立ち姿の影は最小限 (足元の薄い楕円影程度OK、それ以外影なし)

【絶対禁止】
- 背景に色がつくこと (純白以外NG、薄いグレーやベージュも禁止)
- 上半身だけの構図 (足が描かれていない構図NG)
- 椅子、机、医療器具、書類などの小物
- 服装の色が水色以外 (白衣NG、ピンクNG)
- 派手なメイクや過度なセクシュアル表現 (健康的・上品な範囲のグラマラス)`;

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

// 引数: --room-only でアドバイザー再生成スキップ / --advisor-only で部屋スキップ
const ROOM_ONLY = process.argv.includes('--room-only');
const ADVISOR_ONLY = process.argv.includes('--advisor-only');

(async () => {
  // 1) 部屋画像
  if (!ADVISOR_ONLY) {
    try {
      if (fs.existsSync(ROOM_OUT)) fs.copyFileSync(ROOM_OUT, ROOM_OUT + '.bak.' + Date.now());
      const tmpRoom = ROOM_OUT + '.raw';
      fs.writeFileSync(tmpRoom, await geminiImage(ROOM_PROMPT, 'wellness_room_secret'));
      execSync(`ffmpeg -y -i ${tmpRoom} -vf "crop=in_w:in_w*9/16:0:(in_h-in_w*9/16)/2,scale=1344:768" -update 1 -frames:v 1 ${ROOM_OUT}`, { stdio: 'inherit' });
      fs.unlinkSync(tmpRoom);
      console.log('✅ 健康管理室+隠し扉:', ROOM_OUT);
    } catch (e) {
      console.error('部屋画像失敗:', e.message);
    }
  }
  // 2) ヘルスアドバイザー (若返り+ショート+グラマラス全身) — --room-only でスキップ
  if (!ROOM_ONLY) {
    try {
      if (fs.existsSync(ADVISOR_OUT)) fs.copyFileSync(ADVISOR_OUT, ADVISOR_OUT + '.bak.' + Date.now());
      fs.writeFileSync(ADVISOR_OUT, await geminiImage(ADVISOR_PROMPT, 'advisor_v3'));
      console.log('✅ ヘルスアドバイザー (グラマラス全身):', ADVISOR_OUT);
    } catch (e) {
      console.error('アドバイザー失敗:', e.message);
    }
  }
})();
