// 安全運転レポートAPI (2026-06-09)
// 須貝さんが日次で「個人別安全運転順位表CSV」+「違反指導書PDF」をアップ → サーバーが解析して安全運転集計を自動生成。
// 順位=ログイン全員閲覧 / 違反詳細(地点・種別)=管理職・運行管理者のみ。
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

getDb().prepare(`CREATE TABLE IF NOT EXISTS safe_driving_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL UNIQUE,
  data_json TEXT NOT NULL,
  csv_name TEXT, pdf_path TEXT,
  uploaded_by TEXT, uploaded_by_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`).run();
// 運行・品質管理メンバーへ配信した日時 (配信ボタン)。既存DB向けに追加。
try { getDb().prepare('ALTER TABLE safe_driving_reports ADD COLUMN distributed_at TEXT').run(); } catch (e) {}

// 運行・品質管理メンバー グループ (このグループ全員へ配信)
const OPS_GROUP_ID = 'e50d16e5-b049-43d4-860b-5ec719b4199d';

const dir = path.join(__dirname, '..', '..', 'uploads', 'safe-driving');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: dir,
    filename: (req, file, cb) => {
      const ext = /\.pdf$/i.test(file.originalname || '') ? '.pdf' : '.csv';
      cb(null, 'sd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// 管理職 or 運行管理者
function canEdit(uid) {
  const r = getDb().prepare('SELECT employee_type, role, is_manager, is_ops_manager FROM users WHERE id = ?').get(uid);
  return !!(r && (r.is_manager === 1 || r.is_ops_manager === 1 || r.employee_type === 'admin' || r.role === 'admin'));
}

// ---- 解析ユーティリティ ----
function stripCtrl(s) { let o = ''; const t = String(s || ''); for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c === 9 || c === 10 || c === 12 || c >= 32) o += t[i]; } return o; }
function norm(s) { return stripCtrl(s).normalize('NFKC'); }
function splitNameOffice(s) {
  const m = String(s || '').match(/^(.*?)\s*[(（](.+?)[)）]\s*$/);
  return m ? { name: m[1].replace(/\s+/g, ' ').trim(), office: m[2].trim() } : { name: String(s || '').trim(), office: '' };
}

function parseCsv(csvPath) {
  const wb = XLSX.readFile(csvPath, { codepage: 932, raw: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  return rows.slice(1).filter(r => r[5]).map(r => {
    const no = splitNameOffice(r[5]);
    return {
      rank: +r[0] || null, prevRank: (r[1] === '-' || r[1] === '' ? null : +r[1] || null),
      score: +r[2] || 0, safety: +r[3] || 0, eco: +r[4] || 0,
      name: no.name, office: no.office, distance: +r[8] || 0, time: r[9] || '',
    };
  });
}

const VTYPES = ['速度超過', 'エンジン回転オーバー', '急加速', '急減速', '急旋回', 'アイドリング', '長時間運転'];
function parsePdf(pdfPath) {
  let txt = '';
  try { txt = norm(execSync('pdftotext -layout "' + pdfPath + '" -', { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })); }
  catch (e) { console.warn('[safe-driving pdftotext]', e.message); return { date: '', violations: [] }; }
  const dm = txt.match(/対象期間\s*[:：]\s*(\d{4})年(\d{2})月(\d{2})日/);
  const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : '';
  const blocks = txt.split('\f').filter(b => /乗務員名/.test(b));
  const violations = blocks.map(b => {
    const office = (b.match(/営業所\s*[:：]\s*(\S+)/) || [])[1] || '';
    const nm = b.match(/乗務員名\s*[:：]\s*(.+?)\s*[(（](\d+)[)）]/);
    const name = nm ? nm[1].replace(/\s+/g, ' ').trim() : '';
    const counts = {};
    for (const label of VTYPES) { const m = b.match(new RegExp(label + '\\s+(\\d+)\\s*回')); if (m && +m[1] > 0) counts[label] = +m[1]; }
    const details = b.split('\n').filter(l => /\d{2}日\d{2}:\d{2}:\d{2}/.test(l)).map(l => {
      const tm = (l.match(/(\d{2})日(\d{2}:\d{2}:\d{2})/) || []);
      const road = (l.match(/(高速道|一般道)/) || [])[1] || '';
      const place = (l.match(/(?:高速道|一般道)\s+(\S*[都道府県]\S+)/) || [])[1] || '';
      return { time: tm[1] ? `${tm[1]}日 ${tm[2]}` : '', road, place };
    });
    return { name, office, counts, details };
  }).filter(v => v.name);
  return { date, violations };
}

function timeToMin(t) { const m = String(t || '').match(/(\d+):(\d{2})/); return m ? (+m[1] * 60 + +m[2]) : 0; }

// 須貝ルール(2026-06-09): ①得点降順 ②稼働時間降順 ③走行距離降順。15時間以上は赤文字フラグ。
function buildReport(drivers, pdf, prevMap) {
  drivers = drivers.slice().sort((a, b) => (b.score - a.score) || (timeToMin(b.time) - timeToMin(a.time)) || (b.distance - a.distance));
  drivers.forEach((d, i) => {
    d.rank = i + 1;
    d.longHours = timeToMin(d.time) >= 900; // 15時間以上(900分)
    const key = String(d.name).replace(/\s+/g, '');
    d.prevRank = (prevMap && prevMap[key] != null) ? prevMap[key] : null;
  });
  const total = drivers.length;
  const perfect = drivers.filter(d => d.score >= 100).length;
  const rate = total ? Math.round(perfect * 1000 / total) / 10 : 0;
  const byType = {};
  const violations = pdf.violations.map(v => {
    const d = drivers.find(x => x.name.replace(/\s+/g, '') === v.name.replace(/\s+/g, ''));
    for (const [k, n] of Object.entries(v.counts)) byType[k] = (byType[k] || 0) + n;
    return {
      name: v.name, office: v.office || (d ? d.office : ''),
      score: d ? d.score : null, rank: d ? d.rank : null, prevRank: d ? d.prevRank : null,
      types: v.counts, details: v.details,
    };
  });
  return {
    summary: { total, perfect, rate, violationCount: violations.length, byType },
    drivers, violations,
  };
}

// ---- アップロード(管理職・運行管理者) ----
router.post('/upload', authUser, (req, res) => {
  if (!canEdit(req.uid)) return res.status(403).json({ success: false, msg: 'この機能は管理職・運行管理者のみ利用できます' });
  upload.fields([{ name: 'csv', maxCount: 1 }, { name: 'pdf', maxCount: 1 }])(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, msg: err.message || 'アップロード失敗' });
    const csvFile = req.files && req.files.csv && req.files.csv[0];
    const pdfFile = req.files && req.files.pdf && req.files.pdf[0];
    if (!csvFile) return res.status(400).json({ success: false, msg: '順位表CSVを選択してください' });
    let drivers, pdf;
    try { drivers = parseCsv(csvFile.path); } catch (e) { return res.status(400).json({ success: false, msg: 'CSV解析に失敗: ' + e.message }); }
    if (!drivers.length) return res.status(400).json({ success: false, msg: 'CSVからドライバーを読めませんでした（形式をご確認ください）' });
    try { pdf = pdfFile ? parsePdf(pdfFile.path) : { date: '', violations: [] }; } catch (e) { pdf = { date: '', violations: [] }; }
    const date = String(req.body.report_date || pdf.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, msg: '対象日が不明です。日付を指定してください' });
    const db = getDb();
    // 前回順位: 直近の過去日レポート(同ルール)の氏名→順位から計算
    let prevMap = {};
    try {
      const prev = db.prepare('SELECT data_json FROM safe_driving_reports WHERE report_date < ? ORDER BY report_date DESC LIMIT 1').get(date);
      if (prev) { const pd = JSON.parse(prev.data_json); (pd.drivers || []).forEach(x => { prevMap[String(x.name).replace(/\s+/g, '')] = x.rank; }); }
    } catch (e) {}
    const report = buildReport(drivers, pdf, prevMap);
    report.date = date;

    const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {};
    const pdfPath = pdfFile ? '/uploads/safe-driving/' + pdfFile.filename : null;
    // 同日があれば置換(古いファイルは残置・上書き)
    const old = db.prepare('SELECT id FROM safe_driving_reports WHERE report_date = ?').get(date);
    if (old) {
      db.prepare('UPDATE safe_driving_reports SET data_json=?, csv_name=?, pdf_path=COALESCE(?,pdf_path), uploaded_by=?, uploaded_by_name=?, created_at=datetime(\'now\') WHERE report_date=?')
        .run(JSON.stringify(report), csvFile.originalname || '', pdfPath, req.uid, me.display_name || '', date);
    } else {
      db.prepare('INSERT INTO safe_driving_reports (report_date, data_json, csv_name, pdf_path, uploaded_by, uploaded_by_name) VALUES (?,?,?,?,?,?)')
        .run(date, JSON.stringify(report), csvFile.originalname || '', pdfPath, req.uid, me.display_name || '');
    }
    res.json({ success: true, date, summary: report.summary });
  });
});

// ---- 日付一覧 ----
router.get('/list', authUser, (req, res) => {
  const rows = getDb().prepare('SELECT report_date, data_json FROM safe_driving_reports ORDER BY report_date DESC LIMIT 120').all();
  const dates = rows.map(r => { let s = {}; try { s = JSON.parse(r.data_json).summary || {}; } catch (e) {} return { date: r.report_date, rate: s.rate, violationCount: s.violationCount, total: s.total }; });
  res.json({ success: true, can_edit: canEdit(req.uid), dates });
});

// ---- レポート取得(最新 or 指定日) ----
router.get('/report', authUser, (req, res) => {
  const db = getDb();
  const date = String(req.query.date || '').slice(0, 10);
  const row = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? db.prepare('SELECT * FROM safe_driving_reports WHERE report_date=?').get(date)
    : db.prepare('SELECT * FROM safe_driving_reports ORDER BY report_date DESC LIMIT 1').get();
  if (!row) return res.json({ success: true, empty: true, can_edit: canEdit(req.uid) });
  let data = {}; try { data = JSON.parse(row.data_json); } catch (e) {}
  const editor = canEdit(req.uid);
  // 違反詳細は管理職・運行管理者のみ。一般は件数のみ(順位表は全員)。
  if (!editor) { if (data.violations) data.violations = null; data.violations_hidden = true; }
  res.json({ success: true, date: row.report_date, can_edit: editor, uploaded_by_name: row.uploaded_by_name, pdf_path: editor ? row.pdf_path : null, distributed_at: row.distributed_at || null, data });
});

// ---- 配信(管理職・運行管理者): 運行・品質管理メンバー全員へDM ----
// 須貝さんが内容を確認してから「配信」ボタンで送る。確認されない問題への対処として
// グループ投稿でなく個別DMで気づかせる。
// 送信元は配信した本人(実ユーザー)。bot送信DMはDM一覧から隠れて受信できないため使わない。
router.post('/distribute', authUser, express.json(), (req, res) => {
  if (!canEdit(req.uid)) return res.status(403).json({ success: false, msg: '管理職・運行管理者のみ配信できます' });
  const db = getDb();
  const date = String(req.body.date || '').slice(0, 10);
  const row = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? db.prepare('SELECT * FROM safe_driving_reports WHERE report_date=?').get(date)
    : db.prepare('SELECT * FROM safe_driving_reports ORDER BY report_date DESC LIMIT 1').get();
  if (!row) return res.status(404).json({ success: false, msg: '対象のレポートがありません' });
  let data = {}; try { data = JSON.parse(row.data_json); } catch (e) {}
  const s = data.summary || {};
  const d = row.report_date;
  const md = d.slice(5).replace('-', '/');
  const msg = '🚛 運行管理データ（' + md + '分）が更新されました。\n'
    + '・運行ドライバー ' + (s.total || 0) + '名\n'
    + '・安全運転達成率 ' + (s.rate != null ? s.rate + '%' : '-') + '（満点 ' + (s.perfect || 0) + '/' + (s.total || 0) + '名）\n'
    + '・違反 ' + (s.violationCount || 0) + '件\n'
    + '必ず内容をご確認ください。\n→ /safe-driving.html';
  // グループ全員 (bot・配信者本人は除く)。送信元=配信した本人なので自分宛て自己DMは作らない。
  const members = db.prepare('SELECT user_id FROM chat_group_members WHERE group_id=?').all(OPS_GROUP_ID)
    .map(r => r.user_id).filter(uid => uid && !/^bot_/.test(uid) && uid !== req.uid);
  const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')");
  const emit = req.app && req.app.locals && req.app.locals.emitToUser;
  const push = req.app && req.app.locals && req.app.locals.sendPushToUser;
  let count = 0;
  for (const uid of members) {
    try {
      const r = ins.run(req.uid, uid, msg);
      if (emit) emit(uid, 'dm:msg', { id: r.lastInsertRowid, from: req.uid, to: uid, content: msg, at: new Date().toISOString(), attach: null });
      if (push) { try { push(uid, { title: '🚛 運行管理データ更新', body: md + '分 達成率' + (s.rate != null ? s.rate + '%' : '-') + '・違反' + (s.violationCount || 0) + '件', tag: 'safe-driving', url: '/safe-driving.html' }); } catch (e) {} }
      count++;
    } catch (e) {}
  }
  try { db.prepare("UPDATE safe_driving_reports SET distributed_at=datetime('now') WHERE report_date=?").run(d); } catch (e) {}
  res.json({ success: true, count, date: d });
});

// ---- 削除(管理職・運行管理者) ----
router.delete('/:date', authUser, express.json(), (req, res) => {
  if (!canEdit(req.uid)) return res.status(403).json({ success: false, msg: '権限がありません' });
  const db = getDb();
  const row = db.prepare('SELECT pdf_path FROM safe_driving_reports WHERE report_date=?').get(req.params.date);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  db.prepare('DELETE FROM safe_driving_reports WHERE report_date=?').run(req.params.date);
  try { if (row.pdf_path && row.pdf_path.startsWith('/uploads/safe-driving/')) fs.unlink(path.join(__dirname, '..', '..', row.pdf_path), () => {}); } catch (e) {}
  res.json({ success: true });
});

module.exports = router;
