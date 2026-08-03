// ============================================================
// クライアントIPの判定 (2026-08-04)
//  ⚠️⚠️これまで X-Forwarded-For の**先頭**を客のIPとして扱っていたが、nginx は
//    `$proxy_add_x_forwarded_for` で客が送ってきた値の後ろに自分の見たIPを"追記"する。
//    つまり先頭はクライアントが好きに名乗れる=事業所IP制限(TABLET_SETUP_ALLOW_IPS)を
//    ヘッダー1行で素通りできたし、監査ログのIPも詐称できた。
//  正しい順序:
//   ① nginx が上書きする X-Real-IP を「直接つないできた相手(peer)」として信頼する
//   ② peer が Cloudflare のIPなら、CF-Connecting-IP を客のIPとして信頼する
//      (Cloudflare は客が送ってきた CF-Connecting-IP を必ず自分の値で上書きする)
//   ③ peer が Cloudflare でない = オリジンに直接来た通信。ヘッダーは一切信じず peer を使う
//  ⚠️X-Forwarded-For は信じない(追記式で先頭が詐称可能なため)。
// ============================================================

// Cloudflare の公開レンジ (https://www.cloudflare.com/ips/)。増減したらここを更新する。
const CF_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CF_V6_PREFIX = [
  '2400:cb00:', '2606:4700:', '2803:f800:', '2405:b500:',
  '2405:8100:', '2a06:98c0:', '2c0f:f248:',
];

function normalize(ip) {
  return String(ip || '').trim().replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '').split('%')[0];
}
function v4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    const v = parseInt(x, 10);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n;
}
function inCidrV4(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = parseInt(bitsRaw, 10);
  const a = v4ToInt(ip), b = v4ToInt(base);
  if (a == null || b == null) return false;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}
function isCloudflare(ip) {
  const s = normalize(ip).toLowerCase();
  if (!s) return false;
  if (s.indexOf(':') >= 0) return CF_V6_PREFIX.some(p => s.startsWith(p));
  return CF_V4.some(c => inCidrV4(s, c));
}

// 詐称できないクライアントIP。判定できないときは空文字 (=どのIP許可リストにも当たらない)。
function trustedClientIp(req) {
  if (!req || !req.headers) return '';
  const peer = normalize(req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || req.ip);
  if (peer && isCloudflare(peer)) {
    const cf = normalize(req.headers['cf-connecting-ip']);
    if (cf) return cf;
  }
  return peer || '';
}

// 前方一致の許可リスト判定 (.env の TABLET_SETUP_ALLOW_IPS と同じ書式)
function ipAllowed(ip, list) {
  const s = normalize(ip);
  if (!s) return false;
  return list.some(a => s === a || s.indexOf(a) === 0);
}

// ============================================================
// 設置端末(共用タブレット)の登録 — 2026-08-04
//  ⚠️ログイン前の名前選択画面が全社員の氏名を返すため、何かで「正規の端末か」を見分ける必要がある。
//    IPで見分けるのは無理があった: 実測で拠点のグローバルIPは1か月半に2回入れ替わっており
//    (7/10・7/25)、許可リストの棚卸しを忘れると現場が止まる。端末は動かないのでこちらを正とする。
//  発行は事業所ネットワークからのみ(=今までのIP制限をそのまま入口として使い、
//  1回きりの登録に変える)。以後は端末が持つトークンで判定するのでIPが変わっても切れない。
//  ⚠️トークンはハッシュで保存する(DBを見ても端末になりすませない)。
// ============================================================
const crypto = require('crypto');
function ensureDeviceTable(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS kiosk_devices (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    company_code TEXT,
    label TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    created_ip TEXT,
    last_seen_at TEXT,
    last_seen_ip TEXT,
    revoked_at TEXT
  )`).run();
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_kiosk_dev_hash ON kiosk_devices(token_hash)').run(); } catch (e) {}
}
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function issueDeviceToken(db, { companyCode, label, ip }) {
  ensureDeviceTable(db);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO kiosk_devices (id, token_hash, company_code, label, created_ip)
    VALUES (?, ?, ?, ?, ?)`).run(crypto.randomUUID(), hashToken(token), companyCode || null,
    String(label || '').slice(0, 60) || null, String(ip || '').slice(0, 64));
  return token;
}
// リクエストが持つ端末トークンを検証し、端末の行を返す (無効なら null)。
function deviceOf(db, req) {
  const t = (req && req.headers && req.headers['x-device-token'])
    || (req && req.query && req.query.dev) || '';
  if (!t) return null;
  try {
    ensureDeviceTable(db);
    const row = db.prepare('SELECT * FROM kiosk_devices WHERE token_hash = ? AND revoked_at IS NULL').get(hashToken(t));
    if (!row) return null;
    try {
      db.prepare("UPDATE kiosk_devices SET last_seen_at = datetime('now'), last_seen_ip = ? WHERE id = ?")
        .run(String(trustedClientIp(req) || '').slice(0, 64), row.id);
    } catch (e) {}
    return row;
  } catch (e) { return null; }
}

module.exports = { trustedClientIp, isCloudflare, ipAllowed, ensureDeviceTable, issueDeviceToken, deviceOf };
