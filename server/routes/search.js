const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// CoHub 横断検索: メンバー / 自分が閲覧できるチャット / 掲示板 / ひろば
// プライバシー: チャットは「自分のDM」と「自分が所属するグループ」のみ対象 (他人のDMは出さない)
router.get('/', authUser, (req, res) => {
  try {
    const db = getDb();
    const uid = req.uid;
    const qraw = (req.query.q || '').toString().trim();
    if (qraw.length < 2) {
      return res.json({ success: true, q: qraw, results: { members: [], messages: [], board: [], plaza: [] } });
    }
    const q = qraw.slice(0, 100);
    // LIKE のワイルドカードをエスケープ
    const like = '%' + q.replace(/[%_\\]/g, '\\$&') + '%';
    const LIMIT = 15;

    // 1) メンバー
    // ⚠️プライバシー: ニックネームではヒットさせない＆ニックネームを返さない。
    //   (ニックネーム→実名の橋渡しを防ぐ。氏名・会社での検索のみ)
    const members = db.prepare(`
      SELECT id, display_name, company_code, avatar_url, role
      FROM users
      WHERE role != 'bot' AND status = 'active'
        AND (display_name LIKE ? ESCAPE '\\' OR company_code LIKE ? ESCAPE '\\')
      ORDER BY display_name LIMIT ?
    `).all(like, like, LIMIT);

    // 2) チャット (自分のDM + 所属グループのみ)
    const rawMsgs = db.prepare(`
      SELECT m.id, m.sender_id, m.receiver_id, m.content, m.room_code, m.created_at,
             su.display_name AS sender_name
      FROM messages m
      LEFT JOIN users su ON su.id = m.sender_id
      WHERE m.content LIKE ? ESCAPE '\\'
        AND (
          (m.room_code = 'dm' AND (m.sender_id = ? OR m.receiver_id = ?))
          OR (m.room_code LIKE 'grp_%' AND m.room_code IN
              (SELECT 'grp_' || group_id FROM chat_group_members WHERE user_id = ?))
        )
      ORDER BY m.created_at DESC LIMIT ?
    `).all(like, uid, uid, uid, LIMIT);

    const messages = rawMsgs.map(m => {
      let where = '', link = '';
      if (m.room_code === 'dm') {
        const peerId = m.sender_id === uid ? m.receiver_id : m.sender_id;
        const peer = db.prepare('SELECT display_name FROM users WHERE id = ?').get(peerId) || {};
        where = 'DM · ' + (peer.display_name || '');
        link = '/chat?dm=' + encodeURIComponent(peerId);
      } else {
        const gid = m.room_code.replace(/^grp_/, '');
        const g = db.prepare('SELECT name, icon FROM chat_groups WHERE id = ?').get(gid) || {};
        where = (g.icon || '💬') + ' ' + (g.name || 'グループ');
        link = '/chat?g=' + encodeURIComponent(gid);
      }
      return { id: m.id, content: m.content, sender_name: m.sender_name || '', at: m.created_at, where, link };
    });

    // 3) 掲示板
    const board = db.prepare(`
      SELECT b.id, b.content, b.created_at, u.display_name AS author_name
      FROM board_posts b LEFT JOIN users u ON u.id = b.author_id
      WHERE b.deleted_at IS NULL AND b.content LIKE ? ESCAPE '\\'
      ORDER BY b.created_at DESC LIMIT ?
    `).all(like, LIMIT);

    // 4) ひろば (匿名投稿は投稿者名を隠す。非匿名はニックネーム優先)
    const plazaRows = db.prepare(`
      SELECT p.id, p.content, p.category, p.created_at, p.is_anonymous,
             u.display_name AS author_name, u.nickname AS author_nick
      FROM plaza_posts p LEFT JOIN users u ON u.id = p.author_id
      WHERE p.deleted_at IS NULL AND p.content LIKE ? ESCAPE '\\'
      ORDER BY p.created_at DESC LIMIT ?
    `).all(like, LIMIT);
    // ⚠️プライバシー: ひろばは実名を出さない。非匿名でもニックネーム、無ければ匿名扱い
    const plaza = plazaRows.map(p => ({
      id: p.id, content: p.content, category: p.category, at: p.created_at,
      author_name: p.is_anonymous ? '匿名' : (p.author_nick || '匿名')
    }));

    res.json({ success: true, q, results: { members, messages, board, plaza } });
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({ success: false, msg: '検索エラー' });
  }
});

module.exports = router;
