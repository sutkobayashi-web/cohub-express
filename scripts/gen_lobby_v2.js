#!/usr/bin/env node
// 1Fロビー (1人称視点 v2) を Gemini 2.5 Flash Image で生成
// 変更点: エレベーター削除、滞在用ソファ椅子追加、CoWellロゴ維持、中央に葵が立つ余白
// 出力: public/assets/floor_lobby.png (差替) + 既存をbackup

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const PROMPT = `FIRST-PERSON VIEW, looking INTO a modern Japanese corporate ENTRANCE LOBBY of "CoWell" (Communication & Wellness) from the entrance doorway. The viewer is standing at the door looking forward into a welcoming reception lobby. WIDE 16:9 horizontal canvas. Photorealistic interior architecture, eye-level perspective. Bright, premium, calming corporate atmosphere.

Composition (camera POV, what the viewer sees from the door):
- BACK WALL CENTER (most prominent): A LARGE EMPTY FRAMED PLAQUE on the back wall — a wide rectangular brushed-brass elegant frame surrounding a COMPLETELY BLANK ivory-white panel inside. The frame is well-crafted (about 80cm tall × 130cm wide), eye-level, well-lit by recessed ceiling lighting from above, central focal point of the room. The interior of the frame must be PURE BLANK ivory white with NO logo, NO text, NO image, NO design — just empty white surface (a separate company logo will be overlaid later in canvas).
- BELOW THE LOGO: a low minimalist console table in light oak wood with a single elegant orchid arrangement.
- LEFT FOREGROUND: a comfortable WAITING SEATING AREA for visiting employees — L-shaped charcoal grey leather sofa with 3 plush cream cushions, a square dark wood coffee table with a small leather notebook and a glass of water, a tall floor lamp with brass stem and cream shade.
- RIGHT FOREGROUND: a compact minimalist reception desk in light oak wood (low height, about waist-high, NOT blocking the center floor) with a sleek tablet on top, with 2 modern lounge chairs in soft sage green facing slightly toward the room (additional staying employees can sit here).
- CENTER FLOOR (CRITICAL - KEEP COMPLETELY EMPTY): a wide open polished marble walkway from the door to the back wall, NO furniture, NO obstacles. This is where a friendly receptionist figure will stand in overlay. The marble has subtle warm grey veining (Calacatta style), highly reflective glossy finish.
- LEFT BACK CORNER: a tall lush potted monstera plant in a dark planter.
- RIGHT BACK CORNER: a tall sculptural snake plant (sansevieria) in a matching dark planter.
- CEILING (visible in upper edge): warm white ceiling with elegant recessed downlights and one modern pendant fixture above the center walkway, soft warm ambient lighting.
- WALLS: warm off-white upper walls, with a subtle dark navy lower-wall accent (waist-down wainscoting in deep navy) creating sophisticated layered look.

Color palette: warm cream white walls + dark navy accent + light oak wood + brushed brass + charcoal leather + soft sage green + deep greenery. Premium yet welcoming, NOT cold or corporate-sterile.

CRITICAL CONSTRAINTS:
- ABSOLUTELY NO ELEVATORS, NO ELEVATOR DOORS, NO ELEVATOR BUTTONS visible anywhere
- NO TEXT, NO LETTERS, NO ALPHABET CHARACTERS, NO WORDS, NO READABLE SIGNS anywhere (the logo plaque has only the abstract leaf-line monogram, NO letters)
- NO PEOPLE, NO HUMAN FIGURES (a receptionist will be overlaid in canvas later)
- KEEP the center walkway completely clear and unobstructed
- The reception desk on the right MUST be low and to the side, NOT blocking the center floor
- Bright, welcoming, premium corporate hall atmosphere
- High-quality interior photography style, photorealistic`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  const outFile = path.join(__dirname, '..', 'public', 'assets', 'floor_lobby.png');
  try {
    if (fs.existsSync(outFile)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.copyFileSync(outFile, outFile + '.bak.' + ts);
    }
  } catch (e) {}
  const body = {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.85,
      imageConfig: { aspectRatio: '16:9' },
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
      fs.writeFileSync(outFile, Buffer.from(inline.data, 'base64'));
      console.log('saved', outFile, Buffer.from(inline.data, 'base64').length, 'bytes');
      return;
    }
  }
  console.error('no image returned');
  process.exit(1);
})();
