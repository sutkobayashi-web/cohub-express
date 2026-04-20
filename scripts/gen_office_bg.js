#!/usr/bin/env node
// 俯瞰リアルオフィス背景を Gemini 2.5 Flash Image で再生成
// 使い方: node scripts/gen_office_bg.js
// 出力: public/assets/office_bg.png
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const PROMPT = `Top-down aerial view of a modern Japanese IT company open-plan office, photorealistic architectural visualization. Features from top to bottom:
- 3 large floor-to-ceiling windows on the upper wall with soft morning daylight streaming in
- Warm oak hardwood flooring throughout
- Left side: a lounge area with grey L-shaped sofa, wooden coffee table with cups and books, floor lamp, potted plants
- Center top: long meeting table with 6 chairs, laptops and documents on surface
- Right top: two personal work desks with dual monitors, ergonomic chairs
- Right middle: large whiteboard with markers
- Right bottom: tall wooden bookshelf filled with colorful books and files
- Center bottom: round meeting table with 4 chairs on a soft rug
- Left bottom: modern cafe counter with espresso machine, sink, mini fridge, wooden bar stools
- Corners: many lush green potted plants
- Bottom center: entrance door with welcome mat
No people visible. Warm lighting, soft realistic shadows, clean modern interior design, ultra high detail, photorealistic materials, professional interior rendering.`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  const body = {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.8 }
  };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) { console.error('HTTP', r.status, await r.text()); process.exit(1); }
  const d = await r.json();
  const parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
  if (!parts) { console.error('no parts'); process.exit(1); }
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      const out = path.join(__dirname, '..', 'public', 'assets', 'office_bg.png');
      fs.writeFileSync(out, Buffer.from(inline.data, 'base64'));
      console.log('saved', out, Buffer.from(inline.data, 'base64').length, 'bytes');
      return;
    }
  }
  console.error('no image in parts');
  process.exit(1);
})();
