#!/usr/bin/env node
// ロビー装飾用 胡蝶蘭スプライト生成 (Gemini 2.5 Flash Image)
// 出力: public/assets/orchid_white.png  (透過処理は四隅flood-fill)
try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const path = require('path');

const OUT_FILE = 'orchid_white.png';
const PROMPT = `Elegant Japanese congratulatory white phalaenopsis orchid plant in a tall arrangement,
luxurious "胡蝶蘭" (kochoran) for grand opening celebration.
Three to five tall arching green stems, each with 6-8 large pure white phalaenopsis blooms
cascading symmetrically, soft yellow centers, glossy green leaves at the base.
Pot wrapped in pristine white traditional Japanese paper with subtle silver-gold pin-stripe ribbon,
no text on the wrapping. Tall vertical composition, plant fills the frame top to bottom.
Pure white background (#FFFFFF), soft small elliptical floor shadow under the pot.
Photorealistic, soft warm studio lighting, professional florist photography.
2:3 portrait aspect. NO text, NO logos, NO writing, NO sign, NO label, NO 立札 stake.`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  const outDir = path.join(__dirname, '..', 'public', 'assets');
  console.log('generating', OUT_FILE);
  const body = {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.8,
      imageConfig: { aspectRatio: '2:3' },
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
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      const out = path.join(outDir, OUT_FILE);
      fs.writeFileSync(out, Buffer.from(inline.data, 'base64'));
      console.log('saved', out, Buffer.from(inline.data, 'base64').length, 'bytes');
      return;
    }
  }
  console.error('no image returned');
  process.exit(1);
})();
