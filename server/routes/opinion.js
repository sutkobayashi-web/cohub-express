// みんなに聞いてみよう — 意見募集(自由記述)＋AI集約  2026-06-20
// 主催者がお題を出し、対象者は自由記述で意見を投稿。集まった意見を Gemini が
// 「論点・賛否・代表的な声」に自動要約し、主催者の手集約をゼロにする。
// 投票したろう(vote.js)の作法を踏襲: 個別招待 + 招待DM(+push) + 未回答バッジ。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const ai = require('../services/ai');

router.use(express.json({ limit: '512kb' }));

function ensureSchema() {
  const db = getDb();
  db.prepare(`CREATE TABLE IF NOT EXISTS opinion_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organizer_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    allow_anonymous INTEGER DEFAULT 1,
    status TEXT DEFAULT 'open',
    summary_text TEXT,
    summarized_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT,
    cancelled_at TEXT
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS opinion_invitees (
    request_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (request_id, user_id)
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS opinion_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    is_anon INTEGER DEFAULT 0,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(request_id, user_id)
  )`).run();
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_opres_req ON opinion_responses(request_id)').run(); } catch (e) {}
}
try { ensureSchema(); } catch (e) { console.warn('[opinion] ensureSchema skipped:', e.message); }

// 未回答件数 (招待されていて open かつ未回答、主催者本人は除く)
router.get('/unread-count', authUser, (req, res) => {
  const db = getDb();
  const r = db.prepare(`
    SELECT COUNT(*) AS count FROM opinion_requests p
    JOIN opinion_invitees i ON i.request_id = p.id AND i.user_id = ?
    WHERE p.status = 'open' AND p.organizer_id != ?
      AND NOT EXISTS (SELECT 1 FROM opinion_responses r WHERE r.request_id = p.id AND r.user_id = ?)
  `).get(req.uid, req.uid, req.uid);
  res.json({ success: true, count: (r && r.count) || 0 });
});

// 一覧 (自分が主催 or 招待されているもの)
router.get('/', authUser, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.id, p.title, p.description, p.organizer_id, p.status, p.allow_anonymous,
           p.created_at, p.closed_at, p.summarized_at,
           u.display_name AS organizer_name, u.avatar_url AS organizer_avatar,
           (SELECT COUNT(*) FROM opinion_invitees WHERE request_id = p.id) AS invitee_count,
           (SELECT COUNT(*) FROM opinion_responses WHERE request_id = p.id) AS response_count,
           EXISTS(SELECT 1 FROM opinion_responses r WHERE r.request_id = p.id AND r.user_id = ?) AS i_responded
    FROM opinion_requests p LEFT JOIN users u ON u.id = p.organizer_id
    WHERE p.status != 'cancelled'
      AND (p.organizer_id = ? OR EXISTS(SELECT 1 FROM opinion_invitees i WHERE i.request_id = p.id AND i.user_id = ?))
    ORDER BY (p.status = 'open') DESC, p.created_at DESC LIMIT 100
  `).all(req.uid, req.uid, req.uid);
  res.json({ success: true, requests: rows, me: req.uid });
});

// 詳細
router.get('/:id', authUser, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, msg: 'id不正' });
  const r = db.prepare(`SELECT p.*, u.display_name AS organizer_name, u.avatar_url AS organizer_avatar
    FROM opinion_requests p LEFT JOIN users u ON u.id = p.organizer_id WHERE p.id = ?`).get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const isOrg = r.organizer_id === req.uid;
  const invited = !!db.prepare('SELECT 1 FROM opinion_invitees WHERE request_id = ? AND user_id = ?').get(id, req.uid);
  if (!isOrg && !invited) return res.status(403).json({ success: false, msg: '権限がありません' });
  const invitee_count = db.prepare('SELECT COUNT(*) c FROM opinion_invitees WHERE request_id = ?').get(id).c;
  const response_count = db.prepare('SELECT COUNT(*) c FROM opinion_responses WHERE request_id = ?').get(id).c;
  const mine = db.prepare('SELECT content, is_anon, updated_at FROM opinion_responses WHERE request_id = ? AND user_id = ?').get(id, req.uid) || null;
  // 生の意見は主催者のみ閲覧可。匿名回答は主催者にも氏名を出さない。
  let responses = null;
  if (isOrg) {
    responses = db.prepare(`SELECT r.id, r.content, r.is_anon, r.created_at, r.updated_at,
        CASE WHEN r.is_anon = 1 THEN NULL ELSE u.display_name END AS name
      FROM opinion_responses r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.request_id = ? ORDER BY r.updated_at DESC`).all(id);
  }
  res.json({
    success: true, request: r, is_organizer: isOrg, is_invited: invited,
    invitee_count, response_count, my_response: mine, responses, me: req.uid,
  });
});

// 新規作成
router.post('/', authUser, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 150);
  if (!title) return res.status(400).json({ success: false, msg: 'お題(質問)を入力してください' });
  const description = String(b.description || '').trim().slice(0, 4000);
  const allowAnon = b.allow_anonymous ? 1 : 0;
  const invitees = Array.isArray(b.invitees) ? b.invitees.filter(Boolean) : [];
  if (invitees.length < 1) return res.status(400).json({ success: false, msg: '対象者を1人以上選んでください' });
  if (invitees.length > 300) return res.status(400).json({ success: false, msg: '対象者は300人まで' });
  const db = getDb();
  const ph = invitees.map(() => '?').join(',');
  const exist = new Set(db.prepare(`SELECT id FROM users WHERE id IN (${ph})`).all(...invitees).map(x => x.id));
  const valid = invitees.filter(u => exist.has(u));
  if (!valid.length) return res.status(400).json({ success: false, msg: '対象者が見つかりません' });
  const ins = db.prepare('INSERT INTO opinion_requests (organizer_id, title, description, allow_anonymous) VALUES (?, ?, ?, ?)')
    .run(req.uid, title, description, allowAnon);
  const rid = ins.lastInsertRowid;
  const invIns = db.prepare('INSERT OR IGNORE INTO opinion_invitees (request_id, user_id) VALUES (?, ?)');
  db.transaction(() => { valid.forEach(u => invIns.run(rid, u)); })();
  // 対象者へ依頼DM(+push)。bot名義でなく主催者本人名義=受信箱に出る。
  const org = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const msg = `🙋 ${(org && org.display_name) || ''}さんが「${title}」についてみんなの意見を募集しています。\n`
    + `あなたの考えを聞かせてください（${allowAnon ? '匿名でも回答できます' : '記名'}）。\n→ /opinion.html?id=${rid}`;
  const emit = req.app && req.app.locals && req.app.locals.emitToUser;
  const push = req.app && req.app.locals && req.app.locals.sendPushToUser;
  const dmIns = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')");
  for (const uid of valid) {
    if (uid === req.uid) continue;
    const rr = dmIns.run(req.uid, uid, msg);
    if (emit) emit(uid, 'dm:msg', { id: rr.lastInsertRowid, from: req.uid, to: uid, content: msg, at: new Date().toISOString() });
    if (push) { try { push(uid, { title: '🙋 意見募集', body: title.slice(0, 120), tag: 'opinion-' + rid, url: '/opinion.html?id=' + rid }); } catch (e) {} }
  }
  res.json({ success: true, id: rid });
});

// 意見の投稿/更新 (1人1件・上書き)
router.post('/:id/respond', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const r = db.prepare('SELECT id, status, allow_anonymous FROM opinion_requests WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (r.status !== 'open') return res.status(400).json({ success: false, msg: '締切済みです' });
  const invited = db.prepare('SELECT 1 FROM opinion_invitees WHERE request_id = ? AND user_id = ?').get(id, req.uid);
  if (!invited) return res.status(403).json({ success: false, msg: '対象者ではありません' });
  const content = String((req.body && req.body.content) || '').trim().slice(0, 4000);
  if (!content) return res.status(400).json({ success: false, msg: '意見を入力してください' });
  const anon = (r.allow_anonymous && req.body && req.body.anonymous) ? 1 : 0;
  const existing = db.prepare('SELECT id FROM opinion_responses WHERE request_id = ? AND user_id = ?').get(id, req.uid);
  if (existing) {
    db.prepare("UPDATE opinion_responses SET content = ?, is_anon = ?, updated_at = datetime('now') WHERE id = ?").run(content, anon, existing.id);
  } else {
    db.prepare('INSERT INTO opinion_responses (request_id, user_id, is_anon, content) VALUES (?, ?, ?, ?)').run(id, req.uid, anon, content);
  }
  res.json({ success: true });
});

// AI集約 (主催者のみ)
router.post('/:id/summarize', authUser, async (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const r = db.prepare('SELECT * FROM opinion_requests WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (r.organizer_id !== req.uid) return res.status(403).json({ success: false, msg: '主催者のみ集約できます' });
  const rows = db.prepare('SELECT content FROM opinion_responses WHERE request_id = ? ORDER BY created_at').all(id);
  if (rows.length < 1) return res.status(400).json({ success: false, msg: 'まだ回答がありません' });
  const list = rows.map((x, i) => `【意見${i + 1}】${x.content}`).join('\n');
  const prompt = `あなたは社内の意見集約を支援するアシスタントです。以下は「${r.title}」というお題に対して、社員から集まった${rows.length}件の自由記述の意見です。意思決定者が一目で把握できるよう、日本語のMarkdownでわかりやすくまとめてください。\n\n# お題\n${r.title}\n${r.description || ''}\n\n# 集まった意見(${rows.length}件)\n${list}\n\n# 出力形式(この見出し構成で簡潔に)\n## 全体の傾向\n(2〜4行)\n## 主な論点\n(箇条書き。論点ごとに賛否や声の多寡が分かるように)\n## 前向き・賛成の声\n(代表的な意見を2〜4個、要約)\n## 慎重・反対の声\n(2〜4個。無ければ「特になし」)\n## 少数だが注目したい意見\n(1〜3個。無ければ省略)\n## 次の一手の提案\n(意見を踏まえた具体的アクション2〜3個)\n\n注意: 個人名や特定につながる表現は避け、意見の中身に集中。誇張や創作はせず、寄せられた意見に忠実にまとめること。`;
  try {
    const text = await ai.generateText(prompt, { temperature: 0.3, maxTokens: 1800, thinkingBudget: 0 });
    db.prepare("UPDATE opinion_requests SET summary_text = ?, summarized_at = datetime('now') WHERE id = ?").run(text, id);
    res.json({ success: true, summary: text, response_count: rows.length });
  } catch (e) {
    console.error('[opinion summarize]', e.message);
    res.status(500).json({ success: false, msg: 'AI集約に失敗しました: ' + e.message });
  }
});

// 締切 / 再開 (主催者のみ)
router.post('/:id/close', authUser, (req, res) => {
  const id = parseInt(req.params.id); const db = getDb();
  const r = db.prepare('SELECT organizer_id FROM opinion_requests WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false });
  if (r.organizer_id !== req.uid) return res.status(403).json({ success: false, msg: '主催者のみ' });
  db.prepare("UPDATE opinion_requests SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
});
router.post('/:id/reopen', authUser, (req, res) => {
  const id = parseInt(req.params.id); const db = getDb();
  const r = db.prepare('SELECT organizer_id FROM opinion_requests WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false });
  if (r.organizer_id !== req.uid) return res.status(403).json({ success: false, msg: '主催者のみ' });
  db.prepare("UPDATE opinion_requests SET status = 'open', closed_at = NULL WHERE id = ?").run(id);
  res.json({ success: true });
});

module.exports = router;
