const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// ===== ログイン時の「本日の会議 議題」仕掛け =====
// app_settings(key='login_agenda') に JSON で保持し、当日(localtime)かつ active かつ
// 対象(audience)に合致するユーザーがログインした時だけ /today が議題を返す(表示可否はサーバーで判定)。
//  { active, date:'YYYY-MM-DD', title, intro, points:[...], close,
//    audience:'managers_promoters'|'managers'|'all', by }
function loadAgenda() {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = 'login_agenda'").get();
  if (!row || !row.value) return null;
  try { return JSON.parse(row.value); } catch (e) { return null; }
}
function isManagerUser(u) {
  return !!(u && (u.is_manager || u.role === 'admin' || u.employee_type === 'admin' || u.job_role === 'manager'));
}
function inAudience(u, audience) {
  if (!u) return false;
  if (audience === 'all') return true;
  if (audience === 'managers') return isManagerUser(u);
  // 既定 = 管理職 + 推進メンバー(現場/倉庫)
  return isManagerUser(u) || !!u.is_field_promoter || !!u.is_warehouse_promoter;
}

// 本日の議題(対象者のみ返る)。既読管理はフロント(localStorage)。
router.get('/today', authUser, (req, res) => {
  const a = loadAgenda();
  if (!a || !a.active) return res.json({ success: true, agenda: null });
  const today = getDb().prepare("SELECT date('now','localtime') AS d").get().d;
  if (String(a.date) !== today) return res.json({ success: true, agenda: null });
  const u = getDb().prepare(
    'SELECT is_manager, is_field_promoter, is_warehouse_promoter, role, employee_type, job_role FROM users WHERE id = ?'
  ).get(req.uid);
  if (!inAudience(u, a.audience || 'managers_promoters')) return res.json({ success: true, agenda: null });
  res.json({
    success: true,
    agenda: {
      key: String(a.date) + '|' + String(a.title || ''), // フロントの既読キー
      title: a.title || '',
      intro: a.intro || '',
      points: Array.isArray(a.points) ? a.points : [],
      close: a.close || '',
      date: a.date,
    },
  });
});

// 議題の設定/差し替え(管理職のみ)。次回会議もここで更新すれば同じ仕掛けが再利用できる。
router.post('/set', authUser, express.json(), (req, res) => {
  const u = getDb().prepare(
    'SELECT display_name, is_manager, role, employee_type, job_role FROM users WHERE id = ?'
  ).get(req.uid);
  if (!isManagerUser(u)) return res.status(403).json({ success: false, msg: '管理職のみ' });
  const b = req.body || {};
  const today = getDb().prepare("SELECT date('now','localtime') AS d").get().d;
  const data = {
    active: b.active !== false,
    date: String(b.date || today),
    title: String(b.title || '').slice(0, 200),
    intro: String(b.intro || '').slice(0, 500),
    points: (Array.isArray(b.points) ? b.points : []).slice(0, 8).map((p) => String(p).slice(0, 300)),
    close: String(b.close || '').slice(0, 300),
    audience: ['all', 'managers', 'managers_promoters'].indexOf(b.audience) >= 0 ? b.audience : 'managers_promoters',
    by: (u && u.display_name) || '',
  };
  getDb()
    .prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('login_agenda', ?, datetime('now')) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    )
    .run(JSON.stringify(data));
  res.json({ success: true, agenda: data });
});

module.exports = router;
