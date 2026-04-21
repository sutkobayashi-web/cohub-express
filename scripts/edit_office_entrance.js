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

  const prompt = `Edit this top-down office floor plan image.

KEEP ABSOLUTELY EVERYTHING IDENTICAL: all 15 desks, 15 chairs, monitors, plants, walls, windows, furniture — do NOT move, add, or remove any item except as specified below.

THE ONLY CHANGE: the BOTTOM WALL.
1. REMOVE the staircase currently at the BOTTOM-LEFT corner completely — replace with plain wooden floor and plant corner decoration matching the other corners.
2. At the HORIZONTAL CENTER of the BOTTOM WALL (from about 44% to 56% of total image width): create a CLEAR DOORWAY OPENING. This looks like:
   - A break in the bottom wall about 12-15% of the total image width wide
   - Double glass automatic sliding doors set flush into the wall (shown from above as two narrow parallel dark rectangles with thin metal frames)
   - A small dark welcome mat (rectangle) on the wooden floor just inside the doorway
   - The opening should look like a professional Japanese office front entrance viewed directly from above
3. The breakroom, printer, filing cabinets, whiteboards, windows, and ALL 15 desks must remain PIXEL-EXACT in their current positions.

Style: match the existing top-down orthographic rendering, same lighting, same wooden floor texture. NO text, NO logos.`;

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
