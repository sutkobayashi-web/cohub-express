const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const FIELD_VOICE_GROUP = 'g_field_voice';
// JST(+9h)基準の当日 YYYY-MM-DD
const jstDate = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function getOperator(uid) {
  return getDb().prepare(
    `SELECT id, display_name, company_code, employee_type, job_role,
            is_field_promoter, is_warehouse_promoter, is_tenko_operator
     FROM users WHERE id = ?`
  ).get(uid);
}
// 点呼者/管理者か (予め選出: フラグ or 管理職 or manager or 推進メンバー)
function isOperator(u) {
  return !!(u && (u.is_tenko_operator || u.employee_type === 'admin' || u.job_role === 'manager'
    || u.is_field_promoter || u.is_warehouse_promoter));
}

// 体調回答の重み付け (点呼)。wellness聞き取りカードと整合する severity 0/1/2 方式
const SEV = {
  facial:  { normal: 0, tired: 1, bad: 2 },
  sleep:   { ok: 0, short: 1, none: 2 },
  fatigue: { no: 0, yes: 1 },
  concern: { no: 0, yes: 1 },
};
function deriveUrgency(mode, health, condition) {
  if (mode === 'chorei') {
    if (condition === 'bad') return '高';
    if (health && health.concern === 'yes') return '中';
    return '低';
  }
  let max = 0;
  if (health) for (const k of Object.keys(SEV)) {
    const s = (SEV[k] && SEV[k][health[k]] != null) ? SEV[k][health[k]] : 0;
    if (s > max) max = s;
  }
  return max >= 2 ? '高' : max >= 1 ? '中' : '低';
}

// 営業所ロスター + 本日の実施状況
router.get('/roster', authUser, (req, res) => {
  const op = getOperator(req.uid);
  if (!isOperator(op)) return res.status(403).json({ success: false, msg: '点呼者・管理者のみ利用できます' });
  const db = getDb();
  const company = String(req.query.company || op.company_code || '').trim();
  const date = jstDate();
  const members = db.prepare(`
    SELECT id, display_name, avatar_url, job_role
    FROM users
    WHERE company_code = ?
      AND COALESCE(status,'active') NOT IN ('deleted','archived')
      AND COALESCE(role,'') <> 'bot' AND COALESCE(employee_type,'') <> 'bot' AND id NOT LIKE 'bot_%'
    ORDER BY COALESCE(dm_rank,0) DESC, display_name COLLATE NOCASE
  `).all(company);
  const recs = db.prepare(
    'SELECT target_id, mode, urgency, tokai_done, condition FROM tenko_records WHERE rec_date = ? AND company_code = ?'
  ).all(date, company);
  const recMap = {}; recs.forEach(r => { recMap[r.target_id] = r; });
  const items = members.map(m => {
    const r = recMap[m.id];
    return {
      id: m.id, name: m.display_name, avatar: m.avatar_url || '', job_role: m.job_role || '',
      mode: (m.job_role === 'driver') ? 'tenko' : 'chorei',
      done: !!r, urgency: r ? r.urgency : null,
    };
  });
  const companies = db.prepare("SELECT code, name FROM companies WHERE code NOT IN ('ADMIN','GUEST','NPO','UNIVERSITY') ORDER BY name").all();
  res.json({
    success: true, date, company, companies,
    total: items.length, done: items.filter(i => i.done).length, items,
    me: { id: op.id, name: op.display_name },
  });
});

// 本日の連絡・安全一言 取得/設定
router.get('/brief', authUser, (req, res) => {
  const op = getOperator(req.uid);
  if (!isOperator(op)) return res.status(403).json({ success: false, msg: '権限なし' });
  const company = String(req.query.company || op.company_code || '').trim();
  const row = getDb().prepare('SELECT message FROM tenko_briefs WHERE rec_date = ? AND company_code = ?').get(jstDate(), company);
  res.json({ success: true, message: row ? row.message : '' });
});
router.post('/brief', authUser, express.json(), (req, res) => {
  const op = getOperator(req.uid);
  if (!isOperator(op)) return res.status(403).json({ success: false, msg: '権限なし' });
  const company = String((req.body && req.body.company) || op.company_code || '').trim();
  const message = String((req.body && req.body.message) || '').slice(0, 500);
  getDb().prepare(`INSERT INTO tenko_briefs (rec_date, company_code, message, set_by, updated_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(rec_date, company_code) DO UPDATE SET
      message = excluded.message, set_by = excluded.set_by, updated_at = excluded.updated_at`)
    .run(jstDate(), company, message, op.id);
  res.json({ success: true });
});

// 点呼・朝礼の記録 (1日1回, 上書き)。不調(中/高)は現場の声へ自動連携
router.post('/checkin', authUser, express.json(), (req, res) => {
  const op = getOperator(req.uid);
  if (!isOperator(op)) return res.status(403).json({ success: false, msg: '点呼者・管理者のみ利用できます' });
  const db = getDb();
  const b = req.body || {};
  const target = db.prepare('SELECT id, display_name, company_code, job_role FROM users WHERE id = ?').get(String(b.target_id || ''));
  if (!target) return res.status(404).json({ success: false, msg: '対象者が見つかりません' });

  const mode = (target.job_role === 'driver') ? 'tenko' : 'chorei';
  const tokaiDone = b.tokai_done ? 1 : 0;
  const condition = b.condition ? String(b.condition).slice(0, 16) : null;
  const health = (b.health && typeof b.health === 'object') ? b.health : null;
  const note = String(b.note || '').slice(0, 300);
  const urgency = deriveUrgency(mode, health, condition);
  const date = jstDate();

  // 不調 → 現場の声(運管/倉庫POST)へ連携
  let wpId = null;
  if (urgency === '中' || urgency === '高') {
    try {
      const sourceType = mode === 'tenko' ? '運管' : '倉庫';
      const memo = `【${mode === 'tenko' ? '点呼' : '朝礼'}】${target.display_name}さんの体調確認: ${note || '(メモなし)'}`;
      const ins = db.prepare(`INSERT INTO wellness_posts
        (poster_id, company_code, category, urgency, identity_mode, memo, source_type, subject_user_id, structured_json)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(op.id, target.company_code || '', '体調', urgency, '本人特定可', memo, sourceType,
             target.id, JSON.stringify(health || { condition }));
      wpId = ins.lastInsertRowid;
      const mark = urgency === '高' ? '🔴' : '🟡';
      const content = `📝 #${wpId} 【体調】 ${mark}${urgency}\n営業所: ${target.company_code || '-'}　/　${mode === 'tenko' ? '点呼' : '朝礼'}: ${target.display_name}\n─\n${note || '(メモなし)'}`;
      const msgIns = db.prepare('INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, NULL, ?, ?)')
        .run(op.id, content, 'grp_' + FIELD_VOICE_GROUP);
      if (req.app && req.app.locals && req.app.locals.emitToGroupMembers) {
        req.app.locals.emitToGroupMembers(FIELD_VOICE_GROUP, 'group:msg', {
          id: msgIns.lastInsertRowid, from: op.id, group_id: FIELD_VOICE_GROUP,
          content, at: new Date().toISOString(), attach: null,
        });
      }
    } catch (e) { console.warn('[tenko→wellness]', e.message); }
  }

  db.prepare(`INSERT INTO tenko_records
    (rec_date, target_id, operator_id, company_code, mode, tokai_done, condition, health_json, urgency, note, wellness_post_id, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(rec_date, target_id) DO UPDATE SET
      operator_id = excluded.operator_id, mode = excluded.mode, tokai_done = excluded.tokai_done,
      condition = excluded.condition, health_json = excluded.health_json, urgency = excluded.urgency,
      note = excluded.note,
      wellness_post_id = COALESCE(excluded.wellness_post_id, tenko_records.wellness_post_id),
      updated_at = datetime('now')`)
    .run(date, target.id, op.id, target.company_code || '', mode, tokaiDone, condition,
         health ? JSON.stringify(health) : null, urgency, note, wpId);

  res.json({ success: true, urgency, escalated: !!wpId });
});

module.exports = router;
