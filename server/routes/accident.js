// 事故報告書API (2026-04-28 CoLink吸収)
// 製品事故 (kbc_accident_reports) と 車両事故 (vehicle_accident_reports) の2系統
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// 事故報告書 写真アップロード先 — /opt/cohub/uploads/ に直置き
// (CoLink から移行した既存写真もここにあり、URL は /uploads/<filename> で配信)
const accidentDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(accidentDir)) fs.mkdirSync(accidentDir, { recursive: true });
const accidentUpload = multer({
  storage: multer.diskStorage({
    destination: accidentDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').slice(0, 8) || '.jpg').replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, 'accident_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype || '')) return cb(new Error('画像のみアップロード可'));
    cb(null, true);
  },
});

// 写真アップロード (複数ファイル対応、最大10枚)
router.post('/upload', authUser, accidentUpload.array('photos', 10), (req, res) => {
  const urls = (req.files || []).map(f => '/uploads/' + f.filename);
  res.json({ success: true, urls });
});

// 管理職判定 (employee_type='admin' または role='admin')
function isManager(uid) {
  const r = getDb().prepare('SELECT employee_type, role FROM users WHERE id = ?').get(uid);
  return !!(r && (r.employee_type === 'admin' || r.role === 'admin'));
}

// ============================================================
// 製品事故 (倉庫荷役)
// ============================================================
// マスタ: 原因
router.get('/causes', authUser, (req, res) => {
  const rows = getDb().prepare('SELECT id, category, template, keywords, sort_order FROM kbc_accident_cause_master ORDER BY sort_order, id').all();
  res.json({ success: true, causes: rows });
});

// マスタ: 商品
router.get('/products', authUser, (req, res) => {
  const rows = getDb().prepare('SELECT id, product_category, product_name, sort_order FROM kbc_accident_product_master ORDER BY sort_order, id').all();
  res.json({ success: true, products: rows });
});

// 製品事故 一覧
router.get('/product', authUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const status = req.query.status;
  const db = getDb();
  let sql = `SELECT * FROM kbc_accident_reports`;
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY accident_date DESC, id DESC LIMIT ?';
  params.push(limit);
  res.json({ success: true, reports: db.prepare(sql).all(...params) });
});

// 製品事故 詳細
router.get('/product/:id', authUser, (req, res) => {
  const r = getDb().prepare('SELECT * FROM kbc_accident_reports WHERE id = ?').get(parseInt(req.params.id));
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  res.json({ success: true, report: r });
});

// 製品事故 新規作成
router.post('/product', authUser, express.json({ limit: '20mb' }), (req, res) => {
  const b = req.body || {};
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const reporterName = b.reporter_name || (u && u.display_name) || '不明';
  if (!b.accident_date) return res.status(400).json({ success: false, msg: '事故発生日が必須です' });
  const ins = getDb().prepare(`INSERT INTO kbc_accident_reports
    (accident_date, accident_time, weather, timing, location_floor, location_area,
     reporter_name, accident_type, product_code, product_name, product_category, quantity,
     cause_category, cause_detail, situation_template, situation_detail, damage_description,
     media_paths, label_photo_path, reporter_reflection, similar_accident_known,
     handling, handling_instruction, cost_amount, cost_status, status,
     reported_to, reported_where, police_contact)
    VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?)`).run(
    b.accident_date, b.accident_time || null, b.weather || null, b.timing || null,
    b.location_floor || null, b.location_area || null,
    reporterName, b.accident_type || '製品破損', b.product_code || null, b.product_name || null,
    b.product_category || null, b.quantity || 1,
    b.cause_category || null, b.cause_detail || null, b.situation_template || null,
    b.situation_detail || null, b.damage_description || null,
    JSON.stringify(b.media_paths || []), b.label_photo_path || null, b.reporter_reflection || null,
    b.similar_accident_known || '有',
    b.handling || '関東BCへ連絡済み・指示待ち', b.handling_instruction || null,
    b.cost_amount || null, b.cost_status || '未定', b.status || 'submitted',
    b.reported_to || null, b.reported_where || null, b.police_contact || '無し');
  res.json({ success: true, id: ins.lastInsertRowid });
});

// 製品事故 更新
router.put('/product/:id', authUser, express.json({ limit: '20mb' }), (req, res) => {
  const id = parseInt(req.params.id);
  const r = getDb().prepare('SELECT id, status FROM kbc_accident_reports WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const b = req.body || {};
  const updates = [];
  const params = [];
  const editable = ['accident_date','accident_time','weather','timing','location_floor','location_area',
    'accident_type','product_code','product_name','product_category','quantity',
    'cause_category','cause_detail','situation_template','situation_detail','damage_description',
    'reporter_reflection','similar_accident_known','handling','handling_instruction',
    'cost_amount','cost_status','status','reported_to','reported_where','police_contact'];
  for (const k of editable) {
    if (b[k] !== undefined) { updates.push(`${k} = ?`); params.push(b[k]); }
  }
  if (b.media_paths !== undefined) { updates.push('media_paths = ?'); params.push(JSON.stringify(b.media_paths)); }
  if (b.manager_comment !== undefined && isManager(req.uid)) { updates.push('manager_comment = ?'); params.push(b.manager_comment); }
  if (!updates.length) return res.json({ success: true, msg: '変更なし' });
  updates.push("updated_at = datetime('now','localtime')");
  params.push(id);
  getDb().prepare(`UPDATE kbc_accident_reports SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// 製品事故 承認
router.post('/product/:id/approve', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ承認可' });
  const id = parseInt(req.params.id);
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  getDb().prepare(`UPDATE kbc_accident_reports SET status = 'approved', approved_by = ?, approved_at = datetime('now','localtime') WHERE id = ?`)
    .run((u && u.display_name) || req.uid, id);
  res.json({ success: true });
});

// 製品事故 削除
router.delete('/product/:id', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ削除可' });
  getDb().prepare('DELETE FROM kbc_accident_reports WHERE id = ?').run(parseInt(req.params.id));
  res.json({ success: true });
});

// ============================================================
// 車両事故 (運送ドライバー)
// ============================================================
router.get('/vehicle', authUser, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const db = getDb();
  const rows = db.prepare(`SELECT v.*, u.display_name AS reporter_display
                           FROM vehicle_accident_reports v
                           LEFT JOIN users u ON u.id = v.reporter_id
                           ORDER BY v.accident_date DESC, v.id DESC LIMIT ?`).all(limit);
  res.json({ success: true, reports: rows });
});

router.get('/vehicle/:id', authUser, (req, res) => {
  const r = getDb().prepare(`SELECT v.*, u.display_name AS reporter_display
                             FROM vehicle_accident_reports v
                             LEFT JOIN users u ON u.id = v.reporter_id
                             WHERE v.id = ?`).get(parseInt(req.params.id));
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  res.json({ success: true, report: r });
});

router.post('/vehicle', authUser, express.json({ limit: '20mb' }), (req, res) => {
  const b = req.body || {};
  if (!b.accident_date) return res.status(400).json({ success: false, msg: '事故発生日が必須です' });
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const ins = getDb().prepare(`INSERT INTO vehicle_accident_reports
    (accident_date, accident_time, weather, location, reporter_id, reporter_name,
     vehicle_no, accident_type, counter_party, injury_status, police_contact,
     insurance_status, cause_summary, description, media_paths,
     repair_status, cost_amount, status)
    VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?)`).run(
    b.accident_date, b.accident_time || null, b.weather || null, b.location || null,
    req.uid, (u && u.display_name) || '',
    b.vehicle_no || null, b.accident_type || null, b.counter_party || null,
    b.injury_status || '無し', b.police_contact || '無し',
    b.insurance_status || null, b.cause_summary || null, b.description || null,
    JSON.stringify(b.media_paths || []),
    b.repair_status || null, b.cost_amount || null, b.status || 'submitted');
  res.json({ success: true, id: ins.lastInsertRowid });
});

router.put('/vehicle/:id', authUser, express.json({ limit: '20mb' }), (req, res) => {
  const id = parseInt(req.params.id);
  const r = getDb().prepare('SELECT id FROM vehicle_accident_reports WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const b = req.body || {};
  const updates = [];
  const params = [];
  const editable = ['accident_date','accident_time','weather','location','vehicle_no',
    'accident_type','counter_party','injury_status','police_contact','insurance_status',
    'cause_summary','description','repair_status','cost_amount','status'];
  for (const k of editable) {
    if (b[k] !== undefined) { updates.push(`${k} = ?`); params.push(b[k]); }
  }
  if (b.media_paths !== undefined) { updates.push('media_paths = ?'); params.push(JSON.stringify(b.media_paths)); }
  if (b.manager_comment !== undefined && isManager(req.uid)) { updates.push('manager_comment = ?'); params.push(b.manager_comment); }
  if (!updates.length) return res.json({ success: true, msg: '変更なし' });
  updates.push("updated_at = datetime('now','localtime')");
  params.push(id);
  getDb().prepare(`UPDATE vehicle_accident_reports SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

router.post('/vehicle/:id/approve', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ承認可' });
  const id = parseInt(req.params.id);
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  getDb().prepare(`UPDATE vehicle_accident_reports SET status = 'approved', approved_by = ?, approved_at = datetime('now','localtime') WHERE id = ?`)
    .run((u && u.display_name) || req.uid, id);
  res.json({ success: true });
});

router.delete('/vehicle/:id', authUser, (req, res) => {
  if (!isManager(req.uid)) return res.status(403).json({ success: false, msg: '管理職のみ削除可' });
  getDb().prepare('DELETE FROM vehicle_accident_reports WHERE id = ?').run(parseInt(req.params.id));
  res.json({ success: true });
});

// ============================================================
// 統合: 両方の集計サマリ (管理画面ダッシュボード用)
// ============================================================
router.get('/summary', authUser, (req, res) => {
  const db = getDb();
  const productByType = db.prepare(`SELECT accident_type, COUNT(*) AS cnt FROM kbc_accident_reports GROUP BY accident_type ORDER BY cnt DESC`).all();
  const productByCause = db.prepare(`SELECT cause_category, COUNT(*) AS cnt FROM kbc_accident_reports GROUP BY cause_category ORDER BY cnt DESC`).all();
  const productByMonth = db.prepare(`SELECT substr(accident_date,1,7) AS month, COUNT(*) AS cnt FROM kbc_accident_reports GROUP BY month ORDER BY month DESC LIMIT 12`).all();
  const vehicleByType = db.prepare(`SELECT accident_type, COUNT(*) AS cnt FROM vehicle_accident_reports GROUP BY accident_type ORDER BY cnt DESC`).all();
  const vehicleByMonth = db.prepare(`SELECT substr(accident_date,1,7) AS month, COUNT(*) AS cnt FROM vehicle_accident_reports GROUP BY month ORDER BY month DESC LIMIT 12`).all();
  res.json({
    success: true,
    product: { total: db.prepare('SELECT COUNT(*) AS c FROM kbc_accident_reports').get().c, byType: productByType, byCause: productByCause, byMonth: productByMonth },
    vehicle: { total: db.prepare('SELECT COUNT(*) AS c FROM vehicle_accident_reports').get().c, byType: vehicleByType, byMonth: vehicleByMonth },
  });
});

module.exports = router;
