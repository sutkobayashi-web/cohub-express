#!/usr/bin/env node
// 健康管理室 (1人称視点) 背景を Gemini 2.5 Flash Image で生成
// 使い方: node scripts/gen_wellness_room.js
// 出力: public/assets/floor_wellness_room.png

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const PROMPT = `FIRST-PERSON VIEW, looking INTO a calm modern Japanese corporate WELLNESS / HEALTH CONSULTATION ROOM (健康管理室) from the entrance doorway. The viewer is standing at the door looking in.

WIDE 16:9 horizontal canvas. Photorealistic interior architecture, eye-level perspective.

Composition (camera POV from doorway looking forward):
- LEFT FOREGROUND: a low and welcoming consultation area — light beige / sage green soft sofa with 2 plush cushions, a small round side table with a glass of water, large lush potted monstera plant on the floor, a small wooden bookshelf showing 4-5 health books and a few wellness magazines (no readable text, just abstract spines)
- LEFT BACK CORNER: subtle medical equipment area — a sleek modern blood pressure monitor on a small table, digital scale on the floor, neatly placed
- CENTER FLOOR: warm natural light wood plank flooring, soft cream area rug under the consultation area
- LEFT-CENTER: tasteful empty floor space where a friendly staff member would stand to greet visitors (KEEP THIS AREA EMPTY - no furniture in the central walking path)
- RIGHT FOREGROUND/MID: small sleek standing reception desk in light wood (low height, about waist-high), with a stylized green health icon (heart + leaf) on the front panel
- RIGHT BACK: window with sheer cream curtain, sunlight streaming in, view of soft greenery outside
- BACK WALL CENTER-RIGHT: A LARGE PROMINENT EMPTY WHITEBOARD framed in light natural wood, mounted on the wall — the whiteboard surface is COMPLETELY BLANK and pure white (this is critical, leave it absolutely empty for content overlay)
- WALLS: soft sage green lower wall (waist-down) + warm white upper wall, calming color combination
- CEILING (visible only in upper edge): soft warm recessed lighting, no fluorescent tubes
- CORNER PLANTS: 1 tall snake plant (sansevieria) in the right back corner, the monstera in the left foreground

Color palette: soft sage green + warm cream white + natural light oak wood + deep greenery. Calming, healing, NOT clinical or sterile. Wellness boutique aesthetic, like a high-end day spa meets modern clinic.

CRITICAL CONSTRAINTS:
- NO TEXT, NO LETTERS, NO LOGOS, NO WRITTEN WORDS anywhere
- NO PEOPLE
- The whiteboard MUST be EMPTY (pure white, no marks, no text, no drawings)
- The center floor walkway must be CLEAR of furniture (where a person would walk in and stand)
- KEEP the LEFT-CENTER area open (no furniture overlap there) so a standing AI advisor figure can be visually placed there in overlay
- KEEP the right side of the back wall area visible and uncluttered (whiteboard placement zone)
- Bright, welcoming, calm atmosphere
- NO COLD CLINICAL feel — warm and approachable

Style: high-end Japanese boutique wellness clinic, calming inviting atmosphere, photorealistic interior photography quality.`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

  const body = {
    contents: [{ parts: [{ text: PROMPT }] }],
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
      const out = path.join(__dirname, '..', 'public', 'assets', 'floor_wellness_room.png');
      // 既存をbackup
      try {
        if (fs.existsSync(out)) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          fs.copyFileSync(out, out + '.bak.' + ts);
        }
      } catch (e) {}
      fs.writeFileSync(out, Buffer.from(inline.data, 'base64'));
      console.log('saved', out, Buffer.from(inline.data, 'base64').length, 'bytes');
      return;
    }
  }
  console.error('no image in parts');
  process.exit(1);
})();
