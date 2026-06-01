// 事故報告書API (2026-04-28 CoLink吸収)
// 製品事故 (kbc_accident_reports) と 車両事故 (vehicle_accident_reports) の2系統
// 過去PDFアーカイブ (accident_archives) — 2026-04-30追加: bot_safety学習材料 + スクリーン掲示元
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const multer = require('multer');
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// 事故報告書 写真アップロード先 — /opt/cohub/uploads/ に直置き
// (CoLink から移行した既存写真もここにあり、URL は /uploads/<filename> で配信)
const accidentDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(accidentDir)) fs.mkdirSync(accidentDir, { recursive: true });
const accidentUpload = multer({
  storage: multer.diskStorage({
    destination: accidentDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').slice(0, 8) || '.jpg').replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, 'accident_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype || '')) return cb(new Error('画像のみアップロード可'));
    cb(null, true);
  },
});

// 写真アップロード (複数ファイル対応、最大10枚)
router.post('/upload', authUser, accidentUpload.array('photos', 10), (req, res) => {
  const urls = (req.files || []).map(f => '/uploads/' + f.filename);
  res.json({ success: true, urls });
});

// 管理職判定 (employee_type='admin' または role='admin')
function isManager(uid) {
  const r = getDb().prepare('SELECT employee_type, role FROM users WHERE id = ?').get(uid);
  return !!(r && (r.employee_type === 'admin' || r.role === 'admin'));
}

// ============================================================
// 事故対策室スクリーン (動画/写真を流し続ける)
// ============================================================
const screenUpload = multer({
  storage: multer.diskStorage({
    destination: accidentDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').slice(0, 8) || '.bin').replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, 'screen_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + ext);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },  // 動画も流すので50MB
  fileFilter: (req, file, cb) => {
    if (!/^(image|video)\//.test(file.mimetype || '')) return cb(new Error('画像または動画のみ'));
    cb(null, true);
  },
});

// スクリーン投稿: 写真または動画 (multipart) + caption
router.post('/screen', authUser, screenUpload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, msg: 'mediaフィールドが必要' });
  const mediaType = /^video\//.test(req.file.mimetype) ? 'video' : 'image';
  const url = '/uploads/' + req.file.filename;
  const caption = (req.body && req.body.caption ? String(req.body.caption) : '').slice(0, 200);
  const db = getDb();
  const r = db.prepare(`INSERT INTO accident_screen_posts (media_url, media_type, caption, posted_by) VALUES (?, ?, ?, ?)`)
    .run(url, mediaType, caption, req.uid);
  // 個別アップロードは1投稿=1ファイル扱い。source_label を後付け (caption + 日付)
  const today = new Date().toISOString().slice(0, 10);
  const labelPrefix = mediaType === 'video' ? '🎥' : '📷';
  const label = labelPrefix + ' ' + today + ' ' + (caption || '事故' + (mediaType === 'video' ? '映像' : '写真')).slice(0, 60);
  db.prepare(`UPDATE accident_screen_posts SET source_id = ?, source_label = ? WHERE id = ?`)
    .run('screen_' + r.lastInsertRowid, label, r.lastInsertRowid);
  res.json({ success: true, id: r.lastInsertRowid, url, media_type: mediaType });
});

// スクリーン投稿一覧 (新しい順、最大100件、削除済除外)
router.get('/screen', authUser, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.id, p.media_url, p.media_type, p.caption, p.text_body, p.source_id, p.source_label,
           p.posted_by, p.created_at, u.display_name AS posted_name
      FROM accident_screen_posts p
      LEFT JOIN users u ON u.id = p.posted_by
     WHERE p.deleted_at IS NULL
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT 100
  `).all();
  res.json({ success: true, posts: rows });
});

// ファイル単位削除: 同じsource_idを持つ投稿をまとめて削除 (番組表の削除ボタン用)
router.delete('/screen/by-source/:sid', authUser, (req, res) => {
  const sid = String(req.params.sid || '');
  if (!sid) return res.status(400).json({ success: false, msg: 'source_id 必須' });
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ削除可' });
  const db = getDb();
  const result = db.prepare(`UPDATE accident_screen_posts SET deleted_at = datetime('now') WHERE source_id = ? AND deleted_at IS NULL`).run(sid);
  res.json({ success: true, deleted: result.changes });
});

// スクリーン投稿削除 (投稿者本人または管理職のみ)
router.delete('/screen/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const row = db.prepare('SELECT posted_by FROM accident_screen_posts WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (row.posted_by !== req.uid && !isManager(req.uid)) {
    return res.status(403).json({ success: false, msg: '削除権限がありません' });
  }
  db.prepare(`UPDATE accident_screen_posts SET deleted_at = datetime('now') WHERE id = ?`).run(id);
  res.json({ success: true });
});

// ============================================================
// 過去事故報告書 PDFアーカイブ (bot_safety学習 + スクリーン掲示)
// ============================================================
const archiveUpload = multer({
  storage: multer.diskStorage({
    destination: accidentDir,
    filename: (req, file, cb) => {
      cb(null, 'archive_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.pdf');
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 },  // PDF 30MBまで
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('PDFのみアップロード可'));
    cb(null, true);
  },
});

// PDFをページごとのPNGに変換 (poppler-utils pdftoppm)
function pdfToPageImages(pdfPath) {
  const base = pdfPath.replace(/\.pdf$/i, '');
  // pdftoppm -png -r 110 input.pdf prefix → prefix-1.png, prefix-2.png ...
  execSync(`pdftoppm -png -r 110 "${pdfPath}" "${base}_p"`, { stdio: 'pipe' });
  // 出力ファイルを集める
  const dir = path.dirname(pdfPath);
  const stem = path.basename(base) + '_p';
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(stem) && f.endsWith('.png'))
    .sort((a, b) => {
      const na = parseInt((a.match(/_p-?(\d+)\.png$/) || [])[1] || 0);
      const nb = parseInt((b.match(/_p-?(\d+)\.png$/) || [])[1] || 0);
      return na - nb;
    })
    .map(f => '/uploads/' + f);
}

// Gemini で PDFから「タイトル/事故日/サマリ/全文」をJSON抽出
async function geminiExtractPdf(pdfPath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const pdfData = fs.readFileSync(pdfPath).toString('base64');
  const prompt = `以下のPDFは社内の過去の事故報告書です。安全管理者AIの学習材料として、以下のJSONを返してください。

{
  "title": "報告書のタイトル (50字以内、なければ事故概要)",
  "accident_date": "事故発生日 (YYYY-MM-DD形式、不明なら空文字)",
  "summary": "200字以内の要約 (発生状況・原因・再発防止策の要点)",
  "full_text": "PDF全体を構造化したテキスト (3000字以内、見出し付き、表は要点のみ)"
}

絶対に守ること:
- JSONのみを返す。前後の説明文や\`\`\`json\`\`\`は不要
- 個人情報 (氏名・電話番号・住所等) は伏字「●●」または役職名に置換
- PDFが事故報告書でない場合は title="(事故報告書ではないPDF)" として返す`;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [
      { text: prompt },
      { inlineData: { mimeType: 'application/pdf', data: pdfData } },
    ]}],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8000, thinkingConfig: { thinkingBudget: 0 } },
  };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('Gemini ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('Gemini応答parts無し');
  let text = '';
  for (const p of parts) if (p.text) text += p.text;
  // ```json ブロックが混じることがあるので除去
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(text); } catch (e) {
    // 最低限のフォールバック
    return { title: '(自動解析失敗)', accident_date: '', summary: text.slice(0, 200), full_text: text.slice(0, 3000) };
  }
}

// PDF アップロード — 管理職のみ
router.post('/archive', authUser, (req, res, next) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみアップロード可' });
  archiveUpload.single('pdf')(req, res, async (err) => {
    if (err) return res.status(400).json({ success: false, msg: err.message });
    if (!req.file) return res.status(400).json({ success: false, msg: 'pdfフィールドが必要' });
    const pdfPath = req.file.path;
    const pdfUrl = '/uploads/' + req.file.filename;
    let pageUrls = [];
    let extracted = { title: req.file.originalname, accident_date: '', summary: '', full_text: '' };
    // (1) ページ画像化 (失敗してもPDF登録は続行)
    try { pageUrls = pdfToPageImages(pdfPath); }
    catch (e) { console.warn('[archive pdftoppm fail]', e.message); }
    // (2) Gemini 抽出
    try { extracted = await geminiExtractPdf(pdfPath); }
    catch (e) { console.warn('[archive gemini fail]', e.message); extracted.summary = '(Gemini解析失敗: ' + e.message.slice(0,80) + ')'; }
    // (3) ユーザー指定があればそちら優先
    const title = (req.body && req.body.title) ? String(req.body.title).slice(0, 80) : (extracted.title || req.file.originalname);
    const accidentDate = (req.body && req.body.accident_date) ? String(req.body.accident_date) : (extracted.accident_date || '');
    const ins = getDb().prepare(`INSERT INTO accident_archives
      (pdf_url, page_image_urls, title, accident_date, summary, full_text, uploaded_by)
      VALUES (?,?,?,?,?,?,?)`).run(
      pdfUrl, JSON.stringify(pageUrls), title, accidentDate || null,
      (extracted.summary || '').slice(0, 1000),
      (extracted.full_text || '').slice(0, 8000),
      req.uid);
    res.json({ success: true, id: ins.lastInsertRowid, pdf_url: pdfUrl,
      page_count: pageUrls.length, title, accident_date: accidentDate, summary: extracted.summary });
  });
});

// 一覧
router.get('/archive', authUser, (req, res) => {
  const rows = getDb().prepare(`SELECT a.id, a.pdf_url, a.page_image_urls, a.title, a.accident_date,
       a.summary, a.created_at, a.uploaded_by, u.display_name AS uploaded_name
     FROM accident_archives a
     LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.deleted_at IS NULL
     ORDER BY a.created_at DESC LIMIT 100`).all();
  res.json({ success: true, archives: rows });
});

// 詳細 (full_text含む)
router.get('/archive/:id', authUser, (req, res) => {
  const r = getDb().prepare(`SELECT * FROM accident_archives WHERE id = ? AND deleted_at IS NULL`).get(parseInt(req.params.id));
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  res.json({ success: true, archive: r });
});

// 削除 (管理職のみ)
router.delete('/archive/:id', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ削除可' });
  getDb().prepare(`UPDATE accident_archives SET deleted_at = datetime('now','localtime') WHERE id = ?`).run(parseInt(req.params.id));
  res.json({ success: true });
});

// 反省会記録を構造化入力で追加 (PDF不要、安全管理者が現場で記入)
// xlsxインポートと同じ構造の full_text を生成し、accident_archives に保存
router.post('/archive/reflection', authUser, express.json({ limit: '500kb' }), (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ追加可' });
  const b = req.body || {};
  const accident_date = (b.accident_date || '').trim();
  const place = (b.place || '').trim();
  const road_type = (b.road_type || '').trim();
  const content = (b.content || '').trim();
  const cause = (b.cause || '').trim();
  const prevention = (b.prevention || '').trim();
  const stop_measure = (b.stop_measure || '').trim();
  const reflection_date = (b.reflection_date || '').trim();
  const subject = (b.subject || '').trim();
  const instructor = (b.instructor || '').trim();
  const participants = (b.participants || '').trim();
  if (!content && !cause) return res.status(400).json({ success: false, msg: '事故内容または原因のいずれかは必須です' });

  const yearLabel = accident_date ? accident_date.slice(0, 4) : '';
  const titleParts = [];
  if (yearLabel) titleParts.push('[' + yearLabel + ']');
  if (place) titleParts.push(place);
  if (road_type) titleParts.push('(' + road_type + ')');
  if (content) titleParts.push(content.slice(0, 30));
  const title = (b.title || '').trim() || (titleParts.join(' ').slice(0, 80) || '反省会記録');

  const summary = ((content ? '事故内容: ' + content : '') + (cause ? ' / 原因: ' + cause.slice(0, 80) : '')).slice(0, 250);

  const fullParts = ['【反省会記録】'];
  if (yearLabel) fullParts.push('年: ' + yearLabel);
  if (accident_date) fullParts.push('日付: ' + accident_date);
  if (place) fullParts.push('場所: ' + place + (road_type ? ' (' + road_type + ')' : ''));
  if (content) fullParts.push('事故内容: ' + content);
  if (cause) fullParts.push('原因 (本人の振り返り): ' + cause);
  if (prevention) fullParts.push('再発防止: ' + prevention);
  if (stop_measure) fullParts.push('歯止め (組織として): ' + stop_measure);
  if (reflection_date) fullParts.push('反省会実施日: ' + reflection_date);
  if (subject) fullParts.push('対象者: ' + subject);
  if (instructor) fullParts.push('指導者: ' + instructor);
  if (participants) fullParts.push('反省会参加者: ' + participants);
  const full_text = fullParts.join('\n').slice(0, 8000);

  const ins = getDb().prepare(`INSERT INTO accident_archives
    (pdf_url, page_image_urls, title, accident_date, summary, full_text, uploaded_by)
    VALUES (?, '[]', ?, ?, ?, ?, ?)`).run(
    'reflection://' + Date.now(), title, accident_date || null, summary, full_text, req.uid);
  res.json({ success: true, id: ins.lastInsertRowid, title, accident_date });
});

// 反省会記録の更新 (内容を上書き、構造化フィールドから再生成)
router.put('/archive/reflection/:id', authUser, express.json({ limit: '500kb' }), (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ更新可' });
  const id = parseInt(req.params.id);
  const r = getDb().prepare(`SELECT id, pdf_url FROM accident_archives WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  // PDFアーカイブは構造化更新できない (PDF再アップロードが必要)
  if (r.pdf_url && /^\/uploads\//.test(r.pdf_url)) {
    return res.status(400).json({ success: false, msg: 'PDF型アーカイブは構造化更新不可。削除→再アップロードしてください' });
  }
  const b = req.body || {};
  const accident_date = (b.accident_date || '').trim();
  const place = (b.place || '').trim();
  const road_type = (b.road_type || '').trim();
  const content = (b.content || '').trim();
  const cause = (b.cause || '').trim();
  const prevention = (b.prevention || '').trim();
  const stop_measure = (b.stop_measure || '').trim();
  const reflection_date = (b.reflection_date || '').trim();
  const subject = (b.subject || '').trim();
  const instructor = (b.instructor || '').trim();
  const participants = (b.participants || '').trim();

  const yearLabel = accident_date ? accident_date.slice(0, 4) : '';
  const titleParts = [];
  if (yearLabel) titleParts.push('[' + yearLabel + ']');
  if (place) titleParts.push(place);
  if (road_type) titleParts.push('(' + road_type + ')');
  if (content) titleParts.push(content.slice(0, 30));
  const title = (b.title || '').trim() || (titleParts.join(' ').slice(0, 80) || '反省会記録');
  const summary = ((content ? '事故内容: ' + content : '') + (cause ? ' / 原因: ' + cause.slice(0, 80) : '')).slice(0, 250);
  const fullParts = ['【反省会記録】'];
  if (yearLabel) fullParts.push('年: ' + yearLabel);
  if (accident_date) fullParts.push('日付: ' + accident_date);
  if (place) fullParts.push('場所: ' + place + (road_type ? ' (' + road_type + ')' : ''));
  if (content) fullParts.push('事故内容: ' + content);
  if (cause) fullParts.push('原因 (本人の振り返り): ' + cause);
  if (prevention) fullParts.push('再発防止: ' + prevention);
  if (stop_measure) fullParts.push('歯止め (組織として): ' + stop_measure);
  if (reflection_date) fullParts.push('反省会実施日: ' + reflection_date);
  if (subject) fullParts.push('対象者: ' + subject);
  if (instructor) fullParts.push('指導者: ' + instructor);
  if (participants) fullParts.push('反省会参加者: ' + participants);
  const full_text = fullParts.join('\n').slice(0, 8000);

  getDb().prepare(`UPDATE accident_archives SET title = ?, accident_date = ?, summary = ?, full_text = ? WHERE id = ?`)
    .run(title, accident_date || null, summary, full_text, id);
  res.json({ success: true });
});

// 反省会記録の構造化フィールドを取り出す (編集用)
// full_text を逆パースして元の項目を返す
router.get('/archive/reflection/:id', authUser, (req, res) => {
  const r = getDb().prepare(`SELECT * FROM accident_archives WHERE id = ? AND deleted_at IS NULL`).get(parseInt(req.params.id));
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const ft = r.full_text || '';
  const pick = (label) => {
    const m = new RegExp('^' + label + '\\s*[::]\\s*(.+)$', 'm').exec(ft);
    return m ? m[1].trim() : '';
  };
  res.json({ success: true, archive: {
    id: r.id, title: r.title, accident_date: r.accident_date,
    place: pick('場所').replace(/\s*\([^)]*\)\s*$/, ''),
    road_type: (pick('場所').match(/\(([^)]+)\)\s*$/) || [])[1] || '',
    content: pick('事故内容'),
    cause: pick('原因 \\(本人の振り返り\\)') || pick('原因'),
    prevention: pick('再発防止'),
    stop_measure: pick('歯止め \\(組織として\\)') || pick('歯止め'),
    reflection_date: pick('反省会実施日'),
    subject: pick('対象者'),
    instructor: pick('指導者'),
    participants: pick('反省会参加者'),
    is_pdf: r.pdf_url && /^\/uploads\//.test(r.pdf_url),
  }});
});

// スクリーン掲示: 各ページ画像を accident_screen_posts に追加
router.post('/archive/:id/screen', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ掲示可' });
  const id = parseInt(req.params.id);
  const a = getDb().prepare(`SELECT * FROM accident_archives WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  const pages = JSON.parse(a.page_image_urls || '[]');
  if (!pages.length) return res.status(400).json({ success: false, msg: 'ページ画像なし (pdftoppm 失敗)' });
  const sourceId = 'archive_' + a.id;
  const sourceLabel = '📄 ' + (a.title || '事故報告書') + (a.accident_date ? ' (' + a.accident_date + ')' : '');
  const stmt = getDb().prepare(`INSERT INTO accident_screen_posts (media_url, media_type, caption, posted_by, source_id, source_label) VALUES (?, 'image', ?, ?, ?, ?)`);
  let inserted = 0;
  for (let i = 0; i < pages.length; i++) {
    const cap = `📄 ${a.title || '事故報告書'}${a.accident_date ? ' (' + a.accident_date + ')' : ''} P${i+1}/${pages.length}`;
    stmt.run(pages[i], cap, req.uid, sourceId, sourceLabel);
    inserted++;
  }
  res.json({ success: true, inserted });
});

// ============================================================
// AI分析レポート (Geminiが過去事故データを総括)
// ============================================================
async function geminiAnalyze(promptText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  // 包括的なレポート生成のため Pro を使用 (Flashだと深さが出にくい)
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=' + apiKey;
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    // Google Search グラウンディング: 業界事例・労働安全衛生資料を実際に検索して引用させる
    tools: [{ googleSearch: {} }],
    generationConfig: { temperature: 0.5, maxOutputTokens: 24000 },
  };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('Gemini ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  const cand = data.candidates && data.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  if (!parts) throw new Error('Gemini応答parts無し');
  let text = '';
  for (const p of parts) if (p.text) text += p.text;
  // グラウンディングで引用元URLが返れば末尾に追記
  const grounding = cand.groundingMetadata;
  if (grounding && Array.isArray(grounding.groundingChunks) && grounding.groundingChunks.length) {
    const cites = grounding.groundingChunks
      .map((c, i) => {
        const w = c.web || {};
        const title = (w.title || '').slice(0, 80);
        const uri = w.uri || '';
        return uri ? `[${i + 1}] ${title} — ${uri}` : '';
      })
      .filter(Boolean)
      .slice(0, 10);
    if (cites.length) text += '\n\n## 引用元 (Google検索結果)\n' + cites.join('\n');
  }
  return text;
}

// AI分析レポート生成 (管理職のみ)
router.post('/analysis', authUser, async (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ分析実行可' });
  const db = getDb();
  // 全データ収集 (件数多すぎる場合は直近に絞る)
  const archives = db.prepare(`SELECT title, accident_date, full_text FROM accident_archives
    WHERE deleted_at IS NULL ORDER BY accident_date DESC, created_at DESC LIMIT 120`).all();
  const prodRows = db.prepare(`SELECT accident_date, location_floor, location_area, product_name, product_category,
      cause_category, cause_detail, damage_description, reporter_reflection
    FROM kbc_accident_reports ORDER BY accident_date DESC LIMIT 100`).all();
  const vehRows = db.prepare(`SELECT accident_date, location, vehicle_no, accident_type, counter_party,
      injury_status, cause_summary, description, repair_status
    FROM vehicle_accident_reports ORDER BY accident_date DESC LIMIT 100`).all();

  const totalRows = archives.length + prodRows.length + vehRows.length;
  if (!totalRows) return res.status(400).json({ success: false, msg: '分析対象データがありません' });

  // プロンプト組立
  const dataLines = [];
  if (archives.length) {
    dataLines.push('【反省会記録・PDFアーカイブ ' + archives.length + '件】');
    for (const a of archives) {
      const ds = a.accident_date ? '[' + a.accident_date + '] ' : '';
      dataLines.push('- ' + ds + (a.title || '無題') + ' :: ' + (a.full_text || '').replace(/\n/g, ' / ').slice(0, 700));
    }
  }
  if (prodRows.length) {
    dataLines.push('\n【製品事故報告書 ' + prodRows.length + '件】');
    for (const r of prodRows) {
      const loc = [r.location_floor, r.location_area].filter(Boolean).join('/');
      const refl = r.reporter_reflection ? ' / 振返り:' + r.reporter_reflection.slice(0, 120) : '';
      dataLines.push('- [' + r.accident_date + '] ' + loc + ' / ' + (r.product_name || '') + ' / 原因:' + (r.cause_category || '?') + ' ' + (r.cause_detail || '').slice(0, 200) + refl);
    }
  }
  if (vehRows.length) {
    dataLines.push('\n【車両事故報告書 ' + vehRows.length + '件】');
    for (const r of vehRows) {
      dataLines.push('- [' + r.accident_date + '] ' + (r.location || '-') + ' ' + (r.accident_type || '?') + ' / 負傷:' + (r.injury_status || '無し') + ' / 原因:' + (r.cause_summary || '?') + ' ' + (r.description || '').slice(0, 200));
    }
  }

  const prompt = `あなたは中小運送会社 (スタンダード運輸グループ) の安全管理責任者AIです。
社内の過去事故データに加え、**運送業界の他社事故事例・労働安全衛生関係の公的資料 (厚生労働省・国土交通省・陸災防・JISHA等)** をGoogle検索で実際に参照し、両者を照合した**包括的で具体的な分析レポート (8000字〜12000字程度)** を作成してください。

# 厳守する分量・密度ルール
- **各章は最低でも400〜600字、または箇条書き5項目以上**を必須とする。1〜2行で済ませない。
- 数値・件数・比率・場所名・原因キーワードなど**社内データから引用した具体的事実**を各章に必ず散りばめる。
- 業界資料の引用は**章ごとに最低1〜2件**、検索した資料の出典名・年度・数値を本文に書く。
- 「等」「など」で逃げない。具体例を3つ以上列挙する。

# 出力形式 (必ずこの章立てで・マークダウン)

## 1. 総括サマリ (最低500字)
全${totalRows}件の社内データから読み取れる現状を**段落形式で500字以上**にまとめる。
- 期間内の件数推移 (年別・月別の山谷を具体的に)
- 直近半年の最大トピック (最も多く発生した事故タイプ・場所)
- 重傷・物損規模の比較
- 業界統計との照合 (例:「厚労省2024年労災統計では運送業の死傷年間〇件/万人だが、当社は△△」)
- 経営的な含意 (このまま放置すると何が起こるか)

## 2. 多発パターン Top5 (各パターン詳細あり)
各パターンに以下を必ず付ける:
- 件数 / 全体に占める比率 (例: 12件/27%)
- 典型的なシーン (場所・時間帯・天候・作業種別)
- 過去事案からの**具体例3つ** (年月日・場所・事故内容を1行ずつ)
- なぜそのパターンが多いのか短い分析 (2〜3行)

## 3. 共通する根本原因 (社内 + 業界共通の知見・最低6項目)
心理的・行動的パターンを**6項目以上**抽出。各項目に:
- パターン名 (例:「過信」「焦り」「確認手順の省略」など)
- 社内データ内の該当事案数・典型コメント (本人振り返りからの抜粋を匿名で)
- 業界・心理学的背景 (KY活動の研究、ヒューマンエラー理論、防衛運転の概念など)
- 当社特有か業界共通かの判定

## 4. 業界他社事例・労働安全衛生資料からの示唆 (Google検索必須・最低6件引用)
Google検索で実際に調べた以下を**最低6件、具体的な数値・年度付きで引用**:
- 厚労省「労働災害発生状況」「死傷災害発生状況」の運送業データ
- 国交省「事業用自動車総合安全プラン2025」「貨物自動車運送事業者の事故統計」
- 陸災防 (陸上貨物運送事業労働災害防止協会) の年次報告・指針
- JISHA・全日本トラック協会の白書
- 同業他社の重大事故ニュース・行政処分事例 (匿名化して教訓のみ抽出)
- 労働安全衛生規則・改善基準告示の関連条文
各引用について「**当社へのインプリケーション**」を1〜2行で添える。

## 5. 効果のあった歯止め・対策事例 (最低5件)
社内の歯止め記録と業界ベストプラクティスを組み合わせて5件以上:
- 各事例: 取り組み名・実施組織 (社内ならどの営業所か)・効果の根拠
- 業界ベストプラクティス例: 点呼支援システム、デジタコ、ドラレコAI解析、KYT基礎4ラウンド、3H点呼、健康起因事故予防 (SAS検査など)
- 「**当社にどう取り込めるか**」を3行以内で具体提案

## 6. 来月の重点項目提言 (3項目・各最低200字)
直近傾向 + 季節要因 (本日 ${new Date().toISOString().slice(0,10)}) + 業界年間カレンダー (国交省事故防止強調月間など) を踏まえた**具体的指導項目3つ**。各項目に:
- なぜこのテーマか (社内データの裏付け)
- どうやって展開するか (朝礼ネタ・KY活動例・点呼項目・教育ビデオなど具体施策3つ)
- 数値目標 (例: 「該当事故を翌月ゼロ件に」)

## 7. 安全管理者からの一言 (300字程度)
50代現場叩き上げ管理職として、社員に向けた指導メッセージ。厳しさと信頼を両立。

## 8. 安全三箇条 厳守で防げた事故の割合 (必須・最後に必ず表示)
当社の**安全三箇条** (会社オフィシャル / 全車両シール掲示済):
- 「速度」(制限速度遵守 + 状況に応じた減速)
- 「車間距離」(追突防止のための十分な車間)
- 「バック走行時目視確認」(バック前に必ず一旦停車・降車目視)

社内の事故データ (反省会記録 + 製品事故報告書 + 車両事故報告書) を**1件ずつ判定**し、もし三箇条のうち**いずれか一つでも厳守していれば防げた可能性が高い**事故をカウントしてください。
- 速度超過/急減速失敗 → 「速度」違反
- 追突/前方車への接触 → 「車間距離」違反
- バック時接触/後退時接触/誘導過信 → 「バック走行時目視確認」違反
- 上記の組み合わせも含む

**出力フォーマット (この章だけは必ず以下の文面で締めてください):**

> 全${totalRows}件のうち、安全三箇条の厳守で防げた可能性が高い事故は **N件 (○○%)** でした。
>
> 内訳:
> - 「速度」違反が関係した事故: A件 (a%)
> - 「車間距離」違反が関係した事故: B件 (b%)
> - 「バック走行時目視確認」違反が関係した事故: C件 (c%)
>
> **結局この三箇条を守るだけで○○%の事故は起きなかった。複雑な対策は要りません。三箇条を厳守する、これだけです。**

(※数値は実データから判定して計算してください。創作禁止。判定不能な事故は除外して構いません)

# 守るべきルール
- 個人名は出さない (データに伏字「●●」が含まれていてもそのまま伏字で扱う)
- 数字や比率は社内データは実値、業界データは検索結果から具体的な統計値を引用 (「○年版△△白書 N%」)
- **必ずGoogle検索で業界統計・公的資料を確認し、創作・推測の数字は使わない**
- 言葉遣いは硬めだが「〜してください」「〜が必要です」程度の指示形
- アスタリスク強調 (**) は本文では使わず、「」かぎ括弧で強調
- 引用URLは末尾の「引用元」セクションに自動で付与されるので、本文中でも[1][2]のような番号で簡潔に対応付け

# 分析対象データ (社内分)
${dataLines.join('\n')}`;

  try {
    const reportText = await geminiAnalyze(prompt);
    // 総括サマリだけ抽出 (## 1. 総括サマリ から ## 2. まで)
    const summaryMatch = /##\s*1\.\s*総括サマリ\s*\n([\s\S]*?)(?=\n##\s|$)/m.exec(reportText);
    const summary = (summaryMatch ? summaryMatch[1] : reportText.slice(0, 400)).trim().slice(0, 600);
    const ins = db.prepare(`INSERT INTO accident_analysis_reports
      (period_label, target_archives, target_reports, summary, full_report, generated_by)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      '全期間 (' + totalRows + '件)', archives.length, prodRows.length + vehRows.length,
      summary, reportText, req.uid);
    res.json({ success: true, id: ins.lastInsertRowid, report: reportText, summary, target_count: totalRows });
  } catch (e) {
    console.error('[analysis fail]', e);
    res.status(500).json({ success: false, msg: e.message });
  }
});

// 分析レポート一覧
router.get('/analysis', authUser, (req, res) => {
  const rows = getDb().prepare(`SELECT a.id, a.period_label, a.target_archives, a.target_reports,
       a.summary, a.created_at, a.generated_by, u.display_name AS generated_name
     FROM accident_analysis_reports a
     LEFT JOIN users u ON u.id = a.generated_by
     WHERE a.deleted_at IS NULL
     ORDER BY a.created_at DESC LIMIT 30`).all();
  res.json({ success: true, reports: rows });
});

// 分析レポート詳細 (full_report)
router.get('/analysis/:id', authUser, (req, res) => {
  const r = getDb().prepare(`SELECT * FROM accident_analysis_reports WHERE id = ? AND deleted_at IS NULL`).get(parseInt(req.params.id));
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  res.json({ success: true, report: r });
});

// 分析レポート削除 (管理職のみ)
router.delete('/analysis/:id', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ削除可' });
  getDb().prepare(`UPDATE accident_analysis_reports SET deleted_at = datetime('now','localtime') WHERE id = ?`).run(parseInt(req.params.id));
  res.json({ success: true });
});

// AI分析レポート用 資料スライド一括生成 (三箇条→matplotlib→Geminiイラスト→テキスト)
// 既存の「テキストのみのスクリーン投稿」を置き換え、ビジュアル豊かなプレゼンを構築
router.post('/analysis/:id/visual-screen', authUser, async (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ可' });
  const id = parseInt(req.params.id);
  const r = getDb().prepare(`SELECT * FROM accident_analysis_reports WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const fullText = r.full_report || '';
  const db = getDb();

  // 既存のtext型スライドを削除 (古いレポートが混ざるのを防ぐ)
  db.prepare(`UPDATE accident_screen_posts SET deleted_at = datetime('now') WHERE media_type = 'text' AND deleted_at IS NULL`).run();
  // 過去の生成済みチャート画像 (caption が "📊 " で始まる) も古い世代を削除
  db.prepare(`UPDATE accident_screen_posts SET deleted_at = datetime('now') WHERE media_type = 'image' AND caption LIKE '📊 %' AND deleted_at IS NULL`).run();
  db.prepare(`UPDATE accident_screen_posts SET deleted_at = datetime('now') WHERE media_type = 'image' AND caption LIKE '🎨 %' AND deleted_at IS NULL`).run();

  const slides = [];   // {type: 'text'|'image', title, body, url, caption}

  // (1) 表紙
  slides.push({ type: 'text', title: '📊 過去事故 AI分析レポート',
    body: '安全管理者からの全社共有\n\n' + (r.created_at || '').slice(0, 16) + ' 生成\n対象: 反省会記録 ' + (r.target_archives || 0) + ' 件 / 事故報告書 ' + (r.target_reports || 0) + ' 件' });

  // (2) 安全三箇条 — 冒頭に必ず差し込む (重要性の宣言)
  slides.push({ type: 'image', url: '/assets/safety_three_rules_sticker.png',
    caption: '🚨 会社オフィシャル 安全三箇条 — まず、これを守れば事故の大半は防げる' });
  slides.push({ type: 'text', title: '🚨 安全三箇条 — まず、これを守れば事故の大半は防げる',
    body: '当社が過去の事故を踏まえて定めた最重要ルール。全車両にシール掲示済み。\n\n' +
          '1. 「速度」 — 社速・法定速度を守る\n' +
          '2. 「車間距離」 — 車間距離を充分に空ける\n' +
          '3. 「バック走行時目視確認」 — バック時は降りて確認\n\n' +
          '複雑な対策は要りません。この三つを愚直に守ってください。' });

  // (3) AI分析レポートを章ごとに分割
  const sectionRegex = /(^|\n)##\s+(.+?)\n([\s\S]*?)(?=\n##\s|$)/g;
  const sections = [];
  let m;
  // 引用元・参考文献はスライドから除外 (スクリーン表示・読み上げの邪魔)
  const SKIP_TITLE_RE = /引用元|参考文献|参考資料|出典|references?|sources?/i;
  while ((m = sectionRegex.exec(fullText)) !== null) {
    const title = m[2].trim();
    if (SKIP_TITLE_RE.test(title)) continue;
    let body = m[3].trim()
      .replace(/^###\s+(.+)$/gm, '【$1】')
      .replace(/^##?\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/^-\s+/gm, '・')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\[\d+\](?:\[\d+\])*/g, '');   // [1][2] 等の引用番号を除去
    sections.push({ title, body });
  }

  // (4) matplotlib でグラフを生成
  let charts = [];
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('python3', ['/opt/cohub/server/scripts/gen_analysis_charts.py', '/opt/cohub/uploads'], {
      timeout: 60000, encoding: 'utf8',
    });
    const idx = out.lastIndexOf('===CHARTS===');
    if (idx >= 0) {
      const json = out.slice(idx + '===CHARTS==='.length).trim();
      const parsed = JSON.parse(json);
      charts = (parsed.charts || []).map((url, i) => ({ url, caption: parsed.captions[i] || '📊 グラフ' }));
    }
  } catch (e) { console.warn('[charts gen fail]', e.message.slice(0, 200)); }

  // (5) テキスト章とチャートをインターリーブで配置
  // 章1の後にチャート1、章2の後にチャート2、... と挟む
  const MAX_TEXT = 260;
  function pushTextChunked(s) {
    if (s.body.length <= MAX_TEXT) {
      slides.push({ type: 'text', title: s.title, body: s.body });
      return;
    }
    const chunks = [];
    let buf = '';
    for (const line of s.body.split('\n')) {
      if (line.length > MAX_TEXT) {
        if (buf) { chunks.push(buf); buf = ''; }
        for (let p = 0; p < line.length; p += MAX_TEXT) chunks.push(line.slice(p, p + MAX_TEXT));
        continue;
      }
      if ((buf + '\n' + line).length > MAX_TEXT && buf) { chunks.push(buf); buf = line; }
      else buf = buf ? buf + '\n' + line : line;
    }
    if (buf) chunks.push(buf);
    chunks.forEach((c, i) => slides.push({ type: 'text', title: s.title + ' (' + (i+1) + '/' + chunks.length + ')', body: c }));
  }

  for (let i = 0; i < sections.length; i++) {
    pushTextChunked(sections[i]);
    // 章の合間にチャートを差し込む (チャート分のループ位置)
    if (i < charts.length) {
      slides.push({ type: 'image', url: charts[i].url, caption: charts[i].caption });
    }
  }
  // 余ったチャートは末尾に追加
  for (let i = sections.length; i < charts.length; i++) {
    slides.push({ type: 'image', url: charts[i].url, caption: charts[i].caption });
  }

  // (6) 末尾に三箇条のリマインダー (任意)
  slides.push({ type: 'text', title: '🚨 結論 — まず、安全三箇条だけ守ってください',
    body: '速度・車間距離・バック時目視。\n\n複雑な対策は要りません。\n\nこの三つを愚直に守れば、事故の大半は防げます。' });

  // DBに投入: 全スライドが同一source_id配下 = 1ファイル扱い
  const sourceId = 'analysis_' + id + '_visual';
  const sourceLabel = '🎨 AI分析レポート (' + (r.created_at || '').slice(0, 10) + ') 図解付き';
  const stmtText = db.prepare(`INSERT INTO accident_screen_posts (media_url, media_type, caption, text_body, posted_by, source_id, source_label) VALUES ('analysis://' || ?, 'text', ?, ?, ?, ?, ?)`);
  const stmtImg = db.prepare(`INSERT INTO accident_screen_posts (media_url, media_type, caption, posted_by, source_id, source_label) VALUES (?, 'image', ?, ?, ?, ?)`);
  let inserted = 0;
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    if (s.type === 'text') {
      stmtText.run(id + '/' + i, (s.title || '').slice(0, 200), (s.body || '').slice(0, 2000), req.uid, sourceId, sourceLabel);
    } else if (s.type === 'image') {
      stmtImg.run(s.url, (s.caption || '').slice(0, 200), req.uid, sourceId, sourceLabel);
    }
    inserted++;
  }
  res.json({ success: true, inserted, charts: charts.length });
});

// AI分析レポートを章ごとに分割して前面スクリーンにテキストスライドとして掲示
router.post('/analysis/:id/screen', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ掲示可' });
  const id = parseInt(req.params.id);
  const r = getDb().prepare(`SELECT * FROM accident_analysis_reports WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const fullText = r.full_report || '';
  // ## 見出しで章を分割 (## 1. 〜 まで)
  const slides = [];
  // 表紙スライド
  slides.push({
    title: '📊 過去事故 AI分析レポート',
    body: '安全管理者からの全社共有\n\n' + (r.created_at || '').slice(0, 16) + ' 生成\n対象: 反省会記録 ' + (r.target_archives || 0) + ' 件 / 事故報告書 ' + (r.target_reports || 0) + ' 件',
  });
  // 章を抽出
  const sectionRegex = /(^|\n)##\s+(.+?)\n([\s\S]*?)(?=\n##\s|$)/g;
  let m;
  const SKIP_TITLE_RE2 = /引用元|参考文献|参考資料|出典|references?|sources?/i;
  while ((m = sectionRegex.exec(fullText)) !== null) {
    const title = m[2].trim();
    if (SKIP_TITLE_RE2.test(title)) continue;   // 引用元章はスライド化しない
    let body = m[3].trim();
    // 本文整形: ### サブ見出しを「【】」で、行頭"-"を「・」で
    body = body
      .replace(/^###\s+(.+)$/gm, '【$1】')
      .replace(/^##?\s+/gm, '')
      .replace(/^\*\*(.+?)\*\*/gm, '$1')
      .replace(/\*\*/g, '')
      .replace(/^-\s+/gm, '・')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\[\d+\](?:\[\d+\])*/g, '');   // [1][2] 等の引用番号も除去
    // 1スライドあたり260字を上限に分割 (canvas表示で確実に全文収まる安全マージン)
    const MAX = 260;
    if (body.length <= MAX) {
      slides.push({ title, body });
    } else {
      const chunks = [];
      let buf = '';
      for (const line of body.split('\n')) {
        // 1行が長すぎる場合は文字単位で分割
        if (line.length > MAX) {
          if (buf) { chunks.push(buf); buf = ''; }
          for (let p = 0; p < line.length; p += MAX) {
            chunks.push(line.slice(p, p + MAX));
          }
          continue;
        }
        if ((buf + '\n' + line).length > MAX && buf) { chunks.push(buf); buf = line; }
        else buf = buf ? buf + '\n' + line : line;
      }
      if (buf) chunks.push(buf);
      chunks.forEach((c, i) => slides.push({ title: title + ' (' + (i + 1) + '/' + chunks.length + ')', body: c }));
    }
  }
  if (slides.length <= 1) return res.status(400).json({ success: false, msg: 'レポート本文の解析に失敗しました' });

  // accident_screen_posts に投稿 (media_type='text')
  // 既存の text 型レポートスライドは削除 (古いレポートが混ざるのを防ぐ)
  getDb().prepare(`UPDATE accident_screen_posts SET deleted_at = datetime('now') WHERE media_type = 'text' AND deleted_at IS NULL`).run();
  const sourceId = 'analysis_' + id;
  const sourceLabel = '📊 AI分析レポート (' + (r.created_at || '').slice(0, 10) + ')';
  const stmt = getDb().prepare(`INSERT INTO accident_screen_posts (media_url, media_type, caption, text_body, posted_by, source_id, source_label) VALUES ('analysis://' || ?, 'text', ?, ?, ?, ?, ?)`);
  let inserted = 0;
  for (let i = 0; i < slides.length; i++) {
    stmt.run(id + '/' + i, slides[i].title.slice(0, 200), slides[i].body.slice(0, 2000), req.uid, sourceId, sourceLabel);
    inserted++;
  }
  res.json({ success: true, inserted });
});

// ============================================================
// 製品事故 (倉庫荷役)
// ============================================================
// マスタ: 原因
router.get('/causes', authUser, (req, res) => {
  const rows = getDb().prepare('SELECT id, category, template, keywords, sort_order FROM kbc_accident_cause_master ORDER BY sort_order, id').all();
  res.json({ success: true, causes: rows });
});

// マスタ: 商品
router.get('/products', authUser, (req, res) => {
  const rows = getDb().prepare('SELECT id, product_category, product_name, sort_order FROM kbc_accident_product_master ORDER BY sort_order, id').all();
  res.json({ success: true, products: rows });
});

// 製品事故 一覧
router.get('/product', authUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const status = req.query.status;
  const db = getDb();
  let sql = `SELECT * FROM kbc_accident_reports`;
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY accident_date DESC, id DESC LIMIT ?';
  params.push(limit);
  res.json({ success: true, reports: db.prepare(sql).all(...params) });
});

// 製品事故 詳細
router.get('/product/:id', authUser, (req, res) => {
  const r = getDb().prepare('SELECT * FROM kbc_accident_reports WHERE id = ?').get(parseInt(req.params.id));
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  res.json({ success: true, report: r });
});

// 製品事故 新規作成
router.post('/product', authUser, express.json({ limit: '20mb' }), (req, res) => {
  const b = req.body || {};
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const reporterName = b.reporter_name || (u && u.display_name) || '不明';
  if (!b.accident_date) return res.status(400).json({ success: false, msg: '事故発生日が必須です' });
  const ins = getDb().prepare(`INSERT INTO kbc_accident_reports
    (accident_date, accident_time, weather, timing, location_floor, location_area,
     reporter_name, accident_type, product_code, product_name, product_category, quantity,
     cause_category, cause_detail, situation_template, situation_detail, damage_description,
     media_paths, label_photo_path, reporter_reflection, similar_accident_known,
     handling, handling_instruction, cost_amount, cost_status, status,
     reported_to, reported_where, police_contact)
    VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?)`).run(
    b.accident_date, b.accident_time || null, b.weather || null, b.timing || null,
    b.location_floor || null, b.location_area || null,
    reporterName, b.accident_type || '製品破損', b.product_code || null, b.product_name || null,
    b.product_category || null, b.quantity || 1,
    b.cause_category || null, b.cause_detail || null, b.situation_template || null,
    b.situation_detail || null, b.damage_description || null,
    JSON.stringify(b.media_paths || []), b.label_photo_path || null, b.reporter_reflection || null,
    b.similar_accident_known || '有',
    b.handling || '関東BCへ連絡済み・指示待ち', b.handling_instruction || null,
    b.cost_amount || null, b.cost_status || '未定', b.status || 'submitted',
    b.reported_to || null, b.reported_where || null, b.police_contact || '無し');
  res.json({ success: true, id: ins.lastInsertRowid });
});

// 製品事故 更新
router.put('/product/:id', authUser, express.json({ limit: '20mb' }), (req, res) => {
  const id = parseInt(req.params.id);
  const r = getDb().prepare('SELECT id, status FROM kbc_accident_reports WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const b = req.body || {};
  const updates = [];
  const params = [];
  const editable = ['accident_date','accident_time','weather','timing','location_floor','location_area',
    'accident_type','product_code','product_name','product_category','quantity',
    'cause_category','cause_detail','situation_template','situation_detail','damage_description',
    'reporter_reflection','similar_accident_known','handling','handling_instruction',
    'cost_amount','cost_status','status','reported_to','reported_where','police_contact'];
  for (const k of editable) {
    if (b[k] !== undefined) { updates.push(`${k} = ?`); params.push(b[k]); }
  }
  if (b.media_paths !== undefined) { updates.push('media_paths = ?'); params.push(JSON.stringify(b.media_paths)); }
  if (b.manager_comment !== undefined && isManager(req.uid)) { updates.push('manager_comment = ?'); params.push(b.manager_comment); }
  if (!updates.length) return res.json({ success: true, msg: '変更なし' });
  updates.push("updated_at = datetime('now','localtime')");
  params.push(id);
  getDb().prepare(`UPDATE kbc_accident_reports SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// 製品事故 承認
router.post('/product/:id/approve', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ承認可' });
  const id = parseInt(req.params.id);
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  getDb().prepare(`UPDATE kbc_accident_reports SET status = 'approved', approved_by = ?, approved_at = datetime('now','localtime') WHERE id = ?`)
    .run((u && u.display_name) || req.uid, id);
  res.json({ success: true });
});

// 製品事故 削除
router.delete('/product/:id', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ削除可' });
  getDb().prepare('DELETE FROM kbc_accident_reports WHERE id = ?').run(parseInt(req.params.id));
  res.json({ success: true });
});

// ============================================================
// 車両事故 (運送ドライバー)
// ============================================================
router.get('/vehicle', authUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const db = getDb();
  const rows = db.prepare(`SELECT v.*, u.display_name AS reporter_display
                           FROM vehicle_accident_reports v
                           LEFT JOIN users u ON u.id = v.reporter_id
                           ORDER BY v.accident_date DESC, v.id DESC LIMIT ?`).all(limit);
  res.json({ success: true, reports: rows });
});

router.get('/vehicle/:id', authUser, (req, res) => {
  const r = getDb().prepare(`SELECT v.*, u.display_name AS reporter_display
                             FROM vehicle_accident_reports v
                             LEFT JOIN users u ON u.id = v.reporter_id
                             WHERE v.id = ?`).get(parseInt(req.params.id));
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  res.json({ success: true, report: r });
});

router.post('/vehicle', authUser, express.json({ limit: '20mb' }), (req, res) => {
  const b = req.body || {};
  if (!b.accident_date) return res.status(400).json({ success: false, msg: '事故発生日が必須です' });
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const ins = getDb().prepare(`INSERT INTO vehicle_accident_reports
    (accident_date, accident_time, weather, location, reporter_id, reporter_name,
     vehicle_no, accident_type, counter_party, injury_status, police_contact,
     insurance_status, cause_summary, description, media_paths,
     repair_status, cost_amount, status)
    VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?)`).run(
    b.accident_date, b.accident_time || null, b.weather || null, b.location || null,
    req.uid, (u && u.display_name) || '',
    b.vehicle_no || null, b.accident_type || null, b.counter_party || null,
    b.injury_status || '無し', b.police_contact || '無し',
    b.insurance_status || null, b.cause_summary || null, b.description || null,
    JSON.stringify(b.media_paths || []),
    b.repair_status || null, b.cost_amount || null, b.status || 'submitted');
  res.json({ success: true, id: ins.lastInsertRowid });
});

router.put('/vehicle/:id', authUser, express.json({ limit: '20mb' }), (req, res) => {
  const id = parseInt(req.params.id);
  const r = getDb().prepare('SELECT id FROM vehicle_accident_reports WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const b = req.body || {};
  const updates = [];
  const params = [];
  const editable = ['accident_date','accident_time','weather','location','vehicle_no',
    'accident_type','counter_party','injury_status','police_contact','insurance_status',
    'cause_summary','description','repair_status','cost_amount','status'];
  for (const k of editable) {
    if (b[k] !== undefined) { updates.push(`${k} = ?`); params.push(b[k]); }
  }
  if (b.media_paths !== undefined) { updates.push('media_paths = ?'); params.push(JSON.stringify(b.media_paths)); }
  if (b.manager_comment !== undefined && isManager(req.uid)) { updates.push('manager_comment = ?'); params.push(b.manager_comment); }
  if (!updates.length) return res.json({ success: true, msg: '変更なし' });
  updates.push("updated_at = datetime('now','localtime')");
  params.push(id);
  getDb().prepare(`UPDATE vehicle_accident_reports SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

router.post('/vehicle/:id/approve', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ承認可' });
  const id = parseInt(req.params.id);
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  getDb().prepare(`UPDATE vehicle_accident_reports SET status = 'approved', approved_by = ?, approved_at = datetime('now','localtime') WHERE id = ?`)
    .run((u && u.display_name) || req.uid, id);
  res.json({ success: true });
});

router.delete('/vehicle/:id', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ削除可' });
  getDb().prepare('DELETE FROM vehicle_accident_reports WHERE id = ?').run(parseInt(req.params.id));
  res.json({ success: true });
});

// ============================================================
// 統合: 両方の集計サマリ (管理画面ダッシュボード用)
// ============================================================
router.get('/summary', authUser, (req, res) => {
  const db = getDb();
  const productByType = db.prepare(`SELECT accident_type, COUNT(*) AS cnt FROM kbc_accident_reports GROUP BY accident_type ORDER BY cnt DESC`).all();
  const productByCause = db.prepare(`SELECT cause_category, COUNT(*) AS cnt FROM kbc_accident_reports GROUP BY cause_category ORDER BY cnt DESC`).all();
  const productByMonth = db.prepare(`SELECT substr(accident_date,1,7) AS month, COUNT(*) AS cnt FROM kbc_accident_reports GROUP BY month ORDER BY month DESC LIMIT 12`).all();
  const vehicleByType = db.prepare(`SELECT accident_type, COUNT(*) AS cnt FROM vehicle_accident_reports GROUP BY accident_type ORDER BY cnt DESC`).all();
  const vehicleByMonth = db.prepare(`SELECT substr(accident_date,1,7) AS month, COUNT(*) AS cnt FROM vehicle_accident_reports GROUP BY month ORDER BY month DESC LIMIT 12`).all();
  res.json({
    success: true,
    product: { total: db.prepare('SELECT COUNT(*) AS c FROM kbc_accident_reports').get().c, byType: productByType, byCause: productByCause, byMonth: productByMonth },
    vehicle: { total: db.prepare('SELECT COUNT(*) AS c FROM vehicle_accident_reports').get().c, byType: vehicleByType, byMonth: vehicleByMonth },
  });
});

module.exports = router;
