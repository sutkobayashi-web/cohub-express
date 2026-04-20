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

const PROMPT = `A clean, modern mobile app icon for "CoHub" - a virtual office collaboration platform.
Square format, exactly 1:1 aspect ratio.

Design: A bold, stylized "Co" monogram in pure white, centered on a vivid radial gradient background.
Background gradient: from deep navy (#0f172a) at the corners, through royal blue (#1e40af) in the middle ring, to bright cyan (#06b6d4) at the center, creating a soft glow behind the monogram.
The "Co" letters: bold, geometric sans-serif, tightly kerned, slightly rounded corners, with a very subtle white inner glow, occupying about 45% of the icon width, perfectly centered.

Style: flat design with subtle depth, premium feel, friendly yet professional, suitable for a corporate productivity app.

CRITICAL constraints:
- Plain gradient background only - NO scenes, NO buildings, NO people, NO additional shapes or decorations
- All visual content must stay within the center 80% (safe zone for Android maskable adaptive icons)
- The only text is the "Co" monogram - absolutely no other letters, words, or numbers
- Must remain clearly readable when scaled down to 32x32 pixels
- No drop shadow that extends beyond the canvas edges
- Do not add a frame or border
- Background must reach all four edges of the canvas`;

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
