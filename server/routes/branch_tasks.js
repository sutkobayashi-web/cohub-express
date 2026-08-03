// 拠点別「やること」集計 + 各拠点グループへのダイジェスト配信 (2026-07-17)
// 目的: 個人バッジでは働かない「拠点としての当事者意識」を、拠点単位の見える化＋
//       各拠点チャットグループへの明示的な通知で担保する。
// 集計対象(現場で拠点が対応すべきタスク):
//   ①未対応の自主体調チェック (wellness_posts: category=体調 / source=点呼由来 / ack未対応 / 直近7日)
//   ②帰り(退勤前)の自主体調チェックの承認待ち (tenko_kiko: 当日 / approved_at 無し)
// ⚠️ 2026-07-27: 配信文面から「点呼」を排除し「自主体調チェック」に統一。
//    「点呼」だと倉庫・製造の社員が自分に関係ない話だと受け取ってしまうため(社長指示)。
//    DB列名/内部語(TENKO_SOURCES等)は互換のためそのまま。変えるのは"人が読む文言"だけ。
const express = require('express');
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const router = express.Router();

// ⚠️ここに '帰庫' を足さないこと。帰り(退勤前)チェック由来の声は②の承認待ち(tenko_kiko)で
//   既に同じ出来事を数えているため、①にも入れると同じ1件が拠点の「やること」に二重計上される。
//   帰り由来の気がかりは 気にかけボード(カテゴリ問わず未対応を表示)と点呼管理の未対応キューで拾う。
const TENKO_SOURCES = ['運管', '倉庫', '製造', 'セルフ'];
// 現場拠点のみ対象。管理系(本社/管理課/管理部)・非現場係は除外し「現場のやること」に集中。
const EXCLUDE = ['ADMIN', 'GUEST', 'NPO', 'UNIVERSITY', 'SU_KANRI', 'SU_KANRIBU', 'KOJI'];

function jstDate(offsetDays) {
  return new Date(Date.now() + 32400000 - (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
}
function isHQ(uid) {
  const u = getDb().prepare('SELECT role, employee_type FROM users WHERE id = ?').get(uid);
  return !!(u && (u.employee_type === 'admin' || u.role === 'admin'));
}

// 拠点ごとの未対応集計 (2クエリでGROUP BY・軽量)
function computeBoard() {
  const db = getDb();
  const today = jstDate(0);
  const since = jstDate(7); // 直近7日の未対応を「やること」として集計
  const branches = db.prepare(
    `SELECT code, name FROM companies WHERE code NOT IN (${EXCLUDE.map(() => '?').join(',')}) ORDER BY name`
  ).all(...EXCLUDE);
  const srcPh = TENKO_SOURCES.map(() => '?').join(',');
  const unh = db.prepare(
    `SELECT company_code AS code, COUNT(*) AS c FROM wellness_posts
     WHERE category='体調' AND COALESCE(ack_status,'未対応')='未対応'
       AND source_type IN (${srcPh}) AND created_at >= ? GROUP BY company_code`
  ).all(...TENKO_SOURCES, since + ' 00:00:00');
  const unhMap = Object.fromEntries(unh.map(r => [r.code, r.c]));
  const kiko = db.prepare(
    `SELECT company_code AS code, COUNT(*) AS c FROM tenko_kiko
     WHERE rec_date = ? AND (approved_at IS NULL OR approved_at = '') GROUP BY company_code`
  ).all(today);
  const kikoMap = Object.fromEntries(kiko.map(r => [r.code, r.c]));
  const rows = branches.map(b => {
    const tenko_unhandled = unhMap[b.code] || 0;
    const kiko_pending = kikoMap[b.code] || 0;
    return { code: b.code, name: b.name, tenko_unhandled, kiko_pending, total: tenko_unhandled + kiko_pending };
  });
  rows.sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name)));
  return { date: today, since, rows, grand_total: rows.reduce((s, r) => s + r.total, 0) };
}

function digestText(row) {
  const lines = ['📋 ' + row.name + ' 本日のやること'];
  if (row.total === 0) {
    lines.push('✅ 未対応はありません。お疲れさまです。');
  } else {
    if (row.tenko_unhandled > 0) lines.push('🔴 未対応の自主体調チェック ' + row.tenko_unhandled + '件 → 内容を確認して声かけ・対応をお願いします');
    if (row.kiko_pending > 0) lines.push('🟠 帰り（退勤前）の自主体調チェック 承認待ち ' + row.kiko_pending + '件 → 承認をお願いします');
    lines.push('─');
    lines.push('※運転者だけでなく、倉庫・製造・事務も対象です。各拠点で対応をお願いします。未対応が続く場合は本部で確認します。→ /tenko-manage.html');
  }
  return lines.join('\n');
}

// GET /board — HQ=全拠点 / 拠点責任者・運管=自拠点のみ
router.get('/board', authUser, (req, res) => {
  const db = getDb();
  const board = computeBoard();
  if (isHQ(req.uid)) return res.json({ success: true, hq: true, ...board });
  const u = db.prepare('SELECT company_code, is_branch_head, is_ops_manager FROM users WHERE id = ?').get(req.uid) || {};
  if (!u.is_branch_head && !u.is_ops_manager) return res.status(403).json({ success: false, msg: '拠点責任者・運行管理者・管理者のみ閲覧できます' });
  const rows = board.rows.filter(r => r.code === u.company_code);
  res.json({ success: true, hq: false, date: board.date, since: board.since, rows, grand_total: rows.reduce((s, r) => s + r.total, 0) });
});

// POST /notify — HQのみ。body: { code? (単一拠点), all? , dry_run? }
//   code指定=その拠点へ / all=未対応(total>0)の全拠点へ / dry_run=投稿せずプレビュー返却。
router.post('/notify', authUser, express.json(), (req, res) => {
  if (!isHQ(req.uid)) return res.status(403).json({ success: false, msg: '管理者のみ配信できます' });
  const db = getDb();
  const b = req.body || {};
  const dryRun = !!b.dry_run;
  const board = computeBoard();
  let targets;
  if (b.code) targets = board.rows.filter(r => r.code === b.code);
  else targets = board.rows.filter(r => r.total > 0); // 全拠点配信は未対応のある拠点のみ(空の拠点にスパムしない)
  const results = [];
  for (const row of targets) {
    const grp = db.prepare('SELECT id FROM chat_groups WHERE name = ?').get(row.name);
    const text = digestText(row);
    if (!grp) { results.push({ code: row.code, name: row.name, posted: false, reason: 'グループ未存在', text }); continue; }
    if (dryRun) { results.push({ code: row.code, name: row.name, group_id: grp.id, posted: false, dry_run: true, total: row.total, text }); continue; }
    const roomCode = 'grp_' + grp.id;
    const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, NULL, ?, ?)").run(req.uid, text, roomCode);
    try {
      const senderRow = db.prepare(`SELECT u.display_name, u.avatar_url, u.company_code, c.ring_color
        FROM users u LEFT JOIN companies c ON c.code = u.company_code WHERE u.id = ?`).get(req.uid) || {};
      const payload = { id: ins.lastInsertRowid, from: req.uid, group_id: String(grp.id), content: text, at: new Date().toISOString(), attach: null,
        sender_name: senderRow.display_name || '', sender_avatar: senderRow.avatar_url || '', sender_company: senderRow.company_code || '', sender_ring: senderRow.ring_color || '' };
      const emit = req.app.locals.emitToGroupMembers;
      if (emit) emit(String(grp.id), 'group:msg', payload);
      const sendPush = req.app.locals.sendPushToUser;
      if (sendPush) {
        const members = db.prepare('SELECT user_id FROM chat_group_members WHERE group_id = ?').all(grp.id);
        for (const m of members) {
          if (m.user_id === req.uid) continue;
          sendPush(m.user_id, { title: '[' + row.name + '] 本日のやること', body: text.slice(0, 120), tag: 'brtask-' + grp.id, url: '/?g=' + grp.id }).catch(() => {});
        }
      }
    } catch (e) { console.warn('[branch-tasks notify emit]', e.message); }
    results.push({ code: row.code, name: row.name, group_id: grp.id, posted: true, total: row.total });
  }
  res.json({ success: true, dry_run: dryRun, count: results.filter(r => r.posted).length, results });
});

module.exports = router;
