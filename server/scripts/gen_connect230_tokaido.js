// Connect 230 用画像を東海道テイストで再生成 (Gemini 2.5 Flash Image)
// 道の駅 8枚 + 旅人 2枚 を統一スタイルで生成
// 実行: node server/scripts/gen_connect230_tokaido.js
'use strict';
const fs = require('fs');
const path = require('path');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY が設定されていません'); process.exit(1); }

const OUT_DIR = path.join(__dirname, '..', '..', 'public', 'assets', 'walk');
fs.mkdirSync(OUT_DIR, { recursive: true });

// 統一スタイルガイド (浮世絵×フラット、円形構図、文字なし)
const STYLE = 'STYLE: Ukiyo-e woodblock print aesthetic, flat 2D, soft sumi-ink black outlines, ' +
  'muted woodblock palette (indigo blue #3a5f8f, vermilion #c44530, ochre/gold #c9a14a, sage green, sumi black), ' +
  'warm ivory cream paper background (#f4e8d0) matching aged washi, subtle paper texture. ' +
  'Circular composition — main subject centered and contained in an implicit circle so it crops cleanly to a round thumbnail. ' +
  'Single iconic landmark, simplified and stylized, NOT photorealistic. ' +
  'NO TEXT, NO LETTERS, NO KANJI, NO CHARACTERS, NO READABLE SIGNS. ' +
  'NO foreground human figures. ' +
  'Square 1:1 format. Soft hand-drawn quality. ' +
  'Designed to be placed as a small ~90px round thumbnail on top of an antique Tokaido map.';

const PROMPTS = [
  {
    file: 'milestone_tokyo.png', km: 0,
    prompt: 'A stylized woodblock illustration of the historical wooden Nihonbashi bridge (日本橋) in Edo Tokyo, ' +
      'with a glimpse of edo-period townhouses and a stylized Tokyo Tower silhouette far in the back as a subtle modern hint. ' +
      'The bridge is the central iconic element. Daytime, soft warm sky. ' + STYLE,
  },
  {
    file: 'milestone_yokohama.png', km: 28,
    prompt: 'A stylized woodblock illustration of Yokohama port: red brick warehouses (赤レンガ倉庫) and a small docked sailing ship in the bay. ' +
      'A stylized Landmark Tower silhouette far behind. The brick warehouse is the central iconic element. ' + STYLE,
  },
  {
    file: 'milestone_odawara.png', km: 85,
    prompt: 'A stylized woodblock illustration of Odawara Castle (小田原城) — a Japanese castle with white walls, dark curved tile roofs, ' +
      'surrounded by pine trees and a hint of cherry blossoms, mountains layered behind. The castle is the central iconic element. ' + STYLE,
  },
  {
    file: 'milestone_fujioyama.png', km: 110,
    prompt: 'A stylized woodblock illustration of Mt. Fuji (富士山) prominently in the center with snowcap, ' +
      'a small wooden roadside station hut at the base, low green hills around. ' +
      'Mt. Fuji is the central iconic element, drawn in classic ukiyo-e simplified curves with soft indigo and white. ' + STYLE,
  },
  {
    file: 'milestone_fujikawa.png', km: 140,
    prompt: 'A stylized woodblock illustration of the Fujikawa river area: a flowing river with hokusai-style wave patterns ' +
      'crossing the foreground, a small wooden roadside complex on the bank, Mt. Fuji silhouette small in the distance behind. ' +
      'The river and station are the central elements. ' + STYLE,
  },
  {
    file: 'milestone_utsunoya.png', km: 175,
    prompt: 'A stylized woodblock illustration of Utsunoya pass (宇津ノ谷峠): an old Tokaido stone-paved mountain path winding through ' +
      'autumn maple forest with red and gold leaves, a small traditional teahouse with a thatched roof on the side. ' +
      'Atmospheric and historic. ' + STYLE,
  },
  {
    file: 'milestone_kakegawa.png', km: 210,
    prompt: 'A stylized woodblock illustration of Kakegawa: rolling green tea plantation fields with neat striped rows of tea bushes in the foreground, ' +
      'Kakegawa Castle (掛川城) — a small white castle on a hilltop in the background. Sunny clear day. ' +
      'Tea fields and the castle are the central elements. ' + STYLE,
  },
  {
    file: 'milestone_iwata.png', km: 230,
    prompt: 'A stylized woodblock illustration of Iwata in Shizuoka: a small clean modern electronics factory ' +
      '(representing Suzue Electric) with a simple silhouette, solar panels on the roof, surrounded by green trees and rolling hills, ' +
      'blending traditional landscape with subtle modern industry. Welcoming corporate atmosphere. ' + STYLE,
  },
  // 旅人 2枚 (チームマーカー用、円形構図、上半身)
  {
    file: 'traveler_std.png', traveler: true,
    prompt: 'A stylized woodblock illustration of an Edo-period Tokaido traveler/courier (飛脚) walking purposefully eastward-to-westward (facing right). ' +
      'Wearing an indigo blue (deep #1e3a5f) happi coat / hanten with a simple stylized arrow or crest pattern on the back. ' +
      'Carrying a wooden walking staff. Straw sandals, simple traveler trousers. ' +
      'Single figure centered in circular composition, full upper body visible. Cheerful, energetic posture. ' + STYLE.replace('NO foreground human figures. ', ''),
  },
  {
    file: 'traveler_sze.png', traveler: true,
    prompt: 'A stylized woodblock illustration of an Edo-period Tokaido traveler/courier (飛脚) walking purposefully westward-to-eastward (facing left). ' +
      'Wearing an emerald green (deep #047857) happi coat / hanten with a simple stylized lightning or crest pattern on the back. ' +
      'Carrying a wooden walking staff. Straw sandals, simple traveler trousers. ' +
      'Single figure centered in circular composition, full upper body visible. Cheerful, energetic posture. ' + STYLE.replace('NO foreground human figures. ', ''),
  },
];

async function genOne(prompt, outFile) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.85 },
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
      return { ok: true, bytes: buf.length };
    }
  }
  throw new Error('no image data in parts');
}

(async () => {
  let okCount = 0, failCount = 0;
  for (const p of PROMPTS) {
    const outFile = path.join(OUT_DIR, p.file);
    // 既存退避
    try {
      if (fs.existsSync(outFile)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        fs.copyFileSync(outFile, outFile + '.bak.' + ts);
      }
    } catch (e) {}
    process.stdout.write('[gen] ' + p.file + ' ... ');
    try {
      const r = await genOne(p.prompt, outFile);
      console.log('OK (' + Math.round(r.bytes / 1024) + ' KB)');
      okCount++;
    } catch (e) {
      console.log('FAIL', e.message);
      failCount++;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log('\n生成結果: ' + okCount + ' 成功 / ' + failCount + ' 失敗');
  console.log('保存先: ' + OUT_DIR);
})();
