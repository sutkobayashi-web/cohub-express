// SU/SUZUE のストリートビュー写真を 浮世絵+水彩風に Gemini で加工 → milestone 始点・終点に上書き
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const { execSync } = require('child_process');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const ASSETS = '/opt/cohub/public/assets/walk';

const COMMON_STYLE = `
【画風指示 — 厳守】
この実写写真をベースに、**浮世絵+水彩風の温かみある風景画** に変換してください。他の宿場画像と同じ画風で統一感を出すため:
- 江戸時代浮世絵+現代風景写真の中間くらいの画風
- 温かみのある彩色 (空はやや色付き、建物はナチュラルな色)
- 水墨画風の輪郭線+水彩のにじみ
- 現代の建物 (倉庫風) はそのまま残しつつ、浮世絵風の絵画タッチ
- 背景の空は晴天、雲は浮世絵風
- 手前にお祝いムード (旗・桜・小さな旅人など) を控えめに足してOK

【画像形式 — 厳守】
- 16:9 横長 (1344×768px)
- **画面いっぱい (フルブリード) の風景画像** — 額縁・枠・縁取り・余白 一切なし
- 文字・ロゴ・看板・キャプション一切なし (Google Mapsの透かしも除去)
- リアル写真ではなく**絵画調**で
`;

const TASKS = [
  {
    key: 'su',
    src: '/tmp/SU.png',
    out: `${ASSETS}/milestone_tokyo.png`,
    name: 'スタンダード運輸本社',
    prompt: `**スタンダード運輸 海老名本社** — 出発点。
平屋建ての社屋、扉、自販機、向こうに事務所、駐車スペース。
陽が差す朝、社員が出発するような賑わい、幟旗 (出発の旗) がはためく雰囲気。
桜並木と青空。物流業を象徴する大型トラックが奥にちらりと見える。`,
  },
  {
    key: 'suzue',
    src: '/tmp/SUZUE.png',
    out: `${ASSETS}/milestone_iwata.png`,
    name: 'スズエ電機本社',
    prompt: `**スズエ電機 磐田本社**。
工場・倉庫風の建屋、シャッター門、機械や資材、駐車場。
夕陽に染まる落ち着いた空気感、桜の花びら舞う。
製造業を象徴する整然とした工場景観、奥に工業団地のシルエット。
**横断幕・幟旗・歓迎旗・ゴールテープ・看板・文字 一切なし** (元写真の看板も除去)。`,
  },
];

async function geminiImage(srcPath, prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const imgB64 = fs.readFileSync(srcPath).toString('base64');
  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType: 'image/png', data: imgB64 } },
        { text: prompt },
      ],
    }],
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
  const targets = only ? TASKS.filter(t => only.includes(t.key)) : TASKS;
  for (const t of targets) {
    try {
      console.log(`\n━━ [${t.name}] 加工中…`);
      const fullPrompt = `${t.prompt}\n${COMMON_STYLE}`;
      const buf = await geminiImage(t.src, fullPrompt);
      if (fs.existsSync(t.out)) fs.copyFileSync(t.out, t.out + '.bak.' + Date.now());
      const tmpRaw = t.out + '.raw';
      fs.writeFileSync(tmpRaw, buf);
      execSync(`ffmpeg -y -i ${tmpRaw} -vf "scale=1344:768:force_original_aspect_ratio=increase,crop=1344:768" -update 1 -frames:v 1 ${t.out}`, { stdio: 'pipe' });
      fs.unlinkSync(tmpRaw);
      console.log(`✅ [${t.name}] 完了: ${t.out}`);
    } catch (e) {
      console.error(`❌ [${t.name}] 失敗:`, e.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('\n✨ 完了');
})().catch(e => { console.error(e); process.exit(2); });
