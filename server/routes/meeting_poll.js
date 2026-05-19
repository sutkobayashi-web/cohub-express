// ミーティング日程調整 (調整さん型) — 2026-05-14
// 主催者が候補日時を複数出し、招待者は各候補に ○/△/× で回答
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

router.use(express.json({ limit: '512kb' }));

const DOWS = ['日', '月', '火', '水', '木', '金', '土'];
function fmtJa(iso) {
  const m = String(iso || '').match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const d = new Date(iso.length === 16 ? iso + ':00' : iso);
  return parseInt(m[2]) + '/' + parseInt(m[3]) + '(' + DOWS[d.getDay()] + ') ' + m[4] + ':' + m[5];
}

// 未回答の投票数 (招待されていてまだ未回答の open ポール、主催者本人は除く)
router.get('/unread-count', authUser, (req, res) => {
  const db = getDb();
  const r = db.prepare(`
    SELECT COUNT(*) AS count FROM meeting_polls p
    JOIN meeting_poll_invitees i ON i.poll_id = p.id AND i.user_id = ?
    WHERE p.status = 'open'
      AND p.organizer_id != ?
      AND NOT EXISTS (
        SELECT 1 FROM meeting_poll_votes v
        WHERE v.poll_id = p.id AND v.user_id = ?
      )
  `).get(req.uid, req.uid, req.uid);
  res.json({ success: true, count: r.count || 0 });
});

// 会議室 mt:main の現在の参加者プロファイルを返す
function getCurrentRoomParticipants(req) {
  const io = req.app && req.app.locals && req.app.locals.io;
  if (!io) return [];
  const room = io.sockets.adapter.rooms.get('mt:main');
  if (!room) return [];
  const uids = [];
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.uid && !uids.includes(s.uid)) uids.push(s.uid);
  }
  if (!uids.length) return [];
  const db = getDb();
  const ph = uids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, display_name, avatar_url FROM users WHERE id IN (${ph})`).all(...uids);
  return rows.map(u => ({ id: u.id, name: u.display_name || '', avatar: u.avatar_url || '' }));
}

// 時刻表 (ミーティングルームトップに「映画の時刻表風」で並べる)
router.get('/timetable', authUser, (req, res) => {
  const db = getDb();
  const me = req.uid;

  // 確定済み: 自分が主催 or 招待されていて、まだ終わっていないもの (開始時刻+所要時間 >= 今 のもの)
  const decided = db.prepare(`
    SELECT p.id, p.title, p.description, p.organizer_id, p.duration_minutes, p.decided_at,
           p.format, p.location,
           u.display_name AS organizer_name, u.avatar_url AS organizer_avatar,
           s.starts_at
    FROM meeting_polls p
    JOIN meeting_poll_slots s ON s.id = p.decided_slot_id
    LEFT JOIN users u ON u.id = p.organizer_id
    WHERE p.status = 'decided'
      AND datetime(s.starts_at, '+' || COALESCE(p.duration_minutes, 30) || ' minutes') >= datetime('now')
      AND (p.organizer_id = ? OR EXISTS (SELECT 1 FROM meeting_poll_invitees i WHERE i.poll_id = p.id AND i.user_id = ?))
    ORDER BY s.starts_at ASC
    LIMIT 30
  `).all(me, me);

  // 調整中: 自分が主催 or 招待されていて open のもの
  const open = db.prepare(`
    SELECT p.id, p.title, p.description, p.organizer_id, p.duration_minutes, p.created_at,
           p.format, p.location,
           u.display_name AS organizer_name, u.avatar_url AS organizer_avatar,
           (SELECT COUNT(*) FROM meeting_poll_slots WHERE poll_id = p.id) AS slot_count,
           (SELECT COUNT(*) FROM meeting_poll_invitees WHERE poll_id = p.id) AS invitee_count,
           (SELECT COUNT(DISTINCT user_id) FROM meeting_poll_votes WHERE poll_id = p.id) AS voted_count,
           (SELECT MIN(starts_at) FROM meeting_poll_slots WHERE poll_id = p.id) AS earliest_candidate
    FROM meeting_polls p
    LEFT JOIN users u ON u.id = p.organizer_id
    WHERE p.status = 'open'
      AND (p.organizer_id = ? OR EXISTS (SELECT 1 FROM meeting_poll_invitees i WHERE i.poll_id = p.id AND i.user_id = ?))
    ORDER BY earliest_candidate ASC, p.created_at DESC
    LIMIT 30
  `).all(me, me);

  // 参加者アバター (確定済み・調整中の両方、最大6名分)
  const allIds = [...decided.map(d => d.id), ...open.map(p => p.id)];
  const participantsByPoll = {};
  if (allIds.length) {
    const ph = allIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT i.poll_id, i.user_id, u.display_name, u.avatar_url
      FROM meeting_poll_invitees i
      LEFT JOIN users u ON u.id = i.user_id
      WHERE i.poll_id IN (${ph})
      ORDER BY i.poll_id, COALESCE(u.display_name, i.user_id)
    `).all(...allIds);
    for (const r of rows) {
      if (!participantsByPoll[r.poll_id]) participantsByPoll[r.poll_id] = [];
      participantsByPoll[r.poll_id].push({ id: r.user_id, name: r.display_name, avatar: r.avatar_url });
    }
  }

  res.json({
    success: true,
    server_now: new Date().toISOString(),
    decided: decided.map(d => Object.assign({}, d, { participants: participantsByPoll[d.id] || [] })),
    open: open.map(p => Object.assign({}, p, { participants: participantsByPoll[p.id] || [] })),
    me,
    current_room: getCurrentRoomParticipants(req),
  });
});

// 一覧 (自分が主催 or 招待されているもの)
router.get('/', authUser, (req, res) => {
  const db = getDb();
  const polls = db.prepare(`
    SELECT p.id, p.title, p.description, p.organizer_id, p.status,
           p.decided_slot_id, p.duration_minutes, p.created_at, p.decided_at,
           p.format, p.location,
           u.display_name AS organizer_name, u.avatar_url AS organizer_avatar,
           (SELECT starts_at FROM meeting_poll_slots WHERE id = p.decided_slot_id) AS decided_at_slot,
           (SELECT COUNT(*) FROM meeting_poll_slots WHERE poll_id = p.id) AS slot_count,
           (SELECT COUNT(*) FROM meeting_poll_invitees WHERE poll_id = p.id) AS invitee_count,
           (SELECT COUNT(DISTINCT user_id) FROM meeting_poll_votes WHERE poll_id = p.id) AS voted_count
    FROM meeting_polls p
    LEFT JOIN users u ON u.id = p.organizer_id
    WHERE p.organizer_id = ?
       OR EXISTS (SELECT 1 FROM meeting_poll_invitees i WHERE i.poll_id = p.id AND i.user_id = ?)
    ORDER BY (p.status = 'open') DESC, p.created_at DESC
    LIMIT 100
  `).all(req.uid, req.uid);
  res.json({ success: true, polls, me: req.uid });
});

// 詳細
router.get('/:id', authUser, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, msg: 'id不正' });
  const poll = db.prepare(`SELECT p.*, u.display_name AS organizer_name, u.avatar_url AS organizer_avatar
    FROM meeting_polls p LEFT JOIN users u ON u.id = p.organizer_id WHERE p.id = ?`).get(id);
  if (!poll) return res.status(404).json({ success: false, msg: '見つかりません' });
  const isOrganizer = poll.organizer_id === req.uid;
  const invited = !!db.prepare(`SELECT 1 FROM meeting_poll_invitees WHERE poll_id = ? AND user_id = ?`).get(id, req.uid);
  if (!isOrganizer && !invited) return res.status(403).json({ success: false, msg: '権限がありません' });

  const slots = db.prepare(`SELECT id, starts_at, ordinal FROM meeting_poll_slots WHERE poll_id = ? ORDER BY ordinal, starts_at`).all(id);
  const invitees = db.prepare(`
    SELECT i.user_id, u.display_name, u.avatar_url, u.company_code
    FROM meeting_poll_invitees i
    LEFT JOIN users u ON u.id = i.user_id
    WHERE i.poll_id = ?
    ORDER BY COALESCE(u.display_name, i.user_id)
  `).all(id);
  const votes = db.prepare(`SELECT user_id, slot_id, answer FROM meeting_poll_votes WHERE poll_id = ?`).all(id);

  // 自分の回答済みフラグ
  const myVoteCount = db.prepare(`SELECT COUNT(*) c FROM meeting_poll_votes WHERE poll_id = ? AND user_id = ?`).get(id, req.uid).c;
  res.json({
    success: true,
    poll,
    slots,
    invitees,
    votes,
    me: req.uid,
    is_organizer: isOrganizer,
    is_invited: invited,
    voted: myVoteCount > 0,
  });
});

// 新規作成
router.post('/', authUser, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ success: false, msg: 'タイトル必須' });
  const description = String(b.description || '').trim().slice(0, 2000);
  const duration = Math.max(10, Math.min(480, parseInt(b.duration_minutes) || 30));
  const slots = Array.isArray(b.slots) ? b.slots.filter(s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(s))) : [];
  const invitees = Array.isArray(b.invitees) ? b.invitees.filter(Boolean) : [];
  if (slots.length < 1) return res.status(400).json({ success: false, msg: '候補日時を1つ以上' });
  if (slots.length > 30) return res.status(400).json({ success: false, msg: '候補日時は30件まで' });
  if (invitees.length < 1) return res.status(400).json({ success: false, msg: '出席者を1人以上' });
  if (invitees.length > 50) return res.status(400).json({ success: false, msg: '出席者は50人まで' });

  // 開催形式
  const format = (b.format === 'inperson') ? 'inperson' : 'online';
  const location = (format === 'inperson') ? String(b.location || '').trim().slice(0, 200) : '';
  if (format === 'inperson' && !location) {
    return res.status(400).json({ success: false, msg: '対面の場合は場所を入力してください' });
  }

  const db = getDb();
  // 招待ユーザーがDBに存在するかバリデーション
  const ph = invitees.map(() => '?').join(',');
  const existRows = db.prepare(`SELECT id FROM users WHERE id IN (${ph})`).all(...invitees);
  const existSet = new Set(existRows.map(r => r.id));
  const validInvitees = invitees.filter(u => existSet.has(u));
  if (validInvitees.length === 0) return res.status(400).json({ success: false, msg: '出席者が見つかりません' });

  const ins = db.prepare(`INSERT INTO meeting_polls (organizer_id, title, description, duration_minutes, format, location) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.uid, title, description, duration, format, location);
  const pollId = ins.lastInsertRowid;
  const slotIns = db.prepare(`INSERT INTO meeting_poll_slots (poll_id, starts_at, ordinal) VALUES (?, ?, ?)`);
  const invIns = db.prepare(`INSERT OR IGNORE INTO meeting_poll_invitees (poll_id, user_id) VALUES (?, ?)`);
  db.transaction(() => {
    slots.forEach((s, idx) => slotIns.run(pollId, String(s).slice(0, 30), idx));
    validInvitees.forEach(u => invIns.run(pollId, u));
  })();

  // 招待者全員にDM
  const orgUser = db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(req.uid);
  const slotPreviews = slots.slice(0, 3).map(s => fmtJa(s)).join('・');
  const more = slots.length > 3 ? ` 他${slots.length - 3}件` : '';
  const place = fmtPlace(format, location);
  const msg = `📅 ${(orgUser && orgUser.display_name) || ''}さんが「${title}」の日程調整を依頼しています。\n形式: ${place}\n候補: ${slotPreviews}${more}\n→ /poll.html?id=${pollId} で回答`;
  const emit = req.app && req.app.locals && req.app.locals.emitToUser;
  const dmIns = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')");
  for (const uid of validInvitees) {
    if (uid === req.uid) continue;
    const r = dmIns.run(req.uid, uid, msg);
    if (emit) emit(uid, 'dm:msg', { id: r.lastInsertRowid, from: req.uid, to: uid, content: msg, at: new Date().toISOString() });
  }
  res.json({ success: true, id: pollId });
});

// 投票送信 (自分の全スロットの回答を上書き)
router.post('/:id/vote', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, msg: 'id不正' });
  const db = getDb();
  const poll = db.prepare(`SELECT id, status FROM meeting_polls WHERE id = ?`).get(id);
  if (!poll) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (poll.status !== 'open') return res.status(400).json({ success: false, msg: '締切済みです' });
  const invited = db.prepare(`SELECT 1 FROM meeting_poll_invitees WHERE poll_id = ? AND user_id = ?`).get(id, req.uid);
  if (!invited) return res.status(403).json({ success: false, msg: '招待されていません' });
  const votes = (req.body && req.body.votes) || {};

  db.prepare(`DELETE FROM meeting_poll_votes WHERE poll_id = ? AND user_id = ?`).run(id, req.uid);
  const ins = db.prepare(`INSERT INTO meeting_poll_votes (poll_id, slot_id, user_id, answer) VALUES (?, ?, ?, ?)`);
  const slotIds = new Set(db.prepare(`SELECT id FROM meeting_poll_slots WHERE poll_id = ?`).all(id).map(r => r.id));
  db.transaction(() => {
    for (const slotIdStr of Object.keys(votes)) {
      const sid = parseInt(slotIdStr);
      const ans = String(votes[slotIdStr]);
      if (!['yes', 'maybe', 'no'].includes(ans)) continue;
      if (!slotIds.has(sid)) continue;
      ins.run(id, sid, req.uid, ans);
    }
  })();
  res.json({ success: true });
});

// 主催者が確定
router.post('/:id/decide', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const slotId = parseInt(req.body && req.body.slot_id);
  const db = getDb();
  const poll = db.prepare(`SELECT id, organizer_id, title, status, format, location FROM meeting_polls WHERE id = ?`).get(id);
  if (!poll) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (poll.organizer_id !== req.uid) return res.status(403).json({ success: false, msg: '主催者のみ確定可能' });
  if (poll.status !== 'open') return res.status(400).json({ success: false, msg: '既に確定済みです' });
  const slot = db.prepare(`SELECT id, starts_at FROM meeting_poll_slots WHERE id = ? AND poll_id = ?`).get(slotId, id);
  if (!slot) return res.status(400).json({ success: false, msg: 'スロットが不正' });

  db.prepare(`UPDATE meeting_polls SET status = 'decided', decided_slot_id = ?, decided_at = datetime('now') WHERE id = ?`).run(slotId, id);

  const invitees = db.prepare(`SELECT user_id FROM meeting_poll_invitees WHERE poll_id = ?`).all(id);
  const place = fmtPlace(poll.format, poll.location);
  const msg = `✅ 「${poll.title}」の開催日時が確定しました: ${fmtJa(slot.starts_at)}\n形式: ${place}\n→ /poll.html?id=${id}`;
  const emit = req.app && req.app.locals && req.app.locals.emitToUser;
  const dmIns = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')");
  for (const { user_id } of invitees) {
    if (user_id === req.uid) continue;
    const r = dmIns.run(req.uid, user_id, msg);
    if (emit) emit(user_id, 'dm:msg', { id: r.lastInsertRowid, from: req.uid, to: user_id, content: msg, at: new Date().toISOString() });
  }
  res.json({ success: true });
});

// キャンセル
router.delete('/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const poll = db.prepare(`SELECT organizer_id, status FROM meeting_polls WHERE id = ?`).get(id);
  if (!poll) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (poll.organizer_id !== req.uid) return res.status(403).json({ success: false, msg: '主催者のみ' });
  if (poll.status === 'cancelled') return res.json({ success: true });
  db.prepare(`UPDATE meeting_polls SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?`).run(id);
  res.json({ success: true });
});

// ============ 開始前リマインダーDM (15分前 / 5分前) ============
// meeting_polls に notified_15min_at / notified_5min_at / format / location カラムを追加 (初回起動時)
function ensureNotifyColumns() {
  const db = getDb();
  try {
    const info = db.prepare('PRAGMA table_info(meeting_polls)').all();
    const cols = new Set(info.map(c => c.name));
    if (!cols.has('notified_15min_at')) db.prepare('ALTER TABLE meeting_polls ADD COLUMN notified_15min_at TEXT').run();
    if (!cols.has('notified_5min_at')) db.prepare('ALTER TABLE meeting_polls ADD COLUMN notified_5min_at TEXT').run();
    // 2026-05-19 開催形式 (online=Zoom主体 / inperson=対面)
    if (!cols.has('format')) db.prepare("ALTER TABLE meeting_polls ADD COLUMN format TEXT DEFAULT 'online'").run();
    if (!cols.has('location')) db.prepare("ALTER TABLE meeting_polls ADD COLUMN location TEXT DEFAULT ''").run();
  } catch (e) { console.warn('[meeting_poll] ALTER skipped:', e.message); }
}

function fmtPlace(format, location) {
  if (format === 'inperson') return location ? `📍 対面 (${location})` : '📍 対面';
  return '📹 オンライン (Zoom)';
}

function tickReminders(app) {
  const db = getDb();
  const emit = app && app.locals && app.locals.emitToUser;
  const nowMs = Date.now();
  // 15分以内かつ未通知15
  // 5分以内かつ未通知5
  // SQLiteの日時はUTC基準なのでJSで境界判定する
  const candidates = db.prepare(`
    SELECT p.id, p.title, p.organizer_id, p.duration_minutes, p.notified_15min_at, p.notified_5min_at,
           p.format, p.location,
           s.starts_at,
           u.display_name AS organizer_name
    FROM meeting_polls p
    JOIN meeting_poll_slots s ON s.id = p.decided_slot_id
    LEFT JOIN users u ON u.id = p.organizer_id
    WHERE p.status = 'decided'
      AND p.cancelled_at IS NULL
  `).all();
  const updateNote15 = db.prepare("UPDATE meeting_polls SET notified_15min_at = datetime('now') WHERE id = ?");
  const updateNote5 = db.prepare("UPDATE meeting_polls SET notified_5min_at = datetime('now') WHERE id = ?");
  const inviteesStmt = db.prepare(`SELECT user_id FROM meeting_poll_invitees WHERE poll_id = ?`);
  const dmIns = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')");
  for (const c of candidates) {
    if (!c.starts_at) continue;
    const startMs = new Date(String(c.starts_at).length === 16 ? c.starts_at + ':00Z' : c.starts_at.replace(' ', 'T') + (c.starts_at.includes('T') ? '' : 'Z')).getTime();
    // starts_at は JST想定 (UI入力) なので、Z付与は無理筋。ローカル時刻として解釈する。
    const startLocal = new Date(c.starts_at.length === 16 ? c.starts_at + ':00' : c.starts_at).getTime();
    if (!isFinite(startLocal)) continue;
    const minsUntil = (startLocal - nowMs) / 60000;
    const dur = c.duration_minutes || 30;
    const timeStr = (() => { const d = new Date(startLocal); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); })();
    const place = fmtPlace(c.format, c.location);
    const where = (c.format === 'inperson') ? place : `${place}\n→ /meeting で入室`;
    // 15分前: 15分以内 かつ 5分超 (5分通知に被らない) かつ 未通知
    if (!c.notified_15min_at && minsUntil <= 15 && minsUntil > 5) {
      const msg = `⏰ あと${Math.max(1, Math.round(minsUntil))}分で「${c.title}」が始まります (${timeStr}〜${dur}分)\n${where}`;
      const invitees = inviteesStmt.all(c.id);
      for (const { user_id } of invitees) {
        if (user_id === c.organizer_id) continue;
        try {
          const r = dmIns.run(c.organizer_id, user_id, msg);
          if (emit) emit(user_id, 'dm:msg', { id: r.lastInsertRowid, from: c.organizer_id, to: user_id, content: msg, at: new Date().toISOString() });
        } catch (e) { /* skip */ }
      }
      updateNote15.run(c.id);
    }
    // 5分前: 5分以内 かつ 開始前 かつ 未通知5
    if (!c.notified_5min_at && minsUntil <= 5 && minsUntil > -2) {
      const msg = `🔔 まもなく「${c.title}」が始まります (${timeStr})\n${where}`;
      const invitees = inviteesStmt.all(c.id);
      for (const { user_id } of invitees) {
        if (user_id === c.organizer_id) continue;
        try {
          const r = dmIns.run(c.organizer_id, user_id, msg);
          if (emit) emit(user_id, 'dm:msg', { id: r.lastInsertRowid, from: c.organizer_id, to: user_id, content: msg, at: new Date().toISOString() });
        } catch (e) { /* skip */ }
      }
      updateNote5.run(c.id);
    }
  }
}

let _reminderTimer = null;
function startReminderScheduler(app) {
  ensureNotifyColumns();
  if (_reminderTimer) return;
  // 60秒ごとにチェック
  _reminderTimer = setInterval(() => {
    try { tickReminders(app); }
    catch (e) { console.warn('[meeting_poll reminder]', e.message); }
  }, 60 * 1000);
  // 起動直後にも1回実行
  setTimeout(() => { try { tickReminders(app); } catch (e) {} }, 5000);
}

// モジュールロード時に即座にスキーマ移行 (route呼び出しで未定義カラム参照を避ける)
try { ensureNotifyColumns(); } catch (e) { console.warn('[meeting_poll] ensure on load skipped:', e.message); }

module.exports = router;
module.exports.startReminderScheduler = startReminderScheduler;
