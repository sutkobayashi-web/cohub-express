// 事故対策室 — 一人称視点画像 + 安全管理者(男性・管理職) 立ち姿を Gemini で生成
// usage: node server/scripts/gen_field_accident.js
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const ROOM_OUT = '/opt/cohub/public/assets/floor_field_accident.png';
const MANAGER_OUT = '/opt/cohub/public/assets/concierge_safety_full.png';

const ROOM_PROMPT = `物流・運送会社の**事故対策室 / 緊急対策本部**の**一人称視点**画像を生成してください。

【視点・構図】
- 部屋に入って正面を見る人間の目線(身長170cm)
- **必ず 16:9 横長アスペクト比** (1344×768 px)
- **正面の壁いっぱいに巨大なビデオスクリーン**(壁掛け大型液晶、横長16:9、ベゼル細め、画面はオフ状態の暗い黒〜ネイビー)。スクリーンは画面中央〜左寄りで、横幅は壁の60%、高さは壁の50%程度を占める存在感
- スクリーンの**右脇**に、安全管理者(男性管理職)が立つ余白スペース(壁から少し離れた床、ここにアバターを後で重ねるので**人物は描かない**)
- スクリーン手前(部屋の中央〜手前)に**会議卓**(濃い木目の長方形テーブル、椅子8脚をU字配置、椅子は黒革の事務用)
- 床は**ダークグレーのカーペットタイル**(業務的、清掃しやすい)
- 天井: ホワイト+ダウンライト+左右に空調ダクト
- 左右の壁: 事故統計の貼り紙(文字は読めない程度のぼかし)、安全標語ポスター(具体的文字なし)、ホワイトボード(中央スクリーンの脇)
- 部屋全体の色調: **赤と黒を基調とした緊張感のある対策本部風**(壁はオフホワイトだがアクセントに濃赤のラインや赤色の警告灯、椅子は黒)

【トーン・雰囲気】
- 緊張感のある対策本部・危機管理センター風(冷静で硬派)
- リアル写真調 (CG・イラスト風ではなく、実写風レンダリング)
- 蛍光灯+スクリーンの青白い光が顔に当たるような演出は不要(スクリーンはオフ状態)
- 観葉植物は1株のみ(部屋の右奥隅)

【重要】
- **人物は一切描かない**(後で別レイヤーで男性管理職アバターを重ねるため)
- スクリーン本体の画面は**真っ黒〜暗いネイビーの単色**にしてください(後で動画/写真をオーバーレイ表示するため、空のディスプレイ状態が必要)
- 文字・看板・追加ロゴは入れない (ぼかしポスター程度のみ可)
- 全体的に少し暗め・引き締まった印象、安全管理の重みが伝わる空間`;

const MANAGER_PROMPT = `**運送会社の安全管理責任者 / 事故対策室長**のキャラクター立ち姿を生成してください。

【キャラクター】
- 50代前半の日本人男性
- がっしりした体格、肩幅広め、身長175cm程度
- やや**強面・厳格**な表情(口は引き締まり、目つきは鋭いが理不尽ではない、現場叩き上げの管理職らしい眼差し)
- 短く整えた黒髪+少し白髪混じり、清潔感のある髪型
- **濃紺のスーツ**+白シャツ+えんじ色のネクタイ (運送会社の管理職らしい堅実な装い、作業服ではない)
- 胸ポケットに「安全」または無地の腕章/バッジ(具体的文字は入れない)
- ポーズ: 正面向き、両足はやや肩幅に開いて立ち、両手を体の前で軽く組む(または右手で軽く何かを指し示すジェスチャー)
- 体格は威圧感あるが、敵意ではなく**「事故は許さない」「安全は妥協しない」という覚悟の威厳**が滲む雰囲気

【スタイル】
- リアル写真調 (Pixar/アニメではない、実写ベース)
- 全身が入る縦長構図 (頭から足まで、背景は**完全に白 #FFFFFF**)
- 背景に余計な装飾やグラデーションを入れない (透過処理用)
- 立ち姿の影は最小限

【重要】
- 背景は**真っ白(無地)**にしてください (後でクライアント側で透過処理します)
- キャラクター以外の物体(机、椅子、ヘルメット等)を入れない
- 顔は具体的すぎない、誰にでも親しみやすい平均的な造形だがやや厳格な印象を残す
- 笑顔ではなく**真顔〜やや険しい表情**`;

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
  // 1. 部屋画像 (1344×768 にクロップ)
  try {
    if (fs.existsSync(ROOM_OUT)) fs.copyFileSync(ROOM_OUT, ROOM_OUT + '.bak.' + Date.now());
    const tmpRoom = ROOM_OUT + '.raw';
    fs.writeFileSync(tmpRoom, await geminiImage(ROOM_PROMPT, 'field_accident_room'));
    execSync(`ffmpeg -y -i ${tmpRoom} -vf "crop=in_w:in_w*9/16:0:(in_h-in_w*9/16)/2,scale=1344:768" -update 1 -frames:v 1 ${ROOM_OUT}`, { stdio: 'inherit' });
    fs.unlinkSync(tmpRoom);
    console.log('✅ 部屋画像:', ROOM_OUT);
  } catch (e) {
    console.error('部屋画像失敗:', e.message);
  }
  // 2. 管理職立ち姿
  try {
    if (fs.existsSync(MANAGER_OUT)) fs.copyFileSync(MANAGER_OUT, MANAGER_OUT + '.bak.' + Date.now());
    fs.writeFileSync(MANAGER_OUT, await geminiImage(MANAGER_PROMPT, 'safety_manager'));
    console.log('✅ 安全管理者:', MANAGER_OUT);
  } catch (e) {
    console.error('安全管理者失敗:', e.message);
  }
})().catch(e => { console.error(e); process.exit(2); });
