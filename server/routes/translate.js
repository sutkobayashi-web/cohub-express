// 多言語翻訳API (日本語 → 英語 / ポルトガル語)
// クライアント translate.js が DOM 走査して未訳テキストをバッチPOST。
// SQLite で永久キャッシュ (hash + lang)。Gemini 2.5 Flash で JSON 配列翻訳。
const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../services/db');
const { generateText } = require('../services/ai');
const { authUser } = require('../middleware/auth');

const router = express.Router();

const SUPPORTED_LANGS = { en: 'English', pt: 'Brazilian Portuguese' };
// チャット本文翻訳用 (ソース言語自動検出、JAも target に含む)
const MSG_TARGET_LANGS = { ja: 'Japanese', en: 'English', pt: 'Brazilian Portuguese' };
const MAX_BATCH = 80;
const MAX_TEXT_LEN = 800;
const MAX_MSG_LEN = 2000;

function ensureTable() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS translations_cache (
    hash TEXT NOT NULL,
    lang TEXT NOT NULL,
    src TEXT NOT NULL,
    dst TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (hash, lang)
  )`);
}
ensureTable();

function hashText(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 20);
}

async function translateBatch(texts, lang) {
  const langName = SUPPORTED_LANGS[lang];
  const numbered = texts.map((t, i) => `[${i + 1}] ${t}`).join('\n');
  const prompt = `You are a translator for a Japanese corporate web app (logistics/health/HR domain).
Translate the following Japanese UI strings into ${langName}.

Rules:
- Output ONLY a JSON array of strings, same length as input, same order.
- Keep tone natural and concise (UI labels, button text, sentences).
- Preserve emoji, numbers, dates, URLs, and proper nouns (company names like "CoWell", "CoHub", "スタンダード運輸") as-is.
- Do NOT translate placeholder tokens like {name} \${var} %s.
- If a string is already in the target language or untranslatable, return it unchanged.
- Do not add explanations.

Input:
${numbered}

Output JSON array:`;
  const raw = await generateText(prompt, {
    temperature: 0.2,
    maxTokens: 8000,
    responseMimeType: 'application/json',
    thinkingBudget: 0,
  });
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('翻訳JSON解析失敗');
    arr = JSON.parse(m[0]);
  }
  if (!Array.isArray(arr)) throw new Error('翻訳結果が配列ではない');
  if (arr.length !== texts.length) {
    // 長さ不一致時はゼロ埋めして部分救済
    while (arr.length < texts.length) arr.push(texts[arr.length]);
    arr = arr.slice(0, texts.length);
  }
  return arr.map(v => (typeof v === 'string' ? v : String(v == null ? '' : v)));
}

router.post('/', async (req, res) => {
  try {
    const lang = String((req.body && req.body.lang) || '').toLowerCase();
    if (!SUPPORTED_LANGS[lang]) {
      return res.status(400).json({ error: 'unsupported lang' });
    }
    const inputs = Array.isArray(req.body && req.body.texts) ? req.body.texts : [];
    if (!inputs.length) return res.json({ translations: {} });
    if (inputs.length > MAX_BATCH) {
      return res.status(400).json({ error: `batch too large (max ${MAX_BATCH})` });
    }

    const db = getDb();
    const selStmt = db.prepare('SELECT dst FROM translations_cache WHERE hash=? AND lang=?');
    const insStmt = db.prepare('INSERT OR REPLACE INTO translations_cache(hash, lang, src, dst) VALUES(?,?,?,?)');

    const out = {};
    const missing = [];
    const missingHashes = [];
    for (const raw of inputs) {
      const t = String(raw == null ? '' : raw).slice(0, MAX_TEXT_LEN);
      if (!t.trim()) { out[raw] = raw; continue; }
      const h = hashText(t);
      const row = selStmt.get(h, lang);
      if (row) {
        out[raw] = row.dst;
      } else {
        missing.push(t);
        missingHashes.push(h);
      }
    }

    if (missing.length) {
      const translated = await translateBatch(missing, lang);
      const insMany = db.transaction(() => {
        for (let i = 0; i < missing.length; i++) {
          insStmt.run(missingHashes[i], lang, missing[i], translated[i]);
        }
      });
      insMany();
      // 元キーで返却
      let idx = 0;
      for (const raw of inputs) {
        if (out[raw] !== undefined) continue;
        const t = String(raw == null ? '' : raw).slice(0, MAX_TEXT_LEN);
        if (!t.trim()) continue;
        out[raw] = translated[idx++];
      }
    }

    res.set('Cache-Control', 'no-store');
    res.json({ translations: out, lang });
  } catch (e) {
    console.error('[translate] error:', e && e.message);
    res.status(500).json({ error: '翻訳失敗', detail: String(e && e.message || e).slice(0, 200) });
  }
});

// ============================================================
// チャット本文翻訳 (POST /api/translate/message)
// 任意言語からターゲット言語へ翻訳。translations_cache を流用 (target キーで分離)
// ============================================================
async function translateMessage(text, target) {
  const langName = MSG_TARGET_LANGS[target];
  const prompt = `Translate the following chat message into ${langName}.

Rules:
- The source could be in any language (Japanese, Portuguese, English, etc.). Auto-detect it.
- If the source is already in ${langName}, return it unchanged.
- Preserve emoji, URLs, @mentions, numbers, dates, proper nouns (CoWell, CoHub, スタンダード運輸, person names) as-is.
- Output ONLY the translated text. No explanation, no quotes, no prefix.
- Keep tone natural and casual (it's a chat message, not formal documentation).

Source message:
${text}

Translation:`;
  const raw = await generateText(prompt, {
    temperature: 0.3,
    maxTokens: 1500,
    thinkingBudget: 0,
  });
  return String(raw || '').trim().replace(/^["「『]/, '').replace(/["」』]$/, '');
}

router.post('/message', authUser, async (req, res) => {
  try {
    const target = String((req.body && req.body.target) || '').toLowerCase();
    if (!MSG_TARGET_LANGS[target]) {
      return res.status(400).json({ error: 'unsupported target' });
    }
    const text = String((req.body && req.body.text) || '').slice(0, MAX_MSG_LEN).trim();
    if (!text) return res.json({ translation: '', target });

    const db = getDb();
    // キャッシュキー: msgTarget を prefix で区別 (UI訳と被らないように)
    const cacheLang = 'msg:' + target;
    const h = hashText(text);
    const cached = db.prepare('SELECT dst FROM translations_cache WHERE hash=? AND lang=?').get(h, cacheLang);
    if (cached) {
      return res.json({ translation: cached.dst, target, cached: true });
    }

    const translated = await translateMessage(text, target);
    db.prepare('INSERT OR REPLACE INTO translations_cache(hash, lang, src, dst) VALUES(?,?,?,?)')
      .run(h, cacheLang, text, translated);
    res.set('Cache-Control', 'no-store');
    res.json({ translation: translated, target, cached: false });
  } catch (e) {
    console.error('[translate/message] error:', e && e.message);
    res.status(500).json({ error: '翻訳失敗', detail: String(e && e.message || e).slice(0, 200) });
  }
});

module.exports = router;
