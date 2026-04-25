const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const PROMOTER_GROUP_ID = 'g_field_voice';

const CATEGORIES = ['体調', '食事', '睡眠', '職場環境', 'その他'];
const URGENCIES = ['低', '中', '高'];
const IDENTITY_MODES = ['本人特定可', '匿名', '集計のみ'];

// 推進メンバー判定
function isFieldPromoter(uid) {
  const r = getDb().prepare('SELECT is_field_promoter FROM users WHERE id = ?').get(uid);
  return !!(r && r.is_field_promoter);
}

// POST /api/wellness/post  現場の声を1件登録 + 推進メンバーグループに自動配信
router.post('/post', authUser, express.json(), (req, res) => {
  if (!isFieldPromoter(req.uid)) {
    return res.status(403).json({ success: false, msg: '推進メンバー権限がありません' });
  }
  const body = req.body || {};
  const category = String(body.category || '').trim();
  const urgency = String(body.urgency || '').trim();
  const identityMode = String(body.identity_mode || '').trim();
  const memo = String(body.memo || '').slice(0, 200).trim();
  if (!CATEGORIES.includes(category)) return res.status(400).json({ success: false, msg: 'カテゴリ不正' });
  if (!URGENCIES.includes(urgency)) return res.status(400).json({ success: false, msg: '緊急度不正' });
  if (!IDENTITY_MODES.includes(identityMode)) return res.status(400).json({ success: false, msg: '特定区分不正' });

  const db = getDb();
  const poster = db.prepare('SELECT id, display_name, company_code FROM users WHERE id = ?').get(req.uid);
  const ins = db.prepare(`INSERT INTO wellness_posts (poster_id, company_code, category, urgency, identity_mode, memo)
    VALUES (?, ?, ?, ?, ?, ?)`).run(poster.id, poster.company_code || '', category, urgency, identityMode, memo);
  const postId = ins.lastInsertRowid;

  // チャット表示用にフォーマット
  const urgencyMark = urgency === '高' ? '🔴' : urgency === '中' ? '🟡' : '🟢';
  const lines = [
    `📝 #${postId} 【${category}】 ${urgencyMark}${urgency}`,
    `営業所: ${poster.company_code || '-'}　/　特定区分: ${identityMode}`,
  ];
  if (memo) lines.push('─', memo);
  const content = lines.join('\n');
  const roomCode = 'grp_' + PROMOTER_GROUP_ID;
  const msgIns = db.prepare(`INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, NULL, ?, ?)`)
    .run(poster.id, content, roomCode);

  const payload = {
    id: msgIns.lastInsertRowid,
    from: poster.id,
    group_id: PROMOTER_GROUP_ID,
    content,
    at: new Date().toISOString(),
    attach: null,
  };
  // メンバーへ即配信 + Push通知
  if (req.app && req.app.locals && req.app.locals.emitToGroupMembers) {
    req.app.locals.emitToGroupMembers(PROMOTER_GROUP_ID, 'group:msg', payload);
  }
  // 推進メンバー以外の管理者にもPush (オフライン時)
  try {
    const members = db.prepare('SELECT user_id FROM chat_group_members WHERE group_id = ?').all(PROMOTER_GROUP_ID);
    const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (sendPush) {
      for (const m of members) {
        if (m.user_id === poster.id) continue;
        sendPush(m.user_id, {
          title: `🩺 現場の声 [${category}]`,
          body: (memo || `${poster.company_code} ${urgencyMark}${urgency}`).slice(0, 120),
          tag: 'fieldvoice-' + postId,
          url: '/?g=' + PROMOTER_GROUP_ID,
        }).catch(() => {});
      }
    }
  } catch (e) {}

  res.json({ success: true, post_id: postId, group_id: PROMOTER_GROUP_ID });
});

// GET /api/wellness/posts  推進メンバー専用の最近の投稿一覧 (管理画面/レビュー用)
router.get('/posts', authUser, (req, res) => {
  if (!isFieldPromoter(req.uid) && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, msg: '権限なし' });
  }
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows = getDb().prepare(`
    SELECT wp.id, wp.category, wp.urgency, wp.identity_mode, wp.memo, wp.company_code,
           wp.created_at, u.display_name as poster_name
    FROM wellness_posts wp
    LEFT JOIN users u ON u.id = wp.poster_id
    ORDER BY wp.id DESC LIMIT ?
  `).all(limit);
  res.json({ success: true, posts: rows });
});

// メタ情報 (フォーム選択肢)
router.get('/meta', authUser, (req, res) => {
  res.json({
    is_field_promoter: isFieldPromoter(req.uid),
    group_id: PROMOTER_GROUP_ID,
    categories: CATEGORIES,
    urgencies: URGENCIES,
    identity_modes: IDENTITY_MODES,
  });
});

module.exports = router;
