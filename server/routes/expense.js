// 経費精算システム (2026-05-25 GAS移植。旧称: 仮払精算)
// 領収書画像 → Gemini OCR で自動抽出 → 申請 → 管理職が承認/差戻し → 承認済CSV出力。
// 営業所は companies を流用。承認は単純1段 (申請済/承認済/差戻し)。
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { analyzeReceiptImage } = require('../services/ai');

// ===== 領収書PDFのページ画像化 (poppler pdftoppm) =====
// スマホ/PWA/iOS Safari は <embed>/<iframe> のPDFインライン描画が不安定なため、
// 掲示板(board.js)と同じくページを .pN.jpg 画像へ変換して確実にプレビューする。
// 命名規則: /uploads/receipt_X.pdf → 1ページ目大 receipt_X.pdf.p1.jpg ... / サムネ receipt_X.pdf.thumb.jpg
const RECEIPT_PDF_MAX_PAGES = 20;
function pdfPageCount(absPdf) {
  try {
    const out = execFileSync('pdfinfo', [absPdf], { timeout: 15000 }).toString();
    const m = out.match(/^Pages:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : 0;
  } catch (_) { return 0; }
}
// 1ページ目(サムネ+閲覧用大)を同期生成→アップロード直後のプレビューに間に合わせる。2ページ目以降は非同期。
function generateReceiptPdfImages(absPdf) {
  try { execFileSync('pdftoppm', ['-jpeg', '-singlefile', '-f', '1', '-l', '1', '-scale-to', '480', absPdf, absPdf + '.thumb'], { timeout: 20000 }); } catch (_) {}
  try { execFileSync('pdftoppm', ['-jpeg', '-singlefile', '-f', '1', '-l', '1', '-scale-to', '1400', absPdf, absPdf + '.p1'], { timeout: 25000 }); } catch (_) {}
  const pages = Math.min(pdfPageCount(absPdf) || 1, RECEIPT_PDF_MAX_PAGES);
  let n = 2;
  const next = () => {
    if (n > pages) return;
    const p = n++;
    execFile('pdftoppm', ['-jpeg', '-singlefile', '-f', String(p), '-l', String(p), '-scale-to', '1400', absPdf, absPdf + '.p' + p], { timeout: 30000 }, () => next());
  };
  next();
}
// アップロードされたファイルがPDFならページ画像を生成 (絶対パスは uploadDir 配下に限定)
function maybeGenerateReceiptPdf(filename, mimetype) {
  if (mimetype !== 'application/pdf' && !/\.pdf$/i.test(filename || '')) return;
  const abs = path.join(uploadDir, path.basename(filename));
  if (!abs.startsWith(uploadDir) || !fs.existsSync(abs)) return;
  try { generateReceiptPdfImages(abs); } catch (e) { console.warn('[expense pdf img]', e.message); }
}

// 領収書画像アップロード先 — /opt/cohub/uploads/ に直置き (URL は /uploads/<filename>)
const uploadDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').slice(0, 8) || '.jpg').replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, 'receipt_' + crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mt = file.mimetype || '';
    // 領収書は画像に加えてPDFも許可 (レシートをPDFで受け取るケース対応)
    if (!/^image\//.test(mt) && mt !== 'application/pdf') return cb(new Error('画像またはPDFのみアップロード可'));
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
// 経費の「承認」権限は 経営管理本部長(HQA)・管理部長(MBD)・代表取締役社長(PRES) のみ (2026-07-03 後藤要望、2026-07-09 ADM→MBD役職改編)。
// 役職の割当 (appr_role_assignments) を正とし、異動追従できるようにする。
function canApproveExpenseUid(uid) {
  const db = getDb();
  const u = db.prepare('SELECT login_id FROM users WHERE id = ?').get(uid);
  if (!u || !u.login_id) return false;
  const row = db.prepare("SELECT 1 FROM appr_role_assignments WHERE user_login_id = ? AND role_code IN ('HQA','MBD','PRES') LIMIT 1").get(u.login_id);
  return !!row;
}
function requireApprover(req, res, next) {
  authUser(req, res, () => {
    if (!canApproveExpenseUid(req.uid)) return res.status(403).json({ success: false, msg: '経費の承認権限は経営管理本部・管理部のみです' });
    next();
  });
}
// 最終承認者(役職 HQA/MBD/PRES の割当者)を氏名+役職名で返す。承認ルート表示用(申請フローに名前を出す)。
// 同一人物が複数役職/営業所で割当されていても login_id で一意化。表示順=本部長→管理部長→社長。
function finalApproverList() {
  const db = getDb();
  const roleName = { HQA: '経営管理本部長', MBD: '管理部長', PRES: '代表取締役社長' };
  const order = { HQA: 0, MBD: 1, PRES: 2 };
  const rows = db.prepare(`SELECT a.role_code, a.user_login_id, u.display_name
    FROM appr_role_assignments a LEFT JOIN users u ON u.login_id = a.user_login_id
    WHERE a.role_code IN ('HQA','MBD','PRES')`).all();
  rows.sort((a, b) => (order[a.role_code] - order[b.role_code]));
  const seen = new Set(); const out = [];
  for (const r of rows) {
    if (!r.user_login_id || seen.has(r.user_login_id)) continue;
    seen.add(r.user_login_id);
    out.push({ name: r.display_name || r.user_login_id, role: roleName[r.role_code] || r.role_code });
  }
  return out;
}
// ===== 2段階承認 (2026-07-03): 所長(MGR、無ければ課長KCH)の一次承認 → 経営管理本部/管理部の最終承認 =====
// 申請営業所の一次承認者(所長MGR優先・無ければ課長KCH)の login_id を返す。無ければ null。
function firstApproverLoginId(officeCode) {
  const db = getDb();
  for (const role of ['MGR', 'KCH']) {
    const a = db.prepare('SELECT user_login_id FROM appr_role_assignments WHERE role_code=? AND office_code=?').get(role, officeCode);
    if (a && a.user_login_id) return a.user_login_id;
  }
  return null;
}
function loginToUid(login) {
  if (!login) return null;
  const u = getDb().prepare('SELECT id FROM users WHERE login_id=?').get(login);
  return u ? u.id : null;
}
function firstApproverUid(officeCode) { return loginToUid(firstApproverLoginId(officeCode)); }
// 申請者が申請営業所の一次承認者(所長MGR/課長KCH)より上位職なら、所長の一次承認を飛ばして
// 管理部門の最終承認へ直行させる。例: 専務(SVP rank8)の申請が鹿島所長(MGR rank2)に回る逆転を解消(2026-07-04 小林指示)。
function applicantRoleRank(uid) {
  const db = getDb();
  const u = db.prepare('SELECT login_id FROM users WHERE id = ?').get(uid);
  if (!u || !u.login_id) return 0;
  const row = db.prepare('SELECT MAX(r.rank) AS mx FROM appr_role_assignments a JOIN appr_roles r ON r.code = a.role_code WHERE a.user_login_id = ?').get(u.login_id);
  return (row && row.mx) || 0;
}
function firstApproverRank(officeCode) {
  const db = getDb();
  for (const role of ['MGR', 'KCH']) {
    const a = db.prepare('SELECT 1 FROM appr_role_assignments WHERE role_code = ? AND office_code = ?').get(role, officeCode);
    if (a) { const r = db.prepare('SELECT rank FROM appr_roles WHERE code = ?').get(role); return (r && r.rank) || 0; }
  }
  return 0;
}
function applicantOutranksFirst(uid, officeCode) {
  const far = firstApproverRank(officeCode);
  if (!far) return false; // 一次承認者不在の営業所は既存ロジックで一次省略済
  return applicantRoleRank(uid) > far;
}
// 申請営業所の一次承認者(所長/課長)の氏名。未設定(一次省略)なら空文字。承認ルート表示用。
function firstApproverName(officeCode) {
  const uid = firstApproverUid(officeCode);
  if (!uid) return '';
  const u = getDb().prepare('SELECT display_name FROM users WHERE id=?').get(uid);
  return (u && u.display_name) || '';
}
// このユーザーが一次承認者になっている営業所コードの配列 (所長/課長として割当・かつ実際にその営業所の一次承認者)
function firstApproveOffices(uid) {
  const db = getDb();
  const u = db.prepare('SELECT login_id FROM users WHERE id=?').get(uid);
  if (!u || !u.login_id) return [];
  const rows = db.prepare("SELECT DISTINCT office_code FROM appr_role_assignments WHERE user_login_id=? AND role_code IN ('MGR','KCH')").all(u.login_id);
  return rows.map(r => r.office_code).filter(oc => firstApproverLoginId(oc) === u.login_id);
}
// 一次承認できるか: その申請営業所の一次承認者本人 or 管理部門(代理)
function canFirstAct(uid, r) {
  if (canApproveExpenseUid(uid)) return true; // 管理部門は代理で一次承認も可
  const fa = firstApproverUid(r.request_office);
  return !!fa && fa === uid;
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
  // PDFから派生したサムネ/ページ画像も掃除 (receipt_X.pdf.thumb.jpg / receipt_X.pdf.pN.jpg)
  if (/\.pdf$/i.test(base)) {
    try {
      const prefix = base + '.';
      for (const f of fs.readdirSync(uploadDir)) {
        if (f.startsWith(prefix) && /\.(jpg|jpeg)$/i.test(f)) {
          const dp = path.join(uploadDir, f);
          if (dp.startsWith(uploadDir)) { try { fs.unlinkSync(dp); } catch (_) {} }
        }
      }
    } catch (_) {}
  }
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
    first_checker: r.first_checker || '',
    first_checked_at: r.first_checked_at || '',
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
      can_approve: canApproveExpenseUid(req.uid),        // 最終承認 (経営管理本部/管理部)
      first_offices: firstApproveOffices(req.uid),        // 一次承認できる営業所 (所長/課長)
      can_first_approve: firstApproveOffices(req.uid).length > 0,
    },
    final_approvers: finalApproverList(),                 // 最終承認者(氏名+役職) — 承認フロー表示用

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
    maybeGenerateReceiptPdf(req.file.filename, req.file.mimetype);
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

// ===== 領収書画像アップロード (OCRなし・保存のみ) =====
// 2026-07-03: OCR読み取りを押さずに申請した領収書が保存されず画像リンクが出ない不具合の対処。
// 申請登録時、OCR未実施でもこのエンドポイントで画像を必ずアップロードし image_url を保存する。
router.post('/upload-receipt', authUser, (req, res) => {
  receiptUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, msg: err.message || 'アップロード失敗' });
    if (!req.file) return res.status(400).json({ success: false, msg: '画像がありません' });
    maybeGenerateReceiptPdf(req.file.filename, req.file.mimetype);
    res.json({ success: true, image_url: '/uploads/' + req.file.filename });
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
  // 2段階承認: ①所長(MGR/課長KCH)の一次承認 → ②経営管理本部/管理部の最終承認。
  // ・申請者が最終承認権限者(経営管理本部長/管理部長/代表取締役社長)なら登録時に自動で最終承認(承認済)。
  // ・一次承認者が居て申請者本人でなければ「申請済」(所長の一次承認待ち)。
  // ・一次承認者が不在、または申請者自身が所長の場合は「一次承認済」(所長段階を飛ばし最終承認待ち)。
  const selfFinal = canApproveExpenseUid(req.uid);
  const faUid = firstApproverUid(d.request_office);
  const outranksFirst = applicantOutranksFirst(req.uid, d.request_office); // 申請者が所長より上位職→一次省略
  let status, checker = '', checkedAt = '', firstChecker = '', firstCheckedAt = '', msg;
  if (selfFinal) {
    status = '承認済'; checker = '自動承認(管理部門)'; checkedAt = now; firstChecker = '（管理部門のため一次省略）'; firstCheckedAt = now;
    msg = '申請を登録しました（管理部門のため自動承認）';
  } else if (outranksFirst) {
    // 所長より上位職(専務・本部長等)は所長一次を飛ばし、管理部門(後藤/吉沢/小林)の最終承認へ直行。
    status = '一次承認済'; firstChecker = '（申請者が所長より上位職のため一次省略）'; firstCheckedAt = now;
    msg = '申請を登録しました（管理部門の最終承認待ち）';
  } else if (faUid && faUid !== req.uid) {
    status = '申請済'; msg = '申請を登録しました（所長の一次承認待ち）';
  } else {
    status = '一次承認済'; firstChecker = faUid ? '（申請者が所長のため一次省略）' : '（一次承認者未設定のため省略）'; firstCheckedAt = now;
    msg = '申請を登録しました（最終承認待ち）';
  }
  db.prepare(`INSERT INTO expenses
    (id, apply_date, request_office, target_office, applicant, usage_date, vendor, ocr_vendor, amount, ocr_amount,
     account_title, summary, receipt_date, ocr_receipt_date, invoice_no, ocr_text, image_url, status, checker, checked_at, first_checker, first_checked_at, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, d.apply_date || '', d.request_office || '', d.target_office || '', d.applicant || '', d.usage_date || '',
    d.vendor || '', d.ocr_vendor || '', normAmount(d.amount), normAmount(d.ocr_amount),
    d.account_title || '', d.summary || '', d.receipt_date || '', d.ocr_receipt_date || '', d.invoice_no || '',
    d.ocr_text || '', d.image_url || '', status, checker, checkedAt, firstChecker, firstCheckedAt, req.uid, now, now
  );
  res.json({ success: true, id, msg });
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
  // 削除可否 + 段階別のアクション可否
  const canFinal = canApproveExpenseUid(req.uid);
  const myFirstOffices = firstApproveOffices(req.uid);
  const faNameCache = {};
  items.forEach(x => {
    x.can_delete = admin || x.status !== '承認済';
    // 承認ルート表示用: 意図した一次承認者(所長/課長)の氏名。空=一次省略(管理部門直行)
    x.first_approver_name = (x.request_office in faNameCache) ? faNameCache[x.request_office] : (faNameCache[x.request_office] = firstApproverName(x.request_office));
    // 一次承認: 申請済 かつ その営業所の一次承認者本人(または管理部門の代理)
    x.can_first_act = x.status === '申請済' && (canFinal || myFirstOffices.indexOf(x.request_office) >= 0);
    // 最終承認: 一次承認済(または管理部門が申請済を直接最終承認する上書き) かつ 管理部門
    x.can_final_act = canFinal && (x.status === '一次承認済' || x.status === '申請済');
  });
  res.json({ success: true, items, isAdmin: admin });
});

// ===== 承認待ち件数 (ホーム新着バッジ用) =====
// 管理部門=最終承認待ち(一次承認済)の件数、所長/課長=自営業所の一次承認待ち(申請済)の件数。
router.get('/pending-count', authUser, (req, res) => {
  const db = getDb();
  if (canApproveExpenseUid(req.uid)) {
    const row = db.prepare("SELECT COUNT(*) AS c FROM expenses WHERE status = '一次承認済'").get();
    return res.json({ success: true, count: (row && row.c) || 0 });
  }
  const offices = firstApproveOffices(req.uid);
  if (!offices.length) return res.json({ success: true, count: 0 });
  const ph = offices.map(() => '?').join(',');
  const row = db.prepare(`SELECT COUNT(*) AS c FROM expenses WHERE status='申請済' AND request_office IN (${ph})`).get(...offices);
  res.json({ success: true, count: (row && row.c) || 0 });
});

// ===== 承認済CSV出力 (管理職) =====
router.get('/export-csv', requireApprover, (req, res) => {
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
router.post('/approve-bulk', requireApprover, express.json(), (req, res) => {
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
  item.first_approver_name = firstApproverName(r.request_office);
  item.can_delete = canDeleteExpense(req.uid, r);
  item.can_first_act = r.status === '申請済' && canFirstAct(req.uid, r);
  item.can_final_act = canApproveExpenseUid(req.uid) && (r.status === '一次承認済' || r.status === '申請済');
  res.json({ success: true, item });
});

// ===== 修正 (自営業所のみ / 管理職は全社) =====
router.patch('/:id', authUser, express.json(), (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const isMgr = isManagerUid(req.uid);
  if (!isMgr) {
    const me = db.prepare('SELECT company_code FROM users WHERE id = ?').get(req.uid) || {};
    if (r.created_by !== req.uid && r.request_office !== (me.company_code || '')) {
      return res.status(403).json({ success: false, msg: '修正権限がありません' });
    }
  }
  const d = req.body || {};
  // 非管理職は request_office を変更不可。可視/削除スコープを跨ぐ mass-assignment を防ぐため保存済みの値を維持
  const newOffice = isMgr ? (d.request_office || '') : (r.request_office || '');
  // image_url は明示的に渡された時のみ更新 (領収書の後付け/差し替え)。通常の修正保存では既存値を保持
  const newImageUrl = (d.image_url !== undefined) ? (d.image_url || '') : (r.image_url || '');
  db.prepare(`UPDATE expenses SET apply_date=?, request_office=?, target_office=?, applicant=?, usage_date=?,
     vendor=?, amount=?, account_title=?, summary=?, receipt_date=?, invoice_no=?, image_url=?, updated_at=? WHERE id=?`).run(
    d.apply_date || r.apply_date || '', newOffice, d.target_office || '', d.applicant || '', d.usage_date || '',
    d.vendor || '', normAmount(d.amount), d.account_title || '', d.summary || '', d.receipt_date || '', d.invoice_no || '',
    newImageUrl, nowStr(), req.params.id
  );
  res.json({ success: true, msg: '修正を保存しました' });
});

// ===== 一次承認 / 一次差戻し (所長・課長 or 管理部門の代理) =====
router.post('/:id/first-approve', authUser, express.json(), (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (r.status !== '申請済') return res.status(400).json({ success: false, msg: 'この申請は一次承認の段階ではありません' });
  if (!canFirstAct(req.uid, r)) return res.status(403).json({ success: false, msg: '一次承認の権限がありません（申請営業所の所長のみ）' });
  const checker = (db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {}).display_name || '';
  const now = nowStr();
  db.prepare("UPDATE expenses SET status='一次承認済', first_checker=?, first_checked_at=?, return_reason='', updated_at=? WHERE id=?")
    .run(checker, now, now, req.params.id);
  res.json({ success: true, msg: '一次承認しました（管理部門の最終承認へ進みます）' });
});
router.post('/:id/first-return', authUser, express.json(), (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (r.status !== '申請済') return res.status(400).json({ success: false, msg: 'この申請は一次承認の段階ではありません' });
  if (!canFirstAct(req.uid, r)) return res.status(403).json({ success: false, msg: '差戻しの権限がありません' });
  const checker = (db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {}).display_name || '';
  const now = nowStr();
  db.prepare("UPDATE expenses SET status='差戻し', first_checker=?, first_checked_at=?, return_reason=?, updated_at=? WHERE id=?")
    .run(checker, now, String((req.body && req.body.reason) || ''), now, req.params.id);
  res.json({ success: true, msg: '差戻ししました' });
});

// ===== 最終承認 / 差戻し (経営管理本部・管理部) =====
router.post('/:id/approve', requireApprover, express.json(), (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT status FROM expenses WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (r.status === '承認済') return res.status(400).json({ success: false, msg: '既に承認済です' });
  const checker = (db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {}).display_name || '';
  const now = nowStr();
  db.prepare("UPDATE expenses SET status='承認済', checker=?, checked_at=?, return_reason='', updated_at=? WHERE id=?")
    .run(checker, now, now, req.params.id);
  res.json({ success: true, msg: '承認しました' });
});
router.post('/:id/return', requireApprover, express.json(), (req, res) => {
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
