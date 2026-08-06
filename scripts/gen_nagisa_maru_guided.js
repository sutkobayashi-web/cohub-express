#!/usr/bin/env node
// なぎさの ○(まる)ポーズを【下絵つき】で生成する。
// ⚠️言葉だけでは腕の長さが直らなかった(肘90度/頭半分の高さ 等を書いても腕が長いまま)ため、
//   PILで描いた棒人間の下絵(pose_guide.png)を2枚目の画像として渡し、腕の幾何だけを真似させる。
// 実行: cd /opt/cohub && node scripts/gen_nagisa_maru_guided.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const REF_FILE = path.join(__dirname, '..', 'public', 'assets', 'advisor_still.png');   // 人物(顔・服)の正
const GUIDE_FILE = path.join(__dirname, 'pose_guide.png');                              // ポーズの正
const OUT_FILE = path.join(__dirname, '..', 'public', 'assets', 'nagisa_maru.png');

const PROMPT = `You are given TWO images.

IMAGE 1 = the PERSON reference: a photorealistic Japanese female health advisor (nurse) in a light blue medical scrub top. Copy her identity from this image: same face, same short dark brown hair, same light blue scrub top with the chest pocket and ID badge.

IMAGE 2 = the POSE GUIDE: a simple stick-figure diagram. Copy the GEOMETRY OF THE ARMS from this diagram EXACTLY:
- The elbows are pushed OUT to the sides, roughly at the same height as her eyes, and clearly BENT.
- The forearms come back INWARD and UPWARD so both hands meet and TOUCH just above the top of her head.
- The gap between the top of her head and her touching hands is SMALL — about half the height of her head. The hands must NOT be far above her head.
- The upper arm and the forearm are the SAME SHORT LENGTH as in the diagram. Do NOT lengthen them.
- Together, her two arms and her head fill one rounded "maru" (○) shape — the Japanese sign for "correct / good".

Generate ONE photorealistic image of the woman from IMAGE 1 performing the pose from IMAGE 2.

EXPRESSION: bright, happy, beaming smile, looking straight at the viewer, as if congratulating ("よくできました!").

FRAMING: waist-up, centred, whole ring and both elbows fully inside the frame with a little padding.

BACKGROUND: pure solid white (#FFFFFF), no props, no floor.

CRITICAL:
- Photorealistic photography, NOT anime, NOT illustration, NOT a drawing. Do NOT copy the stick-figure look — the diagram is ONLY for the arm geometry.
- Natural human proportions. Arms must look SHORT and compact, never stretched.
- NO text, NO logos, NO other people.`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  for (const f of [REF_FILE, GUIDE_FILE]) {
    if (!fs.existsSync(f)) { console.error('not found:', f); process.exit(1); }
  }
  if (fs.existsSync(OUT_FILE)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(OUT_FILE, OUT_FILE + '.bak.' + ts);
    console.log('backup:', OUT_FILE + '.bak.' + ts);
  }
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType: 'image/png', data: fs.readFileSync(REF_FILE).toString('base64') } },
        { inlineData: { mimeType: 'image/png', data: fs.readFileSync(GUIDE_FILE).toString('base64') } },
      ],
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.3,
      imageConfig: { aspectRatio: '1:1' },
    },
  };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
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
