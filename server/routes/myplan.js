// 健康管理室 個人アクションプラン API
// 樹形図相談 (Layer1→2→3+自由記述) → AI生成 → DB保存 → 表示
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateActionPlan } = require('../services/ai');

router.use(express.json());

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

// 相談実行: 選択肢+自由記述+コンテキストでAIアクションプラン生成 → DB保存
router.post('/consult', authUser, async (req, res) => {
  const selections = Array.isArray(req.body && req.body.selections) ? req.body.selections : [];
  const freeText = String((req.body && req.body.free_text) || '').slice(0, 1000).trim();
  if (!selections.length && !freeText) {
    return res.status(400).json({ success: false, msg: '選択または自由記述が必要です' });
  }
  const movementPriority = detectMovementPriority(selections, freeText);
  const context = {
    recent_meals_7d: collectRecentMeals(req.uid),
    bp_recent: collectRecentBP(req.uid),
  };
  console.log(`[myplan] consult uid=${req.uid} sels=${selections.length} free=${freeText.length} move=${movementPriority} meals=${context.recent_meals_7d.length} bp=${context.bp_recent.length}`);
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
    (user_id, selections_json, free_text, movement_priority, plan_now, plan_today, plan_week, plan_month, plan_kpi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.uid, JSON.stringify(selections), freeText || null, movementPriority ? 1 : 0,
    String(plan.plan_now || '').slice(0, 800),
    String(plan.plan_today || '').slice(0, 600),
    String(plan.plan_week || '').slice(0, 800),
    String(plan.plan_month || '').slice(0, 800),
    kpiJson
  );
  const saved = db.prepare(`SELECT * FROM myplan_consultations WHERE id=?`).get(ins.lastInsertRowid);
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

// 今日のアクション完了マーク (トグル)
router.post('/done/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const row = db.prepare(`SELECT id, user_id, today_done_at FROM myplan_consultations WHERE id=?`).get(id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (row.user_id !== req.uid) return res.status(403).json({ success: false, msg: '本人のみ操作可' });
  const newDone = row.today_done_at ? null : new Date().toISOString();
  db.prepare(`UPDATE myplan_consultations SET today_done_at=? WHERE id=?`).run(newDone, id);
  res.json({ success: true, today_done_at: newDone });
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
