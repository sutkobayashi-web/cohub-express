// ホーム「今日のひとこと」: ユーザーの状態からAIが1メッセージ生成、日次キャッシュ
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateText } = require('../services/ai');

router.use(express.json({ limit: '64kb' }));

// テーブル準備 (初回ロード時)
function ensureTable() {
  const db = getDb();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS daily_messages (
      user_id TEXT NOT NULL,
      message_date TEXT NOT NULL,
      icon TEXT,
      message TEXT NOT NULL,
      generated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, message_date)
    )
  `).run();
}
ensureTable();

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// ユーザーの状態を軽量に集める
function gatherContext(db, uid) {
  const ctx = {};
  // 直近7日の食事POST数 + 直近の食事栄養スコア (最後の1件のキー特徴)
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM plaza_posts
      WHERE author_id = ? AND category = '食事' AND deleted_at IS NULL
        AND created_at >= datetime('now', '-7 days')
    `).get(uid);
    ctx.food_posts_7d = r ? r.n : 0;
  } catch (e) {}
  try {
    const r = db.prepare(`
      SELECT nutrition_scores FROM plaza_posts
      WHERE author_id = ? AND category = '食事' AND nutrition_scores IS NOT NULL AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(uid);
    if (r && r.nutrition_scores) {
      try {
        const ns = JSON.parse(r.nutrition_scores);
        const flags = [];
        const salt = ns.salt && Number(ns.salt.value || ns.salt);
        const veg = ns.vitamin && Number(ns.vitamin.value || ns.vitamin);
        if (salt && salt > 2.5) flags.push('塩分やや高め');
        if (veg != null && veg < 80) flags.push('野菜が少なめ');
        ctx.last_food_flags = flags;
      } catch (e) {}
    }
  } catch (e) {}
  // 直近のミーティング (本人が招待されている確定済の次の1件)
  try {
    const r = db.prepare(`
      SELECT p.title, s.starts_at, p.duration_minutes
      FROM meeting_polls p
      JOIN meeting_poll_slots s ON s.id = p.decided_slot_id
      WHERE p.status = 'decided'
        AND datetime(s.starts_at, '+' || COALESCE(p.duration_minutes, 30) || ' minutes') >= datetime('now')
        AND (p.organizer_id = ? OR EXISTS (SELECT 1 FROM meeting_poll_invitees i WHERE i.poll_id = p.id AND i.user_id = ?))
      ORDER BY s.starts_at ASC LIMIT 1
    `).get(uid, uid);
    if (r) ctx.next_meeting = { title: r.title, starts_at: r.starts_at };
  } catch (e) {}
  // 未回答の日程調整ポール数
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM meeting_polls p
      JOIN meeting_poll_invitees i ON i.poll_id = p.id AND i.user_id = ?
      WHERE p.status = 'open' AND p.organizer_id != ?
        AND NOT EXISTS (SELECT 1 FROM meeting_poll_votes v WHERE v.poll_id = p.id AND v.user_id = ?)
    `).get(uid, uid, uid);
    ctx.unanswered_polls = r ? r.n : 0;
  } catch (e) {}
  // 未読DM数 (簡易: 過去48h以内の未読)
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM messages m
      WHERE m.receiver_id = ? AND m.room_code = 'dm'
        AND m.created_at >= datetime('now', '-48 hours')
        AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.user_id = ?)
    `).get(uid, uid);
    ctx.unread_dm = r ? r.n : 0;
  } catch (e) { /* テーブルない場合あり */ }
  // 推進メンバーかどうか
  try {
    const u = db.prepare(`SELECT is_field_promoter, role, employee_type FROM users WHERE id = ?`).get(uid);
    if (u) {
      ctx.is_promoter = !!u.is_field_promoter;
      ctx.is_admin = u.role === 'admin';
    }
  } catch (e) {}
  // 今日の曜日
  const days = ['日','月','火','水','木','金','土'];
  ctx.dow = days[new Date().getDay()];
  ctx.month_day = (new Date().getMonth() + 1) + '/' + new Date().getDate();
  return ctx;
}

async function generateMessage(ctx, displayName) {
  const ctxLines = [];
  ctxLines.push('日付: ' + ctx.month_day + ' (' + ctx.dow + ')');
  ctxLines.push('名前: ' + displayName);
  if (ctx.food_posts_7d != null) ctxLines.push('過去7日の食事投稿: ' + ctx.food_posts_7d + '回');
  if (ctx.last_food_flags && ctx.last_food_flags.length) ctxLines.push('直近の食事: ' + ctx.last_food_flags.join('、'));
  if (ctx.next_meeting) ctxLines.push('次の予定: 「' + ctx.next_meeting.title + '」(' + ctx.next_meeting.starts_at + ')');
  if (ctx.unanswered_polls) ctxLines.push('未回答の日程調整: ' + ctx.unanswered_polls + '件');
  if (ctx.unread_dm) ctxLines.push('未読DM: ' + ctx.unread_dm + '件');
  if (ctx.is_promoter) ctxLines.push('役割: 推進メンバー');
  if (ctx.is_admin) ctxLines.push('役割: 管理職');

  const prompt = `あなたは社内ポータル「CoWell」のホーム画面に毎朝表示される「今日のひとこと」を書きます。

【厳守ルール】
- 60文字以内の日本語1文 (絵文字含む)
- 押し付けがましさNG。健康説教NG。「健康のために」「〜しましょう」「お忘れなく」等の指図口調NG
- 「健診」「血圧」「BMI」「肥満」等の医療系単語NG (健康無関心層への配慮)
- 数字データを直接引用しない (「7回」「2.5g」等は不可)
- 名前を毎回呼ぶ必要なし。話題があれば優しく触れる
- 業務指示や催促NG (「ミーティングに参加してください」NG)。事実を軽く認知してもらう程度
- ポジティブだが過剰に明るくない。「淡々と寄り添う」トーン
- 出力は本文のみ。前置きや説明不要

【ユーザーの状態】
${ctxLines.join('\n')}

【出力】絵文字1〜2個と、その人の状態にそっと寄り添う一言。状態に注目すべきものがなければ「今日も良い1日になりますように」系の汎用メッセージでOK。`;

  try {
    const text = await generateText(prompt, { temperature: 0.85, maxOutputTokens: 200 });
    if (text && text.trim()) return text.trim().slice(0, 120);
  } catch (e) {
    console.warn('[daily-message] generate failed:', e.message);
  }
  // フォールバック
  const fallbacks = [
    '☕ 今日も淡々と、いきましょう。',
    '🌿 一息ついたら、また始めましょう。',
    '🍵 急がず、自分のペースで。',
    '🌤 良い1日になりますように。',
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

// 今日のひとことを取得 (キャッシュ済みなら即返、なければ生成して保存)
router.get('/', authUser, async (req, res) => {
  const db = getDb();
  const date = todayKey();
  // キャッシュ確認
  const cached = db.prepare(`SELECT icon, message FROM daily_messages WHERE user_id = ? AND message_date = ?`).get(req.uid, date);
  if (cached) {
    return res.json({ success: true, date, message: cached.message, icon: cached.icon || '', cached: true });
  }
  // 生成
  try {
    const u = db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(req.uid);
    const ctx = gatherContext(db, req.uid);
    const message = await generateMessage(ctx, (u && u.display_name) || '');
    db.prepare(`INSERT OR REPLACE INTO daily_messages (user_id, message_date, icon, message) VALUES (?, ?, ?, ?)`)
      .run(req.uid, date, '', message);
    res.json({ success: true, date, message, icon: '', cached: false });
  } catch (e) {
    console.error('[daily-message]', e);
    res.status(500).json({ success: false, msg: e.message });
  }
});

// 再生成 (管理職のみ。プロンプト調整時のデバッグ用)
router.post('/regenerate', authUser, async (req, res) => {
  const db = getDb();
  const date = todayKey();
  db.prepare(`DELETE FROM daily_messages WHERE user_id = ? AND message_date = ?`).run(req.uid, date);
  try {
    const u = db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(req.uid);
    const ctx = gatherContext(db, req.uid);
    const message = await generateMessage(ctx, (u && u.display_name) || '');
    db.prepare(`INSERT OR REPLACE INTO daily_messages (user_id, message_date, icon, message) VALUES (?, ?, ?, ?)`)
      .run(req.uid, date, '', message);
    res.json({ success: true, date, message, icon: '' });
  } catch (e) {
    res.status(500).json({ success: false, msg: e.message });
  }
});

module.exports = router;
