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

// 管理職 (employee_type='admin') 判定 — システムadmin (role='admin') とは別物
function isWellnessManager(uid) {
  const r = getDb().prepare('SELECT employee_type FROM users WHERE id = ?').get(uid);
  return !!(r && r.employee_type === 'admin');
}

// ゲストレビュアー (大学/NPO等の外部専門家) — 施策ボードのレビュー権限
function isGuestReviewer(uid) {
  const r = getDb().prepare('SELECT is_guest_reviewer FROM users WHERE id = ?').get(uid);
  return !!(r && r.is_guest_reviewer);
}

// 健康管理室ページの閲覧権限: 管理職 or 推進メンバー or ゲストレビュアー
// (一般のシステム管理者は除外 — ドライバーの体調/睡眠/食事POSTを見せない方針)
function canAccessWellness(uid) {
  return isWellnessManager(uid) || isFieldPromoter(uid) || isGuestReviewer(uid);
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

// GET /api/wellness/posts  健康管理室メンバーのみ閲覧可
router.get('/posts', authUser, (req, res) => {
  if (!canAccessWellness(req.uid)) {
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

// メタ情報 (フォーム選択肢 + 権限フラグ)
router.get('/meta', authUser, (req, res) => {
  const wm = isWellnessManager(req.uid);
  const fp = isFieldPromoter(req.uid);
  const gr = isGuestReviewer(req.uid);
  res.json({
    is_field_promoter: fp,
    is_wellness_manager: wm,
    is_guest_reviewer: gr,             // 大学/NPO等の外部レビュアー
    can_access_wellness: wm || fp || gr,
    can_approve_actions: wm,           // 承認/却下は管理職のみ (ゲストはレビューコメントのみ)
    can_edit_actions: wm || fp,        // 起票/編集は管理職+推進メンバー (ゲストは閲覧のみ)
    group_id: PROMOTER_GROUP_ID,
    disc_group_id: WELLNESS_DISC_ID,
    categories: CATEGORIES,
    urgencies: URGENCIES,
    identity_modes: IDENTITY_MODES,
    action_statuses: ACTION_STATUSES,
  });
});

// GET /api/wellness/owners  施策担当に指名できるメンバー一覧 (=管理職 + 推進メンバー + admin)
router.get('/owners', authUser, (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const rows = getDb().prepare(`
    SELECT id, display_name, company_code FROM users
    WHERE employee_type = 'admin' OR is_field_promoter = 1 OR role = 'admin'
    ORDER BY display_name
  `).all();
  res.json({ success: true, users: rows });
});

// =============================================================
// 月次施策ボード (Wellness Actions)
// =============================================================

// 施策ボード閲覧: 管理職 or 推進メンバー or ゲストレビュアー
function canManageActions(req) {
  return canAccessWellness(req.uid);
}
// 起票/編集: 管理職+推進メンバー (ゲストは閲覧のみ)
function canEditActions(req) {
  return isWellnessManager(req.uid) || isFieldPromoter(req.uid);
}
// 承認/却下: 管理職のみ
function canApprove(req) {
  return isWellnessManager(req.uid);
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

// POST /api/wellness/actions  新規施策作成 (管理職+推進メンバーのみ。ゲストは閲覧のみ)
router.post('/actions', authUser, express.json(), (req, res) => {
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '起票権限なし (ゲストは閲覧のみ)' });
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
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '編集権限なし (ゲストは閲覧のみ)' });
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

// POST /api/wellness/actions/:id/approve  管理職のみ承認
router.post('/actions/:id/approve', authUser, (req, res) => {
  if (!canApprove(req)) return res.status(403).json({ success: false, msg: '管理職権限が必要です' });
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

// POST /api/wellness/actions/:id/reject  却下 (管理職のみ)
router.post('/actions/:id/reject', authUser, express.json(), (req, res) => {
  if (!canApprove(req)) return res.status(403).json({ success: false, msg: '管理職権限が必要です' });
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
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
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
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
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
    // Gemini 2.5 は thinking にもトークン消費するため余裕を持たせる
    const aiText = await generateText(prompt, { maxTokens: 4000, responseMimeType: 'application/json' });
    console.log('[insights] raw:', String(aiText || '').slice(0, 300));
    let parsed = null;
    let cleaned = String(aiText || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) cleaned = m[0];
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      // 切詰時のフォールバック: 開きカッコ過多なら閉じる
      let fixed = cleaned;
      const opens = (fixed.match(/\{/g) || []).length;
      const closes = (fixed.match(/\}/g) || []).length;
      const obs = (fixed.match(/\[/g) || []).length;
      const cbs = (fixed.match(/\]/g) || []).length;
      if (obs > cbs) fixed += ']'.repeat(obs - cbs);
      if (opens > closes) fixed += '}'.repeat(opens - closes);
      try { parsed = JSON.parse(fixed); }
      catch (e2) {
        console.warn('[insights] parse fail:', cleaned.slice(0, 300));
        return res.json({ success: false, msg: 'AI出力解析失敗 (出力切詰の可能性)', raw: cleaned.slice(0, 500) });
      }
    }
    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      window_days: days,
      counts: { posts: posts.length, disc_msgs: discMsgs.length },
      insights: parsed,
    });
  } catch (e) {
    console.warn('[insights] error:', e.message);
    res.status(500).json({ success: false, msg: 'AI呼び出し失敗: ' + e.message });
  }
});

// ============================================================
// 現場の声: 共感 + 議論スレッド (推進メンバー間の議論用)
// ============================================================
const POST_EMOJIS = ['🙏', '💪', '😢', '⚠'];  // 共感/応援/共有痛み/要注意

router.post('/posts/:id/react', authUser, express.json(), (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const emoji = String((req.body && req.body.emoji) || '');
  if (!POST_EMOJIS.includes(emoji)) return res.status(400).json({ success: false, msg: '不正' });
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM wellness_post_reactions WHERE post_id=? AND user_id=? AND emoji=?').get(id, req.uid, emoji);
  if (exists) {
    db.prepare('DELETE FROM wellness_post_reactions WHERE post_id=? AND user_id=? AND emoji=?').run(id, req.uid, emoji);
    res.json({ success: true, added: false });
  } else {
    db.prepare('INSERT INTO wellness_post_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)').run(id, req.uid, emoji);
    res.json({ success: true, added: true });
  }
});

router.get('/posts/:id/reactions', authUser, (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const rows = getDb().prepare('SELECT emoji, user_id FROM wellness_post_reactions WHERE post_id = ?').all(parseInt(req.params.id));
  const counts = {}; const mine = {};
  for (const e of POST_EMOJIS) { counts[e] = 0; mine[e] = false; }
  for (const r of rows) {
    counts[r.emoji] = (counts[r.emoji] || 0) + 1;
    if (r.user_id === req.uid) mine[r.emoji] = true;
  }
  res.json({ success: true, counts, my: mine });
});

router.get('/posts/:id/discussions', authUser, (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const rows = getDb().prepare(`SELECT d.*, u.display_name AS author_name, u.avatar_url AS author_avatar
    FROM wellness_post_discussions d LEFT JOIN users u ON u.id = d.author_id
    WHERE d.post_id = ? AND d.deleted_at IS NULL ORDER BY d.id ASC LIMIT 200`).all(parseInt(req.params.id));
  res.json({ success: true, discussions: rows });
});

router.post('/posts/:id/discussions', authUser, express.json(), (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const content = String((req.body && req.body.content) || '').slice(0, 1000).trim();
  if (!content) return res.status(400).json({ success: false, msg: '本文必須' });
  const ins = getDb().prepare('INSERT INTO wellness_post_discussions (post_id, author_id, content) VALUES (?, ?, ?)').run(id, req.uid, content);
  const c = getDb().prepare(`SELECT d.*, u.display_name AS author_name, u.avatar_url AS author_avatar
    FROM wellness_post_discussions d LEFT JOIN users u ON u.id = d.author_id WHERE d.id = ?`).get(ins.lastInsertRowid);
  res.json({ success: true, discussion: c });
});

router.delete('/posts/discussions/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const d = db.prepare('SELECT author_id FROM wellness_post_discussions WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!d) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (d.author_id !== req.uid && !isWellnessManager(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  db.prepare("UPDATE wellness_post_discussions SET deleted_at = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
});

// ============================================================
// 施策ボード: 議論スレッド + AI評議会 (5専門家)
// ============================================================
router.get('/actions/:id/discussions', authUser, (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const rows = getDb().prepare(`SELECT d.*, u.display_name AS author_name, u.avatar_url AS author_avatar
    FROM wellness_action_discussions d LEFT JOIN users u ON u.id = d.author_id
    WHERE d.action_id = ? AND d.deleted_at IS NULL ORDER BY d.id ASC LIMIT 200`).all(parseInt(req.params.id));
  res.json({ success: true, discussions: rows });
});

router.post('/actions/:id/discussions', authUser, express.json(), (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const content = String((req.body && req.body.content) || '').slice(0, 1000).trim();
  if (!content) return res.status(400).json({ success: false, msg: '本文必須' });
  const ins = getDb().prepare('INSERT INTO wellness_action_discussions (action_id, author_id, content) VALUES (?, ?, ?)').run(id, req.uid, content);
  const c = getDb().prepare(`SELECT d.*, u.display_name AS author_name, u.avatar_url AS author_avatar
    FROM wellness_action_discussions d LEFT JOIN users u ON u.id = d.author_id WHERE d.id = ?`).get(ins.lastInsertRowid);
  res.json({ success: true, discussion: c });
});

// AI評議会 (5専門家 + 11人プールから多様な社員シミュレーション)
router.post('/actions/:id/ai-council', authUser, async (req, res) => {
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT * FROM wellness_actions WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });

  // 議論文脈も含める
  const discussions = db.prepare(`SELECT d.content, u.display_name AS name FROM wellness_action_discussions d
    LEFT JOIN users u ON u.id = d.author_id WHERE d.action_id = ? AND d.deleted_at IS NULL ORDER BY d.id`).all(id);
  const discText = discussions.length ? discussions.map(d => `${d.name||'匿名'}: ${d.content}`).join('\n') : '(議論なし)';

  const prompt = `あなたは中小運送会社の健康推進施策を評価する「AI評議会」です。
2層構造で評価してください: ①専門家5名による評議 + ②社内多様な人材11人プールから選抜された4〜5名のリアル反応。

【①専門家評議 (固定5名)】
1. AIメディカルアドバイザー(🩺) — 医学的妥当性、エビデンス
2. AIヘルスアドバイザー(💉) — 産業保健、労働安全衛生
3. AI食事アドバイザー(🥗) — 栄養学、食習慣改善
4. AI経営アドバイザー(📊) — コスト対効果、経営インパクト
5. AI現場アドバイザー(🚛) — ドライバー実態、現場実現可能性

【②社内多様人材プール (11名から関連性の高い4〜5名を自動選抜)】
- 田中さん (🚛 ベテランドライバー60歳/慢性腰痛/家族思い) — 賛成寄り、経験談
- 佐藤さん (🚚 中堅ドライバー42歳/2児の父/長時間運転常習) — 慎重派、シフト懸念
- 鈴木さん (🆕 新人ドライバー24歳/独身) — 中立、「教えてもらえたら」型
- 山田さん (👨‍💼 配車担当35歳/現場調整役) — 「シフトに無理出ないか」現実派
- 木村さん (👩‍💻 経理40歳) — コスト目線で慎重、「予算根拠は」
- 高橋さん (👔 営業所長48歳/中間管理職) — 「現場負担と効果のバランス」
- 中村さん (📊 部長55歳/経営寄り) — 効果測定にこだわる、批判的目線
- 伊藤さん (🌱 健康熱心34歳/趣味ランニング) — 「もっと積極的に」前のめり
- 渡辺さん (😴 健康無関心50歳/帰宅後ビール) — 「面倒くさい」否定的
- 斎藤さん (👨‍👩‍👧 家族持ちドライバー38歳) — 「家族のためにも」温かい支持
- 加藤さん (🧓 高齢ドライバー63歳/再雇用) — 「無理せず続けたい」マイペース

【施策案】
タイトル: ${a.title}
詳細: ${a.description || '(なし)'}
予算: ¥${a.budget_jpy || 0}　期日: ${a.target_date || '未定'}
カテゴリ: ${a.category || '-'}

【推進メンバーの議論】
${discText}

【発言ルール】
- 各人 80〜120字、具体的・人間味のある発言で
- 専門家は結論明示 (賛成/条件付き/要検討)
- 多様人材は「自分の生活実態に照らした感想」中心、賛否のバランスを必ず取る (賛成だけ/反対だけにならない)
- ドライバー実態 (長時間運転・コンビニ食・不規則生活・家族のための稼ぎ) を踏まえる

純粋なJSON配列のみで回答 (前置き禁止):
[
  {"role":"AIメディカルアドバイザー","avatar":"🩺","kind":"expert","message":"..."},
  {"role":"AIヘルスアドバイザー","avatar":"💉","kind":"expert","message":"..."},
  {"role":"AI食事アドバイザー","avatar":"🥗","kind":"expert","message":"..."},
  {"role":"AI経営アドバイザー","avatar":"📊","kind":"expert","message":"..."},
  {"role":"AI現場アドバイザー","avatar":"🚛","kind":"expert","message":"..."},
  {"role":"○○さん (役職/年代)","avatar":"絵文字","kind":"voice","message":"..."}
]`;

  try {
    const aiText = await generateText(prompt, { maxTokens: 4000, responseMimeType: 'application/json' });
    let cleaned = String(aiText || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (m) cleaned = m[0];
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      let fixed = cleaned;
      const opens = (fixed.match(/\{/g) || []).length;
      const closes = (fixed.match(/\}/g) || []).length;
      const obs = (fixed.match(/\[/g) || []).length;
      const cbs = (fixed.match(/\]/g) || []).length;
      if (opens > closes) fixed += '"}'.slice(0,1).repeat(0) + '}'.repeat(opens - closes);
      if (obs > cbs) fixed += ']'.repeat(obs - cbs);
      try { parsed = JSON.parse(fixed); }
      catch (e2) { return res.status(500).json({ success: false, msg: 'AI解析失敗', raw: cleaned.slice(0, 300) }); }
    }
    if (!Array.isArray(parsed)) return res.status(500).json({ success: false, msg: 'AI応答が配列でない' });

    // 既存の評議会記録は削除して新規 (再実行可)
    db.prepare('DELETE FROM wellness_action_council WHERE action_id = ?').run(id);
    const ins = db.prepare('INSERT INTO wellness_action_council (action_id, role, avatar, message) VALUES (?, ?, ?, ?)');
    for (const c of parsed) {
      const kind = c.kind === 'voice' ? 'voice' : 'expert';
      const role = `[${kind}] ` + String(c.role || 'AI').slice(0, 80);
      const avatar = String(c.avatar || '🤖').slice(0, 8);
      const msg = String(c.message || '').slice(0, 800);
      if (msg) ins.run(id, role, avatar, msg);
    }
    res.json({ success: true, council: parsed });
  } catch (e) {
    res.status(500).json({ success: false, msg: 'AI失敗: ' + e.message });
  }
});

router.get('/actions/:id/ai-council', authUser, (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const rows = getDb().prepare('SELECT role, avatar, message, created_at FROM wellness_action_council WHERE action_id = ? ORDER BY id').all(parseInt(req.params.id));
  res.json({ success: true, council: rows });
});

module.exports = router;
