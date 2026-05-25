// 拠点ごとのWi-Fi情報管理 (2026-05-21)
// タブレット画面で個人スマホ用に表示。推進メンバー/管理職がID/PWを入力
const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

function isPromoterOrAdmin(uid) {
  const r = getDb().prepare('SELECT employee_type, role, is_field_promoter, is_warehouse_promoter FROM users WHERE id = ?').get(uid);
  if (!r) return false;
  return r.employee_type === 'admin' || r.role === 'admin' || !!r.is_field_promoter || !!r.is_warehouse_promoter;
}

// 全拠点のWi-Fi情報 (タブレットキオスク用 → 認証なし)
// ※ 拠点内ネットワーク前提。事務所留置タブレット用
router.get('/list', (req, res) => {
  const rows = getDb().prepare(`
    SELECT code, name, ring_color, wifi_ssid, wifi_password, wifi_security, wifi_updated_at
    FROM companies ORDER BY code
  `).all();
  res.json({ success: true, branches: rows });
});

// 自分の編集可能拠点 (推進メンバー/管理職のみ)
router.get('/editable', authUser, (req, res) => {
  if (!isPromoterOrAdmin(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const me = getDb().prepare('SELECT id, company_code, employee_type, role FROM users WHERE id = ?').get(req.uid);
  // システム管理者(role=admin)とemployee_type=adminは全拠点編集可
  const all = (me.role === 'admin' || me.employee_type === 'admin');
  const rows = getDb().prepare(`
    SELECT code, name, wifi_ssid, wifi_password, wifi_security, wifi_updated_at, wifi_updated_by
    FROM companies ORDER BY code
  `).all();
  // 推進メンバーは自拠点のみ
  const editable = all ? rows.map(r => r.code) : (me.company_code ? [me.company_code] : []);
  res.json({ success: true, branches: rows, editable_codes: editable, is_admin: all });
});

// Wi-Fi情報更新 (推進メンバー: 自拠点のみ / 管理職: 全拠点)
router.put('/:code', authUser, express.json(), (req, res) => {
  if (!isPromoterOrAdmin(req.uid)) return res.status(403).json({ success: false, msg: '権限なし' });
  const code = String(req.params.code || '').trim();
  if (!code) return res.status(400).json({ success: false, msg: 'code required' });
  const me = getDb().prepare('SELECT company_code, employee_type, role, display_name FROM users WHERE id = ?').get(req.uid);
  const isAdminLevel = (me.role === 'admin' || me.employee_type === 'admin');
  if (!isAdminLevel && me.company_code !== code) {
    return res.status(403).json({ success: false, msg: '自営業所のみ編集可能です' });
  }
  const b = req.body || {};
  const ssid = String(b.ssid || '').slice(0, 100).trim();
  const password = String(b.password || '').slice(0, 100);
  const security = ['WPA', 'WEP', 'nopass'].includes(b.security) ? b.security : 'WPA';
  const r = getDb().prepare(`UPDATE companies SET
    wifi_ssid = ?, wifi_password = ?, wifi_security = ?,
    wifi_updated_at = datetime('now'), wifi_updated_by = ?
    WHERE code = ?`).run(ssid || null, password || null, security, req.uid, code);
  if (r.changes === 0) return res.status(404).json({ success: false, msg: '拠点が見つかりません' });
  res.json({ success: true });
});

// QRコード生成 (SVG返却・認証不要・キオスク用)
// type: 'url' = href to text, 'wifi' = WIFI:S:...;T:...;P:...;; 形式
router.get('/qr', async (req, res) => {
  const t = String(req.query.t || '').slice(0, 1000);
  if (!t) return res.status(400).send('text required');
  try {
    const svg = await QRCode.toString(t, { type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M' });
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(svg);
  } catch (e) {
    res.status(500).send('QR生成失敗');
  }
});

module.exports = router;
