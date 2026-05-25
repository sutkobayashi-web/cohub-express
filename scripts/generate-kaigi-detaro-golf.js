#!/usr/bin/env node
// かいぎ出太郎 ゴルフスイング・フィニッシュ姿 (Gemini 2.5 Flash Image)
// 既存 kaigi_detarou_icon.png (実写・年配男性) を参照画像として渡し、
// 同一人物のフォトリアルなゴルフ姿を生成する
// 実行: cd /opt/cohub && node scripts/generate-kaigi-detaro-golf.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const REF_FILE = path.join(__dirname, '..', 'public', 'assets', 'kaigi_detarou_icon.png');

const PROMPT = `Photorealistic full-body image of THE EXACT SAME elderly Japanese man as in the attached reference photo (white/silver hair, kind face, dress shirt with ID lanyard around neck). KEEP HIS FACE, HAIRSTYLE, AGE, BODY TYPE 100% IDENTICAL to the reference - this is the same person, just shown in a different pose.

He is a friendly senior corporate employee, the company mascot character "かいぎ出太郎 (Kaigi Detarou)".

POSE (CRITICAL):
He has just finished a powerful golf DRIVER swing. This is the FINISH POSE of a right-handed golf swing:
- Body fully rotated to face the LEFT side (toward the target/ball flight direction)
- Hands held HIGH up by his LEFT ear/shoulder, gripping a driver (long graphite shaft, large silver clubhead)
- The driver shaft is wrapped down behind his back, clubhead hanging down behind his left shoulder
- Weight 100% on left foot, right foot up on toe with the back of the heel showing
- Belt buckle clearly faces toward the target (LEFT side of the frame)
- His face has a satisfied, proud smile, eyes following the imagined ball flying off to the left
- He is wearing his usual white dress shirt and slacks (or smart polo + slacks), with the company ID lanyard still around his neck
- Standing on green grass of a golf course in the early morning

ON TOP OF HIS HEAD:
One small fluffy yellow baby CHICK (ヒヨコ) is perched right on top of his white hair. The chick is tiny (about 1/4 the size of his head), bright yellow fluffy feathers, tiny orange beak, beady black eyes, with its little wings spread out in surprise/joy as if it got launched by the swing power. ONE CHICK ONLY, sitting upright on the very top of his head.

STYLE:
- PHOTOREALISTIC, professional sports photography quality
- NOT anime, NOT illustration, NOT cartoon - this must look like a real photograph of a real elderly man
- Soft natural directional light from the upper-left
- Background MUST be 100% PURE SOLID WHITE (#FFFFFF), perfectly uniform, no gradient, no texture, no grass, no sky, no shadow on background, no golf course, no trees
- A very soft small elliptical shadow directly under the feet is OK, but it must be on the pure white background (just a soft grey ellipse touching the soles)
- Vertical 2:3 portrait orientation, full body visible from chick on head down to feet
- Subject centered with comfortable margin on all sides (about 10% padding)

ABSOLUTELY DO NOT:
- Do not draw anime or cartoon style
- Do not show any text, speech bubbles, words, or logos anywhere in the image
- Do not change his face, hair color, or age from the reference
- Do not add other people
- Do not show more than ONE chick
- Do not include any background scenery (no grass, no sky, no trees, no golf course, no clouds, no walls)
- Background must be uniform pure white #FFFFFF, ready for chroma-key style background removal`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(REF_FILE)) { console.error('Reference image not found:', REF_FILE); process.exit(1); }

  const refB64 = fs.readFileSync(REF_FILE).toString('base64');
  const outFile = path.join(__dirname, '..', 'public', 'assets', 'kaigi_detarou_golf.png');
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
        { inlineData: { mimeType: 'image/png', data: refB64 } },
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

  // 一旦RAWを保存 → 四隅flood-fillで白背景透過化
  const rawFile = outFile + '.raw.png';
  fs.writeFileSync(rawFile, buf);
  console.log('raw saved:', rawFile, buf.length, 'bytes');

  console.log('Applying four-corner flood-fill transparency...');
  const { PNG } = require('pngjs');
  const png = PNG.sync.read(fs.readFileSync(rawFile));
  const { width, height, data } = png;
  const visited = new Uint8Array(width * height);
  const TOL = 32; // 白(#FFFFFF)から各チャネルこの差以内なら背景扱い
  const isBg = (idx) => {
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    return r >= 255 - TOL && g >= 255 - TOL && b >= 255 - TOL;
  };
  // BFS from corners
  const stack = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const pi = y * width + x;
    if (visited[pi]) continue;
    const di = pi * 4;
    if (!isBg(di)) continue;
    visited[pi] = 1;
    data[di + 3] = 0; // alpha = 0
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  // 縁にうっすら残る半透明白を均す(ソフト境界)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pi = y * width + x;
      if (visited[pi]) continue;
      const di = pi * 4;
      const r = data[di], g = data[di + 1], b = data[di + 2];
      // 白に近いピクセルでvisited隣接 → alpha減衰
      if (r >= 240 && g >= 240 && b >= 240) {
        // 上下左右いずれかvisitedなら半透明
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
