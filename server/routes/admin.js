const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../services/db');
const { authAdmin } = require('../middleware/auth');
const { transcribeRecording } = require('../services/ai');

const recDir = path.join(__dirname, '..', '..', 'uploads', 'recordings');
if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });
const recUpload = multer({
  storage: multer.diskStorage({
    destination: recDir,
    filename: (req, file, cb) => cb(null, Date.now() + '_' + (req.uid || 'anon').slice(0, 8) + '.webm'),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ユーザー一覧
router.get('/users', authAdmin, (req, res) => {
  const rows = getDb().prepare(`SELECT u.id, u.login_id, u.display_name, u.company_code, u.role, u.avatar_url,
    u.last_seen_at, p.status FROM users u LEFT JOIN positions p ON p.user_id = u.id ORDER BY u.created_at DESC`).all();
  res.json({ success: true, users: rows });
});

// ユーザー作成（1件）
router.post('/users', authAdmin, (req, res) => {
  const { login_id, display_name, company_code, password, role } = req.body;
  if (!login_id || !display_name || !company_code || !password) {
    return res.status(400).json({ success: false, msg: '必須項目が不足しています' });
  }
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(login_id);
  if (exists) return res.status(400).json({ success: false, msg: 'このログインIDは既に使われています' });
  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (id, login_id, password_hash, display_name, company_code, role)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, login_id, hash, display_name, company_code, role || 'member');
  res.json({ success: true, id });
});

// CSV一括登録
router.post('/users/bulk', authAdmin, (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ success: false, msg: 'CSVが空です' });
  const lines = csv.trim().split(/\r?\n/);
  const db = getDb();
  const results = { created: 0, skipped: 0, errors: [] };
  const insert = db.prepare(`INSERT INTO users (id, login_id, password_hash, display_name, company_code, role)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const txn = db.transaction(() => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      // フォーマット: login_id,display_name,company_code,password[,role]
      const parts = line.split(',').map(s => s.trim());
      if (parts.length < 4) { results.errors.push(`行${i+1}: 列不足`); continue; }
      const [login_id, display_name, company_code, password, role] = parts;
      const exists = db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(login_id);
      if (exists) { results.skipped++; continue; }
      const id = crypto.randomUUID();
      const hash = bcrypt.hashSync(password, 10);
      insert.run(id, login_id, hash, display_name, company_code, role || 'member');
      results.created++;
    }
  });
  txn();
  res.json({ success: true, ...results });
});

// パスワードリセット
router.post('/users/:id/password', authAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ success: false, msg: 'パスワードを指定してください' });
  const hash = bcrypt.hashSync(password, 10);
  const r = getDb().prepare('UPDATE users SET password_hash = ?, session_token = NULL WHERE id = ?').run(hash, req.params.id);
  res.json({ success: r.changes > 0 });
});

// ユーザー削除
router.delete('/users/:id', authAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM positions WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').run(req.params.id, req.params.id);
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: r.changes > 0 });
});

// ========== 録音機能 ==========
router.post('/recording/upload', authAdmin, recUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, msg: 'ファイルなし' });
  const duration_ms = parseInt(req.body.duration_ms) || 0;
  const floor_code = (req.body.floor_code || '').toString();
  const note = (req.body.note || '').toString().slice(0, 500);
  const ins = getDb().prepare(`INSERT INTO recordings (filename, size, duration_ms, floor_code, recorded_by, note) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.file.filename, req.file.size, duration_ms, floor_code, req.uid, note);
  res.json({ success: true, id: ins.lastInsertRowid });
});

router.get('/recording', authAdmin, (req, res) => {
  const rows = getDb().prepare(`SELECT r.id, r.filename, r.size, r.duration_ms, r.floor_code, r.recorded_by, r.note, r.created_at,
    r.transcript_at,
    CASE WHEN r.transcript IS NOT NULL AND length(r.transcript) > 0 THEN 1 ELSE 0 END AS has_transcript,
    u.display_name AS recorded_by_name FROM recordings r LEFT JOIN users u ON u.id = r.recorded_by ORDER BY r.created_at DESC LIMIT 500`).all();
  res.json({ success: true, recordings: rows });
});

// AI議事録 生成 (録音ファイル → Gemini)
router.post('/recording/:id/transcribe', authAdmin, async (req, res) => {
  const row = getDb().prepare('SELECT filename, transcript FROM recordings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, msg: '録音が見つかりません' });
  const fp = path.join(recDir, row.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ success: false, msg: 'ファイル不在' });
  const stat = fs.statSync(fp);
  if (stat.size > 30 * 1024 * 1024) {
    return res.status(400).json({ success: false, msg: 'ファイルが30MBを超えます (長すぎる会議は分割必要)' });
  }
  try {
    const buf = fs.readFileSync(fp);
    const b64 = buf.toString('base64');
    const text = await transcribeRecording(b64, 'audio/webm');
    getDb().prepare("UPDATE recordings SET transcript=?, transcript_at=datetime('now') WHERE id=?").run(text, req.params.id);
    res.json({ success: true, transcript: text });
  } catch (e) {
    console.error('[transcribe]', e);
    res.status(500).json({ success: false, msg: e.message });
  }
});

router.get('/recording/:id/transcript', authAdmin, (req, res) => {
  const row = getDb().prepare('SELECT transcript, transcript_at FROM recordings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false });
  res.json({ success: true, transcript: row.transcript || '', transcript_at: row.transcript_at });
});

router.get('/recording/:id', authAdmin, (req, res) => {
  const row = getDb().prepare('SELECT filename FROM recordings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).end();
  const fp = path.join(recDir, row.filename);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/webm');
  fs.createReadStream(fp).pipe(res);
});

router.delete('/recording/:id', authAdmin, (req, res) => {
  const row = getDb().prepare('SELECT filename FROM recordings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false });
  try { fs.unlinkSync(path.join(recDir, row.filename)); } catch (e) {}
  getDb().prepare('DELETE FROM recordings WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// 出席履歴
router.get('/attendance', authAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
  const userId = (req.query.user_id || '').toString().trim();
  const floor = (req.query.floor || '').toString().trim();
  const since = (req.query.since || '').toString().trim();
  const until = (req.query.until || '').toString().trim();
  let sql = `SELECT a.id, a.user_id, a.floor_code, a.event_type, a.at,
             u.display_name, u.login_id FROM attendance a
             LEFT JOIN users u ON u.id = a.user_id WHERE 1=1`;
  const params = [];
  if (userId) { sql += ' AND a.user_id = ?'; params.push(userId); }
  if (floor) { sql += ' AND a.floor_code = ?'; params.push(floor); }
  if (since) { sql += ' AND a.at >= ?'; params.push(since); }
  if (until) { sql += " AND a.at <= ? || ' 23:59:59'"; params.push(until); }
  sql += ' ORDER BY a.at DESC LIMIT ?';
  params.push(limit);
  const rows = getDb().prepare(sql).all(...params);
  res.json({ success: true, events: rows });
});

module.exports = router;
