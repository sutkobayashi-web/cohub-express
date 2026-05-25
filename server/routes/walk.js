// Connect 230 API
// 東京日本橋⇔磐田スズエ電機 双方向ウォーキングイベント (約230km)
// 10,000歩 = 100マイル / 1歩 = 0.7m
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { analyzePedometerImage } = require('../services/ai');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'walk');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },  // 5MB
});

const STEP_METERS = 0.7;
const MILES_PER_10K_STEPS = 100;

function stepsToMeters(steps) { return steps * STEP_METERS; }
function stepsToMiles(steps) { return Math.round((steps / 10000) * MILES_PER_10K_STEPS * 100) / 100; }

function isAdmin(uid) {
  const u = getDb().prepare('SELECT employee_type, role FROM users WHERE id = ?').get(uid);
  return !!(u && (u.employee_type === 'admin' || u.role === 'admin'));
}

function getActiveEvent() {
  return getDb().prepare(`SELECT * FROM walk_events
    WHERE status IN ('active','phase2_solo')
       OR (status='pending' AND start_date <= date('now') AND end_date >= date('now'))
    ORDER BY id DESC LIMIT 1`).get();
}

function teamCodeFor(companyCode) {
  // SZE = スズエチーム / それ以外 (STD/KBC等) = 標準チーム
  return companyCode === 'SZE' ? 'SZE' : 'STD';
}

// 1ユーザーの状態を再計算 (歩数記録から累積を導出)
function recomputePersonal(uid, eventId) {
  const db = getDb();
  const u = db.prepare('SELECT company_code FROM users WHERE id=?').get(uid);
  if (!u) return null;
  const team = teamCodeFor(u.company_code);
  const agg = db.prepare(`SELECT SUM(steps) AS total_steps, SUM(miles) AS total_miles
    FROM walk_steps_log WHERE user_id=? AND event_id=?`).get(uid, eventId);
  const totalSteps = agg.total_steps || 0;
  const totalMiles = Math.round((agg.total_miles || 0) * 100) / 100;
  const distanceKm = Math.round((totalSteps * STEP_METERS / 1000) * 100) / 100;
  // 通過マイルストーン算出
  const milestones = db.prepare(`SELECT id, km_from_tokyo FROM walk_milestones WHERE event_id=? ORDER BY km_from_tokyo`).all(eventId);
  const visited = [];
  for (const m of milestones) {
    // チームごとに進行方向が逆 — 通過判定はチームによって異なる
    const reached = team === 'STD'
      ? (distanceKm >= m.km_from_tokyo)
      : (distanceKm >= (getEventTotalKm(eventId) - m.km_from_tokyo));
    if (reached) visited.push(m.id);
  }
  db.prepare(`INSERT INTO walk_personal_state (user_id, event_id, team_code, total_steps, total_miles, distance_walked_km, visited_milestones, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, event_id) DO UPDATE SET
      team_code=excluded.team_code,
      total_steps=excluded.total_steps,
      total_miles=excluded.total_miles,
      distance_walked_km=excluded.distance_walked_km,
      visited_milestones=excluded.visited_milestones,
      last_updated=excluded.last_updated`)
    .run(uid, eventId, team, totalSteps, totalMiles, distanceKm, JSON.stringify(visited));
  return { team_code: team, total_steps: totalSteps, total_miles: totalMiles, distance_walked_km: distanceKm, visited_milestones: visited };
}

function recomputeTeams(eventId) {
  const db = getDb();
  for (const team of ['STD', 'SZE']) {
    const agg = db.prepare(`SELECT SUM(total_steps) AS s, SUM(distance_walked_km) AS km, COUNT(*) AS n
      FROM walk_personal_state WHERE event_id=? AND team_code=?`).get(eventId, team);
    db.prepare(`INSERT INTO walk_team_progress (team_code, event_id, total_steps, total_km, member_count, last_updated)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(team_code, event_id) DO UPDATE SET
        total_steps=excluded.total_steps, total_km=excluded.total_km,
        member_count=excluded.member_count, last_updated=excluded.last_updated`)
      .run(team, eventId, agg.s || 0, Math.round((agg.km || 0) * 100) / 100, agg.n || 0);
  }
  // 合流イベント検知: 両チーム合計 >= 全長 で初めて 'phase2_solo' へ
  const ev = db.prepare('SELECT * FROM walk_events WHERE id=?').get(eventId);
  if (ev && ev.status === 'active') {
    const std = db.prepare("SELECT total_km FROM walk_team_progress WHERE team_code='STD' AND event_id=?").get(eventId);
    const sze = db.prepare("SELECT total_km FROM walk_team_progress WHERE team_code='SZE' AND event_id=?").get(eventId);
    const stdKm = (std && std.total_km) || 0;
    const szeKm = (sze && sze.total_km) || 0;
    if (stdKm + szeKm >= ev.total_route_km) {
      // 合流地点 = 東京から見た STDチームの進捗位置
      const meetKm = Math.min(stdKm, ev.total_route_km);
      db.prepare(`UPDATE walk_events SET status='phase2_solo', meet_event_at=datetime('now'), meet_position_km=? WHERE id=?`).run(meetKm, eventId);
    }
  }
}

function getEventTotalKm(eventId) {
  const ev = getDb().prepare('SELECT total_route_km FROM walk_events WHERE id=?').get(eventId);
  return ev ? ev.total_route_km : 230;
}

// =========== 写真OCR ===========
// 万歩計写真をアップロードして歩数を抽出
router.post('/steps/ocr', authUser, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, msg: '写真がありません' });
    const result = await analyzePedometerImage(req.file.buffer, req.file.mimetype);
    if (!result || result.steps == null) {
      return res.json({ success: false, msg: result && result.note ? result.note : '歩数を読み取れませんでした', confidence: result && result.confidence });
    }
    // 写真を保存 (記録に紐づける用)
    const ts = Date.now();
    const ext = (req.file.mimetype || '').includes('png') ? '.png' : '.jpg';
    const fname = req.uid + '_' + ts + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), req.file.buffer);
    res.json({ success: true, steps: result.steps, confidence: result.confidence, photo_url: '/uploads/walk/' + fname, note: result.note });
  } catch (e) {
    console.error('[walk OCR]', e);
    res.status(500).json({ success: false, msg: e.message || 'OCR失敗' });
  }
});

// =========== 一般ユーザーAPI ===========

// 開催中イベント情報 + マイルストーン
router.get('/event/active', authUser, (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.json({ success: true, event: null });
  const milestones = getDb().prepare(`SELECT id, name, km_from_tokyo, image_url, description
    FROM walk_milestones WHERE event_id=? ORDER BY km_from_tokyo`).all(ev.id);
  res.json({ success: true, event: ev, milestones });
});

// 歩数記録 (1日1回、上書きOK)
router.post('/steps', authUser, express.json({ limit: '8mb' }), (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.status(400).json({ success: false, msg: '開催中のイベントがありません' });
  const b = req.body || {};
  const steps = Math.max(0, Math.min(150000, parseInt(b.steps) || 0));
  if (!steps) return res.status(400).json({ success: false, msg: '歩数を入力してください' });
  const date = (b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) ? b.date : new Date().toISOString().slice(0, 10);
  const miles = stepsToMiles(steps);
  const source = String(b.source || 'manual').slice(0, 20);
  const photoUrl = b.photo_url ? String(b.photo_url).slice(0, 500) : null;
  const comment = b.comment ? String(b.comment).slice(0, 500) : null;
  const deviceId = b.device_id ? String(b.device_id).slice(0, 80) : null;
  getDb().prepare(`INSERT INTO walk_steps_log (user_id, event_id, log_date, steps, miles, source, photo_url, comment, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, event_id, log_date) DO UPDATE SET
      steps=excluded.steps, miles=excluded.miles, source=excluded.source,
      photo_url=COALESCE(excluded.photo_url, walk_steps_log.photo_url),
      comment=COALESCE(excluded.comment, walk_steps_log.comment),
      device_id=COALESCE(excluded.device_id, walk_steps_log.device_id),
      created_at=datetime('now')`)
    .run(req.uid, ev.id, date, steps, miles, source, photoUrl, comment, deviceId);
  const personal = recomputePersonal(req.uid, ev.id);
  recomputeTeams(ev.id);
  res.json({ success: true, personal, miles, steps });
});

// 自分の状態
router.get('/personal', authUser, (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.json({ success: true, event: null, personal: null });
  let personal = getDb().prepare('SELECT * FROM walk_personal_state WHERE user_id=? AND event_id=?').get(req.uid, ev.id);
  if (!personal) personal = recomputePersonal(req.uid, ev.id);
  // 直近30日の歩数履歴
  const history = getDb().prepare(`SELECT log_date, steps, miles, comment FROM walk_steps_log
    WHERE user_id=? AND event_id=? ORDER BY log_date DESC LIMIT 30`).all(req.uid, ev.id);
  res.json({ success: true, event: ev, personal, history });
});

// 両チーム進捗 (ロビースクリーン用)
router.get('/teams', authUser, (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.json({ success: true, event: null });
  const teams = getDb().prepare(`SELECT * FROM walk_team_progress WHERE event_id=?`).all(ev.id);
  res.json({ success: true, event: ev, teams });
});

// 個人ランキング (TOP N)
router.get('/ranking', authUser, (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.json({ success: true, ranking: [] });
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 30));
  const rows = getDb().prepare(`SELECT ps.user_id, ps.team_code, ps.total_steps, ps.total_miles, ps.distance_walked_km, ps.visited_milestones,
      u.display_name, u.nickname, u.avatar_url, u.company_code
    FROM walk_personal_state ps JOIN users u ON u.id = ps.user_id
    WHERE ps.event_id=? ORDER BY ps.total_steps DESC LIMIT ?`).all(ev.id, limit);
  // visited_milestones を JSON parse して配列化
  for (const r of rows) {
    try { r.visited_milestones = JSON.parse(r.visited_milestones || '[]'); } catch { r.visited_milestones = []; }
  }
  res.json({ success: true, event: ev, ranking: rows });
});

// 直近コメント+道中フォト (ロビースクリーン用 / 健康話題化の触媒データ)
router.get('/recent-comments', authUser, (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.json({ success: true, comments: [] });
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || 20));
  // 歩数ログのコメント (写真は OCR読取り元なので任意)
  const stepRows = getDb().prepare(`SELECT sl.log_date, sl.steps, sl.comment, sl.photo_url, sl.created_at,
      u.display_name, u.nickname, u.company_code, u.avatar_url, 'steps' AS kind
    FROM walk_steps_log sl JOIN users u ON u.id = sl.user_id
    WHERE sl.event_id=? AND sl.comment IS NOT NULL AND sl.comment <> ''
    ORDER BY sl.created_at DESC LIMIT ?`).all(ev.id, limit);
  // 道中フォト (新規 5/6: 風景写真+コメント)
  const photoRows = getDb().prepare(`SELECT NULL AS log_date, 0 AS steps, fp.comment, fp.photo_url, fp.created_at,
      u.display_name, u.nickname, u.company_code, u.avatar_url, 'field_photo' AS kind
    FROM walk_field_posts fp JOIN users u ON u.id = fp.user_id
    WHERE fp.event_id=? AND fp.deleted_at IS NULL
    ORDER BY fp.created_at DESC LIMIT ?`).all(ev.id, limit);
  // マージして created_at 降順で limit 件
  const merged = stepRows.concat(photoRows)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, limit);
  res.json({ success: true, comments: merged });
});

// 道中フォト投稿 (multer で写真+コメント) — 5/6 新設
router.post('/field-photo', authUser, upload.single('photo'), (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.status(400).json({ success: false, msg: '開催中のイベントなし' });
  if (!req.file) return res.status(400).json({ success: false, msg: '写真が必要です' });
  const comment = (req.body && req.body.comment) ? String(req.body.comment).slice(0, 200).trim() : null;
  // ファイル保存 (uploads/walk/field/<uid>_<ts>.<ext>)
  const ext = (req.file.originalname || '').match(/\.(jpe?g|png|webp|gif|heic)$/i);
  const filename = `field_${req.uid.slice(0, 8)}_${Date.now()}${ext ? ext[0].toLowerCase() : '.jpg'}`;
  const fieldDir = path.join(UPLOAD_DIR, 'field');
  fs.mkdirSync(fieldDir, { recursive: true });
  const fpath = path.join(fieldDir, filename);
  fs.writeFileSync(fpath, req.file.buffer);
  const photoUrl = `/uploads/walk/field/${filename}`;
  const ins = getDb().prepare('INSERT INTO walk_field_posts (user_id, event_id, photo_url, comment) VALUES (?, ?, ?, ?)')
    .run(req.uid, ev.id, photoUrl, comment);
  res.json({ success: true, id: ins.lastInsertRowid, photo_url: photoUrl });
});

// 自分の道中フォト一覧 (削除用)
router.get('/field-photo/mine', authUser, (req, res) => {
  const ev = getActiveEvent();
  if (!ev) return res.json({ success: true, posts: [] });
  const rows = getDb().prepare('SELECT id, photo_url, comment, created_at FROM walk_field_posts WHERE user_id=? AND event_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 30').all(req.uid, ev.id);
  res.json({ success: true, posts: rows });
});

router.delete('/field-photo/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const row = getDb().prepare('SELECT user_id FROM walk_field_posts WHERE id=?').get(id);
  if (!row) return res.status(404).json({ success: false });
  if (row.user_id !== req.uid) return res.status(403).json({ success: false, msg: '本人のみ削除可' });
  getDb().prepare("UPDATE walk_field_posts SET deleted_at=datetime('now') WHERE id=?").run(id);
  res.json({ success: true });
});

// =========== 管理者API ===========

// イベント新規作成
router.post('/admin/event', authUser, express.json(), (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者のみ' });
  const b = req.body || {};
  const name = String(b.name || '').slice(0, 200).trim();
  const startDate = String(b.start_date || '').slice(0, 10);
  const endDate = String(b.end_date || '').slice(0, 10);
  const totalKm = Math.max(1, parseFloat(b.total_route_km) || 230);
  if (!name || !startDate || !endDate) return res.status(400).json({ success: false, msg: '必須項目不足' });
  const ins = getDb().prepare(`INSERT INTO walk_events (name, start_date, end_date, total_route_km, status)
    VALUES (?, ?, ?, ?, 'active')`).run(name, startDate, endDate, totalKm);
  res.json({ success: true, id: ins.lastInsertRowid });
});

// マイルストーン追加
router.post('/admin/milestone', authUser, express.json(), (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者のみ' });
  const b = req.body || {};
  const eventId = parseInt(b.event_id) || 0;
  const name = String(b.name || '').slice(0, 100).trim();
  const km = parseFloat(b.km_from_tokyo);
  if (!eventId || !name || isNaN(km)) return res.status(400).json({ success: false, msg: '必須項目不足' });
  const ins = getDb().prepare(`INSERT INTO walk_milestones (event_id, name, km_from_tokyo, image_url, description, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)`).run(eventId, name, km, b.image_url || null, b.description || null, b.sort_order || 0);
  res.json({ success: true, id: ins.lastInsertRowid });
});

// 全員集計を再計算 (デバッグ・修正用)
router.post('/admin/recompute', authUser, express.json(), (req, res) => {
  if (!isAdmin(req.uid)) return res.status(403).json({ success: false, msg: '管理者のみ' });
  const ev = getActiveEvent();
  if (!ev) return res.json({ success: false, msg: '開催中イベントなし' });
  const users = getDb().prepare("SELECT DISTINCT user_id FROM walk_steps_log WHERE event_id=?").all(ev.id);
  for (const u of users) recomputePersonal(u.user_id, ev.id);
  recomputeTeams(ev.id);
  res.json({ success: true, recomputed: users.length });
});

module.exports = router;
