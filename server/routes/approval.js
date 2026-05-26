// 承認申請システム (2026-05-25 GAS移植 / 決裁基準表ベース)
// 申請種別×金額帯×営業所→役職チェーンで承認ルートを判定。役職→担当者(login_id)はDB編集可能。
// 承認は単段ずつ進み、次承認者へ bot DM 通知。管理職は代理承認可。スズエ電機は別ルート(後日)。
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const uploadDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').slice(0, 8) || '.pdf').replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, 'appr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + ext);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ===== 共通 =====
function isManagerUid(uid) {
  const u = getDb().prepare('SELECT employee_type FROM users WHERE id = ?').get(uid);
  return !!(u && u.employee_type === 'admin');
}
function requireManager(req, res, next) {
  authUser(req, res, () => {
    if (!isManagerUid(req.uid)) return res.status(403).json({ success: false, msg: '管理権限 (管理職) が必要です' });
    next();
  });
}
function companyMap() {
  const m = {};
  for (const c of getDb().prepare('SELECT code, name FROM companies').all()) m[c.code] = c.name;
  return m;
}
function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
// アップロード済み添付の安全削除 (/uploads/ 配下のファイル名のみ。パストラバーサル防止)
function safeUnlinkUpload(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  const base = path.basename(url);
  if (!base || base.indexOf('..') !== -1) return;
  const fp = path.join(uploadDir, base);
  if (!fp.startsWith(uploadDir)) return;
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) { console.warn('[approval unlink]', e.message); }
}
function genId() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return 'APP-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + Math.random().toString(36).slice(2, 5);
}
function getNotifierBotId() {
  try {
    const row = getDb().prepare("SELECT id FROM users WHERE id='bot_aoi' OR login_id='bot_aoi' LIMIT 1").get()
      || getDb().prepare("SELECT id FROM users WHERE role='bot' LIMIT 1").get();
    return row && row.id;
  } catch (e) { return null; }
}
function notifyDM(req, toUid, content) {
  const fromUid = getNotifierBotId();
  if (!fromUid || !toUid || fromUid === toUid) return;
  try {
    const ins = getDb().prepare('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)').run(fromUid, toUid, content);
    const emitToUser = req.app && req.app.locals && req.app.locals.emitToUser;
    if (emitToUser) emitToUser(toUid, 'dm:msg', { id: ins.lastInsertRowid, from: fromUid, to: toUid, content, at: new Date().toISOString(), attach: null });
    const sendPush = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (sendPush) sendPush(toUid, { title: '承認申請', body: content }).catch(() => {});
  } catch (e) { console.warn('[approval notifyDM]', e.message); }
}

// 役職コード+営業所 → 担当者 {uid, name, login_id} or null
function resolveApprover(roleCode, officeCode) {
  const db = getDb();
  const role = db.prepare('SELECT office_specific FROM appr_roles WHERE code = ?').get(roleCode);
  const office = (role && role.office_specific) ? officeCode : 'ALL';
  let a = db.prepare('SELECT user_login_id FROM appr_role_assignments WHERE role_code=? AND office_code=?').get(roleCode, office);
  if ((!a || !a.user_login_id) && office !== 'ALL') a = db.prepare("SELECT user_login_id FROM appr_role_assignments WHERE role_code=? AND office_code='ALL'").get(roleCode);
  if (!a || !a.user_login_id) return null;
  const u = db.prepare('SELECT id, display_name FROM users WHERE login_id = ?').get(a.user_login_id);
  return u ? { uid: u.id, name: u.display_name, login_id: a.user_login_id } : null;
}
function roleName(code) {
  const r = getDb().prepare('SELECT name FROM appr_roles WHERE code = ?').get(code);
  return r ? r.name : code;
}
// 申請種別×金額×営業所 → 最優先ルート
function findRoute(applyType, amount, officeCode) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM appr_routes WHERE active=1 AND apply_type=?').all(applyType);
  const amt = Number(amount) || 0;
  const cands = rows.filter(r => amt >= (r.amount_min || 0) && ((r.amount_max || 0) === 0 || amt <= r.amount_max)
    && (r.office_code === 'ALL' || r.office_code === officeCode));
  cands.sort((a, b) => (a.priority || 100) - (b.priority || 100));
  return cands[0] || null;
}
// ルートのrole chain → 実承認者を解決 (未割当ロール・申請者本人はスキップ)
function buildChain(route, officeCode, applicantUid) {
  const codes = String(route.chain || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const code of codes) {
    const ap = resolveApprover(code, officeCode);
    if (!ap) continue;                       // 未割当役職はスキップ
    if (ap.uid === applicantUid) continue;   // 申請者本人の段階はスキップ
    if (out.some(x => x.uid === ap.uid)) continue; // 同一人物の重複段階を排除
    out.push({ role: code, role_name: roleName(code), uid: ap.uid, name: ap.name, login_id: ap.login_id });
  }
  return out;
}

// ===== 初期データ =====
router.get('/init', authUser, (req, res) => {
  const db = getDb();
  const me = db.prepare('SELECT id, display_name, login_id, company_code, employee_type FROM users WHERE id = ?').get(req.uid) || {};
  res.json({
    success: true,
    user: { uid: req.uid, name: me.display_name || '', login_id: me.login_id || '', company_code: me.company_code || '', is_admin: me.employee_type === 'admin' },
    offices: db.prepare("SELECT code, name FROM companies WHERE code NOT IN ('ADMIN','UNIVERSITY','NPO','GUEST') ORDER BY code").all(),
    applyTypes: db.prepare('SELECT DISTINCT apply_type FROM appr_routes WHERE active=1 ORDER BY apply_type').all().map(r => r.apply_type),
  });
});

// ===== ルートプレビュー (申請前の承認チェーン確認) =====
router.post('/preview', authUser, express.json(), (req, res) => {
  const { apply_type, amount, office_code } = req.body || {};
  const route = findRoute(apply_type, amount, office_code);
  if (!route) return res.json({ success: false, msg: '該当する承認ルートがありません (申請種別/金額/営業所をご確認ください)' });
  const chain = buildChain(route, office_code, req.uid);
  res.json({ success: true, route: { id: route.id, apply_type: route.apply_type, amount_min: route.amount_min, amount_max: route.amount_max }, chain });
});

// ===== PDF添付アップロード =====
router.post('/upload', authUser, (req, res) => {
  pdfUpload.array('files', 3)(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, msg: err.message || 'アップロード失敗' });
    res.json({ success: true, files: (req.files || []).map(f => ({ url: '/uploads/' + f.filename, name: f.originalname || f.filename })) });
  });
});

// ===== 申請登録 =====
router.post('/', authUser, express.json(), (req, res) => {
  const db = getDb();
  const d = req.body || {};
  if (!String(d.subject || '').trim()) return res.status(400).json({ success: false, msg: '件名を入力してください' });
  if (!d.apply_type) return res.status(400).json({ success: false, msg: '申請種別を選択してください' });
  if (!d.office_code) return res.status(400).json({ success: false, msg: '営業所を選択してください' });
  const amount = Number(String(d.amount || '').replace(/[^\d.-]/g, '')) || 0;
  const route = findRoute(d.apply_type, amount, d.office_code);
  if (!route) return res.status(400).json({ success: false, msg: '該当する承認ルートがありません' });
  const chain = buildChain(route, d.office_code, req.uid);
  if (!chain.length) return res.status(400).json({ success: false, msg: '承認者が未設定です。管理画面の「役職割当」をご確認ください' });
  const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {};
  const id = genId();
  const att = Array.isArray(d.attachments) ? d.attachments : [];
  const now = nowStr();
  db.prepare(`INSERT INTO approval_apps
    (id, subject, apply_type, office_code, amount, route_id, chain, status, cur_step, cur_role,
     attach1_url, attach1_name, attach2_url, attach2_name, attach3_url, attach3_name, applicant_id, applicant_name, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,'申請中',0,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, d.subject.trim(), d.apply_type, d.office_code, amount, route.id, JSON.stringify(chain), chain[0].role,
    (att[0] && att[0].url) || '', (att[0] && att[0].name) || '', (att[1] && att[1].url) || '', (att[1] && att[1].name) || '',
    (att[2] && att[2].url) || '', (att[2] && att[2].name) || '', req.uid, me.display_name || '', now, now
  );
  db.prepare('INSERT INTO approval_history (app_id, action, role, actor_name, note) VALUES (?,?,?,?,?)')
    .run(id, '申請', '', me.display_name || '', '');
  // 最初の承認者へ通知
  notifyDM(req, chain[0].uid, '【承認依頼】' + chain[0].role_name + ' 宛: ' + d.subject.trim() + ' (' + d.apply_type + ' / ' + amount.toLocaleString() + '円) — 承認をお願いします。');
  res.json({ success: true, id, chain });
});

// ===== 一覧 (自分の申請 + 自分が承認者 / 管理職は全件) =====
router.get('/list', authUser, (req, res) => {
  const db = getDb();
  const admin = isManagerUid(req.uid);
  const rows = db.prepare('SELECT * FROM approval_apps ORDER BY created_at DESC').all();
  const cmap = companyMap();
  const items = rows.map(r => mapApp(r, cmap)).filter(a => {
    if (admin) return true;
    if (a.applicant_id === req.uid) return true;
    return (a._chain || []).some(s => s.uid === req.uid);
  }).map(a => {
    a.can_delete = admin || (a.applicant_id === req.uid && a.status !== '承認済');
    return a;
  });
  res.json({ success: true, items, isAdmin: admin });
});

// ===== 承認待ち (自分が現在の承認者) =====
router.get('/pending', authUser, (req, res) => {
  const db = getDb();
  const admin = isManagerUid(req.uid);
  const rows = db.prepare("SELECT * FROM approval_apps WHERE status='申請中' ORDER BY created_at DESC").all();
  const cmap = companyMap();
  // 「承認待ち」= 自分が現段階の承認者である案件のみ (管理職でも自分の番だけ。代理承認は一覧→詳細から)
  const items = rows.map(r => mapApp(r, cmap)).filter(a => {
    const cur = (a._chain || [])[a.cur_step];
    return !!cur && cur.uid === req.uid;
  });
  res.json({ success: true, items, isAdmin: admin });
});

function mapApp(r, cmap) {
  let chain = [];
  try { chain = JSON.parse(r.chain || '[]'); } catch (e) {}
  const cur = chain[r.cur_step] || null;
  return {
    id: r.id, subject: r.subject, apply_type: r.apply_type,
    office_code: r.office_code, office_name: (cmap && cmap[r.office_code]) || r.office_code,
    amount: r.amount, status: r.status, cur_step: r.cur_step, cur_role: r.cur_role,
    cur_role_name: cur ? cur.role_name : '', cur_approver: cur ? cur.name : '',
    chain_label: chain.map(s => s.role_name + '(' + s.name + ')').join(' → '),
    applicant_id: r.applicant_id, applicant_name: r.applicant_name,
    attachments: [
      r.attach1_url ? { url: r.attach1_url, name: r.attach1_name } : null,
      r.attach2_url ? { url: r.attach2_url, name: r.attach2_name } : null,
      r.attach3_url ? { url: r.attach3_url, name: r.attach3_name } : null,
    ].filter(Boolean),
    created_at: r.created_at, updated_at: r.updated_at, _chain: chain,
  };
}

// ===== 詳細 (履歴つき) =====
router.get('/:id', authUser, (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT * FROM approval_apps WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, msg: '見つかりません' });
  const item = mapApp(r, companyMap());
  const cur = item._chain[item.cur_step] || null;
  item.can_act = (r.status === '申請中') && (isManagerUid(req.uid) || (cur && cur.uid === req.uid));
  item.is_applicant = r.applicant_id === req.uid;
  item.can_delete = isManagerUid(req.uid) || (item.is_applicant && r.status !== '承認済');
  const history = db.prepare('SELECT action, role, actor_name, note, created_at FROM approval_history WHERE app_id=? ORDER BY id').all(req.params.id);
  res.json({ success: true, item, history });
});

// 承認/差戻/却下 の権限: 現段階の担当者本人 or 管理職(代理)
function canAct(app, chain, uid) {
  if (app.status !== '申請中') return false;
  const cur = chain[app.cur_step];
  if (cur && cur.uid === uid) return true;
  return isManagerUid(uid);
}

// ===== 承認 =====
router.post('/:id/approve', authUser, express.json(), (req, res) => {
  const db = getDb();
  const app = db.prepare('SELECT * FROM approval_apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ success: false, msg: '見つかりません' });
  let chain = []; try { chain = JSON.parse(app.chain || '[]'); } catch (e) {}
  if (!canAct(app, chain, req.uid)) return res.status(403).json({ success: false, msg: '承認権限がありません' });
  const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {};
  const cur = chain[app.cur_step] || {};
  const proxy = cur.uid !== req.uid;  // 担当者本人でなければ管理職代理
  const next = app.cur_step + 1;
  const now = nowStr();
  if (next < chain.length) {
    db.prepare("UPDATE approval_apps SET cur_step=?, cur_role=?, status='申請中', updated_at=? WHERE id=?")
      .run(next, chain[next].role, now, app.id);
    notifyDM(req, chain[next].uid, '【承認依頼】' + chain[next].role_name + ' 宛: ' + app.subject + ' — 前段階が承認されました。');
  } else {
    db.prepare("UPDATE approval_apps SET status='承認済', updated_at=? WHERE id=?").run(now, app.id);
    notifyDM(req, app.applicant_id, '【承認完了】あなたの申請「' + app.subject + '」が最終承認されました。');
  }
  db.prepare('INSERT INTO approval_history (app_id, action, role, actor_name, note) VALUES (?,?,?,?,?)')
    .run(app.id, proxy ? '承認(代理)' : '承認', (cur.role_name || ''), me.display_name || '', String((req.body && req.body.note) || ''));
  res.json({ success: true, msg: next < chain.length ? '承認しました（次の承認者へ）' : '最終承認しました' });
});

// ===== 差戻し =====
router.post('/:id/return', authUser, express.json(), (req, res) => {
  const db = getDb();
  const app = db.prepare('SELECT * FROM approval_apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ success: false, msg: '見つかりません' });
  let chain = []; try { chain = JSON.parse(app.chain || '[]'); } catch (e) {}
  if (!canAct(app, chain, req.uid)) return res.status(403).json({ success: false, msg: '権限がありません' });
  const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {};
  const cur = chain[app.cur_step] || {};
  db.prepare("UPDATE approval_apps SET status='差戻し', updated_at=? WHERE id=?").run(nowStr(), app.id);
  db.prepare('INSERT INTO approval_history (app_id, action, role, actor_name, note) VALUES (?,?,?,?,?)')
    .run(app.id, '差戻し', (cur.role_name || ''), me.display_name || '', String((req.body && req.body.note) || ''));
  notifyDM(req, app.applicant_id, '【差戻し】申請「' + app.subject + '」が差戻されました。理由: ' + (String((req.body && req.body.note) || '') || '(なし)') + ' — 修正のうえ再申請してください。');
  res.json({ success: true, msg: '差戻しました' });
});

// ===== 却下 =====
router.post('/:id/reject', authUser, express.json(), (req, res) => {
  const db = getDb();
  const app = db.prepare('SELECT * FROM approval_apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ success: false, msg: '見つかりません' });
  let chain = []; try { chain = JSON.parse(app.chain || '[]'); } catch (e) {}
  if (!canAct(app, chain, req.uid)) return res.status(403).json({ success: false, msg: '権限がありません' });
  const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {};
  const cur = chain[app.cur_step] || {};
  db.prepare("UPDATE approval_apps SET status='却下', updated_at=? WHERE id=?").run(nowStr(), app.id);
  db.prepare('INSERT INTO approval_history (app_id, action, role, actor_name, note) VALUES (?,?,?,?,?)')
    .run(app.id, '却下', (cur.role_name || ''), me.display_name || '', String((req.body && req.body.note) || ''));
  notifyDM(req, app.applicant_id, '【却下】申請「' + app.subject + '」が却下されました。理由: ' + (String((req.body && req.body.note) || '') || '(なし)'));
  res.json({ success: true, msg: '却下しました' });
});

// ===== 再申請 (差戻し→申請者が再提出。チェーン先頭から再スタート) =====
router.post('/:id/resubmit', authUser, express.json(), (req, res) => {
  const db = getDb();
  const app = db.prepare('SELECT * FROM approval_apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ success: false, msg: '見つかりません' });
  if (app.applicant_id !== req.uid) return res.status(403).json({ success: false, msg: '申請者のみ再申請できます' });
  if (app.status !== '差戻し') return res.status(400).json({ success: false, msg: '差戻し中の申請のみ再申請できます' });
  let chain = []; try { chain = JSON.parse(app.chain || '[]'); } catch (e) {}
  if (!chain.length) return res.status(400).json({ success: false, msg: '承認者が未設定です' });
  const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {};
  db.prepare("UPDATE approval_apps SET status='申請中', cur_step=0, cur_role=?, updated_at=? WHERE id=?").run(chain[0].role, nowStr(), app.id);
  db.prepare('INSERT INTO approval_history (app_id, action, role, actor_name, note) VALUES (?,?,?,?,?)')
    .run(app.id, '再申請', '', me.display_name || '', String((req.body && req.body.note) || ''));
  notifyDM(req, chain[0].uid, '【承認依頼(再申請)】' + chain[0].role_name + ' 宛: ' + app.subject + ' — 再申請されました。');
  res.json({ success: true, msg: '再申請しました' });
});

// ===== 申請の削除 (申請者本人=承認済以外 / 管理職=全件)。添付ファイル・履歴も一掃 =====
router.delete('/:id', authUser, (req, res) => {
  const db = getDb();
  const app = db.prepare('SELECT * FROM approval_apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ success: false, msg: '見つかりません' });
  const isMgr = isManagerUid(req.uid);
  const isApplicant = app.applicant_id === req.uid;
  if (!isMgr && !isApplicant) return res.status(403).json({ success: false, msg: '削除権限がありません (申請者本人または管理職のみ)' });
  if (!isMgr && app.status === '承認済') return res.status(403).json({ success: false, msg: '承認済みの申請は削除できません (管理職にご依頼ください)' });
  // 申請中の取消は、現在の承認者へ通知 (承認不要の旨)
  if (app.status === '申請中') {
    let chain = []; try { chain = JSON.parse(app.chain || '[]'); } catch (e) {}
    const cur = chain[app.cur_step];
    if (cur && cur.uid && cur.uid !== req.uid) {
      notifyDM(req, cur.uid, '【申請取消】申請「' + app.subject + '」が取り消されました（承認は不要です）。');
    }
  }
  // 添付ファイルを削除
  [app.attach1_url, app.attach2_url, app.attach3_url].forEach(safeUnlinkUpload);
  db.prepare('DELETE FROM approval_history WHERE app_id=?').run(app.id);
  db.prepare('DELETE FROM approval_apps WHERE id=?').run(app.id);
  res.json({ success: true, msg: '削除しました' });
});

// ============================================================
// 管理画面: ルート / 役職割当 の編集 (管理職)
// ============================================================
router.get('/admin/config', requireManager, (req, res) => {
  const db = getDb();
  res.json({
    success: true,
    roles: db.prepare('SELECT code, name, rank, office_specific FROM appr_roles ORDER BY rank').all(),
    routes: db.prepare('SELECT * FROM appr_routes ORDER BY apply_type, amount_min').all(),
    assignments: db.prepare('SELECT a.id, a.role_code, a.office_code, a.user_login_id, u.display_name FROM appr_role_assignments a LEFT JOIN users u ON u.login_id=a.user_login_id ORDER BY a.role_code, a.office_code').all(),
    offices: db.prepare("SELECT code, name FROM companies WHERE code NOT IN ('ADMIN','UNIVERSITY','NPO','GUEST') ORDER BY code").all(),
    users: db.prepare("SELECT login_id, display_name, company_code FROM users WHERE role!='bot' ORDER BY company_code, display_name").all(),
  });
});
// ルート CRUD
router.post('/admin/route', requireManager, express.json(), (req, res) => {
  const b = req.body || {};
  if (!String(b.apply_type || '').trim() || !String(b.chain || '').trim()) return res.status(400).json({ success: false, msg: '申請種別とチェーンは必須です' });
  getDb().prepare('INSERT INTO appr_routes (apply_type, office_code, amount_min, amount_max, chain, priority, active, note) VALUES (?,?,?,?,?,?,?,?)')
    .run(b.apply_type.trim(), b.office_code || 'ALL', Number(b.amount_min) || 0, Number(b.amount_max) || 0, b.chain.trim(), Number(b.priority) || 100, b.active === false ? 0 : 1, b.note || '');
  res.json({ success: true });
});
router.patch('/admin/route/:id', requireManager, express.json(), (req, res) => {
  const b = req.body || {};
  const sets = [], params = [];
  ['apply_type', 'office_code', 'amount_min', 'amount_max', 'chain', 'priority', 'active', 'note'].forEach(f => {
    if (b[f] !== undefined) { sets.push(f + '=?'); params.push(f === 'active' ? (b[f] ? 1 : 0) : b[f]); }
  });
  if (!sets.length) return res.status(400).json({ success: false, msg: '更新項目なし' });
  params.push(req.params.id);
  getDb().prepare(`UPDATE appr_routes SET ${sets.join(', ')} WHERE id=?`).run(...params);
  res.json({ success: true });
});
router.delete('/admin/route/:id', requireManager, (req, res) => {
  getDb().prepare('DELETE FROM appr_routes WHERE id=?').run(req.params.id);
  res.json({ success: true });
});
// 役職割当 CRUD
router.post('/admin/assignment', requireManager, express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.role_code || !b.user_login_id) return res.status(400).json({ success: false, msg: '役職と担当者は必須です' });
  getDb().prepare('INSERT INTO appr_role_assignments (role_code, office_code, user_login_id) VALUES (?,?,?)')
    .run(b.role_code, b.office_code || 'ALL', b.user_login_id);
  res.json({ success: true });
});
router.patch('/admin/assignment/:id', requireManager, express.json(), (req, res) => {
  const b = req.body || {};
  const sets = [], params = [];
  ['role_code', 'office_code', 'user_login_id'].forEach(f => { if (b[f] !== undefined) { sets.push(f + '=?'); params.push(b[f]); } });
  if (!sets.length) return res.status(400).json({ success: false, msg: '更新項目なし' });
  params.push(req.params.id);
  getDb().prepare(`UPDATE appr_role_assignments SET ${sets.join(', ')} WHERE id=?`).run(...params);
  res.json({ success: true });
});
router.delete('/admin/assignment/:id', requireManager, (req, res) => {
  getDb().prepare('DELETE FROM appr_role_assignments WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
