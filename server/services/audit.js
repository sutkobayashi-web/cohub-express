// 監査ログ (2026-06-22): 「誰がいつログイン/重要操作したか」を追跡可能にする。
// 従来CoHubにはログイン履歴が無く、操作の事後追跡ができなかった(佐藤さん日記調査で露呈)。
const { getDb } = require('./db');

let _ensured = false;
function ensure(db) {
  if (_ensured) return;
  db.prepare(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT, actor_name TEXT, action TEXT NOT NULL,
    target TEXT, ip TEXT, ua TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at)').run(); } catch (e) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at)').run(); } catch (e) {}
  _ensured = true;
}

// Cloudflare 経由でも実クライアントIPを拾う。
// ⚠️2026-08-04: 以前は X-Forwarded-For の先頭を使っていたが、nginx が追記する仕様のため
//   クライアントが好きなIPを名乗れた=監査ログのIPを詐称できた。判定は services/net.js に集約。
const { trustedClientIp } = require('./net');
function clientIp(req) {
  if (!req) return null;
  return String(trustedClientIp(req) || '').slice(0, 64);
}

// audit(req, action, { actor_id, actor_name, target })
function audit(req, action, opts) {
  try {
    const db = getDb(); ensure(db);
    opts = opts || {};
    db.prepare('INSERT INTO audit_log (actor_id, actor_name, action, target, ip, ua) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        opts.actor_id || (req && req.uid) || null,
        opts.actor_name || null,
        String(action).slice(0, 60),
        opts.target ? String(opts.target).slice(0, 200) : null,
        clientIp(req),
        req ? String(req.headers['user-agent'] || '').slice(0, 200) : null
      );
  } catch (e) { /* 監査失敗で本処理は止めない */ }
}

module.exports = { audit, clientIp };
