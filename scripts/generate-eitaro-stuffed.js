#!/usr/bin/env node
// 栄太郎 (実写・濃紺ジャケットの男性) が「食べ過ぎてお腹一杯」のジェスチャー
// eitaro_ref.jpg を参照画像として Gemini に渡し、同一人物のフォトリアル生成
// 出力: public/assets/eitaro_stuffed.png (背景透過)
// 実行: cd /opt/cohub && node scripts/generate-eitaro-stuffed.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const REF_FILE = path.join(__dirname, '..', 'public', 'assets', 'eitaro_ref.jpg');

const PROMPT = `Photorealistic full-body image of THE EXACT SAME middle-aged Japanese man shown in the attached reference photo. KEEP HIS FACE, HAIR, BUILD, AGE 100% IDENTICAL to the reference - same person, just shown in a different pose and without the mask. (You may remove the white mask so his full face is visible, but keep all his facial features identical to the reference.)

He is "栄太郎 (Eitaro)", a friendly Japanese senior employee. He is wearing the SAME outfit as in the reference: dark navy blue work jacket (作業ジャケット) over a polo or shirt, with black work pants, and dark sneakers.

POSE (CRITICAL — "ate too much / stuffed belly" gesture):
He has just finished a very big meal and is satisfied to the point of being overfull. Show this clearly with EVERY single one of the following details:
- Both hands placed flat on his stomach/belly, palms pressing gently against his round full belly
- Belly slightly puffed/rounded out (subtly, as if his stomach is full — not exaggerated cartoon belly, just clearly full)
- His head is tilted slightly back with eyes half-closed in blissful "ごちそうさま" satisfaction
- Mouth in a contented closed-mouth smile, perhaps a slight "ふぅ〜" exhale
- Slight backwards lean of upper body, knees slightly bent for "I am SO full" body language
- Standing pose, both feet on the ground, body facing roughly the viewer (slight 3/4 angle is fine)
- Full body visible from the top of his head down to his shoes

STYLE:
- PHOTOREALISTIC, natural lifestyle photography
- NOT anime, NOT illustration, NOT cartoon — must look like a real candid photo of the real man
- Soft natural directional light from upper-left
- Background MUST be 100% PURE SOLID WHITE (#FFFFFF), perfectly uniform, no gradient, no texture, no shadows on the background, no furniture, no scenery, no walls
- A very soft small elliptical shadow directly under his feet on the white background is OK
- Vertical 2:3 portrait orientation, centered with ~10% padding on all sides

ABSOLUTELY DO NOT:
- Do not draw anime or cartoon style
- Do not show food, plates, tables, or a restaurant
- Do not show any text, speech bubbles, words, or logos
- Do not change his face, hair, age, or body type from the reference
- Do not add other people
- Do not include any background scenery (no walls, no floor pattern, no street)
- Background must be uniform pure white #FFFFFF for chroma-key background removal`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(REF_FILE)) { console.error('Reference image not found:', REF_FILE); process.exit(1); }

  const refMime = REF_FILE.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const refB64 = fs.readFileSync(REF_FILE).toString('base64');
  const outFile = path.join(__dirname, '..', 'public', 'assets', 'eitaro_stuffed.png');
  try {
    if (fs.existsSync(outFile)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.copyFileSync(outFile, outFile + '.bak.' + ts);
      console.log('backup:', outFile + '.bak.' + ts);
    }
  } catch (e) {}

  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType: refMime, data: refB64 } },
      ]
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.85,
      imageConfig: { aspectRatio: '2:3' },
    },
  };
  console.log('Calling Gemini with reference image...');
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error('HTTP', r.status, (await r.text()).slice(0, 600)); process.exit(1); }
  const d = await r.json();
  const parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
  if (!parts) { console.error('no parts'); process.exit(1); }

  let buf = null;
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) { buf = Buffer.from(inline.data, 'base64'); break; }
  }
  if (!buf) { console.error('no image returned'); process.exit(1); }

  const rawFile = outFile + '.raw.png';
  fs.writeFileSync(rawFile, buf);
  console.log('raw saved:', rawFile, buf.length, 'bytes');

  console.log('Applying four-corner flood-fill transparency...');
  const { PNG } = require('pngjs');
  const png = PNG.sync.read(fs.readFileSync(rawFile));
  const { width, height, data } = png;
  const visited = new Uint8Array(width * height);
  const TOL = 32;
  const isBg = (idx) => {
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    return r >= 255 - TOL && g >= 255 - TOL && b >= 255 - TOL;
  };
  const stack = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const pi = y * width + x;
    if (visited[pi]) continue;
    const di = pi * 4;
    if (!isBg(di)) continue;
    visited[pi] = 1;
    data[di + 3] = 0;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pi = y * width + x;
      if (visited[pi]) continue;
      const di = pi * 4;
      const r = data[di], g = data[di + 1], b = data[di + 2];
      if (r >= 240 && g >= 240 && b >= 240) {
        const neighbors = [[1,0],[-1,0],[0,1],[0,-1]];
        let touchesBg = false;
        for (const [dx, dy] of neighbors) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (visited[ny * width + nx]) { touchesBg = true; break; }
        }
        if (touchesBg) data[di + 3] = Math.round(((Math.min(r, g, b) - 240) / 15) * 255);
      }
    }
  }
  fs.writeFileSync(outFile, PNG.sync.write(png));
  console.log('saved transparent:', outFile, fs.statSync(outFile).size, 'bytes');
})();
