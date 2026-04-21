#!/usr/bin/env node
// 既存のfloor_office.pngに正面入口(下中央壁)を追加 (レイアウト維持)
require('dotenv').config();
const fs = require('fs');
const path = require('path');

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  const srcPath = path.join(__dirname, '..', 'public', 'assets', 'floor_office.png');
  const ref = fs.readFileSync(srcPath).toString('base64');

  const prompt = `Edit this top-down orthographic floor plan of an office. I need you to modify ONLY the thin wall line at the very LOWER EDGE of the image (the topmost ~5% horizontal strip of the canvas — the wall between the outside of the building and the office interior).

Current state of that lower wall strip: there is a small STAIRCASE at the BOTTOM-LEFT corner.

Desired change:
1. DELETE the staircase completely. Replace with plain wooden floor continuing up to the wall line.
2. At the EXACT HORIZONTAL MIDDLE of the lower wall (from pixel x=42% to x=58% of image width), REPLACE THAT MIDDLE SECTION OF WALL with a wide MAIN ENTRANCE opening. The opening is SHOWN AS:
   - A gap in the wall line
   - Two tall rectangular glass panels (silver-framed) side by side filling the gap — these are the two leaves of a sliding double entrance door
   - A thin dark threshold strip spanning across the opening at floor level
3. DIRECTLY INSIDE the office (on the wooden floor, just a few pixels above the bottom wall, centered on the entrance): a small dark rectangular welcome mat (oriented horizontally, perpendicular to the flow of entering people).

CRITICAL CONSTRAINTS:
- The entrance appears ONLY within the bottommost ~10% of the image height (wall strip + mat area + former staircase area).
- The TOP WALL and its WINDOWS must remain completely unchanged — do not remove or modify any window on the top wall.
- Do NOT alter the wooden floor (except replacing staircase with plain wood), the desks, the chairs, the plants, the breakroom, filing cabinets, whiteboard, or any other furniture.
- Do NOT add any text or logos.

Preserve the top-down orthographic projection, overall lighting, warm wooden floor, beige walls.`;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'image/png', data: ref } },
      ],
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.3,
      imageConfig: { aspectRatio: '16:9' },
    },
  };

  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.error('HTTP', r.status, (await r.text()).slice(0, 400));
    process.exit(1);
  }
  const d = await r.json();
  const parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
  if (!parts) { console.error('no parts'); process.exit(1); }
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      fs.writeFileSync(srcPath, Buffer.from(inline.data, 'base64'));
      console.log('saved', srcPath, Buffer.from(inline.data, 'base64').length, 'bytes');
      return;
    }
  }
  console.error('no image in response');
})();
