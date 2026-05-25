// 須貝さんのアバターにヒヨコを乗せる (Gemini 2.5 Flash Image)
// 実行: node scripts/prank-chick.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config({ path: '/opt/cohub/.env' });

const USER_ID = '0da5798c-335e-42f4-8842-c08630453ffd';
const DB_PATH = '/opt/cohub/server/db/cohub.db';
const UPLOAD_DIR = '/opt/cohub/uploads/avatars';

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('No GEMINI_API_KEY'); process.exit(1); }

  const db = new Database(DB_PATH);
  const prev = db.prepare('SELECT avatar_url, display_name FROM users WHERE id = ?').get(USER_ID);
  if (!prev || !prev.avatar_url) { console.error('User not found or no avatar'); process.exit(1); }
  console.log('Target:', prev.display_name);
  console.log('Current avatar_url:', prev.avatar_url);

  // 常にプランク前の元アバターを基底に使う (チック合成の二重がけを避ける)
  const ORIGINAL = '/opt/cohub/uploads/avatars/0da5798c-335e-42f4-8842-c08630453ffd_cand_cool_1778750511446.png';
  if (!fs.existsSync(ORIGINAL)) { console.error('Original source missing:', ORIGINAL); process.exit(1); }
  const base64 = fs.readFileSync(ORIGINAL).toString('base64');
  console.log('Base image:', ORIGINAL);

  const prompt = `この人物画像をベースに、頭の上にヒヨコ(黄色いふわふわの雛鳥)を**ちょうど3羽**横一列に仲良く並べて乗せてください。

重要な制約:
- 人物の顔・表情・髪型・服装・ポーズ・背景は元のまま完全に維持すること
- ヒヨコは**正確に3羽**、頭頂部に横一列に等間隔で並んで座っている。多すぎず少なすぎず必ず3羽
- 3羽それぞれが少し違うポーズ(正面向き/横向き/見上げる等)で仲良く寄り添う雰囲気
- 各ヒヨコのサイズは人物の頭の幅の約4分の1程度、3羽合わせて頭の幅にちょうど収まる
- **3羽全員の全身(頭から足先まで)が画面フレーム内に完全に収まること。フレーム上端で切れない**
- ヒヨコは丸くてふわふわ、鮮やかな黄色の体、オレンジ色の小さなくちばしと足、つぶらな黒い瞳
- 人物の額や顔は絶対に隠さない
- ヒヨコ以外の要素は何も追加しない (帽子、装飾、テキスト等は不要)
- 元画像のテイスト (アニメ調・色調) を維持
- 正方形フレーム、必要に応じて人物全体を少し下にずらしてでも3羽全員を入れること`;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'image/png', data: base64 } }
      ]
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.85,
    }
  };

  console.log('Calling Gemini...');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error('Gemini error:', resp.status, (await resp.text()).slice(0, 500));
    process.exit(1);
  }
  const data = await resp.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  let imgData = null;
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) { imgData = inline.data; break; }
  }
  if (!imgData) { console.error('No image in response. Response:', JSON.stringify(data).slice(0, 500)); process.exit(1); }

  const ts = Date.now();
  const newFilename = USER_ID + '_cand_chick_' + ts + '.png';
  const newPath = path.join(UPLOAD_DIR, newFilename);
  fs.writeFileSync(newPath, Buffer.from(imgData, 'base64'));
  console.log('Written:', newPath, '(', fs.statSync(newPath).size, 'bytes )');

  const newUrl = '/uploads/avatars/' + newFilename;
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(newUrl, USER_ID);
  console.log('DB updated to:', newUrl);
  console.log('');
  console.log('=== REVERT INFO ===');
  console.log('sqlite3 ' + DB_PATH + " \"UPDATE users SET avatar_url = '" + prev.avatar_url + "' WHERE id = '" + USER_ID + "';\"");
  console.log('rm ' + newPath);
})();
