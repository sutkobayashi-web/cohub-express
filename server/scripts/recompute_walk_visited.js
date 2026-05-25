// 全参加者の visited_milestones を再計算 (新 SA/PA 追加後の同期)
require('dotenv').config({ path: '/opt/cohub/.env' });
process.chdir('/opt/cohub');
const { getDb } = require('/opt/cohub/server/services/db');
const db = getDb();
const STEP_M = 0.7;
const ev = db.prepare("SELECT * FROM walk_events WHERE status IN ('active','phase1_lobby','phase2_solo') ORDER BY id DESC LIMIT 1").get();
if (!ev) { console.log('no active event'); process.exit(0); }
const totalKm = ev.total_route_km || 230;
const ms = db.prepare('SELECT id, km_from_tokyo FROM walk_milestones WHERE event_id=? ORDER BY km_from_tokyo').all(ev.id);
const users = db.prepare('SELECT DISTINCT user_id FROM walk_steps_log WHERE event_id=?').all(ev.id);
let n = 0;
for (const u of users) {
  const usr = db.prepare('SELECT company_code FROM users WHERE id=?').get(u.user_id);
  if (!usr) continue;
  const team = usr.company_code === 'SZE' ? 'SZE' : 'STD';
  const agg = db.prepare('SELECT SUM(steps) AS s FROM walk_steps_log WHERE user_id=? AND event_id=?').get(u.user_id, ev.id);
  const km = Math.round(((agg.s || 0) * STEP_M / 1000) * 100) / 100;
  const visited = ms.filter(m => team === 'STD' ? km >= m.km_from_tokyo : km >= (totalKm - m.km_from_tokyo)).map(m => m.id);
  db.prepare("UPDATE walk_personal_state SET visited_milestones=?, last_updated=datetime('now') WHERE user_id=? AND event_id=?").run(JSON.stringify(visited), u.user_id, ev.id);
  n++;
}
console.log('recomputed', n, 'users / total milestones now =', ms.length);
