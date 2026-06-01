require('dotenv').config();
const fs = require('fs');
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
let webpush = null;
try { webpush = require('web-push'); } catch (e) { console.warn('web-push未インストール'); }
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { console.warn('nodemailer未インストール (外部相談窓口は無効)'); }
const { getDb } = require('./services/db');
const { chatBot } = require('./services/ai');
const safety = require('./services/safety');
const gcal = require('./services/gcal');

// ===== 受付AI案内員(BOT) 定義 =====
const CONCIERGE_BOTS = [
  { id: 'bot_aoi', login_id: 'bot_aoi', name: '総合案内', avatar: '/assets/concierge_aoi.png?v=2', floor: 'home', x: 744, y: 405 },
  { id: 'bot_health', login_id: 'bot_health', name: 'ヘルスアドバイザー', avatar: '/assets/concierge_health_avatar.png?v=8', floor: 'wellness_room', x: 744, y: 519 },
  { id: 'bot_safety', login_id: 'bot_safety', name: '安全太郎', avatar: '/assets/concierge_safety_avatar.png?v=4', floor: 'field_accident', x: 1080, y: 500 },
];
const OLD_BOT_IDS = ['bot_yui', 'bot_misaki', 'bot_master']; // 廃止bot
function ensureConciergeBots() {
  const db = getDb();
  // 廃止botを削除 (関連メッセージも掃除)
  for (const oldId of OLD_BOT_IDS) {
    db.prepare("DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?").run(oldId, oldId);
    db.prepare('DELETE FROM users WHERE id = ?').run(oldId);
  }
  for (const b of CONCIERGE_BOTS) {
    const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(b.id);
    if (!exists) {
      db.prepare(`INSERT INTO users (id, login_id, password_hash, display_name, company_code, role, avatar_url, employee_type)
                  VALUES (?, ?, '!disabled', ?, 'ADMIN', 'bot', ?, 'office')`).run(b.id, b.login_id, b.name, b.avatar);
    } else {
      db.prepare(`UPDATE users SET display_name=?, avatar_url=?, role='bot', company_code='ADMIN' WHERE id = ?`).run(b.name, b.avatar, b.id);
    }
  }
  // 健康管理室の励まし匿名リレー用システム送信者 (2026-05-27 個人特定事故対応)。
  // フロアには常駐しない (CONCIERGE_BOTS未登録)。role='bot' のためメンバー一覧/DM相手選択から自動除外。
  // 推進メンバーが個人を励ます際、送り主の実名を伏せ「推進メンバー」名義でDM配信するために使う。
  {
    const exists = db.prepare('SELECT id FROM users WHERE id = ?').get('bot_promoter');
    if (!exists) {
      db.prepare(`INSERT INTO users (id, login_id, password_hash, display_name, company_code, role, avatar_url, employee_type)
                  VALUES ('bot_promoter', 'bot_promoter', '!disabled', '推進メンバー', 'ADMIN', 'bot', '', 'office')`).run();
    } else {
      db.prepare(`UPDATE users SET display_name='推進メンバー', role='bot', company_code='ADMIN' WHERE id='bot_promoter'`).run();
    }
  }
}

// TURN サーバー認証情報を起動時に読み込み
let TURN_PASSWORD = '';
try { TURN_PASSWORD = fs.readFileSync(path.join(__dirname, '..', '.turn_password'), 'utf-8').trim(); } catch (e) {}
const TURN_HOST = process.env.TURN_HOST || '163.44.98.179';
const TURN_USER = process.env.TURN_USER || 'cohubuser';

// VAPID (Push通知)
if (webpush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@cohub.biz-terrace.org',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } catch (e) { console.warn('VAPID初期化失敗', e.message); }
}

async function sendPushToUser(uid, payload) {
  if (!webpush || !process.env.VAPID_PUBLIC_KEY) return;
  const subs = getDb().prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(uid);
  for (const s of subs) {
    try {
      await webpush.sendNotification({
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth }
      }, JSON.stringify(payload), { TTL: 60 });
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
      } else {
        console.warn('push send err', uid, e.statusCode || e.message);
      }
    }
  }
}

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3007;
const PROXIMITY_RADIUS = parseInt(process.env.PROXIMITY_RADIUS || '220', 10);
// ささやきモード: アバター本体 (半径28px) が触れ合う距離で発動。揮発、ログなし
// 28+28=56 が完全密着、70px で「軽く触れた」感覚 (耳打ちできる距離)
const WHISPER_TOUCH_DISTANCE = parseInt(process.env.WHISPER_TOUCH_DISTANCE || '70', 10);

// 総合案内から健康管理室の案内DM (1日1回、ロビー入室時)
// 文面を変えたい時はこの定数を編集 (環境変数WELLNESS_EVENT_TEXTで上書きも可)
const WELLNESS_EVENT_TEXT = process.env.WELLNESS_EVENT_TEXT || `🏥 健康管理室からのご案内

食事の写真を1枚撮るだけで、AIが栄養バランスを分析してくれます。
日々のちょっとした記録から、自分にあった健康のヒントが見えてきますよ。

🎯 まず試せること
・「🍱 食事投稿」で30秒撮影 → AIが栄養バランスをチェック
・「🩺 今日の一歩、明日の自分」で3日間のアクションプラン作成
・「🏥 健康管理室」でヘルスアドバイザーに気軽に相談

皆さんの健康づくり、応援しています！`;

async function maybeSendWellnessAnnouncement(uid) {
  const db = getDb();
  const u = db.prepare('SELECT display_name, last_wellness_dm_date FROM users WHERE id = ?').get(uid);
  if (!u) return;
  const today = new Date().toISOString().slice(0, 10);
  if (u.last_wellness_dm_date === today) return;
  const botId = 'bot_aoi';
  try {
    const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')")
      .run(botId, uid, WELLNESS_EVENT_TEXT);
    db.prepare("UPDATE users SET last_wellness_dm_date = ? WHERE id = ?").run(today, uid);
    const p = presence.get(uid);
    if (p && p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('dm:msg', {
        id: ins.lastInsertRowid,
        from: botId,
        to: uid,
        content: WELLNESS_EVENT_TEXT,
        at: new Date().toISOString(),
        attach: null,
      });
    }
    sendPushToUser(uid, {
      title: '🏥 総合案内',
      body: '健康管理室のCoWellイベント案内を送りました',
      tag: 'wellness-greet',
      url: '/',
    }).catch(() => {});
  } catch (e) {
    console.warn('wellness greet fail', uid, (e.message || '').slice(0, 120));
  }
}

// 総合案内からの当日予定DM送信 (1日1回、ロビー入室時)
async function maybeSendCalendarGreeting(uid) {
  const db = getDb();
  const u = db.prepare('SELECT display_name, google_cal_id, last_cal_dm_date FROM users WHERE id = ?').get(uid);
  if (!u || !u.google_cal_id) return;
  const today = new Date().toISOString().slice(0, 10);
  if (u.last_cal_dm_date === today) return;
  const botId = 'bot_aoi';
  try {
    const events = await gcal.fetchEvents(u.google_cal_id, 2, 15);
    const text = gcal.formatEventsForGreeting(events, u.display_name || 'あなた');
    const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')")
      .run(botId, uid, text);
    db.prepare("UPDATE users SET last_cal_dm_date = ? WHERE id = ?").run(today, uid);
    const p = presence.get(uid);
    if (p && p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('dm:msg', {
        id: ins.lastInsertRowid,
        from: botId,
        to: uid,
        content: text,
        at: new Date().toISOString(),
        attach: null,
      });
    }
    sendPushToUser(uid, {
      title: '📅 総合案内',
      body: '本日の予定をお届けしました',
      tag: 'cal-greet',
      url: '/',
    }).catch(() => {});
  } catch (e) {
    console.warn('cal greet fail', uid, (e.message || '').slice(0, 120));
  }
}

app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://static.cloudflareinsights.com"],
      scriptSrcElem: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://static.cloudflareinsights.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://health.biz-terrace.org", "https://*.tile.openstreetmap.org", "https://tile.openstreetmap.org"],
      mediaSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "wss:", "ws:", "https://cloudflareinsights.com", "https://cdn.jsdelivr.net"],
      workerSrc: ["'self'", "blob:"],
      childSrc: ["'self'", "blob:"],
      // 健康管理室は CoHub ネイティブの /plaza.html を iframe (CoWell吸収済)
      frameSrc: ["'self'"],
    }
  },
  crossOriginEmbedderPolicy: false,
  // 既定の no-referrer だと外部リンク(bc-scan等)で document.referrer が空になり
  // 「戻る」JSで遷移元判定不能。strict-origin-when-cross-origin で origin のみ送る
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(cors({
  origin: [process.env.WEB_APP_URL || 'https://cohub.biz-terrace.org', 'http://localhost:3005'],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 3000, standardHeaders: true, legacyHeaders: false });
// 認証系は別の厳格な制限 (ブルートフォース対策)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, msg: 'ログイン試行が多すぎます。15分後に再試行してください' },
  skipSuccessfulRequests: true,  // 成功は数えない
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/change-password', authLimiter);
app.use('/api/auth/tablet-login', authLimiter);
app.use('/api/', apiLimiter);

// /api/* は絶対にキャッシュさせない (ブラウザ/Cloudflareが古い401を304で返す事故を防止)
app.use('/api/', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
// API応答の ETag を無効化 (304 Not Modified を発生させない)
app.set('etag', false);

app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  index: false,  // ルート '/' で index.html を自動配信させない (MINIMAL_MODE 切替のため SPA fallback で制御)
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')
        || filePath.endsWith('manifest.json') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    // .ps1 を text/plain で配信 (PowerShell の Invoke-RestMethod が文字列として受信できるように)
    if (filePath.endsWith('.ps1')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// DB初期化
getDb();

// ルート
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/avatar', require('./routes/avatar'));
app.use('/api/enroll', require('./routes/enroll'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/search', require('./routes/search'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/voice', require('./routes/tts'));
app.use('/api/wellness', require('./routes/wellness'));
app.use('/api/board', require('./routes/board'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/ops', require('./routes/ops'));
app.use('/api/videos', require('./routes/videos'));
app.use('/api/cw-archive', require('./routes/cw_archive'));
app.use('/api/plaza', require('./routes/plaza'));
app.use('/api/events', require('./routes/events'));
app.use('/api/myhealth', require('./routes/health'));
app.use('/api/myplan', require('./routes/myplan'));
app.use('/api/themes', require('./routes/themes'));
app.use('/api/challenges', require('./routes/challenges'));
app.use('/api/accident', require('./routes/accident'));
app.use('/api/kbc', require('./routes/kbc'));
app.use('/api/walk', require('./routes/walk'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/help', require('./routes/help'));
// 出退勤打刻機能は完全削除 (2026-05-25)。/api/timecard 廃止 → 自動打刻(scanAutoPunchOut/PC起動in)も停止
app.use('/api/meeting', require('./routes/meeting'));
{
  const mp = require('./routes/meeting_poll');
  app.use('/api/poll', mp);
  if (typeof mp.startReminderScheduler === 'function') {
    setTimeout(() => mp.startReminderScheduler(app), 3000);
  }
}
app.use('/api/daily-message', require('./routes/daily_message'));
app.use('/api/whats-new', require('./routes/whats_new'));
app.use('/api/health-literacy', require('./routes/health_literacy'));
app.use('/api/members', require('./routes/members'));
app.use('/api/takara', require('./routes/takara_demo'));
app.use('/api/circles', require('./routes/circles'));
app.use('/api/branch-wifi', require('./routes/branch_wifi'));
app.use('/api/translate', require('./routes/translate'));
app.use('/api/expense', require('./routes/expense'));
app.use('/api/approval', require('./routes/approval'));
app.use('/api/tenko', require('./routes/tenko'));
// 2026-05-24〜25 機能 (誤って未mount化していたため復旧 2026-05-25): 共有カレンダー/業務週報/まとめる君/運転アラート
app.use('/api/shared-calendar', require('./routes/shared_calendar'));
app.use('/api/weekly-report', require('./routes/weekly_report'));
app.use('/api/report', require('./routes/report'));
app.use('/api/alert', require('./routes/alert'));

// ===== フィーチャーフラグ (ダウングレード制御 2026-05-07) =====
// MINIMAL_MODE=1 の場合、/ で home.html (8カードシンプル玄関) を返す。
// 0または未設定なら従来の index.html (フル機能) を返す。
const MINIMAL_MODE = process.env.MINIMAL_MODE === '1';

// アプリ全体のバージョン。デプロイ時にbumpして、クライアントは値が変わったら自動リロード
// (古い HTML を使い続けるメンバー対策)
const APP_VERSION = "2026-06-01-presence-away-v2"
app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, version: APP_VERSION });
});

app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    minimal_mode: MINIMAL_MODE,
    features: {
      chat: true,
      timecard: false,
      meal: true,
      plaza: true,
      board: true,
      announcements: true,
      ops: true,
      accident: true,
      challenges: true,
      // 以下は MINIMAL_MODE で非表示推奨 (UI側で参照)
      walk: !MINIMAL_MODE,
      videos: !MINIMAL_MODE,
      myplan: !MINIMAL_MODE,
      cw_archive: !MINIMAL_MODE,
      avatar: !MINIMAL_MODE,
      overview: !MINIMAL_MODE,
    },
  });
});

// モバイル用: 指定フロアに今いる人の一覧 (m.html の人リスト・ビュー用)
const { authUser } = require('./middleware/auth');
// ===== 外部相談窓口 (NPO等の第三者へ匿名相談を転送) =====
// 設計: 本文はサーバ内でメール送信 → DB に永続化しない
// 管理者でも内容は閲覧不可。件数+カテゴリ集計のみ
const REPORT_HASH_SECRET = process.env.REPORT_HASH_SECRET || (process.env.JWT_SECRET || 'change-me') + '-report';
let reportTransporter = null;
function getReportTransporter() {
  if (!nodemailer) return null;
  if (reportTransporter) return reportTransporter;
  if (!process.env.SMTP_HOST) return null;
  try {
    reportTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } catch (e) { console.warn('[report] SMTP transporter init fail', e.message); return null; }
  return reportTransporter;
}
const REPORT_CATEGORIES = new Set(['harassment', 'mental', 'health', 'workplace', 'other']);
const REPORT_CAT_LABEL = { harassment: 'ハラスメント', mental: 'メンタル不調', health: '健康相談', workplace: '職場環境', other: 'その他' };

app.post('/api/report/external', authUser, express.json({ limit: '32kb' }), async (req, res) => {
  const body = req.body || {};
  const category = String(body.category || '').trim();
  const urgency = body.urgency === 'urgent' ? 'urgent' : 'normal';
  const text = String(body.body || '').trim().slice(0, 4000);
  const contact = String(body.contact || '').trim().slice(0, 200) || null;
  if (!REPORT_CATEGORIES.has(category)) return res.status(400).json({ success: false, msg: 'カテゴリ不正' });
  if (text.length < 10) return res.status(400).json({ success: false, msg: '本文は10文字以上' });
  const transporter = getReportTransporter();
  if (!transporter) return res.status(500).json({ success: false, msg: 'メール送信基盤未設定。管理者にお問い合わせください。' });
  const crypto = require('crypto');
  const senderHash = crypto.createHash('sha256').update(req.uid + REPORT_HASH_SECRET).digest('hex').slice(0, 24);
  const reportTo = process.env.REPORT_TO || 'su.t.kobayashi@gmail.com';
  const reportFrom = process.env.REPORT_FROM || process.env.SMTP_USER;
  const ins = getDb().prepare(`INSERT INTO report_dispatch (category, urgency, sender_hash, has_contact, body_len, status) VALUES (?, ?, ?, ?, ?, 'pending')`)
    .run(category, urgency, senderHash, contact ? 1 : 0, text.length);
  const reportId = ins.lastInsertRowid;
  const subject = `[CoWell相談 #${reportId}] ${REPORT_CAT_LABEL[category]} ${urgency === 'urgent' ? '🚨緊急' : ''}`;
  const mailBody = `CoWell 外部相談窓口より受信しました。\n\n` +
    `受付ID: #${reportId}\n` +
    `カテゴリ: ${REPORT_CAT_LABEL[category]}\n` +
    `緊急度: ${urgency === 'urgent' ? '🚨 即対応希望' : '通常'}\n` +
    `匿名識別子: ${senderHash}  (同一人物の追加相談判別用、社内には開示されません)\n` +
    `${contact ? '連絡先: ' + contact + '\n' : '連絡先: 指定なし (匿名相談)\n'}` +
    `送信日時: ${new Date().toLocaleString('ja-JP')}\n\n` +
    `── 本文 ──\n${text}\n\n` +
    `──\nこのメールは CoWell の外部相談窓口を通じて送信されました。\n` +
    `内容は CoWell 社内管理者には共有されません (件数・カテゴリの集計のみ)。\n` +
    `対応後、必要に応じて返信は ${contact || '(連絡先未指定)'} へ。`;
  try {
    await transporter.sendMail({ from: reportFrom, to: reportTo, subject, text: mailBody });
    getDb().prepare(`UPDATE report_dispatch SET status='sent' WHERE id=?`).run(reportId);
    res.json({ success: true, id: reportId, msg: '外部窓口に送信しました。受付ID: #' + reportId });
  } catch (e) {
    console.warn('[report] mail send fail', e.message);
    getDb().prepare(`UPDATE report_dispatch SET status='failed' WHERE id=?`).run(reportId);
    res.status(500).json({ success: false, msg: 'メール送信失敗。少し時間をおいて再度お試しください' });
  }
});

// 管理者向け: 外部相談窓口の件数集計 (本文・送信者は見えない)
app.get('/api/admin/reports/summary', (req, res) => {
  // authAdmin インライン (中央のmiddleware使うとimport追加必要なので簡易判定)
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ success: false });
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ success: false, msg: '管理者専用' });
  } catch (e) { return res.status(401).json({ success: false }); }
  const days = Math.min(parseInt(req.query.days) || 30, 365);
  const sinceISO = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS c FROM report_dispatch WHERE sent_at >= ?`).get(sinceISO).c;
  const byCat = db.prepare(`SELECT category, urgency, status, COUNT(*) AS c FROM report_dispatch WHERE sent_at >= ? GROUP BY category, urgency, status`).all(sinceISO);
  const recent = db.prepare(`SELECT id, category, urgency, status, sent_at FROM report_dispatch ORDER BY id DESC LIMIT 20`).all();
  res.json({ success: true, days, total, by_category: byCat, recent });
});

// 個人ブロック: 自分のブロック一覧
app.get('/api/users/blocks', authUser, (req, res) => {
  const rows = getDb().prepare(`SELECT u.id, u.display_name, u.company_code, u.avatar_url, ub.created_at, ub.reason
    FROM user_blocks ub JOIN users u ON u.id = ub.blocked_id
    WHERE ub.blocker_id = ? ORDER BY ub.created_at DESC`).all(req.uid);
  res.json({ success: true, blocks: rows });
});
// 個人ブロック: 追加
app.post('/api/users/block', authUser, express.json(), (req, res) => {
  const blockedId = (req.body && req.body.uid || '').toString();
  const reason = (req.body && req.body.reason || '').toString().slice(0, 200) || null;
  if (!blockedId || blockedId === req.uid) return res.status(400).json({ success: false, msg: '不正な対象' });
  const target = getDb().prepare('SELECT id, role FROM users WHERE id = ?').get(blockedId);
  if (!target) return res.status(404).json({ success: false, msg: 'ユーザー未存在' });
  if (target.role === 'bot') return res.status(400).json({ success: false, msg: 'botはブロックできません' });
  getDb().prepare('INSERT OR REPLACE INTO user_blocks (blocker_id, blocked_id, reason) VALUES (?, ?, ?)').run(req.uid, blockedId, reason);
  res.json({ success: true });
});
// 個人ブロック: 解除
app.delete('/api/users/block/:uid', authUser, (req, res) => {
  const blockedId = req.params.uid;
  if (!blockedId) return res.status(400).json({ success: false });
  getDb().prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.uid, blockedId);
  res.json({ success: true });
});

// 人間同士チャット用 送信前安全チェック (本人にだけ警告を返す。ログは送信時に別途記録)
app.post('/api/safety/check-message', authUser, express.json({ limit: '32kb' }), (req, res) => {
  const text = (req.body && req.body.text || '').toString();
  if (!text.trim()) return res.json({ success: true, hit: null });
  const hit = safety.checkForHumanChat(text);
  if (!hit) return res.json({ success: true, hit: null });
  const tpl = safety.warningTemplate(hit.category);
  res.json({ success: true, hit: { category: hit.category, severity: hit.severity }, warning: tpl });
});

app.get('/api/floor-presence/:code', authUser, (req, res) => {
  const code = req.params.code;
  const inFloor = floorUserList(code).filter(u => u.floor === code && u.status !== 'offline');
  // 自分自身は除外
  res.json({ success: true, floor: code, members: inFloor.filter(u => u.uid !== req.uid) });
});

// オンラインユーザー一覧 (offline と 退席中 を除く、bot除く)
// ※退席中(スリープ離脱/5分無操作の自動退席)は「在席」に含めない → /chat で離席が分かる
app.get('/api/online-users', authUser, (req, res) => {
  const ids = [];
  const away = [];
  for (const [uid, p] of presence) {
    if (!p || p.isBot || p.status === 'offline') continue;
    if (p.status === '退席中') { away.push(uid); continue; } // 離席(スリープ/5分無操作)
    ids.push(uid);
  }
  res.json({ success: true, online: ids, away });
});

// 初回管理者ブートストラップ（users 0件の時だけ有効）
app.post('/api/bootstrap', (req, res) => {
  const db = getDb();
  const cnt = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (cnt.c > 0) return res.status(403).json({ success: false, msg: '既に初期化済みです' });
  if (req.body.secret !== process.env.BOOTSTRAP_SECRET) return res.status(403).json({ success: false, msg: 'secret不正' });
  const crypto = require('crypto');
  const bcrypt = require('bcryptjs');
  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync(req.body.password, 10);
  db.prepare(`INSERT INTO users (id, login_id, password_hash, display_name, company_code, role)
    VALUES (?, ?, ?, ?, ?, 'admin')`).run(id, req.body.login_id, hash, req.body.display_name, 'STD');
  res.json({ success: true, id });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ===== PWAプッシュ通知 =====
app.get('/api/push/vapid', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

app.post('/api/push/subscribe', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false });
  let uid;
  try { uid = jwt.verify(token, process.env.JWT_SECRET).uid; }
  catch (e) { return res.status(401).json({ success: false }); }
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ success: false });
  }
  try {
    getDb().prepare('INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)')
      .run(uid, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, msg: e.message }); }
});

app.post('/api/push/unsubscribe', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false });
  let uid;
  try { uid = jwt.verify(token, process.env.JWT_SECRET).uid; }
  catch (e) { return res.status(401).json({ success: false }); }
  const endpoint = req.body && req.body.endpoint;
  if (endpoint) getDb().prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(uid, endpoint);
  res.json({ success: true });
});

// ICE サーバー情報（認証ユーザーのみ。TURN認証情報を漏洩しない）
app.get('/api/voice/ice-servers', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false });
  try { jwt.verify(token, process.env.JWT_SECRET); }
  catch (e) { return res.status(401).json({ success: false }); }
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (TURN_PASSWORD) {
    servers.push({
      urls: ['turn:' + TURN_HOST + ':3478?transport=udp', 'turn:' + TURN_HOST + ':3478?transport=tcp'],
      username: TURN_USER,
      credential: TURN_PASSWORD,
    });
  }
  res.json({ success: true, iceServers: servers });
});

// 全フロアスナップショット (オーバービュー用)
app.get('/api/overview/snapshot', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '')
    || (req.query.token || '');
  if (!token) return res.status(401).json({ success: false });
  try { jwt.verify(token, process.env.JWT_SECRET); }
  catch (e) { return res.status(401).json({ success: false }); }
  const db = getDb();
  const floors = allFloors();
  const rows = db.prepare(`SELECT u.id, u.display_name, u.company_code, u.avatar_url, u.role, c.ring_color
    FROM users u LEFT JOIN companies c ON c.code = u.company_code`).all();
  const users = [];
  for (const u of rows) {
    const p = presence.get(u.id);
    if (!p || p.status === 'offline') continue;
    if (p.isBot) continue;
    users.push({
      uid: u.id,
      name: u.display_name,
      company: u.company_code,
      avatar: u.avatar_url,
      ring: u.ring_color || '#333',
      role: u.role,
      floor: p.floor,
      x: p.x,
      y: p.y,
      speaking: !!p.speaking,
      voiceOn: !!p.voiceOn,
      isMobile: !!p.isMobile,
    });
  }
  res.json({ success: true, floors, users, ts: Date.now() });
});

// SPA fallback (HTML キャッシュ無効化: 修正即時反映のため)
function sendHtmlNoCache(res, file) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', file));
}
app.get('/admin', (req, res) => sendHtmlNoCache(res, 'admin.html'));
app.get('/mylog', (req, res) => sendHtmlNoCache(res, 'mylog.html'));
app.get('/m', (req, res) => sendHtmlNoCache(res, 'm.html'));
app.get('/overview', (req, res) => sendHtmlNoCache(res, 'overview.html'));
app.get('/report', (req, res) => sendHtmlNoCache(res, 'report.html'));
// /full は廃止 (2026-05-18: 葵/3Dロビー全廃止方針)。完全に /home へ302固定
app.get('/full', (req, res) => res.redirect(302, '/home'));
app.get('/index.html', (req, res) => res.redirect(302, '/home'));
app.get('/home', (req, res) => sendHtmlNoCache(res, 'home.html'));
app.get('/meeting', (req, res) => sendHtmlNoCache(res, 'meeting.html'));
// /meeting-archive は2026-05-19にZoom主導化で廃止 → /meetingへ
app.get('/meeting-archive', (req, res) => res.redirect(302, '/meeting'));
app.get('/health-literacy', (req, res) => sendHtmlNoCache(res, 'health-literacy.html'));
app.get('/tablet', (req, res) => sendHtmlNoCache(res, 'tablet.html'));
app.get('/ops-literacy', (req, res) => sendHtmlNoCache(res, 'ops-literacy.html'));
app.get('/takara', (req, res) => sendHtmlNoCache(res, 'takara/admin.html'));
app.get('/takara/driver', (req, res) => sendHtmlNoCache(res, 'takara/driver.html'));
app.get('/takara/shipper', (req, res) => sendHtmlNoCache(res, 'takara/shipper.html'));
app.get('/takara/proposal', (req, res) => sendHtmlNoCache(res, 'takara/proposal.html'));
app.get('/takara/onepager', (req, res) => sendHtmlNoCache(res, 'takara/onepager.html'));
app.get('/timecard', (req, res) => res.redirect(302, '/home'));   // 出退勤打刻 完全削除 (2026-05-25)
app.get('/chat', (req, res) => sendHtmlNoCache(res, 'chat-simple.html'));
app.get('/avatar', (req, res) => sendHtmlNoCache(res, 'avatar.html'));
// PC起動通知ワンライナー (text/plain で配信して Invoke-RestMethod が文字列として受け取れるように)
app.get('/setup/install-startup.ps1', (req, res) => {
  const fp = path.join(__dirname, '..', 'public', 'setup', 'install-startup.ps1');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(fp);
});
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  if (req.path.startsWith('/uploads/')) return res.status(404).end();
  // 旧 lobby/葵/3D は完全廃止 (2026-05-18)。未知パスは全部 home.html。MINIMAL_MODE分岐撤去。
  if (req.path === '/' || req.path === '/home') return sendHtmlNoCache(res, 'home.html');
  return res.redirect(302, '/home');
});

// ===== Socket.IO =====
const io = new Server(server, {
  cors: { origin: [process.env.WEB_APP_URL || 'https://cohub.biz-terrace.org', 'http://localhost:3005'], credentials: true },
  maxHttpBufferSize: 1024 * 1024,
  // pong途絶でのオフライン化をスイープ主導にするため、engine.ioのタイムアウトを緩める
  // (背景タブの誤切断も低減。実際の生存判定は下のプレゼンス・スイープが担う)
  pingInterval: 20000,
  pingTimeout: 40000,
});
// ルート側からioを使えるようlocalsに共有
app.locals.io = io;

// ソケット認証 (JWT + デバイス種別セッション照合)
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauth'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.uid = payload.uid;
    socket.role = payload.role;
    socket.dev = payload.dev || null;
    socket.sid = payload.sid || null;
    socket.isMobile = !!(socket.handshake.auth && socket.handshake.auth.isMobile);
    // デバイス種別ごとのセッション照合 (新しいログインで旧セッションをキック)
    if (payload.sid && payload.role !== 'bot') {
      try {
        const u = getDb().prepare('SELECT pc_session_token, mobile_session_token, session_token FROM users WHERE id = ?').get(payload.uid);
        let ok = false;
        if (payload.dev === 'mobile') ok = !!(u && u.mobile_session_token && u.mobile_session_token === payload.sid);
        else if (payload.dev === 'pc') ok = !!(u && u.pc_session_token && u.pc_session_token === payload.sid);
        else {
          // 旧JWT互換: dev未指定なら3フィールドのいずれかに一致すればOK
          ok = !!(u && (
            (u.session_token && u.session_token === payload.sid) ||
            (u.pc_session_token && u.pc_session_token === payload.sid) ||
            (u.mobile_session_token && u.mobile_session_token === payload.sid)
          ));
        }
        if (!ok) {
          return next(new Error('session_kicked'));
        }
      } catch (e) { /* DB失敗時はフェイルオープン */ }
    }
    next();
  } catch (e) { next(new Error('unauth')); }
});

const presence = new Map(); // uid → { x, y, status, floor, socketId }
const tapTimestamps = new Map(); // `${fromUid}:${toUid}` → ts (肩たたきレート制限)
const callTimestamps = new Map(); // `${fromUid}:${toUid}` → ts (DM呼出レート制限)
const lastLogoutAt = new Map(); // uid → ts: 真の離脱時刻 (ナビゲーション再接続のアナウンス抑止用)
const LOGIN_ANNOUNCE_COOLDOWN_MS = 5 * 60 * 1000; // 5分以内の再接続はログインアナウンスしない (ページ遷移対応)

// REST → ソケット 配信ヘルパー (ルートから呼び出せるようlocalsに登録)
app.locals.emitToGroupMembers = function(groupId, eventName, payload) {
  try {
    const members = getDb().prepare('SELECT user_id FROM chat_group_members WHERE group_id = ?').all(groupId);
    for (const m of members) {
      const tp = presence.get(m.user_id);
      if (tp) {
        const s = io.sockets.sockets.get(tp.socketId);
        if (s) s.emit(eventName, payload);
      }
    }
    return members.length;
  } catch (e) { console.warn('emitToGroupMembers fail', e.message); return 0; }
};
app.locals.sendPushToUser = (uid, p) => sendPushToUser(uid, p);

// AI不適切検知時の管理者+推進メンバー通報
// (1) 管理者全員にPush通知 (2) 推進メンバーDMにシステム警告メッセージ
function notifyInappropriateDetection(senderUid, botId, content, hit) {
  try {
    const db = getDb();
    const sender = db.prepare("SELECT display_name, nickname FROM users WHERE id = ?").get(senderUid) || {};
    const senderName = sender.display_name || sender.nickname || '不明';
    const targets = db.prepare("SELECT id FROM users WHERE (employee_type='admin' OR is_field_promoter=1) AND role != 'bot'").all();
    const summary = `🚨 AI不適切検知\n${senderName} → ${botId === 'bot_health' ? 'ヘルス' : '総合案内'}\nカテゴリ: ${hit.category} (${hit.severity})\n本文先頭: 「${(content||'').slice(0, 60)}…」\n→ /admin で履歴確認`;
    for (const t of targets) {
      // Push通知 (オフラインでも届く)
      sendPushToUser(t.id, {
        title: '🚨 AI不適切検知',
        body: senderName + ' / ' + hit.category,
        tag: 'safety-alert',
        mention: true,
        url: '/admin',
      }).catch(() => {});
      // システムBOTからDM (管理者の DM 履歴に残る、後で確認可)
      try {
        const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES ('bot_aoi', ?, ?, 'dm')").run(t.id, summary);
        const tp = presence.get(t.id);
        if (tp) {
          const s = io.sockets.sockets.get(tp.socketId);
          if (s) s.emit('dm:msg', {
            id: ins.lastInsertRowid, from: 'bot_aoi', to: t.id, content: summary,
            at: new Date().toISOString(), attach: null,
          });
        }
      } catch (e) {}
    }
    console.warn(`[safety notify] sent to ${targets.length} admins/promoters`);
  } catch (e) { console.warn('[safety notify fail]', e.message); }
}

// 単一ユーザーへのソケット送信ヘルパー (REST→DM配信用)
app.locals.emitToUser = function(uid, eventName, payload) {
  try {
    const tp = presence.get(uid);
    if (!tp) return false;
    const s = io.sockets.sockets.get(tp.socketId);
    if (s) { s.emit(eventName, payload); return true; }
    return false;
  } catch (e) { return false; }
};

// ハドルゾーン定義 (フロア毎・座標は world 座標)
// zone内のユーザーは独立した音声グループを形成 (フロア外の人には聞こえない)
const HUDDLE_ZONES = {
  office: [
    { code: 'huddle_a', name: '🎙️ ハドル席', x1: 1050, y1: 70, x2: 1300, y2: 260 },
  ],
};


function getVoiceGroup(p) {
  if (!p) return '';
  const zones = HUDDLE_ZONES[p.floor] || [];
  for (const z of zones) {
    if (p.x >= z.x1 && p.x <= z.x2 && p.y >= z.y1 && p.y <= z.y2) {
      return p.floor + ':' + z.code;
    }
  }
  return p.floor + ':open';
}

// DM権限判定: true=許可 / false=拒否 (レポートライン保護)
// 5/19以降: 役員(EXECUTIVE_GROUP_ID メンバー)宛DMは共通chat_group所属必須
//          - 一般→部長/管理職 (役員以外の admin) は引き続き許可
//          - 一般→役員 は同じchat_groupに居る場合のみ許可
function canDm(sender, receiver) {
  if (!sender || !receiver) return false;
  if (sender.role === 'admin' || sender.role === 'bot') return true;
  if (receiver.role === 'bot') return true;
  // 推進メンバー(現場/倉庫)は横断的に全員へDM可 (5/19、役員宛も含む)
  if (sender.is_field_promoter || sender.is_warehouse_promoter) return true;
  // 推進メンバー宛も誰からでも受信可 (5/20、現場相談窓口として機能させるため)
  if (receiver.is_field_promoter || receiver.is_warehouse_promoter) return true;

  const recvIsExec = isExecutive(receiver.id);
  // 役員以外の管理者は引き続き自由に許可
  if (receiver.role === 'admin' && !recvIsExec) return true;

  // 役員宛のDMは職種で分岐 (5/19レポートライン保護 + 個別許可リスト)
  if (recvIsExec) {
    const allowed = getDb().prepare(
      `SELECT 1 FROM dm_executive_allow WHERE executive_uid = ? AND user_uid = ? LIMIT 1`
    ).get(receiver.id, sender.id);
    if (allowed) return true;
    // 現場職 (ドライバー/荷役) は許可リストなしならブロック
    if (sender.job_role === 'driver' || sender.job_role === 'warehouse') return false;
    // 事務職員・管理部門・未設定は役員宛もフリーDM
    return true;
  }

  const sr = sender.dm_restricted | 0;
  const rr = receiver.dm_restricted | 0;
  // 双方制限なし → OK
  if (!sr && !rr) return true;

  // 制限あり: 共通chat_group所属が必要
  const shared = getDb().prepare(`SELECT 1 FROM chat_group_members a
    JOIN chat_group_members b ON a.group_id = b.group_id
    WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`).get(sender.id, receiver.id);
  return !!shared;
}

// 役員判定: users.job_role === 'executive' に統一 (5/19整理)
// 旧来の chat_group "役員" メンバーシップは独立した存在 (チャットグループとして残置)
function isExecutive(uid) {
  if (!uid) return false;
  const r = getDb().prepare(`SELECT job_role FROM users WHERE id = ?`).get(uid);
  return !!(r && r.job_role === 'executive');
}
function loadUserForDm(uid) {
  return getDb().prepare('SELECT id, role, dm_group, dm_rank, dm_restricted, job_role, is_field_promoter, is_warehouse_promoter FROM users WHERE id = ?').get(uid);
}

// 録音同意ペンディング状態 (floor → state)
const pendingRecConsents = new Map();
function finalizeRecConsent(floor, isTimeout) {
  const state = pendingRecConsents.get(floor);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  pendingRecConsents.delete(floor);
  const adminPresence = presence.get(state.adminUid);
  if (!adminPresence) return;
  const adminSocket = io.sockets.sockets.get(adminPresence.socketId);
  if (!adminSocket) return;
  let agreed = 0, denied = 0, pending = 0;
  for (const v of state.responses.values()) {
    if (v === 'ok') agreed++;
    else if (v === 'no') denied++;
    else pending++;
  }
  if (denied === 0 && pending === 0) {
    adminSocket.emit('recording:start-allowed', { agreedCount: agreed, totalCount: state.total });
  } else {
    adminSocket.emit('recording:start-denied', {
      reason: denied > 0 ? 'denied' : 'timeout',
      msg: denied > 0 ? state.deniers.join(', ') + ' が拒否しました' : pending + '名から30秒以内に応答がありませんでした',
      agreedCount: agreed, deniedCount: denied, pendingCount: pending,
    });
  }
}

// 個人ブロック判定: blocker が blocked をブロックしているか
function isBlocked(blockerUid, blockedUid) {
  if (!blockerUid || !blockedUid || blockerUid === blockedUid) return false;
  try {
    const r = getDb().prepare('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?').get(blockerUid, blockedUid);
    return !!r;
  } catch (e) { return false; }
}

function allFloors() {
  const rows = getDb().prepare('SELECT code, name, bg_image, world_w, world_h, entry_x, entry_y, sort_order, icon, locked, approval_mode, building FROM floors ORDER BY sort_order').all();
  return rows.map(r => ({ ...r, locked: !!r.locked, approval_mode: !!r.approval_mode }));
}

function getFloor(code) {
  const r = getDb().prepare('SELECT code, name, bg_image, world_w, world_h, entry_x, entry_y, sort_order, icon, locked, lock_pw_hash, locked_by, approval_mode, building FROM floors WHERE code = ?').get(code);
  if (!r) return null;
  r.locked = !!r.locked;
  r.approval_mode = !!r.approval_mode;
  return r;
}

function getUserEmployeeType(uid) {
  const r = getDb().prepare('SELECT employee_type, role FROM users WHERE id = ?').get(uid);
  return r || { employee_type: 'office', role: 'member' };
}

// 会議モード対応フロア (施錠/承認制/挙手集計などの対象)
function isMeetingFloorCode(code) {
  if (!code) return false;
  return /^(meeting|exec)/.test(code) || code === 'field_accident';
}

// 承認待ちキュー: targetFloor -> Map<uid, timer>
const pendingKnocks = new Map();

// 入口座標 (未設定時はワールド中央下部)
function entryPoint(floor) {
  const ex = (floor && floor.entry_x != null) ? floor.entry_x : Math.floor((floor.world_w || 1344) / 2);
  const ey = (floor && floor.entry_y != null) ? floor.entry_y : ((floor.world_h || 768) - 90);
  return { x: ex, y: ey };
}

function floorCountMap() {
  const map = {};
  for (const [, p] of presence) {
    if (p.status === 'offline') continue;
    if (p.isBot) continue; // BOT(受付AI)は人数に含めない
    map[p.floor] = (map[p.floor] || 0) + 1;
  }
  return map;
}

// 指定フロアに居るメンバー（+オフライン全員のメタ情報）
function floorUserList(floorCode) {
  const db = getDb();
  const users = db.prepare(`SELECT u.id, u.display_name, u.company_code, u.avatar_url, u.employee_type, u.role, u.dm_group, u.dm_rank, c.ring_color
    FROM users u LEFT JOIN companies c ON c.code = u.company_code`).all();
  return users.map(u => {
    const p = presence.get(u.id);
    const connected = p && p.status !== 'offline';
    const inFloor = connected && p.floor === floorCode;
    return {
      uid: u.id,
      name: u.display_name,
      company: u.company_code,
      avatar: u.avatar_url,
      ring: u.ring_color || '#333',
      employee_type: u.employee_type || 'office',
      role: u.role,
      dm_group: u.dm_group || null,
      dm_rank: u.dm_rank | 0,
      x: inFloor ? p.x : null,
      y: inFloor ? p.y : null,
      status: connected ? p.status : 'offline',
      status_text: connected ? (p.statusText || '') : '',
      voice: !!(inFloor && p.voiceOn),
      handUp: !!(inFloor && p.handUp),
      floor: p ? p.floor : null,
      isMobile: !!(connected && p.isMobile),
    };
  });
}

function clampForFloor(floor, x, y) {
  const W = floor.world_w || 1344;
  const H = floor.world_h || 768;
  return {
    x: Math.max(20, Math.min(W - 20, parseInt(x) || Math.floor(W / 2))),
    y: Math.max(20, Math.min(H - 20, parseInt(y) || Math.floor(H / 2))),
  };
}

io.on('connection', (socket) => {
  const uid = socket.uid;
  const db = getDb();
  // 同一uid+同一デバイス種別の旧socketを即時切断 (デバイス種別単位の単一セッション維持)
  // sid 比較は必須: 同じJWT (=同一ログインの別タブ/bfcache復元) は自分自身を kick しない。
  // 別JWT (本当の別ログイン) の時だけキックする。2026-05-15 修正の再適用 (2026-05-18)。
  if (socket.dev) {
    try {
      const peers = Array.from(io.sockets.sockets.values());
      for (const p of peers) {
        if (p === socket) continue;
        if (p.uid === uid && p.dev === socket.dev && p.sid && socket.sid && p.sid !== socket.sid) {
          try { p.emit('session:kicked', { reason: 'same_device_login', dev: socket.dev }); } catch (e) {}
          try { p.disconnect(true); } catch (e) {}
          console.log(`[session] kicked old socket uid=${uid} dev=${socket.dev} old_sid=${p.sid} new_sid=${socket.sid}`);
        }
      }
    } catch (e) {}
  }
  const saved = db.prepare('SELECT x, y, floor_code, status_text FROM positions WHERE user_id = ?').get(uid);
  const userInfo = db.prepare('SELECT employee_type FROM users WHERE id = ?').get(uid);
  // 初回ログイン時のデフォルトフロア: 現場社員は乗務員詰所、その他はロビー
  const defaultFloor = (userInfo && userInfo.employee_type === 'field') ? 'field_rest' : 'home';
  const floorCode = (saved && saved.floor_code) || defaultFloor;
  const floor = getFloor(floorCode) || getFloor(defaultFloor) || getFloor('home');
  const pos = clampForFloor(floor, saved && saved.x, saved && saved.y);

  // ナビゲーション再接続検出: 既存presenceあり or 直前まで離脱中だったら「再接続」扱い
  const wasConnected = presence.has(uid);
  const lastOff = lastLogoutAt.get(uid) || 0;
  const isReconnect = wasConnected || (lastOff && (Date.now() - lastOff) < LOGIN_ANNOUNCE_COOLDOWN_MS);
  lastLogoutAt.delete(uid);
  presence.set(uid, { x: pos.x, y: pos.y, status: 'online', statusText: saved ? (saved.status_text || '') : '', floor: floor.code, socketId: socket.id, isMobile: !!socket.isMobile, lastHb: Date.now() });
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(uid);
  db.prepare("INSERT INTO attendance (user_id, floor_code, event_type) VALUES (?, ?, 'login')").run(uid, floor.code);
  socket.join('floor:' + floor.code);
  socket.join('user:' + uid); // ユーザー個別のroomに参加 (既読通知用)

  // 生存ハートビート: engine.ioのpong受信ごとに lastHb を更新 (PCスリープ/タブ凍結で自然に途絶)
  socket.conn.on('heartbeat', () => {
    const pp = presence.get(uid);
    if (!pp) return;
    pp.lastHb = Date.now();
    // スリープ復帰など: 自動退席/オフラインだったら自動でオンラインに戻す (手動ステータスは維持)
    if (pp.status === 'offline' || (pp.autoAway && pp.status === '退席中')) {
      pp.status = 'online';
      pp.autoAway = false;
      pp.disconnectedAt = null;
      io.to('floor:' + pp.floor).emit('user:update', { uid, x: pp.x, y: pp.y, status: 'online' });
      io.emit('user:floor', { uid, floor: pp.floor });
      io.emit('floor:counts', floorCountMap());
    }
  });

  // 初期スナップショット
  const sendSnapshot = () => {
    socket.emit('snapshot', {
      users: floorUserList(floor.code),
      me: uid,
      proximity: PROXIMITY_RADIUS,
      floor,
      floors: allFloors(),
      floor_counts: floorCountMap(),
      huddle_zones: HUDDLE_ZONES[floor.code] || [],
    });
  };
  sendSnapshot();

  // 新規接続者のフル情報を同フロア既存接続者に通知
  const fullUser = floorUserList(floor.code).find(u => u.uid === uid);
  if (fullUser) socket.to('floor:' + floor.code).emit('user:join', fullUser);
  else socket.to('floor:' + floor.code).emit('user:update', { uid, x: pos.x, y: pos.y, status: 'online' });

  // 全体のフロア在席数更新を配信
  io.emit('floor:counts', floorCountMap());
  // 全クライアントに「このユーザーがこのフロアにオンライン」を通知
  io.emit('user:floor', { uid, floor: floor.code });
  // ログインアナウンス (真の新規ログインのみ; ページ遷移再接続は抑止)
  const loginName = (fullUser && fullUser.name) || '';
  if (!isReconnect) {
    socket.broadcast.emit('user:login', { uid, name: loginName });
    console.log('[cohub] emit user:login', uid, loginName);
  } else {
    console.log('[cohub] skip user:login (reconnect/navigation)', uid, loginName);
  }

  // ロビー着地: 当日初回なら総合案内がカレンダー予定+CoWellイベント案内をDM
  if (floor.code === 'lobby') {
    setTimeout(() => maybeSendCalendarGreeting(uid), 1500);
    setTimeout(() => maybeSendWellnessAnnouncement(uid), 3000);
  }

  // フロア切替
  socket.on('floor:switch', (data) => {
    const targetCode = (data && data.code || '').toString();
    const target = getFloor(targetCode);
    if (!target) return;
    const p = presence.get(uid);
    if (!p) return;
    if (p.floor === target.code) return;
    // 棟アクセス判定: 自分の所属棟と違う場合、承認制扱い (admin/lobbyは免除)
    if (socket.role !== 'admin' && target.code !== 'lobby') {
      const me = getUserEmployeeType(uid);
      // office社員 → field棟 進入不可 (要承認)
      // field社員 → office棟 進入不可 (要承認)
      const mismatch = (me.employee_type === 'office' && target.building === 'field')
                    || (me.employee_type === 'field' && target.building === 'office');
      if (mismatch && !data.approved) {
        // 室内に人が居なければ素通り (最初の1人は許容)
        let hasOccupant = false;
        for (const [, vv] of presence) {
          if (vv.floor === target.code && vv.status !== 'offline') { hasOccupant = true; break; }
        }
        if (hasOccupant) {
          const u = getDb().prepare('SELECT display_name, avatar_url FROM users WHERE id = ?').get(uid);
          const payload = { uid, name: (u && u.display_name) || '', avatar: (u && u.avatar_url) || '', targetFloor: target.code, reason: '棟外からの入室' };
          io.to('floor:' + target.code).emit('room:knock', payload);
          socket.emit('room:waiting', { code: target.code, name: target.name });
          let map = pendingKnocks.get(target.code);
          if (!map) { map = new Map(); pendingKnocks.set(target.code, map); }
          if (map.has(uid)) clearTimeout(map.get(uid).timer);
          const timer = setTimeout(() => {
            const m = pendingKnocks.get(target.code);
            if (m && m.has(uid)) {
              m.delete(uid);
              const tgt = presence.get(uid) && io.sockets.sockets.get(presence.get(uid).socketId);
              if (tgt) tgt.emit('room:knock-result', { ok: false, msg: 'タイムアウト' });
            }
          }, 60000);
          map.set(uid, { timer, targetFloor: target.code, socketId: socket.id });
          return;
        }
      }
    }
    // ロック中ならPWチェック (役員/一般社員/admin問わず全員対象)
    if (target.locked && target.lock_pw_hash) {
      const pw = (data.password || '').toString();
      if (!pw || !bcrypt.compareSync(pw, target.lock_pw_hash)) {
        socket.emit('floor:locked', { code: target.code, name: target.name });
        return;
      }
    }
    // 承認制ON中なら即入室せずノック (admin は免除、事前承認済フラグ付きは通過)
    if (target.approval_mode && socket.role !== 'admin' && !data.approved) {
      // 既にその部屋にいる人が誰もいなければ素通り
      let hasOccupant = false;
      for (const [, vv] of presence) {
        if (vv.floor === target.code && vv.status !== 'offline') { hasOccupant = true; break; }
      }
      if (hasOccupant) {
        const u = getDb().prepare('SELECT display_name, avatar_url FROM users WHERE id = ?').get(uid);
        const payload = { uid, name: (u && u.display_name) || '', avatar: (u && u.avatar_url) || '', targetFloor: target.code };
        io.to('floor:' + target.code).emit('room:knock', payload);
        socket.emit('room:waiting', { code: target.code, name: target.name });
        // 60秒タイムアウト
        let map = pendingKnocks.get(target.code);
        if (!map) { map = new Map(); pendingKnocks.set(target.code, map); }
        if (map.has(uid)) clearTimeout(map.get(uid).timer);
        const timer = setTimeout(() => {
          const m = pendingKnocks.get(target.code);
          if (m && m.has(uid)) {
            m.delete(uid);
            const tgtSocket = (presence.get(uid) && io.sockets.sockets.get(presence.get(uid).socketId));
            if (tgtSocket) tgtSocket.emit('room:knock-result', { ok: false, msg: 'タイムアウト' });
          }
        }, 60000);
        map.set(uid, { timer, targetFloor: target.code, socketId: socket.id });
        return;
      }
    }
    const oldFloor = p.floor;
    // 音声参加中なら旧フロアから脱退扱い (クライアントはフロア切替時にdisableVoiceする)
    if (p.voiceOn) {
      p.voiceOn = false;
      io.to('floor:' + oldFloor).emit('voice:state', { uid, on: false });
    }
    if (p.handUp) {
      p.handUp = false;
      io.to('floor:' + oldFloor).emit('hand', { uid, up: false });
    }
    // 出席履歴
    db.prepare("INSERT INTO attendance (user_id, floor_code, event_type) VALUES (?, ?, 'leave')").run(uid, oldFloor);
    db.prepare("INSERT INTO attendance (user_id, floor_code, event_type) VALUES (?, ?, 'enter')").run(uid, target.code);
    // 旧フロアから leave、旧メンバーに「退室」を通知
    socket.leave('floor:' + oldFloor);
    io.to('floor:' + oldFloor).emit('user:leave', { uid });
    // 新フロア: 入口位置に配置
    p.floor = target.code;
    const entry = entryPoint(target);
    const np = clampForFloor(target, entry.x, entry.y);
    p.x = np.x; p.y = np.y;
    db.prepare(`INSERT INTO positions (user_id, x, y, floor_code) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET x=excluded.x, y=excluded.y, floor_code=excluded.floor_code, updated_at=datetime('now')`).run(uid, p.x, p.y, target.code);
    socket.join('floor:' + target.code);
    // 新フロアの既存メンバーに自分の join 通知
    const fu = floorUserList(target.code).find(u => u.uid === uid);
    if (fu) socket.to('floor:' + target.code).emit('user:join', fu);
    // 自分にはフル再snapshot
    socket.emit('snapshot', {
      users: floorUserList(target.code),
      me: uid,
      proximity: PROXIMITY_RADIUS,
      floor: target,
      floors: allFloors(),
      floor_counts: floorCountMap(),
      huddle_zones: HUDDLE_ZONES[target.code] || [],
    });
    io.emit('floor:counts', floorCountMap());
    io.emit('user:floor', { uid, floor: target.code });
    // ロビーへ移動: 当日初回なら総合案内がカレンダー予定+CoWellイベント案内をDM
    if (target.code === 'lobby') {
      setTimeout(() => maybeSendCalendarGreeting(uid), 1500);
      setTimeout(() => maybeSendWellnessAnnouncement(uid), 3000);
    }
  });

  // 事故対策室: スクリーン操作・ナレーションを同フロア全員に同期
  socket.on('accident:control', (action) => {
    const p = presence.get(uid);
    if (!p || p.floor !== 'field_accident') {
      console.log('[accident:control] reject (not in field_accident):', uid, 'floor=', p ? p.floor : 'none');
      return;
    }
    if (!action || typeof action !== 'object') return;
    const safe = { type: String(action.type || '').slice(0, 32) };
    if (action.dir != null) safe.dir = parseInt(action.dir);
    if (action.fileIdx != null) safe.fileIdx = parseInt(action.fileIdx);
    if (action.sourceId != null) safe.sourceId = String(action.sourceId).slice(0, 80);
    if (action.slotIdx != null) safe.slotIdx = parseInt(action.slotIdx);
    if (action.text != null) safe.text = String(action.text).slice(0, 2500);
    if (action.speedFactor != null) safe.speedFactor = parseFloat(action.speedFactor);
    safe.by = uid;
    // 同フロア他全員へ
    const room = io.sockets.adapter.rooms.get('floor:field_accident');
    const roomSize = room ? room.size : 0;
    console.log('[accident:control] from=', uid, 'type=', safe.type, 'roomSize=', roomSize);
    socket.to('floor:field_accident').emit('accident:control', safe);
  });

  // 移動
  socket.on('move', (data) => {
    const p = presence.get(uid);
    if (!p) return;
    const f = getFloor(p.floor) || floor;
    const np = clampForFloor(f, data.x, data.y);
    const oldGroup = p.voiceOn ? getVoiceGroup(p) : null;
    p.x = np.x; p.y = np.y;
    db.prepare(`INSERT INTO positions (user_id, x, y, floor_code) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET x=excluded.x, y=excluded.y, floor_code=excluded.floor_code, updated_at=datetime('now')`).run(uid, p.x, p.y, p.floor);
    io.to('floor:' + p.floor).emit('user:update', { uid, x: p.x, y: p.y, status: p.status });
    // ハドルゾーン跨ぎ判定 (音声ON時のみ)
    if (p.voiceOn) {
      const newGroup = getVoiceGroup(p);
      if (oldGroup !== newGroup) {
        // 旧グループの音声参加者にピア切断指示 (mic状態は変えない)
        for (const [u, v] of presence) {
          if (u === uid) continue;
          if (v.floor !== p.floor || !v.voiceOn) continue;
          if (getVoiceGroup(v) === oldGroup) {
            const s = io.sockets.sockets.get(v.socketId);
            if (s) s.emit('voice:peer-drop', { uid });
          }
        }
        // 本人にピア再構築指示 (新グループのpeer一覧)
        const peers = [];
        for (const [u, v] of presence) {
          if (u === uid) continue;
          if (v.voiceOn && v.floor === p.floor && v.status !== 'offline' && getVoiceGroup(v) === newGroup) peers.push(u);
        }
        socket.emit('voice:regroup', { peers, group: newGroup });
      }
    }
  });

  // ステータス + 自由文
  socket.on('status', (data) => {
    const s = ['online', '退席中', '会議中', '集中中'].includes(data.status) ? data.status : 'online';
    const text = (data && typeof data.text === 'string') ? data.text.slice(0, 50) : undefined;
    const p = presence.get(uid); if (!p) return;
    p.status = s;
    p.autoAway = false;  // 手動設定したらスイープの自動退席扱いを解除
    p.idleAway = false;  // 無操作自動退席も解除
    if (text !== undefined) p.statusText = text;
    db.prepare(`UPDATE positions SET status=?, status_text=?, updated_at=datetime('now') WHERE user_id=?`).run(s, p.statusText || '', uid);
    io.to('floor:' + p.floor).emit('user:update', { uid, x: p.x, y: p.y, status: s, status_text: p.statusText || '' });
  });

  // 無操作による自動退席 (クライアントのidle検知。端末は接続中だが本人が席を外したケース)
  // ※ pong は流れ続けるので heartbeat 復帰では戻さない。実際の操作(presence:active)でのみ復帰
  socket.on('presence:idle', () => {
    const p = presence.get(uid);
    if (!p || p.status !== 'online') return; // 手動ステータス(会議中/集中中/退席中)は尊重
    p.status = '退席中';
    p.idleAway = true;
    io.to('floor:' + p.floor).emit('user:update', { uid, x: p.x, y: p.y, status: '退席中' });
  });
  socket.on('presence:active', () => {
    const p = presence.get(uid);
    if (!p) return;
    if (p.idleAway && p.status === '退席中') {
      p.status = 'online';
      p.idleAway = false;
      io.to('floor:' + p.floor).emit('user:update', { uid, x: p.x, y: p.y, status: 'online' });
    }
  });

  // 👋 肩たたき: 同フロア+440px以内の相手に通知 (PWA Push連動、30秒レート制限)
  socket.on('tap-shoulder', (data) => {
    const targetUid = (data && data.targetUid || '').toString();
    if (!targetUid || targetUid === uid) return;
    const sender = presence.get(uid);
    const target = presence.get(targetUid);
    if (!sender || !target) return;
    if (sender.floor !== target.floor) return;
    if (!target.isBot) {
      const dx = sender.x - target.x, dy = sender.y - target.y;
      if (Math.sqrt(dx * dx + dy * dy) > 440) return;
      // 個人ブロック判定 (相手が自分をブロックしてたら届けない、無音で握りつぶし)
      if (isBlocked(targetUid, uid)) return;
    }
    const key = uid + ':' + targetUid;
    const now = Date.now();
    if ((tapTimestamps.get(key) || 0) > now - 30000) return;
    tapTimestamps.set(key, now);
    const senderName = (getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(uid) || {}).display_name || '';
    // bot宛: チャット吹き出しは出さず、TTSで挨拶 → クライアントで再生
    // tap:sent に botGreeting を載せる。クライアントが bot uid に応じた声で speakViaTTS する
    if (target.isBot) {
      const greeting = senderName + 'さん、お疲れ様です。';
      socket.emit('tap:sent', { targetUid, botGreeting: greeting });
      return;
    }
    const tgtSocket = io.sockets.sockets.get(target.socketId);
    if (tgtSocket) tgtSocket.emit('tap:received', { fromUid: uid, fromName: senderName, at: new Date().toISOString() });
    sendPushToUser(targetUid, {
      title: '👋 ' + senderName,
      body: '近くで声をかけたいようです',
      tag: 'tap-' + uid,
      mention: true,
      url: '/',
    }).catch(() => {});
    socket.emit('tap:sent', { targetUid });
  });

  // 挙手
  socket.on('hand', (data) => {
    const up = !!(data && data.up);
    const p = presence.get(uid); if (!p) return;
    p.handUp = up;
    io.to('floor:' + p.floor).emit('hand', { uid, up });
  });

  // フロアチャット（同フロアのみ配信。ログは60日保存、管理者閲覧可）
  socket.on('chat', (data) => {
    const content = (data.content || '').toString().trim().slice(0, 500);
    if (!content) return;
    const sender = presence.get(uid);
    if (!sender) return;
    const mentions = Array.isArray(data.mentions)
      ? data.mentions.filter(x => typeof x === 'string').slice(0, 50)
      : [];

    const hasMention = mentions.length > 0 ? 1 : 0;
    const a = data && data.attach && data.attach.url ? data.attach : null;
    const attachUrl = a ? String(a.url).slice(0, 500) : null;
    const attachName = a ? String(a.name || '').slice(0, 200) : null;
    const attachSize = a ? (parseInt(a.size) || 0) : null;
    const attachType = a ? String(a.type || '').slice(0, 80) : null;
    const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code, has_mention, attach_url, attach_name, attach_size, attach_type) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)")
      .run(uid, content, sender.floor, hasMention, attachUrl, attachName, attachSize, attachType);

    const payload = {
      id: ins.lastInsertRowid,
      uid, content,
      x: sender.x, y: sender.y,
      at: new Date().toISOString(),
      mentions,
      room: sender.floor,
      attach: attachUrl ? { url: attachUrl, name: attachName, size: attachSize, type: attachType } : null,
    };
    io.to('floor:' + sender.floor).emit('chat:msg', payload);
    // メンション対象には Push (タブ閉じてても届く)
    if (mentions.length) {
      const senderName = (getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(uid) || {}).display_name || '';
      for (const targetUid of mentions) {
        if (targetUid === uid) continue;
        sendPushToUser(targetUid, {
          title: '[メンション] ' + senderName,
          body: content.slice(0, 120),
          tag: 'mention-' + uid,
          mention: true,
          url: '/',
        }).catch(() => {});
      }
    }
  });

  // ささやき: 接触している相手にだけ本文配信。それ以外の同フロア在席者には💭インジケーターのみ
  // DB保存なし、自分のログにも残らない (完全揮発)
  socket.on('chat:whisper', async (data) => {
    const content = (data && data.content || '').toString().trim().slice(0, 500);
    if (!content) return;
    const sender = presence.get(uid);
    if (!sender) return;
    // 同フロアの在席者から接触距離以内の相手を抽出 (= ささやき参加者) — bot も含む
    const peers = [];
    const botPeers = [];
    for (const [u, v] of presence) {
      if (u === uid) continue;
      if (v.floor !== sender.floor) continue;
      if (v.status === 'offline') continue;
      const dx = sender.x - v.x, dy = sender.y - v.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= WHISPER_TOUCH_DISTANCE) {
        peers.push(u);
        if (v.isBot) botPeers.push(u);
      }
    }
    if (!peers.length) return;  // 誰も接触していない時はそもそも送らせない (UI側でも抑止)
    const at = new Date().toISOString();
    // 参加者(送信者+接触相手)に本文配信
    const msgPayload = { uid, content, x: sender.x, y: sender.y, at };
    socket.emit('chat:whisper-msg', msgPayload);  // 自分も自分の発言を見る
    for (const peerUid of peers) {
      const tp = presence.get(peerUid);
      if (!tp) continue;
      if (tp.isBot) continue;  // bot は socket がないのでスキップ (後で AI応答を別途生成)
      const s = io.sockets.sockets.get(tp.socketId);
      if (s) s.emit('chat:whisper-msg', msgPayload);
    }
    // それ以外の同フロア在席者には💭インジケーターだけ送る (本人2人がささやき中だと分かる)
    const indicatorPayload = { uid, peers, at };
    for (const [u, v] of presence) {
      if (u === uid) continue;
      if (v.floor !== sender.floor) continue;
      if (v.status === 'offline') continue;
      if (peers.includes(u)) continue;
      if (v.isBot) continue;  // bot にはインジケーターを送らない
      const s = io.sockets.sockets.get(v.socketId);
      if (s) s.emit('chat:whisper-indicator', indicatorPayload);
    }
    // ===== bot ささやき応答 (テスト用にも便利) =====
    // 接触相手に bot がいたら AI 応答を whisper-msg として全参加者+周囲💭に流す
    for (const botId of botPeers) {
      const bot = presence.get(botId);
      if (!bot) continue;
      try {
        const senderName = (getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(uid) || {}).display_name || 'あなた';
        // ささやきトーン: 短く・小声で・絵文字控えめ
        const promptMsg = '【ささやき会話・90文字以内・絵文字控えめ・敬語で短く】 ' + senderName + 'さんから: ' + content;
        const reply = await chatBot(botId, promptMsg, []);
        const replyText = String(reply || '').slice(0, 200).trim();
        if (!replyText) continue;
        const replyAt = new Date().toISOString();
        const replyPayload = { uid: botId, content: replyText, x: bot.x, y: bot.y, at: replyAt };
        // 参加者全員 (送信者+他のpeer) に応答配信
        socket.emit('chat:whisper-msg', replyPayload);
        for (const peerUid of peers) {
          if (peerUid === botId) continue;
          const tp = presence.get(peerUid);
          if (!tp || tp.isBot) continue;
          const s = io.sockets.sockets.get(tp.socketId);
          if (s) s.emit('chat:whisper-msg', replyPayload);
        }
        // 周囲には bot の💭も追加 (応答してることが伝わる)
        const replyIndicator = { uid: botId, peers: [uid, ...peers.filter(p => p !== botId)], at: replyAt };
        for (const [u, v] of presence) {
          if (u === uid) continue;
          if (v.floor !== sender.floor) continue;
          if (v.status === 'offline') continue;
          if (peers.includes(u)) continue;
          if (v.isBot) continue;
          const s = io.sockets.sockets.get(v.socketId);
          if (s) s.emit('chat:whisper-indicator', replyIndicator);
        }
      } catch (e) {
        console.warn('[whisper bot reply fail]', botId, e.message);
      }
    }
  });

  // グループチャット
  socket.on('chat:group', (data) => {
    const gid = (data && data.group_id || '').toString();
    const content = (data && data.content || '').toString().trim().slice(0, 2000);
    if (!gid || (!content && !(data && data.attach))) return;
    // メンバー確認 (管理者は全GCに送信可)
    const isMember = getDb().prepare('SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?').get(gid, uid);
    if (!isMember) {
      const u = getDb().prepare('SELECT role, employee_type FROM users WHERE id=?').get(uid);
      const isAdmin = !!(u && u.role === 'admin' && u.employee_type === 'admin');
      if (!isAdmin) return;
    }
    const a = data && data.attach && data.attach.url ? data.attach : null;
    const attachUrl = a ? String(a.url).slice(0, 500) : null;
    const attachName = a ? String(a.name || '').slice(0, 200) : null;
    const attachSize = a ? (parseInt(a.size) || 0) : null;
    const attachType = a ? String(a.type || '').slice(0, 80) : null;
    const roomCode = 'grp_' + gid;
    // 重複送信ガード: 直近3秒に同じ (sender, room_code, content) があればスキップ
    const dupRow = db.prepare("SELECT id FROM messages WHERE sender_id=? AND room_code=? AND content=? AND created_at > datetime('now','-3 seconds') ORDER BY id DESC LIMIT 1").get(uid, roomCode, content);
    if (dupRow) {
      console.log('[group dedup] skip duplicate uid=', uid, 'gid=', gid, 'prev_id=', dupRow.id);
      return;
    }
    const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code, attach_url, attach_name, attach_size, attach_type) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)")
      .run(uid, content, roomCode, attachUrl, attachName, attachSize, attachType);
    const senderRow = getDb().prepare(`SELECT u.display_name, u.avatar_url, u.company_code, c.ring_color
      FROM users u LEFT JOIN companies c ON c.code = u.company_code WHERE u.id = ?`).get(uid) || {};
    const payload = {
      id: ins.lastInsertRowid,
      from: uid,
      group_id: gid,
      content,
      at: new Date().toISOString(),
      attach: attachUrl ? { url: attachUrl, name: attachName, size: attachSize, type: attachType } : null,
      sender_name: senderRow.display_name || '',
      sender_avatar: senderRow.avatar_url || '',
      sender_company: senderRow.company_code || '',
      sender_ring: senderRow.ring_color || '',
    };
    // 送信者本人にACK echo (非メンバーadmin送信でも「送信中」を解除するため) — 5/20
    socket.emit('group:msg', payload);
    // メンバー全員に配信 (オンラインは即、オフラインはPush) — 送信者は上で echo 済みなのでスキップ
    const members = getDb().prepare('SELECT user_id FROM chat_group_members WHERE group_id=?').all(gid);
    const senderName = (getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(uid) || {}).display_name || '';
    const groupName = (getDb().prepare('SELECT name FROM chat_groups WHERE id = ?').get(gid) || {}).name || 'グループ';
    for (const m of members) {
      if (m.user_id === uid) continue;
      const tp = presence.get(m.user_id);
      if (tp) {
        const s = io.sockets.sockets.get(tp.socketId);
        if (s) s.emit('group:msg', payload);
      }
      sendPushToUser(m.user_id, {
        title: '[' + groupName + '] ' + senderName,
        body: (content || '').slice(0, 120) || '📎 添付ファイル',
        tag: 'grp-' + gid,
        url: '/?g=' + gid,
      }).catch(() => {});
    }
    // 安全フィルタ: 警告を無視して送信された場合に静かに監査ログのみ記録 (Push通知なし)
    if (content) {
      try {
        const safetyHit = safety.checkForHumanChat(content);
        if (safetyHit) {
          db.prepare(`INSERT INTO inappropriate_logs (user_id, bot_id, content, detection_layer, category, matched_pattern, severity)
            VALUES (?, ?, ?, 'L1_human_chat', ?, ?, ?)`)
            .run(uid, 'grp_' + gid, content, safetyHit.category, safetyHit.matched, safetyHit.severity);
          console.warn(`[safety human-chat] uid=${uid} gid=${gid} category=${safetyHit.category}`);
        }
      } catch (e) { console.error('[safety log group]', e.message); }
    }
  });

  // 入力中インジケーター (chat-simple.htmlの「○○さんが入力中...」)
  // 永続化なし、対象者にだけ即時転送。user:<uid> roomを使って全タブに届ける
  socket.on('chat:typing', (data) => {
    if (!data) return;
    const isTyping = !!data.typing;
    if (data.peer_id) {
      // DM: 対象ユーザーの全接続ソケットへ
      io.to('user:' + data.peer_id).emit('chat:typing', { from: uid, peer_id: uid, typing: isTyping });
    } else if (data.group_id) {
      // グループ: メンバー全員 (送信者除く) のuser roomへ
      const members = getDb().prepare('SELECT user_id FROM chat_group_members WHERE group_id = ?').all(data.group_id);
      for (const m of members) {
        if (m.user_id === uid) continue;
        io.to('user:' + m.user_id).emit('chat:typing', { from: uid, group_id: data.group_id, typing: isTyping });
      }
    }
  });

  // 呼出 (DMの相手にチャイムを鳴らして気づかせる。メッセージは保存しない軽量ping)
  socket.on('dm:call', (data) => {
    const to = (data && data.to || '').toString();
    if (!to || to === uid) return;
    const target = getDb().prepare('SELECT id, role, dm_group, dm_rank, dm_restricted, job_role, is_field_promoter, is_warehouse_promoter FROM users WHERE id = ?').get(to);
    if (!target || target.role === 'bot') return;
    // DM権限・ブロック判定 (DM送信と同じルール)
    const sender = loadUserForDm(uid);
    if (!canDm(sender, target)) { socket.emit('dm:call-sent', { to, ok: false, reason: 'hierarchy' }); return; }
    if (isBlocked(to, uid) || isBlocked(uid, to)) { socket.emit('dm:call-sent', { to, ok: false, reason: 'blocked' }); return; }
    // レート制限: 同じ相手へは20秒に1回まで
    const key = uid + ':' + to;
    const now = Date.now();
    if ((callTimestamps.get(key) || 0) > now - 20000) { socket.emit('dm:call-sent', { to, ok: false, reason: 'cooldown' }); return; }
    callTimestamps.set(key, now);
    const senderName = (getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(uid) || {}).display_name || '';
    // オンラインなら全タブ(PC/モバイル)へ即時チャイム配信
    const tp = presence.get(to);
    let online = false;
    if (tp && !tp.isBot) {
      io.to('user:' + to).emit('dm:call', { from: uid, fromName: senderName, at: new Date().toISOString() });
      online = true;
    }
    // OS通知を必ず出す: alwaysShow=true でSWの「タブが開いてたら出さない」抑制を回避。
    // 呼出は明示的な緊急ページなので、相手がチャット以外のページを開いていても確実に通知。
    const pushSubs = getDb().prepare('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id = ?').get(to);
    sendPushToUser(to, {
      title: '🔔 ' + (senderName || '呼び出し') + 'さんが呼び出しています',
      body: 'タップしてチャットを開く',
      tag: 'dm-call-' + uid,
      mention: true,
      requireInteraction: true,
      alwaysShow: true,
      vibrate: [300, 120, 300, 120, 500],
      url: '/chat',
    }).catch(() => {});
    console.log('[dm:call] from=' + uid + '(' + senderName + ') to=' + to + ' online=' + online + ' pushSubs=' + ((pushSubs && pushSubs.c) || 0));
    socket.emit('dm:call-sent', { to, ok: true, online });
  });

  // DM (1対1ダイレクトメッセージ、添付対応)
  socket.on('chat:dm', (data) => {
    const to = (data && data.to || '').toString();
    const content = (data && data.content || '').toString().trim().slice(0, 1000);
    if (!to || (!content && !(data && data.attach)) || to === uid) return;
    const target = getDb().prepare('SELECT id, role, dm_group, dm_rank, dm_restricted, job_role, is_field_promoter, is_warehouse_promoter FROM users WHERE id = ?').get(to);
    if (!target) return;
    // DM権限判定 (レポートライン保護)
    const sender = loadUserForDm(uid);
    if (!canDm(sender, target)) {
      socket.emit('dm:blocked', { to, reason: 'hierarchy', msg: 'この相手にはDMできません。上司経由でご連絡ください。' });
      return;
    }
    // 個人ブロック判定: 受信者が送信者をブロックしている場合は配信せず通知
    if (isBlocked(to, uid)) {
      socket.emit('dm:blocked', { to, reason: 'blocked', msg: 'メッセージは届きませんでした (相手の設定による)' });
      return;
    }
    // 自分が相手をブロックしている場合は送信前に注意 (誤送信防止)
    if (isBlocked(uid, to)) {
      socket.emit('dm:blocked', { to, reason: 'self_blocked', msg: 'この相手をブロック中です。設定から解除してから送信してください' });
      return;
    }
    const a = data && data.attach && data.attach.url ? data.attach : null;
    const attachUrl = a ? String(a.url).slice(0, 500) : null;
    const attachName = a ? String(a.name || '').slice(0, 200) : null;
    const attachSize = a ? (parseInt(a.size) || 0) : null;
    const attachType = a ? String(a.type || '').slice(0, 80) : null;
    // 音声モード: 相手が取込中でも読み上げでメッセージを伝える (急ぎ連絡用)
    const voiceMode = !!(data && data.voice) && !!content;
    // 重複送信ガード: 直近3秒に同じ (sender, receiver, content) があれば再送扱いとしてINSERTスキップ
    // 原因: ダブルクリック / Enter+click / socket reconnect 時のリトライ
    const dupRow = db.prepare("SELECT id, created_at, attach_url, attach_name, attach_size, attach_type FROM messages WHERE sender_id=? AND receiver_id=? AND content=? AND room_code='dm' AND created_at > datetime('now','-3 seconds') ORDER BY id DESC LIMIT 1").get(uid, to, content);
    if (dupRow) {
      console.log('[dm dedup] skip duplicate uid=', uid, 'to=', to, 'prev_id=', dupRow.id);
      // 念のため送信者にだけ既存IDの dm:msg を返す (クライアント側の pending 解決用)
      socket.emit('dm:msg', { id: dupRow.id, from: uid, to, content, at: dupRow.created_at, attach: dupRow.attach_url ? { url: dupRow.attach_url, name: dupRow.attach_name, size: dupRow.attach_size, type: dupRow.attach_type } : null, dedup: true });
      return;
    }
    const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code, attach_url, attach_name, attach_size, attach_type) VALUES (?, ?, ?, 'dm', ?, ?, ?, ?)")
      .run(uid, to, content, attachUrl, attachName, attachSize, attachType);
    const payload = {
      id: ins.lastInsertRowid,
      from: uid,
      to,
      content,
      at: new Date().toISOString(),
      attach: attachUrl ? { url: attachUrl, name: attachName, size: attachSize, type: attachType } : null,
      voice: voiceMode,
    };
    socket.emit('dm:msg', payload);
    const tp = presence.get(to);
    if (tp && !tp.isBot) {
      const s = io.sockets.sockets.get(tp.socketId);
      if (s) s.emit('dm:msg', payload);
    }
    // 安全フィルタ: 人間宛DMで警告を押し切って送信された場合に静かに監査ログを記録 (Push通知なし)
    if (content && target.role !== 'bot') {
      try {
        const safetyHit = safety.checkForHumanChat(content);
        if (safetyHit) {
          db.prepare(`INSERT INTO inappropriate_logs (user_id, bot_id, content, detection_layer, category, matched_pattern, severity)
            VALUES (?, ?, ?, 'L1_human_chat', ?, ?, ?)`)
            .run(uid, to, content, safetyHit.category, safetyHit.matched, safetyHit.severity);
          console.warn(`[safety human-chat] uid=${uid} to=${to} category=${safetyHit.category}`);
        }
      } catch (e) { console.error('[safety log dm]', e.message); }
    }
    // bot宛ならGeminiに転送して返答を生成
    if (tp && tp.isBot && content) {
      // L1: 入力スクリーニング (Geminiに渡す前にキーワードでブロック)
      const safetyHit = safety.checkInappropriate(content);
      if (safetyHit) {
        console.warn(`[safety L1] uid=${uid} bot=${to} category=${safetyHit.category} matched=${safetyHit.matched}`);
        const refusalText = safety.refusalResponse(safetyHit.category);
        // 拒否応答を bot からのDMとして送信
        const ins2 = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')")
          .run(to, uid, refusalText);
        socket.emit('dm:msg', {
          id: ins2.lastInsertRowid, from: to, to: uid, content: refusalText,
          at: new Date().toISOString(), attach: null, voice: voiceMode,
        });
        // 不適切ログ記録
        try {
          db.prepare(`INSERT INTO inappropriate_logs (user_id, bot_id, content, detection_layer, category, matched_pattern, severity)
            VALUES (?, ?, ?, 'L1_keyword', ?, ?, ?)`)
            .run(uid, to, content.slice(0, 1000), safetyHit.category, safetyHit.matched, safetyHit.severity);
        } catch (e) { console.warn('[safety log fail]', e.message); }
        // 管理者+推進メンバーへ通報 (mental_crisis は除外: 本人を晒さない、専門窓口対応で十分)
        if (safetyHit.category !== 'mental_crisis') {
          notifyInappropriateDetection(uid, to, content, safetyHit);
        }
        return;
      }
      (async () => {
        try {
          // 直近10件の履歴 (本人↔bot)
          const histRows = getDb().prepare(`
            SELECT sender_id, content, created_at FROM messages
            WHERE room_code='dm'
              AND ((sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?))
              AND content IS NOT NULL AND content <> ''
            ORDER BY created_at DESC LIMIT 11
          `).all(uid, to, to, uid);
          const history = histRows.reverse().slice(0, -1).map(r => ({
            role: r.sender_id === to ? 'bot' : 'user',
            text: r.content,
          }));
          // カレンダーキーワード検知 → 連携済なら予定を注入
          let userMessage = content;
          if (/予定|スケジュール|カレンダー|アジェンダ|今日|明日|明後日|今週|来週|会議|ミーティング|打ち合わせ|午前|午後/.test(content)) {
            const u = db.prepare('SELECT google_cal_id FROM users WHERE id = ?').get(uid);
            if (u && u.google_cal_id) {
              try {
                const events = await gcal.fetchEvents(u.google_cal_id, 7, 20);
                const pad = n => String(n).padStart(2, '0');
                const dayJa = ['日','月','火','水','木','金','土'];
                const lines = events.map(ev => {
                  const s = new Date(ev.start);
                  const d = `${s.getMonth()+1}/${s.getDate()}(${dayJa[s.getDay()]})`;
                  const t = ev.allDay ? '終日' : `${pad(s.getHours())}:${pad(s.getMinutes())}`;
                  return `${d} ${t} ${ev.summary}${ev.location ? ' @' + ev.location : ''}`;
                }).join('\n');
                const evBlock = lines || '(直近1週間に予定はありません)';
                userMessage = `[社員のGoogleカレンダー予定 (今日〜7日分)]\n${evBlock}\n\n[社員からの質問]\n${content}`;
              } catch (e) {
                userMessage = `[社員のGoogleカレンダー取得に失敗: ${(e.message||'').slice(0,60)}]\n\n[社員からの質問]\n${content}`;
              }
            } else {
              userMessage = `[この社員はGoogleカレンダー未連携です]\n\n[社員からの質問]\n${content}`;
            }
          }
          // bot_health 向けはユーザー健康データを context として先頭に注入 (パーソナライズ)
          if (to === 'bot_health') {
            try {
              const sinceMonth = new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10);
              // 血圧 (直近30日 + 90日平均)
              const bp30 = db.prepare(`SELECT AVG(systolic) AS sys, AVG(diastolic) AS dia, AVG(pulse) AS pulse, COUNT(*) AS n
                FROM bp_records WHERE user_id = ? AND measured_at >= datetime('now','-30 days')`).get(uid);
              const bp90 = db.prepare(`SELECT AVG(systolic) AS sys, AVG(diastolic) AS dia, COUNT(*) AS n
                FROM bp_records WHERE user_id = ? AND measured_at >= ?`).get(uid, sinceMonth);
              // 健康メモ (直近5件)
              const notes = db.prepare(`SELECT note, tag, created_at FROM health_notes
                WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 5`).all(uid);
              // 健診ファイル (年度別)
              const checkups = db.prepare(`SELECT year, file_name, uploaded_at FROM health_checkups
                WHERE user_id = ? AND deleted_at IS NULL ORDER BY year DESC LIMIT 3`).all(uid);
              // ひろば食事投稿の栄養スコア平均 (直近30日)
              const nut = db.prepare(`SELECT nutrition_scores FROM plaza_posts
                WHERE author_id = ? AND deleted_at IS NULL AND nutrition_scores IS NOT NULL
                  AND created_at >= datetime('now','-30 days') ORDER BY id DESC LIMIT 30`).all(uid);
              // 歩数 (CoWell archive、直近30日平均)
              const cwUid = (db.prepare("SELECT cw_id FROM cw_users WHERE cohub_uid = ?").get(uid) || {}).cw_id;
              let stepStats = null;
              if (cwUid) {
                stepStats = db.prepare(`SELECT AVG(steps) AS avg_steps, COUNT(*) AS days
                  FROM cw_step_log WHERE cw_user_id = ? AND step_date >= date('now','-30 days')`).get(cwUid);
              }
              const lines = ['[参考: 社員の健康データ — 質問内容に直接関係する場合のみ言及。無関係な質問では触れない]'];
              if (bp30 && bp30.n > 0) {
                lines.push(`・血圧30日: 収縮期${Math.round(bp30.sys)}/拡張期${Math.round(bp30.dia)}mmHg, 脈拍${Math.round(bp30.pulse||0)}, 計測${bp30.n}回`);
              } else {
                lines.push('・血圧: 直近30日の記録なし');
              }
              if (bp90 && bp90.n > bp30.n) {
                lines.push(`・血圧90日: 収縮期${Math.round(bp90.sys)}/拡張期${Math.round(bp90.dia)}mmHg, 計測${bp90.n}回`);
              }
              if (notes.length) {
                lines.push('・健康メモ直近: ' + notes.map(n => `「${(n.note||'').slice(0,40)}」`).join(', '));
              }
              if (checkups.length) {
                lines.push('・健診ファイル: ' + checkups.map(c => `${c.year}年度`).join(', '));
              }
              if (nut.length) {
                let totals = { calories: 0, protein: 0, vegetables: 0, fiber: 0, sodium: 0 }, nValid = 0;
                for (const r of nut) {
                  try { const s = JSON.parse(r.nutrition_scores);
                    if (s && typeof s === 'object') {
                      ['calories','protein','vegetables','fiber','sodium'].forEach(k => { if (typeof s[k] === 'number') totals[k] += s[k]; });
                      nValid++;
                    }
                  } catch(e) {}
                }
                if (nValid) {
                  lines.push(`・食事栄養スコア30日 (${nValid}投稿の平均): ` +
                    `カロリー${Math.round(totals.calories/nValid)}, タンパク${Math.round(totals.protein/nValid)}, 野菜${Math.round(totals.vegetables/nValid)}, 食物繊維${Math.round(totals.fiber/nValid)}, 塩分${Math.round(totals.sodium/nValid)}`);
                }
              }
              if (stepStats && stepStats.days > 0) {
                lines.push(`・歩数30日平均: ${Math.round(stepStats.avg_steps).toLocaleString()}歩/日 (${stepStats.days}日分の記録)`);
              }
              // 質問を先頭に置き、健康データは末尾の参考情報として渡す (血圧固定回答防止)
              const baseQuestion = (userMessage === content) ? content : userMessage;
              userMessage = '[社員からの質問 — まずこの質問に直接答えてください]\n' + baseQuestion + '\n\n' + lines.join('\n');
            } catch (e) {
              console.warn('[bot_health context fail]', e.message);
            }
          }
          // bot_safety 向け: 過去の事故報告書 (製品事故 + 車両事故) を context として注入
          // 直近20件の生データ + 180日の集計で「現場叩き上げの蓄積」を再現
          if (to === 'bot_safety') {
            try {
              const lines = ['[過去の事故報告書 context — 安全管理者として再発防止の根拠提示や類似事例参照に使用]'];
              // 製品事故 (関東BC) 直近15件
              const prodRows = db.prepare(`SELECT accident_date, location_floor, location_area, product_name, product_category,
                  quantity, cause_category, cause_detail, damage_description, reporter_reflection, reporter_name, status
                FROM kbc_accident_reports
                ORDER BY accident_date DESC, id DESC LIMIT 15`).all();
              if (prodRows.length) {
                lines.push(`■ 製品事故 直近${prodRows.length}件:`);
                for (const r of prodRows) {
                  const loc = [r.location_floor, r.location_area].filter(Boolean).join('/');
                  const prod = [r.product_category, r.product_name].filter(Boolean).join(':');
                  const detail = (r.cause_detail || r.damage_description || '').slice(0, 80);
                  const refl = (r.reporter_reflection || '').slice(0, 60);
                  lines.push(`- ${r.accident_date} [${loc}] ${prod}${r.quantity ? ' x' + r.quantity : ''} / 原因:${r.cause_category || '?'} ${detail ? '「' + detail + '」' : ''}${refl ? ' / 振返り:「' + refl + '」' : ''} (報告:${r.reporter_name})`);
                }
              }
              // 車両事故 直近10件
              const vehRows = db.prepare(`SELECT accident_date, location, vehicle_no, accident_type, counter_party,
                  injury_status, cause_summary, description, repair_status, reporter_name
                FROM vehicle_accident_reports
                ORDER BY accident_date DESC, id DESC LIMIT 10`).all();
              if (vehRows.length) {
                lines.push(`■ 車両事故 直近${vehRows.length}件:`);
                for (const r of vehRows) {
                  const desc = (r.description || '').slice(0, 80);
                  lines.push(`- ${r.accident_date} [${r.location || '-'}] ${r.accident_type || '?'} ${r.vehicle_no || ''} / 負傷:${r.injury_status || '無し'} / 原因:${r.cause_summary || '?'}${desc ? ' / 状況:「' + desc + '」' : ''}${r.repair_status ? ' / 修理:' + r.repair_status : ''}`);
                }
              }
              // 集計 (180日): 原因カテゴリTop3
              const causeAgg = db.prepare(`SELECT cause_category, COUNT(*) AS cnt FROM kbc_accident_reports
                WHERE accident_date >= date('now','-180 days') AND cause_category IS NOT NULL AND cause_category != ''
                GROUP BY cause_category ORDER BY cnt DESC LIMIT 5`).all();
              const typeAgg = db.prepare(`SELECT accident_type, COUNT(*) AS cnt FROM vehicle_accident_reports
                WHERE accident_date >= date('now','-180 days') AND accident_type IS NOT NULL AND accident_type != ''
                GROUP BY accident_type ORDER BY cnt DESC LIMIT 5`).all();
              const injAgg = db.prepare(`SELECT COUNT(*) AS n FROM vehicle_accident_reports
                WHERE accident_date >= date('now','-180 days') AND injury_status IS NOT NULL AND injury_status != '無し'`).get();
              if (causeAgg.length || typeAgg.length) {
                lines.push('■ 集計 (180日):');
                if (causeAgg.length) lines.push('- 製品事故 原因Top: ' + causeAgg.map(c => `${c.cause_category}(${c.cnt})`).join(', '));
                if (typeAgg.length) lines.push('- 車両事故 種別Top: ' + typeAgg.map(t => `${t.accident_type}(${t.cnt})`).join(', '));
                if (injAgg && injAgg.n > 0) lines.push(`- 車両事故 負傷あり: ${injAgg.n}件`);
              }
              // 過去事故報告書アーカイブ (PDF→Gemini抽出 or 反省会記録xlsx取込)
              // LIMIT 30 × 250字 = 約7500字の context (Gemini処理可能範囲)
              const archives = db.prepare(`SELECT title, accident_date, summary, full_text FROM accident_archives
                WHERE deleted_at IS NULL ORDER BY accident_date DESC, created_at DESC LIMIT 30`).all();
              if (archives.length) {
                lines.push(`■ 過去事故報告書・反省会記録 (アーカイブ ${archives.length}件):`);
                for (const a of archives) {
                  const dateStr = a.accident_date ? `[${a.accident_date}] ` : '';
                  const body = (a.full_text && a.full_text.length > 50) ? a.full_text.slice(0, 250) : (a.summary || '').slice(0, 200);
                  lines.push(`- ${dateStr}${a.title || '無題'} :: ${body.replace(/\n/g, ' / ')}`);
                }
              }
              // 最新のAI分析レポートのサマリ (毎質問の冒頭で「現状認識」として提示)
              const latestReport = db.prepare(`SELECT period_label, summary, created_at FROM accident_analysis_reports
                WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`).get();
              if (latestReport && latestReport.summary) {
                lines.unshift(`■ 最新AI分析レポート (${latestReport.created_at ? latestReport.created_at.slice(0,10) : ''} 生成 / ${latestReport.period_label || ''}):
${latestReport.summary}
↑ この現状認識を踏まえ、回答時は「現在の傾向では…」と語って構いません。`);
              }
              if (lines.length > 1) {
                userMessage = lines.join('\n') + '\n\n[社員からの質問]\n' + (userMessage === content ? content : userMessage);
              }
            } catch (e) {
              console.warn('[bot_safety context fail]', e.message);
            }
          }
          const replyText = await chatBot(to, userMessage, history);
          const ins2 = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')")
            .run(to, uid, replyText);
          const replyPayload = {
            id: ins2.lastInsertRowid,
            from: to,
            to: uid,
            content: replyText,
            at: new Date().toISOString(),
            attach: null,
            voice: voiceMode,  // 送信者が音声モードならbot応答もvoice再生する
          };
          socket.emit('dm:msg', replyPayload);
        } catch (e) {
          // Gemini SAFETY block: L1で拾えなかった巧妙な入力を Gemini が検知
          if (e && e.code === 'GEMINI_SAFETY_BLOCK') {
            console.warn(`[safety L3] uid=${uid} bot=${to} finishReason=${e.finishReason}`);
            const refusalText = safety.refusalResponse('harassment');
            const insR = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')")
              .run(to, uid, refusalText);
            socket.emit('dm:msg', {
              id: insR.lastInsertRowid, from: to, to: uid, content: refusalText,
              at: new Date().toISOString(), attach: null, voice: voiceMode,
            });
            try {
              db.prepare(`INSERT INTO inappropriate_logs (user_id, bot_id, content, detection_layer, category, matched_pattern, severity)
                VALUES (?, ?, ?, 'L3_gemini_safety', 'unknown', ?, 'high')`)
                .run(uid, to, content.slice(0, 1000), e.finishReason || 'SAFETY');
            } catch (ee) {}
            notifyInappropriateDetection(uid, to, content, { category: 'L3_gemini_safety', matched: e.finishReason, severity: 'high' });
            return;
          }
          console.error('[bot reply error]', e.message);
          const errMsg = '⚠️ すみません、ただいま応答できません。少し時間を置いてからもう一度お試しください。';
          socket.emit('dm:msg', { id: 0, from: to, to: uid, content: errMsg, at: new Date().toISOString(), attach: null, voice: voiceMode });
        }
      })();
      return;
    }
    // Pushプッシュ通知 (相手が非アクティブでも届く、bot宛は不要)
    const senderName = (getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(uid) || {}).display_name || '';
    sendPushToUser(to, {
      title: 'DM: ' + senderName,
      body: (content || '').slice(0, 120) || '📎 添付ファイル',
      tag: 'dm-' + uid,
      mention: true,
      url: '/',
    }).catch(() => {});
  });

  // 既読通知を送信者に転送（同フロアのみ意味あり）
  socket.on('chat:read', (data) => {
    const from = (data && data.from || '').toString();
    if (!from) return;
    const target = presence.get(from);
    if (!target) return;
    const s = io.sockets.sockets.get(target.socketId);
    if (s) s.emit('chat:read-receipt', { reader: uid, at: new Date().toISOString() });
  });

  // ===== 音声モード (WebRTC近接メッシュ) =====
  // 音声参加開始: 同フロアの他の音声参加者に通知
  socket.on('voice:join', () => {
    const p = presence.get(uid);
    if (!p) return;
    p.voiceOn = true;
    io.to('floor:' + p.floor).emit('voice:state', { uid, on: true });
    // 既に参加中の同フロア+同グループメンバー一覧を本人に返す (本人がofferを作る)
    const myGroup = getVoiceGroup(p);
    const peers = [];
    for (const [u, v] of presence) {
      if (u === uid) continue;
      if (v.voiceOn && v.floor === p.floor && v.status !== 'offline' && getVoiceGroup(v) === myGroup) peers.push(u);
    }
    socket.emit('voice:peers', { peers });
  });

  socket.on('voice:leave', () => {
    const p = presence.get(uid);
    if (!p) return;
    p.voiceOn = false;
    io.to('floor:' + p.floor).emit('voice:state', { uid, on: false });
  });

  // シグナリング: offer / answer / ice を指定peerへ転送 (異グループ間はブロック)
  socket.on('voice:signal', (data) => {
    if (!data || !data.to) return;
    const sender = presence.get(uid);
    const target = presence.get(data.to);
    if (!sender || !target) return;
    if (getVoiceGroup(sender) !== getVoiceGroup(target)) return; // 異グループは中継しない
    const s = io.sockets.sockets.get(target.socketId);
    if (!s) return;
    s.emit('voice:signal', {
      from: uid,
      type: data.type,
      payload: data.payload,
    });
  });

  // 話者インジケータ (発話検知時) ※ 同グループのみに伝播 (ハドルプライバシー)
  socket.on('voice:speaking', (data) => {
    const p = presence.get(uid);
    if (!p) return;
    const myGroup = getVoiceGroup(p);
    for (const [u, v] of presence) {
      if (u === uid) continue;
      if (v.floor !== p.floor) continue;
      if (getVoiceGroup(v) !== myGroup) continue;
      const s = io.sockets.sockets.get(v.socketId);
      if (s) s.emit('voice:speaking', { uid, on: !!(data && data.on) });
    }
  });

  // ===== ミーティング (Zoom主導+CoHub集合プレゼンス) =====
  // 2026-05-19以降: 会議実体はZoom側、CoHubは「誰が入室中か」だけを配信する。
  // WebRTC/議事録/録画/ロック/主催者譲渡 は撤去。
  socket.on('meeting:join', (data) => {
    const roomId = String((data && data.roomId) || '').trim();
    if (!/^[a-z0-9_-]{1,40}$/.test(roomId)) return;
    // 既存ミーティング部屋から退出
    for (const r of [...socket.rooms]) if (r.startsWith('mt:')) {
      socket.leave(r);
      io.to(r).emit('meeting:peer-left', { uid });
    }
    socket.join('mt:' + roomId);
    // 既存メンバー(uidのみ)を新参加者へ
    const room = io.sockets.adapter.rooms.get('mt:' + roomId) || new Set();
    const peers = [];
    for (const sid of room) {
      if (sid === socket.id) continue;
      const s2 = io.sockets.sockets.get(sid);
      if (s2 && s2.uid) peers.push(s2.uid);
    }
    const u = getDb().prepare('SELECT display_name, avatar_url, company_code FROM users WHERE id = ?').get(uid) || {};
    const profile = { uid, display_name: u.display_name || '', avatar_url: u.avatar_url || '', company_code: u.company_code || '' };
    socket.emit('meeting:peers', { peers, room_id: roomId });
    socket.to('mt:' + roomId).emit('meeting:peer-joined', profile);
  });
  socket.on('meeting:leave', () => {
    for (const r of [...socket.rooms]) if (r.startsWith('mt:')) {
      socket.leave(r);
      io.to(r).emit('meeting:peer-left', { uid });
    }
  });

  // ===== 1:1 通話 (DMから音声/ビデオ通話を開始する) =====
  // 設計: chat-simple.html で使用。WebRTC signaling のリレーのみ。
  // payload は最小限の検証 (相手存在/ブロックなし) のみ実施し、SDP/ICE は中継。
  function relayCallEvent(eventName, data, opts) {
    const to = (data && data.to || '').toString();
    if (!to || to === uid) return;
    // ブロック判定 (DMと同等)
    if (isBlocked(to, uid)) {
      socket.emit('call:blocked', { to, reason: 'blocked' });
      return;
    }
    if (isBlocked(uid, to)) {
      socket.emit('call:blocked', { to, reason: 'self_blocked' });
      return;
    }
    const tp = presence.get(to);
    if (!tp || tp.status === 'offline' || tp.isBot) {
      socket.emit('call:peer-offline', { to });
      return;
    }
    const s = io.sockets.sockets.get(tp.socketId);
    if (!s) {
      socket.emit('call:peer-offline', { to });
      return;
    }
    // 発信者プロファイル添付 (UI 表示用)
    if (opts && opts.attachProfile) {
      const me = getDb().prepare('SELECT display_name, avatar_url, company_code FROM users WHERE id = ?').get(uid) || {};
      s.emit(eventName, { ...data, from: uid, sender_name: me.display_name || '', sender_avatar: me.avatar_url || '', sender_company: me.company_code || '' });
    } else {
      s.emit(eventName, { ...data, from: uid });
    }
  }
  socket.on('call:invite', (data) => {
    // type: 'voice' | 'video'
    relayCallEvent('call:invite', { to: data && data.to, type: (data && data.type === 'video') ? 'video' : 'voice' }, { attachProfile: true });
  });
  socket.on('call:accept', (data)  => relayCallEvent('call:accept',  { to: data && data.to }));
  socket.on('call:reject', (data)  => relayCallEvent('call:reject',  { to: data && data.to, reason: data && data.reason }));
  socket.on('call:cancel', (data)  => relayCallEvent('call:cancel',  { to: data && data.to }));
  socket.on('call:end',    (data)  => relayCallEvent('call:end',     { to: data && data.to }));
  // SDP / ICE 候補のリレー
  socket.on('call:signal', (data) => {
    if (!data) return;
    relayCallEvent('call:signal', {
      to: data.to,
      sdp: data.sdp || null,
      candidate: data.candidate || null,
      kind: data.kind || null, // 'offer' | 'answer' | 'ice'
    });
  });

  // 画面共有 状態通知 (情報表示のみ)
  socket.on('screen:state', (data) => {
    const p = presence.get(uid);
    if (!p) return;
    io.to('floor:' + p.floor).emit('screen:state', { uid, on: !!(data && data.on) });
  });

  // 部屋の施錠/解錠 (会議室・事故対策室のみ、室内の人だけ可)
  socket.on('room:lock', (data) => {
    const p = presence.get(uid); if (!p) return;
    if (!isMeetingFloorCode(p.floor)) return;
    const pw = (data && data.password || '').toString();
    if (pw.length < 4 || pw.length > 30) {
      socket.emit('room:lock-result', { ok: false, msg: 'パスワードは4〜30文字' });
      return;
    }
    const hash = bcrypt.hashSync(pw, 10);
    getDb().prepare("UPDATE floors SET locked=1, lock_pw_hash=?, locked_by=?, locked_at=datetime('now') WHERE code=?").run(hash, uid, p.floor);
    io.emit('room:lockstate', { code: p.floor, locked: true, locked_by: uid });
    socket.emit('room:lock-result', { ok: true });
  });

  socket.on('room:unlock', () => {
    const p = presence.get(uid); if (!p) return;
    if (!isMeetingFloorCode(p.floor)) return;
    getDb().prepare("UPDATE floors SET locked=0, lock_pw_hash=NULL, locked_by=NULL, locked_at=NULL WHERE code=?").run(p.floor);
    io.emit('room:lockstate', { code: p.floor, locked: false });
  });

  // 承認制ON/OFF (会議室・事故対策室内メンバーのみ)
  socket.on('room:set-approval', (data) => {
    const p = presence.get(uid); if (!p) return;
    if (!isMeetingFloorCode(p.floor)) return;
    const on = !!(data && data.on);
    getDb().prepare('UPDATE floors SET approval_mode=? WHERE code=?').run(on ? 1 : 0, p.floor);
    io.emit('room:approval-state', { code: p.floor, on });
  });

  // 入室承認
  socket.on('room:approve', (data) => {
    const p = presence.get(uid); if (!p) return;
    const applicantUid = (data && data.uid || '').toString();
    const map = pendingKnocks.get(p.floor);
    if (!map || !map.has(applicantUid)) return;
    const entry = map.get(applicantUid);
    clearTimeout(entry.timer);
    map.delete(applicantUid);
    // 申請者側の socket を取り出して floor:switch を承認済みフラグ付きで実行させる
    const appSocket = io.sockets.sockets.get(entry.socketId);
    if (appSocket) appSocket.emit('room:knock-result', { ok: true, code: p.floor });
  });

  socket.on('room:deny', (data) => {
    const p = presence.get(uid); if (!p) return;
    const applicantUid = (data && data.uid || '').toString();
    const map = pendingKnocks.get(p.floor);
    if (!map || !map.has(applicantUid)) return;
    const entry = map.get(applicantUid);
    clearTimeout(entry.timer);
    map.delete(applicantUid);
    const appSocket = io.sockets.sockets.get(entry.socketId);
    if (appSocket) appSocket.emit('room:knock-result', { ok: false, msg: '入室が拒否されました' });
    // 室内メンバーにもノック取消を通知
    io.to('floor:' + p.floor).emit('room:knock-cancel', { uid: applicantUid });
  });

  // ホワイトボード 共同編集 (テキスト)
  socket.on('wb:update', (data) => {
    const content = (data && data.content || '').toString().slice(0, 100000);
    const p = presence.get(uid); if (!p) return;
    const room = p.floor;
    getDb().prepare(`INSERT INTO whiteboards (room_code, content, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(room_code) DO UPDATE SET content=excluded.content, updated_by=excluded.updated_by, updated_at=datetime('now')`).run(room, content, uid);
    socket.to('floor:' + room).emit('wb:update', { content, from: uid, at: new Date().toISOString() });
  });

  // ホワイトボード 描画 (1ストローク毎にbroadcast)
  socket.on('wb:draw', (data) => {
    const p = presence.get(uid); if (!p) return;
    socket.to('floor:' + p.floor).emit('wb:draw', { stroke: data && data.stroke, from: uid });
  });

  // 描画の全ストロークをDBに永続化 (ストローク終わりの負担軽く、間引き保存用)
  socket.on('wb:draw-save', (data) => {
    const p = presence.get(uid); if (!p) return;
    const strokes = Array.isArray(data && data.strokes) ? data.strokes : [];
    const json = JSON.stringify(strokes).slice(0, 2000000);
    getDb().prepare(`INSERT INTO whiteboards (room_code, drawing_json, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(room_code) DO UPDATE SET drawing_json=excluded.drawing_json, updated_by=excluded.updated_by, updated_at=datetime('now')`).run(p.floor, json, uid);
  });

  // 描画の全消去
  socket.on('wb:clear', () => {
    const p = presence.get(uid); if (!p) return;
    getDb().prepare("UPDATE whiteboards SET drawing_json='[]', updated_by=?, updated_at=datetime('now') WHERE room_code=?").run(uid, p.floor);
    io.to('floor:' + p.floor).emit('wb:clear', { from: uid });
  });

  // 録音 状態通知 (管理者のみ、同フロアに通知＝被録音者に開示)
  // 録音同意フロー: 管理者が録音開始前にフロアメンバー全員の同意を取る
  socket.on('recording:request', () => {
    const p = presence.get(uid);
    if (!p) return;
    if (socket.role !== 'admin') {
      socket.emit('recording:start-denied', { reason: 'not-admin', msg: '管理者のみ録音できます' });
      return;
    }
    const floor = p.floor;
    const others = [];
    for (const [u, vv] of presence) {
      if (u === uid) continue;
      if (vv.floor !== floor) continue;
      if (vv.status === 'offline') continue;
      if (vv.isBot) continue;
      others.push(u);
    }
    if (others.length === 0) {
      socket.emit('recording:start-allowed', { agreedCount: 0, totalCount: 0 });
      return;
    }
    const responses = new Map();
    for (const u of others) responses.set(u, 'pending');
    const state = { adminUid: uid, floor, startedAt: Date.now(), responses, total: others.length, deniers: [], timer: null };
    pendingRecConsents.set(floor, state);
    state.timer = setTimeout(() => finalizeRecConsent(floor, true), 30000);
    const adminUser = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(uid);
    const adminName = (adminUser && adminUser.display_name) || '管理者';
    for (const u of others) {
      const tp = presence.get(u);
      if (tp && !tp.isBot) {
        const s = io.sockets.sockets.get(tp.socketId);
        if (s) s.emit('recording:consent-prompt', { floor, adminUid: uid, adminName });
      }
    }
    socket.emit('recording:consent-pending', { totalCount: others.length });
  });
  socket.on('recording:consent', (data) => {
    const floor = data && data.floor;
    const ok = !!(data && data.ok);
    if (!floor) return;
    const state = pendingRecConsents.get(floor);
    if (!state) return;
    if (!state.responses.has(uid)) return;
    if (state.responses.get(uid) !== 'pending') return;
    state.responses.set(uid, ok ? 'ok' : 'no');
    if (!ok) {
      const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(uid);
      state.deniers.push((u && u.display_name) || '匿名');
    }
    let allDone = true;
    for (const v of state.responses.values()) if (v === 'pending') { allDone = false; break; }
    if (allDone) finalizeRecConsent(floor, false);
  });

  socket.on('recording:state', (data) => {
    if (socket.role !== 'admin') return;
    const p = presence.get(uid);
    if (!p) return;
    io.to('floor:' + p.floor).emit('recording:state', { uid, on: !!(data && data.on) });
  });

  socket.on('disconnecting', () => {
    // ミーティング部屋にいた場合、退室通知
    for (const r of socket.rooms) if (r.startsWith('mt:')) {
      socket.to(r).emit('meeting:peer-left', { uid });
    }
  });
  socket.on('disconnect', () => {
    const p = presence.get(uid);
    if (!p) return;
    if (p.voiceOn) {
      p.voiceOn = false;
      io.to('floor:' + p.floor).emit('voice:state', { uid, on: false });
    }
    if (p.handUp) {
      p.handUp = false;
      io.to('floor:' + p.floor).emit('hand', { uid, up: false });
    }
    db.prepare("INSERT INTO attendance (user_id, floor_code, event_type) VALUES (?, ?, 'logout')").run(uid, p.floor);
    // 2段階プレゼンス: 即オフラインにせず、ナビ再接続の猶予(2秒)後に「退席中(自動)」へ。
    // オフライン昇格＋ログアウト通知は presence スイープが切断猶予(PRESENCE_DISCONNECT_OFFLINE_MS)経過後に実施。
    setTimeout(() => {
      const cur = presence.get(uid);
      if (cur && cur.socketId === socket.id && !cur.disconnectedAt) {
        cur.status = '退席中';
        cur.autoAway = true;
        cur.disconnectedAt = Date.now();
        io.to('floor:' + cur.floor).emit('user:update', { uid, x: cur.x, y: cur.y, status: '退席中' });
        io.emit('floor:counts', floorCountMap());
      }
    }, 2000);
  });
});

// プレゼンス生存スイープ: ハートビート途絶を検知して 自動退席→オフライン化
// (PCスリープ/タブ凍結/半開き接続で disconnect が発火しないケースの保険。10秒間隔)
const PRESENCE_AWAY_MS = 35000;              // 接続中だがpong途絶 約35秒 → 退席中(自動)
const PRESENCE_OFFLINE_MS = 70000;          // 接続中だがpong途絶 約70秒 → オフライン (半開き接続の保険)
const PRESENCE_DISCONNECT_OFFLINE_MS = 45000; // 切断(退席中)後 約45秒 → オフライン+ログアウト通知
setInterval(() => {
  const now = Date.now();
  const sdb = getDb();
  for (const [uid, p] of presence) {
    if (!p || p.isBot) continue;          // botはsocket無しなので対象外
    if (p.status === 'offline') continue;
    // (1) 切断済みで退席中 → 猶予経過でオフライン+ログアウト+presence削除
    if (p.disconnectedAt) {
      if (now - p.disconnectedAt > PRESENCE_DISCONNECT_OFFLINE_MS) {
        const leaverName = (sdb.prepare('SELECT display_name FROM users WHERE id=?').get(uid) || {}).display_name || '';
        p.status = 'offline';
        io.to('floor:' + p.floor).emit('user:update', { uid, x: p.x, y: p.y, status: 'offline' });
        io.emit('user:floor', { uid, floor: null, offline: true });
        io.emit('floor:counts', floorCountMap());
        io.emit('user:logout', { uid, name: leaverName });
        presence.delete(uid);
        lastLogoutAt.set(uid, Date.now()); // 一定時間は再接続アナウンスを抑止
      }
      continue;
    }
    // (2) 接続中だが pong 途絶 (半開き/フリーズ) → lastHb ベースで 退席中→オフライン
    if (p.lastHb == null) { p.lastHb = now; continue; }
    const age = now - p.lastHb;
    if (age > PRESENCE_OFFLINE_MS) {
      p.status = 'offline';
      io.to('floor:' + p.floor).emit('user:update', { uid, x: p.x, y: p.y, status: 'offline' });
      io.emit('user:floor', { uid, floor: null, offline: true });
      io.emit('floor:counts', floorCountMap());
    } else if (age > PRESENCE_AWAY_MS && p.status === 'online') {
      p.status = '退席中';
      p.autoAway = true;
      io.to('floor:' + p.floor).emit('user:update', { uid, x: p.x, y: p.y, status: '退席中' });
    }
  }
}, 10000);

// 60日より古いメッセージの自動削除（毎時）
setInterval(() => {
  try {
    getDb().prepare("DELETE FROM messages WHERE created_at < datetime('now', '-60 days')").run();
  } catch (e) {}
}, 60 * 60 * 1000);

// Connect 230: 終了日経過イベントの自動完了化 (1時間ごと)
// + 集計を念のため再計算 (整合性保証)
setInterval(() => {
  try {
    const db = getDb();
    // 終了日が過ぎた active/phase2_solo イベントを completed に
    const expired = db.prepare(`SELECT id FROM walk_events
      WHERE status IN ('active','phase2_solo') AND end_date < date('now')`).all();
    for (const r of expired) {
      db.prepare(`UPDATE walk_events SET status='completed', completed_at=datetime('now') WHERE id=?`).run(r.id);
      console.log('[walk] event auto-completed', r.id);
    }
    // 開催中イベントの集計を再計算
    const active = db.prepare(`SELECT id FROM walk_events WHERE status IN ('active','phase2_solo')`).all();
    for (const ev of active) {
      // チーム集計のみ再計算 (個人は記録時に都度更新済)
      for (const team of ['STD', 'SZE']) {
        const agg = db.prepare(`SELECT SUM(total_steps) AS s, SUM(distance_walked_km) AS km, COUNT(*) AS n
          FROM walk_personal_state WHERE event_id=? AND team_code=?`).get(ev.id, team);
        db.prepare(`INSERT INTO walk_team_progress (team_code, event_id, total_steps, total_km, member_count, last_updated)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(team_code, event_id) DO UPDATE SET
            total_steps=excluded.total_steps, total_km=excluded.total_km,
            member_count=excluded.member_count, last_updated=excluded.last_updated`)
          .run(team, ev.id, agg.s || 0, Math.round((agg.km || 0) * 100) / 100, agg.n || 0);
      }
      // 合流検知 (Phase1のみ判定)
      const evRow = db.prepare('SELECT * FROM walk_events WHERE id=?').get(ev.id);
      if (evRow && evRow.status === 'active') {
        const std = db.prepare("SELECT total_km FROM walk_team_progress WHERE team_code='STD' AND event_id=?").get(ev.id);
        const sze = db.prepare("SELECT total_km FROM walk_team_progress WHERE team_code='SZE' AND event_id=?").get(ev.id);
        const stdKm = (std && std.total_km) || 0;
        const szeKm = (sze && sze.total_km) || 0;
        if (stdKm + szeKm >= evRow.total_route_km) {
          const meetKm = Math.min(stdKm, evRow.total_route_km);
          db.prepare(`UPDATE walk_events SET status='phase2_solo', meet_event_at=datetime('now'), meet_position_km=? WHERE id=?`).run(meetKm, ev.id);
          console.log('[walk] meet event detected, event', ev.id, 'meet at', meetKm, 'km');
        }
      }
    }
  } catch (e) { console.warn('[walk auto-tick] fail:', e.message); }
}, 60 * 60 * 1000);

// 健康管理室: 投票期間 7日経過の施策を自動締切 (1時間ごと)
setInterval(() => {
  try {
    const db = getDb();
    const expired = db.prepare(`SELECT id FROM wellness_actions
      WHERE status = '投票中' AND vote_started_at IS NOT NULL
      AND datetime(vote_started_at, '+7 days') <= datetime('now')`).all();
    for (const r of expired) {
      const sm = db.prepare(`SELECT COUNT(*) AS total, AVG(score) AS avg_score,
        SUM(CASE WHEN score >= 4 THEN 1 ELSE 0 END) AS pos,
        SUM(CASE WHEN score <= 2 THEN 1 ELSE 0 END) AS neg
        FROM wellness_action_votes WHERE action_id = ?`).get(r.id);
      const passed = (sm.pos || 0) > (sm.neg || 0);
      const result = { total: sm.total||0, avg: sm.avg_score, pos: sm.pos||0, neg: sm.neg||0, passed, auto: true };
      if (passed) {
        db.prepare(`UPDATE wellness_actions SET status = '保健師最終', vote_closed_at = datetime('now'), vote_result_json = ? WHERE id = ?`)
          .run(JSON.stringify(result), r.id);
      } else {
        db.prepare(`UPDATE wellness_actions SET status = '却下', vote_closed_at = datetime('now'), vote_result_json = ?, rejection_reason = '社員投票で賛成が反対を超えませんでした (自動締切)' WHERE id = ?`)
          .run(JSON.stringify(result), r.id);
      }
      console.log('[wellness] auto-closed vote', r.id, passed ? 'PASS→保健師最終' : 'FAIL→却下');
    }
  } catch (e) { console.warn('[wellness vote auto-close] fail:', e.message); }
}, 60 * 60 * 1000);

// 受付AI案内員(BOT) を初期化 + presenceに常駐
ensureConciergeBots();
for (const b of CONCIERGE_BOTS) {
  presence.set(b.id, { x: b.x, y: b.y, status: 'online', statusText: '案内係です。話しかけてください', floor: b.floor, socketId: null, voiceOn: false, isBot: true });
}

// ===== 運転アラート(ITP違反通知)配線 — 2026-05-25実装、誤って巻き戻したため復旧 2026-05-25 =====
// 新着アラート → 管理職(is_manager)へ alert:new emit + Push (派手な音+音声読み上げは global-notif.js 側)
try {
  const alertRoute = require('./routes/alert');
  if (typeof alertRoute.setOnNewAlert === 'function') {
    alertRoute.setOnNewAlert((a) => {
      try {
        const mgrs = getDb().prepare('SELECT id FROM users WHERE is_manager = 1').all();
        const body = [a.vehicle_name || a.vehicle_number, a.driver_name, a.notice].filter(Boolean).join(' / ');
        for (const m of mgrs) {
          io.to('user:' + m.id).emit('alert:new', a);
          sendPushToUser(m.id, { title: '⚠️ 運転アラート', body: body, tag: 'alert-' + (a.id || ''), mention: true, alwaysShow: true, url: '/alerts.html' }).catch(() => {});
        }
      } catch (e) { console.warn('[alert onNew]', e.message); }
    });
  }
} catch (e) { console.warn('[alert wiring]', e.message); }
// ITPメール IMAP自動受信ポーラ起動 (services/itp_imap.js, 5分間隔, error handler内蔵の修正版)
try {
  require('./services/itp_imap').start(require('./routes/alert').ingestText);
} catch (e) { console.warn('[itp_imap start]', e.message); }

server.listen(PORT, () => {
  console.log('CoWell (Communication & Wellness) サーバー起動: http://localhost:' + PORT);
});
