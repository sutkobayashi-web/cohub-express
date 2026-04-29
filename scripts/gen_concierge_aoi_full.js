#!/usr/bin/env node
// 受付AI 葵 (全身、ロゴを紹介する presenting gesture) を Gemini 2.5 Flash Image で生成
// 旧: タブレットを持つ立ち姿 → 新: 横に手を伸ばしたロゴ紹介ポーズ
// 出力: public/assets/concierge_aoi_full.png (差替) + 既存をbackup

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const PROMPT = `Full body standing figure of professional Japanese corporate receptionist 葵 (Aoi), photorealistic style.
Young woman, 25-30 years old, friendly warm smile, dark brown shoulder-length hair tied neatly into a low ponytail with a few wisps framing her face, subtle natural makeup.
Wearing a CRISP NAVY BLAZER over a white silk blouse, navy pencil skirt just below knees, sheer beige stockings, navy closed-toe pumps. Small gold name pin on lapel (no text).

POSE (CRITICAL): She is performing a welcoming PRESENTING GESTURE - one arm extended OUT TO HER SIDE at chest-to-waist height, palm open and slightly upward, fingers gently spread, as if she is INTRODUCING or POINTING TO something next to her ("please look at this" / "see this here" gesture). The other arm is relaxed at her side. Her body slightly turned ~10 degrees toward the gesture direction. Friendly facial expression looking directly at the viewer with a slight nod, professional and welcoming smile.
ABSOLUTELY NOT a hand-on-chest pose. NOT a praying pose. NOT crossed arms. The arm must clearly extend outward to the side at horizontal angle.

Front-facing 3/4 view, full body visible from head to feet, centered in frame.
Pure white background (#FFFFFF), small soft elliptical floor shadow directly beneath feet.
2:3 portrait aspect ratio.

CRITICAL CONSTRAINTS:
- Photorealistic professional corporate photography quality, NOT anime, NOT illustration
- NO text, NO logos, NO words anywhere on clothing or background
- NO other people, NO furniture
- Clear "presenting / introducing" arm gesture (NOT hand on chest, NOT crossed arms, NOT both hands together)
- Welcoming, professional, polished corporate receptionist atmosphere
- SAME CHARACTER VIBE as a previous Aoi version: kind face, dark brown ponytail hair, navy corporate uniform`;

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
  const outFile = path.join(__dirname, '..', 'public', 'assets', 'concierge_aoi_full.png');
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
