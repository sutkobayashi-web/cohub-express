const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser, authAdmin } = require('../middleware/auth');

// 管理者(role=admin かつ employee_type=admin)かどうか
function isManager(uid) {
  const u = getDb().prepare("SELECT role, employee_type FROM users WHERE id=?").get(uid);
  return !!(u && u.role === 'admin' && u.employee_type === 'admin');
}
// グループ閲覧/操作の可否 (メンバー OR 管理者)
function canAccessGroup(uid, gid) {
  const m = getDb().prepare('SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?').get(gid, uid);
  if (m) return true;
  return isManager(uid);
}


// チャット添付ファイル保存
const chatDir = path.join(__dirname, '..', '..', 'uploads', 'chat');
if (!fs.existsSync(chatDir)) fs.mkdirSync(chatDir, { recursive: true });

// multer(busboy)はファイル名を latin1 として渡すため、UTF-8の日本語ファイル名が文字化けする。
// latin1のバイト列が正当なUTF-8として往復一致する場合のみ utf8 で再解釈して復元する
// (ASCIIや既に正しい文字列はそのまま。二重デコード/不正バイトを避ける)。
function decodeFilename(name) {
  if (!name) return name;
  try {
    const buf = Buffer.from(name, 'latin1');
    const utf8 = buf.toString('utf8');
    if (Buffer.from(utf8, 'utf8').equals(buf)) return utf8;
  } catch (e) {}
  return name;
}
const chatUpload = multer({
  storage: multer.diskStorage({
    destination: chatDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 8).replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

router.post('/upload', authUser, chatUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, msg: 'ファイル無し' });
  res.json({
    success: true,
    url: '/uploads/chat/' + req.file.filename,
    name: decodeFilename(req.file.originalname),
    size: req.file.size,
    type: req.file.mimetype,
  });
});

// 自分の60日以内の会話履歴（本人のみ閲覧）
router.get('/history', authUser, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.id, m.sender_id, m.receiver_id, m.content, m.created_at,
           us.display_name AS sender_name, us.company_code AS sender_company,
           ur.display_name AS receiver_name
    FROM messages m
    LEFT JOIN users us ON us.id = m.sender_id
    LEFT JOIN users ur ON ur.id = m.receiver_id
    WHERE (m.sender_id = ? OR m.receiver_id = ? OR m.receiver_id IS NULL)
      AND m.created_at > datetime('now', '-60 days')
    ORDER BY m.created_at DESC
    LIMIT 500
  `).all(req.uid, req.uid);
  res.json({ success: true, messages: rows });
});

// 指定フロアのチャット履歴 直近100件（全ユーザー）
router.get('/recent', authUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const room = (req.query.room || 'lobby').toString();
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.id, m.sender_id, m.content, m.has_mention, m.created_at,
           m.attach_url, m.attach_name, m.attach_size, m.attach_type,
           u.display_name AS sender_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_code = ? AND m.created_at > datetime('now', '-60 days')
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(room, limit);
  res.json({ success: true, messages: rows.reverse() });
});

// 管理者向け全文検索（内部統制モニタリング）
router.get('/admin/search', authAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const q = (req.query.q || '').toString().trim();
  const senderId = (req.query.sender_id || '').toString().trim();
  const since = (req.query.since || '').toString().trim();
  const until = (req.query.until || '').toString().trim();
  const onlyMention = req.query.mention === '1';
  const room = (req.query.room || '').toString().trim();

  let sql = `SELECT m.id, m.sender_id, m.content, m.room_code, m.has_mention, m.created_at,
             u.display_name AS sender_name, u.login_id AS sender_login, u.company_code AS sender_company
             FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE 1=1`;
  const params = [];
  if (q) { sql += ' AND m.content LIKE ?'; params.push('%' + q + '%'); }
  if (senderId) { sql += ' AND m.sender_id = ?'; params.push(senderId); }
  if (since) { sql += ' AND m.created_at >= ?'; params.push(since); }
  if (until) { sql += " AND m.created_at <= ? || ' 23:59:59'"; params.push(until); }
  if (onlyMention) { sql += ' AND m.has_mention = 1'; }
  if (room) { sql += ' AND m.room_code = ?'; params.push(room); }
  sql += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = getDb().prepare(sql).all(...params);

  // 合計件数も返す
  let countSql = 'SELECT COUNT(*) as c FROM messages m WHERE 1=1';
  const countParams = [];
  if (q) { countSql += ' AND m.content LIKE ?'; countParams.push('%' + q + '%'); }
  if (senderId) { countSql += ' AND m.sender_id = ?'; countParams.push(senderId); }
  if (since) { countSql += ' AND m.created_at >= ?'; countParams.push(since); }
  if (until) { countSql += " AND m.created_at <= ? || ' 23:59:59'"; countParams.push(until); }
  if (onlyMention) { countSql += ' AND m.has_mention = 1'; }
  if (room) { countSql += ' AND m.room_code = ?'; countParams.push(room); }
  const totalRow = getDb().prepare(countSql).get(...countParams);

  res.json({ success: true, messages: rows, total: totalRow.c });
});

// DM履歴（自分と指定相手）
router.get('/dm/:peerId', authUser, (req, res) => {
  const peerId = req.params.peerId;
  const db = getDb();
  const peer = db.prepare(`SELECT u.id, u.display_name, u.avatar_url, u.company_code, c.ring_color
    FROM users u LEFT JOIN companies c ON c.code = u.company_code WHERE u.id = ?`).get(peerId);
  if (!peer) return res.status(404).json({ success: false, msg: 'ユーザー未存在' });
  const rows = db.prepare(`
    SELECT m.id, m.sender_id, m.receiver_id, m.content, m.created_at,
           m.attach_url, m.attach_name, m.attach_size, m.attach_type,
           u.display_name AS sender_name,
           u.avatar_url   AS sender_avatar,
           u.company_code AS sender_company,
           c.ring_color   AS sender_ring
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    LEFT JOIN companies c ON c.code = u.company_code
    WHERE m.room_code = 'dm'
      AND ((m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?))
      AND m.created_at > datetime('now', '-60 days')
    ORDER BY m.created_at DESC
    LIMIT 200
  `).all(req.uid, peerId, peerId, req.uid);
  res.json({ success: true, peer, messages: rows.reverse() });
});

// DMの相手一覧（最新のやり取り順、最新本文付き）
router.get('/dm', authUser, (req, res) => {
  const rows = getDb().prepare(`
    SELECT u.id AS peer_id, u.display_name, u.avatar_url, u.company_code, l.last_at,
      (SELECT content FROM messages
        WHERE room_code='dm'
          AND ((sender_id = ? AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = ?))
        ORDER BY created_at DESC LIMIT 1) AS last_content,
      (SELECT sender_id FROM messages
        WHERE room_code='dm'
          AND ((sender_id = ? AND receiver_id = u.id) OR (sender_id = u.id AND receiver_id = ?))
        ORDER BY created_at DESC LIMIT 1) AS last_sender_id
    FROM users u
    JOIN (
      SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS peer_id,
             MAX(created_at) AS last_at
      FROM messages
      WHERE room_code='dm' AND (sender_id = ? OR receiver_id = ?)
      GROUP BY peer_id
    ) l ON l.peer_id = u.id
    ORDER BY l.last_at DESC LIMIT 100
  `).all(req.uid, req.uid, req.uid, req.uid, req.uid, req.uid, req.uid);
  res.json({ success: true, peers: rows });
});

// 自分が参加しているグループ一覧 (最新メッセージ順)
router.get('/groups', authUser, (req, res) => {
  const admin = isManager(req.uid);
  let rows;
  if (admin) {
    // 管理者: 全GCを返す。is_memberフラグで自身がメンバーかも示す
    rows = getDb().prepare(`
      SELECT g.id, g.name, g.icon, g.created_at, g.is_circle, g.category,
        (SELECT MAX(created_at) FROM messages WHERE room_code = 'grp_' || g.id) AS last_at,
        (SELECT content FROM messages WHERE room_code = 'grp_' || g.id ORDER BY created_at DESC LIMIT 1) AS last_content,
        (SELECT COUNT(*) FROM chat_group_members WHERE group_id = g.id) AS member_count,
        EXISTS(SELECT 1 FROM chat_group_members WHERE group_id = g.id AND user_id = ?) AS is_member
      FROM chat_groups g
      ORDER BY COALESCE(g.sort_order, 100), COALESCE(last_at, g.created_at) DESC
    `).all(req.uid);
  } else {
    rows = getDb().prepare(`
      SELECT g.id, g.name, g.icon, g.created_at, g.is_circle, g.category,
        (SELECT MAX(created_at) FROM messages WHERE room_code = 'grp_' || g.id) AS last_at,
        (SELECT content FROM messages WHERE room_code = 'grp_' || g.id ORDER BY created_at DESC LIMIT 1) AS last_content,
        (SELECT COUNT(*) FROM chat_group_members WHERE group_id = g.id) AS member_count,
        1 AS is_member
      FROM chat_groups g
      JOIN chat_group_members m ON m.group_id = g.id
      WHERE m.user_id = ?
      ORDER BY COALESCE(g.sort_order, 100), COALESCE(last_at, g.created_at) DESC
    `).all(req.uid);
  }
  res.json({ success: true, groups: rows, is_manager_view: admin });
});

// グループのメッセージ履歴 (参加者のみ)
router.get('/groups/:gid/messages', authUser, (req, res) => {
  if (!canAccessGroup(req.uid, req.params.gid)) return res.status(403).json({ success: false, msg: 'メンバーではありません' });
  const rows = getDb().prepare(`
    SELECT m.id, m.sender_id, m.content, m.created_at,
           m.attach_url, m.attach_name, m.attach_size, m.attach_type,
           u.display_name AS sender_name,
           u.avatar_url   AS sender_avatar,
           u.company_code AS sender_company,
           c.ring_color   AS sender_ring
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    LEFT JOIN companies c ON c.code = u.company_code
    WHERE m.room_code = ?
      AND m.created_at > datetime('now', '-60 days')
    ORDER BY m.created_at DESC LIMIT 300
  `).all('grp_' + req.params.gid);
  res.json({ success: true, messages: rows.reverse() });
});

// グループ メンバー一覧
router.get('/groups/:gid/members', authUser, (req, res) => {
  if (!canAccessGroup(req.uid, req.params.gid)) return res.status(403).json({ success: false });
  const rows = getDb().prepare(`SELECT u.id, u.display_name, u.avatar_url, c.ring_color
    FROM chat_group_members gm JOIN users u ON u.id = gm.user_id
    LEFT JOIN companies c ON c.code = u.company_code WHERE gm.group_id = ?`).all(req.params.gid);
  res.json({ success: true, members: rows });
});

// ===== 既読管理 (2026-05-08) =====
// 自分が読んだメッセージを一括登録 + Socket.IO で関係者に通知
router.post('/read', authUser, express.json(), (req, res) => {
  const ids = Array.isArray(req.body && req.body.message_ids) ? req.body.message_ids : [];
  const valid = ids.map(x => parseInt(x)).filter(n => !isNaN(n) && n > 0);
  if (valid.length === 0) return res.json({ success: true, read: 0 });
  const db = getDb();
  // 自分が読まれた送信者ではない (sender_id != uid) のメッセージだけ既読対象
  const placeholders = valid.map(() => '?').join(',');
  const target = db.prepare(`SELECT id, sender_id, room_code FROM messages
    WHERE id IN (${placeholders}) AND sender_id != ?`).all(...valid, req.uid);
  if (target.length === 0) return res.json({ success: true, read: 0 });
  const ins = db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)');
  let inserted = 0;
  db.transaction(() => {
    for (const m of target) {
      const r = ins.run(m.id, req.uid);
      if (r.changes > 0) inserted++;
    }
  })();
  // Socket: 既読を関係者に通知
  try {
    const io = req.app.locals.io;
    if (io) {
      const reader = db.prepare('SELECT display_name, avatar_url FROM users WHERE id = ?').get(req.uid) || {};
      // メッセージごとに roomCode を判定して関係者へ
      const byRoom = new Map();
      for (const m of target) {
        if (!byRoom.has(m.room_code)) byRoom.set(m.room_code, []);
        byRoom.get(m.room_code).push(m.id);
      }
      for (const [room, msgIds] of byRoom.entries()) {
        if (room.startsWith('grp_')) {
          const gid = room.slice(4);
          const members = db.prepare('SELECT user_id FROM chat_group_members WHERE group_id = ?').all(gid);
          const payload = {
            scope: 'group', group_id: gid, message_ids: msgIds,
            reader_id: req.uid, reader_name: reader.display_name || '', reader_avatar: reader.avatar_url || '',
            read_at: new Date().toISOString(),
          };
          for (const mb of members) {
            // 各メンバーのソケットに通知 (ヘルパは server/index.js 側にしかないので簡易にbroadcast)
            io.to('user:' + mb.user_id).emit('message:read', payload);
          }
        } else if (room === 'dm') {
          // DM: 送信者にのみ通知
          for (const m of target) {
            if (msgIds.indexOf(m.id) === -1) continue;
            io.to('user:' + m.sender_id).emit('message:read', {
              scope: 'dm', message_ids: [m.id],
              reader_id: req.uid, reader_name: reader.display_name || '', reader_avatar: reader.avatar_url || '',
              read_at: new Date().toISOString(),
            });
          }
        }
      }
    }
  } catch (e) { console.warn('[message:read socket]', e.message); }
  res.json({ success: true, read: inserted });
});

// 自分の未読件数: グループ別 + DM相手別 (60日以内のメッセージ対象)
router.get('/unread', authUser, (req, res) => {
  const db = getDb();
  // グループ未読: 自分が参加するグループの 自分以外送信メッセージで、自分が既読していないもの
  const groups = db.prepare(`
    SELECT g.id AS group_id, g.name, COUNT(*) AS unread
    FROM chat_groups g
    JOIN chat_group_members gm ON gm.group_id = g.id AND gm.user_id = ?
    JOIN messages m ON m.room_code = 'grp_' || g.id
      AND m.sender_id != ?
      AND m.created_at > datetime('now', '-60 days')
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?)
    GROUP BY g.id
  `).all(req.uid, req.uid, req.uid);
  // DM未読: DM相手別の未読数 (自己DM/bot送信は除外)
  // bot DMはチャット画面のDMリストから除外されていて既読化できないため、未読カウントにも含めない
  const dms = db.prepare(`
    SELECT m.sender_id AS peer_id, COUNT(*) AS unread
    FROM messages m
    WHERE m.room_code = 'dm'
      AND m.receiver_id = ?
      AND m.sender_id != ?
      AND m.sender_id NOT LIKE 'bot_%'
      AND m.created_at > datetime('now', '-60 days')
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?)
    GROUP BY m.sender_id
  `).all(req.uid, req.uid, req.uid);
  res.json({ success: true, groups, dms });
});

// 未読合計数 (home.html のチャットバッジ用) — DM + グループ未読の総和
// 自分宛て自己DM (sender_id = receiver_id) と bot送信DMはノイズなので除外
// (bot DMはchat-simple側でDMリストから隠されており、ユーザーが既読化する手段がないため
//  これを含めるとバッジが永久に消えない)
router.get('/unread-count', authUser, (req, res) => {
  const db = getDb();
  const groupSum = db.prepare(`
    SELECT COUNT(*) AS c
    FROM chat_groups g
    JOIN chat_group_members gm ON gm.group_id = g.id AND gm.user_id = ?
    JOIN messages m ON m.room_code = 'grp_' || g.id
      AND m.sender_id != ?
      AND m.created_at > datetime('now', '-60 days')
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?)
  `).get(req.uid, req.uid, req.uid);
  const dmSum = db.prepare(`
    SELECT COUNT(*) AS c FROM messages
    WHERE room_code = 'dm' AND receiver_id = ?
      AND sender_id != ?
      AND sender_id NOT LIKE 'bot_%'
      AND created_at > datetime('now', '-60 days')
      AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = id AND r.user_id = ?)
  `).get(req.uid, req.uid, req.uid);
  const total = (groupSum.c || 0) + (dmSum.c || 0);
  res.json({ success: true, count: total, dm: dmSum.c || 0, group: groupSum.c || 0 });
});

// 特定メッセージの既読者一覧 (グループチャットの「既読N人」用)
router.get('/messages/:mid/readers', authUser, (req, res) => {
  const mid = parseInt(req.params.mid);
  if (isNaN(mid)) return res.status(400).json({ success: false });
  const db = getDb();
  // メッセージの所属判定 (アクセス権チェック)
  const msg = db.prepare('SELECT id, room_code, sender_id FROM messages WHERE id = ?').get(mid);
  if (!msg) return res.status(404).json({ success: false });
  if (msg.room_code.startsWith('grp_')) {
    const gid = msg.room_code.slice(4);
    const ok = db.prepare('SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ?').get(gid, req.uid);
    if (!ok && msg.sender_id !== req.uid) return res.status(403).json({ success: false });
  } else if (msg.room_code === 'dm') {
    if (msg.sender_id !== req.uid) {
      // 受信者のみが読み手 (1人)。送信者でなければ閲覧不可
      const isReceiver = db.prepare('SELECT 1 FROM messages WHERE id = ? AND receiver_id = ?').get(mid, req.uid);
      if (!isReceiver) return res.status(403).json({ success: false });
    }
  }
  const readers = db.prepare(`SELECT u.id, u.display_name, u.avatar_url, c.ring_color, r.read_at
    FROM message_reads r JOIN users u ON u.id = r.user_id
    LEFT JOIN companies c ON c.code = u.company_code
    WHERE r.message_id = ? ORDER BY r.read_at`).all(mid);
  res.json({ success: true, readers });
});

// メッセージID範囲で既読者を一括取得 (グループ画面表示用)
router.post('/messages/readers-bulk', authUser, express.json(), (req, res) => {
  const ids = Array.isArray(req.body && req.body.message_ids) ? req.body.message_ids : [];
  const valid = ids.map(x => parseInt(x)).filter(n => !isNaN(n) && n > 0).slice(0, 500);
  if (valid.length === 0) return res.json({ success: true, by_message: {} });
  const db = getDb();
  const placeholders = valid.map(() => '?').join(',');
  const rows = db.prepare(`SELECT r.message_id, u.id, u.display_name, u.avatar_url, c.ring_color, r.read_at
    FROM message_reads r JOIN users u ON u.id = r.user_id
    LEFT JOIN companies c ON c.code = u.company_code
    WHERE r.message_id IN (${placeholders})
    ORDER BY r.read_at`).all(...valid);
  const byMsg = {};
  for (const r of rows) {
    if (!byMsg[r.message_id]) byMsg[r.message_id] = [];
    byMsg[r.message_id].push({ id: r.id, display_name: r.display_name, avatar_url: r.avatar_url, ring_color: r.ring_color, read_at: r.read_at });
  }
  res.json({ success: true, by_message: byMsg });
});

// フロア一覧 (アイコン+棟分類付き、モバイル/管理画面で利用)
router.get('/floors', authUser, (req, res) => {
  const rows = getDb().prepare('SELECT code, name, icon, building, locked, approval_mode FROM floors ORDER BY sort_order').all();
  res.json({ success: true, floors: rows });
});

// ホワイトボード内容取得 (会議室入室時)
router.get('/wb/:room', authUser, (req, res) => {
  const row = getDb().prepare('SELECT content, drawing_json, updated_at, updated_by FROM whiteboards WHERE room_code = ?').get(req.params.room);
  res.json({
    success: true,
    content: row ? row.content : '',
    drawing_json: row ? (row.drawing_json || '[]') : '[]',
    updated_at: row ? row.updated_at : null,
  });
});

module.exports = router;
