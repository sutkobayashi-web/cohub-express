const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const PROMOTER_GROUP_ID = 'g_field_voice';
const WELLNESS_DISC_ID = 'g_wellness_disc';
const LOBBY_ANNOUNCE_ROOM = 'lobby';  // 全社アナウンスはロビーフロアの公開チャットへ

const CATEGORIES = ['体調', '食事', '睡眠', '職場環境', 'その他'];
// 倉庫POST向けカテゴリ (聞き取りカードの異常項目から自動付与)
const WAREHOUSE_CATEGORIES = ['体調', '腰・関節', '作業負荷', '設備・動線', '温度・環境', 'ヒヤリハット', 'その他'];
const URGENCIES = ['低', '中', '高'];
const IDENTITY_MODES = ['本人特定可', '匿名', '集計のみ'];

// 聞き取りカード選択肢 (統合版 2026-05-08): 職種を問わず使える共通8項目
// severity 0(正常)|1(中)|2(高) → 最大severityを urgency、最初の severity>0 項目の category を採用
// 聞き取り8項目 (2026-06: 投票で決定した5項目[Yes/No] + 従来の観察3項目)
const LISTENING_FIELDS = [
  // --- 会社として投票で決定した5項目 (Yes/No・セルフ点検) ---
  { key: 'hydration', label: '💧 こまめに水分補給', category: '食事', options: [
    { v: 'はい', s: 0 }, { v: 'いいえ', s: 0 },
  ]},
  { key: 'breakfast', label: '🍚 朝食を食べた', category: '食事', options: [
    { v: 'はい', s: 0 }, { v: 'いいえ', s: 0 },
  ]},
  { key: 'three_meals', label: '🍽️ 3食きちんと食べた', category: '食事', options: [
    { v: 'はい', s: 0 }, { v: 'いいえ', s: 0 },
  ]},
  { key: 'sleep6h', label: '🛌 6時間以上寝た', category: '睡眠', options: [
    { v: 'はい', s: 0 }, { v: 'いいえ', s: 0 },
  ]},
  { key: 'wakeup', label: '🌅 朝の目覚めスッキリ', category: '睡眠', options: [
    { v: 'はい', s: 0 }, { v: 'いいえ', s: 0 },
  ]},
  // --- 観察・リスク系 (従来から継続) ---
  { key: 'facial_color', label: '🌡️ 顔色', category: '体調', options: [
    { v: '普通', s: 0 }, { v: '疲れ気味', s: 1 }, { v: '赤い', s: 2 }, { v: '青白い', s: 2 }, { v: '不明', s: 0 },
  ]},
  { key: 'pain', label: '🦴 体の痛み', category: '体調', options: [
    { v: 'なし', s: 0 }, { v: '腰', s: 1 }, { v: '肩・首', s: 1 }, { v: '関節', s: 1 }, { v: '強い痛み', s: 2 },
  ]},
  { key: 'concern', label: '⚠️ 気になる', category: '職場環境', options: [
    { v: 'なし', s: 0 }, { v: '体調', s: 1 }, { v: '家族', s: 1 }, { v: '職場', s: 2 }, { v: 'お金', s: 1 }, { v: 'その他', s: 1 },
  ]},
];
const CARD_OPTIONS = {
  '聞き取り': { title: '聞き取りカード', fields: LISTENING_FIELDS },
  // 旧仕様の互換: 既存の運管/倉庫/製造リクエストが来ても新カードで応答
  '運管': { title: '聞き取りカード', fields: LISTENING_FIELDS },
  '倉庫': { title: '聞き取りカード', fields: LISTENING_FIELDS },
  '製造': { title: '聞き取りカード', fields: LISTENING_FIELDS },
};

// カード回答から urgency/category を自動推定
function deriveCardSummary(sourceType, answers) {
  const conf = CARD_OPTIONS[sourceType];
  if (!conf) return { urgency: '低', category: 'その他' };
  let maxSeverity = 0;
  let category = null;
  const fields = conf.fields;
  for (const f of fields) {
    const v = answers && answers[f.key];
    if (!v) continue;
    const opt = f.options.find(o => o.v === v);
    if (!opt) continue;
    if (opt.s > maxSeverity) {
      maxSeverity = opt.s;
      category = f.category;
    } else if (opt.s > 0 && category === null) {
      category = f.category;
    }
  }
  const urgency = maxSeverity >= 2 ? '高' : maxSeverity >= 1 ? '中' : '低';
  if (!category) category = sourceType === '倉庫' ? '体調' : '体調';
  return { urgency, category };
}
// 投稿元区分 (B案): 推進メンバー内の役割区別
// - 運管: 配車・点呼担当 (ドライバー対応の最前線) ※画面表示は「点呼」
// - 倉庫: 倉庫管理者 (荷役・庫内作業者対応)
// - 製造: 製造現場の責任者 (2026-08-03 追加。それまで製造スタッフの声は倉庫に入っていた)
// - 総務: 総務・人事 (オフィス職員対応、産業医連絡担当)
// - 帰庫: 帰り(退勤前)のチェックからの自動エスカレーション ※画面表示は「帰り」
// - その他: 上記以外 (店舗担当、特殊業務等)
const SOURCE_TYPES = ['運管', '倉庫', '製造', '総務', '帰庫', '聞き取り', 'その他'];
// v2 パイプライン: 候補→評議→推進確定→保健師中→役員→投票中→保健師末→実行→完了
const ACTION_STATUSES = ['候補', '評議中', '推進確定', '保健師中間', '役員決済', '投票中', '保健師最終', '実行中', '完了', '却下'];
// 段階遷移マップ (どこへ進めるか)
const NEXT_STATUS = {
  '候補': ['評議中', '推進確定', '却下'],            // AI評議をスキップして推進確定もOK
  '評議中': ['推進確定', '却下'],
  '推進確定': ['保健師中間', '却下'],
  '保健師中間': ['役員決済', '却下'],
  '役員決済': ['投票中', '却下'],
  '投票中': ['保健師最終'],                        // CRON or手動で締切→保健師最終へ
  '保健師最終': ['実行中', '却下'],
  '実行中': ['完了', '却下'],
};
const VOTING_DAYS = 7;       // 投票期間 (1週間)
const VOTE_PASS_RULE = 'pos_gt_neg'; // 賛成(4-5) > 反対(1-2) で採用、複数案OK

// 推進メンバー判定
function isFieldPromoter(uid) {
  const r = getDb().prepare('SELECT is_field_promoter FROM users WHERE id = ?').get(uid);
  return !!(r && r.is_field_promoter);
}

// 倉庫推進メンバー判定 (2026-05-08)
function isWarehousePromoter(uid) {
  const r = getDb().prepare('SELECT is_warehouse_promoter FROM users WHERE id = ?').get(uid);
  return !!(r && r.is_warehouse_promoter);
}

// 運行管理者 / 所長・副所長 判定 (2026-06-02 聞き取り担当分担)
function isOpsManager(uid) {
  const r = getDb().prepare('SELECT is_ops_manager FROM users WHERE id = ?').get(uid);
  return !!(r && r.is_ops_manager);
}
function isBranchHead(uid) {
  const r = getDb().prepare('SELECT is_branch_head FROM users WHERE id = ?').get(uid);
  return !!(r && r.is_branch_head);
}

// 聞き取り記録の権限・スコープ判定 (2026-06-02)
// 戻り: { allowed, crossSite, companyCode, primaryRole }
//  - 推進(field/warehouse)・管理職(wellness)・admin → crossSite=true (全拠点全員 横断代行)
//  - 運行管理者・所長/副所長 → crossSite=false (自拠点全員のみ。代行可)
//  - いずれでもなければ allowed=false
function getListeningScope(uid) {
  const u = getDb().prepare(`SELECT company_code, employee_type, role,
      is_field_promoter, is_warehouse_promoter, is_ops_manager, is_branch_head
    FROM users WHERE id = ?`).get(uid);
  if (!u) return { allowed: false };
  const isPromoter = !!u.is_field_promoter || !!u.is_warehouse_promoter;
  const isManager = u.employee_type === 'admin';
  const isAdmin = u.role === 'admin';
  const crossSite = isPromoter || isManager || isAdmin;
  let primaryRole = null;
  if (u.is_field_promoter) primaryRole = '推進(運管)';
  else if (u.is_warehouse_promoter) primaryRole = '推進(倉庫)';
  else if (u.is_branch_head) primaryRole = '所長/副所長';
  else if (u.is_ops_manager) primaryRole = '運行管理者';
  else if (isManager) primaryRole = '管理職';
  else if (isAdmin) primaryRole = 'admin';
  const onSite = !!u.is_ops_manager || !!u.is_branch_head;
  return {
    allowed: crossSite || onSite,
    crossSite,
    companyCode: u.company_code || '',
    primaryRole,
  };
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

// 健康管理室ページの閲覧権限: 管理職 or 推進メンバー(運管/倉庫) or ゲストレビュアー
// (一般のシステム管理者は除外 — ドライバーの体調/睡眠/食事POSTを見せない方針)
function canAccessWellness(uid) {
  return isWellnessManager(uid) || isFieldPromoter(uid) || isWarehousePromoter(uid) || isGuestReviewer(uid);
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
  const sourceType = String(body.source_type || '運管').trim();
  if (!CATEGORIES.includes(category)) return res.status(400).json({ success: false, msg: 'カテゴリ不正' });
  if (!URGENCIES.includes(urgency)) return res.status(400).json({ success: false, msg: '緊急度不正' });
  if (!IDENTITY_MODES.includes(identityMode)) return res.status(400).json({ success: false, msg: '特定区分不正' });
  if (!SOURCE_TYPES.includes(sourceType)) return res.status(400).json({ success: false, msg: '投稿元区分不正' });

  const db = getDb();
  const poster = db.prepare('SELECT id, display_name, company_code FROM users WHERE id = ?').get(req.uid);
  const ins = db.prepare(`INSERT INTO wellness_posts (poster_id, company_code, category, urgency, identity_mode, memo, source_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(poster.id, poster.company_code || '', category, urgency, identityMode, memo, sourceType);
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
  const sourceFilter = req.query.source_type;  // '運管'|'倉庫'|undefined
  const db = getDb();
  let sql = `
    SELECT wp.id, wp.category, wp.urgency, wp.identity_mode, wp.memo, wp.company_code,
           wp.source_type, wp.subject_user_id, wp.structured_json, wp.created_at,
           COALESCE(u.display_name, '不明') as poster_name,
           NULL as poster_avatar,
           CASE WHEN wp.poster_id = ? THEN 1 ELSE 0 END as is_mine,
           s.display_name as subject_name,
           s.avatar_url   as subject_avatar
    FROM wellness_posts wp
    LEFT JOIN users u ON u.id = wp.poster_id
    LEFT JOIN users s ON s.id = wp.subject_user_id`;
  const params = [req.uid];
  if (sourceFilter && SOURCE_TYPES.includes(sourceFilter)) {
    sql += ' WHERE wp.source_type = ?';
    params.push(sourceFilter);
  }
  sql += ' ORDER BY wp.id DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  res.json({ success: true, posts: rows });
});

// メタ情報 (フォーム選択肢 + 権限フラグ)
router.get('/meta', authUser, (req, res) => {
  const wm = isWellnessManager(req.uid);
  const fp = isFieldPromoter(req.uid);
  const wp = isWarehousePromoter(req.uid);
  const gr = isGuestReviewer(req.uid);
  res.json({
    is_field_promoter: fp,
    is_warehouse_promoter: wp,
    is_wellness_manager: wm,
    is_guest_reviewer: gr,             // 大学/NPO等の外部レビュアー
    can_access_wellness: wm || fp || wp || gr,
    can_approve_actions: wm,           // 承認/却下は管理職のみ (ゲストはレビューコメントのみ)
    can_edit_actions: wm || fp || wp,  // 起票/編集は管理職+推進メンバー(運管/倉庫) (ゲストは閲覧のみ)
    group_id: PROMOTER_GROUP_ID,
    disc_group_id: WELLNESS_DISC_ID,
    categories: CATEGORIES,
    warehouse_categories: WAREHOUSE_CATEGORIES,
    urgencies: URGENCIES,
    identity_modes: IDENTITY_MODES,
    source_types: SOURCE_TYPES,
    action_statuses: ACTION_STATUSES,
    card_options: CARD_OPTIONS,
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
  // insight からの登録なら thread にも記録 (登録履歴)
  if (b.insight_id && (typeof b.insight_candidate_idx === 'number')) {
    try {
      getDb().prepare(`INSERT INTO wellness_insight_threads (insight_id, candidate_idx, author_id, type, content, registered_action_id)
        VALUES (?, ?, ?, 'register', ?, ?)`).run(
        parseInt(b.insight_id), b.insight_candidate_idx, req.uid,
        '📋 ボードへ登録: ' + title.slice(0, 80), ins.lastInsertRowid
      );
    } catch (e) { console.warn('[insight register thread] fail:', e.message); }
  }
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

// POST /api/wellness/actions/bulk-delete-ai-candidates
// AI生成された候補 (is_ai_suggested=1 AND status='候補') を一括削除 (やり直し用)
// body: { ids: number[] }
router.post('/actions/bulk-delete-ai-candidates', authUser, express.json(), (req, res) => {
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(x => parseInt(x)).filter(x => !isNaN(x)) : [];
  if (!ids.length) return res.json({ success: true, deleted: 0 });
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  // 安全: AI候補かつ status='候補' のみ削除対象
  const rows = db.prepare(`SELECT id FROM wellness_actions WHERE id IN (${placeholders}) AND is_ai_suggested = 1 AND status = '候補'`).all(...ids);
  const delIds = rows.map(r => r.id);
  if (!delIds.length) return res.json({ success: true, deleted: 0 });
  const delPh = delIds.map(() => '?').join(',');
  const tx = db.transaction(() => {
    try { db.prepare(`DELETE FROM wellness_action_discussions WHERE action_id IN (${delPh})`).run(...delIds); } catch (e) {}
    try { db.prepare(`DELETE FROM wellness_action_council WHERE action_id IN (${delPh})`).run(...delIds); } catch (e) {}
    try { db.prepare(`DELETE FROM wellness_action_votes WHERE action_id IN (${delPh})`).run(...delIds); } catch (e) {}
    try { db.prepare(`UPDATE wellness_insight_threads SET registered_action_id = NULL WHERE registered_action_id IN (${delPh})`).run(...delIds); } catch (e) {}
    db.prepare(`DELETE FROM wellness_actions WHERE id IN (${delPh})`).run(...delIds);
  });
  tx();
  res.json({ success: true, deleted: delIds.length });
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
// AI 集計 (運管POST + 社員自発の声 + 食事分析 + ディスカッションGC)
// =============================================================
const { generateText } = require('../services/ai');

router.get('/promoter-board', authUser, (req, res) => {
  if (!canManageActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const sinceISO = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const db = getDb();

  // フロー進捗 (3ソース→施策化までの数値)
  const unkanCount = db.prepare('SELECT COUNT(*) AS c FROM wellness_posts WHERE created_at >= ?').get(sinceISO).c;
  const plazaCount = db.prepare("SELECT COUNT(*) AS c FROM plaza_posts WHERE deleted_at IS NULL AND created_at >= ? AND category != '食事'").get(sinceISO).c;
  const foodCount = db.prepare("SELECT COUNT(*) AS c FROM plaza_posts WHERE deleted_at IS NULL AND created_at >= ? AND category = '食事'").get(sinceISO).c;
  const totalVoices = unkanCount + plazaCount + foodCount;
  const aiSuggested = db.prepare("SELECT COUNT(*) AS c FROM wellness_actions WHERE created_at >= ? AND is_ai_suggested = 1").get(sinceISO).c;
  const inMotion = db.prepare("SELECT COUNT(*) AS c FROM wellness_actions WHERE status IN ('承認待ち','承認済','実行中')").get().c;
  const completed = db.prepare("SELECT COUNT(*) AS c FROM wellness_actions WHERE status = '完了' AND completed_at >= ?").get(sinceISO).c;

  // 直近の重要な声 (緊急度高 or 直近)
  const recentVoices = db.prepare(`SELECT wp.id, wp.category, wp.urgency, wp.memo, wp.company_code, wp.created_at,
    u.display_name as poster_name FROM wellness_posts wp LEFT JOIN users u ON u.id = wp.poster_id
    WHERE wp.created_at >= ? ORDER BY (wp.urgency = '高') DESC, wp.id DESC LIMIT 5`).all(sinceISO);

  // 進行中の施策 (上位)
  const ongoingActions = db.prepare(`SELECT id, title, status, category FROM wellness_actions
    WHERE status IN ('承認待ち','承認済','実行中') ORDER BY id DESC LIMIT 5`).all();

  // 推進メンバー貢献 (POST数+議論数+コメント数+ひろば貢献) — 全員返す
  // ⚠️2026-07-30: 実名表示に統一。もとは「実名・アバター・会社は出さない+🎭ニックネーム」で匿名化して
  //   いたが、(a)同ページのスケジュールが同じ推進メンバーを実名で列挙しており固定の呼び名は照合の
  //   足がかりにしかなっていなかった (b)健康戦略室は実名のみに統一する方針になった。3点まとめて解除。
  const promoters = db.prepare(`SELECT
    CASE WHEN u.id = ? THEN 1 ELSE 0 END AS is_mine,
    u.display_name AS display_name,
    u.avatar_url AS avatar_url, u.company_code AS company_code,
    (SELECT COUNT(*) FROM wellness_posts WHERE poster_id = u.id AND created_at >= ?) AS post_count,
    (SELECT COUNT(*) FROM wellness_post_discussions WHERE author_id = u.id AND deleted_at IS NULL AND created_at >= ?) AS post_disc_count,
    (SELECT COUNT(*) FROM wellness_action_discussions WHERE author_id = u.id AND deleted_at IS NULL AND created_at >= ?) AS action_disc_count,
    (SELECT COUNT(*) FROM wellness_post_reactions WHERE user_id = u.id AND created_at >= ?) AS react_count,
    (SELECT COUNT(*) FROM plaza_post_promoter_comments WHERE author_id = u.id AND deleted_at IS NULL AND created_at >= ?) AS plaza_comment_count,
    (SELECT COUNT(*) FROM plaza_reactions WHERE user_id = u.id AND created_at >= ?) AS plaza_react_count
    FROM users u WHERE u.is_field_promoter = 1 AND u.role != 'bot'
    ORDER BY (post_count*3 + (post_disc_count + action_disc_count + plaza_comment_count)*2 + react_count + plaza_react_count) DESC, u.id ASC`)
    .all(req.uid, sinceISO, sinceISO, sinceISO, sinceISO, sinceISO, sinceISO);

  // 最近完了した施策 (成果として見せる)
  const recentCompleted = db.prepare(`SELECT id, title, completed_at, announce_message FROM wellness_actions
    WHERE status = '完了' AND completed_at >= ? ORDER BY completed_at DESC LIMIT 3`).all(sinceISO);

  res.json({
    success: true,
    window_days: days,
    flow: {
      voices: totalVoices,
      unkan: unkanCount, plaza: plazaCount, food: foodCount,
      ai_suggested: aiSuggested,
      in_motion: inMotion,
      completed: completed,
    },
    recent_voices: recentVoices,
    ongoing_actions: ongoingActions,
    promoters,
    recent_completed: recentCompleted,
  });
});

// 3ソース集計サマリ (推進メンバーモーダル用)
router.get('/sources-summary', authUser, (req, res) => {
  if (!canManageActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const sinceISO = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const db = getDb();
  const unkanCount = db.prepare('SELECT COUNT(*) AS c FROM wellness_posts WHERE created_at >= ?').get(sinceISO).c;
  const plazaCount = db.prepare("SELECT COUNT(*) AS c FROM plaza_posts WHERE deleted_at IS NULL AND created_at >= ? AND category != '食事'").get(sinceISO).c;
  const foodCount = db.prepare("SELECT COUNT(*) AS c FROM plaza_posts WHERE deleted_at IS NULL AND created_at >= ? AND category = '食事'").get(sinceISO).c;
  const discCount = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE room_code = ? AND created_at >= ?").get('grp_' + WELLNESS_DISC_ID, sinceISO).c;
  // urgency高 のwellness_posts件数 (注意喚起用)
  const urgentCount = db.prepare("SELECT COUNT(*) AS c FROM wellness_posts WHERE created_at >= ? AND urgency = '高'").get(sinceISO).c;
  // 食事の塩分過多/野菜不足カウント (簡易)
  let saltOver = 0, vegLow = 0;
  try {
    const foods = db.prepare("SELECT nutrition_scores FROM plaza_posts WHERE deleted_at IS NULL AND created_at >= ? AND category = '食事' AND nutrition_scores IS NOT NULL").all(sinceISO);
    for (const f of foods) {
      try {
        const ns = JSON.parse(f.nutrition_scores);
        const salt = ns.salt && ns.salt.value;
        const veg = ns.vitamin && ns.vitamin.value;
        if (salt && Number(salt) > 2.5) saltOver++;
        if (veg != null && Number(veg) < 80) vegLow++;
      } catch (e) {}
    }
  } catch (e) {}
  res.json({
    success: true,
    window_days: days,
    sources: {
      unkan: { count: unkanCount, urgent: urgentCount, label: '🩺 運管・健管POST', desc: '点呼/帰庫時に推進メンバーが拾った構造化された声' },
      plaza: { count: plazaCount, label: '🌳 一般投稿', desc: '社員が自発的にひろばへ投稿した相談/雑談/Tips' },
      food: { count: foodCount, salt_over: saltOver, veg_low: vegLow, label: '🍱 食事投稿', desc: '食事写真+AI栄養スコアから見える生活習慣' },
    },
    discussion: { count: discCount, label: '💬 健康管理室議論GC', desc: '推進メンバー間の議論レイヤー (ソースではなく加工側)' },
  });
});

router.post('/insights', authUser, express.json(), async (req, res) => {
  if (!canManageActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const days = Math.min(parseInt((req.body && req.body.days) || 30), 90);
  const db = getDb();
  const sinceISO = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  // 系統A: 運管POST (wellness_posts)
  const unkanPosts = db.prepare(`
    SELECT wp.id, wp.category, wp.urgency, wp.identity_mode, wp.memo, wp.company_code, wp.created_at,
           u.display_name as poster_name
    FROM wellness_posts wp LEFT JOIN users u ON u.id = wp.poster_id
    WHERE wp.created_at >= ? ORDER BY wp.id ASC
  `).all(sinceISO);

  // 系統B: 社員の自発的な声 (ひろば posts、食事以外)
  const plazaPosts = db.prepare(`
    SELECT pp.id, pp.category, pp.content, pp.is_anonymous, pp.created_at,
           u.display_name as author_name, u.company_code
    FROM plaza_posts pp LEFT JOIN users u ON u.id = pp.author_id
    WHERE pp.deleted_at IS NULL AND pp.created_at >= ? AND pp.category != '食事'
    ORDER BY pp.id DESC LIMIT 200
  `).all(sinceISO);

  // 系統C: 食事分析 (ひろば 食事カテゴリ + nutrition_scores)
  const foodPosts = db.prepare(`
    SELECT pp.id, pp.content, pp.nutrition_scores, pp.ai_comment, pp.is_anonymous, pp.created_at,
           u.display_name as author_name, u.company_code
    FROM plaza_posts pp LEFT JOIN users u ON u.id = pp.author_id
    WHERE pp.deleted_at IS NULL AND pp.created_at >= ? AND pp.category = '食事'
    ORDER BY pp.id DESC LIMIT 200
  `).all(sinceISO);

  // 健康管理室ディスカッション (事務側)
  const discMsgs = db.prepare(`
    SELECT m.id, m.content, m.created_at, u.display_name as sender_name
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_code = ? AND m.created_at >= ?
    ORDER BY m.id ASC LIMIT 200
  `).all('grp_' + WELLNESS_DISC_ID, sinceISO);

  if (!unkanPosts.length && !plazaPosts.length && !foodPosts.length && !discMsgs.length) {
    return res.json({ success: true, insights: null, msg: 'データが不足しています' });
  }

  // 反応集計 (plaza_reactions) — POST別 絵文字別カウントを取得
  // ラベル付き8種: 👍いいね/❤️推し/😊共感/💪応援/👏すごい/💡参考/🙏ありがとう/😢心配
  const REACTION_LABEL = { '👍':'いいね', '❤️':'推し', '😊':'共感', '💪':'応援', '👏':'すごい', '💡':'参考', '🙏':'ありがとう', '😢':'心配', '🎉':'お祝い' };
  const reactionMap = {}; // {post_id: {emoji: count}}
  try {
    const allPlazaIds = [...plazaPosts.map(p => p.id), ...foodPosts.map(p => p.id)];
    if (allPlazaIds.length) {
      const ph = allPlazaIds.map(() => '?').join(',');
      const rows = db.prepare(`SELECT post_id, emoji, COUNT(*) as ct FROM plaza_reactions WHERE post_id IN (${ph}) GROUP BY post_id, emoji`).all(...allPlazaIds);
      for (const r of rows) {
        if (!reactionMap[r.post_id]) reactionMap[r.post_id] = {};
        reactionMap[r.post_id][r.emoji] = r.ct;
      }
    }
  } catch (e) { console.warn('[insights] reaction aggregate failed', e.message); }
  const reactionSummary = (postId) => {
    const m = reactionMap[postId];
    if (!m) return '';
    const parts = Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .map(([e, c]) => `${REACTION_LABEL[e] || e}${c}`);
    return parts.length ? ' 反応{' + parts.join('・') + '}' : '';
  };

  // 各系統 上限80件、メモは200字まで (プロンプト肥大化防止)
  const cap = (arr, n) => arr.length > n ? arr.slice(0, n) : arr;
  const unkanLines = cap(unkanPosts, 80).map(p =>
    `[#${p.id}|${p.category}|緊急度${p.urgency}|${p.company_code || '-'}|by ${p.poster_name || '不明'}] ${(p.memo || '').slice(0, 200) || '(メモなし)'}`
  ).join('\n');
  const plazaLines = cap(plazaPosts, 80).map(p =>
    `[#${p.id}|${p.category}|${p.company_code || '-'}|by ${p.is_anonymous ? '匿名' : (p.author_name || '不明')}] ${(p.content || '').slice(0, 150)}${reactionSummary(p.id)}`
  ).join('\n');
  const foodLines = cap(foodPosts, 80).map(p => {
    let nutri = '';
    try {
      const ns = JSON.parse(p.nutrition_scores || '{}');
      const cal = ns.calories && ns.calories.value;
      const salt = ns.salt && ns.salt.value;
      const veg = ns.vitamin && ns.vitamin.value;
      nutri = `(cal:${cal||'-'}kcal塩:${salt||'-'}g野菜:${veg||'-'}g)`;
    } catch (e) {}
    return `[#${p.id}|by ${p.is_anonymous ? '匿名' : (p.author_name || '不明')}] ${(p.content || '').slice(0,80)} ${nutri}${reactionSummary(p.id)}`;
  }).join('\n');
  const discLines = cap(discMsgs, 80).map(m =>
    `[${m.sender_name || '不明'}] ${(m.content || '').slice(0, 150)}`
  ).join('\n');

  const prompt = `あなたは中小運送業の健康管理室の補助役です。3系統の異なるソースから集まったテキストと、社員が押した反応ボタン(8種ラベル付き)を分析し、健康管理室会議で議論する材料として整理してください。

【系統A: 運管・現場責任者の "現場の声" POST (構造化)】
${unkanLines || '(なし)'}

【系統B: 社員の自発的な声 (ひろば: 相談/雑談/Tips)】
※ 各行末の 反応{...} は社員が押した反応ボタン集計。ラベル別カウント。
${plazaLines || '(なし)'}

【系統C: 食事分析 (ひろば食事投稿+AI栄養データ)】
※ 食事投稿は👍いいねのみ可（マウント防止ルール）。反応数=共感した社員数。
${foodLines || '(なし)'}

【系統D: 健康管理室ディスカッション(事務側議論)】
${discLines || '(なし)'}

【反応ボタンの意味】
- いいね: 軽い同意。多いほど"あるある"度が高い
- 推し: 強い共感・賛成。重要シグナル
- 共感: わかる/同じ気持ち。情緒的に響いた
- 応援: がんばれ。本人を励ましたい
- すごい: 称賛。模範事例として広めたい
- 参考: 学び/チップとして使える。横展開候補
- ありがとう: 感謝。誰かを助けた価値ある投稿
- 心配: 気になる/それ辛い。早めの介入候補 ★最重要シグナル

以下の形式の純粋なJSONで回答してください (Markdownや前置きは不要):
{
  "summary": "全体の特徴を3〜5行で",
  "themes": [
    {"name": "テーマ名", "post_ids": [整数配列], "count": 件数, "urgency_max": "高|中|低", "note": "1〜2行の所見", "resonance": "反応傾向(例: 共感が突出/心配多い/参考多い 等)"}
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
- データが薄い場合は無理に作らず空配列で良い
- 3系統 (運管POST/社員の声/食事分析) を横断的に見て、複数ソースで裏付けが取れるテーマを優先
- 反応ボタンの分布を強力なシグナルとして使う。特に「心配」「推し」「共感」の集中は職場の温度を示す
- 「心配」が多いPOSTは緊急度を1段上げて評価する
- 「推し」「参考」が多いPOSTは横展開・全社施策化の候補`;

  try {
    // thinkingBudget=0 で thinking を切り、出力枠をフルに確保
    const aiText = await generateText(prompt, {
      maxTokens: 8000,
      responseMimeType: 'application/json',
      thinkingBudget: 0,
    });
    console.log('[insights] raw len=', String(aiText || '').length, 'head:', String(aiText || '').slice(0, 200));
    let parsed = null;
    let cleaned = String(aiText || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) cleaned = m[0];
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      // 切詰時のフォールバック: 末尾の壊れた要素を切り捨ててから閉じカッコ補完
      let fixed = cleaned;
      // 末尾が文字列途中(閉じ"がない)で切れていたら "" を補完
      // 末尾が , で終わっていたら除去 (JSON で trailing comma は不可)
      fixed = fixed.replace(/,\s*$/,'');
      // 末尾の不完全要素 (最後の { または [ 以降) を可能なら捨てる
      const opens = (fixed.match(/\{/g) || []).length;
      const closes = (fixed.match(/\}/g) || []).length;
      const obs = (fixed.match(/\[/g) || []).length;
      const cbs = (fixed.match(/\]/g) || []).length;
      // 文字列途中切れ(奇数個の") は閉じる
      const dq = (fixed.match(/"/g) || []).length;
      if (dq % 2 === 1) fixed += '"';
      // 末尾に , を再除去
      fixed = fixed.replace(/,\s*$/,'');
      if (obs > cbs) fixed += ']'.repeat(obs - cbs);
      if (opens > closes) fixed += '}'.repeat(opens - closes);
      try { parsed = JSON.parse(fixed); }
      catch (e2) {
        console.warn('[insights] parse fail. len=', cleaned.length, 'tail:', cleaned.slice(-300));
        return res.json({
          success: false,
          msg: 'AI出力解析失敗 (出力切詰の可能性)。対象期間を短くするかPOST数を減らして再試行してください',
          raw_len: cleaned.length,
          raw_tail: cleaned.slice(-300),
        });
      }
    }
    // 永続化: insightを保存
    const counts = {
      unkan_posts: unkanPosts.length,
      plaza_posts: plazaPosts.length,
      food_posts: foodPosts.length,
      disc_msgs: discMsgs.length,
      posts: unkanPosts.length,
    };
    let insightId = null;
    try {
      const ins = db.prepare(`INSERT INTO wellness_insights (generated_by, days_window, summary, candidates_json, counts_json)
        VALUES (?, ?, ?, ?, ?)`).run(
        req.uid, days, parsed.summary || '',
        JSON.stringify(parsed.actions || []),
        JSON.stringify(counts)
      );
      insightId = ins.lastInsertRowid;
    } catch (e) { console.warn('[insights] persist fail:', e.message); }
    // 各AI候補を自動で施策ボードに【候補】として登録 → 既存の💬議論UIで個別議論可能
    const createdActionIds = [];
    if (parsed.actions && Array.isArray(parsed.actions)) {
      for (let i = 0; i < parsed.actions.length; i++) {
        const a = parsed.actions[i];
        if (!a || !a.title) continue;
        const title = String(a.title || '').slice(0, 200);
        const description = (String(a.description || '') + (a.rationale ? '\n\n💡 効果想定: ' + a.rationale : '')).slice(0, 2000);
        const sourceSummary = JSON.stringify({ insight_id: insightId, candidate_idx: i, source_post_ids: a.source_post_ids || [] }).slice(0, 1000);
        const category = CATEGORIES.includes(a.category) ? a.category : null;
        try {
          const r = db.prepare(`INSERT INTO wellness_actions
            (title, description, category, source_post_ids, source_summary, status, created_by, is_ai_suggested)
            VALUES (?, ?, ?, ?, ?, '候補', ?, 1)`).run(
            title, description, category,
            a.source_post_ids ? JSON.stringify(a.source_post_ids) : null,
            sourceSummary, req.uid
          );
          createdActionIds.push(r.lastInsertRowid);
        } catch (e) { console.warn('[insights auto-create] fail:', e.message); }
      }
    }
    res.json({
      success: true,
      insight_id: insightId,
      generated_at: new Date().toISOString(),
      window_days: days,
      counts,
      insights: parsed,
      created_action_ids: createdActionIds,
    });
  } catch (e) {
    console.warn('[insights] error:', e.message);
    res.status(500).json({ success: false, msg: 'AI呼び出し失敗: ' + e.message });
  }
});

// 直近のAI凝縮結果一覧 (再展開用)
router.get('/insights', authUser, (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const rows = getDb().prepare(`SELECT i.id, i.generated_by, i.generated_at, i.days_window, i.summary, i.candidates_json, i.counts_json,
    u.display_name AS generator_name FROM wellness_insights i LEFT JOIN users u ON u.id = i.generated_by
    WHERE i.status = 'active' ORDER BY i.id DESC LIMIT 10`).all();
  res.json({ success: true, insights: rows });
});

// 個別insight再取得
router.get('/insights/:id', authUser, (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const ins = getDb().prepare(`SELECT i.*, u.display_name AS generator_name FROM wellness_insights i
    LEFT JOIN users u ON u.id = i.generated_by WHERE i.id = ?`).get(id);
  if (!ins) return res.status(404).json({ success: false, msg: '見つかりません' });
  res.json({ success: true, insight: ins });
});

// 候補ごとの議論+共感+登録履歴を取得
router.get('/insights/:id/threads', authUser, (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const threads = getDb().prepare(`SELECT t.id, t.candidate_idx, t.author_id, t.type, t.content, t.registered_action_id, t.created_at,
    COALESCE(u.display_name, '不明') AS author_name FROM wellness_insight_threads t LEFT JOIN users u ON u.id = t.author_id
    WHERE t.insight_id = ? AND t.deleted_at IS NULL ORDER BY t.id ASC`).all(id);
  res.json({ success: true, threads });
});

// 共感+コメント追加
router.post('/insights/:id/threads', authUser, express.json(), (req, res) => {
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '推進メンバー権限が必要' });
  const insightId = parseInt(req.params.id);
  const b = req.body || {};
  const candidateIdx = (typeof b.candidate_idx === 'number') ? b.candidate_idx : -1;
  const type = String(b.type || '');
  if (!['like', 'comment'].includes(type)) return res.status(400).json({ success: false, msg: 'type は like|comment' });
  const content = String(b.content || '').slice(0, 1000);
  if (type === 'comment' && !content.trim()) return res.status(400).json({ success: false, msg: 'コメント本文必須' });
  const db = getDb();
  // like は同一ユーザーで重複しない (toggle)
  if (type === 'like') {
    const existing = db.prepare(`SELECT id FROM wellness_insight_threads
      WHERE insight_id = ? AND candidate_idx = ? AND author_id = ? AND type = 'like' AND deleted_at IS NULL`)
      .get(insightId, candidateIdx, req.uid);
    if (existing) {
      db.prepare("UPDATE wellness_insight_threads SET deleted_at = datetime('now') WHERE id = ?").run(existing.id);
      return res.json({ success: true, action: 'unliked' });
    }
  }
  const ins = db.prepare(`INSERT INTO wellness_insight_threads (insight_id, candidate_idx, author_id, type, content)
    VALUES (?, ?, ?, ?, ?)`).run(insightId, candidateIdx, req.uid, type, content);
  res.json({ success: true, id: ins.lastInsertRowid, action: type === 'like' ? 'liked' : 'commented' });
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
  const rows = getDb().prepare(`SELECT d.*, COALESCE(u.display_name, '不明') AS author_name, NULL AS author_avatar
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
  const c = getDb().prepare(`SELECT d.*, COALESCE(u.display_name, '不明') AS author_name, NULL AS author_avatar
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
  const rows = getDb().prepare(`SELECT d.*, COALESCE(u.display_name, '不明') AS author_name, NULL AS author_avatar
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
  const c = getDb().prepare(`SELECT d.*, COALESCE(u.display_name, '不明') AS author_name, NULL AS author_avatar
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
  const discussions = db.prepare(`SELECT d.content, ('参加者' || ROW_NUMBER() OVER (ORDER BY d.id)) AS name FROM wellness_action_discussions d
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

// =============================================================
// v2 パイプライン (3つの柱→AI凝縮→候補→評議→推進確定→保健師中→役員→投票→保健師末→実行→完了)
// =============================================================

// CoWell の image_url は CORP same-origin のためプロキシ経由必須
function rewriteCwImage(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/uploads/')) {
    const fname = url.replace(/^\/uploads\//, '');
    return '/api/cw-archive/img/' + encodeURIComponent(fname);
  }
  return url;
}

// 各柱の最新POST (3つの柱に実コンテンツを表示するため、CoWell移行データもマージ)
router.get('/pillar-recent', authUser, (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const limit = Math.min(parseInt(req.query.limit) || 5, 20);
  const fetchN = limit * 2; // CoHub+CoWell をマージするため余分に取って後で絞る
  const db = getDb();
  // 運管POST (CoWellには無い)
  const unkan = db.prepare(`SELECT wp.id, wp.category, wp.urgency, wp.identity_mode, wp.memo, wp.company_code, wp.created_at,
    wp.source_type, u.display_name as poster_name, s.display_name as subject_name
    FROM wellness_posts wp LEFT JOIN users u ON u.id = wp.poster_id
    LEFT JOIN users s ON s.id = wp.subject_user_id
    ORDER BY wp.id DESC LIMIT ?`).all(limit);
  unkan.forEach(p => p.source = 'unkan');

  // 一般投稿 (CoHub plaza 食事以外 + CoWell 相談カテゴリ)
  const plazaCohub = db.prepare(`SELECT pp.id, pp.category, pp.content, pp.image_url, pp.is_anonymous, pp.created_at,
    u.display_name as author_name, u.company_code, pp.nutrition_scores, pp.ai_comment
    FROM plaza_posts pp LEFT JOIN users u ON u.id = pp.author_id
    WHERE pp.deleted_at IS NULL AND pp.category != '食事'
    ORDER BY pp.id DESC LIMIT ?`).all(fetchN);
  plazaCohub.forEach(p => p.source = 'plaza');
  const plazaCw = db.prepare(`SELECT cw_post_id AS id, category, content, image_url, nickname, cw_created_at AS created_at, status, analysis
    FROM cw_posts WHERE category != '🍱 食事・栄養' ORDER BY cw_created_at DESC LIMIT ?`).all(fetchN);
  plazaCw.forEach(p => { p.source = 'cw_post'; p.author_name = p.nickname; p.is_archive = true; p.image_url = rewriteCwImage(p.image_url); });
  const plaza = [...plazaCohub, ...plazaCw]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, limit);

  // 食事投稿 (CoHub plaza 食事 + CoWell 食事 + CoWell 週間レポート)
  const foodCohub = db.prepare(`SELECT pp.id, pp.content, pp.image_url, pp.nutrition_scores, pp.ai_comment, pp.is_anonymous, pp.created_at,
    u.display_name as author_name, u.company_code
    FROM plaza_posts pp LEFT JOIN users u ON u.id = pp.author_id
    WHERE pp.deleted_at IS NULL AND pp.category = '食事'
    ORDER BY pp.id DESC LIMIT ?`).all(fetchN);
  foodCohub.forEach(p => p.source = 'food');
  const foodCw = db.prepare(`SELECT cw_post_id AS id, content, image_url, nutrition_scores, nickname, cw_created_at AS created_at, analysis, status
    FROM cw_posts WHERE category = '🍱 食事・栄養' ORDER BY cw_created_at DESC LIMIT ?`).all(fetchN);
  foodCw.forEach(p => { p.source = 'cw_post'; p.author_name = p.nickname; p.is_archive = true; p.ai_comment = p.analysis; p.image_url = rewriteCwImage(p.image_url); });
  const food = [...foodCohub, ...foodCw]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, limit);

  res.json({ success: true, unkan, plaza, food });
});

// POST詳細 (3柱共通、source+id で1リクエスト)
router.get('/post-detail/:source/:id', authUser, (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const src = req.params.source;
  const id = req.params.id;
  const db = getDb();
  let post = null, comments = [], promoter_comments = [], discussions = [];
  try {
    if (src === 'unkan') {
      post = db.prepare(`SELECT wp.*, u.display_name AS poster_name, s.display_name AS subject_name
        FROM wellness_posts wp LEFT JOIN users u ON u.id = wp.poster_id
        LEFT JOIN users s ON s.id = wp.subject_user_id WHERE wp.id = ?`).get(parseInt(id));
      if (post) {
        discussions = db.prepare(`SELECT d.id, d.content, d.created_at, COALESCE(u.display_name, '不明') AS author_name
          FROM wellness_post_discussions d LEFT JOIN users u ON u.id = d.author_id
          WHERE d.post_id = ? AND d.deleted_at IS NULL ORDER BY d.id`).all(parseInt(id));
      }
    } else if (src === 'plaza' || src === 'food') {
      post = db.prepare(`SELECT pp.*, u.display_name AS author_name FROM plaza_posts pp
        LEFT JOIN users u ON u.id = pp.author_id WHERE pp.id = ? AND pp.deleted_at IS NULL`).get(parseInt(id));
      if (post) {
        comments = db.prepare(`SELECT c.id, c.content, c.created_at, COALESCE(u.display_name, '不明') AS author_name
          FROM plaza_comments c LEFT JOIN users u ON u.id = c.author_id
          WHERE c.post_id = ? AND c.deleted_at IS NULL ORDER BY c.id`).all(parseInt(id));
        promoter_comments = db.prepare(`SELECT c.id, c.content, c.created_at, COALESCE(u.display_name, '不明') AS author_name
          FROM plaza_post_promoter_comments c LEFT JOIN users u ON u.id = c.author_id
          WHERE c.post_id = ? AND c.deleted_at IS NULL ORDER BY c.id`).all(parseInt(id));
      }
    } else if (src === 'cw_post') {
      post = db.prepare('SELECT * FROM cw_posts WHERE cw_post_id = ?').get(id);
      if (post) {
        post.author_name = post.nickname;
        post.is_archive = true;
        post.created_at = post.cw_created_at;
        post.image_url = rewriteCwImage(post.image_url);
        // ///SCORE///{json} を analysis から抽出
        const m = (post.analysis || '').match(/\/\/\/SCORE\/\/\/\s*(\{[\s\S]*?\})/);
        if (m) {
          try {
            const sc = JSON.parse(m[1]);
            // 7軸だけ抜き出す (is_target/is_planned 等はメタ情報として別保持)
            const axes = {};
            ['legal','risk','freq','urgency','safety','value','needs'].forEach(k => {
              if (sc[k] != null) axes[k] = Math.max(1, Math.min(5, parseInt(sc[k]) || 1));
            });
            if (Object.keys(axes).length === 7) post.priority_axes = JSON.stringify(axes);
            post.cw_meta = { is_target: !!sc.is_target, is_planned: !!sc.is_planned };
          } catch (e) {}
          // analysis から ///SCORE///+JSON を削除して表示用 ai_comment へ
          post.ai_comment = (post.analysis || '').replace(/\/\/\/SCORE\/\/\/[\s\S]*$/, '').trim();
        } else {
          post.ai_comment = post.analysis;
        }
      }
    } else if (src === 'cw_weekly') {
      post = db.prepare('SELECT * FROM cw_food_weekly_reports WHERE cw_report_id = ?').get(id);
      if (post) {
        post.author_name = post.nickname;
        post.is_archive = true;
        post.is_weekly = true;
        post.created_at = post.cw_created_at;
        post.content = post.report_text;
      }
    }
    if (!post) return res.status(404).json({ success: false, msg: '見つかりません' });
    res.json({ success: true, source: src, post, comments, promoter_comments, discussions });
  } catch (e) {
    console.warn('[post-detail] fail:', e.message);
    res.status(500).json({ success: false, msg: e.message });
  }
});

// パイプライン件数: トップ画面の「→」可視化用
router.get('/pipeline', authUser, (req, res) => {
  if (!canAccessWellness(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const sinceISO = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const db = getDb();
  // 3本柱の件数 + 推進コメント件数 (CoHub + CoWell移行データ合算)
  const unkanCount = db.prepare('SELECT COUNT(*) AS c FROM wellness_posts WHERE created_at >= ?').get(sinceISO).c;
  const unkanComments = db.prepare("SELECT COUNT(*) AS c FROM wellness_post_discussions WHERE deleted_at IS NULL AND created_at >= ?").get(sinceISO).c;
  const unkanUrgent = db.prepare("SELECT COUNT(*) AS c FROM wellness_posts WHERE created_at >= ? AND urgency = '高'").get(sinceISO).c;
  // 一般投稿 = CoHub plaza(食事以外) + CoWell cw_posts(食事・栄養以外)
  const plazaCohubN = db.prepare("SELECT COUNT(*) AS c FROM plaza_posts WHERE deleted_at IS NULL AND created_at >= ? AND category != '食事'").get(sinceISO).c;
  const plazaCwN = db.prepare("SELECT COUNT(*) AS c FROM cw_posts WHERE category != '🍱 食事・栄養' AND cw_created_at >= ?").get(sinceISO).c;
  const plazaCount = plazaCohubN + plazaCwN;
  // 食事投稿 = CoHub plaza(食事) + CoWell cw_posts(食事・栄養)
  const foodCohubN = db.prepare("SELECT COUNT(*) AS c FROM plaza_posts WHERE deleted_at IS NULL AND created_at >= ? AND category = '食事'").get(sinceISO).c;
  const foodCwN = db.prepare("SELECT COUNT(*) AS c FROM cw_posts WHERE category = '🍱 食事・栄養' AND cw_created_at >= ?").get(sinceISO).c;
  const foodCount = foodCohubN + foodCwN;
  // plaza/food への推進コメント
  const plazaCommentRows = db.prepare(`
    SELECT pp.category, COUNT(*) AS c FROM plaza_post_promoter_comments ppc
    JOIN plaza_posts pp ON pp.id = ppc.post_id
    WHERE ppc.deleted_at IS NULL AND ppc.created_at >= ? AND pp.deleted_at IS NULL
    GROUP BY (pp.category = '食事')
  `).all(sinceISO);
  let plazaComments = 0, foodComments = 0;
  for (const r of plazaCommentRows) {
    if (r.category === '食事') foodComments = r.c;
    else plazaComments = r.c;
  }
  // 各段階の件数 (期間制限なし、現在進行中)
  const stages = ['候補', '評議中', '推進確定', '保健師中間', '役員決済', '投票中', '保健師最終', '実行中', '完了'];
  const stageRows = db.prepare("SELECT status, COUNT(*) AS c FROM wellness_actions GROUP BY status").all();
  const stageMap = {};
  stages.forEach(s => stageMap[s] = 0);
  for (const r of stageRows) if (stageMap[r.status] !== undefined) stageMap[r.status] = r.c;
  // 完了件数だけは期間内のみ
  stageMap['完了'] = db.prepare("SELECT COUNT(*) AS c FROM wellness_actions WHERE status = '完了' AND completed_at >= ?").get(sinceISO).c;
  // 24時間以内に新規作成された施策の段階別件数 (NEWバッジ用)
  const newRows = db.prepare("SELECT status, COUNT(*) AS c FROM wellness_actions WHERE created_at >= datetime('now','-24 hours') GROUP BY status").all();
  const newMap = {};
  stages.forEach(s => newMap[s] = 0);
  for (const r of newRows) if (newMap[r.status] !== undefined) newMap[r.status] = r.c;
  res.json({
    success: true,
    window_days: days,
    pillars: {
      unkan: { count: unkanCount, comments: unkanComments, urgent: unkanUrgent, label: '🩺 運管・健管POST', desc: '推進メンバーが点呼/帰庫時に拾った構造化された声' },
      plaza: { count: plazaCount, comments: plazaComments, label: '🌳 一般投稿', desc: '社員の自発的なひろば投稿 (相談/雑談/Tips)' },
      food: { count: foodCount, comments: foodComments, label: '🍱 食事投稿', desc: 'AI栄養分析つきの生活習慣記録' },
    },
    stages: stageMap,
    stage_new: newMap,
    stage_order: stages,
    stage_labels: {
      '候補': '🎯 候補', '評議中': '🤖 AI評議',
      '推進確定': '✏ 推進確定', '保健師中間': '🩺 保健師(中間)',
      '役員決済': '⚖ 役員決済', '投票中': '🗳 社員投票',
      '保健師最終': '🩺 保健師(最終)', '実行中': '▶ 実行中', '完了': '✅ 完了',
    },
  });
});

// 段階遷移 (汎用、推進メンバーが手動で進める)
router.post('/actions/:id/transition', authUser, express.json(), (req, res) => {
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const target = String((req.body && req.body.to) || '');
  const db = getDb();
  const a = db.prepare('SELECT status FROM wellness_actions WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  const allowed = NEXT_STATUS[a.status] || [];
  if (!allowed.includes(target)) {
    return res.status(400).json({ success: false, msg: `「${a.status}」から「${target}」へは進めません (許可: ${allowed.join(',') || 'なし'})` });
  }
  // 役員決済→投票中 に進める時は管理職権限必須
  if (target === '投票中' && !isWellnessManager(req.uid)) {
    return res.status(403).json({ success: false, msg: '役員(管理職)権限が必要です' });
  }
  // 投票中 へ遷移時は vote_started_at を打つ
  if (target === '投票中') {
    db.prepare("UPDATE wellness_actions SET status = ?, vote_started_at = datetime('now') WHERE id = ?").run(target, id);
  } else if (target === '実行中') {
    db.prepare("UPDATE wellness_actions SET status = ? WHERE id = ?").run(target, id);
  } else {
    db.prepare("UPDATE wellness_actions SET status = ? WHERE id = ?").run(target, id);
  }
  res.json({ success: true, status: target });
});

// 推進メンバー: AI最終素案生成 (評議+議論を踏まえて)
const { generateText: gen2 } = require('../services/ai');
router.post('/actions/:id/final-draft', authUser, express.json(), async (req, res) => {
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT * FROM wellness_actions WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  const council = db.prepare('SELECT role, message FROM wellness_action_council WHERE action_id = ? ORDER BY id').all(id);
  const discs = db.prepare(`SELECT ('参加者' || ROW_NUMBER() OVER (ORDER BY d.id)) AS name, d.content FROM wellness_action_discussions d
    LEFT JOIN users u ON u.id = d.author_id WHERE d.action_id = ? AND d.deleted_at IS NULL ORDER BY d.id`).all(id);
  const prompt = `中小運送業の健康推進施策を、関係者の議論を踏まえて最終的な素案にまとめてください。

【施策タイトル】${a.title}
【元の説明】${a.description || '(なし)'}
【カテゴリ】${a.category || '-'}
【予算】${a.budget_jpy || 0}円

【AI評議会の意見】
${council.map(c => `- ${c.role}: ${c.message}`).join('\n') || '(なし)'}

【推進メンバーの議論】
${discs.map(d => `- ${d.name || '不明'}: ${d.content}`).join('\n') || '(なし)'}

以下の純粋なJSON で、議論で出た懸念や賛成意見を踏まえた「実施しやすく効果が出やすい」素案にまとめてください (Markdownや前置き禁止):
{"title":"30字以内", "description":"180字以内、具体的な実施内容と期待効果", "rationale":"40字以内、なぜこの形に落ち着いたか"}`;
  try {
    const aiText = await gen2(prompt, { maxTokens: 2000, responseMimeType: 'application/json', thinkingBudget: 0 });
    let cleaned = String(aiText || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) cleaned = m[0];
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      const opens = (cleaned.match(/\{/g) || []).length, closes = (cleaned.match(/\}/g) || []).length;
      const dq = (cleaned.match(/"/g) || []).length;
      let fixed = cleaned;
      if (dq % 2 === 1) fixed += '"';
      if (opens > closes) fixed += '}'.repeat(opens - closes);
      try { parsed = JSON.parse(fixed); }
      catch (e2) { return res.json({ success: false, msg: 'AI解析失敗 (再試行してください)' }); }
    }
    const draftJson = JSON.stringify(parsed);
    db.prepare("UPDATE wellness_actions SET final_draft = ?, final_draft_at = datetime('now') WHERE id = ?").run(draftJson, id);
    res.json({ success: true, draft: parsed });
  } catch (e) {
    res.status(500).json({ success: false, msg: 'AI失敗: ' + e.message });
  }
});

// 7軸priority評価 (legal/risk/freq/urgency/safety/value/needs 各1-5点) AI算出
router.post('/actions/:id/priority-axes', authUser, express.json(), async (req, res) => {
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT * FROM wellness_actions WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  const prompt = `中小運送業の健康施策を以下の7軸で評価し、各軸を1〜5点で採点してください。

【施策タイトル】${a.title}
【説明】${a.description || '(なし)'}
【カテゴリ】${a.category || '-'}

7軸の意味:
- legal: 法令・規制対応の重要度 (高いほど法的に必須)
- risk: 放置した場合のリスク (高いほど危険)
- freq: 該当事象の発生頻度 (高いほど頻発)
- urgency: 対応の緊急度 (高いほど急ぐ)
- safety: 安全性への影響 (高いほど安全に直結)
- value: 会社/社員にもたらす価値 (高いほど価値大)
- needs: 社員・現場からのニーズ (高いほど要望強い)

以下の純粋なJSON のみで回答 (前置き禁止):
{"legal":1-5, "risk":1-5, "freq":1-5, "urgency":1-5, "safety":1-5, "value":1-5, "needs":1-5, "rationale":"30字以内、評価の根拠"}`;
  try {
    const aiText = await gen2(prompt, { maxTokens: 800, responseMimeType: 'application/json', thinkingBudget: 0 });
    let cleaned = String(aiText || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) cleaned = m[0];
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      let fixed = cleaned;
      const dq = (fixed.match(/"/g) || []).length;
      if (dq % 2 === 1) fixed += '"';
      const opens = (fixed.match(/\{/g) || []).length, closes = (fixed.match(/\}/g) || []).length;
      if (opens > closes) fixed += '}'.repeat(opens - closes);
      try { parsed = JSON.parse(fixed); }
      catch (e2) { return res.json({ success: false, msg: 'AI解析失敗' }); }
    }
    // クリップ 1-5
    ['legal','risk','freq','urgency','safety','value','needs'].forEach(k => {
      let v = parseInt(parsed[k]);
      if (!Number.isInteger(v)) v = 1;
      parsed[k] = Math.max(1, Math.min(5, v));
    });
    db.prepare("UPDATE wellness_actions SET priority_axes = ? WHERE id = ?").run(JSON.stringify(parsed), id);
    res.json({ success: true, axes: parsed });
  } catch (e) {
    res.status(500).json({ success: false, msg: 'AI失敗: ' + e.message });
  }
});

// 推進メンバーで最終確定 (final_draft の内容を本体に反映 → status=推進確定)
router.post('/actions/:id/finalize', authUser, express.json(), (req, res) => {
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT * FROM wellness_actions WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  const b = req.body || {};
  // body で title/description を上書き可、なければ final_draft を流用
  let newTitle = b.title, newDesc = b.description;
  if ((!newTitle || !newDesc) && a.final_draft) {
    try { const fd = JSON.parse(a.final_draft); newTitle = newTitle || fd.title; newDesc = newDesc || fd.description; }
    catch (e) {}
  }
  newTitle = String(newTitle || a.title).slice(0, 200);
  newDesc = String(newDesc || a.description || '').slice(0, 2000);
  db.prepare(`UPDATE wellness_actions SET title = ?, description = ?, status = '推進確定',
    finalized_by = ?, finalized_at = datetime('now') WHERE id = ?`).run(newTitle, newDesc, req.uid, id);
  res.json({ success: true });
});

// 保健師(中間)レビュー — ゲストレビュアーのみ
router.post('/actions/:id/nurse-mid', authUser, express.json(), (req, res) => {
  const u = getDb().prepare('SELECT is_guest_reviewer, employee_type FROM users WHERE id = ?').get(req.uid);
  if (!u || (!u.is_guest_reviewer && u.employee_type !== 'admin')) return res.status(403).json({ success: false, msg: '保健師(ゲストレビュアー)権限が必要です' });
  const id = parseInt(req.params.id);
  const comment = String((req.body && req.body.comment) || '').slice(0, 2000).trim();
  if (!comment) return res.status(400).json({ success: false, msg: 'コメント必須' });
  const db = getDb();
  const a = db.prepare('SELECT status FROM wellness_actions WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  // 中間: 推進確定〜役員決済の間で受付
  if (!['推進確定', '保健師中間'].includes(a.status)) {
    return res.status(400).json({ success: false, msg: '今は中間レビューの段階ではありません (現在: ' + a.status + ')' });
  }
  db.prepare(`UPDATE wellness_actions SET nurse_mid_comment = ?, nurse_mid_by = ?, nurse_mid_at = datetime('now'), status = '保健師中間' WHERE id = ?`)
    .run(comment, req.uid, id);
  res.json({ success: true });
});

// 保健師(最終)レビュー
router.post('/actions/:id/nurse-final', authUser, express.json(), (req, res) => {
  const u = getDb().prepare('SELECT is_guest_reviewer, employee_type FROM users WHERE id = ?').get(req.uid);
  if (!u || (!u.is_guest_reviewer && u.employee_type !== 'admin')) return res.status(403).json({ success: false, msg: '保健師(ゲストレビュアー)権限が必要です' });
  const id = parseInt(req.params.id);
  const comment = String((req.body && req.body.comment) || '').slice(0, 2000).trim();
  if (!comment) return res.status(400).json({ success: false, msg: 'コメント必須' });
  const db = getDb();
  const a = db.prepare('SELECT status FROM wellness_actions WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!['投票中', '保健師最終'].includes(a.status)) {
    return res.status(400).json({ success: false, msg: '今は最終レビューの段階ではありません (現在: ' + a.status + ')' });
  }
  db.prepare(`UPDATE wellness_actions SET nurse_final_comment = ?, nurse_final_by = ?, nurse_final_at = datetime('now'), status = '保健師最終' WHERE id = ?`)
    .run(comment, req.uid, id);
  res.json({ success: true });
});

// 役員決済 (employee_type='admin' = 管理職を役員とみなす)
router.post('/actions/:id/exec-approve', authUser, (req, res) => {
  if (!isWellnessManager(req.uid)) return res.status(403).json({ success: false, msg: '役員(管理職)権限が必要です' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT status, nurse_mid_comment FROM wellness_actions WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (a.status !== '保健師中間') return res.status(400).json({ success: false, msg: '保健師中間レビュー後にのみ決済できます' });
  if (!a.nurse_mid_comment) return res.status(400).json({ success: false, msg: '保健師中間コメントが未入力です' });
  db.prepare(`UPDATE wellness_actions SET executive_approver_id = ?, executive_approved_at = datetime('now'), status = '役員決済' WHERE id = ?`)
    .run(req.uid, id);
  res.json({ success: true });
});

// 投票開始 (役員決済→投票中、自動で7日後締切のスケジュール記録)
router.post('/actions/:id/start-vote', authUser, (req, res) => {
  if (!isWellnessManager(req.uid)) return res.status(403).json({ success: false, msg: '役員(管理職)権限が必要です' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT status FROM wellness_actions WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (a.status !== '役員決済') return res.status(400).json({ success: false, msg: '役員決済後にのみ投票開始できます' });
  db.prepare("UPDATE wellness_actions SET status = '投票中', vote_started_at = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
});

// 社員投票 (1〜5点) — 認証済全員
router.post('/actions/:id/vote', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const score = parseInt(req.body && req.body.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) return res.status(400).json({ success: false, msg: '点数は1〜5' });
  const comment = String((req.body && req.body.comment) || '').slice(0, 500);
  const db = getDb();
  const a = db.prepare('SELECT status, vote_started_at FROM wellness_actions WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (a.status !== '投票中') return res.status(400).json({ success: false, msg: '投票期間ではありません' });
  // 期間チェック (7日)
  if (a.vote_started_at) {
    const elapsedMs = Date.now() - new Date(a.vote_started_at + 'Z').getTime();
    if (elapsedMs > VOTING_DAYS * 24 * 3600 * 1000) {
      return res.status(400).json({ success: false, msg: '投票期間は終了しました' });
    }
  }
  db.prepare(`INSERT INTO wellness_action_votes (action_id, user_id, score, comment) VALUES (?, ?, ?, ?)
    ON CONFLICT(action_id, user_id) DO UPDATE SET score = excluded.score, comment = excluded.comment, created_at = datetime('now')`)
    .run(id, req.uid, score, comment);
  res.json({ success: true });
});

// 投票結果集計 (誰でも閲覧可、結果は集計のみ・個人名は推進+管理のみ)
router.get('/actions/:id/votes', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const canSeeNames = canEditActions(req);
  const summary = db.prepare(`SELECT
    COUNT(*) AS total,
    AVG(score) AS avg_score,
    SUM(CASE WHEN score >= 4 THEN 1 ELSE 0 END) AS pos_count,
    SUM(CASE WHEN score = 3 THEN 1 ELSE 0 END) AS neutral_count,
    SUM(CASE WHEN score <= 2 THEN 1 ELSE 0 END) AS neg_count
    FROM wellness_action_votes WHERE action_id = ?`).get(id);
  let votes = [];
  if (canSeeNames) {
    votes = db.prepare(`SELECT v.score, v.comment, v.created_at, u.display_name, u.company_code
      FROM wellness_action_votes v LEFT JOIN users u ON u.id = v.user_id
      WHERE v.action_id = ? ORDER BY v.created_at DESC`).all(id);
  }
  res.json({ success: true, summary, votes, can_see_names: canSeeNames });
});

// 投票締切 (手動 or CRONから) — 賛成>反対なら採用→保健師最終へ、そうでなければ却下
router.post('/actions/:id/close-vote', authUser, (req, res) => {
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT status FROM wellness_actions WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (a.status !== '投票中') return res.status(400).json({ success: false, msg: '投票中ではありません' });
  const sm = db.prepare(`SELECT COUNT(*) AS total, AVG(score) AS avg_score,
    SUM(CASE WHEN score >= 4 THEN 1 ELSE 0 END) AS pos,
    SUM(CASE WHEN score <= 2 THEN 1 ELSE 0 END) AS neg
    FROM wellness_action_votes WHERE action_id = ?`).get(id);
  const passed = (sm.pos || 0) > (sm.neg || 0);
  const result = { total: sm.total||0, avg: sm.avg_score, pos: sm.pos||0, neg: sm.neg||0, passed };
  if (passed) {
    db.prepare(`UPDATE wellness_actions SET status = '保健師最終', vote_closed_at = datetime('now'), vote_result_json = ? WHERE id = ?`)
      .run(JSON.stringify(result), id);
  } else {
    db.prepare(`UPDATE wellness_actions SET status = '却下', vote_closed_at = datetime('now'), vote_result_json = ?, rejection_reason = '社員投票で賛成が反対を超えませんでした' WHERE id = ?`)
      .run(JSON.stringify(result), id);
  }
  res.json({ success: true, result });
});

// 投票中の施策一覧 (社員向け、ロビー/wellness.html で表示用)
router.get('/voting-actions', authUser, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT a.id, a.title, a.description, a.category, a.vote_started_at,
    (SELECT COUNT(*) FROM wellness_action_votes WHERE action_id = a.id) AS vote_count,
    (SELECT score FROM wellness_action_votes WHERE action_id = a.id AND user_id = ?) AS my_score
    FROM wellness_actions a WHERE a.status = '投票中' ORDER BY a.vote_started_at DESC`).all(req.uid);
  // 残り日数
  const now = Date.now();
  for (const r of rows) {
    if (r.vote_started_at) {
      const elapsedMs = now - new Date(r.vote_started_at + 'Z').getTime();
      r.days_left = Math.max(0, VOTING_DAYS - Math.floor(elapsedMs / (24 * 3600 * 1000)));
    } else {
      r.days_left = VOTING_DAYS;
    }
  }
  res.json({ success: true, voting_days: VOTING_DAYS, actions: rows });
});

// =============================================================
// 一般投稿/食事投稿 への 推進メンバーコメント (3つの柱の右側コメント機構)
// AI凝縮の補強材料として利用
// =============================================================
router.get('/plaza-comments/:postId', authUser, (req, res) => {
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '推進メンバー権限が必要です' });
  const postId = parseInt(req.params.postId);
  const rows = getDb().prepare(`SELECT c.id, c.content, c.created_at, c.author_id, COALESCE(u.display_name, '不明') AS author_name
    FROM plaza_post_promoter_comments c LEFT JOIN users u ON u.id = c.author_id
    WHERE c.post_id = ? AND c.deleted_at IS NULL ORDER BY c.id ASC LIMIT 100`).all(postId);
  res.json({ success: true, comments: rows });
});

router.post('/plaza-comments/:postId', authUser, express.json(), (req, res) => {
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '推進メンバー権限が必要です' });
  const postId = parseInt(req.params.postId);
  const content = String((req.body && req.body.content) || '').slice(0, 1000).trim();
  if (!content) return res.status(400).json({ success: false, msg: 'コメント必須' });
  const ins = getDb().prepare('INSERT INTO plaza_post_promoter_comments (post_id, author_id, content) VALUES (?, ?, ?)').run(postId, req.uid, content);
  res.json({ success: true, id: ins.lastInsertRowid });
});

router.delete('/plaza-comments/:id', authUser, (req, res) => {
  if (!canEditActions(req)) return res.status(403).json({ success: false, msg: '推進メンバー権限が必要です' });
  const id = parseInt(req.params.id);
  const db = getDb();
  const c = db.prepare('SELECT author_id FROM plaza_post_promoter_comments WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!c) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (c.author_id !== req.uid && !isWellnessManager(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  db.prepare("UPDATE plaza_post_promoter_comments SET deleted_at = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
});

// =============================================================
// 聞き取りカードPOST (2026-05-08)
// 推進メンバーが点呼/朝礼・昼礼で目の前の相手を聞き取った結果をPOST
// =============================================================

// GET /api/wellness/subjects
// 聞き取り対象のメンバー一覧 (同じ会社コード、bot/ゲスト/自分は除外)
router.get('/subjects', authUser, (req, res) => {
  // 記録権限(推進/管理職/admin/運行管理者/所長副所長)を判定
  const scope = getListeningScope(req.uid);
  if (!scope.allowed) {
    return res.status(403).json({ success: false, msg: '聞き取り記録の権限がありません' });
  }
  const db = getDb();
  const companyCode = scope.companyCode;
  // 横断担当(推進/管理職/admin)=全拠点、現場担当(運行管理者/所長副所長)=自拠点のみ
  const siteFilter = scope.crossSite ? '' : ' AND u.company_code = @cc ';
  const rows = db.prepare(`
    SELECT u.id, u.login_id, u.display_name, u.company_code, u.employee_type,
           u.job_role, u.is_manager, u.avatar_url,
           wp.created_at AS last_post_at,
           wp.urgency AS last_urgency,
           wp.category AS last_category
    FROM users u
    LEFT JOIN (
      SELECT subject_user_id, MAX(id) AS max_id
      FROM wellness_posts
      WHERE source_type = '聞き取り' AND subject_user_id IS NOT NULL
      GROUP BY subject_user_id
    ) mx ON mx.subject_user_id = u.id
    LEFT JOIN wellness_posts wp ON wp.id = mx.max_id
    WHERE u.role != 'bot'
      AND u.id != @uid
      AND u.is_guest_reviewer = 0
      ${siteFilter}
    ORDER BY u.company_code, u.display_name
  `).all({ uid: req.uid, cc: companyCode });
  res.json({ success: true, subjects: rows, company_code: companyCode, cross_site: scope.crossSite, primary_role: scope.primaryRole });
});

// POST /api/wellness/post-card  聞き取りカードPOST (統合版: 職種区別なし)
// body: { subject_user_id, answers: {...}, memo, source_type? }
router.post('/post-card', authUser, express.json(), (req, res) => {
  // 記録権限(推進/管理職/admin/運行管理者/所長副所長)を判定
  const scope = getListeningScope(req.uid);
  if (!scope.allowed) {
    return res.status(403).json({ success: false, msg: '聞き取り記録の権限がありません' });
  }
  const body = req.body || {};
  const sourceType = '聞き取り';  // 統合後は固定値
  const subjectUserId = String(body.subject_user_id || '').trim();
  const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
  const memo = String(body.memo || '').slice(0, 200).trim();
  if (!subjectUserId) return res.status(400).json({ success: false, msg: '対象者を選択してください' });

  const db = getDb();
  const subject = db.prepare('SELECT id, display_name, company_code FROM users WHERE id = ?').get(subjectUserId);
  if (!subject) return res.status(404).json({ success: false, msg: '対象者が見つかりません' });
  // 自拠点担当(運行管理者/所長副所長)は自拠点メンバーのみ記録可
  if (!scope.crossSite && (subject.company_code || '') !== scope.companyCode) {
    return res.status(403).json({ success: false, msg: '自拠点のメンバーのみ記録できます' });
  }
  const poster = db.prepare('SELECT id, display_name, company_code FROM users WHERE id = ?').get(req.uid);

  // カード回答の値検証
  const conf = CARD_OPTIONS[sourceType];
  const cleanAnswers = {};
  for (const f of conf.fields) {
    const v = answers[f.key];
    if (!v) continue;
    const valid = f.options.some(o => o.v === v);
    if (valid) cleanAnswers[f.key] = v;
  }
  const { urgency, category } = deriveCardSummary(sourceType, cleanAnswers);
  const identityMode = '本人特定可';
  const structuredJson = JSON.stringify(cleanAnswers);

  const ins = db.prepare(`INSERT INTO wellness_posts
    (poster_id, company_code, category, urgency, identity_mode, memo, source_type, subject_user_id, structured_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(poster.id, poster.company_code || '', category, urgency, identityMode, memo, sourceType, subject.id, structuredJson);
  const postId = ins.lastInsertRowid;

  // GC配信メッセージ
  const urgencyMark = urgency === '高' ? '🔴' : urgency === '中' ? '🟡' : '🟢';
  const sourceMark = '🩺';
  const lines = [
    `${sourceMark} #${postId} 聞き取り ${urgencyMark}${urgency} / ${category}`,
    `対象: ${subject.display_name} (${subject.company_code || '-'})`,
    `聞き取り: ${poster.display_name}`,
  ];
  const answerLines = [];
  for (const f of conf.fields) {
    const v = cleanAnswers[f.key];
    if (v) answerLines.push(`${f.label}: ${v}`);
  }
  if (answerLines.length) lines.push('─', ...answerLines);
  if (memo) lines.push('─ メモ ─', memo);
  const content = lines.join('\n');

  const targetGroupId = PROMOTER_GROUP_ID;  // 運管/倉庫いずれも g_field_voice に集約
  const roomCode = 'grp_' + targetGroupId;
  const msgIns = db.prepare(`INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, NULL, ?, ?)`)
    .run(poster.id, content, roomCode);

  const payload = {
    id: msgIns.lastInsertRowid,
    from: poster.id,
    group_id: targetGroupId,
    content,
    at: new Date().toISOString(),
    attach: null,
  };
  if (req.app && req.app.locals && req.app.locals.emitToGroupMembers) {
    req.app.locals.emitToGroupMembers(targetGroupId, 'group:msg', payload);
  }
  // Push通知
  try {
    const members = db.prepare('SELECT user_id FROM chat_group_members WHERE group_id = ?').all(targetGroupId);
    const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (sendPush) {
      for (const m of members) {
        if (m.user_id === poster.id) continue;
        sendPush(m.user_id, {
          title: `${sourceMark} 聞き取り [${category}]`,
          body: `${subject.display_name}: ${urgencyMark}${urgency}` + (memo ? ' / ' + memo : ''),
          tag: 'wellness-card-' + postId,
          url: '/?g=' + targetGroupId,
        }).catch(() => {});
      }
    }
  } catch (e) {}

  res.json({ success: true, post_id: postId, group_id: targetGroupId, urgency, category });
});

// =============================================================
// 推進メンバー共有スケジュール (2026-05-20)
// 推進メンバー (運管/倉庫) + admin が自由に起票してガントチャート共有
// =============================================================

function canEditSchedule(uid) {
  return isFieldPromoter(uid) || isWarehousePromoter(uid) || isWellnessManager(uid);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCHED_STATUSES = ['planned', 'in_progress', 'done'];

// GET /api/wellness/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/schedule', authUser, (req, res) => {
  if (!canEditSchedule(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const from = req.query.from;
  const to = req.query.to;
  let sql = `SELECT s.id, s.title, s.description, s.start_date, s.end_date,
                    s.owner_id, s.color, s.status, s.created_by, s.created_at, s.updated_at,
                    u.display_name AS owner_name, u.avatar_url AS owner_avatar,
                    c.display_name AS creator_name
             FROM wellness_schedule s
             LEFT JOIN users u ON u.id = s.owner_id
             LEFT JOIN users c ON c.id = s.created_by`;
  const params = [];
  if (from && to && DATE_RE.test(from) && DATE_RE.test(to)) {
    sql += ' WHERE NOT (s.end_date < ? OR s.start_date > ?)';
    params.push(from, to);
  }
  sql += ' ORDER BY s.start_date ASC, s.id ASC';
  const items = getDb().prepare(sql).all(...params);
  res.json({ success: true, items });
});

// GET /api/wellness/schedule/members  担当者選択肢
router.get('/schedule/members', authUser, (req, res) => {
  if (!canEditSchedule(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const members = getDb().prepare(`
    SELECT id, display_name, avatar_url, company_code
    FROM users
    WHERE (is_field_promoter = 1 OR is_warehouse_promoter = 1 OR employee_type = 'admin')
      AND role != 'bot'
    ORDER BY display_name ASC
  `).all();
  res.json({ success: true, members });
});

function parseSchedBody(b, base) {
  base = base || {};
  const out = {};
  const title = b.title !== undefined ? String(b.title || '').trim() : base.title;
  if (!title) return { error: 'タイトル必須' };
  out.title = title.slice(0, 80);
  out.description = b.description !== undefined ? String(b.description || '').slice(0, 500) : (base.description || '');
  const start_date = b.start_date !== undefined ? String(b.start_date || '').trim() : base.start_date;
  const end_date = b.end_date !== undefined ? String(b.end_date || '').trim() : base.end_date;
  if (!DATE_RE.test(start_date) || !DATE_RE.test(end_date)) return { error: '日付形式が不正 (YYYY-MM-DD)' };
  if (end_date < start_date) return { error: '終了日が開始日より前になっています' };
  out.start_date = start_date;
  out.end_date = end_date;
  out.owner_id = b.owner_id !== undefined ? (b.owner_id ? String(b.owner_id) : null) : (base.owner_id || null);
  const color = b.color !== undefined ? String(b.color || '').trim() : (base.color || '#3b82f6');
  out.color = /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#3b82f6';
  const status = b.status !== undefined ? String(b.status || '') : (base.status || 'planned');
  out.status = SCHED_STATUSES.includes(status) ? status : 'planned';
  return { value: out };
}

// POST /api/wellness/schedule
router.post('/schedule', authUser, express.json(), (req, res) => {
  if (!canEditSchedule(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const parsed = parseSchedBody(req.body || {});
  if (parsed.error) return res.status(400).json({ success: false, msg: parsed.error });
  const v = parsed.value;
  const r = getDb().prepare(`
    INSERT INTO wellness_schedule (title, description, start_date, end_date, owner_id, color, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(v.title, v.description, v.start_date, v.end_date, v.owner_id, v.color, v.status, req.uid);
  res.json({ success: true, id: r.lastInsertRowid });
});

// PUT /api/wellness/schedule/:id
router.put('/schedule/:id', authUser, express.json(), (req, res) => {
  if (!canEditSchedule(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id, 10);
  const row = getDb().prepare('SELECT * FROM wellness_schedule WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ success: false, msg: 'not found' });
  const parsed = parseSchedBody(req.body || {}, row);
  if (parsed.error) return res.status(400).json({ success: false, msg: parsed.error });
  const v = parsed.value;
  getDb().prepare(`
    UPDATE wellness_schedule
    SET title = ?, description = ?, start_date = ?, end_date = ?, owner_id = ?, color = ?, status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(v.title, v.description, v.start_date, v.end_date, v.owner_id, v.color, v.status, id);
  res.json({ success: true });
});

// DELETE /api/wellness/schedule/:id
router.delete('/schedule/:id', authUser, (req, res) => {
  if (!canEditSchedule(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id, 10);
  getDb().prepare('DELETE FROM wellness_schedule WHERE id = ?').run(id);
  res.json({ success: true });
});

module.exports = router;
