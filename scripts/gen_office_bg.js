#!/usr/bin/env node
// 俯瞰リアルオフィス背景を Gemini 2.5 Flash Image で再生成
// 使い方: node scripts/gen_office_bg.js
// 出力: public/assets/office_bg.png
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const PROMPT = `STRICT ORTHOGRAPHIC TOP-DOWN FLOOR PLAN VIEW of a modern Japanese IT company office.
CRITICAL: Pure overhead view at exactly 90 degrees from above. Roof removed. NO perspective distortion. NO isometric projection. NO 3D tilt. Everything seen as a perfectly flat 2D plan-view from directly above, like an architectural floor plan rendered with realistic photographic textures.

All furniture appears as their top surfaces:
- Desks and tables appear as rectangles/circles (tops visible only, no sides)
- Chairs appear as small circles or rounded squares
- Sofas appear as L-shaped or rectangular cushion tops
- Monitors appear as small dark rectangles on desk tops
- Plants appear as clusters of green circles (leaves from above)
- People NOT VISIBLE (office is empty)

Layout (WIDE 16:10 horizontal rectangular canvas, walls on all 4 sides):
- Upper wall: 3 large windows letting in warm morning daylight
- Lower wall: entrance door with red welcome mat
- Left-top quadrant: lounge zone with L-shaped grey sofa, wooden coffee table, floor lamp, potted plant
- Center-top: long rectangular meeting table with 6 chairs
- Right-top: 2 personal desks with monitors and chairs
- Right-middle: whiteboard mounted on right wall
- Right-bottom: tall bookshelf along right wall (colorful book spines visible from above)
- Center-bottom: circular meeting table with 4 chairs on a soft area rug
- Left-bottom: cafe counter with espresso machine, sink, barstools
- Four corners: lush potted plants
- Floor: warm oak hardwood with visible plank lines

Soft realistic lighting and subtle shadows DIRECTLY BENEATH furniture (no long cast shadows - that would imply angle). Colors: warm beige/cream walls, natural wood tones, grey fabric, green plants.
Style: architectural top-view plan rendering with photorealistic textures, clean and professional.`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  const body = {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.8,
      imageConfig: { aspectRatio: '16:9' }
    }
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
