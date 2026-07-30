const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { userMatchesTarget } = require('./announcements');

// 共有タブレットのログイン画面用: 名簿の各人に「未読があるか」だけを返す (2026-07-30)
// 背景: 共有タブレットは現場が最初に触る画面なので、ここで気づけると効く(社長案)。
// ⚠️ 認証なしで共有画面から呼ばれる。共有画面は周囲の全員に見えるため、
//    B案(社長判断)=**種類の有無だけ**。件数・送信者・本文は一切返さない。
//    a = 通達の未読あり / d = DMの未読あり
router.get('/roster-unread', (req, res) => {
  try {
    const db = getDb();
    const co = (req.query.co || '').toString().trim();
    const users = db.prepare(`
      SELECT id FROM users
       WHERE role != 'bot' AND is_guest_reviewer = 0 AND status = 'active'
         ${co ? 'AND company_code = ?' : ''}
    `).all(...(co ? [co] : []));
    if (!users.length) return res.json({ success: true, unread: {} });
    const ids = users.map(u => u.id);
    const out = {};

    // --- 通達: 有効な通達 × 対象判定 × 既読/確認 ---
    const anns = db.prepare(`
      SELECT id, target, requires_ack FROM announcements
       WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at >= datetime('now'))
    `).all();
    if (anns.length) {
      const readOf = db.prepare('SELECT read_at, acked_at FROM announcement_reads WHERE announcement_id = ? AND user_id = ?');
      for (const uid of ids) {
        for (const a of anns) {
          if (!userMatchesTarget(uid, a.target)) continue;
          const r = readOf.get(a.id, uid);
          const unread = !r || !r.read_at;
          const needsAck = a.requires_ack && (!r || !r.acked_at);
          if (unread || needsAck) { (out[uid] = out[uid] || {}).a = 1; break; }
        }
      }
    }

    // --- DM: bot名義は本人に見えないので除外 (chat.js と同じ基準) ---
    const ph = ids.map(() => '?').join(',');
    const dmRows = db.prepare(`
      SELECT DISTINCT m.receiver_id AS uid FROM messages m
       WHERE m.room_code = 'dm' AND m.receiver_id IN (${ph})
         AND m.sender_id <> m.receiver_id AND m.sender_id NOT LIKE 'bot_%'
         AND m.created_at > datetime('now','-60 days')
         AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = m.receiver_id)
    `).all(...ids);
    for (const r of dmRows) (out[r.uid] = out[r.uid] || {}).d = 1;

    res.json({ success: true, unread: out });
  } catch (e) {
    console.warn('[roster-unread]', e && e.message);
    res.json({ success: false, unread: {} });
  }
});

module.exports = router;
