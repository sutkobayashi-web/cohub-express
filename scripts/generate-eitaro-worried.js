#!/usr/bin/env node
// 栄太郎 (実写・濃紺ジャケットの男性) が「悩んでいる/思案中」のポーズ
// eitaro_ref.jpg を参照画像として Gemini に渡し、同一人物のフォトリアル生成
// 出力: public/assets/eitaro_worried.png (背景透過)
// 実行: cd /opt/cohub && node scripts/generate-eitaro-worried.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const REF_FILE  = path.join(__dirname, '..', 'public', 'assets', 'eitaro_ref.jpg');
// 既存の満腹版は顔がよく出ているので識別アンカーとして併用
const REF_FILE2 = path.join(__dirname, '..', 'public', 'assets', 'eitaro_stuffed.png');

const PROMPT = `Photorealistic full-body image of THE EXACT SAME middle-aged Japanese man shown in BOTH attached reference photos. The SECOND reference (eitaro_stuffed.png) shows his face most clearly — TREAT IT AS THE GROUND TRUTH FOR HIS FACE, HAIR, GLASSES (if any), SKIN TONE, AGE, AND BUILD. The first reference (eitaro_ref.jpg) shows him wearing a mask but in his actual workplace outfit. Generate the SAME PERSON shown in both photos — match the face from the second reference EXACTLY.

He is "栄太郎 (Eitaro)", a friendly Japanese senior employee. He is wearing the SAME outfit as in the reference: dark navy blue work jacket (作業ジャケット) over a polo or shirt, with black work pants, and dark sneakers.

POSE (CRITICAL — "worried / troubled / thinking hard" gesture, 悩んでいる/困っている):
He is troubled by a concern and clearly worried. Show this clearly with EVERY single one of the following details:
- ONE hand raised to the side of his head: palm/fingers touching his temple or the back of his head, fingers slightly clenched as if he is scratching his head out of trouble
- THE OTHER hand: either crossed in front holding the opposite elbow, OR hanging down with palm facing slightly outward — keep it relaxed and visible
- Eyebrows pulled together into a clear furrowed-brow worried expression (困り顔)
- Mouth in a slight frown or a wavy uncertain "うーん…" closed-mouth line
- Eyes looking down-and-to-the-side, not at the camera, as if lost in thought
- Head tilted slightly downward and to one side, shoulders slightly dropped
- Subtle forward stoop of upper body, conveying "what should I do…" body language
- Standing pose, both feet on the ground, body facing roughly the viewer (slight 3/4 angle is fine)
- Full body visible from the top of his head down to his shoes

CHICK ON HEAD (CRITICAL — must be included):
- A single small fluffy baby chick (ひな鳥/ヒヨコ) is sitting calmly on the very top of his head
- The chick is a round, fluffy, bright yellow body with tiny orange beak, tiny orange feet, and small round black eyes
- The chick is sized about 1/4 of his head's width — small and cute, not exaggerated
- The chick sits naturally on his hair as if perched there, contrasting his worried expression
- The ENTIRE chick (head to feet) must be visible inside the image frame — DO NOT crop the chick at the top edge
- Leave ~12% padding above the chick so its full body is in frame
- Only ONE chick, exactly one — not multiple, not zero

STYLE:
- PHOTOREALISTIC, natural lifestyle photography
- NOT anime, NOT illustration, NOT cartoon — must look like a real candid photo of the real man
- Soft natural directional light from upper-left
- Background MUST be 100% PURE SOLID WHITE (#FFFFFF), perfectly uniform, no gradient, no texture, no shadows on the background, no furniture, no scenery, no walls
- A very soft small elliptical shadow directly under his feet on the white background is OK
- Vertical 2:3 portrait orientation, centered with ~10% padding on all sides

ABSOLUTELY DO NOT:
- Do not draw anime or cartoon style (the chick may be slightly stylized but should look like a real fluffy chick)
- Do not show any other objects (no phone, no documents, no money) — pose + chick only
- Do not show any text, speech bubbles, words, or logos
- Do not change his face, hair, age, or body type from the reference
- Do not add other people
- Do not add more than one chick — exactly ONE
- Do not crop the chick — its entire body must be inside the frame
- Do not include any background scenery (no walls, no floor pattern, no street)
- Background must be uniform pure white #FFFFFF for chroma-key background removal
- Do not make him look angry or crying — just worried/troubled/perplexed`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(REF_FILE)) { console.error('Reference image not found:', REF_FILE); process.exit(1); }
  if (!fs.existsSync(REF_FILE2)) { console.error('Reference image not found:', REF_FILE2); process.exit(1); }

  const refMime = REF_FILE.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const refB64 = fs.readFileSync(REF_FILE).toString('base64');
  const ref2Mime = REF_FILE2.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const ref2B64 = fs.readFileSync(REF_FILE2).toString('base64');
  const outFile = path.join(__dirname, '..', 'public', 'assets', 'eitaro_worried.png');
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
        { inlineData: { mimeType: ref2Mime, data: ref2B64 } },
      ]
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.55,
      imageConfig: { aspectRatio: '2:3' },
    },
  };
  console.log('Calling Gemini with 2 reference images (masked + stuffed)...');
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
