// 健康管理室 個人アクションプラン API
// 樹形図相談 (Layer1→2→3+自由記述) → AI生成 → DB保存 → 表示
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateActionPlan } = require('../services/ai');

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
  const stats = db.prepare(`SELECT category_top AS cat, COUNT(*) AS n FROM myplan_consultations
    WHERE created_at >= datetime('now','-7 days') AND category_top IS NOT NULL
    GROUP BY category_top ORDER BY n DESC`).all();
  const todayDone = db.prepare(`SELECT COUNT(*) AS n FROM myplan_consultations
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
      user_id: r.user_id,
      display_name: r.display_name,
      nickname: r.nickname,
      company_code: r.company_code,
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

// 推進メンバーから個人へ励ましDM送信 (推進メンバー本人として)
router.post('/admin/encourage', authPromoter, (req, res) => {
  const targetUid = String((req.body && req.body.user_id) || '').trim();
  const message = String((req.body && req.body.message) || '').slice(0, 500).trim();
  if (!targetUid || !message) return res.status(400).json({ success: false, msg: '宛先と本文が必要' });
  const db = getDb();
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(targetUid);
  if (!target) return res.status(404).json({ success: false, msg: '宛先が見つかりません' });
  // 推進メンバー本人の display_name で送信
  const me = db.prepare("SELECT display_name FROM users WHERE id = ?").get(req.uid);
  const fromName = (me && me.display_name) || '推進メンバー';
  const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')")
    .run(req.uid, targetUid, `🩺 [健康管理室 ${fromName}より] ${message}`);
  const payload = { id: ins.lastInsertRowid, from: req.uid, to: targetUid,
    content: `🩺 [健康管理室 ${fromName}より] ${message}`, at: new Date().toISOString(), attach: null };
  const emit = req.app && req.app.locals && req.app.locals.emitToUser;
  if (emit) emit(targetUid, 'dm:msg', payload);
  const push = req.app && req.app.locals && req.app.locals.sendPushToUser;
  if (push) push(targetUid, { title: '🩺 健康管理室から', body: message.slice(0, 80), tag: 'wellness-dm', mention: true, url: '/myplan.html' }).catch(() => {});
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

module.exports = router;
