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
const { getDb } = require('./services/db');
const { chatBot } = require('./services/ai');
const safety = require('./services/safety');
const gcal = require('./services/gcal');

// ===== 受付AI案内員(BOT) 定義 =====
const CONCIERGE_BOTS = [
  { id: 'bot_aoi', login_id: 'bot_aoi', name: '総合案内', avatar: '/assets/concierge_aoi.png?v=2', floor: 'lobby', x: 744, y: 405 },
  { id: 'bot_health', login_id: 'bot_health', name: 'ヘルスアドバイザー', avatar: '/assets/concierge_health_avatar.png?v=3', floor: 'wellness_room', x: 744, y: 519 },
  { id: 'bot_safety', login_id: 'bot_safety', name: '安全管理者', avatar: '/assets/concierge_safety_avatar.png?v=1', floor: 'field_accident', x: 1080, y: 500 },
];
const OLD_BOT_IDS = ['bot_yui', 'bot_misaki']; // 廃止bot
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

// 総合案内から健康管理室のひろば案内DM (1日1回、ロビー入室時)
// 文面を変えたい時はこの定数を編集 (環境変数WELLNESS_EVENT_TEXTで上書きも可)
const WELLNESS_EVENT_TEXT = process.env.WELLNESS_EVENT_TEXT || `🌳 健康管理室「ひろば」より

ひろばに食事や雑談を投稿してみませんか？
食事の写真を投稿すると AI が栄養スコアを自動分析します。

🎯 今すぐできること
・「ひろば」(左メニュー🌳) で 30秒で食事投稿 → AI栄養分析
・「🐠 水族館の冒険」(開催中イベント) で歩数を冒険に
・気になることがあれば「相談」カテゴリで投稿

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
      imgSrc: ["'self'", "data:", "blob:", "https://health.biz-terrace.org"],
      mediaSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "wss:", "ws:", "https://cloudflareinsights.com", "https://cdn.jsdelivr.net"],
      workerSrc: ["'self'", "blob:"],
      childSrc: ["'self'", "blob:"],
      // 健康管理室は CoHub ネイティブの /plaza.html を iframe (CoWell吸収済)
      frameSrc: ["'self'"],
    }
  },
  crossOriginEmbedderPolicy: false,
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
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')
        || filePath.endsWith('manifest.json') || filePath.endsWith('sw.js')) {
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
app.use('/api/chat', require('./routes/chat'));
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

// モバイル用: 指定フロアに今いる人の一覧 (m.html の人リスト・ビュー用)
const { authUser } = require('./middleware/auth');
app.get('/api/floor-presence/:code', authUser, (req, res) => {
  const code = req.params.code;
  const inFloor = floorUserList(code).filter(u => u.floor === code && u.status !== 'offline');
  // 自分自身は除外
  res.json({ success: true, floor: code, members: inFloor.filter(u => u.uid !== req.uid) });
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

// SPA fallback
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/mylog', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'mylog.html')));
app.get('/m', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'm.html')));
app.get('/overview', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'overview.html')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  if (req.path.startsWith('/uploads/')) return res.status(404).end();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ===== Socket.IO =====
const io = new Server(server, {
  cors: { origin: [process.env.WEB_APP_URL || 'https://cohub.biz-terrace.org', 'http://localhost:3005'], credentials: true },
  maxHttpBufferSize: 1024 * 1024,
});
// ルート側からioを使えるようlocalsに共有
app.locals.io = io;

// ソケット認証
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauth'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.uid = payload.uid;
    socket.role = payload.role;
    socket.isMobile = !!(socket.handshake.auth && socket.handshake.auth.isMobile);
    next();
  } catch (e) { next(new Error('unauth')); }
});

const presence = new Map(); // uid → { x, y, status, floor, socketId }
const tapTimestamps = new Map(); // `${fromUid}:${toUid}` → ts (肩たたきレート制限)
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
// - 管理者(role=admin)は常にOK
// - 受信者がbotなら常にOK
// - dm_group NULL は移行互換で無制限
// - 同じdm_groupなら常にOK
// - 別group: 送信者rank >= 受信者rank - 1 (即ち差が2以上の下から上はブロック)
function canDm(sender, receiver) {
  if (!sender || !receiver) return false;
  if (sender.role === 'admin') return true;
  if (receiver.role === 'bot') return true;
  const sg = sender.dm_group || null;
  const rg = receiver.dm_group || null;
  // 移行互換: どちらかがNULLなら無制限
  if (sg == null || rg == null) return true;
  if (sg === rg) return true;
  const sr = sender.dm_rank | 0;
  const rr = receiver.dm_rank | 0;
  // 送信者ランクが受信者ランク-1以上なら通す (上から下/隣接レベルまで)
  return sr >= rr - 1;
}
function loadUserForDm(uid) {
  return getDb().prepare('SELECT id, role, dm_group, dm_rank FROM users WHERE id = ?').get(uid);
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
  const saved = db.prepare('SELECT x, y, floor_code, status_text FROM positions WHERE user_id = ?').get(uid);
  const userInfo = db.prepare('SELECT employee_type FROM users WHERE id = ?').get(uid);
  // 初回ログイン時のデフォルトフロア: 現場社員は乗務員詰所、その他はロビー
  const defaultFloor = (userInfo && userInfo.employee_type === 'field') ? 'field_rest' : 'lobby';
  const floorCode = (saved && saved.floor_code) || defaultFloor;
  const floor = getFloor(floorCode) || getFloor(defaultFloor) || getFloor('lobby');
  const pos = clampForFloor(floor, saved && saved.x, saved && saved.y);

  // ナビゲーション再接続検出: 既存presenceあり or 直前まで離脱中だったら「再接続」扱い
  const wasConnected = presence.has(uid);
  const lastOff = lastLogoutAt.get(uid) || 0;
  const isReconnect = wasConnected || (lastOff && (Date.now() - lastOff) < LOGIN_ANNOUNCE_COOLDOWN_MS);
  lastLogoutAt.delete(uid);
  presence.set(uid, { x: pos.x, y: pos.y, status: 'online', statusText: saved ? (saved.status_text || '') : '', floor: floor.code, socketId: socket.id, isMobile: !!socket.isMobile });
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(uid);
  db.prepare("INSERT INTO attendance (user_id, floor_code, event_type) VALUES (?, ?, 'login')").run(uid, floor.code);
  socket.join('floor:' + floor.code);

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
    if (text !== undefined) p.statusText = text;
    db.prepare(`UPDATE positions SET status=?, status_text=?, updated_at=datetime('now') WHERE user_id=?`).run(s, p.statusText || '', uid);
    io.to('floor:' + p.floor).emit('user:update', { uid, x: p.x, y: p.y, status: s, status_text: p.statusText || '' });
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
    // メンバー確認
    const isMember = getDb().prepare('SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?').get(gid, uid);
    if (!isMember) return;
    const a = data && data.attach && data.attach.url ? data.attach : null;
    const attachUrl = a ? String(a.url).slice(0, 500) : null;
    const attachName = a ? String(a.name || '').slice(0, 200) : null;
    const attachSize = a ? (parseInt(a.size) || 0) : null;
    const attachType = a ? String(a.type || '').slice(0, 80) : null;
    const roomCode = 'grp_' + gid;
    const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code, attach_url, attach_name, attach_size, attach_type) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)")
      .run(uid, content, roomCode, attachUrl, attachName, attachSize, attachType);
    const payload = {
      id: ins.lastInsertRowid,
      from: uid,
      group_id: gid,
      content,
      at: new Date().toISOString(),
      attach: attachUrl ? { url: attachUrl, name: attachName, size: attachSize, type: attachType } : null,
    };
    // メンバー全員に配信 (オンラインは即、オフラインはPush)
    const members = getDb().prepare('SELECT user_id FROM chat_group_members WHERE group_id=?').all(gid);
    const senderName = (getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(uid) || {}).display_name || '';
    const groupName = (getDb().prepare('SELECT name FROM chat_groups WHERE id = ?').get(gid) || {}).name || 'グループ';
    for (const m of members) {
      const tp = presence.get(m.user_id);
      if (tp) {
        const s = io.sockets.sockets.get(tp.socketId);
        if (s) s.emit('group:msg', payload);
      }
      if (m.user_id !== uid) {
        sendPushToUser(m.user_id, {
          title: '[' + groupName + '] ' + senderName,
          body: (content || '').slice(0, 120) || '📎 添付ファイル',
          tag: 'grp-' + gid,
          url: '/?g=' + gid,
        }).catch(() => {});
      }
    }
  });

  // DM (1対1ダイレクトメッセージ、添付対応)
  socket.on('chat:dm', (data) => {
    const to = (data && data.to || '').toString();
    const content = (data && data.content || '').toString().trim().slice(0, 1000);
    if (!to || (!content && !(data && data.attach)) || to === uid) return;
    const target = getDb().prepare('SELECT id, role, dm_group, dm_rank FROM users WHERE id = ?').get(to);
    if (!target) return;
    // DM権限判定 (レポートライン保護)
    const sender = loadUserForDm(uid);
    if (!canDm(sender, target)) {
      socket.emit('dm:blocked', { to, reason: 'hierarchy', msg: 'この相手にはDMできません。上司経由でご連絡ください。' });
      return;
    }
    const a = data && data.attach && data.attach.url ? data.attach : null;
    const attachUrl = a ? String(a.url).slice(0, 500) : null;
    const attachName = a ? String(a.name || '').slice(0, 200) : null;
    const attachSize = a ? (parseInt(a.size) || 0) : null;
    const attachType = a ? String(a.type || '').slice(0, 80) : null;
    // 音声モード: 相手が取込中でも読み上げでメッセージを伝える (急ぎ連絡用)
    const voiceMode = !!(data && data.voice) && !!content;
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
              const lines = ['[社員の健康データ context — エビデンスとして根拠提示に使用]'];
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
              userMessage = lines.join('\n') + '\n\n[社員からの質問]\n' + (userMessage === content ? content : userMessage);
            } catch (e) {
              console.warn('[bot_health context fail]', e.message);
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

  // 画面共有 状態通知 (情報表示のみ)
  socket.on('screen:state', (data) => {
    const p = presence.get(uid);
    if (!p) return;
    io.to('floor:' + p.floor).emit('screen:state', { uid, on: !!(data && data.on) });
  });

  // 部屋の施錠/解錠 (会議室のみ、室内の人だけ可)
  socket.on('room:lock', (data) => {
    const p = presence.get(uid); if (!p) return;
    if (!/^(meeting|exec)/.test(p.floor)) return;
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
    if (!/^(meeting|exec)/.test(p.floor)) return;
    getDb().prepare("UPDATE floors SET locked=0, lock_pw_hash=NULL, locked_by=NULL, locked_at=NULL WHERE code=?").run(p.floor);
    io.emit('room:lockstate', { code: p.floor, locked: false });
  });

  // 承認制ON/OFF (会議室内メンバーのみ)
  socket.on('room:set-approval', (data) => {
    const p = presence.get(uid); if (!p) return;
    if (!/^(meeting|exec)/.test(p.floor)) return;
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
  socket.on('recording:state', (data) => {
    if (socket.role !== 'admin') return;
    const p = presence.get(uid);
    if (!p) return;
    io.to('floor:' + p.floor).emit('recording:state', { uid, on: !!(data && data.on) });
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
    p.status = 'offline';
    io.to('floor:' + p.floor).emit('user:update', { uid, x: p.x, y: p.y, status: 'offline' });
    io.emit('user:floor', { uid, floor: null, offline: true });
    io.emit('floor:counts', floorCountMap());
    // ログアウトアナウンス (全クライアント対象、ただし再接続を待って2秒後に発火)
    const leaverName = (db.prepare('SELECT display_name FROM users WHERE id=?').get(uid) || {}).display_name || '';
    setTimeout(() => {
      const cur = presence.get(uid);
      if (cur && cur.socketId === socket.id) {
        io.emit('user:logout', { uid, name: leaverName });
        console.log('[cohub] emit user:logout', uid, leaverName);
        presence.delete(uid);
        lastLogoutAt.set(uid, Date.now()); // 5分間は再接続のアナウンスを抑止
      }
    }, 2000);
  });
});

// 60日より古いメッセージの自動削除（毎時）
setInterval(() => {
  try {
    getDb().prepare("DELETE FROM messages WHERE created_at < datetime('now', '-60 days')").run();
  } catch (e) {}
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

server.listen(PORT, () => {
  console.log('CoWell (Communication & Wellness) サーバー起動: http://localhost:' + PORT);
});
