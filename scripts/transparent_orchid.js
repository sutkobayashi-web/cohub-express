#!/usr/bin/env node
// 胡蝶蘭PNGの白背景を四隅flood-fillで透過化
// 入力: public/assets/orchid_white.png  出力: 同じファイルを上書き
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const FILE = path.join(__dirname, '..', 'public', 'assets', 'orchid_white.png');
const TOL = 18;  // 「ほぼ白」と判定する閾値 (R/G/B 各255-TOL以上)

const buf = fs.readFileSync(FILE);
const png = PNG.sync.read(buf);
const { width, height, data } = png;
const visited = new Uint8Array(width * height);

function isNearWhite(idx) {
  return data[idx] >= 255 - TOL && data[idx + 1] >= 255 - TOL && data[idx + 2] >= 255 - TOL;
}

const stack = [];
function seed(x, y) { if (x >= 0 && x < width && y >= 0 && y < height) stack.push(x, y); }
seed(0, 0); seed(width - 1, 0); seed(0, height - 1); seed(width - 1, height - 1);

while (stack.length) {
  const y = stack.pop(); const x = stack.pop();
  const k = y * width + x;
  if (visited[k]) continue;
  const idx = k * 4;
  if (!isNearWhite(idx)) continue;
  visited[k] = 1;
  data[idx + 3] = 0;  // alpha = 0
  if (x > 0) stack.push(x - 1, y);
  if (x < width - 1) stack.push(x + 1, y);
  if (y > 0) stack.push(x, y - 1);
  if (y < height - 1) stack.push(x, y + 1);
}

const out = PNG.sync.write(png);
fs.writeFileSync(FILE, out);
console.log('transparent', FILE, out.length, 'bytes');
