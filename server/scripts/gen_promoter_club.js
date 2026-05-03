// 推進カフェ — 一人称視点画像 + マスター(店主) 立ち姿を Gemini で生成
// usage: node server/scripts/gen_promoter_club.js
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const ROOM_OUT = '/opt/cohub/public/assets/floor_promoter_club.png';
const MASTER_OUT = '/opt/cohub/public/assets/concierge_master_full.png';

const ROOM_PROMPT = `**おしゃれなブルックリン・カフェ風の社内ラウンジ「推進カフェ」**の**一人称視点**画像を生成してください。

【視点・構図】
- 店内に入って正面を見る人間の目線(身長170cm)
- **必ず 16:9 横長アスペクト比** (1344×768 px)
- 落ち着いた木目+ブラックメタル+暖色照明の温かみあるカフェ空間
- **正面のカウンター越しに、後ろのバックバー(壁面)が見える構図**
- カウンターの**画面右側 (横方向 80%以降) に、マスターが立てる程度の余白**を残す(後でアバターを重ねるので**人物は描かない**)

【店内の要素】
- **正面カウンター**: ダークウォルナットの厚板天板、エイジング加工の銅プレート前面、画面下半分を横切る
- **バックバー (壁面)**: 木製シェルフ3段にコーヒー豆袋・サイフォン・サブウェイタイル
- **エスプレッソマシン**: カウンター右奥に銅色クラシック調のラ・マルゾッコ風大型マシン1台
- **店内中央〜手前** (画面の縦方向 75%〜95%、横方向 20%〜70%): 小さな**丸テーブル2卓**+椅子4脚 (バーチェア風)。等間隔で配置、人物は乗せない
- **天井**: 露出配管+エジソン電球のペンダントライト3灯 (温かいオレンジ光)
- **左壁**: 大きなチョークアートメニューボード (黒板、文字は「COFFEE」程度の薄いぼかしのみ。日本語禁止、Geminiが文字を綺麗に書けないため文字は最小限)
- **右壁**: 大きな観葉植物 (モンステラ系) 1株+小さな額入りモノトーン写真2枚

【トーン・雰囲気】
- 暖色照明+木目の暖かみ、ホっと一息つけるサードプレイス感
- リアル写真調 (CG・イラスト風ではなく、実写風レンダリング)
- 全体的にやや暗めだが居心地良い、コーヒーの香りが漂ってきそうな空気感

【重要・厳守】
- **人物は一切描かない** (後で別レイヤーで店主アバターを重ねるため)
- カウンター越しに見える背後の壁・棚はカフェらしい雑多さで埋めるが、**右側の余白は確保**
- 全体に粗いテキストや看板は描かない (英単語1〜2語の薄い文字なら可、日本語は禁止)
- ロゴ・店名・キャッチコピーは入れない`;

const MASTER_PROMPT = `**社内カフェ「推進カフェ」の店主 (マスター)**のキャラクター立ち姿を生成してください。
**カウンター越しに、入ってきた客 (推進メンバー) を笑顔で迎え、コーヒーカップを差し出す姿勢**を描いてください。

【キャラクター】
- 30代後半〜40代前半の日本人男性、または中性的な印象でも可
- 細身〜標準体型、身長175cm程度
- やわらかく親しみやすい表情 (口元は微笑み、目元は穏やか、職人気質を感じさせる落ち着き)
- 短髪+清潔感のある髪型、無精髭は控えめ
- **黒のソムリエエプロン**+グレーのオックスフォードシャツ (袖口を1〜2折ロールアップ)+黒のスラックス
- 首元に薄手のリネン布巾 (タオル) を軽くかける
- 腕時計と眼鏡 (薄縁) はあっても無くても良い

【ポーズ (重要)】
- 体は正面〜やや右斜め前向き
- **両手で白いコーヒーカップを差し出すように胸の高さに持っている** (ウェルカムジェスチャー)
- 顔は正面を向き、優しく微笑む
- 足は肩幅で安定
- 「いらっしゃい、まずは1杯どうぞ」 という親しみやすい接客ポーズ

【スタイル】
- リアル写真調 (Pixar/アニメではない、実写ベース)
- 全身が入る縦長構図 (頭から足まで、背景は**完全に白 #FFFFFF**)
- 背景に余計な装飾やグラデーションを入れない (透過処理用)
- 立ち姿の影は最小限

【重要】
- 背景は**真っ白(無地)**にしてください (後でクライアント側で透過処理します)
- キャラクター以外の物体 (カウンター、棚、植物等) は入れない (人物のみ・両手にカップだけ持つ)
- カップは白い無地のラテボウル風、湯気が薄く立つ程度
- 顔は具体的すぎない、誰にでも親しみやすい平均的な造形
- 「いらっしゃい」という温かい接客の表情`;

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
    fs.writeFileSync(tmpRoom, await geminiImage(ROOM_PROMPT, 'promoter_club_room'));
    execSync(`ffmpeg -y -i ${tmpRoom} -vf "crop=in_w:in_w*9/16:0:(in_h-in_w*9/16)/2,scale=1344:768" -update 1 -frames:v 1 ${ROOM_OUT}`, { stdio: 'inherit' });
    fs.unlinkSync(tmpRoom);
    console.log('✅ 部屋画像:', ROOM_OUT);
  } catch (e) {
    console.error('部屋画像失敗:', e.message);
  }
  // 2. マスター立ち姿
  try {
    if (fs.existsSync(MASTER_OUT)) fs.copyFileSync(MASTER_OUT, MASTER_OUT + '.bak.' + Date.now());
    fs.writeFileSync(MASTER_OUT, await geminiImage(MASTER_PROMPT, 'master'));
    console.log('✅ マスター:', MASTER_OUT);
  } catch (e) {
    console.error('マスター失敗:', e.message);
  }
})().catch(e => { console.error(e); process.exit(2); });
