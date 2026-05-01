// 東西反転: 背景 (Iwata左→Tokyo右) + 旅人2枚 (向き反転)
// 実行: node server/scripts/gen_tokaido_fix.js
'use strict';
const fs = require('fs');
const path = require('path');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY が設定されていません'); process.exit(1); }

const OUT_DIR = path.join(__dirname, '..', '..', 'public', 'assets', 'walk');
fs.mkdirSync(OUT_DIR, { recursive: true });

const STYLE = 'STYLE: Ukiyo-e woodblock print aesthetic, flat 2D, soft sumi-ink black outlines, ' +
  'muted woodblock palette (indigo blue #3a5f8f, vermilion #c44530, ochre/gold #c9a14a, sage green, sumi black), ' +
  'warm ivory cream paper background (#f4e8d0) matching aged washi, subtle paper texture. ' +
  'Circular composition. Single iconic landmark, simplified and stylized. ' +
  'NO TEXT, NO LETTERS, NO KANJI, NO CHARACTERS, NO READABLE SIGNS. ' +
  'Square 1:1 format. Soft hand-drawn quality.';

const PROMPTS = [
  {
    file: 'tokaido_map_bg.png',
    aspect: '16:9',
    prompt: `An antique Japanese Tokaido (東海道) road map illustration, ultra-wide horizontal panoramic format. The map depicts the historical route oriented as a STANDARD MODERN MAP with NORTH UP, so EAST IS ON THE RIGHT and WEST IS ON THE LEFT. Tokyo Nihonbashi is at the RIGHT EDGE (east), Iwata in Shizuoka is at the LEFT EDGE (west).

★STYLE: Ukiyo-e woodblock print aesthetic blended with vintage cartography. Aged washi paper / parchment background with subtle warm beige cream color (#f4e8d0 base) and faint paper texture, slight tea-stain mottling. Hand-drawn sumi-ink outlines, soft pastel washes in muted indigo, vermilion, ochre, and gold. Hokusai-inspired but flatter and softer.

★COMPOSITION (left to right = west to east):
- LEFT EDGE (west): Iwata / Hamamatsu area with subtle modern factory silhouette blending with traditional landscape
- LEFT-CENTER: rolling tea plantation hills (Kakegawa green tea fields) with neat striped texture
- CENTER-BACK (upper third): a prominent stylized Mt. Fuji (富士山) silhouette with snowcap, drawn in simple ukiyo-e curves, soft indigo and white
- LOWER HALF: the Pacific Ocean / Suruga Bay (駿河湾) with stylized Hokusai-style wave patterns (青波), small sailing boats hint
- RIGHT-CENTER: rolling green hills, the suggestion of Yokohama bay with red brick warehouse hint
- RIGHT EDGE (east): Edo / Tokyo with stylized Nihonbashi wooden bridge silhouette

★THE TOKAIDO ROAD: A gently winding, sinuous ROAD drawn across the middle band of the image (vertically around 50-55% from top), depicted as a soft ochre/golden dashed path with subtle pine tree dots along it. The road must flow continuously from left edge to right edge with gentle organic curves.

★CRITICAL CONSTRAINTS:
- ABSOLUTELY NO TEXT, NO LETTERS, NO KANJI, NO CHARACTERS anywhere
- NO HUMAN FIGURES, NO ANIMALS in foreground
- Middle horizontal band visually CALMER for thumbnail overlay later
- Top edge and bottom edge slightly darker/vignetted to frame the map
- Color palette: aged ivory paper + sumi black + soft indigo + muted vermilion + ochre/gold + sage green
- Format: ultra-wide cinematic 16:9 horizontal
- Premium hand-illustrated antique map feel`,
  },
  {
    file: 'traveler_std.png',
    aspect: null,
    prompt: 'A stylized woodblock illustration of an Edo-period Tokaido traveler/courier (飛脚) walking purposefully WESTWARD (FACING LEFT, body and head turned to the LEFT side of the frame). ' +
      'Wearing an indigo blue (deep #1e3a5f) happi coat / hanten with a simple stylized arrow or crest pattern on the back. ' +
      'Carrying a wooden walking staff. Straw sandals, simple traveler trousers. ' +
      'Single figure centered in circular composition, full upper body visible. Cheerful, energetic posture, mid-stride leftward. ' + STYLE,
  },
  {
    file: 'traveler_sze.png',
    aspect: null,
    prompt: 'A stylized woodblock illustration of an Edo-period Tokaido traveler/courier (飛脚) walking purposefully EASTWARD (FACING RIGHT, body and head turned to the RIGHT side of the frame). ' +
      'Wearing an emerald green (deep #047857) happi coat / hanten with a simple stylized lightning or crest pattern on the back. ' +
      'Carrying a wooden walking staff. Straw sandals, simple traveler trousers. ' +
      'Single figure centered in circular composition, full upper body visible. Cheerful, energetic posture, mid-stride rightward. ' + STYLE,
  },
];

async function genOne(prompt, outFile, aspect) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.85,
    },
  };
  if (aspect) body.generationConfig.imageConfig = { aspectRatio: aspect };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('HTTP ' + resp.status + ': ' + txt.slice(0, 250));
  }
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('no parts in response');
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      const buf = Buffer.from(inline.data, 'base64');
      fs.writeFileSync(outFile, buf);
      return { ok: true, bytes: buf.length };
    }
  }
  throw new Error('no image data');
}

(async () => {
  let okCount = 0;
  for (const p of PROMPTS) {
    const outFile = path.join(OUT_DIR, p.file);
    try {
      if (fs.existsSync(outFile)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        fs.copyFileSync(outFile, outFile + '.bak.' + ts);
      }
    } catch (e) {}
    process.stdout.write('[gen] ' + p.file + ' ... ');
    try {
      const r = await genOne(p.prompt, outFile, p.aspect);
      console.log('OK (' + Math.round(r.bytes / 1024) + ' KB)');
      okCount++;
    } catch (e) {
      console.log('FAIL', e.message);
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  console.log('\n生成: ' + okCount + ' / ' + PROMPTS.length);
})();
