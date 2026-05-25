// =====================================================
// 出退勤打刻 + PC起動時刻記録
// =====================================================
// 設計:
//   - /punch        : ユーザーが手動で打刻 (出勤/退勤)
//   - /today        : 本日の自分の打刻状況
//   - /history      : 自分の履歴 (デフォルト30日)
//   - /pc-startup   : PC起動スクリプトから自動POST (共有シークレット認証)
//   - /admin/*      : 管理者向け閲覧 + PC起動時刻と打刻の差分
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser, authAdmin } = require('../middleware/auth');

// PC起動スクリプトからのPOSTを認証する共有シークレット
// 環境変数で設定。スクリプトを各PCに配布する際にこの値を埋め込む
const PC_STARTUP_SECRET = process.env.PC_STARTUP_SECRET || 'cohub-pc-startup-2026';

// 自動退勤推定: 最終ハートビートから何分間サイレントなら「退勤済み」と判定するか
const AUTO_OUT_SILENCE_MIN = parseInt(process.env.AUTO_OUT_SILENCE_MIN || '30');

// ===== ユーザー向け =====

// 自分の本日の打刻状況
router.get('/today', authUser, (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const rows = db.prepare(`SELECT id, punch_type, punched_at, source, note FROM time_punches
    WHERE user_id = ? AND date(punched_at) = ? ORDER BY punched_at`).all(req.uid, today);
  // 本日の最初の login (login = attendance.event_type = 'login') と PC起動時刻
  const pcStart = db.prepare(`SELECT started_at FROM pc_startup_logs
    WHERE user_id = ? AND date(started_at) = ? ORDER BY started_at LIMIT 1`).get(req.uid, today);
  // 最終ハートビート (退勤推定用)
  const lastHb = db.prepare(`SELECT MAX(last_at) AS last_at FROM pc_heartbeats WHERE user_id = ?`).get(req.uid);
  const lastHbToday = (lastHb && lastHb.last_at && lastHb.last_at.slice(0,10) === today) ? lastHb.last_at : null;
  const prefs = db.prepare('SELECT auto_punch_in, auto_punch_out FROM users WHERE id = ?').get(req.uid) || {};
  res.json({
    success: true,
    date: today,
    punches: rows,
    pc_startup_at: pcStart ? pcStart.started_at : null,
    last_heartbeat_at: lastHbToday,
    auto_punch_in: !!prefs.auto_punch_in,
    auto_punch_out: !!prefs.auto_punch_out,
  });
});

// 自動打刻のオプション設定
router.get('/me/prefs', authUser, (req, res) => {
  const p = getDb().prepare('SELECT auto_punch_in, auto_punch_out FROM users WHERE id = ?').get(req.uid) || {};
  res.json({ success: true, auto_punch_in: !!p.auto_punch_in, auto_punch_out: !!p.auto_punch_out });
});
router.put('/me/prefs', authUser, express.json(), (req, res) => {
  const b = req.body || {};
  const ain = b.auto_punch_in ? 1 : 0;
  const aout = b.auto_punch_out ? 1 : 0;
  getDb().prepare('UPDATE users SET auto_punch_in = ?, auto_punch_out = ? WHERE id = ?').run(ain, aout, req.uid);
  res.json({ success: true, auto_punch_in: !!ain, auto_punch_out: !!aout });
});

// 履歴 (デフォルト30日)
router.get('/history', authUser, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  const sinceDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const db = getDb();
  const punches = db.prepare(`SELECT id, punch_type, punched_at, source, note FROM time_punches
    WHERE user_id = ? AND date(punched_at) >= ? ORDER BY punched_at DESC`).all(req.uid, sinceDate);
  const startups = db.prepare(`SELECT started_at, pc_id FROM pc_startup_logs
    WHERE user_id = ? AND date(started_at) >= ? ORDER BY started_at DESC`).all(req.uid, sinceDate);
  res.json({ success: true, days, punches, startups });
});

// 打刻実行
router.post('/punch', authUser, (req, res) => {
  const type = (req.body && req.body.type === 'out') ? 'out' : 'in';
  const note = ((req.body && req.body.note) || '').toString().slice(0, 200);
  const source = ((req.body && req.body.source) || 'web').toString().slice(0, 20);
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const db = getDb();
  // 直近の同一種別を5分以内に重複登録するのを防止
  const dup = db.prepare(`SELECT id FROM time_punches
    WHERE user_id = ? AND punch_type = ? AND punched_at > datetime('now', 'localtime', '-5 minutes')`).get(req.uid, type);
  if (dup) return res.status(409).json({ success: false, msg: '直前と同じ打刻が登録済みです (5分以内)' });
  const ins = db.prepare(`INSERT INTO time_punches (user_id, punch_type, source, ip_address, note)
    VALUES (?, ?, ?, ?, ?)`).run(req.uid, type, source, ip, note || null);
  const row = db.prepare('SELECT id, punch_type, punched_at FROM time_punches WHERE id = ?').get(ins.lastInsertRowid);
  res.json({ success: true, punch: row });
});

// ===== PC起動スクリプトからのPOST =====
// 共有シークレット認証。POST /api/timecard/pc-startup
// body: { secret, login_id, pc_id?, started_at? (ISO) }
router.post('/pc-startup', (req, res) => {
  const body = req.body || {};
  if (body.secret !== PC_STARTUP_SECRET) {
    return res.status(403).json({ success: false, msg: 'invalid secret' });
  }
  const loginId = (body.login_id || '').toString().trim();
  if (!loginId) return res.status(400).json({ success: false, msg: 'login_id required' });
  const db = getDb();
  const u = db.prepare('SELECT id FROM users WHERE login_id = ?').get(loginId);
  if (!u) return res.status(404).json({ success: false, msg: 'user not found' });
  const pcId = (body.pc_id || '').toString().slice(0, 100) || null;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const ua = (req.headers['user-agent'] || '').toString().slice(0, 200);
  // 1日複数回起動はそのまま記録する。ただし2分以内の重複は弾く (再起動連打対策)
  const dup = db.prepare(`SELECT id FROM pc_startup_logs
    WHERE user_id = ? AND started_at > datetime('now', 'localtime', '-2 minutes')`).get(u.id);
  if (dup) return res.json({ success: true, deduped: true, id: dup.id });
  const startedAt = (body.started_at || '').toString().trim();
  let sql, params;
  if (startedAt && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(startedAt)) {
    sql = `INSERT INTO pc_startup_logs (user_id, pc_id, started_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)`;
    params = [u.id, pcId, startedAt.replace('T', ' ').slice(0, 19), ip, ua];
  } else {
    sql = `INSERT INTO pc_startup_logs (user_id, pc_id, ip_address, user_agent) VALUES (?, ?, ?, ?)`;
    params = [u.id, pcId, ip, ua];
  }
  const ins = db.prepare(sql).run(...params);

  // 自動打刻 (opt-in): 本日まだin打刻が無く auto_punch_in=1 なら起動時刻でin打刻
  try {
    const me = db.prepare('SELECT auto_punch_in FROM users WHERE id = ?').get(u.id);
    if (me && me.auto_punch_in) {
      const today = new Date().toISOString().slice(0, 10);
      const existing = db.prepare(`SELECT id FROM time_punches
        WHERE user_id = ? AND punch_type = 'in' AND date(punched_at) = ?`).get(u.id, today);
      if (!existing) {
        const punchAt = startedAt && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(startedAt)
          ? startedAt.replace('T', ' ').slice(0, 19)
          : new Date().toISOString().replace('T', ' ').slice(0, 19);
        db.prepare(`INSERT INTO time_punches (user_id, punch_type, punched_at, source, pc_id, ip_address, note)
          VALUES (?, 'in', ?, 'auto', ?, ?, ?)`).run(u.id, punchAt, pcId, ip, 'PC起動時の自動打刻');
      }
    }
  } catch (e) { console.warn('[timecard] auto punch_in fail:', e.message); }

  res.json({ success: true, id: ins.lastInsertRowid });
});

// ===== ハートビート (5分おきPCから自動Ping、退勤時刻推定用) =====
// 共有シークレット認証。POST /api/timecard/heartbeat
// body: { secret, login_id, pc_id? }
router.post('/heartbeat', (req, res) => {
  const body = req.body || {};
  if (body.secret !== PC_STARTUP_SECRET) {
    return res.status(403).json({ success: false, msg: 'invalid secret' });
  }
  const loginId = (body.login_id || '').toString().trim();
  if (!loginId) return res.status(400).json({ success: false, msg: 'login_id required' });
  const db = getDb();
  const u = db.prepare('SELECT id FROM users WHERE login_id = ?').get(loginId);
  if (!u) return res.status(404).json({ success: false, msg: 'user not found' });
  const pcId = (body.pc_id || '').toString().slice(0, 100) || '_default';
  db.prepare(`INSERT INTO pc_heartbeats (user_id, pc_id, last_at)
    VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(user_id, pc_id) DO UPDATE SET last_at = excluded.last_at`).run(u.id, pcId);
  res.json({ success: true });
});

// ===== 退勤自動推定スキャナ (auto_punch_out=1 ユーザ向け) =====
// AUTO_OUT_SILENCE_MIN分以上ハートビートが無い かつ 本日out未打刻 → 最終ハートビート時刻でout打刻
function scanAutoPunchOut() {
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const rows = db.prepare(`SELECT u.id AS user_id,
        (SELECT MAX(last_at) FROM pc_heartbeats WHERE user_id = u.id) AS last_hb
      FROM users u
      WHERE u.auto_punch_out = 1 AND u.role != 'bot'`).all();
    let n = 0;
    for (const r of rows) {
      if (!r.last_hb || r.last_hb.slice(0, 10) !== today) continue;
      // 沈黙時間
      const silentMs = Date.now() - new Date(r.last_hb.replace(' ', 'T')).getTime();
      const silentMin = silentMs / 60000;
      if (silentMin < AUTO_OUT_SILENCE_MIN) continue;
      // 本日out打刻が既にあれば対象外
      const exists = db.prepare(`SELECT id FROM time_punches
        WHERE user_id = ? AND punch_type = 'out' AND date(punched_at) = ?`).get(r.user_id, today);
      if (exists) continue;
      db.prepare(`INSERT INTO time_punches (user_id, punch_type, punched_at, source, note)
        VALUES (?, 'out', ?, 'auto', ?)`).run(r.user_id, r.last_hb, '最終ハートビートからの自動退勤');
      n++;
    }
    if (n > 0) console.log('[timecard scanAutoPunchOut] created', n, 'out punches');
  } catch (e) { console.warn('[timecard scanAutoPunchOut] fail:', e.message); }
}
// 5分おきに走らせる
setInterval(scanAutoPunchOut, 5 * 60 * 1000);
// 起動時にも1回 (デプロイ直後の取りこぼし対策)
setTimeout(scanAutoPunchOut, 30 * 1000);

// ===== 管理者向け =====

// 指定日の全社員の打刻 + PC起動時刻 + 差分
router.get('/admin/daily', authAdmin, (req, res) => {
  const date = (req.query.date || new Date().toISOString().slice(0, 10)).toString();
  const db = getDb();
  // ユーザー一覧 (botと管理者を除く、必要なら admin も含めて見せる)
  const users = db.prepare(`SELECT id, login_id, display_name, company_code, dm_group FROM users
    WHERE role != 'bot' ORDER BY company_code, display_name`).all();
  const punches = db.prepare(`SELECT id, user_id, punch_type, punched_at, source FROM time_punches
    WHERE date(punched_at) = ? ORDER BY punched_at`).all(date);
  const startups = db.prepare(`SELECT id, user_id, pc_id, started_at FROM pc_startup_logs
    WHERE date(started_at) = ? ORDER BY started_at`).all(date);
  // ユーザーごとに集約
  const byUser = new Map();
  for (const u of users) byUser.set(u.id, { ...u, in: null, out: null, pc_start: null, all_punches: [], all_startups: [] });
  for (const p of punches) {
    const row = byUser.get(p.user_id);
    if (!row) continue;
    row.all_punches.push(p);
    if (p.punch_type === 'in' && !row.in) row.in = p.punched_at;
    if (p.punch_type === 'out') row.out = p.punched_at; // 最終のout
  }
  for (const s of startups) {
    const row = byUser.get(s.user_id);
    if (!row) continue;
    row.all_startups.push(s);
    if (!row.pc_start) row.pc_start = s.started_at; // 最初の起動
  }
  // 差分計算 (PC起動 < 出勤打刻 = 打刻前作業疑い)
  const list = [];
  for (const u of users) {
    const r = byUser.get(u.id);
    let diffMin = null;
    let suspicion = false;
    if (r.pc_start && r.in) {
      const ps = new Date(r.pc_start.replace(' ', 'T'));
      const pi = new Date(r.in.replace(' ', 'T'));
      diffMin = Math.round((pi - ps) / 60000);
      // 15分以上のラグなら「打刻前作業疑い」フラグ
      if (diffMin >= 15) suspicion = true;
    }
    if (!r.pc_start && !r.in && !r.out) continue; // 全て無記録は除外
    list.push({
      user_id: u.id,
      login_id: u.login_id,
      display_name: u.display_name,
      company_code: u.company_code,
      dm_group: u.dm_group,
      pc_start: r.pc_start,
      punch_in: r.in,
      punch_out: r.out,
      diff_min: diffMin,
      suspicion,
      punches: r.all_punches,
      startups: r.all_startups,
    });
  }
  res.json({ success: true, date, list });
});

// 期間指定で打刻前作業疑いのみ抽出
router.get('/admin/discrepancies', authAdmin, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 7, 90);
  const sinceDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const db = getDb();
  // 各ユーザー×日付ごとに最初のPC起動と最初のin打刻を求める
  const rows = db.prepare(`
    WITH first_starts AS (
      SELECT user_id, date(started_at) AS d, MIN(started_at) AS pc_start
      FROM pc_startup_logs WHERE date(started_at) >= ? GROUP BY user_id, date(started_at)
    ),
    first_ins AS (
      SELECT user_id, date(punched_at) AS d, MIN(punched_at) AS punch_in
      FROM time_punches WHERE punch_type = 'in' AND date(punched_at) >= ? GROUP BY user_id, date(punched_at)
    )
    SELECT fs.user_id, fs.d AS date, fs.pc_start, fi.punch_in,
      (julianday(fi.punch_in) - julianday(fs.pc_start)) * 24 * 60 AS diff_min,
      u.login_id, u.display_name, u.company_code
    FROM first_starts fs
    JOIN first_ins fi ON fi.user_id = fs.user_id AND fi.d = fs.d
    JOIN users u ON u.id = fs.user_id
    WHERE (julianday(fi.punch_in) - julianday(fs.pc_start)) * 24 * 60 >= 15
    ORDER BY fs.d DESC, diff_min DESC
  `).all(sinceDate, sinceDate);
  res.json({ success: true, days, threshold_min: 15, rows });
});

// ===== PC配布状況ダッシュボード (管理者向け) =====
// 全ユーザーの最終PC起動 / 最終ハートビート / 配布済PC一覧
router.get('/admin/deployment-status', authAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT u.id, u.login_id, u.display_name, u.company_code, u.role, u.employee_type,
      u.auto_punch_in, u.auto_punch_out,
      (SELECT MAX(started_at) FROM pc_startup_logs WHERE user_id = u.id) AS last_startup,
      (SELECT GROUP_CONCAT(DISTINCT pc_id) FROM pc_startup_logs WHERE user_id = u.id AND pc_id IS NOT NULL) AS pc_ids,
      (SELECT MAX(last_at) FROM pc_heartbeats WHERE user_id = u.id) AS last_heartbeat
    FROM users u
    WHERE u.role != 'bot'
    ORDER BY u.company_code, u.display_name`).all();
  const now = Date.now();
  const sevenDays = 7 * 86400000;
  const list = rows.map(r => {
    const lastMs = r.last_startup ? new Date(r.last_startup.replace(' ', 'T')).getTime() : 0;
    const hbMs = r.last_heartbeat ? new Date(r.last_heartbeat.replace(' ', 'T')).getTime() : 0;
    return {
      ...r,
      deployed: lastMs > 0,                                       // 1度でも届いてれば配布済
      recent_active: (now - Math.max(lastMs, hbMs)) < sevenDays,  // 7日以内に動いている
    };
  });
  const summary = {
    total: list.length,
    deployed: list.filter(r => r.deployed).length,
    recent_active: list.filter(r => r.recent_active).length,
  };
  res.json({ success: true, summary, list });
});

// PC側ファイルテンプレートを取得 (管理者がコピーする用、シークレットは含めない)
router.get('/admin/script-template/:kind', authAdmin, (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const kind = req.params.kind;
  const map = {
    startup: 'pc_startup.ps1',
    heartbeat: 'pc_heartbeat.ps1',
    install: 'install_cowell_clients.ps1',
  };
  const filename = map[kind];
  if (!filename) return res.status(404).json({ success: false, msg: 'unknown' });
  const fp = path.join(__dirname, '..', '..', 'scripts', filename);
  try {
    const text = fs.readFileSync(fp, 'utf8');
    res.json({ success: true, filename, text });
  } catch (e) {
    res.status(404).json({ success: false, msg: 'template not found: ' + filename });
  }
});

// 個人別カスタマイズ済スクリプト一括生成 (admin用)
// GET /admin/generate-scripts/:loginId?pc_id=HQ-01
router.get('/admin/generate-scripts/:loginId', authAdmin, (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const loginId = req.params.loginId;
  const pcId = (req.query.pc_id || '').toString().trim() || (loginId + '-PC');
  const u = getDb().prepare('SELECT id, display_name, login_id FROM users WHERE login_id = ?').get(loginId);
  if (!u) return res.status(404).json({ success: false, msg: 'user not found' });
  const secret = PC_STARTUP_SECRET;
  const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
  function render(filename) {
    const fp = path.join(scriptsDir, filename);
    if (!fs.existsSync(fp)) return null;
    let t = fs.readFileSync(fp, 'utf8');
    t = t.replace(/REPLACE_LOGIN_ID/g, loginId);
    t = t.replace(/REPLACE_PC_ID/g, pcId);
    t = t.replace(/REPLACE_SECRET/g, secret);
    return t;
  }
  const out = {
    user: { login_id: u.login_id, display_name: u.display_name, pc_id: pcId },
    files: {
      'pc_startup.ps1': render('pc_startup.ps1'),
      'pc_heartbeat.ps1': render('pc_heartbeat.ps1'),
      'install_cowell_clients.ps1': render('install_cowell_clients.ps1'),
    },
  };
  res.json({ success: true, ...out });
});

module.exports = router;
