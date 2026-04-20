#!/usr/bin/env node
// 受付AI案内員 (葵・結衣) のアバターを Gemini 2.5 Flash Image で生成
// 出力: public/assets/concierge_aoi.png, concierge_yui.png
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const AVATARS = [
  {
    file: 'concierge_aoi.png',
    prompt: `Professional Japanese corporate receptionist illustration, anime style.
Young woman, 25-30 years old, friendly warm smile, natural shoulder-length dark brown hair tied neatly,
wearing a CRISP NAVY BLAZER over a white blouse, small gold name pin, subtle natural makeup.
Front-facing portrait, head and upper shoulders only, centered.
Clean white background. Soft warm studio lighting. Bright, welcoming, polished corporate atmosphere.
Square 1:1 frame. NO text, NO logos, NO writing.`,
  },
  {
    file: 'concierge_misaki.png',
    prompt: `Professional Japanese corporate receptionist illustration, anime style.
Young woman, 25-30 years old, calm gentle smile, light brown long straight hair with side swept bangs,
wearing an elegant LIGHT GREY BLAZER over a soft pink blouse, small gold name pin, refined natural makeup.
Front-facing portrait, head and upper shoulders only, centered.
Clean white background. Soft warm studio lighting. Bright, welcoming, polished corporate atmosphere.
Square 1:1 frame. NO text, NO logos, NO writing.`,
  },
];

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  const outDir = path.join(__dirname, '..', 'public', 'assets');
  for (const a of AVATARS) {
    console.log('generating', a.file);
    const body = {
      contents: [{ parts: [{ text: a.prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        temperature: 0.85,
        imageConfig: { aspectRatio: '1:1' },
      },
    };
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { console.error('HTTP', r.status, await r.text()); process.exit(1); }
    const d = await r.json();
    const parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
    if (!parts) { console.error('no parts'); process.exit(1); }
    let saved = false;
    for (const p of parts) {
      const inline = p.inlineData || p.inline_data;
      if (inline && inline.data) {
        const out = path.join(outDir, a.file);
        fs.writeFileSync(out, Buffer.from(inline.data, 'base64'));
        console.log('saved', out, Buffer.from(inline.data, 'base64').length, 'bytes');
        saved = true;
        break;
      }
    }
    if (!saved) console.error('no image for', a.file);
  }
  console.log('done.');
})();
