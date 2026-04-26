const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { analyzeBPImage, generateText } = require('../services/ai');
const fetchFn = require('node-fetch');
let XLSX; try { XLSX = require('xlsx'); } catch(e) { XLSX = null; }

// ============================================================
// 血圧記録
// ============================================================
router.get('/bp', authUser, (req, res) => {
  const db = getDb();
  // CoHub の bp_records + CoWell archive (cw_blood_pressure) を統合
  const cwIds = db.prepare('SELECT cw_id FROM cw_users WHERE cohub_uid = ?').all(req.uid).map(r => r.cw_id);
  const newRows = db.prepare(`SELECT id, systolic, diastolic, pulse, measured_at, memo, created_at, 'cohub' AS src
    FROM bp_records WHERE user_id = ? ORDER BY measured_at DESC LIMIT 100`).all(req.uid);
  let archive = [];
  if (cwIds.length) {
    const ph = cwIds.map(() => '?').join(',');
    archive = db.prepare(`SELECT cw_id AS id, systolic, diastolic, pulse, measured_at, NULL AS memo,
      cw_created_at AS created_at, 'cowell' AS src FROM cw_blood_pressure
      WHERE cw_user_id IN (${ph}) ORDER BY measured_at DESC LIMIT 100`).all(...cwIds);
  }
  const merged = [...newRows, ...archive].sort((a, b) =>
    (b.measured_at || b.created_at || '').localeCompare(a.measured_at || a.created_at || '')
  );
  res.json({ success: true, records: merged });
});

router.post('/bp', authUser, express.json(), (req, res) => {
  const b = req.body || {};
  const sys = parseInt(b.systolic);
  const dia = parseInt(b.diastolic);
  if (!sys || !dia || sys < 50 || sys > 300 || dia < 30 || dia > 200) {
    return res.status(400).json({ success: false, msg: '血圧値が不正です (収縮期 50-300, 拡張期 30-200)' });
  }
  const pulse = b.pulse ? parseInt(b.pulse) : null;
  const memo = String(b.memo || '').slice(0, 500);
  const measuredAt = b.measured_at || new Date().toISOString().slice(0, 19).replace('T', ' ');
  const ins = getDb().prepare(`INSERT INTO bp_records (user_id, systolic, diastolic, pulse, measured_at, memo)
    VALUES (?, ?, ?, ?, ?, ?)`).run(req.uid, sys, dia, pulse, measuredAt, memo);
  res.json({ success: true, id: ins.lastInsertRowid });
});

// 血圧計の写真をAIで読み取り
const bpUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
router.post('/bp/ocr', authUser, bpUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, msg: '画像必須' });
  try {
    const result = await analyzeBPImage(req.file.buffer, req.file.mimetype);
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, msg: 'AI読取エラー: ' + e.message });
  }
});

router.delete('/bp/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const r = getDb().prepare('DELETE FROM bp_records WHERE id = ? AND user_id = ?').run(id, req.uid);
  if (!r.changes) return res.status(404).json({ success: false, msg: '見つかりません' });
  res.json({ success: true });
});

// ============================================================
// 健康メモ
// ============================================================
router.get('/notes', authUser, (req, res) => {
  const rows = getDb().prepare(`SELECT id, note, tag, created_at FROM health_notes
    WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 100`).all(req.uid);
  res.json({ success: true, notes: rows });
});

router.post('/notes', authUser, express.json(), (req, res) => {
  const note = String((req.body && req.body.note) || '').slice(0, 2000).trim();
  if (!note) return res.status(400).json({ success: false, msg: '内容を入力してください' });
  const tag = String((req.body && req.body.tag) || '').slice(0, 30);
  const ins = getDb().prepare('INSERT INTO health_notes (user_id, note, tag) VALUES (?, ?, ?)')
    .run(req.uid, note, tag || null);
  res.json({ success: true, id: ins.lastInsertRowid });
});

router.delete('/notes/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const r = getDb().prepare("UPDATE health_notes SET deleted_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(id, req.uid);
  if (!r.changes) return res.status(404).json({ success: false, msg: '見つかりません' });
  res.json({ success: true });
});

// ============================================================
// 健康診断結果 (PDF/画像アップロード保管)
// ============================================================
const checkupDir = path.join(__dirname, '..', '..', 'uploads', 'checkup');
if (!fs.existsSync(checkupDir)) fs.mkdirSync(checkupDir, { recursive: true });
const checkupUpload = multer({
  storage: multer.diskStorage({
    destination: checkupDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').slice(0, 8) || '.pdf').replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, req.uid.slice(0, 8) + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^(application\/pdf|image\/)/.test(file.mimetype || '')) return cb(new Error('PDFまたは画像のみ'));
    cb(null, true);
  },
});

router.get('/checkups', authUser, (req, res) => {
  const rows = getDb().prepare(`SELECT id, year, file_url, file_name, file_size, uploaded_at
    FROM health_checkups WHERE user_id = ? AND deleted_at IS NULL ORDER BY year DESC, id DESC`).all(req.uid);
  res.json({ success: true, checkups: rows });
});

router.post('/checkups', authUser, checkupUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, msg: 'ファイル必須' });
  const year = parseInt(req.body && req.body.year) || new Date().getFullYear();
  const ins = getDb().prepare(`INSERT INTO health_checkups (user_id, year, file_url, file_name, file_size)
    VALUES (?, ?, ?, ?, ?)`).run(
    req.uid, year,
    '/uploads/checkup/' + req.file.filename,
    req.file.originalname,
    req.file.size
  );
  res.json({ success: true, id: ins.lastInsertRowid });
});

router.delete('/checkups/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const c = db.prepare('SELECT file_url FROM health_checkups WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, req.uid);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  db.prepare("UPDATE health_checkups SET deleted_at = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
});

// 健診ファイル配信 (本人のみ)
router.get('/checkup-file/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const c = getDb().prepare('SELECT file_url, file_name FROM health_checkups WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, req.uid);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  const fname = c.file_url.replace(/^\/uploads\/checkup\//, '');
  if (!/^[a-zA-Z0-9._-]+$/.test(fname)) return res.status(400).end();
  res.sendFile(path.join(checkupDir, fname), {
    headers: { 'Content-Disposition': 'inline; filename="' + encodeURIComponent(c.file_name || fname) + '"' }
  });
});

// ============================================================
// 健診PDF AI分析 (Gemini Vision)
// ============================================================
router.post('/checkups/:id/analyze', authUser, async (req, res) => {
  const id = parseInt(req.params.id);
  const c = getDb().prepare('SELECT file_url, file_name FROM health_checkups WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, req.uid);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  const fname = c.file_url.replace(/^\/uploads\/checkup\//, '');
  if (!/^[a-zA-Z0-9._-]+$/.test(fname)) return res.status(400).end();
  const fpath = path.join(checkupDir, fname);
  if (!fs.existsSync(fpath)) return res.status(404).json({ success: false, msg: 'ファイル無し' });
  try {
    const buf = fs.readFileSync(fpath);
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
    const ext = path.extname(c.file_name || '').toLowerCase();
    const mime = ext === '.pdf' ? 'application/pdf' : (ext === '.png' ? 'image/png' : 'image/jpeg');
    const prompt = `あなたは健康診断結果を読み解く産業医です。アップロードされた健診結果から重要なポイントを抽出して以下の純粋なJSONで回答 (前置き禁止):

{
  "summary": "総合所見3〜5行",
  "values": [
    {"name": "BMI", "value": "数値", "unit": "kg/m2", "judgment": "正常/要注意/要観察/要医療", "ref_range": "基準値"}
  ],
  "highlights": [
    {"category": "血圧/脂質/血糖/肝機能/腎機能/貧血/その他", "level": "good/caution/warning/danger", "message": "1行コメント"}
  ],
  "advice": "今日からできるアクション3〜5項目を箇条書きで (200字以内)"
}

ルール:
- values は読み取れた主要数値 (BMI/血圧/中性脂肪/HDL/LDL/HbA1c/AST/ALT/γGT/eGFR等)
- highlights は問題ありの項目を優先 (good より warning/danger を重点的に)
- 個人特定情報 (氏名/生年月日) は含めない
- 不明な値は省略`;
    const body = {
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: mime, data: buf.toString('base64') } },
        { text: prompt },
      ]}],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
    };
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
    const r = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('Gemini HTTP ' + r.status);
    const data = await r.json();
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    let txt = ''; if (parts) for (const p of parts) if (p.text) txt += p.text;
    txt = txt.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) txt = m[0];
    let parsed;
    try { parsed = JSON.parse(txt); }
    catch (e) { return res.status(500).json({ success: false, msg: 'AI応答解析失敗', raw: txt.slice(0, 400) }); }
    res.json({ success: true, analysis: parsed });
  } catch (e) {
    res.status(500).json({ success: false, msg: e.message });
  }
});

// ============================================================
// 健診Box連携 — 氏名+生年月日でBox上の判定結果xlsm検索
// ============================================================
async function getBoxToken() {
  if (!process.env.BOX_CLIENT_ID) throw new Error('BOX_CLIENT_ID未設定');
  const r = await fetchFn('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'client_id=' + process.env.BOX_CLIENT_ID +
      '&client_secret=' + process.env.BOX_CLIENT_SECRET +
      '&grant_type=client_credentials&box_subject_type=enterprise' +
      '&box_subject_id=' + (process.env.BOX_ENTERPRISE_ID || '0'),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Box認証失敗: ' + (j.error_description || j.error || 'unknown'));
  return j.access_token;
}

router.get('/box-checkup', authUser, async (req, res) => {
  if (!XLSX) return res.status(500).json({ success: false, msg: 'xlsxライブラリ未インストール' });
  const u = getDb().prepare('SELECT display_name, birth_date FROM users WHERE id = ?').get(req.uid);
  if (!u || !u.display_name) return res.status(400).json({ success: false, msg: 'ユーザー情報不足' });
  const folderId = process.env.BOX_CHECKUP_FOLDER_ID || '354720844674';
  try {
    const token = await getBoxToken();
    // フォルダ内の判定結果xlsmを探す
    const lr = await fetchFn(`https://api.box.com/2.0/folders/${folderId}/items?fields=id,name,type&limit=1000`, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const ldata = await lr.json();
    const xlsmFiles = (ldata.entries || []).filter(e => e.type === 'file' && /判定結果.*\.(xlsm|xlsx)$/i.test(e.name));
    if (!xlsmFiles.length) return res.json({ success: false, msg: 'Boxに判定結果ファイルが見つかりません' });

    // 最新ファイル取得 (名前で年度ソート、降順)
    xlsmFiles.sort((a, b) => b.name.localeCompare(a.name));
    const latest = xlsmFiles[0];
    const fr = await fetchFn(`https://api.box.com/2.0/files/${latest.id}/content`, {
      headers: { 'Authorization': 'Bearer ' + token }, redirect: 'follow',
    });
    if (!fr.ok) throw new Error('Box DL失敗: ' + fr.status);
    const buf = await fr.buffer();

    // xlsm から該当氏名行を抽出
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets['判定結果'];
    if (!sheet) return res.json({ success: false, msg: '判定結果シートが無い (' + latest.name + ')' });
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const target = u.display_name.replace(/[\s　]+/g, '');
    const targetBd = (u.birth_date || '').replace(/[-/]/g, '');
    let found = null;
    for (let i = 4; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r[2]) continue;
      const name = String(r[2]).replace(/[\s　]+/g, '');
      if (name === target) {
        // 生年月日もチェック (あれば)
        if (targetBd) {
          const rowBd = String(r[7] || '').replace(/[\s　\-\/年月日]/g, '');
          if (rowBd && rowBd !== targetBd) continue;
        }
        found = {
          氏名: r[2], 支店名: r[4] || '', 職種: r[6] || '',
          生年月日: r[7] || '', 年齢: r[8] || '', 性別: r[9] || '',
          健診受診日: r[10] || '',
          肥満判定: r[11] || '', 高血圧判定: r[12] || '', 脂質異常判定: r[13] || '',
          高血糖判定: r[14] || '', 肝機能判定: r[17] || '', 腎機能判定: r[18] || '',
          貧血判定: r[19] || '',
          身長: r[29] || '', 体重: r[30] || '', BMI: r[31] || '', 腹囲: r[32] || '',
          収縮期血圧: r[38] || r[34] || '', 拡張期血圧: r[39] || r[35] || '',
          中性脂肪: r[42] || '', HDL: r[43] || '', LDL: r[44] || '',
          AST: r[45] || '', ALT: r[46] || '', γGT: r[47] || '',
          空腹時血糖: r[49] || '', HbA1c: r[50] || '',
        };
        break;
      }
    }
    if (!found) return res.json({ success: false, msg: 'Box内に該当データが見つかりません (氏名: ' + u.display_name + ', 生年月日: ' + (u.birth_date || '未登録') + ')' });
    res.json({ success: true, source: latest.name, data: found });
  } catch (e) {
    res.status(500).json({ success: false, msg: e.message });
  }
});

module.exports = router;
