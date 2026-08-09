// みんなの健康月間ボード (運動=activity_logs / 食事=plaza_posts食事)
// 単月(month指定で過去履歴参照) + 累計(mode=cumulative) 対応。巻き込み設計・原則ニックネーム。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

function pad(n) { return String(n).padStart(2, '0'); }
function utc(y, m) { return new Date(Date.UTC(y, m, 1) - 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '); }
function curYM() { const j = new Date(Date.now() + 9 * 3600 * 1000); return j.getUTCFullYear() + '-' + pad(j.getUTCMonth() + 1); }
function boundsFor(ym) {
  let y, m;
  if (ym && /^\d{4}-\d{2}$/.test(ym)) { y = parseInt(ym.slice(0, 4)); m = parseInt(ym.slice(5, 7)) - 1; }
  else { const j = new Date(Date.now() + 9 * 3600 * 1000); y = j.getUTCFullYear(); m = j.getUTCMonth(); }
  const lm = m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 };
  const nm = m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 };
  return {
    label: y + '-' + pad(m + 1), monthName: (m + 1) + '月', year: y,
    thisStart: y + '-' + pad(m + 1) + '-01', lastStart: lm.y + '-' + pad(lm.m + 1) + '-01', nextStart: nm.y + '-' + pad(nm.m + 1) + '-01',
    thisUtc: utc(y, m), lastUtc: utc(lm.y, lm.m), nextUtc: utc(nm.y, nm.m),
  };
}
function nameOf(u) {
  if (u && u.nickname && String(u.nickname).trim()) return String(u.nickname).trim();
  return (u && u.display_name) || 'メンバー';
}
function streakOfDays(daysSet) {
  if (!daysSet || !daysSet.size) return 0;
  const sorted = Array.from(daysSet).sort();
  let best = 0, cur = 0, prev = null;
  for (const d of sorted) {
    if (prev && (new Date(d) - new Date(prev)) === 86400000) cur++; else cur = 1;
    if (cur > best) best = cur;
    prev = d;
  }
  return best;
}

router.get('/', authUser, (req, res) => {
  try {
    const db = getDb();
    const kind = req.query.kind === 'food' ? 'food' : 'exercise';
    const cumulative = req.query.mode === 'cumulative';
    const b = boundsFor(req.query.month);
    const foodClause = "category LIKE '%食事%' AND deleted_at IS NULL";

    // rows (uid, day)
    let rows;
    if (kind === 'exercise') {
      rows = cumulative
        ? db.prepare("SELECT user_id AS uid, date AS day FROM activity_logs WHERE deleted_at IS NULL").all()
        : db.prepare("SELECT user_id AS uid, date AS day FROM activity_logs WHERE deleted_at IS NULL AND date >= ? AND date < ?").all(b.lastStart, b.nextStart);
    } else {
      rows = cumulative
        ? db.prepare("SELECT author_id AS uid, substr(created_at,1,10) AS day FROM plaza_posts WHERE " + foodClause).all()
        : db.prepare("SELECT author_id AS uid, substr(created_at,1,10) AS day FROM plaza_posts WHERE " + foodClause + " AND created_at >= ? AND created_at < ?").all(b.lastUtc, b.nextUtc);
    }
    // earliest month (履歴ナビ用)
    let earliest = null;
    try {
      const er = kind === 'exercise'
        ? db.prepare("SELECT MIN(date) AS d FROM activity_logs WHERE deleted_at IS NULL").get()
        : db.prepare("SELECT MIN(substr(created_at,1,10)) AS d FROM plaza_posts WHERE " + foodClause).get();
      if (er && er.d) earliest = String(er.d).slice(0, 7);
    } catch (e) {}

    const users = {};
    db.prepare("SELECT id, nickname, display_name FROM users WHERE status != 'deleted'").all().forEach(u => { users[u.id] = u; });

    const thisCnt = {}, lastCnt = {}, thisDays = {}, meMonths = {};
    for (const r of rows) {
      if (!r.uid || !r.day) continue;
      if (cumulative) {
        thisCnt[r.uid] = (thisCnt[r.uid] || 0) + 1;
        (thisDays[r.uid] = thisDays[r.uid] || new Set()).add(r.day);
        (meMonths[r.uid] = meMonths[r.uid] || new Set()).add(String(r.day).slice(0, 7));
      } else if (r.day >= b.thisStart && r.day < b.nextStart) {
        thisCnt[r.uid] = (thisCnt[r.uid] || 0) + 1;
        (thisDays[r.uid] = thisDays[r.uid] || new Set()).add(r.day);
      } else if (r.day >= b.lastStart && r.day < b.thisStart) {
        lastCnt[r.uid] = (lastCnt[r.uid] || 0) + 1;
      }
    }

    const uids = Object.keys(thisCnt);
    const total = uids.reduce((s, u) => s + thisCnt[u], 0);
    const lastTotal = cumulative ? 0 : Object.keys(lastCnt).reduce((s, u) => s + lastCnt[u], 0);
    const participants = uids.length;
    const ranking = uids.map(u => ({ nick: nameOf(users[u]), count: thisCnt[u] })).sort((a, c) => c.count - a.count).slice(0, 8);

    let streakTop = null, newcomers = [];
    if (!cumulative) {
      uids.forEach(u => { const s = streakOfDays(thisDays[u]); if (!streakTop || s > streakTop.days) streakTop = { nick: nameOf(users[u]), days: s }; });
      if (!streakTop || streakTop.days < 2) streakTop = null;
      // 今月デビュー = 全期間の初回がこの月
      let firstRows = kind === 'exercise'
        ? db.prepare("SELECT user_id AS uid, MIN(date) AS first FROM activity_logs WHERE deleted_at IS NULL GROUP BY user_id").all()
        : db.prepare("SELECT author_id AS uid, MIN(substr(created_at,1,10)) AS first FROM plaza_posts WHERE " + foodClause + " GROUP BY author_id").all();
      const fm = {}; firstRows.forEach(r => { fm[r.uid] = r.first; });
      newcomers = uids.filter(u => fm[u] && fm[u] >= b.thisStart && fm[u] < b.nextStart).map(u => ({ nick: nameOf(users[u]) })).slice(0, 10);
    }

    const me = {
      count: thisCnt[req.uid] || 0,
      lastCount: lastCnt[req.uid] || 0,
      streak: streakOfDays(thisDays[req.uid]),
      days: thisDays[req.uid] ? thisDays[req.uid].size : 0,
      months: cumulative && meMonths[req.uid] ? meMonths[req.uid].size : 0,
    };

    res.json({
      success: true, kind, cumulative, month: b.label, monthName: b.monthName, year: b.year,
      total, lastTotal, participants, ranking, streakTop, newcomers, me,
      earliest, current: curYM(),
    });
  } catch (e) {
    res.status(500).json({ success: false, msg: e.message });
  }
});

module.exports = router;
