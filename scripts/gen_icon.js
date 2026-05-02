#!/usr/bin/env node
// CoHub アプリアイコンを Gemini 2.5 Flash Image で生成し、必要サイズへ書き出す
// 使い方: node scripts/gen_icon.js
// 出力:
//   public/img/icon-master.png (1024)
//   public/img/icon-512.png
//   public/img/icon-192.png
//   public/img/apple-touch-icon.png (180)
//   public/img/favicon-32.png
//   public/img/favicon-16.png
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PROMPT = `A clean, modern mobile app icon for "CoWell" - Communication & Wellness platform.
Square format, exactly 1:1 aspect ratio.

Design layout (top to bottom, all centered horizontally):
1. The brand wordmark "CoWell" in pure white, bold geometric sans-serif, slightly rounded corners, tightly kerned, occupying about 55% of the icon width, positioned in the upper-middle area of the icon.
2. A thin elegant white horizontal divider line below "CoWell" (about 35% width, 2-3px thick, 60% opacity).
3. Below the divider, the tagline "Communication & Wellness" in a smaller, clean sans-serif uppercase, white at 80% opacity, letter-spaced slightly, occupying about 65% of the icon width.

Background: vivid radial gradient — from deep navy (#0f172a) at the corners, through royal blue (#1e40af) in the middle ring, to a soft teal-cyan (#06b6d4) glow at the center behind the wordmark.
Subtle accent: a faint mint-green (#10b981) inner glow around the "CoWell" letters to hint at the wellness aspect.

Style: flat design with subtle depth, premium feel, friendly yet professional, suitable for a corporate productivity + health app.

CRITICAL constraints:
- Plain gradient background only - NO scenes, NO buildings, NO people, NO icons, NO additional decorations
- All text and visual content must stay within the center 80% (safe zone for Android maskable adaptive icons)
- ONLY the texts "CoWell" and "Communication & Wellness" appear - no other letters, words, or numbers
- "CoWell" must remain clearly readable when scaled to 64x64 pixels (the tagline may become unreadable at small sizes, that's OK)
- No drop shadow that extends beyond the canvas edges
- Do not add a frame or border
- Background must reach all four edges of the canvas
- Spell exactly: "CoWell" (capital C, lowercase o, capital W, lowercase e, lowercase l, lowercase l) and "Communication & Wellness" with a literal ampersand`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

  console.log('Calling Gemini 2.5 Flash Image...');
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

  const masterPath = path.join(outDir, 'icon-master.png');
  fs.writeFileSync(masterPath, masterBuf);
  console.log('saved master', masterPath, masterBuf.length, 'bytes');

  // 1024 にリサイズしてから各サイズを書き出す
  const base = await sharp(masterBuf).resize(1024, 1024, { fit: 'cover' }).png().toBuffer();

  const sizes = [
    { file: 'icon-512.png', size: 512 },
    { file: 'icon-192.png', size: 192 },
    { file: 'apple-touch-icon.png', size: 180 },
    { file: 'favicon-32.png', size: 32 },
    { file: 'favicon-16.png', size: 16 }
  ];
  for (const s of sizes) {
    const out = path.join(outDir, s.file);
    await sharp(base).resize(s.size, s.size, { fit: 'cover' }).png({ compressionLevel: 9 }).toFile(out);
    const stat = fs.statSync(out);
    console.log('saved', s.file, stat.size, 'bytes');
  }
  console.log('done.');
})();
