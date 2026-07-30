// 運転アラート (2026-05-25): ITPの違反通知メールを取り込み履歴化・集計。閲覧/取込とも管理職(is_manager)のみ。
// ITP V3 はライブAPI/位置情報なしのため、メール本文をパースして反映する方式。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

function requireManager(req, res, next) {
  const u = getDb().prepare('SELECT is_manager FROM users WHERE id = ?').get(req.uid);
  if (!u || !u.is_manager) return res.status(403).json({ success: false, msg: 'この機能は管理職以上のみ利用できます' });
  next();
}

// ITP違反通知メールのパース (全角／半角コロン両対応)。1通=1アラート想定
function parseAlert(text) {
  const get = (label) => {
    const m = String(text).match(new RegExp(label + '\\s*[：:]\\s*([^\\r\\n]+)'));
    return m ? m[1].trim() : '';
  };
  return {
    vehicle_number: get('車両番号'),
    vehicle_name: get('車両名称'),
    plate: get('登録ナンバー'),
    driver_code: get('乗務員コード'),
    driver_name: get('乗務員名称'),
    occurred_at: get('日時'),
    notice: get('通知内容'),
  };
}

// 新着アラート発火フック (index.js が設定: 管理職への派手な音+音声通知に使う)
let _onNew = null;
function setOnNewAlert(fn) { _onNew = fn; }
router.setOnNewAlert = setOnNewAlert;

// 取込み (メール本文をパースして1件登録)。IMAP連携時もこの処理を共用予定
function ingestText(text) {
  const a = parseAlert(text);
  // ⚠️ 2026-07-30 修正: 以前は「車両番号があれば notice(通知内容)が空でも取り込む」判定だったため、
  //    ITPの「(メッセージ応答)通知」(乗務員がメッセージに返信するとITPが送るメール)がすべて
  //    アラート扱いになり、管理職にサイレンが連発した(暴走)。
  //    違反/イベント内容が無いものはアラートではないので取り込まない。
  //    実測(修正時点): notice有り101件=すべて実際の違反(急減速/長時間運転事前警告/ドラレコ取得 等)、
  //                    notice空23件=すべてメッセージ応答。例外は0件。
  if (!a.notice) return { ok: false, reason: '通知内容なし(メッセージ応答等)のため対象外' };
  if (!a.vehicle_number) return { ok: false, reason: 'アラート項目が見つかりません' };
  a.dedup_key = [a.vehicle_number, a.occurred_at, a.notice].join('|');
  const r = getDb().prepare(`INSERT OR IGNORE INTO driving_alerts
    (vehicle_number, vehicle_name, plate, driver_code, driver_name, occurred_at, notice, raw, dedup_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    a.vehicle_number, a.vehicle_name, a.plate, a.driver_code, a.driver_name,
    a.occurred_at, a.notice, String(text).slice(0, 4000), a.dedup_key);
  const inserted = r.changes > 0;
  if (inserted) a.id = Number(r.lastInsertRowid);
  // 新規登録時のみ管理職へ通知 (重複は鳴らさない)
  if (inserted && _onNew) { try { _onNew(a); } catch (e) { console.warn('[alert] onNew fail', e.message); } }
  return { ok: true, inserted, alert: a };
}
// 他モジュール(IMAPポーラ等)からも使えるよう公開
router.ingestText = ingestText;

// 取込 (手動貼り付け or 連携)
router.post('/ingest', authUser, requireManager, express.json(), (req, res) => {
  const text = (req.body && (req.body.text || req.body.body) || '').toString();
  if (!text.trim()) return res.status(400).json({ success: false, msg: 'メール本文を入力してください' });
  const out = ingestText(text);
  if (!out.ok) return res.status(400).json({ success: false, msg: out.reason });
  res.json({ success: true, inserted: out.inserted, alert: out.alert });
});

// 一覧 (?days= ?type= ?q=)
router.get('/', authUser, requireManager, (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 180);
  const type = (req.query.type || '').trim();
  const q = (req.query.q || '').trim();
  let sql = `SELECT da.*, (SELECT u.avatar_url FROM users u WHERE u.avatar_url IS NOT NULL AND u.avatar_url <> '' AND REPLACE(REPLACE(u.display_name,' ',''),'　','') = REPLACE(REPLACE(da.driver_name,' ',''),'　','') LIMIT 1) AS driver_avatar FROM driving_alerts da WHERE substr(da.occurred_at,1,10) >= ?`;
  // occurred_at は "YYYY/MM/DD HH:MM:SS"。N日前(スラッシュ形式)を生成
  const d = new Date(); d.setDate(d.getDate() - days);
  const from = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
  const params = [from];
  if (type) { sql += ` AND notice LIKE ?`; params.push('%' + type + '%'); }
  if (q) { sql += ` AND (driver_name LIKE ? OR vehicle_name LIKE ? OR vehicle_number LIKE ?)`; params.push('%'+q+'%','%'+q+'%','%'+q+'%'); }
  if (req.query.handled === '0') sql += ` AND handled = 0`;
  // 未対応を上に、その中で新しい順
  sql += ` ORDER BY handled ASC, occurred_at DESC LIMIT 300`;
  const rows = getDb().prepare(sql).all(...params);
  res.json({ success: true, alerts: rows });
});

// 未対応アラート一覧 (ループ警報のブートストラップ用。リロード/再開時も鳴らし続けるため)
router.get('/unhandled', authUser, requireManager, (req, res) => {
  const rows = getDb().prepare(`SELECT id, vehicle_number, vehicle_name, plate, driver_name, occurred_at, notice
    FROM driving_alerts WHERE handled = 0 ORDER BY occurred_at DESC LIMIT 50`).all();
  res.json({ success: true, alerts: rows });
});

// ドライバー本人が「自分の当日運転アラート」を確認(帰庫点呼で葵が やさしく言及)。管理者権限は不要。
// driving_alerts に user_id は無いので display_name と driver_name を突合(空白差を無視)。当日(ローカル)分のみ。
router.get('/mine', authUser, (req, res) => {
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const name = (u && u.display_name) || '';
  if (!name) return res.json({ success: true, count: 0, alerts: [] });
  // occurred_at は "YYYY/MM/DD HH:MM:SS"。当日のスラッシュ日付を生成して先頭10桁と比較。
  const today = getDb().prepare("SELECT strftime('%Y/%m/%d','now','localtime') AS d").get().d;
  const rows = getDb().prepare(
    `SELECT id, occurred_at, notice, vehicle_name, plate
       FROM driving_alerts
      WHERE REPLACE(REPLACE(driver_name,' ',''),'　','') = REPLACE(REPLACE(?,' ',''),'　','')
        AND substr(occurred_at,1,10) = ?
      ORDER BY occurred_at DESC LIMIT 20`
  ).all(name, today);
  res.json({ success: true, count: rows.length, alerts: rows });
});

// 対応/未対応 切替。対応済みにすると発火(ループ警報)が止まる
router.post('/:id/handle', authUser, requireManager, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const handled = req.body && (req.body.handled === false || req.body.handled === 0) ? 0 : 1;
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const name = (u && u.display_name) || '';
  if (handled) {
    getDb().prepare(`UPDATE driving_alerts SET handled = 1, handled_at = datetime('now','localtime'), handled_by = ?, handled_by_name = ? WHERE id = ?`).run(req.uid, name, id);
  } else {
    getDb().prepare(`UPDATE driving_alerts SET handled = 0, handled_at = NULL, handled_by = NULL, handled_by_name = NULL WHERE id = ?`).run(id);
  }
  // 管理職全員 + 事務中心人物に状態変化を通知 → 各端末のループ警報を止める/再開
  // ⚠️ DRIVE_ALERT_EXTRA_UIDS は index.js の配信側と同一に保つこと(片方だけだと鳴り止まなくなる)。
  const DRIVE_ALERT_EXTRA_UIDS = [
    '0a7ef4f4-4478-44cc-b1f2-2903ece6316f', // 小林 昌子 (SU_SAITAMA・事務)
    '7039611c-be6d-4409-a7e3-460cf86458d1', // 卯月 正美 (IBA_KASHIMA・事務)
    '702dff81-4a62-4c69-af8a-ae7e42822da3', // 牧田 弥生 (SU_MKANTO・事務)
  ];
  try {
    const io = req.app.locals.io;
    if (io) {
      const mgrs = getDb().prepare('SELECT id FROM users WHERE is_manager = 1').all();
      const recipientIds = new Set(mgrs.map((m) => m.id));
      for (const uid of DRIVE_ALERT_EXTRA_UIDS) recipientIds.add(uid);
      for (const uid of recipientIds) io.to('user:' + uid).emit('alert:handled', { id, handled, by: name });
    }
  } catch (e) {}
  res.json({ success: true, id, handled });
});

// 集計 (通知内容別件数・期間)
router.get('/summary', authUser, requireManager, (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 180);
  const d = new Date(); d.setDate(d.getDate() - days);
  const from = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
  const rows = getDb().prepare(`SELECT notice, COUNT(*) AS n FROM driving_alerts
    WHERE substr(occurred_at,1,10) >= ? GROUP BY notice ORDER BY n DESC`).all(from);
  const total = rows.reduce((s, r) => s + r.n, 0);
  res.json({ success: true, days, total, by_type: rows });
});

module.exports = router;
