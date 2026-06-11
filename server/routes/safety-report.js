// 安全衛生委員会 月報API (2026-06-09)
// PDF月報を担当者(管理職 is_manager)がアップロード・更新、全社員が閲覧/DL。
// 新規掲載時に全閲覧者へPush通知。
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// テーブル作成 (初回ロード時)
getDb().prepare(`CREATE TABLE IF NOT EXISTS safety_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_name TEXT,
  file_size INTEGER,
  note TEXT,
  uploaded_by TEXT,
  uploaded_by_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`).run();

// 保存先 uploads/safety-report/
const reportDir = path.join(__dirname, '..', '..', 'uploads', 'safety-report');
if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

const reportUpload = multer({
  storage: multer.diskStorage({
    destination: reportDir,
    filename: (req, file, cb) => {
      cb(null, 'safety_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.pdf');
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // PDF 最大25MB
  fileFilter: (req, file, cb) => {
    const isPdf = (file.mimetype === 'application/pdf') || /\.pdf$/i.test(file.originalname || '');
    if (!isPdf) return cb(new Error('PDFファイルのみアップロード可'));
    cb(null, true);
  },
});

// 管理職判定 (is_manager=1 / employee_type='admin' / role='admin' のいずれか)
function isManager(uid) {
  const r = getDb().prepare('SELECT employee_type, role, is_manager FROM users WHERE id = ?').get(uid);
  return !!(r && (r.is_manager === 1 || r.employee_type === 'admin' || r.role === 'admin'));
}

// originalname の latin1→utf8 復元 (multer/busboy は latin1 で渡すため日本語が化ける)
function decodeName(name) {
  if (!name) return '';
  try {
    const buf = Buffer.from(name, 'latin1');
    const dec = buf.toString('utf8');
    // 往復で壊れていなければ utf8 採用、壊れていたら原文
    return Buffer.from(dec, 'utf8').toString('latin1') === name ? dec : name;
  } catch (e) { return name; }
}

// 一覧取得 (ログイン済み全員)
router.get('/list', authUser, (req, res) => {
  const rows = getDb().prepare(
    'SELECT id, year, month, title, file_path, file_name, file_size, note, uploaded_by_name, created_at FROM safety_reports ORDER BY year DESC, month DESC, created_at DESC'
  ).all();
  res.json({ success: true, can_edit: isManager(req.uid), reports: rows });
});

// アップロード (管理職のみ)
router.post('/upload', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: 'この機能は管理職のみ利用できます' });
  reportUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, msg: err.message || 'アップロード失敗' });
    if (!req.file) return res.status(400).json({ success: false, msg: 'PDFファイルを選択してください' });
    const year = parseInt(req.body.year, 10);
    const month = parseInt(req.body.month, 10);
    const title = String(req.body.title || '').trim().slice(0, 120);
    const note = String(req.body.note || '').trim().slice(0, 300);
    if (!year || !month || month < 1 || month > 12 || !title) {
      fs.unlink(path.join(reportDir, req.file.filename), () => {});
      return res.status(400).json({ success: false, msg: '年・月・タイトルは必須です' });
    }
    const db = getDb();
    const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {};
    const origName = decodeName(req.file.originalname || '').slice(0, 200);
    const filePath = '/uploads/safety-report/' + req.file.filename;
    const ins = db.prepare(
      'INSERT INTO safety_reports (year, month, title, file_path, file_name, file_size, note, uploaded_by, uploaded_by_name) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(year, month, title, filePath, origName, req.file.size || 0, note, req.uid, me.display_name || '');

    // 全閲覧者へPush通知 (bot/ゲスト/レビュアー除外、投稿者本人も除外)
    try {
      const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
      if (sendPush) {
        const viewers = db.prepare(
          "SELECT id FROM users WHERE role != 'bot' AND (employee_type IS NULL OR employee_type NOT IN ('bot','guest')) AND COALESCE(is_guest_reviewer,0)=0"
        ).all();
        for (const v of viewers) {
          if (v.id === req.uid) continue;
          sendPush(v.id, {
            title: '🦺 安全衛生委員会 月報',
            body: `${year}年${month}月「${title}」が掲載されました`,
            tag: 'safety-report',
            url: '/safety-report.html',
          }).catch(() => {});
        }
      }
    } catch (e) { console.warn('[safety-report push]', e.message); }

    res.json({ success: true, id: ins.lastInsertRowid });
  });
});

// 削除 (管理職のみ) — ファイルも削除
router.delete('/:id', authUser, express.json(), (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: 'この機能は管理職のみ利用できます' });
  const db = getDb();
  const row = db.prepare('SELECT file_path FROM safety_reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  db.prepare('DELETE FROM safety_reports WHERE id = ?').run(req.params.id);
  try {
    if (row.file_path && row.file_path.startsWith('/uploads/safety-report/')) {
      fs.unlink(path.join(__dirname, '..', '..', row.file_path), () => {});
    }
  } catch (e) { /* ignore */ }
  res.json({ success: true });
});

module.exports = router;
