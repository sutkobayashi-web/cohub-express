#!/usr/bin/env node
// 健康管理室 ヘルスアドバイザー (女性看護師) を Gemini 2.5 Flash Image で生成
// ポーズ: ホワイトボードを紹介するように一方の手を横に開いた welcoming presenting gesture
// 出力: public/assets/concierge_health_full.png (差替) + 既存をbackup
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const PROMPT = `Full body standing figure of professional Japanese clinic health advisor / nurse, photorealistic style.
Young woman, late 20s to early 30s, kind warm smile, shoulder-length dark brown hair tied neatly into a low ponytail,
wearing CLEAN LIGHT BLUE SCRUB TOP (medical scrub uniform) with small chest pocket holding a pen, matching light blue scrub pants, white slip-on nursing shoes, small ID badge clipped at chest area (no readable text on badge).

POSE (CRITICAL): She is performing a welcoming PRESENTING GESTURE - one arm extended OUT TO HER SIDE at chest-to-waist height, palm open and slightly upward, fingers gently spread, as if she is INTRODUCING or POINTING TO something next to her ("please look at this" / "see this here" gesture). The other arm is relaxed at her side. Her body slightly turned ~10 degrees toward the gesture direction. Friendly facial expression looking directly at the viewer with a slight nod.
ABSOLUTELY NOT a hand-on-chest pose. NOT a praying pose. The arm must clearly extend outward to the side.

Front-facing 3/4 view, full body visible from head to feet, centered in frame.
Pure white background (#FFFFFF), small soft elliptical floor shadow directly beneath feet.
2:3 portrait aspect ratio.

CRITICAL CONSTRAINTS:
- Photorealistic professional photography quality, NOT anime, NOT illustration
- NO text, NO logos, NO words anywhere
- NO other people
- Clear "presenting / introducing" arm gesture (NOT hand on chest, NOT crossed arms, NOT both hands together)
- Inviting, calm, professional, trustworthy atmosphere`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  const outFile = path.join(__dirname, '..', 'public', 'assets', 'concierge_health_full.png');
  // backup
  try {
    if (fs.existsSync(outFile)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.copyFileSync(outFile, outFile + '.bak.' + ts);
    }
  } catch (e) {}
  const body = {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.85,
      imageConfig: { aspectRatio: '2:3' },
    },
  };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error('HTTP', r.status, await r.text()); process.exit(1); }
  const d = await r.json();
  const parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
  if (!parts) { console.error('no parts'); process.exit(1); }
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      fs.writeFileSync(outFile, Buffer.from(inline.data, 'base64'));
      console.log('saved', outFile, Buffer.from(inline.data, 'base64').length, 'bytes');
      return;
    }
  }
  console.error('no image returned');
  process.exit(1);
})();
