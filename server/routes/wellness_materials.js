const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { execFile, execFileSync } = require('child_process');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// ===== 推進メンバー 会議資料アップロード (1件に複数ファイル対応) =====
// 1つの資料(タイトル/会議日/メモ)に レジュメ・議事録 など複数ファイルを添付できる。
// PDF は board.js と同じ命名規則でサムネ/ページ画像を生成し、アプリ内ビューアで閲覧。

// --- テーブル (無ければ作成) ---
(function ensureTable() {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS wellness_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      meeting_date TEXT,
      note TEXT,
      file_url TEXT NOT NULL,
      orig_name TEXT,
      mime TEXT,
      kind TEXT,
      uploaded_by TEXT,
      uploaded_at TEXT DEFAULT (datetime('now')),
      deleted_at TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS wellness_material_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL,
      file_url TEXT NOT NULL,
      orig_name TEXT,
      mime TEXT,
      kind TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    // 旧・単一ファイル行を子テーブルへバックフィル (冪等)
    db.exec(`INSERT INTO wellness_material_files (material_id, file_url, orig_name, mime, kind, sort_order)
             SELECT id, file_url, orig_name, mime, kind, 0 FROM wellness_materials
             WHERE deleted_at IS NULL AND file_url IS NOT NULL
               AND id NOT IN (SELECT material_id FROM wellness_material_files)`);
  } catch (e) { console.warn('wellness_materials ensureTable', (e.message || '').slice(0, 160)); }
})();

// --- アクセス権 (推進 or 管理者) ---
function access(uid) {
  const u = getDb().prepare(`SELECT is_field_promoter, is_warehouse_promoter, role, employee_type
                             FROM users WHERE id = ?`).get(uid);
  if (!u) return { ok: false, admin: false };
  const admin = u.role === 'admin' || u.employee_type === 'admin';
  const promoter = !!u.is_field_promoter || !!u.is_warehouse_promoter;
  return { ok: admin || promoter, admin };
}
function gate(req, res, next) {
  const a = access(req.uid);
  if (!a.ok) return res.status(403).json({ success: false, msg: '推進メンバー専用です' });
  req._isAdmin = a.admin;
  next();
}

// --- PDF サムネ/ページ画像 (board.js と同一規則) ---
const PDF_MAX_PAGES = 30;
function pdfPageCount(absPdf) {
  try {
    const out = execFileSync('pdfinfo', [absPdf], { timeout: 15000 }).toString();
    const m = out.match(/^Pages:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : 0;
  } catch (_) { return 0; }
}
function generatePdfThumb(absPdf) {
  try {
    execFileSync('pdftoppm', ['-jpeg', '-singlefile', '-f', '1', '-l', '1', '-scale-to', '480', absPdf, absPdf + '.thumb'], { timeout: 20000 });
    return true;
  } catch (_) { return false; }
}
function generatePdfPages(absPdf) {
  const pages = Math.min(pdfPageCount(absPdf) || 1, PDF_MAX_PAGES);
  let n = 1;
  const next = () => {
    if (n > pages) return;
    const p = n++;
    execFile('pdftoppm', ['-jpeg', '-singlefile', '-f', String(p), '-l', String(p), '-scale-to', '1100', absPdf, absPdf + '.p' + p], { timeout: 30000 }, () => next());
  };
  next();
}

// --- アップロード先 ---
const matDir = path.join(__dirname, '..', '..', 'uploads', 'wellness_materials');
if (!fs.existsSync(matDir)) fs.mkdirSync(matDir, { recursive: true });

const ALLOWED_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt'];
const upload = multer({
  storage: multer.diskStorage({
    destination: matDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').slice(0, 8) || '.bin').toLowerCase().replace(/[^a-z0-9.]/g, '');
      cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 40 * 1024 * 1024, files: 12 }, // 各40MB・最大12ファイル
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_EXT.includes(ext)) return cb(null, true);
    cb(new Error('対応していないファイル形式です (PDF/画像/Office/CSV/txt)'));
  },
});

function kindOf(filename, mime) {
  if (/\.pdf$/i.test(filename)) return 'pdf';
  if (/^image\//.test(mime || '') || /\.(png|jpe?g|gif|webp)$/i.test(filename)) return 'image';
  return 'file';
}
// multer は originalname を latin1 として渡すため、日本語ファイル名は latin1→utf8 で復元
function fixName(s) {
  try { return Buffer.from(String(s || ''), 'latin1').toString('utf8'); }
  catch (_) { return String(s || ''); }
}

// 資料に紐づくファイル配列を取得
function filesFor(ids) {
  if (!ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT id, material_id, file_url, orig_name, mime, kind
                                FROM wellness_material_files WHERE material_id IN (${ph})
                                ORDER BY material_id, sort_order, id`).all(...ids);
  const map = {};
  for (const r of rows) (map[r.material_id] = map[r.material_id] || []).push(r);
  return map;
}

// --- 一覧 ---
router.get('/', authUser, gate, (req, res) => {
  const mats = getDb().prepare(`SELECT m.id, m.title, m.meeting_date, m.note, m.uploaded_by, m.uploaded_at,
                                       u.display_name AS uploader_name
                                FROM wellness_materials m LEFT JOIN users u ON u.id = m.uploaded_by
                                WHERE m.deleted_at IS NULL
                                ORDER BY m.id DESC LIMIT 300`).all();
  const fmap = filesFor(mats.map(m => m.id));
  const me = req.uid;
  res.json({
    success: true,
    is_admin: !!req._isAdmin,
    materials: mats.map(m => ({
      ...m,
      files: fmap[m.id] || [],
      can_delete: req._isAdmin || m.uploaded_by === me,
    })),
  });
});

// --- アップロード (複数ファイル: レジュメ+議事録 等をまとめて) ---
router.post('/', authUser, gate, upload.array('files', 12), (req, res) => {
  const title = String((req.body && req.body.title) || '').slice(0, 120).trim();
  const meetingDate = String((req.body && req.body.meeting_date) || '').slice(0, 20).trim() || null;
  const note = String((req.body && req.body.note) || '').slice(0, 500).trim() || null;
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ success: false, msg: 'ファイルが必要です' });
  if (!title) return res.status(400).json({ success: false, msg: 'タイトルが必要です' });

  const db = getDb();
  const first = files[0];
  const firstUrl = '/uploads/wellness_materials/' + first.filename;
  const firstKind = kindOf(first.filename, first.mimetype);
  // 親行 (file_url は NOT NULL のため先頭ファイルを代表値に)
  const ins = db.prepare(`INSERT INTO wellness_materials
      (title, meeting_date, note, file_url, orig_name, mime, kind, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(title, meetingDate, note, firstUrl, fixName(first.originalname).slice(0, 200), first.mimetype || '', firstKind, req.uid);
  const matId = ins.lastInsertRowid;

  const insFile = db.prepare(`INSERT INTO wellness_material_files
      (material_id, file_url, orig_name, mime, kind, sort_order) VALUES (?, ?, ?, ?, ?, ?)`);
  files.forEach((f, i) => {
    const url = '/uploads/wellness_materials/' + f.filename;
    const kind = kindOf(f.filename, f.mimetype);
    if (kind === 'pdf') {
      const absPdf = path.join(matDir, f.filename);
      generatePdfThumb(absPdf);
      generatePdfPages(absPdf);
    }
    insFile.run(matId, url, fixName(f.originalname).slice(0, 200), f.mimetype || '', kind, i);
  });

  const m = db.prepare(`SELECT m.id, m.title, m.meeting_date, m.note, m.uploaded_by, m.uploaded_at,
                               u.display_name AS uploader_name
                        FROM wellness_materials m LEFT JOIN users u ON u.id = m.uploaded_by WHERE m.id = ?`).get(matId);
  const fmap = filesFor([matId]);
  res.json({ success: true, material: { ...m, files: fmap[matId] || [], can_delete: true } });
});

// --- 削除 (投稿者 or 管理者、論理削除) ---
router.delete('/:id', authUser, gate, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const m = db.prepare('SELECT uploaded_by FROM wellness_materials WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!m) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!req._isAdmin && m.uploaded_by !== req.uid) return res.status(403).json({ success: false, msg: '投稿者または管理者のみ削除可' });
  db.prepare("UPDATE wellness_materials SET deleted_at = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
});

module.exports = router;
