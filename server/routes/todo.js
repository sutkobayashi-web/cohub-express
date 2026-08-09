// 個人ToDo (2026-07-28 社長要望「事務職員・管理職向けの To Do リストを詳細版に」)
// ⭐自分専用。他人のものは読めない・書けない。uid は必ず JWT(req.uid) から取り、クライアントからは受け取らない。
//   ([[feedback_api_authz_checklist]] 一覧も詳細も同じスコープ / client 指定の id を信用しない)
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

function ensureTable() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS personal_todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,
    title TEXT NOT NULL,
    due_date TEXT,
    done INTEGER DEFAULT 0,
    done_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_personal_todos_uid ON personal_todos(uid, done, due_date)');
}
try { ensureTable(); } catch (e) { console.warn('[todo] table init', e.message); }

const MAX_LEN = 200;
const MAX_OPEN = 200;   // 1人あたりの未完了上限(暴走・貼り付け事故の歯止め)

// サーバーのTZはJSTなので日付は datetime('now','localtime') と揃える
function jstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function validDue(s) {
  const v = String(s == null ? '' : s).trim();
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;   // 形式外は「期限なし」に倒す
}
function ownRow(id, uid) {
  const row = getDb().prepare('SELECT * FROM personal_todos WHERE id = ?').get(id);
  if (!row) return { err: 404, msg: '見つかりません' };
  if (row.uid !== uid) return { err: 403, msg: '権限がありません' };   // 他人のToDoには触れない
  return { row };
}

// 一覧 = 未完了ぜんぶ + 今日 片付けたぶん(消えると達成感が無いので当日中は残す)
// ?history=1 で完了ぶんを直近30日まで広げる(To Doページの「完了したもの」表示用)
router.get('/', authUser, (req, res) => {
  const today = jstToday();
  const since = String(req.query.history || '') === '1'
    ? new Date(Date.now() + 9 * 3600 * 1000 - 30 * 86400000).toISOString().slice(0, 10)
    : today;
  const rows = getDb().prepare(`SELECT id, title, due_date, done, done_at, created_at
      FROM personal_todos
      WHERE uid = ? AND (done = 0 OR substr(done_at, 1, 10) >= ?)`).all(req.uid, since);
  // 未完了(期限が近い順・期限なしは後ろ) → 完了(片付けた新しい順)
  const items = rows.sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    if (a.done) return String(b.done_at || '').localeCompare(String(a.done_at || '')) || b.id - a.id;
    const ad = a.due_date || '9999-99-99', bd = b.due_date || '9999-99-99';
    return ad.localeCompare(bd) || a.id - b.id;
  });
  const open = items.filter(t => !t.done).length;
  const overdue = items.filter(t => !t.done && t.due_date && t.due_date < today).length;
  res.json({ success: true, today, open, overdue, items });
});

router.post('/', authUser, express.json({ limit: '20kb' }), (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, MAX_LEN);
  if (!title) return res.status(400).json({ success: false, msg: '内容を入力してください' });
  const c = getDb().prepare('SELECT COUNT(*) AS c FROM personal_todos WHERE uid = ? AND done = 0').get(req.uid);
  if (c && c.c >= MAX_OPEN) return res.status(400).json({ success: false, msg: '未完了が多すぎます。片付けてから追加してください。' });
  const ins = getDb().prepare('INSERT INTO personal_todos (uid, title, due_date) VALUES (?,?,?)')
    .run(req.uid, title, validDue(b.due_date));
  res.json({ success: true, id: ins.lastInsertRowid });
});

// 完了/未完了の切替、件名・期限の修正
router.patch('/:id', authUser, express.json({ limit: '20kb' }), (req, res) => {
  const own = ownRow(parseInt(req.params.id), req.uid);
  if (own.err) return res.status(own.err).json({ success: false, msg: own.msg });
  const b = req.body || {};
  const up = [], p = [];
  if (b.title !== undefined) {
    const t = String(b.title).trim().slice(0, MAX_LEN);
    if (!t) return res.status(400).json({ success: false, msg: '内容を入力してください' });
    up.push('title = ?'); p.push(t);
  }
  if (b.due_date !== undefined) { up.push('due_date = ?'); p.push(validDue(b.due_date)); }
  if (b.done !== undefined) {
    const d = b.done ? 1 : 0;
    up.push('done = ?'); p.push(d);
    up.push(d ? "done_at = datetime('now','localtime')" : 'done_at = NULL');   // 値はサーバーが決める(埋め込みは固定文字列)
  }
  if (!up.length) return res.json({ success: true, msg: '変更なし' });
  up.push("updated_at = datetime('now','localtime')");
  p.push(own.row.id);
  getDb().prepare(`UPDATE personal_todos SET ${up.join(', ')} WHERE id = ?`).run(...p);
  res.json({ success: true });
});

router.delete('/:id', authUser, (req, res) => {
  const own = ownRow(parseInt(req.params.id), req.uid);
  if (own.err) return res.status(own.err).json({ success: false, msg: own.msg });
  getDb().prepare('DELETE FROM personal_todos WHERE id = ?').run(own.row.id);
  res.json({ success: true });
});

module.exports = router;
