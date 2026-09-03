// 社内共有カレンダー (2026-05-24)
// Google非連携の独立カレンダー。閲覧・登録とも「管理職以上」(users.is_manager=1) に限定。
// 編集・削除は作成者本人 または role=admin のみ。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const CATEGORIES = ['meeting', 'visitor', 'trip', 'outing', 'event', 'leave', 'other'];
const SCOPES = ['shared', 'personal'];  // shared=共有予定 / personal=自分の予定 (どちらも全員に表示、ラベルで区別)

// 閲覧・登録ゲート: 管理職以上(is_manager) のみ
function requireManager(req, res, next) {
  const u = getDb().prepare('SELECT is_manager, role, display_name FROM users WHERE id = ?').get(req.uid);
  if (!u || !u.is_manager) {
    return res.status(403).json({ success: false, msg: 'このカレンダーは管理職以上のみ利用できます' });
  }
  req._me = u;
  next();
}

function clampStr(v, n) { return v == null ? null : String(v).slice(0, n); }

// 共有先グループidを検証し JSON文字列で返す (存在するchat_groupsのみ・最大50・空はnull)
function sanitizeGroupIds(db, raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const valid = new Set(db.prepare('SELECT id FROM chat_groups').all().map(g => g.id));
  const ids = [...new Set(raw.map(String).filter(id => valid.has(id)))].slice(0, 50);
  return ids.length ? JSON.stringify(ids) : null;
}

// 閲覧は全社員に開放。作成・共有は管理職のみ (can_create)。
router.get('/access', authUser, (req, res) => {
  const u = getDb().prepare('SELECT is_manager FROM users WHERE id = ?').get(req.uid);
  res.json({ success: true, allowed: true, can_create: !!(u && u.is_manager) });
});

// 共有先に選べるチャットグループ一覧 (作成フォームのピッカー用・管理職のみ)
router.get('/groups', authUser, requireManager, (req, res) => {
  const rows = getDb().prepare(`SELECT g.id, g.name, COUNT(m.user_id) AS members
    FROM chat_groups g LEFT JOIN chat_group_members m ON m.group_id = g.id
    GROUP BY g.id ORDER BY members DESC, g.name ASC`).all();
  res.json({ success: true, groups: rows });
});

// 一覧取得 (?from=YYYY-MM-DD&to=YYYY-MM-DD で範囲指定。月グリッド用)
// 管理職=全件。一般社員=自分作成 or 自分の所属グループ宛に共有された予定のみ。
router.get('/', authUser, (req, res) => {
  const db = getDb();
  const me = db.prepare('SELECT is_manager FROM users WHERE id = ?').get(req.uid) || {};
  const isMgr = !!me.is_manager;
  const from = (req.query.from || '').slice(0, 10);
  const to = (req.query.to || '').slice(0, 10);
  // 作成者の現在のアバターと表示名を join で同梱 (created_by_avatar / created_by_display)
  // ⚠️ sce.created_by_name は作成時に控えた値なので、改名すると古いままになる。画面は display を優先する。
  let sql = `SELECT sce.*, u.avatar_url AS created_by_avatar, u.display_name AS created_by_display
    FROM shared_calendar_events sce
    LEFT JOIN users u ON u.id = sce.created_by
    WHERE sce.deleted_at IS NULL`;
  const params = [];
  const hasRange = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
  if (hasRange) {
    // 期間が範囲と重なるものを抽出 (終日/複数日対応)
    sql += ` AND date(sce.start_at) <= ? AND date(COALESCE(sce.end_at, sce.start_at)) >= ?`;
    params.push(to, from);
  }
  sql += ` ORDER BY sce.start_at ASC, sce.id ASC`;
  let rows = db.prepare(sql).all(...params);

  // 共有先グループ名の解決マップ
  const gmap = {};
  db.prepare('SELECT id, name FROM chat_groups').all().forEach(g => { gmap[g.id] = g.name; });
  // 閲覧者のグループ所属 (一般社員の可視判定用)
  const myGroups = new Set(db.prepare('SELECT group_id FROM chat_group_members WHERE user_id = ?').all(req.uid).map(r => r.group_id));

  rows = rows.map(r => {
    let ids = [];
    try { ids = r.share_group_ids ? JSON.parse(r.share_group_ids) : []; } catch (e) { ids = []; }
    r.share_group_ids = ids;
    r.share_group_names = ids.map(id => gmap[id]).filter(Boolean);
    return r;
  }).filter(r => {
    if (isMgr) return true;                                  // 管理職は全件閲覧(従来どおり)
    if (r.created_by === req.uid) return true;               // 自分が作成
    return r.share_group_ids.some(id => myGroups.has(id));   // 自分の所属グループ宛に共有
  });

  // 会議予約: 日程調整で確定した会議を読み取り専用で同梱 (管理職のみ)
  let meetings = [];
  if (isMgr) {
    try {
      let msql = `SELECT p.id AS poll_id, p.title, p.duration_minutes, p.format, p.location,
                         p.organizer_id,
                         s.starts_at, u.display_name AS organizer_name, u.avatar_url AS organizer_avatar
        FROM meeting_polls p
        JOIN meeting_poll_slots s ON s.id = p.decided_slot_id
        LEFT JOIN users u ON u.id = p.organizer_id
        WHERE p.status = 'decided'`;
      const mp = [];
      if (hasRange) { msql += ` AND date(s.starts_at) <= ? AND date(s.starts_at) >= ?`; mp.push(to, from); }
      msql += ` ORDER BY s.starts_at ASC`;
      meetings = db.prepare(msql).all(...mp);
    } catch (e) { meetings = []; }
  }

  // 📝 期限つきのToDoをカレンダーに合流 (2026-07-28 社長「カレンダーとToDoは連携できないか」)
  //   Google ToDoリストと同じ考え方=期限=その日の予定として並べる。
  //   ⚠️共有カレンダーは他人も見る画面。**必ず本人(req.uid)のToDoだけ**を返す。他人には一切出さない。
  let todos = [];
  try {
    let tsql = `SELECT id, title, due_date, done, done_at FROM personal_todos
                WHERE uid = ? AND due_date IS NOT NULL AND due_date <> ''`;
    const tp = [req.uid];
    if (hasRange) { tsql += ' AND due_date BETWEEN ? AND ?'; tp.push(from, to); }
    todos = db.prepare(tsql + ' ORDER BY due_date ASC, id ASC').all(...tp);
  } catch (e) { todos = []; }   // personal_todos がまだ無い環境でもカレンダーは動かす

  res.json({ success: true, events: rows, meetings, todos, can_create: isMgr });
});

// 新規登録
router.post('/', authUser, requireManager, express.json(), (req, res) => {
  const b = req.body || {};
  const title = (b.title || '').toString().trim();
  if (!title) return res.status(400).json({ success: false, msg: 'タイトルは必須です' });
  const start_at = (b.start_at || '').toString().trim();
  if (!start_at) return res.status(400).json({ success: false, msg: '開始日時は必須です' });
  const category = CATEGORIES.includes(b.category) ? b.category : 'meeting';
  const scope = SCOPES.includes(b.scope) ? b.scope : 'shared';
  const all_day = b.all_day ? 1 : 0;
  const shareGroupIds = sanitizeGroupIds(getDb(), b.share_group_ids);
  const ins = getDb().prepare(`INSERT INTO shared_calendar_events
    (title, category, scope, start_at, end_at, all_day, location, description, created_by, created_by_name, share_group_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    clampStr(title, 200),
    category,
    scope,
    clampStr(start_at, 20),
    clampStr(b.end_at, 20) || null,
    all_day,
    clampStr(b.location, 200) || null,
    clampStr(b.description, 2000) || null,
    req.uid,
    clampStr(req._me.display_name, 80),
    shareGroupIds
  );
  res.json({ success: true, id: ins.lastInsertRowid });
});

// 更新 (作成者本人 または admin)
router.put('/:id', authUser, requireManager, express.json(), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const ev = db.prepare('SELECT * FROM shared_calendar_events WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!ev) return res.status(404).json({ success: false, msg: '予定が見つかりません' });
  if (ev.created_by !== req.uid && req._me.role !== 'admin') {
    return res.status(403).json({ success: false, msg: '編集できるのは作成者または管理者のみです' });
  }
  const b = req.body || {};
  const fields = [];
  const params = [];
  if (b.title !== undefined) {
    const t = (b.title || '').toString().trim();
    if (!t) return res.status(400).json({ success: false, msg: 'タイトルは必須です' });
    fields.push('title = ?'); params.push(clampStr(t, 200));
  }
  if (b.category !== undefined) {
    fields.push('category = ?'); params.push(CATEGORIES.includes(b.category) ? b.category : 'meeting');
  }
  if (b.scope !== undefined) {
    fields.push('scope = ?'); params.push(SCOPES.includes(b.scope) ? b.scope : 'shared');
  }
  if (b.start_at !== undefined) { fields.push('start_at = ?'); params.push(clampStr(b.start_at, 20)); }
  if (b.end_at !== undefined) { fields.push('end_at = ?'); params.push(clampStr(b.end_at, 20) || null); }
  if (b.all_day !== undefined) { fields.push('all_day = ?'); params.push(b.all_day ? 1 : 0); }
  if (b.location !== undefined) { fields.push('location = ?'); params.push(clampStr(b.location, 200) || null); }
  if (b.description !== undefined) { fields.push('description = ?'); params.push(clampStr(b.description, 2000) || null); }
  if (b.share_group_ids !== undefined) { fields.push('share_group_ids = ?'); params.push(sanitizeGroupIds(db, b.share_group_ids)); }
  if (!fields.length) return res.json({ success: true, msg: '変更なし' });
  fields.push(`updated_at = datetime('now','localtime')`);
  params.push(id);
  db.prepare('UPDATE shared_calendar_events SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
  res.json({ success: true });
});

// 削除 (論理削除。作成者本人 または admin)
router.delete('/:id', authUser, requireManager, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const ev = db.prepare('SELECT created_by FROM shared_calendar_events WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!ev) return res.status(404).json({ success: false, msg: '予定が見つかりません' });
  if (ev.created_by !== req.uid && req._me.role !== 'admin') {
    return res.status(403).json({ success: false, msg: '削除できるのは作成者または管理者のみです' });
  }
  db.prepare(`UPDATE shared_calendar_events SET deleted_at = datetime('now','localtime') WHERE id = ?`).run(id);
  res.json({ success: true });
});

module.exports = router;
