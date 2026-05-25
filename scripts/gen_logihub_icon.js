#!/usr/bin/env node
// LogiHub アプリアイコンを Gemini 2.5 Flash Image で生成
// 使い方: node scripts/gen_logihub_icon.js
// 出力: public/img/logihub-icon-{1024,512,192,180}.png
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PROMPT = `A clean, modern mobile app icon for "LogiHub" - a logistics operations platform.
Square format, exactly 1:1 aspect ratio.

Design layout (centered horizontally, top to bottom):
1. A simplified stylized side-view delivery truck silhouette in pure white, slightly tilted forward for a sense of motion, occupying about 50% of the icon width, positioned in the upper-middle area. The truck has a cab and a cargo box, very clean and minimal — like a flat mobile app icon, NOT photorealistic.
2. The brand wordmark "LogiHub" in pure white, bold geometric sans-serif (similar weight to Helvetica Black or Inter Black), tightly kerned, with the "H" in "Hub" subtly emphasized. Occupies about 65% of the icon width, positioned in the lower-middle area below the truck.
3. A thin elegant white horizontal divider line under "LogiHub" (about 30% width, 2-3px thick, 50% opacity).
4. Below the divider, the tagline "LOGISTICS OPERATIONS" in a small clean uppercase sans-serif, white at 75% opacity, generously letter-spaced, occupying about 70% of the icon width.

Background: vivid radial gradient — from deep teal-green (#064e3b) at the corners, through emerald (#0d9488) in the middle ring, to a bright teal-cyan (#14b8a6) glow at the center behind the truck and wordmark.
Subtle accent: a faint warm amber (#f59e0b) inner glow line under the truck's wheels (hinting at motion/road), and a faint white inner glow around the "LogiHub" letters.

Style: flat design with subtle depth, premium feel, suitable for a B2B logistics SaaS, friendly yet professional. Matches the visual family of a sibling app called "CoWell" (same gradient-radial-background language, but green/teal instead of navy/blue).

CRITICAL constraints:
- Plain gradient background only — NO photographic scenes, NO buildings, NO people, NO road, NO landscape, NO additional icons
- All text and visual content must stay within the center 80% (safe zone for Android maskable adaptive icons)
- ONLY the texts "LogiHub" and "LOGISTICS OPERATIONS" appear — no other letters, words, or numbers
- "LogiHub" must remain clearly readable when scaled to 64x64 pixels (tagline may become unreadable at small sizes — that's OK)
- The truck must be a clean flat icon-style silhouette, NOT a detailed illustration
- No drop shadow that extends beyond the canvas edges
- Do not add a frame or border
- Background must reach all four edges of the canvas
- Spell exactly: "LogiHub" (capital L, lowercase o, lowercase g, lowercase i, capital H, lowercase u, lowercase b) and "LOGISTICS OPERATIONS" in all caps`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

  console.log('Calling Gemini 2.5 Flash Image for LogiHub icon...');
  const body = {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.7,
      imageConfig: { aspectRatio: '1:1' }
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

  let masterBuf = null;
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) { masterBuf = Buffer.from(inline.data, 'base64'); break; }
  }
  if (!masterBuf) { console.error('no image returned'); process.exit(1); }

  const outDir = path.join(__dirname, '..', 'public', 'img');
  fs.mkdirSync(outDir, { recursive: true });

  const masterPath = path.join(outDir, 'logihub-icon-master.png');
  fs.writeFileSync(masterPath, masterBuf);
  console.log('saved master', masterPath, masterBuf.length, 'bytes');

  const base = await sharp(masterBuf).resize(1024, 1024, { fit: 'cover' }).png().toBuffer();

  const sizes = [
    { file: 'logihub-icon-1024.png', size: 1024 },
    { file: 'logihub-icon-512.png', size: 512 },
    { file: 'logihub-icon-192.png', size: 192 },
    { file: 'logihub-icon-180.png', size: 180 },
    { file: 'logihub-icon-64.png',  size: 64  }
  ];
  for (const s of sizes) {
    const out = path.join(outDir, s.file);
    await sharp(base).resize(s.size, s.size, { fit: 'cover' }).png({ compressionLevel: 9 }).toFile(out);
    const stat = fs.statSync(out);
    console.log('saved', s.file, stat.size, 'bytes');
  }
  console.log('done.');
})();
