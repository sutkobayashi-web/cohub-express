// Connect 230 用画像を Gemini 2.5 Flash Image で一括生成
// 実行: node server/scripts/gen_connect230_images.js
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY が設定されていません'); process.exit(1); }

const OUT_DIR = path.join(__dirname, '..', '..', 'public', 'assets', 'walk');
fs.mkdirSync(OUT_DIR, { recursive: true });

const DB_PATH = path.join(__dirname, '..', 'db', 'cohub.db');
const db = new Database(DB_PATH);

// 共通スタイル指示 (一貫性のため)
const STYLE_GUIDE = 'Flat 2D vector illustration style. Soft warm colors. ' +
  'Clear silhouettes, no text labels, no characters in foreground. ' +
  'Bird\'s eye / isometric viewpoint preferred. Square 1:1 aspect ratio. ' +
  'Simple, friendly, suitable for a corporate health app shown to employees of all ages. ' +
  'Background should be light and uncluttered.';

const PROMPTS = [
  // ロゴ
  {
    file: 'logo.png',
    target: 'logo',
    prompt: 'A modern minimalist logo for "Connect 230" - a corporate walking event. ' +
      'The number "230" is the central element, large and bold. ' +
      'Two arrows or stylized footprints curving toward each other from left and right, meeting in the middle. ' +
      'Color palette: deep blue (#0e7490) and emerald green (#047857) with gold accent. ' +
      'Clean, professional, no extra decorations. Square format, white background, high contrast. ' +
      'Designed to look good on tablets and badges.',
  },
  // 道の駅 8箇所
  {
    file: 'milestone_tokyo.png', target: 'milestone', km: 0,
    prompt: 'Tokyo Nihonbashi area: the historical wooden Nihonbashi bridge in the foreground, ' +
      'modern Tokyo skyscrapers (including a stylized Tokyo Tower silhouette) in the background. ' +
      'Daytime, clear sky. ' + STYLE_GUIDE,
  },
  {
    file: 'milestone_yokohama.png', target: 'milestone', km: 28,
    prompt: 'Yokohama port scene: red brick warehouses (赤レンガ倉庫), ' +
      'a docked ship, the Landmark Tower in the background. ' +
      'Bay area, daytime. ' + STYLE_GUIDE,
  },
  {
    file: 'milestone_odawara.png', target: 'milestone', km: 85,
    prompt: 'Odawara Castle (小田原城): a beautiful Japanese castle with white walls and curved roofs, ' +
      'surrounded by pine trees and cherry blossoms, mountains in the background. ' +
      STYLE_GUIDE,
  },
  {
    file: 'milestone_fujioyama.png', target: 'milestone', km: 110,
    prompt: 'Roadside station "Michi-no-eki Fujioyama" with iconic Mt. Fuji prominently in the background, ' +
      'a modern small wooden roadside station building, parking area, surrounded by green hills. ' +
      STYLE_GUIDE,
  },
  {
    file: 'milestone_fujikawa.png', target: 'milestone', km: 140,
    prompt: 'Roadside station "Fujikawa Rakuza" near a flowing river: ' +
      'a large modern wooden roadside complex, Mt. Fuji in the distance behind it, ' +
      'a river (Fujikawa) flowing beside the station. ' +
      STYLE_GUIDE,
  },
  {
    file: 'milestone_utsunoya.png', target: 'milestone', km: 175,
    prompt: 'Utsunoya pass (宇津ノ谷峠): an old Tokaido mountain pass road winding through autumn forest, ' +
      'red and gold maple leaves, stone-paved path, traditional teahouse on the side. ' +
      'Atmospheric, historic. ' + STYLE_GUIDE,
  },
  {
    file: 'milestone_kakegawa.png', target: 'milestone', km: 210,
    prompt: 'Kakegawa: rolling green tea plantation fields with neat rows of tea bushes in the foreground, ' +
      'Kakegawa Castle (掛川城) on a hilltop in the background. Sunny day. ' + STYLE_GUIDE,
  },
  {
    file: 'milestone_iwata.png', target: 'milestone', km: 230,
    prompt: 'Iwata, Shizuoka: a modern clean industrial complex - a small electronic factory with solar panels on the roof, ' +
      'representing Suzue Electric. Some green trees around, blue sky, factory chimneys (gentle, not polluting). ' +
      'Welcoming corporate atmosphere. ' + STYLE_GUIDE,
  },
  // 合流シーン
  {
    file: 'meet_celebration.png', target: 'meet',
    prompt: 'A celebration scene: two cartoon hands shaking firmly in the center - ' +
      'one hand from the left wearing a blue uniform sleeve (Standard Transport / 運送会社), ' +
      'one from the right wearing a green uniform sleeve (Suzue Electric / 電子部品メーカー). ' +
      'Confetti falling, colorful sparkles, joyful atmosphere. ' +
      'A small road map of Japan visible behind, with a star marking the meeting point. ' +
      STYLE_GUIDE,
  },
];

async function genOne(prompt, outFile) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.9 },
  };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('HTTP ' + resp.status + ': ' + txt.slice(0, 250));
  }
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('no parts in response');
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      const buf = Buffer.from(inline.data, 'base64');
      fs.writeFileSync(outFile, buf);
      return { ok: true, bytes: buf.length, mime: inline.mimeType || inline.mime_type };
    }
  }
  throw new Error('no image data in parts');
}

(async () => {
  let okCount = 0, failCount = 0;
  for (const p of PROMPTS) {
    const outFile = path.join(OUT_DIR, p.file);
    process.stdout.write('[gen] ' + p.file + ' ... ');
    try {
      const r = await genOne(p.prompt, outFile);
      console.log('OK (' + Math.round(r.bytes / 1024) + ' KB)');
      okCount++;
      // DB 更新 (マイルストーン)
      if (p.target === 'milestone' && p.km != null) {
        const upd = db.prepare("UPDATE walk_milestones SET image_url=? WHERE km_from_tokyo=?")
          .run('/assets/walk/' + p.file, p.km);
        if (upd.changes) console.log('       → DB updated (' + upd.changes + ' rows)');
      }
    } catch (e) {
      console.log('FAIL', e.message);
      failCount++;
    }
    // 軽くスリープ (rate limit回避)
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('\n生成結果: ' + okCount + ' 成功 / ' + failCount + ' 失敗');
  console.log('保存先: ' + OUT_DIR);
})();
