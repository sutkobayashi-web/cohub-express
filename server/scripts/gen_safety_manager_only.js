// 安全管理者の立ち姿だけを再生成 (gen_field_accident.js のMANAGER_PROMPTを抽出して使用)
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const MANAGER_OUT = '/opt/cohub/public/assets/concierge_safety_full.png';
const SRC_PATH = '/opt/cohub/server/scripts/gen_field_accident.js';

const src = fs.readFileSync(SRC_PATH, 'utf8');
const m = src.match(/const MANAGER_PROMPT = `([\s\S]*?)`;/);
if (!m) { console.error('MANAGER_PROMPT 抽出失敗'); process.exit(2); }
const MANAGER_PROMPT = m[1];
console.log('MANAGER_PROMPT 抽出 (', MANAGER_PROMPT.length, '文字)');

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
  if (fs.existsSync(MANAGER_OUT)) fs.copyFileSync(MANAGER_OUT, MANAGER_OUT + '.bak.' + Date.now());
  fs.writeFileSync(MANAGER_OUT, await geminiImage(MANAGER_PROMPT));
  console.log('✅ 保存完了:', MANAGER_OUT, fs.statSync(MANAGER_OUT).size, 'bytes');
})().catch(e => { console.error('FAIL:', e.message); process.exit(2); });
