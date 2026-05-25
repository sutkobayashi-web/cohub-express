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
- **正面の壁にビデオスクリーンを 1枚だけ**配置 (壁掛け超大型液晶、横長16:9、ベゼル極細)
  - スクリーンは画面の**横方向13%付近〜85%付近まで広がる超巨大サイズ**(横幅は画面全幅の約72%、高さは画面全高の約70%を占める)
  - スクリーンの上端は天井ぎりぎり、下端は床から少し上の壁いっぱい設計
  - 画面はオフ状態の**真っ黒〜暗いネイビーの単色**(後で動画/写真をオーバーレイするため必ず単色)
  - **絶対禁止**: 反対側の壁・側壁・天井・別の場所に**もう1枚のスクリーン/モニター/TV/プロジェクター/掲示板**を描かない。スクリーンは正面の1枚のみ。
- スクリーンの**右側(画面の横方向85%以降)に、安全管理者(男性管理職)が一人立てる程度の余白スペース**を残す(後でアバターを重ねるので**人物は描かない**)
- **会議卓・机は一切描かない** (テーブル禁止)
- **小型のパイプ椅子を4脚**配置: スクリーンの前に**横一列4脚を等間隔で並べる**
  - 配置: 画面の縦方向 82%〜93% 付近、横方向 33%〜67%
  - **背もたれを画面手前 (視点側)、座面が画面奥のスクリーン側を向く**
  - 椅子は**事務用パイプ椅子** (黒の金属フレーム+黒い座面)
  - **椅子1脚は極めて小さく** (画面全高の約 4%程度の高さ。前回比80%に縮小したミニサイズ)
  - 椅子だけ描き、人物は乗せない
- 床は**ダークグレーのカーペットタイル**
- 天井: ホワイト+ダウンライト+左右に空調ダクト
- 左右の壁: **完全に無地・装飾なし**の "**真っ白な壁紙**" のみ。
  - 貼り紙・ポスター・チラシ・ホワイトボード・看板・標語・スローガン・文字・記号・数字・ロゴ・額縁・写真フレーム・ピクチャー・カレンダー・地図・絵画・賞状・OA機器・コンセント・スイッチプレート・配管・ダクト・装飾モール・ピクチャーレール・押しピン・テープ跡・染み・落書きは**一切描かない**
  - **後述の安全三箇条ステッカー1枚以外、壁面には他のオブジェクトを一切描かない**
  - 壁紙のテクスチャや凹凸も最小限。スッキリしたフラットな無地のオフホワイト壁面のみ
  - **ネガティブプロンプト**: NO posters, NO signs, NO papers on walls, NO calendars, NO whiteboards, NO frames, NO art, NO text, NO labels on walls (except the single safety-three-rules sticker described below)

【重要: 安全三箇条ステッカーの壁掲示 (新)】
- スクリーンの**左側の壁面 (画面の横方向 5%〜17% 付近、垂直位置は中央〜やや下、目線の高さ)** に、**会社の安全三箇条ステッカー**を1枚、額装または直貼りで掲示してください
- ステッカーの見た目:
  - **黄色 (#FBBF24相当) の横長長方形** (縦横比 約 3:1)
  - 上下の縁に**黒×黄色のハザードテープ風ストライプ**
  - 内部は **3つの黒い太枠セルが横並び** (左/中/右)
  - 各セルには小さな黒色アイコンと2〜3字の見出しがあるが、**文字は読めない程度のぼかし** (実物の上から後で正確な画像をオーバーレイするため、Geminiが日本語をきれいに描けなくても問題ない)
- 壁から少し浮き出る影と軽い反射で「実物のシール」感を出す
- ステッカー自体は壁面の**約 8%×3% の大きさ**で控えめに、しかし目を引くアクセントとして
- **このステッカー以外、壁面には一切の貼り紙・装飾・文字・看板・写真・額・カレンダーを置かない**(過去の生成で勝手にポスターが追加された事故を絶対に再発させない)
- 部屋全体の色調: **赤と黒を基調とした緊張感のある対策本部風**(壁はオフホワイトの無地。巾木に細い濃赤ラインのアクセントのみ許可)

【トーン・雰囲気】
- 緊張感のある対策本部・危機管理センター風(冷静で硬派)
- リアル写真調 (CG・イラスト風ではなく、実写風レンダリング)
- 蛍光灯+スクリーンの青白い光が顔に当たるような演出は不要(スクリーンはオフ状態)
- 観葉植物は1株のみ(部屋の左奥隅、右側はアバター用に空ける)

【重要・厳守】
- **人物は一切描かない**(後で別レイヤーで男性管理職アバターを重ねるため)
- **会議卓・机の類は絶対に描かない** (上記のパイプ椅子4脚以外の家具なし)
- **スクリーンは正面に1枚だけ。第2のスクリーンや反射映像、別モニターは絶対に描かない**(過去の生成で2つのスクリーンが描かれてしまった事故を防ぐ)
- スクリーン本体の画面は**真っ黒〜暗いネイビーの単色**(空のディスプレイ状態)
- 文字・看板・追加ロゴは入れない
- 部屋は**少人数のミニシアター風配置**: 椅子4脚が観客席、正面に巨大スクリーン、右脇に登壇者の立ち位置という小講堂のような構図
- 全体的に少し暗め・引き締まった印象、安全管理の重みが伝わる空間`;

const MANAGER_PROMPT = `**運送会社の安全管理責任者 / 事故対策室長**のキャラクター立ち姿を生成してください。
**会議室の前面スクリーン (画面左側) を右手で指さしながら社員に説明しているプレゼンター姿**を描いてください。

【キャラクター】
- 50代前半の日本人男性
- がっしりした体格、肩幅広め、身長175cm程度
- やや**強面・厳格**な表情(口は少し開き気味で「説明している」最中、目つきは鋭いが理不尽ではない、現場叩き上げの管理職らしい眼差し)
- 短く整えた黒髪+少し白髪混じり、清潔感のある髪型
- **濃紺のスーツ**+白シャツ+えんじ色のネクタイ (運送会社の管理職らしい堅実な装い、作業服ではない)
- 胸ポケットに「安全」または無地の腕章/バッジ(具体的文字は入れない)

【ポーズ (重要)】
- 体は正面〜やや左斜め前向き (画面左側にあるスクリーンに半身を向ける)
- **右腕を肩の高さで斜め上〜横に伸ばし、人差し指でスクリーン (画面左方向) を明確に指さしている**
- 左手は腰横または身体の前で軽く添える程度
- 顔と視線は、指さした方向 (画面左) と社員 (正面〜右) の中間あたりを見て、説明している最中の表情
- 足は肩幅で安定、やや片足前
- 「ボードを指して語る講師・指導者」の典型ポーズ
- 仁王立ち (両手を組んで真正面) は**絶対NG**

【スタイル】
- リアル写真調 (Pixar/アニメではない、実写ベース)
- 全身が入る縦長構図 (頭から足まで、背景は**完全に白 #FFFFFF**)
- 背景に余計な装飾やグラデーションを入れない (透過処理用)
- 立ち姿の影は最小限

【重要】
- 背景は**真っ白(無地)**にしてください (後でクライアント側で透過処理します)
- キャラクター以外の物体 (机、椅子、ヘルメット、指示棒等) を入れない (人物のみ・指は素手で指さし)
- 顔は具体的すぎない、誰にでも親しみやすい平均的な造形だがやや厳格な印象を残す
- 表情は笑顔ではなく**説明中の真剣な顔**
- 「指さしている」動きが必ず見える構図にしてください

【絶対禁止 (Gemini向け追加指示)】
- **指先には何も描かない**: 指の先には四角い枠・ボード・パネル・紙・看板・カード・画面・ディスプレイ・ラベル・吹き出しを一切描かない
- 指は完全に**何もない空中**を指していること (指先の周囲は背景の白だけ)
- 「指の指す先」を表すための長方形・矩形・枠線・透明パネル・反射表示・モーション線も**全て描かない**
- 持ち物なし: 紙束、書類、タブレット、レーザーポインタ、スティック、扇子、ペンも一切持たせない
- 体に触れる装飾品は腕時計と胸ポケットの腕章のみ。それ以外のバッジ・タグ・名札は描かない
- 指先〜手のひら〜腕の周辺空間は完全に**無背景の白**で、視覚的ノイズゼロ`;

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
