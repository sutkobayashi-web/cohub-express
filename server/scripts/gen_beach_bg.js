// 浜辺さんぽ用の背景画像を Gemini 2.5 Flash Image で生成 (一人称視点・ヒーリング絵画調)
// 実行: GEMINI_API_KEY=xxx node server/scripts/gen_beach_bg.js
// 生成物: public/assets/beach/bg_<key>.png
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', '..', 'public', 'assets', 'beach');
fs.mkdirSync(OUT_DIR, { recursive: true });

const COMMON = [
  '一人称視点(POV)。砂浜に立って自分の目で海を眺めている構図。',
  '手前にやわらかい砂と波打ち際、その先にゆるやかに打ち寄せる波、広い海、遠くに水平線、上に空。',
  '人物・キャラクター・動物は一切描かない。手や足も描かない。文字・ロゴ・UIも入れない。',
  '穏やかで心が落ち着く、上質なヒーリング系の絵画調イラスト。デジタルペインティング、やわらかい筆致、上品で淡い色調、ほどよい奥行きと空気感。',
  '縦長(スマホ縦持ち, 9:16)の構図。高精細。',
].join('\n');

const VARIANTS = {
  dawn:   '時間帯は早朝の朝焼け。淡いピンクと水色のグラデーション、しっとりした静けさ。',
  golden: '時間帯は夕方の黄金時間(ゴールデンアワー)。暖かなオレンジと金色の光が水面に反射し、心がほどける雰囲気。',
  calm:   '時間帯は昼下がり。爽やかな水色とターコイズの海、白い雲、明るく開放的だが穏やかな空気。',
};

async function genOne(key, extra) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const prompt = COMMON + '\n' + extra;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 1.0 },
  };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) { const t = await resp.text(); throw new Error('Gemini error ' + resp.status + ': ' + t.slice(0, 300)); }
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('応答に画像なし: ' + JSON.stringify(data).slice(0, 300));
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      const buf = Buffer.from(inline.data, 'base64');
      const file = path.join(OUT_DIR, 'bg_' + key + '.png');
      fs.writeFileSync(file, buf);
      console.log('OK', key, '->', file, '(' + Math.round(buf.length / 1024) + 'KB)');
      return;
    }
  }
  throw new Error('画像パートなし: ' + key);
}

(async () => {
  for (const [key, extra] of Object.entries(VARIANTS)) {
    try { await genOne(key, extra); }
    catch (e) { console.error('FAIL', key, e.message); }
  }
})();
