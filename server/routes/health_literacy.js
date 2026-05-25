// ヘルスリテラシー調査 (2026-05-09 帝京大学公衆衛生学研究科 西村さん依頼)
// CCHL尺度 (Communicative and Critical Health Literacy) 5項目4段階
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const QUESTIONS = [
  '健康に関する情報を、さまざまな情報源（インターネット、テレビ、医療者など）から集めることができる',
  '集めた健康情報が信頼できるかどうかを判断することができる',
  '健康情報を理解し、自分に必要な情報を選ぶことができる',
  '得た健康情報をもとに、自分の行動を決めることができる',
  '健康に関する自分の考えや意見を、周囲の人（家族・同僚・医療者など）に伝えることができる',
];
const SCALE = [
  { v: 1, label: '全くできない' },
  { v: 2, label: 'あまりできない' },
  { v: 3, label: 'どちらともいえない' },
  { v: 4, label: 'とてもそう思う' },
];

function isWellnessManager(uid) {
  const r = getDb().prepare('SELECT employee_type, role, is_field_promoter, is_warehouse_promoter FROM users WHERE id = ?').get(uid);
  if (!r) return false;
  return r.employee_type === 'admin' || r.role === 'admin' || !!r.is_field_promoter || !!r.is_warehouse_promoter;
}

// 質問項目+選択肢+説明
router.get('/meta', authUser, (req, res) => {
  res.json({ success: true, questions: QUESTIONS, scale: SCALE });
});

// 自分の最新回答
router.get('/latest', authUser, (req, res) => {
  const row = getDb().prepare(`SELECT * FROM health_literacy WHERE user_id = ? ORDER BY id DESC LIMIT 1`).get(req.uid);
  res.json({ success: true, latest: row || null });
});

// 自分の履歴
router.get('/history', authUser, (req, res) => {
  const rows = getDb().prepare(`SELECT id, q1, q2, q3, q4, q5, total, avg_score, created_at FROM health_literacy WHERE user_id = ? ORDER BY id DESC LIMIT 20`).all(req.uid);
  res.json({ success: true, history: rows });
});

// 回答送信 (再回答可、最新が最新の評価とみなす)
router.post('/submit', authUser, express.json(), (req, res) => {
  const b = req.body || {};
  const ans = [b.q1, b.q2, b.q3, b.q4, b.q5].map(v => parseInt(v));
  if (ans.some(v => !Number.isInteger(v) || v < 1 || v > 4)) {
    return res.status(400).json({ success: false, msg: '全5問に1〜4で回答してください' });
  }
  const total = ans.reduce((a, b) => a + b, 0);
  const avg = total / 5;
  const ins = getDb().prepare(`INSERT INTO health_literacy (user_id, q1, q2, q3, q4, q5, total, avg_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.uid, ans[0], ans[1], ans[2], ans[3], ans[4], total, avg);
  res.json({ success: true, id: ins.lastInsertRowid, total, avg_score: avg });
});

// 聞き取り対象メンバー一覧 (PCがない社員向け代理入力。推進メンバー/管理職のみ)
router.get('/subjects', authUser, (req, res) => {
  if (!isWellnessManager(req.uid)) return res.status(403).json({ success: false, msg: '推進メンバー権限が必要です' });
  const db = getDb();
  const me = db.prepare('SELECT company_code FROM users WHERE id = ?').get(req.uid);
  const companyCode = me && me.company_code;
  // 登録されている全員を対象に返す (拠点フィルタなし)
  const rows = db.prepare(`
    SELECT u.id, u.login_id, u.display_name, u.company_code, u.job_role, u.avatar_url,
           h.created_at AS last_answered_at, h.avg_score AS last_avg_score
    FROM users u
    LEFT JOIN (SELECT user_id, MAX(id) AS max_id FROM health_literacy GROUP BY user_id) mx
      ON mx.user_id = u.id
    LEFT JOIN health_literacy h ON h.id = mx.max_id
    WHERE u.role != 'bot'
      AND u.id != ?
      AND u.is_guest_reviewer = 0
    ORDER BY u.company_code, u.display_name
  `).all(req.uid);
  res.json({ success: true, subjects: rows, company_code: companyCode });
});

// 代理入力(聞き取り)で他メンバーの回答を保存。推進メンバー/管理職のみ
router.post('/proxy-submit', authUser, express.json(), (req, res) => {
  if (!isWellnessManager(req.uid)) return res.status(403).json({ success: false, msg: '推進メンバー権限が必要です' });
  const b = req.body || {};
  const subjectUserId = String(b.subject_user_id || '').trim();
  if (!subjectUserId) return res.status(400).json({ success: false, msg: '対象者を選択してください' });
  const ans = [b.q1, b.q2, b.q3, b.q4, b.q5].map(v => parseInt(v));
  if (ans.some(v => !Number.isInteger(v) || v < 1 || v > 4)) {
    return res.status(400).json({ success: false, msg: '全5問に1〜4で回答してください' });
  }
  const db = getDb();
  const subj = db.prepare('SELECT id FROM users WHERE id = ?').get(subjectUserId);
  if (!subj) return res.status(404).json({ success: false, msg: '対象者が見つかりません' });
  const total = ans.reduce((a, b) => a + b, 0);
  const avg = total / 5;
  const ins = db.prepare(`INSERT INTO health_literacy (user_id, q1, q2, q3, q4, q5, total, avg_score, proxy_poster_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(subjectUserId, ans[0], ans[1], ans[2], ans[3], ans[4], total, avg, req.uid);
  res.json({ success: true, id: ins.lastInsertRowid, total, avg_score: avg });
});

// 推進メンバー/管理職向け: 全員の最新回答 (個人別)
router.get('/all-latest', authUser, (req, res) => {
  if (!isWellnessManager(req.uid)) return res.status(403).json({ success: false, msg: '推進メンバー権限が必要です' });
  // 各 user_id の最新1件を取得
  const rows = getDb().prepare(`
    SELECT h.user_id, h.q1, h.q2, h.q3, h.q4, h.q5, h.total, h.avg_score, h.created_at, h.proxy_poster_id,
           u.display_name, u.company_code, u.job_role,
           p.display_name AS proxy_name
    FROM health_literacy h
    JOIN users u ON u.id = h.user_id
    LEFT JOIN users p ON p.id = h.proxy_poster_id
    JOIN (SELECT user_id, MAX(id) AS max_id FROM health_literacy GROUP BY user_id) mx
      ON mx.max_id = h.id
    ORDER BY h.created_at DESC
  `).all();
  res.json({ success: true, responses: rows });
});

// 集計統計 (推進メンバー/管理職)
router.get('/stats', authUser, (req, res) => {
  if (!isWellnessManager(req.uid)) return res.status(403).json({ success: false, msg: '推進メンバー権限が必要です' });
  const db = getDb();
  // 各ユーザー最新1件で集計
  const latest = db.prepare(`
    SELECT h.user_id, h.q1, h.q2, h.q3, h.q4, h.q5, h.total, h.avg_score,
           u.company_code, u.job_role
    FROM health_literacy h
    JOIN users u ON u.id = h.user_id
    JOIN (SELECT user_id, MAX(id) AS max_id FROM health_literacy GROUP BY user_id) mx
      ON mx.max_id = h.id
  `).all();
  if (!latest.length) return res.json({ success: true, count: 0, overall: null, by_company: [], by_job: [], q_avg: [0,0,0,0,0] });
  const count = latest.length;
  const sum = latest.reduce((a, r) => a + r.total, 0);
  const overall = { count, total_avg: sum / count, score_avg: sum / count / 5 };
  const qSum = [0,0,0,0,0];
  for (const r of latest) { qSum[0]+=r.q1; qSum[1]+=r.q2; qSum[2]+=r.q3; qSum[3]+=r.q4; qSum[4]+=r.q5; }
  const qAvg = qSum.map(s => s / count);
  // 拠点別
  const byCompMap = new Map();
  for (const r of latest) {
    const k = r.company_code || '-';
    if (!byCompMap.has(k)) byCompMap.set(k, { count: 0, sum: 0 });
    const v = byCompMap.get(k); v.count++; v.sum += r.total;
  }
  const byCompany = [...byCompMap.entries()].map(([k, v]) => ({ company_code: k, count: v.count, score_avg: v.sum / v.count / 5 }));
  // 職種別
  const byJobMap = new Map();
  for (const r of latest) {
    const k = r.job_role || '-';
    if (!byJobMap.has(k)) byJobMap.set(k, { count: 0, sum: 0 });
    const v = byJobMap.get(k); v.count++; v.sum += r.total;
  }
  const byJob = [...byJobMap.entries()].map(([k, v]) => ({ job_role: k, count: v.count, score_avg: v.sum / v.count / 5 }));
  res.json({ success: true, count, overall, q_avg: qAvg, by_company: byCompany, by_job: byJob });
});

// 推進メンバーGCへアナウンス送信 (管理職/推進メンバーのみ)
// HL未回答者数+回答率を盛り込んだリマインドメッセージを g_field_voice に投稿
const PROMOTER_GROUP_ID = 'g_field_voice';
router.post('/announce-to-promoters', authUser, express.json(), (req, res) => {
  if (!isWellnessManager(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const db = getDb();
  const me = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(req.uid);
  if (!me) return res.status(404).json({ success: false, msg: 'user not found' });

  // 全体集計 (各ユーザー最新1件)
  const stats = db.prepare(`
    SELECT COUNT(DISTINCT u.id) AS targets,
           COUNT(DISTINCT h.user_id) AS responded
    FROM users u
    LEFT JOIN health_literacy h ON h.user_id = u.id
    WHERE u.role != 'bot' AND u.role != 'admin'
      AND (u.employee_type IS NULL OR u.employee_type NOT IN ('guest','bot'))
      AND u.is_guest_reviewer = 0
  `).get();
  const targets = stats.targets || 0;
  const responded = stats.responded || 0;
  const rate = targets ? Math.round(responded * 1000 / targets) / 10 : 0;
  const pending = targets - responded;

  // 営業所別未回答数 (上位5)
  const byBranch = db.prepare(`
    SELECT u.company_code AS code,
           COUNT(DISTINCT u.id) AS targets,
           COUNT(DISTINCT h.user_id) AS responded
    FROM users u
    LEFT JOIN health_literacy h ON h.user_id = u.id
    WHERE u.role != 'bot' AND u.role != 'admin'
      AND (u.employee_type IS NULL OR u.employee_type NOT IN ('guest','bot'))
      AND u.is_guest_reviewer = 0
    GROUP BY u.company_code
    HAVING (targets - responded) > 0
    ORDER BY (targets - responded) DESC, u.company_code
    LIMIT 5
  `).all();
  const branchLines = byBranch.map(r => `・${r.code || '(未設定)'}: ${r.targets - r.responded}名未回答 (${r.targets}名中${r.responded}名回答)`).join('\n');

  const custom = String((req.body && req.body.message) || '').slice(0, 600).trim();
  const lines = [
    `📊 ヘルスリテラシー調査 再アナウンス`,
    ``,
    `現在の回答状況: ${responded} / ${targets}名 (回答率 ${rate}%)`,
    `未回答: ${pending}名`,
  ];
  if (branchLines) lines.push(``, `■ 営業所別 未回答数 (上位5)`, branchLines);
  lines.push(``);
  if (custom) lines.push(custom, ``);
  lines.push(
    `■ 推進メンバーへのお願い`,
    `点呼・朝礼・昼礼で 🩺 聞き取りカード を起票する際、HL5問も同時入力できます。`,
    `PCを使えない社員には、推進メンバーが対面で代理入力してください。`,
    ``,
    `🔗 聞き取りカードPOST: /ops-listening.html`,
    `🔗 HLのみ代理入力: /ops-literacy.html`,
  );
  const content = lines.join('\n');

  const roomCode = 'grp_' + PROMOTER_GROUP_ID;
  const msgIns = db.prepare(`INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, NULL, ?, ?)`)
    .run(me.id, content, roomCode);

  const payload = {
    id: msgIns.lastInsertRowid,
    from: me.id,
    group_id: PROMOTER_GROUP_ID,
    content,
    at: new Date().toISOString(),
    attach: null,
  };
  if (req.app && req.app.locals && req.app.locals.emitToGroupMembers) {
    req.app.locals.emitToGroupMembers(PROMOTER_GROUP_ID, 'group:msg', payload);
  }
  try {
    const members = db.prepare('SELECT user_id FROM chat_group_members WHERE group_id = ?').all(PROMOTER_GROUP_ID);
    const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (sendPush) {
      for (const m of members) {
        if (m.user_id === me.id) continue;
        sendPush(m.user_id, {
          title: '📊 HL調査リマインド',
          body: `未回答 ${pending}名 (回答率${rate}%)。聞き取りカードと同時入力でご協力ください。`,
          tag: 'hl-announce-' + Date.now(),
          url: '/?g=' + PROMOTER_GROUP_ID,
        }).catch(() => {});
      }
    }
  } catch (e) {}

  res.json({ success: true, sent: true, targets, responded, rate, pending });
});

module.exports = router;
