#!/usr/bin/env node
// フロア別の俯瞰オフィス背景を Gemini 2.5 Flash Image で生成
// 使い方: node scripts/gen_floor.js <code>
//   code: lobby | office
// 出力: public/assets/floor_<code>.png
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const COMMON = `STRICT ORTHOGRAPHIC TOP-DOWN FLOOR PLAN VIEW.
CRITICAL: Pure overhead view at exactly 90 degrees from above. Roof removed. NO perspective distortion. NO isometric projection. NO 3D tilt. All furniture seen from directly above as their top surfaces only.
Soft realistic lighting with subtle shadows directly beneath furniture (no long cast shadows). No people visible.
Warm oak hardwood floor with visible plank lines. Walls on all 4 sides.
Style: architectural top-view plan rendering with photorealistic textures, clean and professional.
WIDE 16:9 horizontal rectangular canvas.`;

const PROMPTS = {
  lobby: `${COMMON}

Layout: 1F Lobby of a modern Japanese IT company.
- Upper wall: 3 large windows, warm morning daylight
- Lower wall: main entrance glass double-door with red welcome mat
- Left-top: lounge zone with L-shaped grey sofa, wooden coffee table, floor lamp, potted plant
- Center-top: reception counter with 2 small chairs in front
- Right-top: 2 small round cafe tables with 4 chairs, coffee counter with espresso machine, sink, barstools
- Right-middle: display shelf showing company logo/magazines
- Right-bottom: tall bookshelf with colorful books from above
- Center: open empty floor (guests walk through)
- Left-bottom: elevator and staircase symbols on the wall
- Four corners: lush potted plants (green circles from above)

Overall feeling: welcoming, spacious, empty of people, refined modern Japanese corporate lobby.`,

  office: `${COMMON}

Layout: 2F office floor with 30 desks for administrative staff.
- Upper wall: 3-4 large windows
- Lower wall: staircase and elevator entrance
- Main area: 6 rows × 5 columns = 30 rectangular work desks arranged in a grid (aisles between rows)
- Each desk top shows: wooden desktop rectangle, 2 dark rectangular monitor tops, a small circle chair behind it, maybe a coffee cup or document
- Right wall: filing cabinets (tall rectangles) and a printer
- Left wall: whiteboard + notice boards
- Corners: potted plants
- Narrow walking aisles (about desk-width apart)
- A small breakroom cutout in top-right corner with round table and 2 chairs

Colors: beige/white desks, dark grey monitors, grey chairs, green plants. Organized, professional, empty office scene.`,
};

(async () => {
  const code = (process.argv[2] || 'lobby').toLowerCase();
  const prompt = PROMPTS[code];
  if (!prompt) { console.error('unknown floor code:', code, '(expected: lobby|office)'); process.exit(1); }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.85,
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
      const out = path.join(__dirname, '..', 'public', 'assets', 'floor_' + code + '.png');
      fs.writeFileSync(out, Buffer.from(inline.data, 'base64'));
      console.log('saved', out, Buffer.from(inline.data, 'base64').length, 'bytes');
      return;
    }
  }
  console.error('no image in parts');
  process.exit(1);
})();
