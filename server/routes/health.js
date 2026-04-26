const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { analyzeBPImage } = require('../services/ai');

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

module.exports = router;
