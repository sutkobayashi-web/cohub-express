// What's new: ホーム画面に表示する全社活動の最新ダイジェスト
// 直近の plaza/board/announcement/accident/circle/wellness を統合し時系列で返す
// ⚠️ 事故(accident)は「承認(公開)済みの報告書」のみ掲載 (2026-06-04)。提出直後の一報は
//   非公開＋管理職アラート(accident:new)で扱い、NEWSには承認後に承認時刻で流す。
//
// ⚠️ タイムゾーン注意 (2026-05-25):
//   ソーステーブルで created_at の保存TZが混在している(歴史的経緯)。
//     UTC(datetime('now'))  : plaza_posts / board_posts / announcements / circle_events / wellness_posts
//     JST(datetime('now','localtime')): vehicle_accident_reports / kbc_accident_reports /
//                                        weekly_reports / driving_alerts.received_at
//   クライアントの postTime() は created_at を UTC とみなして端末ローカル(JST)へ +9h 変換するため、
//   JST保存ソースをそのまま返すと二重変換で +9h ズレる(=「投稿時間が狂う」)。
//   よって JST保存ソースは出力時に datetime(col,'-9 hours') で UTC に正規化して揃える。
//   (日本はUTC+9固定・夏時間なしのため -9h は常に正確。全イベントの time順ソートも揃う。)
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

router.use(express.json({ limit: '32kb' }));

function trunc(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function safeAuthor(db, uid, isAnon) {
  try {
    const u = db.prepare('SELECT display_name, nickname FROM users WHERE id = ?').get(uid);
    if (isAnon) return u && u.nickname ? '🎭 ' + u.nickname : '🎭 匿名';
    return u && u.display_name ? u.display_name : '社員';
  } catch (e) { return isAnon ? '🎭 匿名' : '社員'; }
}

// サムネ用: 投稿写真のみ (匿名性のためアバター・人物は出さない)。JSON配列(media_paths)の先頭を返す
function firstMedia(s) {
  if (!s) return null;
  try { const a = JSON.parse(s); return (Array.isArray(a) && a.length) ? a[0] : null; } catch (e) { return null; }
}

// 添付URL→サムネURL。PDFは生成済みの1ページ目サムネ(.thumb.jpg)を指す。画像はそのまま。
function thumbFor(u) {
  if (!u) return null;
  return /\.pdf$/i.test(u) ? u + '.thumb.jpg' : u;
}

// 公開: 共用タブレットのログイン画面用ダイジェスト (未認証で出すため、個人の投稿は出さず
//        全社向けの公式情報=通達・掲示板 のみを返す)。事務所内の共用端末向け。
// ===== 既読/未読 (2026-07-28 社長「what's new の既読、未読処理が必要ですね」) =====
// ⭐端末ごと(localStorage)ではなく **ユーザーごと** に持つ。PCで読んだらスマホでも既読。
//   1件ずつ記録する = 「読んだものだけ」消える (まとめて既読にしない)。
function ensureReads(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS whatsnew_reads (
    uid TEXT NOT NULL,
    item_key TEXT NOT NULL,
    read_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (uid, item_key)
  )`);
}
try { ensureReads(getDb()); } catch (e) { console.warn('[whatsnew] reads table', e.message); }

// 表示中の項目のうち、その人が既に読んだキーの集合
function readKeys(db, uid, keys) {
  if (!keys.length) return new Set();
  const q = keys.map(() => '?').join(',');
  try {
    return new Set(db.prepare(`SELECT item_key FROM whatsnew_reads WHERE uid = ? AND item_key IN (${q})`)
      .all(uid, ...keys).map(r => r.item_key));
  } catch (e) { return new Set(); }
}

router.get('/public', (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit, 10) || 8, 15);
    const items = [];
    db.prepare(`SELECT title, level, created_at FROM announcements
      WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))
        AND created_at >= datetime('now','-30 days')
      ORDER BY created_at DESC LIMIT 10`).all().forEach(a => {
      items.push({ icon: a.level === 'urgent' ? '🚨' : '📢', label: '通達', text: a.title || '', summary: null, thumb: null, time: a.created_at });
    });
    db.prepare(`SELECT content, image_url, created_at FROM board_posts
      WHERE deleted_at IS NULL AND created_at >= datetime('now','-30 days')
      ORDER BY created_at DESC LIMIT 10`).all().forEach(b => {
      items.push({ icon: '📋', label: '掲示板', text: b.content || '', summary: null, thumb: thumbFor(b.image_url), time: b.created_at });
    });
    items.sort((x, y) => String(y.time || '').localeCompare(String(x.time || '')));
    const out = items.slice(0, limit);
    // 新機能お知らせ (app_settings.whatsnew_features) を付加。公式・非個人ゆえ未認証画面でも可。
    try {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'whatsnew_features'").get();
      const feats = row && row.value ? JSON.parse(row.value) : [];
      (Array.isArray(feats) ? feats : []).forEach(f => {
        if (!f || !f.title) return;
        out.push({ icon: f.icon || '🆕', label: '新機能', text: f.title || '', summary: f.summary || null, thumb: null, time: null });
      });
    } catch (e) {}
    res.json({ success: true, items: out });
  } catch (e) {
    res.json({ success: true, items: [] });
  }
});

router.get('/', authUser, (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20);
  const days = Math.min(parseInt(req.query.days, 10) || 7, 60);   // 既定7日 (2026-07-28: 14日は古いものが混ざり「新着」に見えなくなっていた)
  const events = [];

  // ⭐2026-07-28 見直し (社長「みんなもう見ないですね」): 全員に関係する4種だけに絞った。
  //   = 告知 / 掲示板 / 承認済みの事故報告 / 新機能のお知らせ。
  //   外したもの: ひろばの投稿(食事が大半を占め他が埋もれる。ひろば側で見る)、
  //   サークル、業務週報の提出。⚠️運転アラートは従来どおり残す(管理職のみ表示・社長 2026-07-28)。


  // board_posts (掲示板)
  try {
    const rows = db.prepare(`
      SELECT id, author_id, content, image_url, created_at
      FROM board_posts
      WHERE deleted_at IS NULL
        AND created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC LIMIT 5
    `).all(days);
    for (const r of rows) {
      events.push({
        key: 'board:' + r.id,
        type: 'board',
        icon: '📋',
        label: '掲示板',
        summary: trunc(r.content, 160),
        link: '/board.html',
        author: safeAuthor(db, r.author_id, 0),
        thumb: thumbFor(r.image_url),
        created_at: r.created_at,
      });
    }
  } catch (e) {}

  // announcements (告知)
  try {
    const rows = db.prepare(`
      SELECT id, author_id, title, created_at
      FROM announcements
      WHERE created_at >= datetime('now', '-' || ? || ' days')
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at DESC LIMIT 5
    `).all(days);
    for (const r of rows) {
      events.push({
        key: 'announce:' + r.id,
        type: 'announce',
        icon: '📢',
        label: '告知',
        summary: trunc(r.title, 36),
        link: '/announcements.html',
        author: safeAuthor(db, r.author_id, 0),
        thumb: null,
        created_at: r.created_at,
      });
    }
  } catch (e) {}

  // vehicle_accident_reports (車両事故) — 承認(公開)済みの報告書のみNEWSへ。
  // 提出直後の一報(submitted)は非公開かつ管理職アラート(accident:new)で扱うのでここには出さない。
  // 掲載時刻は承認時刻(approved_at, JST保存→-9hでUTC正規化)。
  try {
    const rows = db.prepare(`
      SELECT id, reporter_id, reporter_name, accident_type, location, media_paths,
             datetime(approved_at, '-9 hours') AS created_at_utc
      FROM vehicle_accident_reports
      WHERE status = 'approved' AND approved_at IS NOT NULL
        AND approved_at >= datetime('now', '-' || ? || ' days')
      ORDER BY approved_at DESC LIMIT 3
    `).all(days);
    for (const r of rows) {
      events.push({
        key: 'accident:vehicle:' + r.id,
        type: 'accident:vehicle',
        icon: '🚨',
        label: '車両事故',
        summary: trunc([r.accident_type, r.location].filter(Boolean).join(' / '), 36),
        link: '/accident.html',
        author: r.reporter_name || safeAuthor(db, r.reporter_id, 0),
        thumb: firstMedia(r.media_paths),
        created_at: r.created_at_utc,
      });
    }
  } catch (e) {}

  // kbc_accident_reports (製品事故) — 承認(公開)済みの報告書のみNEWSへ (一報submittedは非公開で出さない)
  try {
    const rows = db.prepare(`
      SELECT id, reporter_name, accident_type, location_area, media_paths, label_photo_path,
             datetime(approved_at, '-9 hours') AS created_at_utc
      FROM kbc_accident_reports
      WHERE status = 'approved' AND approved_at IS NOT NULL
        AND approved_at >= datetime('now', '-' || ? || ' days')
      ORDER BY approved_at DESC LIMIT 3
    `).all(days);
    for (const r of rows) {
      events.push({
        key: 'accident:product:' + r.id,
        type: 'accident:product',
        icon: '📦',
        label: '製品事故',
        summary: trunc([r.accident_type, r.location_area].filter(Boolean).join(' / '), 36),
        link: '/accident.html',
        author: r.reporter_name || '報告者',
        thumb: r.label_photo_path || firstMedia(r.media_paths),
        created_at: r.created_at_utc,
      });
    }
  } catch (e) {}


  // wellness_posts(体調/現場の声)は全員向け新着情報には出さない (2026-06-25 プライバシー修正)。
  // memo に対象者の実名が埋め込まれ、author に匿名nicknameが並ぶため、実名↔nicknameの紐付け+本人特定になっていた。
  // 要配慮個人情報。把握は推進/管理職向けの wellness.html と 点呼管理ボード(未確認バッジ)で行う。



  // 運転アラート (管理職が見ている時のみ。違反通知をテロップにも流して見逃し防止)
  try {
    const mgrA = db.prepare('SELECT is_manager FROM users WHERE id = ?').get(req.uid);
    if (mgrA && mgrA.is_manager) {
      const rows = db.prepare(`SELECT id, vehicle_name, vehicle_number, driver_name, notice, handled,
          datetime(received_at, '-9 hours') AS received_at_utc
        FROM driving_alerts
        WHERE received_at >= datetime('now', '-' || ? || ' days')
        ORDER BY received_at DESC LIMIT 5`).all(days);
      for (const r of rows) {
        const where = r.vehicle_name || r.vehicle_number || '';
        events.push({
          key: 'alert:' + r.id,
          type: 'alert', icon: '⚠️', label: '運転アラート',
          summary: (r.handled ? '' : '【未対応】') + [r.driver_name, r.notice].filter(Boolean).join('・') + (where ? `（${where}）` : ''),
          link: '/alerts.html',
          author: null,
          thumb: null,
          created_at: r.received_at_utc,
        });
      }
    }
  } catch (e) {}

  // 時系列降順で並べて limit
  events.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const out = events.slice(0, limit);
  // 未読判定 (読んだものだけ既読になる)
  const done = readKeys(db, req.uid, out.map(e => e.key).filter(Boolean));
  out.forEach(e => { e.unread = !!e.key && !done.has(e.key); });
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, events: out, unread: out.filter(e => e.unread).length });
});

// ===== What's new「新機能お知らせ」= 管理画面から編集可能 (2026-07-03) =====
function ensureSettings(db) {
  db.prepare("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))").run();
}
const DEFAULT_FEATURES = [
  { icon: '📷', title: '血圧を写真でAI入力', summary: '血圧計を撮るだけ。健康点検の血圧がAIで自動入力に', link: '/self-check.html' },
  { icon: '🩸', title: '体調セルフチェック', summary: '毎日の体調と血圧を、トップからすぐ記録できます', link: '/self-check.html' },
  { icon: '🍱', title: '食事をAIが栄養分析', summary: '食事の写真を投稿すると、AIが栄養バランスをチェック', link: '/plaza.html?tab=食事' },
  { icon: '🎤', title: '声でコメント', summary: 'コメント欄の🎤を押すと、話した声がそのまま文字に', link: '/bdiary.html' },
  { icon: '🦉', title: 'まとめる君', summary: '走り書きの報告をAIが5W1Hにきれいに整形', link: '/matomeru.html' },
];
function loadFeatures(db) {
  try {
    ensureSettings(db);
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'whatsnew_features'").get();
    if (row && row.value) { const a = JSON.parse(row.value); if (Array.isArray(a) && a.length) return a; }
  } catch (e) {}
  return DEFAULT_FEATURES;
}
router.get('/features', authUser, (req, res) => {
  const db = getDb();
  // 新機能のお知らせも1件ずつ既読管理する。キーはリンク+見出し
  // (=中身を差し替えたら未読に戻る。同じ機能を編集しただけなら既読のまま)
  const items = loadFeatures(db).map(x => Object.assign({}, x, {
    key: 'feature:' + String(x.link || '') + '|' + String(x.title || '').slice(0, 40),
  }));
  const done = readKeys(db, req.uid, items.map(i => i.key));
  items.forEach(i => { i.unread = !done.has(i.key); });
  res.json({ success: true, items, unread: items.filter(i => i.unread).length });
});

// 既読にする (クリックした項目 / 「すべて既読」)。自分ぶんしか触れない。
router.post('/read', authUser, (req, res) => {
  const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
  const clean = keys.filter(k => typeof k === 'string' && k && k.length <= 160).slice(0, 40);
  if (!clean.length) return res.json({ success: true, count: 0 });
  const db = getDb();
  ensureReads(db);
  const st = db.prepare("INSERT INTO whatsnew_reads (uid, item_key) VALUES (?, ?) ON CONFLICT(uid, item_key) DO NOTHING");
  const tx = db.transaction((rows) => { for (const k of rows) st.run(req.uid, k); });
  try { tx(clean); } catch (e) { return res.status(500).json({ success: false, msg: '保存できませんでした' }); }
  res.json({ success: true, count: clean.length });
});
router.post('/features', authUser, (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT role, employee_type, is_manager FROM users WHERE id = ?').get(req.uid);
  const isAdmin = !!(u && (u.role === 'admin' || u.employee_type === 'admin' || u.is_manager === 1));
  if (!isAdmin) return res.status(403).json({ success: false, msg: '権限がありません' });
  const arr = Array.isArray(req.body && req.body.items) ? req.body.items : null;
  if (!arr) return res.status(400).json({ success: false, msg: 'items配列が必要です' });
  const clean = arr.slice(0, 12).map((x) => ({
    icon: String((x && x.icon) || '🆕').slice(0, 4),
    title: String((x && x.title) || '').trim().slice(0, 40),
    summary: String((x && x.summary) || '').trim().slice(0, 160),
    link: String((x && x.link) || '/').trim().slice(0, 120),
  })).filter((x) => x.title);
  ensureSettings(db);
  db.prepare("INSERT INTO app_settings(key, value, updated_at) VALUES('whatsnew_features', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(JSON.stringify(clean));
  res.json({ success: true, count: clean.length });
});

module.exports = router;
