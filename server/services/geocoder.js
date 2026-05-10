// 住所→緯度経度ジオコーダー (Nominatim利用、DBキャッシュ付き)
// Nominatim利用規約: User-Agent必須、最大1秒1リクエスト
// 失敗時は市区まで切り詰めて再試行、それでも失敗したら null
const { getDb } = require('./db');

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'CoHub-Takara-Logistics/1.0 (sutko@stdun.biz-terrace.org)';
const SLEEP_MS = 1100;  // 1秒余裕を持たせる

// 関東圏 viewbox (左経,上緯,右経,下緯) - 山梨東部〜房総半島〜埼玉本庄〜三浦
// 宇都宮(36.55)、京都(35.0,135.7)など遠方への誤マッチを防ぐ
const VIEWBOX = '138.4,36.4,141.0,35.0';

// 住所正規化: 全角→半角、ハイフン類統一、不要記号除去
function normalizeAddress(addr) {
  if (!addr) return '';
  return String(addr)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[‐‑‒–—―ー－]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// 関東圏 viewbox に入っているか
function inKanto(lat, lng) {
  return lat >= 35.0 && lat <= 36.4 && lng >= 138.4 && lng <= 141.0;
}

let lastCall = 0;
async function rateLimitWait() {
  const now = Date.now();
  const wait = SLEEP_MS - (now - lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

function trimAddress(addr) {
  // 番地・建物名を除去して粗い住所にフォールバック
  // 例: "神奈川県横浜市西区南幸2-15-13 ABCマンション101" → "神奈川県横浜市西区"
  if (!addr) return null;
  let s = String(addr).trim();
  const m = s.match(/^(.+?[都道府県])(.+?[市郡])(.+?[区町村])/);
  if (m) return m[1] + m[2] + m[3];
  const m2 = s.match(/^(.+?[都道府県])(.+?[市郡])/);
  if (m2) return m2[1] + m2[2];
  return null;
}

async function nominatimQuery(q) {
  await rateLimitWait();
  // bounded=1で viewbox外のヒットを排除、limit=5で関東内のヒットを優先選択
  const url = `${NOMINATIM}?format=json&limit=5&countrycodes=jp&viewbox=${VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) return null;
    // 関東圏内に入る最初の結果を選択 (bounded=1なので基本的に全部入るはず)
    for (const item of j) {
      const lat = parseFloat(item.lat), lng = parseFloat(item.lon);
      if (inKanto(lat, lng)) return { lat, lng, display_name: item.display_name };
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function geocode(address, opts = {}) {
  if (!address) return null;
  const db = getDb();
  const force = opts.force === true;
  if (!force) {
    const cached = db.prepare(`SELECT lat, lng, accuracy FROM td_geocache WHERE address = ?`).get(address);
    if (cached && cached.lat != null) return { lat: cached.lat, lng: cached.lng, accuracy: cached.accuracy, cached: true };
    if (cached && cached.accuracy === 'failed') return null;
  }

  // 住所正規化
  const normalized = normalizeAddress(address);

  // フル住所で試す → 失敗したら市区まで切り詰め
  let result = await nominatimQuery(normalized);
  let accuracy = 'full';
  if (!result) {
    const trimmed = trimAddress(normalized);
    if (trimmed) {
      result = await nominatimQuery(trimmed);
      accuracy = 'ward';
    }
  }
  if (!result) {
    db.prepare(`INSERT OR REPLACE INTO td_geocache (address, lat, lng, source, accuracy, updated_at)
      VALUES (?, NULL, NULL, 'nominatim', 'failed', datetime('now'))`).run(address);
    return null;
  }
  db.prepare(`INSERT OR REPLACE INTO td_geocache (address, lat, lng, source, accuracy, updated_at)
    VALUES (?, ?, ?, 'nominatim', ?, datetime('now'))`).run(address, result.lat, result.lng, accuracy);
  return { lat: result.lat, lng: result.lng, accuracy, cached: false };
}

async function geocodeBatch(addresses, onProgress) {
  const out = {};
  let i = 0;
  for (const a of addresses) {
    i++;
    if (!a) continue;
    if (out[a] !== undefined) continue;
    const r = await geocode(a);
    out[a] = r;
    if (onProgress) onProgress(i, addresses.length, a, r);
  }
  return out;
}

module.exports = { geocode, geocodeBatch, trimAddress, normalizeAddress, inKanto };
