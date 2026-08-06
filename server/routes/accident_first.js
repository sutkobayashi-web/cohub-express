// ===== 事故の「一報」 (2026-08-06 社長指示) =====
// 事故報告書は書き上がるまで時間がかかる(原因・再発防止・組織的歯止めまで書かせる設計)。
// その間、事故が起きたこと自体が管理者に届かないのが問題だった。
// そこで **報告書のフロー(routes/accident.js)とは別建て**で、発生直後に一報だけを飛ばす。
//
// ⭐扱いは **運転アラート(違反)と同じレベル**にする(社長指示)。
//   = サイレン + 20秒ループ + 赤トースト + タブ点滅、「対応済み」にするまで止まらない。
//   ⚠️2026-07-09に「事故報告の一報は違反ではないのでサイレンを止めた」経緯があるが、あれは
//     **報告書を提出したときの通知**の話。実際に事故が起きた直後のこの一報は最優先で鳴らす。
//
// 一報 → (あとで) 報告書 の順。一報に報告書を紐づけられるよう report_kind/report_id を持たせている。
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// テーブル (無ければ作る)
getDb().exec(`CREATE TABLE IF NOT EXISTS accident_first_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT NOT NULL,
  reporter_name TEXT,
  company_code TEXT,
  occurred_at TEXT,
  place TEXT,
  accident_type TEXT,
  injury TEXT,
  counterpart TEXT,
  summary TEXT,
  photo_url TEXT,
  contact TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  handled INTEGER DEFAULT 0,
  handled_at TEXT,
  handled_by TEXT,
  handled_by_name TEXT,
  report_kind TEXT,
  report_id INTEGER
)`);
try { getDb().exec('CREATE INDEX IF NOT EXISTS idx_afa_handled ON accident_first_alerts(handled, id DESC)'); } catch (e) {}

// ⚠️ 受信対象は index.js の運転アラート配信と揃える。ただし**製造の2名は除外しない**
//    (運転アラートは運転と無関係なので外しているが、事故には製品事故・構内事故が含まれるため)。
//    片方だけ直すとループ警報が鳴り止まなくなるので、ここと index.js は必ずセットで見ること。
const FIRST_ALERT_EXTRA_UIDS = [
  '0a7ef4f4-4478-44cc-b1f2-2903ece6316f', // 小林 昌子 (SU_SAITAMA・事務)
  '7039611c-be6d-4409-a7e3-460cf86458d1', // 卯月 正美 (IBA_KASHIMA・事務)
  '702dff81-4a62-4c69-af8a-ae7e42822da3', // 牧田 弥生 (SU_MKANTO・事務)
];

function recipientIds(db) {
  const ids = new Set(db.prepare('SELECT id FROM users WHERE is_manager = 1').all().map((m) => m.id));
  for (const uid of FIRST_ALERT_EXTRA_UIDS) ids.add(uid);
  return ids;
}
// 一報を見る/止められる人。⚠️運転アラートは is_manager だけだったので事務3名は「鳴るのに一覧が見られない」
//   状態だった。事故の一報では受信者=閲覧者=解除できる人 を一致させる。
function canReceive(db, uid) {
  if (FIRST_ALERT_EXTRA_UIDS.includes(uid)) return true;
  const u = db.prepare('SELECT is_manager FROM users WHERE id = ?').get(uid);
  return !!(u && u.is_manager);
}

// 写真 (現場で1枚撮って送るだけ。任意)
const firstDir = path.join(__dirname, '..', '..', 'uploads', 'first-alert');
if (!fs.existsSync(firstDir)) fs.mkdirSync(firstDir, { recursive: true });
const firstUpload = multer({
  storage: multer.diskStorage({
    destination: firstDir,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '').slice(0, 8) || '.jpg').replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype || '')) return cb(null, true);
    cb(new Error('写真(画像)のみ添付できます'));
  },
});

const TYPES = ['車両事故', '人身事故', '物損事故', '荷物事故', '製品事故', '施設・設備', 'その他'];
const INJURY = ['なし', 'あり', '不明'];

function rowToPayload(r) {
  return {
    id: r.id,
    kind: 'first',
    place: r.place || '',
    accident_type: r.accident_type || '事故',
    injury: r.injury || '',
    counterpart: r.counterpart || '',
    summary: (r.summary || '').slice(0, 100),
    reporter_name: r.reporter_name || '',
    occurred_at: r.occurred_at || r.created_at || '',
    photo_url: r.photo_url || '',
    url: '/accident-first.html',
  };
}

// ===== 一報を出す (全社員) =====
router.post('/', authUser, firstUpload.single('photo'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const place = String(b.place || '').trim().slice(0, 120);
  const accidentType = TYPES.includes(String(b.accident_type)) ? String(b.accident_type) : 'その他';
  const injury = INJURY.includes(String(b.injury)) ? String(b.injury) : '不明';
  const counterpart = String(b.counterpart || '').trim().slice(0, 40);
  const summary = String(b.summary || '').trim().slice(0, 500);
  const contact = String(b.contact || '').trim().slice(0, 60);
  // 発生時刻は未入力なら「今」。書式は画面から "YYYY-MM-DD HH:MM" (JST) で来る。
  const occurredAt = String(b.occurred_at || '').trim().slice(0, 16)
    || db.prepare("SELECT datetime('now','localtime') AS t").get().t.slice(0, 16);
  if (!place && !summary) {
    return res.status(400).json({ success: false, msg: '場所か状況のどちらかは入れてください' });
  }
  const u = db.prepare('SELECT display_name, company_code FROM users WHERE id = ?').get(req.uid) || {};
  const photoUrl = req.file ? '/uploads/first-alert/' + req.file.filename : null;
  const ins = db.prepare(`INSERT INTO accident_first_alerts
      (reporter_id, reporter_name, company_code, occurred_at, place, accident_type, injury, counterpart, summary, photo_url, contact)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.uid, u.display_name || '', u.company_code || '', occurredAt, place, accidentType, injury, counterpart, summary, photoUrl, contact);
  const row = db.prepare('SELECT * FROM accident_first_alerts WHERE id = ?').get(ins.lastInsertRowid);
  const payload = rowToPayload(row);

  // ⭐運転アラートと同じ経路で鳴らす。socket は firstalert:new、止めるのは firstalert:handled。
  try {
    const io = req.app && req.app.locals && req.app.locals.io;
    const push = req.app && req.app.locals && req.app.locals.sendPushToUser;
    const body = [payload.place, payload.accident_type, 'けが人' + (payload.injury || '不明'), payload.summary]
      .filter(Boolean).join(' / ').slice(0, 140);
    for (const uid of recipientIds(db)) {
      if (io) io.to('user:' + uid).emit('firstalert:new', payload);
      if (push) push(uid, {
        title: '🚨 事故の一報',
        body,
        tag: 'firstalert-' + row.id,
        mention: true, alwaysShow: true,
        url: '/accident-first.html',
      }).catch(() => {});
    }
  } catch (e) { console.warn('[first-alert notify]', e.message); }
  res.json({ success: true, id: row.id, alert: payload });
});

// ===== 未対応一覧 (ループ警報のブートストラップ用) =====
// ⚠️受信対象でない人には 403 ではなく空配列を返す(全ページが叩くので、権限外でエラーを出さない)。
router.get('/unhandled', authUser, (req, res) => {
  const db = getDb();
  if (!canReceive(db, req.uid)) return res.json({ success: true, alerts: [] });
  const rows = db.prepare('SELECT * FROM accident_first_alerts WHERE handled = 0 ORDER BY id DESC LIMIT 50').all();
  res.json({ success: true, alerts: rows.map(rowToPayload) });
});

// ===== 一覧 (受信対象のみ) =====
router.get('/', authUser, (req, res) => {
  const db = getDb();
  if (!canReceive(db, req.uid)) return res.status(403).json({ success: false, msg: 'この一覧は管理職と各営業所の事務担当のみ見られます' });
  const days = Math.min(parseInt(req.query.days, 10) || 30, 180);
  const rows = db.prepare(`SELECT * FROM accident_first_alerts
      WHERE created_at >= datetime('now','localtime','-' || ? || ' days')
      ORDER BY handled ASC, id DESC LIMIT 200`).all(days);
  res.json({ success: true, alerts: rows, me: req.uid });
});

// ===== 自分が出した一報 (報告者が「届いたか」を確認できるように) =====
router.get('/mine', authUser, (req, res) => {
  const rows = getDb().prepare(`SELECT id, occurred_at, place, accident_type, injury, summary, handled, handled_at, handled_by_name, created_at
      FROM accident_first_alerts WHERE reporter_id = ? ORDER BY id DESC LIMIT 20`).all(req.uid);
  res.json({ success: true, alerts: rows });
});

// ===== 対応済みにする (警報停止) =====
// ⚠️報告した本人は止められない。自分で鳴らして自分で消せると「誰も気づいていないのに鳴り止む」ため
//   ([[自己承認の禁止]] 2026-07-09 と同じ考え方)。
router.post('/:id/handle', authUser, express.json(), (req, res) => {
  const db = getDb();
  if (!canReceive(db, req.uid)) return res.status(403).json({ success: false, msg: 'この操作は管理職と各営業所の事務担当のみです' });
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM accident_first_alerts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ success: false, msg: '見つかりません' });
  const handled = req.body && (req.body.handled === false || req.body.handled === 0) ? 0 : 1;
  if (handled && row.reporter_id === req.uid) {
    return res.status(403).json({ success: false, msg: '一報を出したご本人は解除できません。他の管理者が確認して解除します' });
  }
  const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid) || {};
  if (handled) {
    db.prepare(`UPDATE accident_first_alerts SET handled = 1, handled_at = datetime('now','localtime'), handled_by = ?, handled_by_name = ? WHERE id = ?`)
      .run(req.uid, u.display_name || '', id);
  } else {
    db.prepare('UPDATE accident_first_alerts SET handled = 0, handled_at = NULL, handled_by = NULL, handled_by_name = NULL WHERE id = ?').run(id);
  }
  // 受信者全員の警報を止める/再開する
  try {
    const io = req.app && req.app.locals && req.app.locals.io;
    if (io) for (const uid of recipientIds(db)) io.to('user:' + uid).emit('firstalert:handled', { id, handled, by: u.display_name || '' });
  } catch (e) {}
  // 報告者にも「受け取ったよ」を返す(現場は届いたか分からず不安になるため)
  try {
    const push = req.app && req.app.locals && req.app.locals.sendPushToUser;
    if (handled && push && row.reporter_id !== req.uid) {
      push(row.reporter_id, {
        title: '✅ 一報を受け取りました',
        body: (u.display_name || '管理者') + ' が確認しました。落ち着いてから報告書の作成をお願いします',
        tag: 'firstalert-ack-' + id,
        url: '/accident-first.html',
      }).catch(() => {});
    }
  } catch (e) {}
  res.json({ success: true, id, handled });
});

// ===== 報告書との紐付け (一報 → 後日の報告書) =====
router.post('/:id/link-report', authUser, express.json(), (req, res) => {
  const db = getDb();
  if (!canReceive(db, req.uid)) return res.status(403).json({ success: false, msg: '権限がありません' });
  const id = parseInt(req.params.id, 10);
  const kind = ['vehicle', 'product'].includes(String(req.body && req.body.report_kind)) ? String(req.body.report_kind) : null;
  const rid = parseInt(req.body && req.body.report_id, 10);
  if (!kind || !rid) return res.status(400).json({ success: false, msg: '報告書の種類とIDが必要です' });
  db.prepare('UPDATE accident_first_alerts SET report_kind = ?, report_id = ? WHERE id = ?').run(kind, rid, id);
  res.json({ success: true });
});

module.exports = router;
