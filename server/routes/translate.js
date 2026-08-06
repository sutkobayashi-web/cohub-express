// 多言語翻訳API (日本語 → 英語 / ポルトガル語)
// クライアント translate.js が DOM 走査して未訳テキストをバッチPOST。
// SQLite で永久キャッシュ (hash + lang)。Gemini 2.5 Flash で JSON 配列翻訳。
const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../services/db');
const { generateText } = require('../services/ai');
const { authUser } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// 公開ページ(ログイン前UI翻訳)でも使うため authUser は付けられない。
// 匿名からのLLMコスト悪用を抑えるため翻訳系に専用レート制限 (IPあたり300req/15分)。
const translateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limited' },
});

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

/* ===== 画面部品の用語集 (2026-08-07 社長「言語を切り替えると構成が崩れる/改行される」) =====
   ⚠️ボタン・タブ・見出しは**日本語と同じくらい短い訳語**にする。長い訳語が入ると、
     日本語の字数を前提に幅を決めた横メニューからあふれて構成が崩れる。
   ⚠️ここに載せた語は AI 翻訳もキャッシュも通さず、この訳を必ず返す(最優先)。
   ⚠️キーは画面に出ている日本語そのまま(絵文字は別ノードなので含めない)。
   ⚠️本文・通達・メッセージ等の【文章】は対象外。あくまで部品のラベルだけ。 */
const GLOSSARY = {
  pt: {
    '出勤時': 'Ao chegar', '退勤時': 'Ao sair',
    '個人宛': 'Pessoal', 'グループ宛': 'Grupo',
    '会社から通達': 'Comunicados', '過去の読んだ通達': 'Já lidos',
    'ログアウト': 'Sair',
    '仮払金の申請': 'Adiantamento', '立替の精算': 'Reembolso', '申請の状況': 'Situação',
    'みんなの投稿': 'Publicações', '事故・破損': 'Acidentes', '過去の事例': 'Casos',
    '健康管理室': 'Saúde', '労働安全ニュース': 'Segurança',
    'スマホでも 見られます': 'Veja no celular', 'カメラで 読み取ってください': 'Leia com a câmera',
    '食事記録': 'Refeições', '運動記録': 'Exercícios', '健康ボード': 'Painel',
    '栄養レポート': 'Nutrição', 'マイプラン': 'Meu plano', '体の情報': 'Meu corpo',
    '健康リテラシー': 'Saber sobre saúde', '熱中症ガイド': 'Calor', '何を食べようか': 'O que comer?',
  },
  en: {
    '出勤時': 'Start of work', '退勤時': 'End of work',
    '個人宛': 'Personal', 'グループ宛': 'Group',
    '会社から通達': 'Announcements', '過去の読んだ通達': 'Already read',
    'ログアウト': 'Log out',
    '仮払金の申請': 'Advance', '立替の精算': 'Reimbursement', '申請の状況': 'Status',
    'みんなの投稿': 'Posts', '事故・破損': 'Accidents', '過去の事例': 'Past cases',
    '健康管理室': 'Health room', '労働安全ニュース': 'Safety news',
    'スマホでも 見られます': 'Also on your phone', 'カメラで 読み取ってください': 'Scan with camera',
    '食事記録': 'Meals', '運動記録': 'Exercise', '健康ボード': 'Board',
    '栄養レポート': 'Nutrition', 'マイプラン': 'My plan', '体の情報': 'My body',
    '健康リテラシー': 'Health literacy', '熱中症ガイド': 'Heat', '何を食べようか': 'What to eat?',
  },
};

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

router.post('/', translateLimiter, async (req, res) => {
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
      // ⭐画面の部品(ボタン・タブ・見出し)は短い訳語を固定する (2026-08-07 社長)。
      //   AIに任せると「過去の読んだ通達→Notificações Lidas Anteriores」のように長くなり、
      //   日本語の字数を前提にした横メニューからあふれて構成が崩れる。用語集が最優先。
      const fixed = GLOSSARY[lang] && GLOSSARY[lang][t];
      if (fixed) { out[raw] = fixed; continue; }
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

// ===== ユーザーの表示言語設定 (マイページ/言語ボタンから保存し全ページで自動適用) =====
const ALLOWED_LANGS = ['ja', 'en', 'pt'];
router.get('/lang', authUser, (req, res) => {
  const u = getDb().prepare('SELECT lang FROM users WHERE id = ?').get(req.uid);
  res.json({ success: true, lang: (u && u.lang) || 'ja' });
});
router.post('/lang', authUser, express.json(), (req, res) => {
  const lang = ((req.body && req.body.lang) || '').toString();
  if (!ALLOWED_LANGS.includes(lang)) return res.status(400).json({ success: false, msg: 'invalid lang' });
  getDb().prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, req.uid);
  res.json({ success: true, lang });
});


// ============================================================
// ⭐2026-08-06 (社長): プッシュ通知も本人の言語で送るため、サーバー内から使える翻訳関数を公開する。
//   キャッシュ(translations_cache)を必ず経由するので、同じ文面の2回目以降はGemini呼び出し無し=無料・即時。
//   ⚠️失敗時は日本語のまま返す(通知が出ないより、日本語でも届くほうがよい)。
// ============================================================
async function translateCached(texts, lang) {
  const list = (Array.isArray(texts) ? texts : [texts]).map(t => String(t == null ? '' : t).slice(0, MAX_TEXT_LEN));
  if (!SUPPORTED_LANGS[lang]) return list;
  try {
    const db = getDb();
    const sel = db.prepare('SELECT dst FROM translations_cache WHERE hash=? AND lang=?');
    const ins = db.prepare('INSERT OR REPLACE INTO translations_cache(hash, lang, src, dst) VALUES(?,?,?,?)');
    const out = new Array(list.length);
    const missing = [], missingIdx = [], missingHash = [];
    list.forEach((t, i) => {
      if (!t.trim()) { out[i] = t; return; }
      const h = hashText(t);
      const row = sel.get(h, lang);
      if (row) out[i] = row.dst;
      else { missing.push(t); missingIdx.push(i); missingHash.push(h); }
    });
    if (missing.length) {
      const translated = await translateBatch(missing, lang);
      const tx = db.transaction(() => {
        for (let i = 0; i < missing.length; i++) ins.run(missingHash[i], lang, missing[i], translated[i]);
      });
      tx();
      missingIdx.forEach((mi, k) => { out[mi] = translated[k] || list[mi]; });
    }
    return out.map((v, i) => (v == null ? list[i] : v));
  } catch (e) {
    console.warn('[translateCached]', e && e.message);
    return list;
  }
}

module.exports = router;
module.exports.translateCached = translateCached;
