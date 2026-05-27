// 健康管理室 個人アクションプラン API
// 樹形図相談 (Layer1→2→3+自由記述) → AI生成 → DB保存 → 表示
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateActionPlan, generateDialogStep, generateDailyReply } = require('../services/ai');
const { BASIC_PLANS, CATEGORY_META, PERIOD_OPTIONS, findById: findBasicPlan } = require('../data/basic_plans');

router.use(express.json());

// 推進メンバー / 管理者ガード
function authPromoter(req, res, next) {
  authUser(req, res, () => {
    const u = getDb().prepare("SELECT is_field_promoter, employee_type, role FROM users WHERE id = ?").get(req.uid);
    if (!u) return res.status(401).json({ success: false, msg: 'ユーザー不明' });
    if (u.is_field_promoter || u.employee_type === 'admin' || u.role === 'admin') return next();
    return res.status(403).json({ success: false, msg: '推進メンバー権限が必要です' });
  });
}

// Layer1 key → 集計カテゴリ ('move' / 'meal' / 'sleep' / 'drink' / 'check' / 'belly' / 'tired' / 'stair' / 'med' / 'other')
function topCategoryOf(selections) {
  const l1 = (selections || []).find(s => s && s.layer === 1);
  return (l1 && l1.key) || 'other';
}
function categoryLabel(cat) {
  const M = { move: '🏃 運動', meal: '🍱 食事改善', drink: '🍺 お酒', sleepy: '😴 眠気', tired: '🛌 疲労回復', stair: '🚶 体力', belly: '🫃 お腹周り', check: '🩺 健診結果', med: '💊 薬・サプリ', other: '💬 その他相談' };
  return M[cat] || M.other;
}

// 健康アドバイザー (bot_health) からのDM送信ヘルパー
// content をテンプレ生成し messages テーブルに INSERT + 受信者ソケットに emit
function sendHealthAdvisorDm(req, toUid, content) {
  try {
    const db = getDb();
    const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES ('bot_health', ?, ?, 'dm')")
      .run(toUid, content);
    const payload = {
      id: ins.lastInsertRowid,
      from: 'bot_health',
      to: toUid,
      content,
      at: new Date().toISOString(),
      attach: null,
    };
    // ソケット配信 (オンラインなら即時)
    const emit = req.app && req.app.locals && req.app.locals.emitToUser;
    if (emit) emit(toUid, 'dm:msg', payload);
    // Push通知 (オフライン対応)
    const push = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (push) push(toUid, {
      title: '🩺 ヘルスアドバイザー',
      body: content.slice(0, 80),
      tag: 'health-buddy-' + toUid,
      url: '/myplan.html',
    }).catch(() => {});
    return true;
  } catch (e) { console.warn('[sendHealthAdvisorDm] fail:', e.message); return false; }
}

// 過去7日の食事ログを集計 (plaza_posts 本人 + cw_posts CoWell Classic ミラー)
function collectRecentMeals(uid) {
  const db = getDb();
  const rows = [];
  try {
    const r1 = db.prepare(`SELECT created_at AS ts, nutrition_scores AS ns FROM plaza_posts
      WHERE author_id=? AND category='食事' AND nutrition_scores IS NOT NULL AND deleted_at IS NULL
      AND created_at >= datetime('now','-7 days')
      ORDER BY created_at DESC LIMIT 7`).all(uid);
    rows.push(...r1);
  } catch (e) {}
  try {
    const cwIds = db.prepare(`SELECT cw_id FROM cw_users WHERE cohub_uid=?`).all(uid).map(r => r.cw_id);
    if (cwIds.length) {
      const ph = cwIds.map(() => '?').join(',');
      const r2 = db.prepare(`SELECT cw_created_at AS ts, nutrition_scores AS ns FROM cw_posts
        WHERE cw_user_id IN (${ph}) AND category LIKE '%食事%' AND nutrition_scores IS NOT NULL
        AND cw_created_at >= datetime('now','-7 days')
        ORDER BY cw_created_at DESC LIMIT 7`).all(...cwIds);
      rows.push(...r2);
    }
  } catch (e) {}
  rows.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const summarize = (ns) => {
    let s; try { s = typeof ns === 'string' ? JSON.parse(ns) : ns; } catch { return null; }
    const v = (k) => { const x = s && s[k]; return (x && typeof x === 'object') ? Number(x.value) : (typeof x === 'number' ? x : 0); };
    return { kcal: v('calories'), protein: v('protein'), fat: v('fat'), carbs: v('carbs'), veg: v('vitamin'), ca: v('mineral'), salt: v('salt'), fiber: v('fiber'), alc: v('alcohol') };
  };
  const result = [];
  for (const r of rows) {
    const sm = summarize(r.ns);
    if (!sm) continue;
    result.push({ date: (r.ts || '').slice(0, 10), ...sm });
    if (result.length >= 7) break;
  }
  return result;
}

// 直近5回の血圧記録
function collectRecentBP(uid) {
  const db = getDb();
  try {
    const rows = db.prepare(`SELECT systolic AS sys, diastolic AS dia, pulse, measured_at, created_at
      FROM bp_records WHERE user_id=? ORDER BY COALESCE(measured_at, created_at) DESC LIMIT 5`).all(uid);
    return rows.map(r => ({ date: (r.measured_at || r.created_at || '').slice(0, 10), sys: r.sys, dia: r.dia, pulse: r.pulse }));
  } catch (e) { return []; }
}

// 運動意欲フラグ判定 (selections + free_text から)
function detectMovementPriority(selections, freeText) {
  const sels = (Array.isArray(selections) ? selections : []);
  const moveKeys = /^(move_|exercise_|jog|kintore|walk|stretch|bike|stair|posture|workout)/i;
  const moveLabels = /(運動|歩|ジョグ|ジョギング|筋トレ|ストレッチ|体操|スポーツ|ヨガ|サイクリング|自転車|階段|散歩)/;
  for (const s of sels) {
    if (s.layer === 1 && (s.key === 'move' || /運動|動きたい/.test(s.label || ''))) return true;
    if (moveKeys.test(s.key || '')) return true;
    if (moveLabels.test(s.label || '')) return true;
  }
  if (freeText && /(運動|動きたい|痩せたい|歩きたい|筋トレ|ジムに?行|ジョギング|散歩)/.test(freeText)) return true;
  return false;
}

// 相談実行: 選択肢+自由記述+コンテキストでAIアクションプラン生成 → DB保存 → bot_healthからDM
router.post('/consult', authUser, async (req, res) => {
  const selections = Array.isArray(req.body && req.body.selections) ? req.body.selections : [];
  const freeText = String((req.body && req.body.free_text) || '').slice(0, 1000).trim();
  const sharePublicly = !!(req.body && req.body.share_publicly);
  if (!selections.length && !freeText) {
    return res.status(400).json({ success: false, msg: '選択または自由記述が必要です' });
  }
  const movementPriority = detectMovementPriority(selections, freeText);
  const categoryTop = topCategoryOf(selections);
  const context = {
    recent_meals_7d: collectRecentMeals(req.uid),
    bp_recent: collectRecentBP(req.uid),
  };
  console.log(`[myplan] consult uid=${req.uid} sels=${selections.length} free=${freeText.length} move=${movementPriority} cat=${categoryTop} share=${sharePublicly}`);
  let plan;
  try {
    plan = await generateActionPlan(selections, freeText, context, movementPriority);
  } catch (e) {
    console.warn('[myplan] AI fail:', e.message);
    return res.status(502).json({ success: false, msg: 'AI生成に失敗しました。少し時間を置いて再試行してください' });
  }
  const kpiJson = (() => { try { return JSON.stringify(plan.plan_kpi || []); } catch { return '[]'; } })();
  const db = getDb();
  const ins = db.prepare(`INSERT INTO myplan_consultations
    (user_id, selections_json, free_text, movement_priority, category_top, share_publicly, share_opted_at,
     plan_now, plan_today, plan_week, plan_month, plan_kpi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.uid, JSON.stringify(selections), freeText || null, movementPriority ? 1 : 0,
    categoryTop, sharePublicly ? 1 : 0, sharePublicly ? new Date().toISOString() : null,
    String(plan.plan_now || '').slice(0, 800),
    String(plan.plan_today || '').slice(0, 600),
    String(plan.plan_week || '').slice(0, 800),
    String(plan.plan_month || '').slice(0, 800),
    kpiJson
  );
  // 公開時は pioneer_count をインクリメント (累積バッジ)
  if (sharePublicly) {
    db.prepare("UPDATE users SET pioneer_count = COALESCE(pioneer_count,0) + 1 WHERE id = ?").run(req.uid);
  }
  const saved = db.prepare(`SELECT * FROM myplan_consultations WHERE id=?`).get(ins.lastInsertRowid);

  // 健康アドバイザーから DM 励まし送信
  setTimeout(() => {
    try {
      const u = db.prepare("SELECT display_name, nickname, pioneer_count FROM users WHERE id = ?").get(req.uid);
      const name = (u && (u.nickname || u.display_name)) || 'あなた';
      const catLbl = categoryLabel(categoryTop);
      const todayShort = String(plan.plan_today || '').slice(0, 60).replace(/\n/g, ' ');
      let msg = `🩺 ${name}さん、相談ありがとう。${catLbl} のプランを一緒に考えたよ。\n\n` +
        `まずは今日「${todayShort}…」から始めてみよう。途中で迷ったらいつでも私のところに来てね。`;
      if (sharePublicly) {
        const cnt = (u && u.pioneer_count) || 1;
        msg += `\n\n✨ 仲間に共有してくれてありがとう! ${cnt}人目の "先駆者" として表示されるよ。あなたの一歩が、誰かの背中を押すかもしれない。`;
      }
      sendHealthAdvisorDm(req, req.uid, msg);
    } catch (e) { console.warn('[buddy DM] fail:', e.message); }
  }, 500);

  res.json({ success: true, plan: hydrate(saved) });
});

// 履歴: 直近10件
router.get('/list', authUser, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM myplan_consultations WHERE user_id=? ORDER BY id DESC LIMIT 10`).all(req.uid);
  res.json({ success: true, plans: rows.map(hydrate) });
});

// 最新1件
router.get('/latest', authUser, (req, res) => {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM myplan_consultations WHERE user_id=? ORDER BY id DESC LIMIT 1`).get(req.uid);
  res.json({ success: true, plan: row ? hydrate(row) : null });
});

// 今日のアクション完了マーク (トグル) → バディーから応援DM
router.post('/done/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const row = db.prepare(`SELECT id, user_id, today_done_at, plan_today, category_top FROM myplan_consultations WHERE id=?`).get(id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (row.user_id !== req.uid) return res.status(403).json({ success: false, msg: '本人のみ操作可' });
  const wasDone = !!row.today_done_at;
  const newDone = wasDone ? null : new Date().toISOString();
  db.prepare(`UPDATE myplan_consultations SET today_done_at=? WHERE id=?`).run(newDone, id);
  // 完了したタイミングだけバディーから応援DM (取消時は静かに)
  if (!wasDone) {
    setTimeout(() => {
      try {
        const u = db.prepare("SELECT display_name, nickname FROM users WHERE id = ?").get(req.uid);
        const name = (u && (u.nickname || u.display_name)) || 'あなた';
        // 連続完了日数を簡易カウント (直近7日のうち今日のアクション完了したプラン数)
        const streak = db.prepare(`SELECT COUNT(*) AS n FROM myplan_consultations
          WHERE user_id=? AND today_done_at IS NOT NULL
          AND date(today_done_at) >= date('now','-7 days')`).get(req.uid).n;
        const msgs = [
          `🎉 ${name}さん、今日のアクション完了お疲れさま! 小さな一歩がいちばん大きいよ。`,
          `✨ ${name}さん、やったね! ${streak}回目の完了になるよ。続けてる感覚、大事にしようね。`,
          `🌱 ${name}さんの一歩、しっかり見届けたよ。明日もマイペースでいこう。`,
        ];
        const msg = msgs[Math.min(streak - 1, msgs.length - 1)] || msgs[0];
        sendHealthAdvisorDm(req, req.uid, msg);
      } catch (e) {}
    }, 300);
  }
  res.json({ success: true, today_done_at: newDone });
});

// 公開設定トグル (myplan.html から後付け opt-in 可能)
router.post('/share/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const row = db.prepare(`SELECT id, user_id, share_publicly FROM myplan_consultations WHERE id=?`).get(id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (row.user_id !== req.uid) return res.status(403).json({ success: false, msg: '本人のみ操作可' });
  const newShare = row.share_publicly ? 0 : 1;
  db.prepare(`UPDATE myplan_consultations SET share_publicly=?, share_opted_at=? WHERE id=?`)
    .run(newShare, newShare ? new Date().toISOString() : null, id);
  if (newShare) {
    db.prepare("UPDATE users SET pioneer_count = COALESCE(pioneer_count,0) + 1 WHERE id = ?").run(req.uid);
  } else {
    db.prepare("UPDATE users SET pioneer_count = MAX(0, COALESCE(pioneer_count,0) - 1) WHERE id = ?").run(req.uid);
  }
  res.json({ success: true, share_publicly: !!newShare });
});

// 全員向け匿名集計 + 公開ニックネーム配信フィード
// 過去7日のカテゴリ別件数 + 公開設定済みの直近10件 (ニックネーム表示)
router.get('/feed', authUser, (req, res) => {
  const db = getDb();
  // 集計 (過去7日、本人以外も含む全社)
  // ホワイトボード掲示は "人数" (DISTINCT user_id) で集計。同一人物の複数回相談を1名としてカウント。
  const stats = db.prepare(`SELECT category_top AS cat, COUNT(DISTINCT user_id) AS n FROM myplan_consultations
    WHERE created_at >= datetime('now','-7 days') AND category_top IS NOT NULL
    GROUP BY category_top ORDER BY n DESC`).all();
  const todayDone = db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM myplan_consultations
    WHERE today_done_at IS NOT NULL AND date(today_done_at) = date('now','localtime')`).get().n || 0;
  const totalThisWeek = stats.reduce((s, r) => s + r.n, 0);
  // 先駆者 (公開設定済み、本人以外、直近10件)
  const pioneers = db.prepare(`SELECT m.id, m.category_top, m.created_at,
      u.nickname, u.display_name, u.pioneer_count
    FROM myplan_consultations m JOIN users u ON u.id = m.user_id
    WHERE m.share_publicly = 1 AND m.user_id != ?
    AND m.created_at >= datetime('now','-14 days')
    ORDER BY m.id DESC LIMIT 10`).all(req.uid);
  res.json({
    success: true,
    week_total: totalThisWeek,
    today_done: todayDone,
    by_category: stats.map(r => ({ key: r.cat, label: categoryLabel(r.cat), count: r.n })),
    pioneers: pioneers.map(p => ({
      id: p.id,
      name: p.nickname || p.display_name || '匿名',
      category: p.category_top,
      category_label: categoryLabel(p.category_top),
      pioneer_count: p.pioneer_count || 1,
      at: p.created_at,
    })),
  });
});

// 推進メンバー専用: 全社プラン一覧 + 個人別集計 (ロビー左レール からアクセス)
router.get('/admin/list', authPromoter, (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows = db.prepare(`SELECT m.id, m.user_id, m.category_top, m.movement_priority, m.share_publicly,
      m.plan_now, m.plan_today, m.today_done_at, m.created_at,
      u.display_name, u.nickname, u.company_code, u.employee_type, u.pioneer_count
    FROM myplan_consultations m JOIN users u ON u.id = m.user_id
    ORDER BY m.id DESC LIMIT ?`).all(limit);
  // 集計
  const cat7 = db.prepare(`SELECT category_top, COUNT(*) AS n FROM myplan_consultations
    WHERE created_at >= datetime('now','-7 days') GROUP BY category_top ORDER BY n DESC`).all();
  const cat30 = db.prepare(`SELECT category_top, COUNT(*) AS n FROM myplan_consultations
    WHERE created_at >= datetime('now','-30 days') GROUP BY category_top ORDER BY n DESC`).all();
  const userCount = db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM myplan_consultations`).get().n;
  const completionRate = (() => {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM myplan_consultations
      WHERE created_at >= datetime('now','-7 days')`).get().n;
    const done = db.prepare(`SELECT COUNT(*) AS n FROM myplan_consultations
      WHERE created_at >= datetime('now','-7 days') AND today_done_at IS NOT NULL`).get().n;
    return total ? Math.round(done / total * 100) : 0;
  })();
  res.json({
    success: true,
    plans: rows.map(r => ({
      id: r.id,
      // 黒子型: 実名・所属・login_id は返さない。表示名は nickname のみ。
      name: r.nickname || '匿名',
      category: r.category_top,
      category_label: categoryLabel(r.category_top),
      movement_priority: !!r.movement_priority,
      share_publicly: !!r.share_publicly,
      pioneer_count: r.pioneer_count || 0,
      plan_now: r.plan_now,
      plan_today: r.plan_today,
      today_done: !!r.today_done_at,
      created_at: r.created_at,
    })),
    summary: {
      unique_users: userCount,
      cat_7d: cat7.map(r => ({ key: r.category_top, label: categoryLabel(r.category_top), count: r.n })),
      cat_30d: cat30.map(r => ({ key: r.category_top, label: categoryLabel(r.category_top), count: r.n })),
      completion_rate_7d: completionRate,
    },
  });
});

// 推進メンバーから個人へ励ましDM (黒子型 — 2026-05-27 個人特定事故を受け改修)
// ・送り主(推進メンバー)の実名は相手に一切出さず「推進メンバー」名義(bot_promoter)でリレー配信。
//   → 利用者は誰が励ましたか分からず「特定の同僚に見られている」感を抱かない。
// ・宛先は user_id(=UUID) ではなく plan_id で受け取り、個人IDをクライアントへ出さない。
// ・誰が送ったかの監査はサーバログ(journald)にのみ残す。
router.post('/admin/encourage', authPromoter, (req, res) => {
  const planId = parseInt((req.body && req.body.plan_id) || 0);
  const message = String((req.body && req.body.message) || '').slice(0, 500).trim();
  if (!planId || !message) return res.status(400).json({ success: false, msg: '宛先と本文が必要' });
  const db = getDb();
  const plan = db.prepare("SELECT user_id FROM myplan_active_plans WHERE id = ?").get(planId);
  if (!plan) return res.status(404).json({ success: false, msg: '宛先が見つかりません' });
  const toUid = plan.user_id;
  const content = `🩺 [健康管理室 推進メンバーより] ${message}`;
  const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES ('bot_promoter', ?, ?, 'dm')")
    .run(toUid, content);
  const payload = { id: ins.lastInsertRowid, from: 'bot_promoter', to: toUid, content, at: new Date().toISOString(), attach: null };
  const emit = req.app && req.app.locals && req.app.locals.emitToUser;
  if (emit) emit(toUid, 'dm:msg', payload);
  const push = req.app && req.app.locals && req.app.locals.sendPushToUser;
  if (push) push(toUid, { title: '🩺 健康管理室から', body: message.slice(0, 80), tag: 'wellness-dm', url: '/myplan.html' }).catch(() => {});
  console.log(`[myplan/encourage] promoter=${req.uid} -> plan=${planId} (推進メンバー名義でリレー)`);
  res.json({ success: true });
});

function hydrate(row) {
  if (!row) return null;
  let kpi = []; try { kpi = JSON.parse(row.plan_kpi || '[]'); } catch {}
  let sels = []; try { sels = JSON.parse(row.selections_json || '[]'); } catch {}
  return {
    id: row.id,
    selections: sels,
    free_text: row.free_text || '',
    movement_priority: !!row.movement_priority,
    category_top: row.category_top || null,
    share_publicly: !!row.share_publicly,
    share_opted_at: row.share_opted_at || null,
    plan_now: row.plan_now || '',
    plan_today: row.plan_today || '',
    plan_week: row.plan_week || '',
    plan_month: row.plan_month || '',
    plan_kpi: kpi,
    today_done_at: row.today_done_at || null,
    created_at: row.created_at,
  };
}

// ===== 対話型アクションプラン (Phase 1 — 2026-05-05) =====
// AIと数往復のやり取りで実行可能なアクションを共同決定。
// POST /api/myplan/dialog: { dialog_id?, seed_category?, user_reply? }
//   → AI次の応答 (質問+選択肢 or 最終提案)
// GET  /api/myplan/dialog/:id: 履歴取得
// POST /api/myplan/dialog/:id/finalize: 確定 → myplan_consultations 昇格

router.post('/dialog', authUser, async (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const seed = String(body.seed_category || '').slice(0, 20) || null;
  const reply = body.user_reply ? String(body.user_reply).slice(0, 500) : null;
  const replyValue = body.user_value ? String(body.user_value).slice(0, 50) : null;
  let dialog = null;
  let history = [];
  if (body.dialog_id) {
    dialog = db.prepare('SELECT * FROM myplan_dialogs WHERE id=?').get(body.dialog_id);
    if (!dialog) return res.status(404).json({ success: false, msg: '対話セッションが見つかりません' });
    if (dialog.user_id !== req.uid) return res.status(403).json({ success: false, msg: '本人のみ操作可' });
    if (dialog.status === 'finalized') return res.status(400).json({ success: false, msg: 'この対話は確定済みです' });
    try { history = JSON.parse(dialog.history_json || '[]'); } catch { history = []; }
  } else {
    const ins = db.prepare('INSERT INTO myplan_dialogs (user_id, seed_category, history_json) VALUES (?, ?, ?)').run(req.uid, seed, '[]');
    dialog = db.prepare('SELECT * FROM myplan_dialogs WHERE id=?').get(ins.lastInsertRowid);
  }
  // ユーザー回答を履歴に追加
  if (reply || replyValue) {
    history.push({ role: 'user', text: reply || replyValue, value: replyValue || null, ts: new Date().toISOString() });
  }
  // コンテキスト収集 (本人の食事/血圧+属性)
  const userRow = db.prepare('SELECT display_name, birth_date, employee_type FROM users WHERE id=?').get(req.uid) || {};
  let age = null;
  if (userRow.birth_date) {
    const by = parseInt((userRow.birth_date || '').slice(0, 4));
    if (by) age = new Date().getFullYear() - by;
  }
  const context = {
    recent_meals_7d: collectRecentMeals(req.uid),
    bp_recent: collectRecentBP(req.uid),
    user_attrs: { age, employee_type: userRow.employee_type || null },
    seed_category: dialog.seed_category,
  };
  let step;
  try {
    step = await generateDialogStep(history, context, {});
  } catch (e) {
    console.warn('[myplan/dialog] AI fail:', e.message);
    return res.status(502).json({ success: false, msg: 'AIとの対話に失敗しました。少し時間を置いて再試行を' });
  }
  // AI応答を履歴に追加
  history.push({ role: 'ai', text: step.ai_message || '', choices: step.choices || [], phase: step.phase, ts: new Date().toISOString() });
  // DB更新
  db.prepare('UPDATE myplan_dialogs SET history_json=? WHERE id=?').run(JSON.stringify(history), dialog.id);
  res.json({
    success: true,
    dialog_id: dialog.id,
    step,
    history_length: history.length,
  });
});

router.get('/dialog/:id', authUser, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM myplan_dialogs WHERE id=?').get(parseInt(req.params.id));
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (row.user_id !== req.uid) return res.status(403).json({ success: false, msg: '本人のみ閲覧可' });
  let history = []; try { history = JSON.parse(row.history_json || '[]'); } catch {}
  res.json({ success: true, dialog: {
    id: row.id, status: row.status, seed_category: row.seed_category,
    history, final_action: row.final_action, final_pattern: row.final_pattern,
    final_evidence: row.final_evidence, final_confidence: row.final_confidence,
    final_when: row.final_when, created_at: row.created_at, finalized_at: row.finalized_at,
  } });
});

// 確定: 対話の finalize 内容+ユーザー選択 (when, confidence) を保存し、myplan_consultations へ昇格
router.post('/dialog/:id/finalize', authUser, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const row = db.prepare('SELECT * FROM myplan_dialogs WHERE id=?').get(id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (row.user_id !== req.uid) return res.status(403).json({ success: false, msg: '本人のみ操作可' });
  if (row.status === 'finalized') return res.status(400).json({ success: false, msg: '確定済み' });
  const body = req.body || {};
  const action = String(body.action || '').slice(0, 800).trim();
  const pattern = String(body.pattern || '').slice(0, 20);
  const evidence = String(body.evidence || '').slice(0, 600);
  const confidence = parseInt(body.confidence) || null;
  const whenStr = String(body.when || '').slice(0, 50);
  if (!action) return res.status(400).json({ success: false, msg: 'アクション本文が必要です' });
  // myplan_consultations に昇格
  const consIns = db.prepare(`INSERT INTO myplan_consultations
    (user_id, selections_json, free_text, movement_priority, category_top, plan_now, plan_today, plan_week, plan_month, plan_kpi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.uid,
    JSON.stringify([{ layer: 1, key: row.seed_category || 'other', label: '対話確定' }]),
    null, 0, row.seed_category || 'other',
    `📍 ${pattern === 'reduce' ? '⬇️減らす' : pattern === 'stop' ? '🚫やめる' : pattern === 'swap' ? '🔄置換' : pattern === 'add' ? '➕加える' : '⏰タイミング'} の方針で確定 (自信度 ${confidence || '?'}/10)`,
    action,
    `継続: ${whenStr || '今日から'}・週次で振り返り`,
    `1ヶ月後にこの行動が習慣化しているか確認`,
    JSON.stringify([{ label: pattern, value: action }])
  );
  db.prepare(`UPDATE myplan_dialogs SET status='finalized', final_action=?, final_pattern=?, final_evidence=?, final_confidence=?, final_when=?, finalized_consultation_id=?, finalized_at=? WHERE id=?`)
    .run(action, pattern, evidence, confidence, whenStr, consIns.lastInsertRowid, new Date().toISOString(), id);
  // ヘルスアドバイザーから DM 励まし
  setTimeout(() => {
    try {
      const u = db.prepare("SELECT display_name, nickname FROM users WHERE id=?").get(req.uid);
      const name = (u && (u.nickname || u.display_name)) || 'あなた';
      const msg = `🩺 ${name}さん、今日のアクションが決まったね。\n\n「${action.slice(0, 80)}」\n\n${whenStr || '今日'} から少しずつ。途中で迷ったらいつでも私のところへ。`;
      sendHealthAdvisorDm(req, req.uid, msg);
    } catch (e) {}
  }, 300);
  res.json({ success: true, dialog_id: id, consultation_id: consIns.lastInsertRowid });
});

// ============================================================
// 個人プラン v2 (2026-05-20) — 15基本プラン × 期間選択 × カレンダー
// ============================================================

// 15基本プラン一覧 + ユーザーの初回完走状態 (期間ロック判定)
router.get('/basic_plans', authUser, (req, res) => {
  const db = getDb();
  const completedRow = db.prepare(
    `SELECT COUNT(*) AS n FROM myplan_active_plans WHERE user_id=? AND status='completed'`
  ).get(req.uid);
  const firstCycleDone = (completedRow.n || 0) > 0;
  res.json({
    success: true,
    plans: BASIC_PLANS,
    categories: CATEGORY_META,
    periods: PERIOD_OPTIONS,
    first_cycle_done: firstCycleDone,
    allowed_period_kinds: firstCycleDone ? ['starter', 'standard', 'long'] : ['starter'],
  });
});

// 現在のアクティブプラン + 全カレンダーログ + ストリーク + 残日数
router.get('/active', authUser, (req, res) => {
  const db = getDb();
  const plan = db.prepare(
    `SELECT * FROM myplan_active_plans WHERE user_id=? AND status='active' ORDER BY id DESC LIMIT 1`
  ).get(req.uid);
  if (!plan) return res.json({ success: true, plan: null });
  const logs = db.prepare(
    `SELECT log_date, status, comment, ai_reply, ai_axis_change FROM myplan_calendar_logs
     WHERE active_plan_id=? ORDER BY log_date ASC`
  ).all(plan.id);
  const stats = computeStats(plan, logs);
  res.json({ success: true, plan: hydrateActivePlan(plan, stats), logs });
});

// プラン開始 — active が既にあれば 409
router.post('/start', authUser, (req, res) => {
  const db = getDb();
  const basicId = String((req.body && req.body.basic_plan_id) || '');
  const periodDays = parseInt((req.body && req.body.period_days) || 0);
  const basic = findBasicPlan(basicId);
  if (!basic) return res.status(400).json({ success: false, msg: 'プランIDが不正です' });
  const periodOpt = PERIOD_OPTIONS.find(p => p.days === periodDays);
  if (!periodOpt) return res.status(400).json({ success: false, msg: '期間が不正です (3/7/14/30/90)' });
  // 初回完走前は starter(3日) 以外を拒否
  const completedN = db.prepare(
    `SELECT COUNT(*) AS n FROM myplan_active_plans WHERE user_id=? AND status='completed'`
  ).get(req.uid).n;
  if (!completedN && periodOpt.kind !== 'starter') {
    return res.status(400).json({ success: false, msg: 'まず3日プランから始めましょう (完走すると長期プランが開放されます)' });
  }
  // 既存activeあれば中止 → 新規開始 (軸変更運用)
  const existing = db.prepare(`SELECT id FROM myplan_active_plans WHERE user_id=? AND status='active'`).get(req.uid);
  if (existing) {
    db.prepare(`UPDATE myplan_active_plans SET status='abandoned', abandoned_at=? WHERE id=?`)
      .run(new Date().toISOString(), existing.id);
  }
  const ins = db.prepare(`INSERT INTO myplan_active_plans
    (user_id, basic_plan_id, plan_title, plan_action, plan_category, period_days)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    req.uid, basic.id, basic.title, basic.action, basic.cat, periodDays
  );
  const planRow = db.prepare(`SELECT * FROM myplan_active_plans WHERE id=?`).get(ins.lastInsertRowid);
  // 健康アドバイザーから開始DM
  setTimeout(() => {
    try {
      const u = db.prepare("SELECT display_name, nickname FROM users WHERE id=?").get(req.uid);
      const name = (u && (u.nickname || u.display_name)) || 'あなた';
      const msg = `🩺 ${name}さん、新しいプランがスタートしました!\n\n${basic.icon} ${basic.title} (${periodOpt.label})\n→ ${basic.action}\n\n毎日カレンダーに○△✕休を残してね。私がお返事するよ。`;
      sendHealthAdvisorDm(req, req.uid, msg);
    } catch (e) {}
  }, 300);
  res.json({ success: true, plan: hydrateActivePlan(planRow, computeStats(planRow, [])) });
});

// 日次ログ記録 + AI返答生成 (同日2回目はUPDATE)
router.post('/log', authUser, async (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const rawDate = String(body.log_date || '').slice(0, 10);
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : todayLocal();
  const status = String(body.status || '');
  const comment = String(body.comment || '').slice(0, 200).trim() || null;
  if (!['done', 'partial', 'miss', 'rest'].includes(status)) {
    return res.status(400).json({ success: false, msg: 'statusは done/partial/miss/rest のいずれか' });
  }
  const plan = db.prepare(
    `SELECT * FROM myplan_active_plans WHERE user_id=? AND status='active' ORDER BY id DESC LIMIT 1`
  ).get(req.uid);
  if (!plan) return res.status(400).json({ success: false, msg: 'アクティブなプランがありません' });
  // 過去ログ (今日より前)
  const prevLogs = db.prepare(
    `SELECT log_date, status, comment FROM myplan_calendar_logs
     WHERE active_plan_id=? AND log_date < ? ORDER BY log_date ASC`
  ).all(plan.id, dateStr);
  // AI返答生成
  let aiResult = { reply: '', axis_change: false };
  try {
    aiResult = await generateDailyReply({
      plan: { title: plan.plan_title, action: plan.plan_action, category: plan.plan_category, period_days: plan.period_days },
      recent_logs: prevLogs,
      today: { log_date: dateStr, status, comment },
    });
  } catch (e) {
    console.warn('[myplan/log] AI fail:', e.message);
  }
  // upsert
  const existing = db.prepare(
    `SELECT id FROM myplan_calendar_logs WHERE active_plan_id=? AND log_date=?`
  ).get(plan.id, dateStr);
  if (existing) {
    db.prepare(
      `UPDATE myplan_calendar_logs SET status=?, comment=?, ai_reply=?, ai_axis_change=? WHERE id=?`
    ).run(status, comment, aiResult.reply, aiResult.axis_change ? 1 : 0, existing.id);
  } else {
    db.prepare(
      `INSERT INTO myplan_calendar_logs (active_plan_id, user_id, log_date, status, comment, ai_reply, ai_axis_change)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(plan.id, req.uid, dateStr, status, comment, aiResult.reply, aiResult.axis_change ? 1 : 0);
  }
  // 完走判定: 期間日数到達 + ○/△の合計が period の70%以上
  const allLogs = db.prepare(
    `SELECT log_date, status FROM myplan_calendar_logs WHERE active_plan_id=? ORDER BY log_date ASC`
  ).all(plan.id);
  const startDay = (plan.started_at || '').slice(0, 10);
  const daysSinceStart = startDay ? daysBetween(startDay, dateStr) + 1 : allLogs.length;
  const positiveCount = allLogs.filter(l => l.status === 'done' || l.status === 'partial').length;
  const completedThresh = Math.ceil(plan.period_days * 0.7);
  let completedNow = false;
  if (plan.status === 'active' && daysSinceStart >= plan.period_days && positiveCount >= completedThresh) {
    db.prepare(`UPDATE myplan_active_plans SET status='completed', completed_at=? WHERE id=?`)
      .run(new Date().toISOString(), plan.id);
    completedNow = true;
    setTimeout(() => {
      try {
        const u = db.prepare("SELECT display_name, nickname FROM users WHERE id=?").get(req.uid);
        const name = (u && (u.nickname || u.display_name)) || 'あなた';
        const msg = `🎊 ${name}さん、${plan.period_days}日プラン完走おめでとう!\n\n「${plan.plan_title}」を ${positiveCount}日達成。\n\n次は1週間/2週間の長期プランも選べるようになったよ。引き続き、または別のテーマもどうぞ。`;
        sendHealthAdvisorDm(req, req.uid, msg);
      } catch (e) {}
    }, 300);
  }
  res.json({
    success: true,
    ai_reply: aiResult.reply,
    axis_change: aiResult.axis_change,
    completed: completedNow,
  });
});

// プラン中止 (軸変更)
router.post('/abandon', authUser, (req, res) => {
  const db = getDb();
  const row = db.prepare(`SELECT id FROM myplan_active_plans WHERE user_id=? AND status='active'`).get(req.uid);
  if (!row) return res.status(404).json({ success: false, msg: 'アクティブなプランがありません' });
  db.prepare(`UPDATE myplan_active_plans SET status='abandoned', abandoned_at=? WHERE id=?`)
    .run(new Date().toISOString(), row.id);
  res.json({ success: true });
});

// 個人履歴 (完走/中止含む)
router.get('/history', authUser, (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, basic_plan_id, plan_title, plan_action, plan_category, period_days, started_at, completed_at, abandoned_at, status
     FROM myplan_active_plans WHERE user_id=? ORDER BY id DESC LIMIT 20`
  ).all(req.uid);
  res.json({ success: true, history: rows });
});

// 推進メンバー Dashboard データ (v2)
router.get('/admin/dashboard', authPromoter, (req, res) => {
  const db = getDb();
  // KPI
  const activeCount = db.prepare(`SELECT COUNT(*) AS n FROM myplan_active_plans WHERE status='active'`).get().n || 0;
  const completedCount = db.prepare(`SELECT COUNT(*) AS n FROM myplan_active_plans WHERE status='completed'`).get().n || 0;
  const abandonedCount = db.prepare(`SELECT COUNT(*) AS n FROM myplan_active_plans WHERE status='abandoned'`).get().n || 0;
  const totalStarted = activeCount + completedCount + abandonedCount;
  const completionRate = totalStarted ? Math.round(completedCount / totalStarted * 100) : 0;
  // 過去7日の日次ログ数+ポジティブ率
  const last7 = db.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status IN ('done','partial') THEN 1 ELSE 0 END) AS positive
     FROM myplan_calendar_logs WHERE log_date >= date('now','-7 days','localtime')`
  ).get() || { total: 0, positive: 0 };
  const positiveRate7d = last7.total ? Math.round((last7.positive || 0) / last7.total * 100) : 0;
  // プラン人気ランキング
  const popularity = db.prepare(
    `SELECT basic_plan_id, plan_title, plan_category, COUNT(*) AS n
     FROM myplan_active_plans GROUP BY basic_plan_id ORDER BY n DESC`
  ).all();
  // カテゴリ別人気
  const byCategory = db.prepare(
    `SELECT plan_category AS cat, COUNT(*) AS n FROM myplan_active_plans GROUP BY plan_category ORDER BY n DESC`
  ).all();
  // 離脱日分布 (abandonedプラン: started_at と abandoned_at の差)
  const abandonRows = db.prepare(
    `SELECT started_at, abandoned_at FROM myplan_active_plans WHERE status='abandoned' AND abandoned_at IS NOT NULL`
  ).all();
  const abandonDayHist = {};
  for (const a of abandonRows) {
    const d = Math.max(0, daysBetween((a.started_at || '').slice(0, 10), (a.abandoned_at || '').slice(0, 10)));
    const bucket = d <= 2 ? '0-2日' : d <= 6 ? '3-6日' : d <= 13 ? '7-13日' : d <= 29 ? '14-29日' : '30日+';
    abandonDayHist[bucket] = (abandonDayHist[bucket] || 0) + 1;
  }
  // アクティブユーザー一覧 (現在進行中)
  const activeUsers = db.prepare(
    `SELECT m.id AS plan_id, m.user_id, m.plan_title, m.plan_category, m.period_days, m.started_at,
       u.display_name, u.nickname, u.company_code,
       (SELECT status FROM myplan_calendar_logs WHERE active_plan_id=m.id ORDER BY log_date DESC LIMIT 1) AS last_status,
       (SELECT log_date FROM myplan_calendar_logs WHERE active_plan_id=m.id ORDER BY log_date DESC LIMIT 1) AS last_log_date,
       (SELECT COUNT(*) FROM myplan_calendar_logs WHERE active_plan_id=m.id AND status IN ('done','partial')) AS positive_n
     FROM myplan_active_plans m JOIN users u ON u.id=m.user_id
     WHERE m.status='active' ORDER BY m.started_at DESC LIMIT 100`
  ).all();
  // 完走者リスト
  const completers = db.prepare(
    `SELECT m.id AS plan_id, m.user_id, m.plan_title, m.period_days, m.completed_at,
       u.display_name, u.nickname, u.company_code
     FROM myplan_active_plans m JOIN users u ON u.id=m.user_id
     WHERE m.status='completed' ORDER BY m.completed_at DESC LIMIT 30`
  ).all();
  // コメントピックアップ (直近30件、空でないもの)
  const recentComments = db.prepare(
    `SELECT m.log_date, m.status, m.comment, u.display_name, u.nickname, ap.plan_title
     FROM myplan_calendar_logs m
     JOIN myplan_active_plans ap ON ap.id=m.active_plan_id
     JOIN users u ON u.id=m.user_id
     WHERE m.comment IS NOT NULL AND m.comment != '' ORDER BY m.id DESC LIMIT 30`
  ).all();
  res.json({
    success: true,
    kpi: {
      active: activeCount,
      completed: completedCount,
      abandoned: abandonedCount,
      total_started: totalStarted,
      completion_rate: completionRate,
      positive_rate_7d: positiveRate7d,
      logs_7d: last7.total || 0,
    },
    popularity: popularity.map(p => ({ ...p, category_label: (CATEGORY_META[p.plan_category] || {}).label || p.plan_category })),
    by_category: byCategory.map(c => ({ key: c.cat, label: (CATEGORY_META[c.cat] || {}).label || c.cat, count: c.n })),
    abandon_day_hist: ['0-2日', '3-6日', '7-13日', '14-29日', '30日+'].map(k => ({ bucket: k, count: abandonDayHist[k] || 0 })),
    // 黒子型: 実名(display_name)・所属(company_code)・login_id(user_id)はクライアントへ返さない。
    // 表示名は nickname のみ (未設定なら'匿名'。実名へのフォールバックは禁止)。励ましは plan_id 経由。
    active_users: activeUsers.map(u => ({
      plan_id: u.plan_id,
      name: u.nickname || '匿名',
      plan_title: u.plan_title,
      plan_category: u.plan_category,
      period_days: u.period_days,
      started_at: u.started_at,
      last_status: u.last_status,
      last_log_date: u.last_log_date,
      positive_n: u.positive_n,
      day_index: Math.min(u.period_days, daysBetween((u.started_at || '').slice(0, 10), todayLocal()) + 1),
    })),
    completers: completers.map(c => ({
      plan_id: c.plan_id,
      name: c.nickname || '匿名',
      plan_title: c.plan_title,
      period_days: c.period_days,
      completed_at: c.completed_at,
    })),
    recent_comments: recentComments.map(c => ({
      name: c.nickname || '匿名',
      log_date: c.log_date,
      status: c.status,
      comment: c.comment,
      plan_title: c.plan_title,
    })),
  });
});

function computeStats(plan, logs) {
  const startDay = (plan.started_at || '').slice(0, 10);
  const dayIndex = startDay ? Math.min(plan.period_days, daysBetween(startDay, todayLocal()) + 1) : 1;
  const remaining = Math.max(0, plan.period_days - dayIndex);
  let streak = 0;
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].status === 'done' || logs[i].status === 'partial') streak++; else break;
  }
  const positive = logs.filter(l => l.status === 'done' || l.status === 'partial').length;
  let miss = 0;
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].status === 'miss') miss++; else break;
  }
  return { day_index: dayIndex, remaining, streak, positive, consecutive_miss: miss };
}

function hydrateActivePlan(row, stats) {
  return {
    id: row.id,
    basic_plan_id: row.basic_plan_id,
    title: row.plan_title,
    action: row.plan_action,
    category: row.plan_category,
    category_label: (CATEGORY_META[row.plan_category] || {}).label || row.plan_category,
    period_days: row.period_days,
    started_at: row.started_at,
    status: row.status,
    completed_at: row.completed_at,
    ...stats,
  };
}

function todayLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function daysBetween(a, b) {
  if (!a || !b) return 0;
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db - da) / 86400000);
}

module.exports = router;
