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

// ── 対応記録 (2026-09-03): 「誰が・どうやって・何を」を残す ──────────────────
// これまで handled フラグ(+押した人の名前)しか残らず、133件のアラートに対して
// アラート由来の指導記録は0件だった。全員配信ゆえに「押した人＝当事者に連絡した人」とは
// 限らず、お見合い(誰も連絡していない)と重複連絡(何人も電話した)の両方が起きうるのに、
// あとから追えない。→ 1アラートに複数の対応記録を持たせる(追記できる)。
function ensureRespTable() {
  const db = getDb();
  db.prepare(`CREATE TABLE IF NOT EXISTS driving_alert_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id INTEGER NOT NULL,
    responder_id TEXT,
    responder_name TEXT,
    method TEXT,              -- 電話 / 対面 / 無線 / CoWell / メール / その他
    contacted INTEGER,        -- 1=本人と話せた 0=つながらず NULL=該当なし
    content TEXT,             -- 何を伝えたか
    created_at TEXT DEFAULT (datetime('now','localtime')),
    deleted_at TEXT
  )`).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_dar_alert ON driving_alert_responses(alert_id)').run();
}
try { ensureRespTable(); } catch (e) { console.warn('[alert] ensureRespTable', e.message); }

// 乗務員名の突合は空白差を無視する (ITPの氏名は全角/半角スペース混在)
const NM = (col) => `REPLACE(REPLACE(${col},' ',''),'　','')`;

// 対応記録を alert_id ごとにまとめて引く (N+1を避ける)
function responsesFor(ids) {
  const map = {};
  if (!ids.length) return map;
  const rows = getDb().prepare(`SELECT id, alert_id, responder_id, responder_name, method, contacted, content, created_at
    FROM driving_alert_responses WHERE deleted_at IS NULL AND alert_id IN (${ids.map(() => '?').join(',')})
    ORDER BY id ASC`).all(...ids);
  for (const r of rows) (map[r.alert_id] = map[r.alert_id] || []).push(r);
  return map;
}

// 発火時に配信した宛先と同じ集合へ状態変化を伝える
// ⚠️ DRIVE_ALERT_EXTRA_UIDS は index.js の配信側と同一に保つこと(片方だけだと鳴り止まなくなる)。
const DRIVE_ALERT_EXTRA_UIDS = [
  '0a7ef4f4-4478-44cc-b1f2-2903ece6316f', // 小林 昌子 (SU_SAITAMA・事務)
  '7039611c-be6d-4409-a7e3-460cf86458d1', // 卯月 正美 (IBA_KASHIMA・事務)
  '702dff81-4a62-4c69-af8a-ae7e42822da3', // 牧田 弥生 (SU_MKANTO・事務)
];
function emitHandled(req, id, handled, byName) {
  try {
    const io = req.app.locals.io;
    if (!io) return;
    const mgrs = getDb().prepare('SELECT id FROM users WHERE is_manager = 1').all();
    const recipientIds = new Set(mgrs.map((m) => m.id));
    for (const uid of DRIVE_ALERT_EXTRA_UIDS) recipientIds.add(uid);
    for (const uid of recipientIds) io.to('user:' + uid).emit('alert:handled', { id, handled, by: byName });
  } catch (e) {}
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
  // ⭐乗務員名の横に出す「発布歴」バッジ用: 通算回数と直近90日の回数を各行に付ける
  let sql = `SELECT da.*,
      (SELECT u.avatar_url FROM users u WHERE u.avatar_url IS NOT NULL AND u.avatar_url <> '' AND ${NM('u.display_name')} = ${NM('da.driver_name')} LIMIT 1) AS driver_avatar,
      (SELECT COUNT(*) FROM driving_alerts d2 WHERE ${NM('d2.driver_name')} = ${NM('da.driver_name')}) AS driver_total,
      (SELECT COUNT(*) FROM driving_alerts d3 WHERE ${NM('d3.driver_name')} = ${NM('da.driver_name')} AND substr(d3.occurred_at,1,10) >= ?) AS driver_recent
    FROM driving_alerts da WHERE substr(da.occurred_at,1,10) >= ?`;
  // occurred_at は "YYYY/MM/DD HH:MM:SS"。N日前(スラッシュ形式)を生成
  const d = new Date(); d.setDate(d.getDate() - days);
  const from = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
  const r90 = new Date(); r90.setDate(r90.getDate() - 90);
  const from90 = `${r90.getFullYear()}/${String(r90.getMonth()+1).padStart(2,'0')}/${String(r90.getDate()).padStart(2,'0')}`;
  // ⚠️ サブクエリの ? が先に出てくるので from90 → from の順に積む
  const params = [from90, from];
  if (type) { sql += ` AND notice LIKE ?`; params.push('%' + type + '%'); }
  if (q) { sql += ` AND (driver_name LIKE ? OR vehicle_name LIKE ? OR vehicle_number LIKE ?)`; params.push('%'+q+'%','%'+q+'%','%'+q+'%'); }
  if (req.query.handled === '0') sql += ` AND handled = 0`;
  // 未対応を上に、その中で新しい順
  sql += ` ORDER BY handled ASC, occurred_at DESC LIMIT 300`;
  const rows = getDb().prepare(sql).all(...params);
  const rmap = responsesFor(rows.map((r) => r.id));
  for (const r of rows) r.responses = rmap[r.id] || [];
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
// ⚠️ 画面からの「対応済み」は POST /:id/respond (内容つき) を使う。ここは取り消し(未対応に戻す)と、
//    内容を伴わない旧クライアント互換のための入口として残す。
router.post('/:id/handle', authUser, requireManager, express.json(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const handled = req.body && (req.body.handled === false || req.body.handled === 0) ? 0 : 1;
  const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const name = (u && u.display_name) || '';
  if (handled) {
    getDb().prepare(`UPDATE driving_alerts SET handled = 1, handled_at = datetime('now','localtime'), handled_by = ?, handled_by_name = ? WHERE id = ?`).run(req.uid, name, id);
  } else {
    // ⚠️ 取り消しても対応記録は消さない (誰が何をしたかの証跡は残す)
    getDb().prepare(`UPDATE driving_alerts SET handled = 0, handled_at = NULL, handled_by = NULL, handled_by_name = NULL WHERE id = ?`).run(id);
  }
  // 管理職全員 + 事務中心人物に状態変化を通知 → 各端末のループ警報を止める/再開
  emitHandled(req, id, handled, name);
  res.json({ success: true, id, handled });
});

// ⭐対応記録を残す (これが「対応済み」の正規の入口)。1件のアラートに何件でも追記できる。
//   最初の1件で handled=1 になり、ループ警報が止まる。
router.post('/:id/respond', authUser, requireManager, express.json(), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  const a = db.prepare('SELECT id, handled, driver_name FROM driving_alerts WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: 'アラートが見つかりません' });
  const b = req.body || {};
  const method = String(b.method || '').trim().slice(0, 40);
  const content = String(b.content || '').trim().slice(0, 1000);
  const contacted = (b.contacted === null || b.contacted === undefined || b.contacted === '') ? null : (b.contacted ? 1 : 0);
  if (!method) return res.status(400).json({ success: false, msg: '対応方法を選んでください' });
  const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
  const name = (u && u.display_name) || '';
  const r = db.prepare(`INSERT INTO driving_alert_responses (alert_id, responder_id, responder_name, method, contacted, content)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, req.uid, name, method, contacted, content);
  const wasHandled = !!a.handled;
  if (!wasHandled) {
    // 最初に記録した人を「対応者」として残す (あとからの追記では上書きしない)
    db.prepare(`UPDATE driving_alerts SET handled = 1, handled_at = datetime('now','localtime'), handled_by = ?, handled_by_name = ? WHERE id = ?`).run(req.uid, name, id);
    emitHandled(req, id, 1, name);
  } else {
    // 既に対応済み → 警報は鳴っていない。追記だけを一覧側へ知らせる (音は鳴らさない)
    try {
      const io2 = req.app.locals.io;
      if (io2) {
        const mgrs = db.prepare('SELECT id FROM users WHERE is_manager = 1').all();
        for (const m of mgrs) io2.to('user:' + m.id).emit('alert:responded', { id, by: name });
      }
    } catch (e) {}
  }
  const row = db.prepare('SELECT id, alert_id, responder_id, responder_name, method, contacted, content, created_at FROM driving_alert_responses WHERE id = ?').get(Number(r.lastInsertRowid));
  res.json({ success: true, id, handled: 1, first: !wasHandled, response: row });
});

// 1件の詳細 (対応記録 + その乗務員の発布歴)。対応入力ダイアログが開くときに引く。
router.get('/:id/responses', authUser, requireManager, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  const a = db.prepare('SELECT * FROM driving_alerts WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ success: false, msg: 'アラートが見つかりません' });
  const responses = db.prepare(`SELECT id, alert_id, responder_id, responder_name, method, contacted, content, created_at
    FROM driving_alert_responses WHERE alert_id = ? AND deleted_at IS NULL ORDER BY id ASC`).all(id);
  // 同じ乗務員の過去アラート (発布歴)
  const hist = db.prepare(`SELECT id, occurred_at, notice, handled, handled_by_name FROM driving_alerts
    WHERE ${NM('driver_name')} = ${NM('?')} AND id <> ? ORDER BY occurred_at DESC LIMIT 8`).all(a.driver_name || '', id);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM driving_alerts WHERE ${NM('driver_name')} = ${NM('?')}`).get(a.driver_name || '').n;
  res.json({ success: true, alert: a, responses, history: hist, driver_total: total });
});

// 記録の取り消し (書き間違い)。自分が入れた記録のみ・論理削除。
router.delete('/:id/respond/:rid', authUser, requireManager, (req, res) => {
  const db = getDb();
  const rid = parseInt(req.params.rid, 10);
  const row = db.prepare('SELECT id, responder_id FROM driving_alert_responses WHERE id = ? AND deleted_at IS NULL').get(rid);
  if (!row) return res.status(404).json({ success: false, msg: '記録が見つかりません' });
  if (row.responder_id !== req.uid) return res.status(403).json({ success: false, msg: '自分が入力した記録のみ取り消せます' });
  db.prepare("UPDATE driving_alert_responses SET deleted_at = datetime('now','localtime') WHERE id = ?").run(rid);
  res.json({ success: true });
});

// 集計 (通知内容別件数・期間)
router.get('/summary', authUser, requireManager, (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 180);
  const d = new Date(); d.setDate(d.getDate() - days);
  const from = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
  const rows = getDb().prepare(`SELECT notice, COUNT(*) AS n FROM driving_alerts
    WHERE substr(occurred_at,1,10) >= ? GROUP BY notice ORDER BY n DESC`).all(from);
  const total = rows.reduce((s, r) => s + r.n, 0);
  // ⭐乗務員別の発布回数 (期間内・多い順)。バッジの裏付けとして一覧の上に出す。
  const byDriver = getDb().prepare(`SELECT driver_name, COUNT(*) AS n FROM driving_alerts
    WHERE substr(occurred_at,1,10) >= ? AND COALESCE(driver_name,'') <> '' GROUP BY ${NM('driver_name')} ORDER BY n DESC LIMIT 12`).all(from);
  // 対応記録(内容)が残っている件数 = フラグだけで終わっていないか
  const rec = getDb().prepare(`SELECT
      SUM(CASE WHEN handled = 1 THEN 1 ELSE 0 END) AS handled_n,
      SUM(CASE WHEN (SELECT COUNT(*) FROM driving_alert_responses r WHERE r.alert_id = da.id AND r.deleted_at IS NULL) > 0 THEN 1 ELSE 0 END) AS recorded_n
    FROM driving_alerts da WHERE substr(da.occurred_at,1,10) >= ?`).get(from);
  res.json({ success: true, days, total, by_type: rows, by_driver: byDriver,
    handled_n: (rec && rec.handled_n) || 0, recorded_n: (rec && rec.recorded_n) || 0 });
});

module.exports = router;
