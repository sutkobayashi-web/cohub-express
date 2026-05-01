// Connect 230 ロビースクリーン用 東海道地図背景を Gemini 2.5 Flash Image で生成
// 実行: node server/scripts/gen_tokaido_bg.js
'use strict';
const fs = require('fs');
const path = require('path');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY が設定されていません'); process.exit(1); }

const OUT_DIR = path.join(__dirname, '..', '..', 'public', 'assets', 'walk');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PROMPT = `An antique Japanese Tokaido (東海道) road map illustration, ultra-wide horizontal panoramic format. The map depicts the historical route from Tokyo Nihonbashi (left edge, east) to Iwata in Shizuoka (right edge, west), shown as a bird's-eye stylized map.

★STYLE: Ukiyo-e woodblock print aesthetic blended with vintage cartography. Aged washi paper / parchment background with subtle warm beige cream color (#f4e8d0 base) and faint paper texture, slight tea-stain mottling. Hand-drawn sumi-ink (墨) outlines, soft pastel washes in muted indigo, vermilion, ochre, and gold. Hokusai-inspired but flatter and softer.

★COMPOSITION (left to right):
- LEFT EDGE: Edo / Tokyo with stylized Nihonbashi wooden bridge silhouette
- LEFT-CENTER: rolling green hills, the suggestion of Yokohama bay with red brick warehouse hint
- CENTER-BACK (upper third): a prominent stylized Mt. Fuji (富士山) silhouette with snowcap, drawn in simple ukiyo-e curves, soft indigo and white. NOT photorealistic — woodblock simplification.
- LOWER HALF: the Pacific Ocean / Suruga Bay (駿河湾) with stylized Hokusai-style wave patterns (青波), small sailing boats hint
- RIGHT-CENTER: rolling tea plantation hills (Kakegawa green tea fields) with neat striped texture
- RIGHT EDGE: Iwata / Hamamatsu area with subtle modern factory silhouette blending with traditional landscape

★THE TOKAIDO ROAD: A gently winding, sinuous ROAD drawn across the middle band of the image (vertically around 50-55% from top), depicted as a soft ochre/golden dashed path with subtle pine tree dots along it. The road must flow continuously from left edge to right edge with gentle organic curves (NOT a straight line). It should be the visual spine of the composition.

★CRITICAL CONSTRAINTS:
- ABSOLUTELY NO TEXT, NO LETTERS, NO KANJI, NO CHARACTERS, NO READABLE SIGNS anywhere — pure illustration only
- NO HUMAN FIGURES, NO ANIMALS in foreground
- The middle horizontal band where the road runs should be visually CALMER (fewer details) so that thumbnail images can be overlaid on top later — leave breathing room around the road
- Top edge and bottom edge should be slightly darker/vignetted to frame the map
- Overall brightness: medium-bright, warm, inviting, NOT dark
- Color palette: aged ivory paper + sumi black + soft indigo + muted vermilion + ochre/gold + sage green (no neon, no saturated primary colors)
- Format: ultra-wide cinematic 16:9 horizontal
- Premium hand-illustrated antique map feel, suitable as background for a corporate lobby live screen

The result should feel like a beautiful old Tokaido map you would hang in a museum, with room for stops to be marked on top of it later.`;

(async () => {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.85,
      imageConfig: { aspectRatio: '16:9' },
    },
  };
  const outFile = path.join(OUT_DIR, 'tokaido_map_bg.png');
  // 既存退避
  try {
    if (fs.existsSync(outFile)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.copyFileSync(outFile, outFile + '.bak.' + ts);
    }
  } catch (e) {}
  process.stdout.write('[gen] tokaido_map_bg.png ... ');
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const txt = await resp.text();
    console.log('FAIL HTTP', resp.status);
    console.error(txt.slice(0, 400));
    process.exit(1);
  }
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) { console.log('FAIL no parts'); process.exit(1); }
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      const buf = Buffer.from(inline.data, 'base64');
      fs.writeFileSync(outFile, buf);
      console.log('OK (' + Math.round(buf.length / 1024) + ' KB)');
      console.log('保存先: ' + outFile);
      return;
    }
  }
  console.log('FAIL no image in response');
  process.exit(1);
})();
