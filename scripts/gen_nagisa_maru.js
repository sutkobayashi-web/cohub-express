#!/usr/bin/env node
// 「よい一皿です」のサムネに載せる なぎさ(ヘルスアドバイザー)の ○(友達の輪) ポーズを生成する。
// 入力に既存の advisor_still.png を渡して、同一人物・同じ水色スクラブを保つ。
// 実行: cd /opt/cohub && node scripts/gen_nagisa_maru.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SRC_FILE = path.join(__dirname, '..', 'public', 'assets', 'advisor_still.png');
const OUT_FILE = path.join(__dirname, '..', 'public', 'assets', 'nagisa_maru.png');

const PROMPT = `You are given a photorealistic reference image of a Japanese female health advisor (nurse) in a light blue medical scrub top.

Generate a NEW image of the SAME WOMAN — same face, same hairstyle (short dark brown bob), same light blue scrub top with the small chest pocket and ID badge — with this change:

POSE (CRITICAL — follow exactly): The Japanese TV "tomodachi no wa" (友達の輪) gesture, made IN FRONT OF HER CHEST — NOT above her head.
- Both arms are held IN FRONT of her body at chest height, elbows bent and kept CLOSE TO HER SIDES, forearms curving inward.
- The fingertips of both hands TOUCH each other, so the two arms form ONE ROUND CLOSED RING (a big letter O) in front of her chest.
- The ring is centred in front of her chest, roughly the width of her shoulders. Her smiling face is clearly visible ABOVE the ring — the ring must NOT cover her face.
- Because the arms are bent and held in front, only a SHORT length of arm is visible. This is important: the arms must look naturally short and compact, never long or stretched.
- ABSOLUTELY NOT arms raised above the head. NOT straight arms. NOT a heart shape. NOT a peace sign. NOT two separate "OK" finger rings.

EXPRESSION: bright, happy, beaming smile with eyes slightly narrowed in a genuine smile, looking straight at the viewer. Cheerful and congratulating, as if saying "よくできました!".

BODY PROPORTIONS (CRITICAL): Natural, correct, realistic human proportions. Normal arm length for her body — no stretched or elongated limbs, no thin distorted forearms.

FRAMING: WAIST-UP composition — visible from the waist upward, centred. Her head and the ring in front of her chest are both fully inside the frame with a little padding all around. DO NOT crop her hands or elbows.

BACKGROUND: pure solid white (#FFFFFF), no props, no floor, no shadow other than a very soft one behind her.

CRITICAL CONSTRAINTS:
- Photorealistic professional photography quality, NOT anime, NOT illustration
- Keep the SAME PERSON as the reference (same face, same hair, same uniform)
- NO text, NO logos, NO letters, NO numbers anywhere in the image
- NO other people, NO food, NO plates
- Both arms must clearly form ONE closed circle above the head (not a heart shape, not a peace sign, not thumbs up)`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  if (!fs.existsSync(SRC_FILE)) { console.error('Source not found:', SRC_FILE); process.exit(1); }

  const srcB64 = fs.readFileSync(SRC_FILE).toString('base64');

  if (fs.existsSync(OUT_FILE)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(OUT_FILE, OUT_FILE + '.bak.' + ts);
    console.log('backup:', OUT_FILE + '.bak.' + ts);
  }

  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType: 'image/png', data: srcB64 } },
      ],
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.35,
      imageConfig: { aspectRatio: '1:1' },
    },
  };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error('HTTP', r.status, (await r.text()).slice(0, 600)); process.exit(1); }
  const d = await r.json();
  const parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
  if (!parts) { console.error('no parts'); process.exit(1); }
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      const buf = Buffer.from(inline.data, 'base64');
      fs.writeFileSync(OUT_FILE, buf);
      console.log('saved', OUT_FILE, buf.length, 'bytes');
      return;
    }
  }
  console.error('no image returned');
  process.exit(1);
})();
