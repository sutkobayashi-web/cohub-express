// リンクプレビュー(OGP取得) 2026-06-22: チャット等でURLを貼ると、ページのタイトル/サムネを表示。
// SSRF対策(内部IP遮断)＋7日キャッシュ＋サイズ/時間制限。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const dns = require('dns').promises;

let _ensured = false;
function ensure(db) {
  if (_ensured) return;
  db.prepare(`CREATE TABLE IF NOT EXISTS link_previews (
    url TEXT PRIMARY KEY, title TEXT, description TEXT, image TEXT, site_name TEXT,
    ok INTEGER DEFAULT 1, fetched_at TEXT DEFAULT (datetime('now'))
  )`).run();
  _ensured = true;
}

// 内部/プライベートIPを遮断 (SSRF対策)
function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '::1' || /^fe80/i.test(ip) || /^f[cd]/i.test(ip)) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 等) は埋め込みIPv4で判定
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return /:/.test(ip) ? false : true;  // 解釈不能なIPv4形は遮断 (IPv6は上で個別判定済)
  const a = +m[1], b = +m[2];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;       // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}
async function safeUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  try {
    const recs = await dns.lookup(u.hostname, { all: true });
    if (!recs.length) return null;
    for (const r of recs) if (isPrivateIp(r.address)) return null;
  } catch (e) { return null; }
  return u;
}

function metaContent(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '["\'][^>]*>', 'i');
  const tag = html.match(re);
  if (!tag) return null;
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? c[1] : null;
}
function decodeEnt(s) {
  if (!s) return s;
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'").replace(/&nbsp;/g, ' ').trim();
}

async function fetchPreview(u) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 6000);
  try {
    // リダイレクトは手動追従し、各ホップを safeUrl で再検証 (公開URL→内部IPへの302でSSRFされるのを防ぐ)
    let cur = u;
    let r;
    for (let hop = 0; hop < 4; hop++) {
      r = await fetch(cur.href, {
        signal: ctrl.signal, redirect: 'manual',
        headers: { 'User-Agent': 'CoHubLinkPreview/1.0 (+https://cohub.biz-terrace.org)', 'Accept': 'text/html,*/*' }
      });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        let next;
        try { next = new URL(r.headers.get('location'), cur.href); } catch (e) { return { ok: 0 }; }
        const safe = await safeUrl(next.href);   // スキーム+解決IPを再検証
        if (!safe) return { ok: 0 };
        cur = safe;
        continue;
      }
      break;
    }
    if (!r || (r.status >= 300 && r.status < 400)) return { ok: 0 };  // リダイレクト上限超過
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return { ok: 0 };
    const clen = parseInt(r.headers.get('content-length') || '0', 10);
    if (clen && clen > 3 * 1024 * 1024) return { ok: 0 }; // 3MB超は対象外
    let html = await r.text();
    if (html.length > 4 * 1024 * 1024) html = html.slice(0, 4 * 1024 * 1024);
    let title = metaContent(html, 'og:title') || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || null;
    let image = metaContent(html, 'og:image:secure_url') || metaContent(html, 'og:image') || metaContent(html, 'twitter:image') || null;
    let desc = metaContent(html, 'og:description') || metaContent(html, 'description') || null;
    let site = metaContent(html, 'og:site_name') || u.hostname.replace(/^www\./, '');
    if (image && !/^https?:\/\//i.test(image)) { try { image = new URL(decodeEnt(image), u.href).href; } catch (e) { image = null; } }
    title = decodeEnt(title); desc = decodeEnt(desc); site = decodeEnt(site);
    return {
      ok: 1,
      title: title ? title.slice(0, 200) : null,
      description: desc ? desc.slice(0, 300) : null,
      image: image ? image.slice(0, 600) : null,
      site_name: site ? site.slice(0, 100) : null
    };
  } catch (e) { return { ok: 0 }; }
  finally { clearTimeout(timer); }
}

router.get('/', authUser, async (req, res) => {
  const url = String(req.query.url || '').slice(0, 2000);
  if (!url) return res.status(400).json({ success: false, msg: 'url必須' });
  const db = getDb(); ensure(db);
  const cached = db.prepare('SELECT * FROM link_previews WHERE url = ?').get(url);
  if (cached && (Date.now() - Date.parse((cached.fetched_at || '').replace(' ', 'T') + 'Z') < 7 * 86400 * 1000)) {
    return res.json({ success: true, preview: cached.ok ? { title: cached.title, description: cached.description, image: cached.image, site_name: cached.site_name } : null });
  }
  const u = await safeUrl(url);
  if (!u) return res.json({ success: true, preview: null }); // 不正/内部URLは静かにnull
  const p = await fetchPreview(u);
  try {
    db.prepare(`INSERT INTO link_previews (url, title, description, image, site_name, ok, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(url) DO UPDATE SET title=excluded.title, description=excluded.description, image=excluded.image, site_name=excluded.site_name, ok=excluded.ok, fetched_at=excluded.fetched_at`)
      .run(url, p.title || null, p.description || null, p.image || null, p.site_name || null, p.ok ? 1 : 0);
  } catch (e) {}
  res.json({ success: true, preview: p.ok ? { title: p.title, description: p.description, image: p.image, site_name: p.site_name } : null });
});

module.exports = router;
