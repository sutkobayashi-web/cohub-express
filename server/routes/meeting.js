// ミーティング: Zoom主導+CoHub集合プレゼンス (2026-05-19以降)
// - 1部屋固定: main
// - WebRTC/議事録/録画/AI要約 は廃止 (Zoom側でやる)
// - サーバの責務は「誰が入室中か」のpresence配信のみ
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const ROOMS = [
  { id: 'main', name: '会議室', icon: '🎙' },
];

router.get('/meta', authUser, (req, res) => {
  res.json({ success: true, rooms: ROOMS, zoomUrl: process.env.ZOOM_MEETING_URL || '' });
});

router.get('/rooms/status', authUser, (req, res) => {
  const io = req.app && req.app.locals && req.app.locals.io;
  const db = getDb();
  const out = ROOMS.map(r => {
    let count = 0;
    const uids = [];
    if (io) {
      const room = io.sockets.adapter.rooms.get('mt:' + r.id);
      if (room) {
        count = room.size;
        for (const sid of room) {
          const s = io.sockets.sockets.get(sid);
          if (s && s.uid && !uids.includes(s.uid)) uids.push(s.uid);
        }
      }
    }
    let participants = [];
    if (uids.length) {
      const ph = uids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id, display_name, avatar_url, company_code FROM users WHERE id IN (${ph})`).all(...uids);
      participants = rows.map(u => ({
        uid: u.id,
        display_name: u.display_name || '',
        avatar_url: u.avatar_url || '',
        company_code: u.company_code || '',
      }));
    }
    return { ...r, count, participants };
  });
  res.json({ success: true, rooms: out, zoomUrl: process.env.ZOOM_MEETING_URL || '' });
});

module.exports = router;
