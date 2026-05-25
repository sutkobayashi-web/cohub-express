// 東名高速 SA/PA を含む 22 ポイントの milestone 画像を Gemini で再生成
// usage: node server/scripts/gen_walk_milestones_v2.js [--only=key1,key2]
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const { execSync } = require('child_process');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const ASSETS = '/opt/cohub/public/assets/walk';
if (!fs.existsSync(ASSETS)) fs.mkdirSync(ASSETS, { recursive: true });

const COMMON = `
【画像形式 — 厳守】
- 16:9 横長 (1344×768px、ffmpegで後処理クロップ)
- **画面いっぱい (フルブリード) の風景画像** — 額縁・枠・縁取り・余白 一切なし
- 浮世絵+水彩風のやや古地図テイスト、温かみのある彩色
- 文字・ロゴ・看板・キャプション一切なし
- 人物は描かない or 遠景の小さな旅人程度
- リアル写真ではなく、**江戸時代浮世絵+現代風景写真の中間** くらいの画風
`;

const POINTS = [
  { key: 'tokyo',          out: 'milestone_tokyo.png',          name: '東京日本橋 (出発)',       prompt: '東京日本橋 — 江戸の商業中心地、麒麟橋柱と石造アーチ、奥に高層ビル、朝霧の中で出発の旗が翻る。お堀と桜並木。日本橋川に映る現代と江戸の対比。' },
  { key: 'kohoku_pa',      out: 'milestone_kohoku.png',         name: '港北PA',                 prompt: '東名高速 港北PA — 都市型パーキング、横浜港北エリア、整然とした緑地、遠景に都心ビル群、青空。' },
  { key: 'ebina_sa',       out: 'milestone_ebina.png',          name: '海老名SA',               prompt: '東名高速 海老名SA — 関東最大級のサービスエリア、巨大な吹き抜けフードコート建屋、メロンパンの旗、駐車場に大型トラックが並ぶ、賑わう光景。' },
  { key: 'yokohama',       out: 'milestone_yokohama.png',       name: '横浜',                   prompt: '横浜みなとみらい — ランドマークタワー、観覧車コスモクロック、赤レンガ倉庫、横浜ベイブリッジ、海の青と港町の活気。' },
  { key: 'nakai_pa',       out: 'milestone_nakai.png',          name: '中井PA',                 prompt: '東名高速 中井PA — 神奈川県中井町、丘陵の中の小さなパーキング、富士山遠望、田園と茶畑の風景。' },
  { key: 'ayuzawa_pa',     out: 'milestone_ayuzawa.png',        name: '鮎沢PA',                 prompt: '東名高速 鮎沢PA — 静岡県小山町、山あいの小さな休憩所、緑深い杉林に囲まれ、富士山西麓、清流のせせらぎ。' },
  { key: 'odawara',        out: 'milestone_odawara.png',        name: '小田原',                 prompt: '小田原城 — 江戸時代の三層天守、桜並木、相模湾を望む高台、瓦屋根と石垣、城下町の趣。' },
  { key: 'ashigara_sa',    out: 'milestone_ashigara.png',       name: '足柄SA',                 prompt: '東名高速 足柄SA — 富士山が真正面に大きく聳える絶景、温泉施設の煙、広い駐車場、観光バス、晴天の朝の富士山絶景。' },
  { key: 'fujioyama',      out: 'milestone_fujioyama.png',      name: '道の駅 ふじおやま',     prompt: '道の駅 ふじおやま — 静岡県小山町、富士山の南麓、農産物直売所、地元野菜、富士山が大きく背景に、田園風景。' },
  { key: 'komakado_pa',    out: 'milestone_komakado.png',       name: '駒門PA',                 prompt: '東名高速 駒門PA — 御殿場周辺、富士山を望む高原のパーキング、ススキ野原、青い空、自衛隊演習場の遠景。' },
  { key: 'suruga_sa',      out: 'milestone_suruga.png',         name: '駿河湾沼津SA',           prompt: '東名高速 駿河湾沼津SA — 駿河湾を一望する展望デッキ、漁船の浮かぶ青い海、伊豆半島の山並み、夕陽に染まる港町、豊かな海の幸。' },
  { key: 'fujikawa',       out: 'milestone_fujikawa.png',       name: '富士川楽座',             prompt: '富士川楽座 — 富士川にかかる長大橋、雪を抱いた富士山が真正面、河川敷、観覧車のシルエット、清流の流れ。' },
  { key: 'yui_pa',         out: 'milestone_yui.png',            name: '由比PA',                 prompt: '東名高速 由比PA — 由比海岸の薩埵峠展望、駿河湾と富士山の絶景、海岸沿いの東海道、桜エビ漁の小舟、波打ち際。' },
  { key: 'shimizu_pa',     out: 'milestone_shimizu.png',        name: '清水PA',                 prompt: '東名高速 清水PA — 清水港の岸壁、ちびまる子ちゃんの故郷、漁港の活気、富士山遠望、お茶と港町の調和。' },
  { key: 'nihondaira_pa',  out: 'milestone_nihondaira.png',     name: '日本平PA',               prompt: '日本平 — 茶畑の段々畑が広がる丘陵、富士山絶景、駿河湾を見下ろす高台、緑のお茶の葉、青空。' },
  { key: 'utsunoya',       out: 'milestone_utsunoya.png',       name: '道の駅 宇津ノ谷峠',     prompt: '宇津ノ谷峠 — 旧東海道の山道難所、苔むした石段、杉並木、トンネル入口、霧深い古道、藁葺き茶屋の残影。' },
  { key: 'makinohara_sa',  out: 'milestone_makinohara.png',     name: '牧之原SA',               prompt: '東名高速 牧之原SA — 一面の茶畑、青々とした新茶のラインが地平線まで広がる、富士山遠景、お茶摘みの帽子、爽やかな緑。' },
  { key: 'ogasa_pa',       out: 'milestone_ogasa.png',          name: '小笠PA',                 prompt: '東名高速 小笠PA — 静岡県掛川市、田園と茶畑が混在する穏やかな丘陵、夕暮れのオレンジ空、のどかな里山風景。' },
  { key: 'kakegawa',       out: 'milestone_kakegawa.png',       name: '道の駅 掛川',           prompt: '掛川城 — 木造再建の三層天守、静かな山城、茶畑、お茶の急須、地元の特産品店、青空に映える白い城。' },
  { key: 'hamanako_sa',    out: 'milestone_hamanako.png',       name: '浜名湖SA',               prompt: '東名高速 浜名湖SA — 浜名湖を一望する絶景、養殖いかだ、湖畔の松林、夕陽が湖面に反射、うなぎの幟、釣り船。' },
  { key: 'mikatahara_pa',  out: 'milestone_mikatahara.png',     name: '三方原PA',               prompt: '東名高速 三方原PA — 浜松市の高台、武田信玄合戦地の歴史、台地の松林、夕暮れの空、遠州灘遠望。' },
  { key: 'iwata',          out: 'milestone_iwata.png',          name: '磐田 スズエ電機 (ゴール)', prompt: '磐田 — ジュビロ磐田の街、スズエ電機本社の現代的な工場建屋、ゴールテープを切る走者、満開の桜、達成感に溢れる夕陽の街並み。' },
];

async function geminiImage(prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.85 },
  };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('API ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('応答にcontent.partsなし');
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) return Buffer.from(inline.data, 'base64');
  }
  throw new Error('画像が返ってきませんでした');
}

(async () => {
  const onlyArg = process.argv.find(a => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.replace('--only=', '').split(',') : null;
  const targets = only ? POINTS.filter(p => only.includes(p.key)) : POINTS;
  console.log(`生成対象 ${targets.length} ポイント`);
  for (const p of targets) {
    const outPath = `${ASSETS}/${p.out}`;
    try {
      console.log(`\n━━ [${p.key}] ${p.name} 生成中…`);
      const fullPrompt = `**${p.name}** の風景画像を生成してください。\n\n${p.prompt}\n${COMMON}`;
      const buf = await geminiImage(fullPrompt);
      if (fs.existsSync(outPath)) fs.copyFileSync(outPath, outPath + '.bak.' + Date.now());
      const tmpRaw = outPath + '.raw';
      fs.writeFileSync(tmpRaw, buf);
      execSync(`ffmpeg -y -i ${tmpRaw} -vf "crop=in_w:in_w*9/16:0:(in_h-in_w*9/16)/2,scale=1344:768" -update 1 -frames:v 1 ${outPath}`, { stdio: 'pipe' });
      fs.unlinkSync(tmpRaw);
      console.log(`✅ [${p.key}] 完了: ${outPath}`);
    } catch (e) {
      console.error(`❌ [${p.key}] 失敗:`, e.message);
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  console.log('\n✨ 全ポイント生成完了');
})().catch(e => { console.error(e); process.exit(2); });
