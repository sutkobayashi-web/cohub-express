// タブレット/アプリの「機能別 利用ログ」(2026-07-06)。
// Cloudflareの粗いPVでなく、どの機能が実際に使われたかをアプリ側で軽量に実測する
// (タブレット現場展開の検証用)。fire-and-forget で記録。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

(function ensure() {
  try {
    getDb().exec(`CREATE TABLE IF NOT EXISTS feature_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT, company_code TEXT, surface TEXT, feature TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    getDb().exec('CREATE INDEX IF NOT EXISTS idx_feature_usage ON feature_usage(created_at, feature)');
    // 本人ぶんの集計 (/mine) 用。既存の索引は created_at 始まりなので本人で絞れない。
    getDb().exec('CREATE INDEX IF NOT EXISTS idx_feature_usage_user ON feature_usage(user_id, feature, created_at)');
  } catch (e) { console.warn('[usage ensure]', e.message); }
})();

/* ⭐「今月の わたしの記録」(2026-08-08 社長)。
   狙い=見ているだけの行為を本人の数字として返し、見る→押す→自分で出す への一歩にする。
   ⚠️created_at は datetime('now') で **UTC** 保存。月初を UTC で切ると、JSTの毎月1日 0:00〜9:00 の
     記録が前月に落ちて「月初に数字が消える」。JSTで月初を決めてから -9h して比較する。 */
const JST_MONTH_START = "datetime(date(datetime('now','+9 hours'),'start of month'),'-9 hours')";
router.get('/mine', authUser, (req, res) => {
  const db = getDb();
  const one = (sql) => { try { return db.prepare(sql).get(req.uid).c || 0; } catch (e) { return 0; } };
  res.json({
    success: true,
    // なぎさの解説を最後まで開いた回数 (tablet-home の logUsage と同じ文字列)
    listen: one(`SELECT COUNT(*) AS c FROM feature_usage
      WHERE user_id = ? AND feature = 'listen:食事解説' AND created_at >= ${JST_MONTH_START}`),
    // ♡ を押した数。⚠️取り消すと行ごと消えるので「いま押している数」であって延べ回数ではない。
    likes: one(`SELECT COUNT(*) AS c FROM plaza_reactions
      WHERE user_id = ? AND created_at >= ${JST_MONTH_START}`),
  });
});

// 記録: 認証必須。feature/surface は短く制限。応答は即返す(記録失敗でもUXを止めない)。
router.post('/tap', authUser, express.json({ limit: '4kb' }), (req, res) => {
  const b = req.body || {};
  const feature = String(b.feature || '').slice(0, 60).trim();
  const surface = (String(b.surface || '').slice(0, 24).trim()) || 'tablet';
  if (!feature) return res.json({ success: false });
  try {
    const u = getDb().prepare('SELECT company_code FROM users WHERE id = ?').get(req.uid) || {};
    getDb().prepare('INSERT INTO feature_usage (user_id, company_code, surface, feature) VALUES (?,?,?,?)')
      .run(req.uid, u.company_code || '', surface, feature);
  } catch (e) { /* ログ失敗は無視 */ }
  res.json({ success: true });
});

// 集計 (管理職/admin のみ): 直近N日の機能別カウント + 拠点別
router.get('/summary', authUser, (req, res) => {
  const db = getDb();
  const me = db.prepare('SELECT employee_type, is_manager FROM users WHERE id = ?').get(req.uid) || {};
  if (!(me.employee_type === 'admin' || me.is_manager === 1)) return res.status(403).json({ success: false, msg: '管理職のみ' });
  const days = Math.min(parseInt(req.query.days, 10) || 14, 90);
  const since = '-' + days + ' days';
  const items = db.prepare(`SELECT surface, feature, COUNT(*) AS taps, COUNT(DISTINCT user_id) AS users, MAX(created_at) AS last_at
    FROM feature_usage WHERE created_at >= datetime('now', ?) GROUP BY surface, feature ORDER BY taps DESC`).all(since);
  const byOffice = db.prepare(`SELECT company_code, COUNT(*) AS taps, COUNT(DISTINCT user_id) AS users
    FROM feature_usage WHERE created_at >= datetime('now', ?) GROUP BY company_code ORDER BY taps DESC`).all(since);
  const total = db.prepare(`SELECT COUNT(*) AS taps, COUNT(DISTINCT user_id) AS users FROM feature_usage WHERE created_at >= datetime('now', ?)`).get(since);
  res.json({ success: true, days, total, items, byOffice });
});

module.exports = router;
