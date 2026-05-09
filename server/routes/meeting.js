// ミーティング (シンプルなZOOM風会議+AI議事録)
// - 部屋: 固定 meeting_a / meeting_b / meeting_c
// - WebRTC: socket.io meeting:* イベント (server/index.js)
// - 議事録: クライアントWeb Speech APIで起こした全文をPOST、Geminiで要約
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateText } = require('../services/ai');

const ROOMS = [
  { id: 'meeting_a', name: '会議室A', icon: '🟦' },
  { id: 'meeting_b', name: '会議室B', icon: '🟩' },
  { id: 'meeting_c', name: '会議室C', icon: '🟧' },
];

// メタ
router.get('/meta', authUser, (req, res) => {
  res.json({ success: true, rooms: ROOMS });
});

// 部屋ごとの現在の参加人数
router.get('/rooms/status', authUser, (req, res) => {
  const io = req.app && req.app.locals && req.app.locals.io;
  const out = ROOMS.map(r => {
    let count = 0;
    if (io) {
      const room = io.sockets.adapter.rooms.get('mt:' + r.id);
      count = room ? room.size : 0;
    }
    return { ...r, count };
  });
  res.json({ success: true, rooms: out });
});

// ミーティング保存 (退室時クライアントから呼ぶ。全文+参加者+期間を保存し、AIで要約生成)
router.post('/save', authUser, express.json({ limit: '2mb' }), async (req, res) => {
  const b = req.body || {};
  const roomId = String(b.room_id || '').trim();
  if (!ROOMS.some(r => r.id === roomId)) {
    return res.status(400).json({ success: false, msg: 'room_id 不正' });
  }
  const title = String(b.title || '').slice(0, 120) || (ROOMS.find(r => r.id === roomId).name + ' ' + new Date().toLocaleString('ja-JP'));
  const transcript = String(b.transcript || '').slice(0, 100000);
  const startedAt = b.started_at ? String(b.started_at) : null;
  const endedAt = b.ended_at ? String(b.ended_at) : null;
  const participants = Array.isArray(b.participants) ? b.participants.slice(0, 50) : [];

  const db = getDb();
  // 議事録が極端に短い (< 50文字) ならAI要約スキップ
  let summary = '';
  if (transcript.length >= 50) {
    try {
      const prompt = `以下は会議の発話起こし全文です。
箇条書きで以下の構成に整理してください:
- 議論の主要トピック (3〜5点)
- 決定事項 (あれば)
- アクションアイテム (担当者・期限が出ていれば付記)
- 持ち越し事項

# 起こし全文
${transcript}`;
      summary = await generateText(prompt, { temperature: 0.3, maxTokens: 1200 });
    } catch (e) {
      console.warn('[meeting/save summarize]', e.message);
      summary = '(AI要約は生成できませんでした: ' + e.message + ')';
    }
  }
  const ins = db.prepare(`INSERT INTO meetings
    (room_id, title, started_by, started_at, ended_at, participants, transcript, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(roomId, title, req.uid, startedAt, endedAt, JSON.stringify(participants), transcript, summary);
  res.json({ success: true, id: ins.lastInsertRowid, summary });
});

// ミーティング履歴一覧 (自分が参加したもの優先)
router.get('/list', authUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const rows = getDb().prepare(`
    SELECT m.id, m.room_id, m.title, m.started_at, m.ended_at, m.summary,
           u.display_name AS started_by_name
    FROM meetings m
    LEFT JOIN users u ON u.id = m.started_by
    ORDER BY m.id DESC LIMIT ?
  `).all(limit);
  res.json({ success: true, meetings: rows });
});

// ミーティング詳細
router.get('/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const m = getDb().prepare(`SELECT m.*, u.display_name AS started_by_name
    FROM meetings m LEFT JOIN users u ON u.id = m.started_by WHERE m.id = ?`).get(id);
  if (!m) return res.status(404).json({ success: false, msg: '見つかりません' });
  let participantNames = [];
  try {
    const ids = JSON.parse(m.participants || '[]');
    if (ids.length) {
      const rows = getDb().prepare(`SELECT id, display_name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      participantNames = rows.map(r => r.display_name);
    }
  } catch (e) {}
  res.json({ success: true, meeting: { ...m, participant_names: participantNames } });
});

module.exports = router;
