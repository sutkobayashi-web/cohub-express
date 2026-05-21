#!/usr/bin/env node
// 承認済みの「悩み栄太郎」画像 (eitaro_worried.png.bak.<timestamp>) を入力に、
// 頭頂部に黄色いヒヨコ1羽だけ合成する。ポーズ・顔・服装・背景は完全維持。
// 実行: cd /opt/cohub && node scripts/add-chick-to-worried.js <backup_filename>

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SRC_ARG = process.argv[2];
if (!SRC_ARG) {
  console.error('Usage: node scripts/add-chick-to-worried.js <backup_filename_in_public/assets>');
  process.exit(1);
}
const SRC_FILE = path.join(__dirname, '..', 'public', 'assets', SRC_ARG);
const OUT_FILE = path.join(__dirname, '..', 'public', 'assets', 'eitaro_worried.png');

const PROMPT = `You are given a photorealistic image of a worried middle-aged Japanese man (栄太郎) standing on a pure white background, one hand on his temple in a troubled "うーん…" pose.

ADD EXACTLY ONE small fluffy baby chick (ひな鳥/ヒヨコ) sitting calmly on the very top of his head. Specifications:
- Single chick only — exactly one
- Round, fluffy, bright yellow body, tiny orange beak, tiny orange feet, small round black eyes
- Sized about 1/4 of his head's width — small and cute, not exaggerated
- Sits naturally on his hair as if perched there
- The ENTIRE chick (head to feet) must be inside the frame — DO NOT crop the chick at the top edge. If needed, slightly shift the man downward so there is ~12% padding above the chick.

PRESERVATION REQUIREMENTS (CRITICAL):
- DO NOT change the man's face, hair, glasses, expression, clothing, hand position, body lean, leg stance, or anything else about him.
- DO NOT change the white background — keep it pure solid white #FFFFFF for chroma-key.
- DO NOT add any text, speech bubbles, hats, extra props, other animals, or extra people.
- DO NOT change the aspect ratio or framing of the man — only add the chick on top and adjust crop padding if necessary.
- DO NOT recolor the photo.`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(SRC_FILE)) { console.error('Source not found:', SRC_FILE); process.exit(1); }

  const srcMime = SRC_FILE.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png';
  const srcB64 = fs.readFileSync(SRC_FILE).toString('base64');

  // 既存出力をバックアップ
  if (fs.existsSync(OUT_FILE)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(OUT_FILE, OUT_FILE + '.bak.' + ts);
    console.log('backup:', OUT_FILE + '.bak.' + ts);
  }

  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType: srcMime, data: srcB64 } },
      ]
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.4,
      imageConfig: { aspectRatio: '2:3' },
    },
  };
  console.log('Calling Gemini to add a chick on the head...');
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

  const rawFile = OUT_FILE + '.raw.png';
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
  fs.writeFileSync(OUT_FILE, PNG.sync.write(png));
  console.log('saved transparent:', OUT_FILE, fs.statSync(OUT_FILE).size, 'bytes');
})();
