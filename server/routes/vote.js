// 投票したろう — 多肢選択投票 (アンケート型) 2026-06-11
// 主催者が選択肢を複数出し、招待者は「最大N個まで」選んで投票。記名式。
// 会議出太郎(meeting_poll)の作法を踏襲: 個別招待 + 招待DM + 未読バッジ
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

router.use(express.json({ limit: '512kb' }));

// ---- スキーマ移行 (モジュールロード時に1回) ----
function ensureSchema() {
  const db = getDb();
  db.prepare(`CREATE TABLE IF NOT EXISTS vote_polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organizer_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    max_choices INTEGER DEFAULT 1,
    status TEXT DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT,
    cancelled_at TEXT
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS vote_poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    ordinal INTEGER DEFAULT 0
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS vote_poll_invitees (
    poll_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (poll_id, user_id)
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS vote_poll_votes (
    poll_id INTEGER NOT NULL,
    option_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (poll_id, option_id, user_id)
  )`).run();
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_vpo_poll ON vote_poll_options(poll_id)').run(); } catch (e) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_vpv_poll ON vote_poll_votes(poll_id)').run(); } catch (e) {}
  // 決選投票リンク用カラム (既存テーブルへ後付け)
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(vote_polls)').all().map(c => c.name));
    if (!cols.has('parent_poll_id')) db.prepare('ALTER TABLE vote_polls ADD COLUMN parent_poll_id INTEGER').run();
    if (!cols.has('round')) db.prepare('ALTER TABLE vote_polls ADD COLUMN round INTEGER DEFAULT 1').run();
  } catch (e) { console.warn('[vote] runoff cols skip:', e.message); }
}
try { ensureSchema(); } catch (e) { console.warn('[vote] ensureSchema skipped:', e.message); }

// 大学関係者(閲覧者): company_code='UNIVERSITY' は全投票を閲覧のみ可能。
// 招待者ではないので投票はできず、未回答バッジ(unread-count)にも乗らない=投票義務なし。
function isUniversityObserver(db, uid) {
  const u = db.prepare(`SELECT company_code FROM users WHERE id = ?`).get(uid);
  return !!(u && u.company_code === 'UNIVERSITY');
}

// 未回答の投票数 (招待されていてまだ未回答の open ポール、主催者本人は除く)
router.get('/unread-count', authUser, (req, res) => {
  const db = getDb();
  const r = db.prepare(`
    SELECT COUNT(*) AS count FROM vote_polls p
    JOIN vote_poll_invitees i ON i.poll_id = p.id AND i.user_id = ?
    WHERE p.status = 'open'
      AND p.organizer_id != ?
      AND NOT EXISTS (
        SELECT 1 FROM vote_poll_votes v
        WHERE v.poll_id = p.id AND v.user_id = ?
      )
  `).get(req.uid, req.uid, req.uid);
  res.json({ success: true, count: (r && r.count) || 0 });
});

// 一覧 (自分が主催 or 招待されているもの / 大学関係者は全件を閲覧)
router.get('/', authUser, (req, res) => {
  const db = getDb();
  const observer = isUniversityObserver(db, req.uid);
  const SELECT = `
    SELECT p.id, p.title, p.description, p.organizer_id, p.status, p.max_choices,
           p.created_at, p.closed_at, p.round, p.parent_poll_id,
           u.display_name AS organizer_name, u.avatar_url AS organizer_avatar,
           (SELECT COUNT(*) FROM vote_poll_options WHERE poll_id = p.id) AS option_count,
           (SELECT COUNT(*) FROM vote_poll_invitees WHERE poll_id = p.id) AS invitee_count,
           (SELECT COUNT(DISTINCT user_id) FROM vote_poll_votes WHERE poll_id = p.id) AS voted_count
    FROM vote_polls p
    LEFT JOIN users u ON u.id = p.organizer_id `;
  const ORDER = ` ORDER BY (p.status = 'open') DESC, p.created_at DESC LIMIT 100`;
  let polls;
  if (observer) {
    // 大学関係者: 中止以外の全投票を閲覧 (招待不要)
    polls = db.prepare(SELECT + ` WHERE p.status != 'cancelled'` + ORDER).all();
  } else {
    polls = db.prepare(SELECT + ` WHERE p.organizer_id = ?
       OR EXISTS (SELECT 1 FROM vote_poll_invitees i WHERE i.poll_id = p.id AND i.user_id = ?)` + ORDER)
      .all(req.uid, req.uid);
  }
  res.json({ success: true, polls, me: req.uid, is_observer: observer });
});

// 詳細
router.get('/:id', authUser, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, msg: 'id不正' });
  const poll = db.prepare(`SELECT p.*, u.display_name AS organizer_name, u.avatar_url AS organizer_avatar
    FROM vote_polls p LEFT JOIN users u ON u.id = p.organizer_id WHERE p.id = ?`).get(id);
  if (!poll) return res.status(404).json({ success: false, msg: '見つかりません' });
  const isOrganizer = poll.organizer_id === req.uid;
  const invited = !!db.prepare(`SELECT 1 FROM vote_poll_invitees WHERE poll_id = ? AND user_id = ?`).get(id, req.uid);
  const observer = isUniversityObserver(db, req.uid);
  if (!isOrganizer && !invited && !observer) return res.status(403).json({ success: false, msg: '権限がありません' });

  const options = db.prepare(`SELECT id, label, ordinal FROM vote_poll_options WHERE poll_id = ? ORDER BY ordinal, id`).all(id);
  const invitees = db.prepare(`
    SELECT i.user_id, u.display_name, u.avatar_url, u.company_code
    FROM vote_poll_invitees i
    LEFT JOIN users u ON u.id = i.user_id
    WHERE i.poll_id = ?
    ORDER BY COALESCE(u.display_name, i.user_id)
  `).all(id);
  // 記名式: 誰がどの選択肢に入れたか (display_name 付き)
  const votes = db.prepare(`
    SELECT v.option_id, v.user_id, u.display_name
    FROM vote_poll_votes v
    LEFT JOIN users u ON u.id = v.user_id
    WHERE v.poll_id = ?
  `).all(id);

  const myVoteCount = db.prepare(`SELECT COUNT(*) c FROM vote_poll_votes WHERE poll_id = ? AND user_id = ?`).get(id, req.uid).c;

  // 決選投票リンク (親 / 子)
  let parent = null;
  if (poll.parent_poll_id) {
    parent = db.prepare(`SELECT id, title, round FROM vote_polls WHERE id = ?`).get(poll.parent_poll_id) || null;
  }
  const runoff_child = db.prepare(
    `SELECT id, title, status FROM vote_polls WHERE parent_poll_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1`
  ).get(id) || null;

  res.json({
    success: true,
    poll,
    options,
    invitees,
    votes,
    me: req.uid,
    is_organizer: isOrganizer,
    is_invited: invited,
    is_observer: observer,
    voted: myVoteCount > 0,
    parent,
    runoff_child,
  });
});

// 新規作成
router.post('/', authUser, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ success: false, msg: 'タイトル必須' });
  const description = String(b.description || '').trim().slice(0, 4000);

  // 選択肢
  const rawOptions = Array.isArray(b.options) ? b.options : [];
  const options = rawOptions
    .map(o => String(o == null ? '' : o).trim().slice(0, 200))
    .filter(Boolean);
  if (options.length < 2) return res.status(400).json({ success: false, msg: '選択肢を2つ以上' });
  if (options.length > 50) return res.status(400).json({ success: false, msg: '選択肢は50個まで' });

  // 最大選択数 (1 = 単一選択)
  let maxChoices = parseInt(b.max_choices);
  if (!Number.isFinite(maxChoices) || maxChoices < 1) maxChoices = 1;
  if (maxChoices > options.length) maxChoices = options.length;

  const invitees = Array.isArray(b.invitees) ? b.invitees.filter(Boolean) : [];
  if (invitees.length < 1) return res.status(400).json({ success: false, msg: '対象者を1人以上' });
  if (invitees.length > 200) return res.status(400).json({ success: false, msg: '対象者は200人まで' });

  const db = getDb();
  // 招待ユーザーがDBに存在するかバリデーション
  const ph = invitees.map(() => '?').join(',');
  const existRows = db.prepare(`SELECT id FROM users WHERE id IN (${ph})`).all(...invitees);
  const existSet = new Set(existRows.map(r => r.id));
  const validInvitees = invitees.filter(u => existSet.has(u));
  if (validInvitees.length === 0) return res.status(400).json({ success: false, msg: '対象者が見つかりません' });

  const ins = db.prepare(`INSERT INTO vote_polls (organizer_id, title, description, max_choices) VALUES (?, ?, ?, ?)`)
    .run(req.uid, title, description, maxChoices);
  const pollId = ins.lastInsertRowid;
  const optIns = db.prepare(`INSERT INTO vote_poll_options (poll_id, label, ordinal) VALUES (?, ?, ?)`);
  const invIns = db.prepare(`INSERT OR IGNORE INTO vote_poll_invitees (poll_id, user_id) VALUES (?, ?)`);
  db.transaction(() => {
    options.forEach((o, idx) => optIns.run(pollId, o, idx));
    validInvitees.forEach(u => invIns.run(pollId, u));
  })();

  // 対象者全員にDM
  const orgUser = db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(req.uid);
  const rule = maxChoices === 1 ? '1つ選んで' : `最大${maxChoices}つまで選んで`;
  const preview = options.slice(0, 3).map(o => '・' + o).join('\n');
  const more = options.length > 3 ? `\n…他${options.length - 3}件` : '';
  const msg = `🗳️ ${(orgUser && orgUser.display_name) || ''}さんが「${title}」の投票を依頼しています。\n${rule}投票してください (全${options.length}項目)\n${preview}${more}\n→ /vote.html?id=${pollId} で投票`;
  const emit = req.app && req.app.locals && req.app.locals.emitToUser;
  const dmIns = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')");
  for (const uid of validInvitees) {
    if (uid === req.uid) continue;
    const r = dmIns.run(req.uid, uid, msg);
    if (emit) emit(uid, 'dm:msg', { id: r.lastInsertRowid, from: req.uid, to: uid, content: msg, at: new Date().toISOString() });
  }
  res.json({ success: true, id: pollId });
});

// 投票送信 (自分の選択を上書き)
router.post('/:id/vote', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, msg: 'id不正' });
  const db = getDb();
  const poll = db.prepare(`SELECT id, status, max_choices FROM vote_polls WHERE id = ?`).get(id);
  if (!poll) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (poll.status !== 'open') return res.status(400).json({ success: false, msg: '締切済みです' });
  const invited = db.prepare(`SELECT 1 FROM vote_poll_invitees WHERE poll_id = ? AND user_id = ?`).get(id, req.uid);
  if (!invited) return res.status(403).json({ success: false, msg: '対象者ではありません' });

  // 受領した option_id (このポールに属するものだけ)
  const validOptIds = new Set(db.prepare(`SELECT id FROM vote_poll_options WHERE poll_id = ?`).all(id).map(r => r.id));
  const reqIds = Array.isArray(req.body && req.body.option_ids) ? req.body.option_ids : [];
  const picked = [];
  const seen = new Set();
  for (const x of reqIds) {
    const oid = parseInt(x);
    if (!validOptIds.has(oid) || seen.has(oid)) continue;
    seen.add(oid);
    picked.push(oid);
  }
  if (picked.length < 1) return res.status(400).json({ success: false, msg: '1つ以上選んでください' });
  if (picked.length > poll.max_choices) {
    return res.status(400).json({ success: false, msg: `選択は最大${poll.max_choices}つまでです` });
  }

  const del = db.prepare(`DELETE FROM vote_poll_votes WHERE poll_id = ? AND user_id = ?`);
  const ins = db.prepare(`INSERT OR IGNORE INTO vote_poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)`);
  db.transaction(() => {
    del.run(id, req.uid);
    picked.forEach(oid => ins.run(id, oid, req.uid));
  })();
  res.json({ success: true });
});

// 主催者が締切
router.post('/:id/close', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const poll = db.prepare(`SELECT id, organizer_id, title, status FROM vote_polls WHERE id = ?`).get(id);
  if (!poll) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (poll.organizer_id !== req.uid) return res.status(403).json({ success: false, msg: '主催者のみ締切可能' });
  if (poll.status !== 'open') return res.status(400).json({ success: false, msg: '既に締切済みです' });

  db.prepare(`UPDATE vote_polls SET status = 'closed', closed_at = datetime('now') WHERE id = ?`).run(id);

  const invitees = db.prepare(`SELECT user_id FROM vote_poll_invitees WHERE poll_id = ?`).all(id);
  const msg = `📊 「${poll.title}」の投票が締め切られました。結果を確認できます。\n→ /vote.html?id=${id}`;
  const emit = req.app && req.app.locals && req.app.locals.emitToUser;
  const dmIns = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')");
  for (const { user_id } of invitees) {
    if (user_id === req.uid) continue;
    const r = dmIns.run(req.uid, user_id, msg);
    if (emit) emit(user_id, 'dm:msg', { id: r.lastInsertRowid, from: req.uid, to: user_id, content: msg, at: new Date().toISOString() });
  }
  res.json({ success: true });
});

// キャンセル (中止)
router.delete('/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const poll = db.prepare(`SELECT organizer_id, status FROM vote_polls WHERE id = ?`).get(id);
  if (!poll) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (poll.organizer_id !== req.uid) return res.status(403).json({ success: false, msg: '主催者のみ' });
  if (poll.status === 'cancelled') return res.json({ success: true });
  db.prepare(`UPDATE vote_polls SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?`).run(id);
  res.json({ success: true });
});

// 決選投票を作成 (締切済みの投票から、指定した候補・同じ対象者で第2回以降を起こす)
router.post('/:id/runoff', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, msg: 'id不正' });
  const db = getDb();
  const parent = db.prepare(`SELECT * FROM vote_polls WHERE id = ?`).get(id);
  if (!parent) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (parent.organizer_id !== req.uid) return res.status(403).json({ success: false, msg: '主催者のみ作成できます' });
  if (parent.status !== 'closed') return res.status(400).json({ success: false, msg: 'まず投票を締め切ってから決選投票を作成してください' });

  // 既に決選投票(未中止)があれば二重作成を防ぐ
  const exist = db.prepare(`SELECT id FROM vote_polls WHERE parent_poll_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1`).get(id);
  if (exist) return res.status(400).json({ success: false, msg: '既に決選投票があります', existing_id: exist.id });

  const b = req.body || {};
  // 引き継ぐ候補 (親の option_id)
  const reqIds = Array.isArray(b.option_ids) ? b.option_ids.map(x => parseInt(x)).filter(Boolean) : [];
  if (reqIds.length < 2) return res.status(400).json({ success: false, msg: '決選の候補を2つ以上選んでください' });
  const ph = reqIds.map(() => '?').join(',');
  const opts = db.prepare(`SELECT id, label FROM vote_poll_options WHERE poll_id = ? AND id IN (${ph}) ORDER BY ordinal, id`).all(id, ...reqIds);
  if (opts.length < 2) return res.status(400).json({ success: false, msg: '候補が不正です' });

  const title = (String(b.title || '').trim().slice(0, 120)) || (parent.title + ' 決選投票');
  const description = b.description != null
    ? String(b.description).trim().slice(0, 4000)
    : `「${parent.title}」で票が割れたため、上位候補で決選投票を行います。`;
  let maxChoices = parseInt(b.max_choices);
  if (!Number.isFinite(maxChoices) || maxChoices < 1) maxChoices = 1;
  if (maxChoices > opts.length) maxChoices = opts.length;
  const round = (parent.round || 1) + 1;

  const invitees = db.prepare(`SELECT user_id FROM vote_poll_invitees WHERE poll_id = ?`).all(id).map(r => r.user_id);
  if (!invitees.length) return res.status(400).json({ success: false, msg: '対象者がいません' });

  const ins = db.prepare(`INSERT INTO vote_polls (organizer_id, title, description, max_choices, parent_poll_id, round) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.uid, title, description, maxChoices, id, round);
  const newId = ins.lastInsertRowid;
  const optIns = db.prepare(`INSERT INTO vote_poll_options (poll_id, label, ordinal) VALUES (?, ?, ?)`);
  const invIns = db.prepare(`INSERT OR IGNORE INTO vote_poll_invitees (poll_id, user_id) VALUES (?, ?)`);
  db.transaction(() => {
    opts.forEach((o, i) => optIns.run(newId, o.label, i));
    invitees.forEach(u => invIns.run(newId, u));
  })();

  // 対象者全員にDM
  const orgUser = db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(req.uid);
  const rule = maxChoices === 1 ? '1つ選んで' : `最大${maxChoices}つまで選んで`;
  const preview = opts.slice(0, 4).map(o => '・' + o.label).join('\n');
  const more = opts.length > 4 ? `\n…他${opts.length - 4}件` : '';
  const msg = `🏁 ${(orgUser && orgUser.display_name) || ''}さんが「${parent.title}」の決選投票を開始しました。\n上位${opts.length}候補から${rule}投票してください\n${preview}${more}\n→ /vote.html?id=${newId} で投票`;
  const emit = req.app && req.app.locals && req.app.locals.emitToUser;
  const dmIns = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')");
  for (const uid of invitees) {
    if (uid === req.uid) continue;
    const r = dmIns.run(req.uid, uid, msg);
    if (emit) emit(uid, 'dm:msg', { id: r.lastInsertRowid, from: req.uid, to: uid, content: msg, at: new Date().toISOString() });
  }
  res.json({ success: true, id: newId });
});

module.exports = router;
