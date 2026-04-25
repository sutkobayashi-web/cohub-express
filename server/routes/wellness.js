const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const PROMOTER_GROUP_ID = 'g_field_voice';
const WELLNESS_DISC_ID = 'g_wellness_disc';
const LOBBY_ANNOUNCE_ROOM = 'lobby';  // 全社アナウンスはロビーフロアの公開チャットへ

const CATEGORIES = ['体調', '食事', '睡眠', '職場環境', 'その他'];
const URGENCIES = ['低', '中', '高'];
const IDENTITY_MODES = ['本人特定可', '匿名', '集計のみ'];
const ACTION_STATUSES = ['候補', '承認待ち', '承認済', '実行中', '完了', '却下'];

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
    disc_group_id: WELLNESS_DISC_ID,
    categories: CATEGORIES,
    urgencies: URGENCIES,
    identity_modes: IDENTITY_MODES,
    action_statuses: ACTION_STATUSES,
  });
});

// =============================================================
// 月次施策ボード (Wellness Actions)
// =============================================================

function isAdmin(req) {
  return req.user && req.user.role === 'admin';
}
function canManageActions(req) {
  return isAdmin(req) || isFieldPromoter(req.uid);
}

// GET /api/wellness/actions  施策一覧 (推進メンバー or admin)
router.get('/actions', authUser, (req, res) => {
  if (!canManageActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const status = req.query.status;
  const limit = Math.min(parseInt(req.query.limit) || 100, 300);
  const db = getDb();
  let sql = `SELECT a.*, u.display_name as owner_name, c.display_name as creator_name, ap.display_name as approver_name
             FROM wellness_actions a
             LEFT JOIN users u ON u.id = a.owner_id
             LEFT JOIN users c ON c.id = a.created_by
             LEFT JOIN users ap ON ap.id = a.approved_by`;
  const params = [];
  if (status && ACTION_STATUSES.includes(status)) {
    sql += ' WHERE a.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY a.id DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  res.json({ success: true, actions: rows });
});

// POST /api/wellness/actions  新規施策作成 (推進メンバー or admin)
router.post('/actions', authUser, express.json(), (req, res) => {
  if (!canManageActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ success: false, msg: 'タイトル必須' });
  const status = ACTION_STATUSES.includes(b.status) ? b.status : '候補';
  const ins = getDb().prepare(`INSERT INTO wellness_actions
    (title, description, category, source_post_ids, source_summary, status, owner_id, budget_jpy, target_date, created_by, is_ai_suggested)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    title,
    String(b.description || '').slice(0, 2000),
    CATEGORIES.includes(b.category) ? b.category : null,
    b.source_post_ids ? JSON.stringify(b.source_post_ids) : null,
    String(b.source_summary || '').slice(0, 1000),
    status,
    b.owner_id || null,
    parseInt(b.budget_jpy) || 0,
    String(b.target_date || '').slice(0, 20) || null,
    req.uid,
    b.is_ai_suggested ? 1 : 0,
  );
  res.json({ success: true, id: ins.lastInsertRowid });
});

// PUT /api/wellness/actions/:id  更新 (オーナー指定/期日/予算/ステータスなど)
router.put('/actions/:id', authUser, express.json(), (req, res) => {
  if (!canManageActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, msg: 'ID不正' });
  const db = getDb();
  const cur = db.prepare('SELECT * FROM wellness_actions WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ success: false, msg: '見つかりません' });
  const b = req.body || {};
  const fields = [];
  const params = [];
  const setIfDef = (key, val) => { if (val !== undefined) { fields.push(`${key} = ?`); params.push(val); } };
  if (b.title !== undefined) setIfDef('title', String(b.title || '').slice(0, 200));
  if (b.description !== undefined) setIfDef('description', String(b.description || '').slice(0, 2000));
  if (b.category !== undefined) setIfDef('category', CATEGORIES.includes(b.category) ? b.category : null);
  if (b.owner_id !== undefined) setIfDef('owner_id', b.owner_id || null);
  if (b.budget_jpy !== undefined) setIfDef('budget_jpy', parseInt(b.budget_jpy) || 0);
  if (b.target_date !== undefined) setIfDef('target_date', String(b.target_date || '').slice(0, 20) || null);
  if (b.announce_message !== undefined) setIfDef('announce_message', String(b.announce_message || '').slice(0, 1000));
  if (b.status !== undefined && ACTION_STATUSES.includes(b.status)) setIfDef('status', b.status);
  if (!fields.length) return res.json({ success: true, msg: '変更なし' });
  params.push(id);
  db.prepare(`UPDATE wellness_actions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// POST /api/wellness/actions/:id/approve  admin 承認
router.post('/actions/:id/approve', authUser, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const cur = db.prepare('SELECT * FROM wellness_actions WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (cur.status === '完了' || cur.status === '却下') {
    return res.status(400).json({ success: false, msg: 'この状態からは承認できません' });
  }
  db.prepare(`UPDATE wellness_actions SET status='承認済', approved_by=?, approved_at=datetime('now') WHERE id=?`)
    .run(req.uid, id);
  res.json({ success: true });
});

// POST /api/wellness/actions/:id/reject  却下
router.post('/actions/:id/reject', authUser, express.json(), (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
  const id = parseInt(req.params.id);
  const reason = String((req.body && req.body.reason) || '').slice(0, 500);
  const db = getDb();
  const cur = db.prepare('SELECT * FROM wellness_actions WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ success: false, msg: '見つかりません' });
  db.prepare("UPDATE wellness_actions SET status='却下', rejection_reason=?, approved_by=?, approved_at=datetime('now') WHERE id=?")
    .run(reason, req.uid, id);
  res.json({ success: true });
});

// POST /api/wellness/actions/:id/start  実行中マーク
router.post('/actions/:id/start', authUser, (req, res) => {
  if (!canManageActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const cur = db.prepare('SELECT * FROM wellness_actions WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (cur.status !== '承認済') return res.status(400).json({ success: false, msg: '承認済からのみ実行開始可能' });
  db.prepare("UPDATE wellness_actions SET status='実行中' WHERE id=?").run(id);
  res.json({ success: true });
});

// POST /api/wellness/actions/:id/complete  完了マーク + 全社アナウンス + 運管DM
router.post('/actions/:id/complete', authUser, express.json(), (req, res) => {
  if (!canManageActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const cur = db.prepare('SELECT * FROM wellness_actions WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (cur.status !== '実行中' && cur.status !== '承認済') {
    return res.status(400).json({ success: false, msg: '実行中/承認済からのみ完了マーク可能' });
  }
  const announceMsg = String((req.body && req.body.announce_message) || cur.announce_message || '').slice(0, 1000);
  db.prepare("UPDATE wellness_actions SET status='完了', completed_at=datetime('now'), announce_message=? WHERE id=?")
    .run(announceMsg, id);

  // 全社アナウンス: ロビーフロア公開チャットに自動投稿
  const bot = db.prepare("SELECT id FROM users WHERE login_id = 'admin' OR role = 'admin' ORDER BY role='admin' DESC LIMIT 1").get();
  const announceContent = announceMsg
    || `🏥 健康管理室より\n${cur.title}\n${cur.description || ''}\n（現場の声 #${(JSON.parse(cur.source_post_ids || '[]') || []).join(', #') || '-'} → 形にしました）`;
  if (bot) {
    db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, NULL, ?, ?)")
      .run(bot.id, announceContent, LOBBY_ANNOUNCE_ROOM);
    // 全フロア在席者に告知 (ロビー以外もアナウンスを見られるようlobby roomにいなくても通知する)
    const io = req.app && req.app.locals && req.app.locals.io;
    if (io) {
      io.to('floor:' + LOBBY_ANNOUNCE_ROOM).emit('chat:msg', {
        uid: bot.id, name: '健康管理室', content: announceContent, room: LOBBY_ANNOUNCE_ROOM, at: new Date().toISOString()
      });
    }
  }

  // 運管DMフィードバック: source_post_ids に紐づく投稿者へ
  try {
    const postIds = JSON.parse(cur.source_post_ids || '[]');
    if (Array.isArray(postIds) && postIds.length) {
      const placeholders = postIds.map(() => '?').join(',');
      const posters = db.prepare(`SELECT DISTINCT poster_id FROM wellness_posts WHERE id IN (${placeholders})`).all(...postIds);
      const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
      const io = req.app && req.app.locals && req.app.locals.io;
      const fbContent = `🏥 ご報告: あなたが共有してくださった現場の声 (#${postIds.join(', #')}) を健康管理室で議論し、施策として実行しました。\n\n【実行内容】\n${cur.title}\n${cur.description || ''}\n\n継続的な気付きの共有、ありがとうございます。`;
      const emitToUser = req.app && req.app.locals && req.app.locals.emitToUser;
      for (const p of posters) {
        if (!p.poster_id) continue;
        const adminId = bot && bot.id;
        if (adminId) {
          const msgIns = db.prepare("INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)")
            .run(adminId, p.poster_id, fbContent);
          // 在席なら即DM配信
          if (emitToUser) {
            emitToUser(p.poster_id, 'dm:msg', {
              id: msgIns.lastInsertRowid,
              from: adminId,
              to: p.poster_id,
              content: fbContent,
              at: new Date().toISOString(),
              attach: null,
            });
          }
        }
        if (sendPush) {
          sendPush(p.poster_id, {
            title: '🏥 あなたの声が形になりました',
            body: cur.title.slice(0, 100),
            tag: 'wa-' + id,
            url: '/',
          }).catch(() => {});
        }
      }
    }
  } catch (e) { console.warn('feedback DM fail', e.message); }

  res.json({ success: true });
});

// =============================================================
// AI 集計 (運管POST + ディスカッションGC を Gemini に食わせて要約)
// =============================================================
const { generateText } = require('../services/ai');

router.post('/insights', authUser, express.json(), async (req, res) => {
  if (!canManageActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const days = Math.min(parseInt((req.body && req.body.days) || 30), 90);
  const db = getDb();
  const sinceISO = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  // 運管POST取得
  const posts = db.prepare(`
    SELECT wp.id, wp.category, wp.urgency, wp.identity_mode, wp.memo, wp.company_code, wp.created_at,
           u.display_name as poster_name
    FROM wellness_posts wp LEFT JOIN users u ON u.id = wp.poster_id
    WHERE wp.created_at >= ? ORDER BY wp.id ASC
  `).all(sinceISO);

  // 健康管理室ディスカッションGC のメッセージ取得
  const discMsgs = db.prepare(`
    SELECT m.id, m.content, m.created_at, u.display_name as sender_name
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_code = ? AND m.created_at >= ?
    ORDER BY m.id ASC LIMIT 200
  `).all('grp_' + WELLNESS_DISC_ID, sinceISO);

  if (!posts.length && !discMsgs.length) {
    return res.json({ success: true, insights: null, msg: 'データが不足しています' });
  }

  // プロンプト構成 — 簡潔・断定回避・施策候補3案まで
  const postLines = posts.map(p =>
    `[#${p.id}|${p.category}|緊急度${p.urgency}|${p.company_code || '-'}|${p.created_at}|by ${p.poster_name || '不明'}|${p.identity_mode}] ${p.memo || '(メモなし)'}`
  ).join('\n');
  const discLines = discMsgs.map(m =>
    `[${m.created_at}|${m.sender_name || '不明'}] ${(m.content || '').slice(0, 200)}`
  ).join('\n');

  const prompt = `あなたは中小運送業の健康管理室の補助役です。以下の2系統のテキストを分析し、健康管理室会議で議論する材料として整理してください。

【系統A: 運行管理者からの "現場の声" POST】
${postLines || '(なし)'}

【系統B: 健康管理室ディスカッション(事務側議論)】
${discLines || '(なし)'}

以下の形式の純粋なJSONで回答してください (Markdownや前置きは不要):
{
  "summary": "全体の特徴を3〜5行で",
  "themes": [
    {"name": "テーマ名", "post_ids": [整数配列], "count": 件数, "urgency_max": "高|中|低", "note": "1〜2行の所見"}
  ],
  "company_distribution": [{"company": "コード", "count": 件数}],
  "actions": [
    {"title": "施策タイトル(20字)", "description": "実施内容(80字)", "source_post_ids": [整数配列], "category": "体調|食事|睡眠|職場環境|その他", "rationale": "なぜこれが効くか(40字)"}
  ]
}
注意点:
- actions は最大3案、現実的に1〜2週間で動かせる小さな施策に絞る
- 個人を特定しない (匿名/集計のみのPOSTは個人名を出さない)
- 緊急度高のテーマがあれば actions の優先順位を上げる
- データが薄い場合は無理に作らず空配列で良い`;

  try {
    const aiText = await generateText(prompt, { maxTokens: 2000 });
    let parsed = null;
    try {
      // ```json ... ``` ブロックを除去して試す
      const cleaned = String(aiText || '').replace(/^```json\s*|```\s*$/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.json({ success: false, msg: 'AI出力解析失敗', raw: aiText });
    }
    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      window_days: days,
      counts: { posts: posts.length, disc_msgs: discMsgs.length },
      insights: parsed,
    });
  } catch (e) {
    res.status(500).json({ success: false, msg: 'AI呼び出し失敗: ' + e.message });
  }
});

module.exports = router;
