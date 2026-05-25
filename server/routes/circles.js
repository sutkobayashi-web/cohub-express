// サークル機能 v1 (chat_groups 流用)
// - サークル = chat_groups.is_circle=1 のレコード
// - 一覧: 誰でも閲覧可
// - 作成/編集: 管理者 or 推進メンバー
// - 参加申請: 一般社員も可。join_mode='open' なら即承認。'approve' ならリーダー承認
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

function notifyDM(req, fromUid, toUid, content, push) {
  if (!fromUid || !toUid || fromUid === toUid) return;
  try {
    const db = getDb();
    const ins = db.prepare('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)')
      .run(fromUid, toUid, content);
    const emitToUser = req.app && req.app.locals && req.app.locals.emitToUser;
    if (emitToUser) {
      emitToUser(toUid, 'dm:msg', {
        id: ins.lastInsertRowid,
        from: fromUid,
        to: toUid,
        content,
        at: new Date().toISOString(),
        attach: null,
      });
    }
    const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (sendPush && push) sendPush(toUid, push).catch(() => {});
  } catch (e) { console.warn('[circles notifyDM]', e.message); }
}

function getNotifierBotId() {
  try {
    const row = getDb().prepare("SELECT id FROM users WHERE id = 'bot_aoi' OR login_id = 'bot_aoi' LIMIT 1").get()
      || getDb().prepare("SELECT id FROM users WHERE role = 'bot' ORDER BY (login_id='bot_aoi') DESC LIMIT 1").get();
    return row && row.id;
  } catch (e) { return null; }
}

function canCreateCircle(uid) {
  const u = getDb().prepare('SELECT role, employee_type, is_field_promoter, is_warehouse_promoter FROM users WHERE id = ?').get(uid);
  if (!u) return false;
  return u.role === 'admin' || u.employee_type === 'admin' || !!u.is_field_promoter || !!u.is_warehouse_promoter;
}

function canManageCircle(uid, circle) {
  if (!circle) return false;
  if (circle.lead_uid === uid) return true;
  const u = getDb().prepare('SELECT role, employee_type FROM users WHERE id = ?').get(uid);
  if (!u) return false;
  return u.role === 'admin' || u.employee_type === 'admin';
}

// 一覧: サークル全件 + 各自の参加状態
router.get('/', authUser, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT g.id, g.name, g.icon, g.description, g.lead_uid, g.recruiting, g.join_mode, g.cover_image, g.color_theme, g.created_at,
           (SELECT display_name FROM users WHERE id = g.lead_uid) AS lead_name,
           (SELECT avatar_url FROM users WHERE id = g.lead_uid) AS lead_avatar,
           (SELECT COUNT(*) FROM chat_group_members WHERE group_id = g.id) AS member_count,
           (SELECT 1 FROM chat_group_members WHERE group_id = g.id AND user_id = ?) AS is_member,
           (SELECT status FROM circle_join_requests WHERE group_id = g.id AND user_id = ? AND status = 'pending' LIMIT 1) AS my_request
    FROM chat_groups g
    WHERE g.is_circle = 1
    ORDER BY g.recruiting DESC, member_count DESC, g.created_at DESC
  `).all(req.uid, req.uid);
  res.json({ success: true, circles: rows, can_create: canCreateCircle(req.uid) });
});

// 詳細: メンバー + 申請一覧 (リーダー/管理者のみ申請一覧見える)
router.get('/:id', authUser, (req, res) => {
  const db = getDb();
  const c = db.prepare(`
    SELECT g.id, g.name, g.icon, g.description, g.lead_uid, g.recruiting, g.join_mode, g.cover_image, g.color_theme, g.created_at,
           (SELECT display_name FROM users WHERE id = g.lead_uid) AS lead_name
    FROM chat_groups g WHERE g.id = ? AND g.is_circle = 1
  `).get(req.params.id);
  if (!c) return res.status(404).json({ success: false, msg: 'サークルが見つかりません' });
  const members = db.prepare(`
    SELECT u.id, u.display_name, u.nickname, u.avatar_url, u.company_code, u.job_role, m.joined_at
    FROM chat_group_members m JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ? AND u.role != 'bot'
    ORDER BY (u.id = ?) DESC, m.joined_at ASC
  `).all(c.id, c.lead_uid || '');
  const isMember = !!db.prepare('SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ?').get(c.id, req.uid);
  const myReq = db.prepare("SELECT id, status, message, created_at FROM circle_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'").get(c.id, req.uid);
  const canMgr = canManageCircle(req.uid, c);
  let requests = [];
  if (canMgr) {
    requests = db.prepare(`
      SELECT r.id, r.user_id, r.message, r.created_at,
             u.display_name, u.nickname, u.avatar_url, u.company_code, u.job_role
      FROM circle_join_requests r JOIN users u ON u.id = r.user_id
      WHERE r.group_id = ? AND r.status = 'pending'
      ORDER BY r.created_at ASC
    `).all(c.id);
  }
  res.json({
    success: true,
    circle: c,
    members,
    is_member: isMember,
    my_request: myReq || null,
    can_manage: canMgr,
    requests,
  });
});

// 作成 (管理者/推進メンバー)
router.post('/', authUser, express.json(), (req, res) => {
  if (!canCreateCircle(req.uid)) return res.status(403).json({ success: false, msg: 'サークル作成権限がありません' });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const icon = String(b.icon || '🎯').trim().slice(0, 4);
  const description = String(b.description || '').trim().slice(0, 1000);
  const leadUid = String(b.lead_uid || req.uid).trim();
  const joinMode = (b.join_mode === 'open') ? 'open' : 'approve';
  const recruiting = b.recruiting === false ? 0 : 1;
  const ALLOWED_THEMES = ['teal','rose','amber','emerald','sky','violet','pink','slate','indigo','orange'];
  const colorTheme = ALLOWED_THEMES.includes(b.color_theme) ? b.color_theme : 'teal';
  if (!name || name.length > 60) return res.status(400).json({ success: false, msg: 'サークル名は1〜60文字' });
  const db = getDb();
  const leadExists = db.prepare("SELECT 1 FROM users WHERE id = ? AND role != 'bot'").get(leadUid);
  if (!leadExists) return res.status(400).json({ success: false, msg: 'リーダーのユーザーが見つかりません' });
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`INSERT INTO chat_groups (id, name, icon, description, lead_uid, recruiting, join_mode, color_theme, is_circle, created_by, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 200)`)
      .run(id, name, icon, description || null, leadUid, recruiting, joinMode, colorTheme, req.uid);
    // リーダー自身を自動でメンバーに
    db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(id, leadUid);
  })();
  res.json({ success: true, id });
});

// 編集 (リーダー or 管理者)
router.patch('/:id', authUser, express.json(), (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT id, lead_uid FROM chat_groups WHERE id = ? AND is_circle = 1').get(req.params.id);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!canManageCircle(req.uid, c)) return res.status(403).json({ success: false, msg: '権限なし' });
  const b = req.body || {};
  const fields = [];
  const params = [];
  if (typeof b.name === 'string') { fields.push('name = ?'); params.push(b.name.trim().slice(0, 60)); }
  if (typeof b.icon === 'string') { fields.push('icon = ?'); params.push(b.icon.trim().slice(0, 4)); }
  if (typeof b.description === 'string') { fields.push('description = ?'); params.push(b.description.trim().slice(0, 1000)); }
  if (typeof b.recruiting === 'boolean') { fields.push('recruiting = ?'); params.push(b.recruiting ? 1 : 0); }
  if (b.join_mode === 'open' || b.join_mode === 'approve') { fields.push('join_mode = ?'); params.push(b.join_mode); }
  const ALLOWED_THEMES = ['teal','rose','amber','emerald','sky','violet','pink','slate','indigo','orange'];
  if (typeof b.color_theme === 'string' && ALLOWED_THEMES.includes(b.color_theme)) { fields.push('color_theme = ?'); params.push(b.color_theme); }
  if (typeof b.lead_uid === 'string' && b.lead_uid) {
    const exists = db.prepare("SELECT 1 FROM users WHERE id = ? AND role != 'bot'").get(b.lead_uid);
    if (exists) { fields.push('lead_uid = ?'); params.push(b.lead_uid); }
  }
  if (!fields.length) return res.json({ success: true });
  params.push(req.params.id);
  db.prepare('UPDATE chat_groups SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
  res.json({ success: true });
});

// 参加申請 / 即参加
router.post('/:id/request', authUser, express.json(), (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT id, name, recruiting, join_mode, lead_uid FROM chat_groups WHERE id = ? AND is_circle = 1').get(req.params.id);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!c.recruiting) return res.status(400).json({ success: false, msg: '現在メンバー募集を停止中です' });
  const already = db.prepare('SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ?').get(c.id, req.uid);
  if (already) return res.status(409).json({ success: false, msg: '既に参加済みです' });
  const message = String((req.body && req.body.message) || '').trim().slice(0, 400);
  const applicant = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const applicantName = (applicant && applicant.display_name) || '社員';
  const botId = getNotifierBotId();
  if (c.join_mode === 'open') {
    db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(c.id, req.uid);
    notifyDM(req, botId, c.lead_uid,
      `🎯 サークル新規参加\n「${c.name}」に ${applicantName} さんが参加しました。\n→ /circles.html`,
      { title: '🎯 新メンバー参加', body: `${c.name}: ${applicantName}さん`, tag: 'circle-join-' + c.id, url: '/circles.html' });
    return res.json({ success: true, mode: 'joined' });
  }
  // approve モード: 既存の pending を上書き相当 (重複防止)
  const dup = db.prepare("SELECT id FROM circle_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'").get(c.id, req.uid);
  if (dup) return res.status(409).json({ success: false, msg: '既に申請中です' });
  db.prepare(`INSERT INTO circle_join_requests (id, group_id, user_id, message) VALUES (?, ?, ?, ?)`)
    .run(crypto.randomUUID(), c.id, req.uid, message || null);
  const msgLine = message ? `\n💬「${message}」` : '';
  notifyDM(req, botId, c.lead_uid,
    `🎯 サークル参加申請\n「${c.name}」に ${applicantName} さんから参加申請が届きました。${msgLine}\n→ /circles.html`,
    { title: '🎯 サークル参加申請', body: `${c.name}: ${applicantName}さん`, tag: 'circle-req-' + c.id, url: '/circles.html' });
  res.json({ success: true, mode: 'pending' });
});

// 申請の承認/却下 (リーダー/管理者)
router.post('/:id/requests/:rid/decision', authUser, express.json(), (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT id, name, lead_uid FROM chat_groups WHERE id = ? AND is_circle = 1').get(req.params.id);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!canManageCircle(req.uid, c)) return res.status(403).json({ success: false, msg: '権限なし' });
  const r = db.prepare("SELECT id, user_id, status FROM circle_join_requests WHERE id = ? AND group_id = ?").get(req.params.rid, c.id);
  if (!r) return res.status(404).json({ success: false, msg: '申請なし' });
  if (r.status !== 'pending') return res.status(400).json({ success: false, msg: 'すでに処理済' });
  const decision = (req.body && req.body.decision) === 'approve' ? 'approved' : 'rejected';
  db.transaction(() => {
    db.prepare("UPDATE circle_join_requests SET status = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?")
      .run(decision, req.uid, r.id);
    if (decision === 'approved') {
      db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(c.id, r.user_id);
    }
  })();
  const botId = getNotifierBotId();
  if (decision === 'approved') {
    notifyDM(req, botId, r.user_id,
      `🎯 サークル参加が承認されました\n「${c.name}」のメンバーになりました。\n→ /circles.html`,
      { title: '🎯 サークル参加承認', body: `${c.name} に参加できました`, tag: 'circle-dec-' + c.id, url: '/circles.html' });
  } else {
    notifyDM(req, botId, r.user_id,
      `🎯 サークル参加申請の結果\n「${c.name}」への申請は今回見送りとなりました。\n別のサークルもぜひご検討ください。`,
      { title: '🎯 サークル申請結果', body: `${c.name}: 見送り`, tag: 'circle-dec-' + c.id, url: '/circles.html' });
  }
  res.json({ success: true, decision });
});

// 退会
router.delete('/:id/membership', authUser, (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT id, lead_uid FROM chat_groups WHERE id = ? AND is_circle = 1').get(req.params.id);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (c.lead_uid === req.uid) return res.status(400).json({ success: false, msg: 'リーダーは退会前に交代してください' });
  db.prepare('DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?').run(c.id, req.uid);
  res.json({ success: true });
});

// メンバー削除 (リーダー/管理者)
router.delete('/:id/members/:uid', authUser, (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT id, lead_uid FROM chat_groups WHERE id = ? AND is_circle = 1').get(req.params.id);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!canManageCircle(req.uid, c)) return res.status(403).json({ success: false, msg: '権限なし' });
  if (req.params.uid === c.lead_uid) return res.status(400).json({ success: false, msg: 'リーダーは退会させられません' });
  db.prepare('DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?').run(c.id, req.params.uid);
  res.json({ success: true });
});

// ===== 予定 (簡易カレンダー) =====
// 一覧: メンバー or 管理者。未来の予定 + 過去14日まで (履歴参照用)
router.get('/:id/events', authUser, (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT id, lead_uid FROM chat_groups WHERE id = ? AND is_circle = 1').get(req.params.id);
  if (!c) return res.status(404).json({ success: false, msg: 'サークルが見つかりません' });
  // 過去14日 + 未来 全件 (シンプル)
  const sinceDate = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT e.id, e.title, e.event_date, e.event_time, e.location, e.memo, e.created_by, e.created_at,
           u.display_name AS created_by_name
    FROM circle_events e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.group_id = ? AND e.event_date >= ?
    ORDER BY e.event_date ASC, COALESCE(e.event_time, '99:99') ASC
  `).all(c.id, sinceDate);
  res.json({ success: true, events: rows });
});

// 追加: メンバーのみ
router.post('/:id/events', authUser, express.json(), (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT id, lead_uid FROM chat_groups WHERE id = ? AND is_circle = 1').get(req.params.id);
  if (!c) return res.status(404).json({ success: false, msg: 'サークルが見つかりません' });
  const isMember = !!db.prepare('SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ?').get(c.id, req.uid);
  if (!isMember) return res.status(403).json({ success: false, msg: 'サークルメンバーのみ予定を追加できます' });
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 80);
  const eventDate = String(b.event_date || '').trim();
  const eventTime = b.event_time ? String(b.event_time).trim() : null;
  const location = b.location ? String(b.location).trim().slice(0, 120) : null;
  const memo = b.memo ? String(b.memo).trim().slice(0, 500) : null;
  if (!title) return res.status(400).json({ success: false, msg: 'タイトルは必須' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return res.status(400).json({ success: false, msg: '日付はYYYY-MM-DD' });
  if (eventTime && !/^\d{2}:\d{2}$/.test(eventTime)) return res.status(400).json({ success: false, msg: '時刻はHH:MM' });
  // 直近30秒以内に同じ作成者が同じタイトル+日付を登録していたら冪等扱い (二重POST防御)
  const dup = db.prepare(`SELECT id FROM circle_events
    WHERE group_id = ? AND created_by = ? AND title = ? AND event_date = ?
      AND created_at >= datetime('now', '-30 seconds')
    LIMIT 1`).get(c.id, req.uid, title, eventDate);
  if (dup) return res.json({ success: true, id: dup.id, deduped: true });
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO circle_events (id, group_id, title, event_date, event_time, location, memo, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, c.id, title, eventDate, eventTime || null, location || null, memo || null, req.uid);
  res.json({ success: true, id });
});

// 削除: 作成者 or リーダー or 管理者
router.delete('/:id/events/:eid', authUser, (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT id, lead_uid FROM chat_groups WHERE id = ? AND is_circle = 1').get(req.params.id);
  if (!c) return res.status(404).json({ success: false, msg: 'サークルが見つかりません' });
  const e = db.prepare('SELECT id, created_by FROM circle_events WHERE id = ? AND group_id = ?').get(req.params.eid, c.id);
  if (!e) return res.status(404).json({ success: false, msg: '予定が見つかりません' });
  const canDel = e.created_by === req.uid || canManageCircle(req.uid, c);
  if (!canDel) return res.status(403).json({ success: false, msg: '削除権限がありません' });
  db.prepare('DELETE FROM circle_events WHERE id = ?').run(req.params.eid);
  res.json({ success: true });
});

module.exports = router;
