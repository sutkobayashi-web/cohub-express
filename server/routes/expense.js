// 経費精算システム (2026-05-25 GAS移植。旧称: 仮払精算)
// 領収書画像 → Gemini OCR で自動抽出 → 申請 → 管理職が承認/差戻し → 承認済CSV出力。
// 営業所は companies を流用。承認は単純1段 (申請済/承認済/差戻し)。
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { analyzeReceiptImage } = require('../services/ai');

// 領収書画像アップロード先 — /opt/cohub/uploads/ に直置き (URL は /uploads/<filename>)
const uploadDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').slice(0, 8) || '.jpg').replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, 'receipt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + ext);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype || '')) return cb(new Error('画像のみアップロード可'));
    cb(null, true);
  },
});

// ===== 共通 =====
function isManagerUid(uid) {
  const u = getDb().prepare('SELECT employee_type FROM users WHERE id = ?').get(uid);
  return !!(u && u.employee_type === 'admin');
}
// 承認・マスタ編集は管理職 (employee_type='admin') のみ
function requireManager(req, res, next) {
  authUser(req, res, () => {
    if (!isManagerUid(req.uid)) return res.status(403).json({ success: false, msg: '承認権限 (管理職) が必要です' });
    next();
  });
}
function companyMap() {
  const m = {};
  for (const c of getDb().prepare('SELECT code, name FROM companies').all()) m[c.code] = c.name;
  return m;
}
function genExpenseId() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  return 'EXP-' + stamp + '-' + Math.random().toString(36).slice(2, 6);
}
function normAmount(v) {
  const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, ''));
  return isNaN(n) ? 0 : Math.round(n);
}
function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
// アップロード済み領収書画像の安全削除 (/uploads/ 配下のファイル名のみ。パストラバーサル防止)
function safeUnlinkUpload(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  const base = path.basename(url);
  if (!base || base.indexOf('..') !== -1) return;
  const fp = path.join(uploadDir, base);
  if (!fp.startsWith(uploadDir)) return;
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) { console.warn('[expense unlink]', e.message); }
}
// 削除可否: 管理職=全件 / 一般=自分or自営業所(承認済を除く)
function canDeleteExpense(uid, r) {
  if (isManagerUid(uid)) return true;
  if (r.status === '承認済') return false;
  const me = getDb().prepare('SELECT company_code FROM users WHERE id = ?').get(uid) || {};
  return r.created_by === uid || r.request_office === (me.company_code || '');
}

function mapRow(r, cmap) {
  return {
    id: r.id,
    apply_date: r.apply_date || '',
    request_office: r.request_office || '',
    request_office_name: cmap[r.request_office] || r.request_office || '',
    target_office: r.target_office || '',
    target_office_name: cmap[r.target_office] || r.target_office || '',
    applicant: r.applicant || '',
    usage_date: r.usage_date || '',
    vendor: r.vendor || '',
    ocr_vendor: r.ocr_vendor || '',
    amount: r.amount || 0,
    ocr_amount: r.ocr_amount || 0,
    account_title: r.account_title || '',
    summary: r.summary || '',
    receipt_date: r.receipt_date || '',
    ocr_receipt_date: r.ocr_receipt_date || '',
    invoice_no: r.invoice_no || '',
    ocr_text: r.ocr_text || '',
    image_url: r.image_url || '',
    status: r.status || '',
    checker: r.checker || '',
    checked_at: r.checked_at || '',
    return_reason: r.return_reason || '',
    created_by: r.created_by || '',
    created_at: r.created_at || '',
    updated_at: r.updated_at || '',
  };
}

// ===== 初期データ (ログインユーザー + マスタ) =====
router.get('/init', authUser, (req, res) => {
  const db = getDb();
  const me = db.prepare('SELECT id, display_name, company_code, employee_type FROM users WHERE id = ?').get(req.uid) || {};
  const cmap = companyMap();
  res.json({
    success: true,
    user: {
      uid: req.uid,
      name: me.display_name || '',
      company_code: me.company_code || '',
      company_name: cmap[me.company_code] || '',
      is_admin: me.employee_type === 'admin',
    },
    offices: db.prepare("SELECT code, name FROM companies WHERE code NOT IN ('ADMIN','UNIVERSITY','NPO','GUEST') ORDER BY code").all(),
    accountTitles: db.prepare('SELECT id, code, name FROM expense_account_titles WHERE active = 1 ORDER BY sort_order, id').all(),
    vendors: db.prepare('SELECT id, code, name, yomi, note FROM expense_vendors WHERE active = 1 ORDER BY yomi, name').all(),
    applicants: db.prepare('SELECT id, code, name, company_code FROM expense_applicants WHERE active = 1 ORDER BY company_code, name').all(),
  });
});

// ===== Gemini 領収書OCR =====
router.post('/ocr', authUser, (req, res) => {
  receiptUpload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ success: false, msg: err.message || 'アップロード失敗' });
    if (!req.file) return res.status(400).json({ success: false, msg: '画像がありません' });
    const imageUrl = '/uploads/' + req.file.filename;
    try {
      const titles = getDb().prepare('SELECT name FROM expense_account_titles WHERE active = 1 ORDER BY sort_order, id').all().map(r => r.name);
      const buf = fs.readFileSync(path.join(uploadDir, req.file.filename));
      const parsed = await analyzeReceiptImage(buf, req.file.mimetype, titles);
      res.json({ success: true, image_url: imageUrl, parsed });
    } catch (e) {
      // OCR失敗でも画像は保存済 → URLは返す (手入力で続行可能)
      res.json({ success: false, image_url: imageUrl, msg: e.message || 'OCR失敗' });
    }
  });
});

// ===== 申請登録 =====
router.post('/', authUser, express.json(), (req, res) => {
  const d = req.body || {};
  if (!d.request_office) return res.status(400).json({ success: false, msg: '申請営業所を選択してください' });
  if (!d.applicant) return res.status(400).json({ success: false, msg: '申請者を入力してください' });
  if (!normAmount(d.amount)) return res.status(400).json({ success: false, msg: '金額を入力してください' });
  const db = getDb();
  const id = genExpenseId();
  const now = nowStr();
  db.prepare(`INSERT INTO expenses
    (id, apply_date, request_office, target_office, applicant, usage_date, vendor, ocr_vendor, amount, ocr_amount,
     account_title, summary, receipt_date, ocr_receipt_date, invoice_no, ocr_text, image_url, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, d.apply_date || '', d.request_office || '', d.target_office || '', d.applicant || '', d.usage_date || '',
    d.vendor || '', d.ocr_vendor || '', normAmount(d.amount), normAmount(d.ocr_amount),
    d.account_title || '', d.summary || '', d.receipt_date || '', d.ocr_receipt_date || '', d.invoice_no || '',
    d.ocr_text || '', d.image_url || '', '申請済', req.uid, now, now
  );
  res.json({ success: true, id, msg: '申請を登録しました' });
});

// ===== 一覧 (USER=自営業所/自分の申請、管理職=全社) =====
router.get('/list', authUser, (req, res) => {
  const db = getDb();
  const cmap = companyMap();
  const admin = isManagerUid(req.uid);
  let rows;
  if (admin) {
    rows = db.prepare('SELECT * FROM expenses ORDER BY created_at DESC').all();
  } else {
    const me = db.prepare('SELECT company_code FROM users WHERE id = ?').get(req.uid) || {};
    rows = db.prepare('SELECT * FROM expenses WHERE request_office = ? OR created_by = ? ORDER BY created_at DESC')
      .all(me.company_code || '', req.uid);
  }
  // フィルタ
  const { status, vendor, dateFrom, dateTo, office } = req.query;
  let items = rows.map(r => mapRow(r, cmap));
  if (status) items = items.filter(x => x.status === status);
  if (office) items = items.filter(x => x.request_office === office);
  if (vendor) items = items.filter(x => (x.vendor || '').indexOf(vendor) >= 0);
  if (dateFrom) items = items.filter(x => x.apply_date && x.apply_date >= dateFrom);
  if (dateTo) items = items.filter(x => x.apply_date && x.apply_date <= dateTo);
  // 削除可否 (一覧は自分/自営業所に絞られているため、一般は承認済以外を削除可)
  items.forEach(x => { x.can_delete = admin || x.status !== '承認済'; });
  res.json({ success: true, items, isAdmin: admin });
});

// ===== 承認済CSV出力 (管理職) =====
router.get('/export-csv', requireManager, (req, res) => {
  const db = getDb();
  const cmap = companyMap();
  const items = db.prepare("SELECT * FROM expenses WHERE status = '承認済' ORDER BY request_office, apply_date").all().map(r => mapRow(r, cmap));
  if (!items.length) return res.json({ success: false, msg: '承認済データがありません' });
  const header = ['申請ID', '申請日', '申請営業所', '該当営業所', '申請者', '使用日', '支払先', '金額', '勘定科目', '摘要', '領収書日付', 'インボイス番号', '状態', '確認者', '確認日', '画像URL'];
  const rows = [header];
  items.forEach(x => rows.push([
    x.id, x.apply_date, x.request_office_name, x.target_office_name, x.applicant, x.usage_date,
    x.vendor, x.amount, x.account_title, x.summary, x.receipt_date, x.invoice_no,
    x.status, x.checker, x.checked_at, x.image_url,
  ]));
  const csv = rows.map(r => r.map(v => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
  const filename = '経費精算_承認済_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.csv';
  res.json({ success: true, csv, count: items.length, filename });
});

// ===== 一括承認 (管理職) =====
router.post('/approve-bulk', requireManager, express.json(), (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ success: false, msg: '承認対象がありません' });
  const db = getDb();
  const checker = (db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {}).display_name || '';
  const now = nowStr();
  const stmt = db.prepare("UPDATE expenses SET status = '承認済', checker = ?, checked_at = ?, return_reason = '', updated_at = ? WHERE id = ? AND status != '承認済'");
  let count = 0;
  const tx = db.transaction(() => { for (const id of ids) count += stmt.run(checker, now, now, id).changes; });
  tx();
  res.json({ success: true, count, msg: count + '件を承認しました' });
});

// ===== マスタCRUD (管理職) =====
const MASTER_TABLES = {
  account: { table: 'expense_account_titles', fields: ['code', 'name', 'sort_order', 'active'] },
  vendor: { table: 'expense_vendors', fields: ['code', 'name', 'yomi', 'note', 'active'] },
  applicant: { table: 'expense_applicants', fields: ['code', 'name', 'company_code', 'active'] },
};
router.post('/master/:type', requireManager, express.json(), (req, res) => {
  const def = MASTER_TABLES[req.params.type];
  if (!def) return res.status(400).json({ success: false, msg: '不正な種別' });
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ success: false, msg: '名称は必須です' });
  const cols = def.fields.filter(f => b[f] !== undefined);
  if (!cols.includes('name')) cols.push('name');
  const vals = cols.map(f => f === 'active' ? (b[f] ? 1 : 0) : (b[f] != null ? b[f] : ''));
  getDb().prepare(`INSERT INTO ${def.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  res.json({ success: true });
});
router.patch('/master/:type/:id', requireManager, express.json(), (req, res) => {
  const def = MASTER_TABLES[req.params.type];
  if (!def) return res.status(400).json({ success: false, msg: '不正な種別' });
  const b = req.body || {};
  const sets = [], params = [];
  def.fields.forEach(f => {
    if (b[f] !== undefined) { sets.push(f + ' = ?'); params.push(f === 'active' ? (b[f] ? 1 : 0) : b[f]); }
  });
  if (!sets.length) return res.status(400).json({ success: false, msg: '更新項目がありません' });
  params.push(req.params.id);
  getDb().prepare(`UPDATE ${def.table} SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});
router.delete('/master/:type/:id', requireManager, (req, res) => {
  const def = MASTER_TABLES[req.params.type];
  if (!def) return res.status(400).json({ success: false, msg: '不正な種別' });
  getDb().prepare(`DELETE FROM ${def.table} WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ===== 詳細 =====
router.get('/:id', authUser, (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const item = mapRow(r, companyMap());
  item.can_delete = canDeleteExpense(req.uid, r);
  res.json({ success: true, item });
});

// ===== 修正 (自営業所のみ / 管理職は全社) =====
router.patch('/:id', authUser, express.json(), (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!isManagerUid(req.uid)) {
    const me = db.prepare('SELECT company_code FROM users WHERE id = ?').get(req.uid) || {};
    if (r.created_by !== req.uid && r.request_office !== (me.company_code || '')) {
      return res.status(403).json({ success: false, msg: '修正権限がありません' });
    }
  }
  const d = req.body || {};
  db.prepare(`UPDATE expenses SET apply_date=?, request_office=?, target_office=?, applicant=?, usage_date=?,
     vendor=?, amount=?, account_title=?, summary=?, receipt_date=?, invoice_no=?, updated_at=? WHERE id=?`).run(
    d.apply_date || r.apply_date || '', d.request_office || '', d.target_office || '', d.applicant || '', d.usage_date || '',
    d.vendor || '', normAmount(d.amount), d.account_title || '', d.summary || '', d.receipt_date || '', d.invoice_no || '',
    nowStr(), req.params.id
  );
  res.json({ success: true, msg: '修正を保存しました' });
});

// ===== 承認 / 差戻し (管理職) =====
router.post('/:id/approve', requireManager, express.json(), (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT id FROM expenses WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const checker = (db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {}).display_name || '';
  const now = nowStr();
  db.prepare("UPDATE expenses SET status='承認済', checker=?, checked_at=?, return_reason='', updated_at=? WHERE id=?")
    .run(checker, now, now, req.params.id);
  res.json({ success: true, msg: '承認しました' });
});
router.post('/:id/return', requireManager, express.json(), (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT id FROM expenses WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const checker = (db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {}).display_name || '';
  const now = nowStr();
  db.prepare("UPDATE expenses SET status='差戻し', checker=?, checked_at=?, return_reason=?, updated_at=? WHERE id=?")
    .run(checker, now, String((req.body && req.body.reason) || ''), now, req.params.id);
  res.json({ success: true, msg: '差戻ししました' });
});

// ===== 削除 (管理職=全件 / 一般=自分or自営業所・承認済を除く)。領収書画像も一掃 =====
router.delete('/:id', authUser, (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (!canDeleteExpense(req.uid, r)) {
    const locked = !isManagerUid(req.uid) && r.status === '承認済';
    return res.status(403).json({ success: false, msg: locked ? '承認済みの申請は削除できません (管理職にご依頼ください)' : '削除権限がありません' });
  }
  safeUnlinkUpload(r.image_url);
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  res.json({ success: true, msg: '削除しました' });
});

module.exports = router;
