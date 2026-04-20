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
  const { login_id, display_name, company_code, password, role, employee_type } = req.body;
  if (!login_id || !display_name || !company_code || !password) {
    return res.status(400).json({ success: false, msg: '必須項目が不足しています' });
  }
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(login_id);
  if (exists) return res.status(400).json({ success: false, msg: 'このログインIDは既に使われています' });
  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync(password, 10);
  const etype = (employee_type === 'field' || employee_type === 'admin') ? employee_type : 'office';
  db.prepare(`INSERT INTO users (id, login_id, password_hash, display_name, company_code, role, employee_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, login_id, hash, display_name, company_code, role || 'member', etype);
  res.json({ success: true, id });
});

// CSV一括登録
// フォーマット: login_id,display_name,company_code,password[,role[,employee_type]]
router.post('/users/bulk', authAdmin, (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ success: false, msg: 'CSVが空です' });
  const lines = csv.trim().split(/\r?\n/);
  const db = getDb();
  const results = { created: 0, skipped: 0, errors: [] };
  const validRoles = new Set(['member', 'admin']);
  const validEtypes = new Set(['office', 'field', 'admin']);
  // 既知の company コード一覧 (UNKNOWN は弾く)
  const validCompanies = new Set(db.prepare('SELECT code FROM companies').all().map(r => r.code));
  const insert = db.prepare(`INSERT INTO users (id, login_id, password_hash, display_name, company_code, role, employee_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const txn = db.transaction(() => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(',').map(s => s.trim());
      if (parts.length < 4) { results.errors.push(`行${i+1}: 列不足 (4列以上必要)`); continue; }
      const [login_id, display_name, company_code, password, roleRaw, etypeRaw] = parts;
      if (!login_id || !display_name || !company_code || !password) { results.errors.push(`行${i+1}: 必須項目空欄`); continue; }
      if (!validCompanies.has(company_code)) { results.errors.push(`行${i+1}: 会社コード '${company_code}' が未定義`); continue; }
      const role = validRoles.has(roleRaw) ? roleRaw : 'member';
      const etype = validEtypes.has(etypeRaw) ? etypeRaw : 'office';
      if (password.length < 8) { results.errors.push(`行${i+1}: パスワード短すぎ (8文字以上)`); continue; }
      const exists = db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(login_id);
      if (exists) { results.skipped++; continue; }
      const id = crypto.randomUUID();
      const hash = bcrypt.hashSync(password, 10);
      insert.run(id, login_id, hash, display_name, company_code, role, etype);
      results.created++;
    }
  });
  txn();
  res.json({ success: true, ...results });
});

// CSVテンプレート (BOM付きUTF-8でExcel/Numbers互換)
router.get('/users/csv-template', authAdmin, (req, res) => {
  const db = getDb();
  const companies = db.prepare('SELECT code, name FROM companies ORDER BY code').all();
  const compList = companies.map(c => `#   ${c.code.padEnd(14)} = ${c.name}`).join('\n');
  const tpl = '\uFEFF' + [
    '# CoHub メンバー一括登録CSV テンプレート',
    '# ───────────────────────────────────────────────',
    '# 列: login_id,display_name,company_code,password,role,employee_type',
    '#  login_id        : ログインID (英数字, 重複不可)',
    '#  display_name    : 表示名 (日本語OK, 例: 山田太郎)',
    '#  company_code    : 所属会社コード (下記から選択)',
    '#  password        : 初期パスワード (8文字以上推奨)',
    '#  role            : member | admin (省略時 member)',
    '#  employee_type   : office | field | admin (省略時 office)',
    '#                    field=現場棟スタッフ(乗務員/倉庫), office=事務所棟',
    '#',
    '# 利用可能な会社コード:',
    compList,
    '#',
    '# 「#」で始まる行はコメント。空行は無視されます。',
    '# サンプル(下の3行は削除して、本データに置き換えてください):',
    'taro_yamada,山田太郎,SU_HQ,Init#Pass2026,member,office',
    'hanako_suzuki,鈴木花子,SU_SAITAMA,Init#Pass2026,member,office',
    'driver_sato,佐藤健一,SU_ZAMA,Init#Pass2026,member,field',
  ].join('\n') + '\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cohub_members_template.csv"');
  res.send(tpl);
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

// ========== グループチャット管理 ==========
router.get('/groups', authAdmin, (req, res) => {
  const rows = getDb().prepare(`
    SELECT g.id, g.name, g.icon, g.created_by, g.created_at,
      u.display_name AS created_by_name,
      (SELECT COUNT(*) FROM chat_group_members WHERE group_id = g.id) AS member_count
    FROM chat_groups g LEFT JOIN users u ON u.id = g.created_by
    ORDER BY g.created_at DESC
  `).all();
  res.json({ success: true, groups: rows });
});

router.post('/groups', authAdmin, (req, res) => {
  const name = (req.body.name || '').toString().trim().slice(0, 50);
  const icon = (req.body.icon || '💬').toString().slice(0, 8);
  const memberIds = Array.isArray(req.body.member_ids) ? req.body.member_ids : [];
  if (!name) return res.status(400).json({ success: false, msg: 'グループ名必須' });
  const id = crypto.randomUUID();
  const db = getDb();
  db.prepare('INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)').run(id, name, icon, req.uid);
  const addMember = db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)');
  db.transaction(() => {
    // 作成者も自動参加
    addMember.run(id, req.uid);
    for (const uid of memberIds) if (typeof uid === 'string') addMember.run(id, uid);
  })();
  res.json({ success: true, id });
});

router.get('/groups/:gid', authAdmin, (req, res) => {
  const g = getDb().prepare('SELECT id, name, icon, created_by, created_at FROM chat_groups WHERE id = ?').get(req.params.gid);
  if (!g) return res.status(404).json({ success: false });
  const members = getDb().prepare(`SELECT u.id, u.display_name, u.login_id FROM chat_group_members gm
    JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.display_name`).all(req.params.gid);
  res.json({ success: true, group: g, members });
});

router.post('/groups/:gid/members', authAdmin, (req, res) => {
  const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids : [];
  const st = getDb().prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)');
  for (const uid of ids) if (typeof uid === 'string') st.run(req.params.gid, uid);
  res.json({ success: true });
});

router.delete('/groups/:gid/members/:uid', authAdmin, (req, res) => {
  getDb().prepare('DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?').run(req.params.gid, req.params.uid);
  res.json({ success: true });
});

router.delete('/groups/:gid', authAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM chat_group_members WHERE group_id = ?').run(req.params.gid);
  db.prepare("DELETE FROM messages WHERE room_code = ?").run('grp_' + req.params.gid);
  db.prepare('DELETE FROM chat_groups WHERE id = ?').run(req.params.gid);
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
