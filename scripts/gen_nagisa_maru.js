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

POSE (CRITICAL — follow exactly): Both arms are raised above her head and CURVED so that the TWO HANDS MEET AND TOUCH at the very top of the arc. The fingertips (or palms) of the left hand physically TOUCH the fingertips of the right hand. Her two arms plus her hands form ONE BIG ROUND CLOSED RING (the letter O) above her head — the classic Japanese "maru" (○ = correct / good) gesture, the same shape a gymnast or a quiz-show contestant makes for "correct answer".
- The two arms must draw a WIDE ROUND ARCH like a RAINBOW or a big balloon. Elbows are pushed far OUT to the sides (wider than her shoulders) and clearly BENT, and the wrists are bent so the hands curve inward to meet at the top center.
- The enclosed empty space inside the ring should be a wide ROUND oval, clearly wider than her head.
- The ring must be CLOSED: there must be NO GAP between the two hands.
- ABSOLUTELY NOT a triangle or roof shape with straight arms. NOT two separate raised hands. NOT two small "OK" finger rings. NOT a heart shape. NOT a peace sign. NOT straight arms in a V shape.

EXPRESSION: bright, happy, beaming smile with eyes slightly narrowed in a genuine smile, looking straight at the viewer. Cheerful and congratulating, as if saying "よくできました!".

BODY PROPORTIONS (CRITICAL): Natural, correct, realistic human proportions. Her upper arms and forearms must be NORMAL LENGTH — do NOT stretch or elongate the arms.
- Elbows are BENT to roughly 90 degrees, so the ring sits LOW and CLOSE to her head, resting just above her hair.
- The gap between the top of her head and her touching hands must be only about HALF a head height. The hands must NOT float high above her.
- The arms hug close around her head, making a small compact round ring — like a person making "maru" right on top of their head.
- No distortion, no extra-long limbs, no thin stretched forearms.

FRAMING: TIGHT BUST-UP composition — visible from the middle of the chest upward only (chest, shoulders, neck, head) plus the raised arms. Her head should be large in the frame. The closed ring made by her arms must be fully inside the frame — DO NOT crop the hands. Leave only about 5% padding above her hands.

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
