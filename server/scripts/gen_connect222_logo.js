// Connect 222 ロゴを Gemini で生成
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const OUT = '/opt/cohub/public/assets/walk/logo.png';
const SRC = '/opt/cohub/public/assets/walk/logo.png';  // 元ロゴをベースに

const PROMPT = `Edit this corporate logo: change the large number "230" to "222" while preserving the overall design exactly.

Keep:
- The text "CONNECT" at the top in navy blue bold sans-serif
- The text "CORPORATE WALKING EVENT" at the bottom in green
- The two arrows (green arrow on left pointing right, navy arrow on right pointing left) curving around the central number
- The yellow diamond/rhombus where the arrows meet
- The white background
- Same proportions, same typography, same colors

Change only:
- "230" → "222" (same font, same size, same navy blue color)

Output: a clean square logo image, no extra elements, white background, professional and minimal.`;

async function gen() {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const imgB64 = fs.readFileSync(SRC).toString('base64');
  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType: 'image/png', data: imgB64 } },
        { text: PROMPT },
      ],
    }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.4 },
  };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('API ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('応答にcontent.partsなし');
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      if (fs.existsSync(OUT)) fs.copyFileSync(OUT, OUT + '.bak.' + Date.now());
      fs.writeFileSync(OUT, Buffer.from(inline.data, 'base64'));
      console.log('✅ logo updated:', OUT);
      return;
    }
  }
  throw new Error('画像が返ってきませんでした');
}

gen().catch(e => { console.error('❌', e.message); process.exit(2); });
