// 凝集型テーマ投票 (CoWell v2 移植 minimum viable)
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateText } = require('../services/ai');

const STATUSES = ['投票中', '専門家精査中', '施策化', '却下', '完了'];
const VOTES = [-1, 0, 1, 2];

function isManager(uid) {
  const u = getDb().prepare('SELECT employee_type, role, is_field_promoter, is_guest_reviewer FROM users WHERE id = ?').get(uid);
  return !!(u && (u.employee_type === 'admin' || u.role === 'admin' || u.is_field_promoter));
}
function isAdvisor(uid) {
  const u = getDb().prepare('SELECT is_guest_reviewer, employee_type FROM users WHERE id = ?').get(uid);
  return !!(u && (u.is_guest_reviewer || u.employee_type === 'admin'));
}

// 一覧 (全員閲覧可)
router.get('/', authUser, (req, res) => {
  const cycle = req.query.cycle ? parseInt(req.query.cycle) : null;
  const db = getDb();
  let sql = `SELECT t.*, u.display_name AS created_by_name, a.display_name AS advisor_name,
             (SELECT COUNT(*) FROM wellness_theme_votes WHERE theme_id = t.id) AS vote_count,
             (SELECT COALESCE(SUM(vote), 0) FROM wellness_theme_votes WHERE theme_id = t.id) AS vote_sum,
             (SELECT vote FROM wellness_theme_votes WHERE theme_id = t.id AND user_id = ?) AS my_vote
             FROM wellness_themes t
             LEFT JOIN users u ON u.id = t.created_by
             LEFT JOIN users a ON a.id = t.advisor_id
             WHERE t.deleted_at IS NULL`;
  const params = [req.uid];
  if (cycle) { sql += ' AND t.cycle_no = ?'; params.push(cycle); }
  sql += ' ORDER BY t.cycle_no DESC, t.id DESC LIMIT 100';
  res.json({ success: true, themes: db.prepare(sql).all(...params) });
});

// 起票 (管理職/推進メンバーのみ)
router.post('/', authUser, express.json(), (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '起票権限なし' });
  const b = req.body || {};
  const title = String(b.title || '').slice(0, 200).trim();
  if (!title) return res.status(400).json({ success: false, msg: 'タイトル必須' });
  const cycleNo = parseInt(b.cycle_no) || 1;
  const ins = getDb().prepare(`INSERT INTO wellness_themes (cycle_no, title, description, source_summary, created_by)
    VALUES (?, ?, ?, ?, ?)`).run(
    cycleNo, title, String(b.description || '').slice(0, 2000),
    String(b.source_summary || '').slice(0, 1000), req.uid
  );
  res.json({ success: true, id: ins.lastInsertRowid });
});

// 投票
router.post('/:id/vote', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const vote = parseInt((req.body && req.body.vote));
  if (!VOTES.includes(vote)) return res.status(400).json({ success: false, msg: '投票値不正' });
  const comment = String((req.body && req.body.comment) || '').slice(0, 500);
  const db = getDb();
  const t = db.prepare('SELECT id, status FROM wellness_themes WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!t) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (t.status !== '投票中') return res.status(400).json({ success: false, msg: '投票期間ではありません' });
  db.prepare(`INSERT INTO wellness_theme_votes (theme_id, user_id, vote, comment)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(theme_id, user_id) DO UPDATE SET vote = excluded.vote, comment = excluded.comment`)
    .run(id, req.uid, vote, comment);
  res.json({ success: true });
});

// 投票詳細 (誰が何票)
router.get('/:id/votes', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  if (!isManager(req.uid) && !isAdvisor(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const rows = getDb().prepare(`SELECT v.vote, v.comment, v.created_at, u.display_name, u.company_code
    FROM wellness_theme_votes v LEFT JOIN users u ON u.id = v.user_id
    WHERE v.theme_id = ? ORDER BY v.created_at DESC`).all(id);
  res.json({ success: true, votes: rows });
});

// 専門家コメント (ゲストレビュアー or 管理職)
router.post('/:id/advisor', authUser, express.json(), (req, res) => {
  if (!isAdvisor(req.uid)) return res.status(403).json({ success: false, msg: '専門家権限なし' });
  const id = parseInt(req.params.id);
  const comment = String((req.body && req.body.comment) || '').slice(0, 2000).trim();
  if (!comment) return res.status(400).json({ success: false, msg: 'コメント必須' });
  getDb().prepare(`UPDATE wellness_themes SET advisor_comment = ?, advisor_id = ?, advisor_at = datetime('now') WHERE id = ?`)
    .run(comment, req.uid, id);
  res.json({ success: true });
});

// ステータス更新 (管理職)
router.post('/:id/status', authUser, express.json(), (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const id = parseInt(req.params.id);
  const status = String((req.body && req.body.status) || '');
  if (!STATUSES.includes(status)) return res.status(400).json({ success: false, msg: 'ステータス不正' });
  const db = getDb();
  if (status === '完了' || status === '却下') {
    db.prepare("UPDATE wellness_themes SET status = ?, closed_at = datetime('now') WHERE id = ?").run(status, id);
  } else {
    db.prepare('UPDATE wellness_themes SET status = ? WHERE id = ?').run(status, id);
  }
  res.json({ success: true });
});

// AI でテーマ案を生成 (現場の声/施策ボードから)
router.post('/ai-suggest', authUser, express.json(), async (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const days = Math.min(parseInt((req.body && req.body.days) || 60), 180);
  const db = getDb();
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const posts = db.prepare(`SELECT category, urgency, memo, company_code FROM wellness_posts WHERE created_at >= ?`).all(since);
  if (!posts.length) return res.json({ success: false, msg: 'データ不足 (現場の声POST 0件)' });
  const lines = posts.map(p => `[${p.category}|緊急${p.urgency}|${p.company_code || '-'}] ${p.memo || '(なし)'}`).join('\n');
  const prompt = `中小運送業の健康管理室にあがった「現場の声」を分析し、全社で投票して取り組むべきテーマ案を3〜5本提案してください。
テーマは「全員が共感しやすい」「2〜3カ月で動かせる」「業界特有の課題を捉えた」ものを優先。

現場の声 (過去${days}日, ${posts.length}件):
${lines}

以下の純粋なJSON (前置き禁止) で回答:
{"themes": [{"title": "30字以内テーマ名", "description": "60字以内、なぜ重要か", "source_summary": "根拠となる声の要約40字"}]}`;
  try {
    const aiText = await generateText(prompt, { maxTokens: 3000, responseMimeType: 'application/json' });
    let cleaned = String(aiText || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) cleaned = m[0];
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      // 切詰フォールバック
      let fixed = cleaned;
      const obs = (fixed.match(/\[/g) || []).length;
      const cbs = (fixed.match(/\]/g) || []).length;
      const opens = (fixed.match(/\{/g) || []).length;
      const closes = (fixed.match(/\}/g) || []).length;
      if (obs > cbs) fixed += ']'.repeat(obs - cbs);
      if (opens > closes) fixed += '}'.repeat(opens - closes);
      parsed = JSON.parse(fixed);
    }
    res.json({ success: true, suggestions: parsed.themes || [] });
  } catch (e) {
    console.warn('[themes/ai-suggest] fail:', e.message);
    res.status(500).json({ success: false, msg: 'AI失敗: ' + e.message });
  }
});

// 削除 (起票者または管理職)
router.delete('/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const t = db.prepare('SELECT created_by FROM wellness_themes WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!t) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (t.created_by !== req.uid && !isManager(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  db.prepare("UPDATE wellness_themes SET deleted_at = datetime('now') WHERE id = ?").run(id);
  res.json({ success: true });
});

module.exports = router;
