const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// 自分のCoWell ID (cohub_uid → cw_users マッピングから取得)
function myCwIds(uid) {
  return getDb().prepare('SELECT cw_id FROM cw_users WHERE cohub_uid = ?').all(uid).map(r => r.cw_id);
}

function canViewAll(uid) {
  const u = getDb().prepare('SELECT employee_type, role, is_field_promoter FROM users WHERE id = ?').get(uid);
  return !!(u && (u.employee_type === 'admin' || u.role === 'admin' || u.is_field_promoter));
}

// サマリ (自分のCoWell履歴件数)
router.get('/summary', authUser, (req, res) => {
  const ids = myCwIds(req.uid);
  if (!ids.length) return res.json({ success: true, mapped: false, summary: null });
  const ph = ids.map(() => '?').join(',');
  const db = getDb();
  const summary = {
    posts: db.prepare(`SELECT COUNT(*) AS c FROM cw_posts WHERE cw_user_id IN (${ph})`).get(...ids).c,
    buddy_messages: db.prepare(`SELECT COUNT(*) AS c FROM cw_buddy_messages WHERE cw_user_id IN (${ph})`).get(...ids).c,
    step_days: db.prepare(`SELECT COUNT(*) AS c FROM cw_step_log WHERE cw_user_id IN (${ph})`).get(...ids).c,
    food_reports: db.prepare(`SELECT COUNT(*) AS c FROM cw_food_weekly_reports WHERE cw_user_id IN (${ph})`).get(...ids).c,
    bp_records: db.prepare(`SELECT COUNT(*) AS c FROM cw_blood_pressure WHERE cw_user_id IN (${ph})`).get(...ids).c,
    cw_users: db.prepare(`SELECT nickname, real_name FROM cw_users WHERE cohub_uid = ?`).all(req.uid),
  };
  res.json({ success: true, mapped: true, summary });
});

// 自分の食事/相談投稿
router.get('/posts', authUser, (req, res) => {
  const ids = myCwIds(req.uid);
  if (!ids.length) return res.json({ success: true, posts: [] });
  const ph = ids.map(() => '?').join(',');
  const limit = Math.min(parseInt(req.query.limit) || 100, 300);
  const rows = getDb().prepare(`SELECT cw_post_id, content, analysis, image_url, category, status, cw_created_at
    FROM cw_posts WHERE cw_user_id IN (${ph}) ORDER BY cw_created_at DESC LIMIT ?`).all(...ids, limit);
  res.json({ success: true, posts: rows });
});

// バディー会話
router.get('/buddy', authUser, (req, res) => {
  const ids = myCwIds(req.uid);
  if (!ids.length) return res.json({ success: true, messages: [] });
  const ph = ids.map(() => '?').join(',');
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const rows = getDb().prepare(`SELECT cw_id, role, content, cw_created_at FROM cw_buddy_messages
    WHERE cw_user_id IN (${ph}) ORDER BY cw_created_at DESC LIMIT ?`).all(...ids, limit);
  res.json({ success: true, messages: rows.reverse() });
});

// 歩数履歴
router.get('/steps', authUser, (req, res) => {
  const ids = myCwIds(req.uid);
  if (!ids.length) return res.json({ success: true, days: [] });
  const ph = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT step_date, SUM(steps) AS steps FROM cw_step_log
    WHERE cw_user_id IN (${ph}) GROUP BY step_date ORDER BY step_date DESC LIMIT 90`).all(...ids);
  res.json({ success: true, days: rows });
});

// 食事週次レポート
router.get('/food-reports', authUser, (req, res) => {
  const ids = myCwIds(req.uid);
  if (!ids.length) return res.json({ success: true, reports: [] });
  const ph = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT cw_report_id, week_start, week_end, meal_count, report_text, admin_comment, nutrition_scores, cw_created_at
    FROM cw_food_weekly_reports WHERE cw_user_id IN (${ph}) ORDER BY cw_created_at DESC LIMIT 30`).all(...ids);
  res.json({ success: true, reports: rows });
});

// 血圧
router.get('/bp', authUser, (req, res) => {
  const ids = myCwIds(req.uid);
  if (!ids.length) return res.json({ success: true, records: [] });
  const ph = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT systolic, diastolic, pulse, measured_at FROM cw_blood_pressure
    WHERE cw_user_id IN (${ph}) ORDER BY measured_at DESC LIMIT 50`).all(...ids);
  res.json({ success: true, records: rows });
});

// 管理者用: 全マッピング状況
router.get('/mapping', authUser, (req, res) => {
  if (!canViewAll(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const rows = getDb().prepare(`SELECT u.cw_id, u.nickname, u.real_name, u.cohub_uid, u.map_method,
    c.display_name AS cohub_name, c.login_id AS cohub_login,
    (SELECT COUNT(*) FROM cw_posts WHERE cw_user_id = u.cw_id) AS post_count,
    (SELECT COUNT(*) FROM cw_buddy_messages WHERE cw_user_id = u.cw_id) AS msg_count
    FROM cw_users u LEFT JOIN users c ON c.id = u.cohub_uid ORDER BY u.real_name`).all();
  res.json({ success: true, rows });
});

// 管理者用: 手動マッピング
router.post('/mapping/:cw_id', authUser, express.json(), (req, res) => {
  if (!canViewAll(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const cwId = req.params.cw_id;
  const cohubUid = (req.body && req.body.cohub_uid) || null;
  const db = getDb();
  if (cohubUid) {
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(cohubUid);
    if (!u) return res.status(400).json({ success: false, msg: 'cohub user 不存在' });
  }
  db.prepare("UPDATE cw_users SET cohub_uid = ?, map_method = 'manual' WHERE cw_id = ?").run(cohubUid, cwId);
  res.json({ success: true });
});

// 未マップ cw_users 一覧 (移行候補)
router.get('/unmapped-users', authUser, (req, res) => {
  if (!canViewAll(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const rows = getDb().prepare(`SELECT u.cw_id, u.nickname, u.real_name, u.department, u.cw_created_at,
    (SELECT COUNT(*) FROM cw_posts WHERE cw_user_id = u.cw_id) AS post_count,
    (SELECT COUNT(*) FROM cw_buddy_messages WHERE cw_user_id = u.cw_id) AS msg_count,
    (SELECT COUNT(*) FROM cw_blood_pressure WHERE cw_user_id = u.cw_id) AS bp_count
    FROM cw_users u WHERE u.cohub_uid IS NULL ORDER BY u.real_name`).all();
  res.json({ success: true, users: rows });
});

// CoWellユーザーをCoHubに新規作成して紐付け
router.post('/migrate-user/:cw_id', authUser, require('express').json(), (req, res) => {
  if (!canViewAll(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const cwId = req.params.cw_id;
  const db = getDb();
  const cwUser = db.prepare('SELECT * FROM cw_users WHERE cw_id = ?').get(cwId);
  if (!cwUser) return res.status(404).json({ success: false, msg: 'CoWellユーザーが見つかりません' });
  if (cwUser.cohub_uid) return res.status(400).json({ success: false, msg: '既に紐付け済みです' });

  const b = req.body || {};
  const loginId = String(b.login_id || '').trim();
  const password = String(b.password || '');
  const companyCode = String(b.company_code || 'SU_HQ');
  const role = b.role === 'admin' ? 'admin' : 'member';
  const employeeType = ['office', 'field', 'admin'].includes(b.employee_type) ? b.employee_type : 'office';
  const displayName = String(b.display_name || cwUser.real_name || cwUser.nickname || loginId).slice(0, 80);

  if (!loginId || !password) return res.status(400).json({ success: false, msg: 'ログインIDとパスワード必須' });
  if (password.length < 8) return res.status(400).json({ success: false, msg: 'パスワードは8文字以上' });
  if (!/^[a-zA-Z0-9._-]+$/.test(loginId)) return res.status(400).json({ success: false, msg: 'ログインIDは英数字 . _ - のみ' });

  const exists = db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(loginId);
  if (exists) return res.status(400).json({ success: false, msg: 'このログインIDは既に使われています' });

  const crypto = require('crypto');
  const bcrypt = require('bcryptjs');
  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync(password, 10);

  db.prepare(`INSERT INTO users (id, login_id, password_hash, display_name, company_code, role, employee_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, loginId, hash, displayName, companyCode, role, employeeType);
  db.prepare("UPDATE cw_users SET cohub_uid = ?, map_method = 'migrated' WHERE cw_id = ?").run(id, cwId);

  res.json({
    success: true,
    cohub_uid: id, login_id: loginId, display_name: displayName,
    msg: `${displayName} を作成し ${cwUser.post_count || ''} 件のCoWellデータを紐付けました`,
  });
});

// 既存CoHubユーザーに手動紐付け
router.post('/link-user/:cw_id', authUser, require('express').json(), (req, res) => {
  if (!canViewAll(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const cwId = req.params.cw_id;
  const cohubUid = String((req.body && req.body.cohub_uid) || '').trim();
  if (!cohubUid) return res.status(400).json({ success: false, msg: 'cohub_uid必須' });
  const db = getDb();
  const u = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(cohubUid);
  if (!u) return res.status(400).json({ success: false, msg: 'CoHubユーザーが存在しません' });
  db.prepare("UPDATE cw_users SET cohub_uid = ?, map_method = 'manual' WHERE cw_id = ?").run(cohubUid, cwId);
  res.json({ success: true, msg: u.display_name + ' に紐付けました' });
});

// CoWell画像プロキシ (CORP same-origin で直接配信できないため cohub経由)
// img タグから読まれるため認証なし (CoWell本体も公開配信のため同等)
router.get('/img/:filename', async (req, res) => {
  const fname = req.params.filename;
  if (!/^[a-zA-Z0-9._-]+$/.test(fname)) return res.status(400).end();
  const upstream = (process.env.COWELL_HOST || 'https://health.biz-terrace.org') + '/uploads/' + fname;
  try {
    const r = await fetch(upstream);
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).end();
  }
});

module.exports = router;
