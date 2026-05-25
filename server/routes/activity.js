// マイ運動記録 🔥 (2026-05-23)
// 個人の運動ログ。kcal統一KPI。匿名ランキング/月間目標/バッジ。
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { analyzeActivityImage } = require('../services/ai');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'activity');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// ===== kcal推定 (METs方式) =====
const METS = { walk: 3.0, jog: 7.0, run: 10.0, bike: 6.0, gym: 5.0, other: 4.0 };
const DEFAULT_WEIGHT = 65; // 体重未登録時の暫定値

function estimateKcal({ activity_type, steps, distance_km, duration_min, weight_kg }) {
  const w = (typeof weight_kg === 'number' && weight_kg > 0) ? weight_kg : DEFAULT_WEIGHT;
  const met = METS[activity_type] || METS.other;
  // 1) duration_min があれば最優先 — METs × kg × h
  if (duration_min && duration_min > 0) {
    return Math.round(met * w * (duration_min / 60));
  }
  // 2) distance_km があれば歩速度から時間を逆算 (種別別)
  if (distance_km && distance_km > 0) {
    // 想定速度: walk=4km/h, jog=8km/h, run=11km/h, bike=18km/h, gym=任意なし
    const speed = activity_type === 'walk' ? 4 : activity_type === 'jog' ? 8
      : activity_type === 'run' ? 11 : activity_type === 'bike' ? 18 : 5;
    const hours = distance_km / speed;
    return Math.round(met * w * hours);
  }
  // 3) steps があれば換算 (1000歩 ≈ 0.7km、3METs、4km/h想定)
  if (steps && steps > 0) {
    const km = steps * 0.0007;
    const hours = km / 4.0;
    return Math.round(METS.walk * w * hours);
  }
  return 0;
}

// ===== ユーザー設定 (体重/目標/公開設定) =====
function getPrefs(uid) {
  const row = getDb().prepare('SELECT * FROM user_activity_prefs WHERE user_id = ?').get(uid);
  return row || null;
}

router.get('/prefs', authUser, (req, res) => {
  const p = getPrefs(req.uid);
  res.json({ success: true, prefs: p || { user_id: req.uid, weight_kg: null, monthly_goal_kcal: null, default_visibility: 'private' } });
});

router.put('/prefs', authUser, express.json(), (req, res) => {
  const b = req.body || {};
  const w = parseFloat(b.weight_kg);
  const goal = b.monthly_goal_kcal === null || b.monthly_goal_kcal === undefined ? null : parseInt(b.monthly_goal_kcal);
  const vis = ['private','dept','company'].includes(b.default_visibility) ? b.default_visibility : 'private';
  if (w && (w < 25 || w > 250)) return res.status(400).json({ success: false, msg: '体重は25-250kgで入力してください' });
  if (goal !== null && goal !== null && (goal < 0 || goal > 1000000)) return res.status(400).json({ success: false, msg: '目標が範囲外' });
  getDb().prepare(`INSERT INTO user_activity_prefs (user_id, weight_kg, monthly_goal_kcal, default_visibility, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      weight_kg = COALESCE(excluded.weight_kg, user_activity_prefs.weight_kg),
      monthly_goal_kcal = excluded.monthly_goal_kcal,
      default_visibility = excluded.default_visibility,
      updated_at = excluded.updated_at`).run(req.uid, w || null, goal, vis);
  res.json({ success: true });
});

// ===== 記録CRUD =====
router.post('/', authUser, express.json(), (req, res) => {
  const b = req.body || {};
  const allowedTypes = ['walk','jog','run','bike','gym'];
  if (!allowedTypes.includes(b.activity_type)) return res.status(400).json({ success: false, msg: '種別が無効' });
  const today = new Date().toISOString().slice(0, 10);
  const date = (b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) ? b.date : today;
  const steps = b.steps ? Math.max(0, Math.min(150000, parseInt(b.steps))) : null;
  const distance = b.distance_km ? Math.max(0, Math.min(500, parseFloat(b.distance_km))) : null;
  const duration = b.duration_min ? Math.max(0, Math.min(1440, parseInt(b.duration_min))) : null;
  let kcal = b.kcal ? Math.max(0, Math.min(20000, parseInt(b.kcal))) : null;
  const kcalSource = kcal ? 'direct' : 'estimated';
  // kcal未指定なら推定
  if (!kcal) {
    const prefs = getPrefs(req.uid);
    kcal = estimateKcal({
      activity_type: b.activity_type, steps, distance_km: distance, duration_min: duration,
      weight_kg: prefs && prefs.weight_kg
    });
  }
  if (!kcal || kcal <= 0) return res.status(400).json({ success: false, msg: 'kcalを算出できません (歩数/距離/時間のいずれか必須)' });
  const comment = String(b.comment || '').slice(0, 280);
  const photoUrl = b.photo_url ? String(b.photo_url).slice(0, 500) : null;
  const source = ['manual','ocr','fitbit'].includes(b.source) ? b.source : 'manual';
  const visibility = ['private','dept','company'].includes(b.visibility) ? b.visibility : 'private';
  const ins = getDb().prepare(`INSERT INTO activity_logs
    (user_id, date, activity_type, steps, distance_km, duration_min, kcal, kcal_source, comment, photo_url, source, visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.uid, date, b.activity_type, steps, distance, duration, kcal, kcalSource, comment, photoUrl, source, visibility
  );
  res.json({ success: true, id: ins.lastInsertRowid, kcal });
});

router.delete('/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const row = getDb().prepare('SELECT user_id FROM activity_logs WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ success: false, msg: '記録なし' });
  if (row.user_id !== req.uid) return res.status(403).json({ success: false, msg: '権限なし' });
  getDb().prepare("UPDATE activity_logs SET deleted_at = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
});

router.put('/:id', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const row = getDb().prepare('SELECT user_id FROM activity_logs WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ success: false, msg: '記録なし' });
  if (row.user_id !== req.uid) return res.status(403).json({ success: false, msg: '権限なし' });
  const b = req.body || {};
  const fields = []; const params = [];
  if (b.comment !== undefined) { fields.push('comment = ?'); params.push(String(b.comment || '').slice(0, 280)); }
  if (b.visibility !== undefined && ['private','dept','company'].includes(b.visibility)) {
    fields.push('visibility = ?'); params.push(b.visibility);
  }
  if (!fields.length) return res.json({ success: true, msg: '変更なし' });
  fields.push("updated_at = datetime('now')");
  params.push(id);
  getDb().prepare(`UPDATE activity_logs SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// ===== 自分の記録取得 =====
// 今日の記録 (同日合算用、複数あり)
router.get('/me/today', authUser, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = getDb().prepare(`SELECT * FROM activity_logs
    WHERE user_id = ? AND date = ? AND deleted_at IS NULL ORDER BY id DESC`).all(req.uid, today);
  const sumKcal = rows.reduce((s, r) => s + (r.kcal || 0), 0);
  const sumSteps = rows.reduce((s, r) => s + (r.steps || 0), 0);
  const sumDistance = Math.round(rows.reduce((s, r) => s + (r.distance_km || 0), 0) * 100) / 100;
  res.json({ success: true, date: today, logs: rows, total: { kcal: sumKcal, steps: sumSteps, distance_km: sumDistance } });
});

// 日付指定 (個別)
router.get('/me/date/:date', authUser, (req, res) => {
  const d = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ success: false, msg: '日付形式' });
  const rows = getDb().prepare(`SELECT * FROM activity_logs
    WHERE user_id = ? AND date = ? AND deleted_at IS NULL ORDER BY id DESC`).all(req.uid, d);
  res.json({ success: true, date: d, logs: rows });
});

// 草型ヒートマップ用: 過去365日の日次kcal集計
router.get('/me/heatmap', authUser, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 365, 730);
  const rows = getDb().prepare(`SELECT date, SUM(kcal) AS kcal,
    GROUP_CONCAT(DISTINCT activity_type) AS types
    FROM activity_logs
    WHERE user_id = ? AND deleted_at IS NULL
      AND date >= date('now', ?)
    GROUP BY date ORDER BY date ASC`).all(req.uid, `-${days} day`);
  res.json({ success: true, days, points: rows });
});

// 連続日数 / 月間累計 / ベスト記録 / 種別比率
router.get('/me/stats', authUser, (req, res) => {
  const db = getDb();
  const monthStart = new Date().toISOString().slice(0, 8) + '01';
  // 今月累計
  const month = db.prepare(`SELECT SUM(kcal) AS kcal, SUM(steps) AS steps, SUM(distance_km) AS km
    FROM activity_logs WHERE user_id = ? AND date >= ? AND deleted_at IS NULL`).get(req.uid, monthStart);
  // ベスト
  const bestKcal = db.prepare(`SELECT date, SUM(kcal) AS kcal FROM activity_logs
    WHERE user_id = ? AND deleted_at IS NULL GROUP BY date ORDER BY kcal DESC LIMIT 1`).get(req.uid);
  const bestSteps = db.prepare(`SELECT date, SUM(steps) AS steps FROM activity_logs
    WHERE user_id = ? AND deleted_at IS NULL GROUP BY date ORDER BY steps DESC LIMIT 1`).get(req.uid);
  const bestDist = db.prepare(`SELECT date, SUM(distance_km) AS km FROM activity_logs
    WHERE user_id = ? AND deleted_at IS NULL GROUP BY date ORDER BY km DESC LIMIT 1`).get(req.uid);
  // 連続記録 (current/longest)
  const dates = db.prepare(`SELECT DISTINCT date FROM activity_logs
    WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC LIMIT 400`).all(req.uid).map(r => r.date);
  const todayStr = new Date().toISOString().slice(0, 10);
  function shiftDate(d, delta) {
    const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().slice(0, 10);
  }
  let currentStreak = 0;
  if (dates.length) {
    let expect = todayStr;
    // 今日未記録なら昨日からカウント (連続に1日の猶予はあげない=厳格、ただし当日23:59まで記録可能なので「昨日からのカウント」とする)
    if (dates[0] !== todayStr) expect = shiftDate(todayStr, -1);
    for (const d of dates) {
      if (d === expect) { currentStreak++; expect = shiftDate(expect, -1); }
      else if (d < expect) break;
    }
  }
  // 最長連続: dates 全体スキャン
  let longestStreak = 0; let run = 0; let prev = null;
  const datesAsc = dates.slice().sort();
  for (const d of datesAsc) {
    if (prev && shiftDate(prev, 1) === d) run++;
    else run = 1;
    if (run > longestStreak) longestStreak = run;
    prev = d;
  }
  // 種別比率 (過去90日)
  const ratio = db.prepare(`SELECT activity_type, SUM(kcal) AS kcal FROM activity_logs
    WHERE user_id = ? AND date >= date('now','-90 day') AND deleted_at IS NULL
    GROUP BY activity_type`).all(req.uid);
  res.json({
    success: true,
    month: {
      kcal: month.kcal || 0,
      steps: month.steps || 0,
      distance_km: Math.round((month.km || 0) * 100) / 100,
    },
    best: {
      kcal: bestKcal || null,
      steps: bestSteps || null,
      distance: bestDist ? { date: bestDist.date, km: Math.round(bestDist.km * 100) / 100 } : null,
    },
    streak: { current: currentStreak, longest: longestStreak },
    type_ratio: ratio,
  });
});

// ===== バッジ判定 =====
const STREAK_BADGES = [7, 30, 100, 365];
const KCAL_TOTAL_BADGES = [10000, 50000, 100000, 500000];
const DISTANCE_BADGES = [100, 500, 1000, 3000]; // km

router.get('/me/badges', authUser, (req, res) => {
  const db = getDb();
  const tot = db.prepare(`SELECT SUM(kcal) AS kcal, SUM(distance_km) AS km
    FROM activity_logs WHERE user_id = ? AND deleted_at IS NULL`).get(req.uid);
  const dates = db.prepare(`SELECT DISTINCT date FROM activity_logs
    WHERE user_id = ? AND deleted_at IS NULL ORDER BY date ASC`).all(req.uid).map(r => r.date);
  function shiftDate(d, delta) {
    const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().slice(0, 10);
  }
  let longest = 0; let run = 0; let prev = null;
  for (const d of dates) {
    if (prev && shiftDate(prev, 1) === d) run++; else run = 1;
    if (run > longest) longest = run;
    prev = d;
  }
  const km = Math.round(tot.km || 0);
  const kcal = tot.kcal || 0;
  const earned = [];
  for (const n of STREAK_BADGES) if (longest >= n) earned.push({ kind: 'streak', n, label: `${n}日連続` });
  for (const n of KCAL_TOTAL_BADGES) if (kcal >= n) earned.push({ kind: 'kcal', n, label: `累計${(n/1000).toFixed(0)}k kcal` });
  for (const n of DISTANCE_BADGES) if (km >= n) earned.push({ kind: 'distance', n, label: `累計${n}km` });
  res.json({ success: true, earned, totals: { kcal, distance_km: km, longest_streak: longest } });
});

// ===== 月間匿名ランキング (visibility=company のみ集計) =====
router.get('/ranking', authUser, (req, res) => {
  const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? req.query.month : new Date().toISOString().slice(0, 7);
  const monthStart = month + '-01';
  const monthEnd = month + '-31';
  const rows = getDb().prepare(`SELECT
      a.user_id,
      u.company_code,
      SUM(a.kcal) AS kcal,
      (SELECT activity_type FROM activity_logs
        WHERE user_id = a.user_id AND date BETWEEN ? AND ? AND deleted_at IS NULL AND visibility = 'company'
        GROUP BY activity_type ORDER BY SUM(kcal) DESC LIMIT 1) AS main_type
    FROM activity_logs a
    JOIN users u ON u.id = a.user_id
    WHERE a.date BETWEEN ? AND ? AND a.deleted_at IS NULL AND a.visibility = 'company'
    GROUP BY a.user_id
    HAVING SUM(a.kcal) > 0
    ORDER BY kcal DESC`).all(monthStart, monthEnd, monthStart, monthEnd);
  // 営業所名対応
  const branchNames = {};
  try {
    const allCompanies = getDb().prepare('SELECT DISTINCT company_code FROM users WHERE company_code IS NOT NULL').all();
    for (const c of allCompanies) branchNames[c.company_code] = c.company_code;
  } catch (e) {}
  // 自分の順位
  let myRank = null;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].user_id === req.uid) { myRank = i + 1; break; }
  }
  // 個人名は出さず、匿名化 (company_code + main_type アイコンのみ)
  const typeIcon = { walk: '👣', jog: '🏃', run: '💨', bike: '🚴', gym: '💪' };
  const ranking = rows.slice(0, 10).map((r, i) => ({
    rank: i + 1,
    branch: r.company_code || '—',
    main_type: r.main_type || 'walk',
    icon: typeIcon[r.main_type] || '🔥',
    kcal: r.kcal,
    is_me: r.user_id === req.uid,
  }));
  const myKcal = (rows.find(r => r.user_id === req.uid) || {}).kcal || 0;
  const percentile = (myRank && rows.length) ? Math.ceil((myRank / rows.length) * 100) : null;
  res.json({
    success: true, month, total_participants: rows.length,
    ranking, my_rank: myRank, my_kcal: myKcal, my_percentile: percentile,
  });
});

// ===== 画像OCR =====
router.post('/ocr', authUser, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, msg: '画像未指定' });
  try {
    const parsed = await analyzeActivityImage(req.file.buffer, req.file.mimetype || 'image/jpeg');
    if (!parsed || (parsed.steps == null && parsed.distance_km == null && parsed.kcal == null && parsed.duration_min == null)) {
      return res.json({ success: false, msg: parsed && parsed.note || 'OCR読み取り失敗', parsed });
    }
    res.json({ success: true, parsed });
  } catch (e) {
    console.warn('[activity OCR fail]', e.message);
    res.status(500).json({ success: false, msg: 'OCR失敗: ' + (e.message || '').slice(0, 120) });
  }
});

// 画像アップロード (記録に添付する写真)
router.post('/photo', authUser, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, msg: '画像未指定' });
  const ext = (req.file.mimetype || '').includes('png') ? 'png' : 'jpg';
  const fname = `${req.uid}_${Date.now()}_${Math.floor(Math.random() * 9000) + 1000}.${ext}`;
  const fp = path.join(UPLOAD_DIR, fname);
  fs.writeFileSync(fp, req.file.buffer);
  res.json({ success: true, url: `/uploads/activity/${fname}` });
});

module.exports = router;
