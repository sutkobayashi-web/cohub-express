const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser, authAdmin } = require('../middleware/auth');
const { allReadings, readingsVersion } = require('../services/name-readings');

// 人名読みの一覧 (読み上げ用)。クライアント側の辞書は5名分しかなく、
// 名簿(roster_yomi.json)を見ていないため辞書外の社員が当て推量で読まれていた (2026-07-30)。
// 正規化した表示名 -> カナ。ver は名簿の更新時刻で、変われば読みを直したという意味。
router.get('/name-readings', authUser, (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ver: readingsVersion(), readings: allReadings() });
  } catch (e) {
    console.warn('[name-readings]', e && e.message);
    res.json({ success: false, readings: {} });
  }
});

// 管理者(role=admin かつ employee_type=admin)かどうか
function isManager(uid) {
  const u = getDb().prepare("SELECT role, employee_type FROM users WHERE id=?").get(uid);
  return !!(u && u.role === 'admin' && u.employee_type === 'admin');
}
// グループ閲覧/操作の可否 = メンバーであることのみ。
// ⚠️2026-07-28 修正: 以前は `return isManager(uid)` のフォールバックがあり、
// role=admin かつ employee_type=admin の11名は、参加していないグループ
// (役員・拠点GC・ゴルフ部などの私的サークルを含む) を一覧で見て中身も読めた。
// 「役員GCはメンバー6名なのに既読8」で発覚 (社長指摘)。内部統制上のモニタリングが
// 必要な場合は、管理コンソールの全文検索 (/api/chat/admin/search・authAdmin・
// 許可リスト6名・audit_log記録あり) を使うこと。ここでは特権を持たせない。
function canAccessGroup(uid, gid) {
  const m = getDb().prepare('SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?').get(gid, uid);
  return !!m;
}
// 既読者の表示をメンバーに限る用 (過去に非メンバーが付けた既読は証跡として残すが、
// 「既読N人」には数えない。送信者本人は退会していても表示対象に含める)
function groupMemberIds(gid) {
  return new Set(getDb().prepare('SELECT user_id FROM chat_group_members WHERE group_id=?').all(gid).map(r => r.user_id));
}

// 起動時マイグレーション: 個人ごとのグループ非表示リスト (本人の一覧表示だけに影響。権限は不変)
try {
  getDb().prepare(`CREATE TABLE IF NOT EXISTS user_hidden_groups (
    user_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, group_id)
  )`).run();
} catch (e) { console.warn('[chat] user_hidden_groups migration skipped:', e.message); }


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
// 能動的コンテンツ(.html/.svg/.js 等)は無認証の /uploads から同一オリジン実行=保存型XSSになるため拒否
const DANGEROUS_UPLOAD = (file) =>
  /\.(html?|xhtml|svg|js|mjs|xml)$/i.test(file.originalname || '') ||
  /(text\/html|image\/svg|application\/xhtml|javascript)/i.test(file.mimetype || '');

const chatUpload = multer({
  storage: multer.diskStorage({
    destination: chatDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 8).replace(/[^a-zA-Z0-9.]/g, '');
      // 推測可能な Date.now()+Math.random ではなく CSPRNG の UUID で列挙を防ぐ
      cb(null, crypto.randomUUID() + ext);
    },
  }),
  fileFilter: (req, file, cb) => {
    if (DANGEROUS_UPLOAD(file)) return cb(new Error('このファイル形式はアップロードできません'));
    cb(null, true);
  },
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

// 2026-07-21 廃止。旧「自分のログ」(/mylog) 専用API。
// 旧実装が WHERE に `OR m.receiver_id IS NULL` を含んでいたため、receiver_id=NULL =
// 全グループチャット(grp_*)が、未加入グループも含めて全ログインユーザーに最大60日500件
// 閲覧可能だった (役員会話・実名つき健康データ・個人の病状を含む)。機能ごと撤去。
router.get('/history', authUser, (req, res) => {
  res.status(410).json({ success: false, msg: 'この機能は廃止されました' });
});

// 指定フロアのチャット履歴 直近100件
// ⚠️2026-07-21 修正: room をクライアント指定のまま SQL に渡しており、
// `?room=dm` で全社のDM本文が、`?room=grp_xxx` で未加入グループの会話が
// 全ログインユーザーに読めた (/history と同種の抜け)。閲覧可否を検査する。
router.get('/recent', authUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const room = (req.query.room || 'lobby').toString();
  const db = getDb();
  if (room === 'dm') {
    return res.status(403).json({ success: false, msg: 'DMはこの経路では取得できません' });
  }
  if (room.startsWith('grp_')) {
    if (!canAccessGroup(req.uid, room.slice(4))) {
      return res.status(403).json({ success: false, msg: 'メンバーではありません' });
    }
  } else if (!db.prepare('SELECT 1 FROM floors WHERE code = ?').get(room)) {
    return res.status(403).json({ success: false, msg: '閲覧できないルームです' });
  }
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
// ⚠️2026-07-28 修正: 以前は「管理者(11名)には全GCを返す」分岐があり、参加していない
// グループが一覧に並び、そのまま開いて読めていた。参加しているGCだけを返す。
router.get('/groups', authUser, (req, res) => {
  const rows = getDb().prepare(`
    SELECT g.id, g.name, g.icon, g.created_at, g.is_circle, g.category,
      (SELECT MAX(created_at) FROM messages WHERE room_code = 'grp_' || g.id) AS last_at,
      (SELECT content FROM messages WHERE room_code = 'grp_' || g.id ORDER BY created_at DESC LIMIT 1) AS last_content,
      (SELECT COUNT(*) FROM chat_group_members WHERE group_id = g.id) AS member_count,
      1 AS is_member,
      EXISTS(SELECT 1 FROM user_hidden_groups WHERE group_id = g.id AND user_id = ?) AS is_hidden
    FROM chat_groups g
    JOIN chat_group_members m ON m.group_id = g.id
    WHERE m.user_id = ?
    ORDER BY COALESCE(g.sort_order, 100), COALESCE(last_at, g.created_at) DESC
  `).all(req.uid, req.uid);
  res.json({ success: true, groups: rows, is_manager_view: false });
});

// グループの「自分の一覧での表示/非表示」を切り替え (本人の表示だけに影響。閲覧/参加権限は不変)
// body: { group_id, hidden: true|false }
router.post('/groups/hidden', authUser, express.json(), (req, res) => {
  const gid = String((req.body && req.body.group_id) || '').trim();
  if (!gid) return res.status(400).json({ success: false, msg: 'group_id必須' });
  const hidden = !!(req.body && req.body.hidden);
  const db = getDb();
  // 存在チェック (不正IDの混入防止)
  const g = db.prepare('SELECT 1 FROM chat_groups WHERE id = ?').get(gid);
  if (!g) return res.status(404).json({ success: false, msg: 'グループが見つかりません' });
  if (hidden) {
    db.prepare('INSERT OR IGNORE INTO user_hidden_groups (user_id, group_id) VALUES (?, ?)').run(req.uid, gid);
  } else {
    db.prepare('DELETE FROM user_hidden_groups WHERE user_id = ? AND group_id = ?').run(req.uid, gid);
  }
  res.json({ success: true, group_id: gid, hidden });
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
  let target = db.prepare(`SELECT id, sender_id, room_code FROM messages
    WHERE id IN (${placeholders}) AND sender_id != ?`).all(...valid, req.uid);
  // ⚠️2026-07-28 追加: グループのメッセージは「メンバーのときだけ」既読を記録する。
  // 以前はここに検査が無く、IDさえ渡せば非メンバーでも既読が付いた
  // (役員GC=メンバー6名なのに既読8、の直接原因)。
  target = target.filter(m => {
    if (!(m.room_code || '').startsWith('grp_')) return true;
    return canAccessGroup(req.uid, m.room_code.slice(4));
  });
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
      AND m.created_at > gm.joined_at
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
      AND m.created_at > gm.joined_at
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
  let readers = db.prepare(`SELECT u.id, u.display_name, u.avatar_url, c.ring_color, r.read_at
    FROM message_reads r JOIN users u ON u.id = r.user_id
    LEFT JOIN companies c ON c.code = u.company_code
    WHERE r.message_id = ? ORDER BY r.read_at`).all(mid);
  // ⚠️2026-07-28: 修正前に非メンバーが付けた既読が過去分として残っている。
  // 記録は証跡として消さないが、「既読N人」には現在のメンバーだけを数える。
  if (msg.room_code.startsWith('grp_')) {
    const mem = groupMemberIds(msg.room_code.slice(4));
    readers = readers.filter(r => mem.has(r.id));
  }
  res.json({ success: true, readers });
});

// メッセージID範囲で既読者を一括取得 (グループ画面表示用)
// ⚠️2026-07-28 修正: 以前は権限検査が一切無く、message_id さえ渡せば
// 誰でも他人のグループ/DMの「誰がいつ読んだか」を取得できた。
// 自分が閲覧できるメッセージだけに絞り、既読者もメンバーのみ返す。
router.post('/messages/readers-bulk', authUser, express.json(), (req, res) => {
  const ids = Array.isArray(req.body && req.body.message_ids) ? req.body.message_ids : [];
  const valid = ids.map(x => parseInt(x)).filter(n => !isNaN(n) && n > 0).slice(0, 500);
  if (valid.length === 0) return res.json({ success: true, by_message: {} });
  const db = getDb();
  const placeholders = valid.map(() => '?').join(',');
  // 対象メッセージのうち、自分が見てよいものだけを残す
  const msgs = db.prepare(`SELECT id, room_code, sender_id, receiver_id FROM messages
    WHERE id IN (${placeholders})`).all(...valid);
  const memCache = new Map();
  const allowed = new Map();   // message_id -> 既読者として見せてよい user_id の Set (null=制限なし)
  for (const m of msgs) {
    const room = m.room_code || '';
    if (room.startsWith('grp_')) {
      const gid = room.slice(4);
      if (!memCache.has(gid)) memCache.set(gid, groupMemberIds(gid));
      const mem = memCache.get(gid);
      if (!mem.has(req.uid)) continue;            // 非メンバーには返さない
      allowed.set(m.id, mem);                     // 既読者はメンバーのみ (過去の非メンバー既読は数えない)
    } else if (room === 'dm') {
      if (m.sender_id !== req.uid && m.receiver_id !== req.uid) continue;
      allowed.set(m.id, null);
    } else {
      if (!db.prepare('SELECT 1 FROM floors WHERE code = ?').get(room)) continue;
      allowed.set(m.id, null);
    }
  }
  if (allowed.size === 0) return res.json({ success: true, by_message: {} });
  const okIds = [...allowed.keys()];
  const ph2 = okIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT r.message_id, u.id, u.display_name, u.avatar_url, c.ring_color, r.read_at
    FROM message_reads r JOIN users u ON u.id = r.user_id
    LEFT JOIN companies c ON c.code = u.company_code
    WHERE r.message_id IN (${ph2})
    ORDER BY r.read_at`).all(...okIds);
  const byMsg = {};
  for (const r of rows) {
    const mem = allowed.get(r.message_id);
    if (mem && !mem.has(r.id)) continue;
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

// ===== メッセージ削除 (DM/グループ共通) =====
// 権限: 自分の発言は常に削除可。グループは管理者なら他人の発言も削除可(モデレーション)。
//       DMの相手の発言は削除不可。削除後は全端末へ socket 'msg:deleted' を配信して即時反映。
router.delete('/messages/:mid', authUser, (req, res) => {
  const mid = parseInt(req.params.mid);
  if (isNaN(mid)) return res.status(400).json({ success: false, msg: 'IDが不正です' });
  const db = getDb();
  const msg = db.prepare('SELECT id, room_code, sender_id, receiver_id FROM messages WHERE id = ?').get(mid);
  if (!msg) return res.json({ success: true, already: true }); // 既に無い場合も成功扱い

  const isOwn = msg.sender_id === req.uid;
  const isGroup = (msg.room_code || '').startsWith('grp_');
  const gid = isGroup ? msg.room_code.slice(4) : null;
  // 権限判定
  let allowed = isOwn;
  if (!allowed && isGroup && isManager(req.uid)) allowed = true; // グループは管理者がモデレーション可
  if (!allowed) return res.status(403).json({ success: false, msg: 'このメッセージは削除できません' });

  db.prepare('DELETE FROM messages WHERE id = ?').run(mid);
  db.prepare('DELETE FROM message_reads WHERE message_id = ?').run(mid);

  // 配信: グループはメンバー全員、DMは送受信者の双方の全端末へ
  const payload = { id: mid, room_code: msg.room_code, group_id: gid, by: req.uid };
  try {
    if (isGroup && req.app.locals.emitToGroupMembers) {
      req.app.locals.emitToGroupMembers(gid, 'msg:deleted', payload);
    } else if (req.app.locals.emitToUser) {
      req.app.locals.emitToUser(msg.sender_id, 'msg:deleted', payload);
      if (msg.receiver_id) req.app.locals.emitToUser(msg.receiver_id, 'msg:deleted', payload);
    }
  } catch (e) { /* 配信失敗は無視 (DB削除は成立済み) */ }

  res.json({ success: true });
});

module.exports = router;
