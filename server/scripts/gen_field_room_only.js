// 事故対策室の部屋画像のみを再生成 (gen_field_accident.js のROOM_PROMPTを抽出)
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const { execSync } = require('child_process');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const ROOM_OUT = '/opt/cohub/public/assets/floor_field_accident.png';
const SRC_PATH = '/opt/cohub/server/scripts/gen_field_accident.js';

const src = fs.readFileSync(SRC_PATH, 'utf8');
const m = src.match(/const ROOM_PROMPT = `([\s\S]*?)`;/);
if (!m) { console.error('ROOM_PROMPT 抽出失敗'); process.exit(2); }
const ROOM_PROMPT = m[1];
console.log('ROOM_PROMPT 抽出 (', ROOM_PROMPT.length, '文字)');

async function geminiImage(prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE','TEXT'], temperature: 0.85 } };
  console.log('Gemini に生成リクエスト送信中…');
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('API ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  for (const p of parts || []) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) return Buffer.from(inline.data, 'base64');
    if (p.text) console.log('[text]', p.text.slice(0, 200));
  }
  throw new Error('画像が返ってこない');
}

(async () => {
  if (fs.existsSync(ROOM_OUT)) fs.copyFileSync(ROOM_OUT, ROOM_OUT + '.bak.' + Date.now());
  const tmp = ROOM_OUT + '.raw';
  fs.writeFileSync(tmp, await geminiImage(ROOM_PROMPT));
  // 1344×768 にクロップ&スケール
  execSync(`ffmpeg -y -i ${tmp} -vf "crop=in_w:in_w*9/16:0:(in_h-in_w*9/16)/2,scale=1344:768" -update 1 -frames:v 1 ${ROOM_OUT}`, { stdio: 'inherit' });
  fs.unlinkSync(tmp);
  console.log('✅ 保存完了:', ROOM_OUT, fs.statSync(ROOM_OUT).size, 'bytes');
})().catch(e => { console.error('FAIL:', e.message); process.exit(2); });
