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
const { getDb } = require('./services/db');

// TURN サーバー認証情報を起動時に読み込み
let TURN_PASSWORD = '';
try { TURN_PASSWORD = fs.readFileSync(path.join(__dirname, '..', '.turn_password'), 'utf-8').trim(); } catch (e) {}
const TURN_HOST = process.env.TURN_HOST || '163.44.98.179';
const TURN_USER = process.env.TURN_USER || 'cohubuser';

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3007;
const PROXIMITY_RADIUS = parseInt(process.env.PROXIMITY_RADIUS || '220', 10);

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
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "wss:", "ws:", "https://cloudflareinsights.com"],
      workerSrc: ["'self'", "blob:"],
      childSrc: ["'self'", "blob:"],
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
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
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

// SPA fallback
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/mylog', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'mylog.html')));
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

// ソケット認証
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauth'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.uid = payload.uid;
    socket.role = payload.role;
    next();
  } catch (e) { next(new Error('unauth')); }
});

const presence = new Map(); // uid → { x, y, status, floor, socketId }

function allFloors() {
  return getDb().prepare('SELECT code, name, bg_image, world_w, world_h, entry_x, entry_y, sort_order, icon FROM floors ORDER BY sort_order').all();
}

function getFloor(code) {
  return getDb().prepare('SELECT code, name, bg_image, world_w, world_h, entry_x, entry_y, sort_order, icon FROM floors WHERE code = ?').get(code);
}

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
    map[p.floor] = (map[p.floor] || 0) + 1;
  }
  return map;
}

// 指定フロアに居るメンバー（+オフライン全員のメタ情報）
function floorUserList(floorCode) {
  const db = getDb();
  const users = db.prepare(`SELECT u.id, u.display_name, u.company_code, u.avatar_url, c.ring_color
    FROM users u LEFT JOIN companies c ON c.code = u.company_code`).all();
  return users.map(u => {
    const p = presence.get(u.id);
    const inFloor = p && p.status !== 'offline' && p.floor === floorCode;
    return {
      uid: u.id,
      name: u.display_name,
      company: u.company_code,
      avatar: u.avatar_url,
      ring: u.ring_color || '#333',
      x: inFloor ? p.x : null,
      y: inFloor ? p.y : null,
      status: inFloor ? p.status : 'offline',
      voice: !!(inFloor && p.voiceOn),
      floor: p ? p.floor : null,
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
  const saved = db.prepare('SELECT x, y, floor_code FROM positions WHERE user_id = ?').get(uid);
  const floorCode = (saved && saved.floor_code) || 'lobby';
  const floor = getFloor(floorCode) || getFloor('lobby');
  const pos = clampForFloor(floor, saved && saved.x, saved && saved.y);

  presence.set(uid, { x: pos.x, y: pos.y, status: 'online', floor: floor.code, socketId: socket.id });
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(uid);
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
    });
  };
  sendSnapshot();

  // 新規接続者のフル情報を同フロア既存接続者に通知
  const fullUser = floorUserList(floor.code).find(u => u.uid === uid);
  if (fullUser) socket.to('floor:' + floor.code).emit('user:join', fullUser);
  else socket.to('floor:' + floor.code).emit('user:update', { uid, x: pos.x, y: pos.y, status: 'online' });

  // 全体のフロア在席数更新を配信
  io.emit('floor:counts', floorCountMap());

  // フロア切替
  socket.on('floor:switch', (data) => {
    const targetCode = (data && data.code || '').toString();
    const target = getFloor(targetCode);
    if (!target) return;
    const p = presence.get(uid);
    if (!p) return;
    if (p.floor === target.code) return;
    const oldFloor = p.floor;
    // 音声参加中なら旧フロアから脱退扱い (クライアントはフロア切替時にdisableVoiceする)
    if (p.voiceOn) {
      p.voiceOn = false;
      io.to('floor:' + oldFloor).emit('voice:state', { uid, on: false });
    }
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
    });
    io.emit('floor:counts', floorCountMap());
  });

  // 移動
  socket.on('move', (data) => {
    const p = presence.get(uid);
    if (!p) return;
    const f = getFloor(p.floor) || floor;
    const np = clampForFloor(f, data.x, data.y);
    p.x = np.x; p.y = np.y;
    db.prepare(`INSERT INTO positions (user_id, x, y, floor_code) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET x=excluded.x, y=excluded.y, floor_code=excluded.floor_code, updated_at=datetime('now')`).run(uid, p.x, p.y, p.floor);
    io.to('floor:' + p.floor).emit('user:update', { uid, x: p.x, y: p.y, status: p.status });
  });

  // ステータス
  socket.on('status', (data) => {
    const s = ['online', '退席中', '会議中'].includes(data.status) ? data.status : 'online';
    const p = presence.get(uid); if (!p) return;
    p.status = s;
    io.to('floor:' + p.floor).emit('user:update', { uid, x: p.x, y: p.y, status: s });
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
    const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code, has_mention) VALUES (?, NULL, ?, ?, ?)").run(uid, content, sender.floor, hasMention);

    const payload = {
      id: ins.lastInsertRowid,
      uid, content,
      x: sender.x, y: sender.y,
      at: new Date().toISOString(),
      mentions,
      room: sender.floor,
    };
    io.to('floor:' + sender.floor).emit('chat:msg', payload);
  });

  // DM (1対1ダイレクトメッセージ)
  socket.on('chat:dm', (data) => {
    const to = (data && data.to || '').toString();
    const content = (data && data.content || '').toString().trim().slice(0, 1000);
    if (!to || !content || to === uid) return;
    const target = getDb().prepare('SELECT id FROM users WHERE id = ?').get(to);
    if (!target) return;
    const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')").run(uid, to, content);
    const payload = {
      id: ins.lastInsertRowid,
      from: uid,
      to,
      content,
      at: new Date().toISOString(),
    };
    socket.emit('dm:msg', payload);
    const tp = presence.get(to);
    if (tp) {
      const s = io.sockets.sockets.get(tp.socketId);
      if (s) s.emit('dm:msg', payload);
    }
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
    // 既に参加中の同フロアメンバー一覧を本人に返す (本人がofferを作る)
    const peers = [];
    for (const [u, v] of presence) {
      if (u === uid) continue;
      if (v.voiceOn && v.floor === p.floor && v.status !== 'offline') peers.push(u);
    }
    socket.emit('voice:peers', { peers });
  });

  socket.on('voice:leave', () => {
    const p = presence.get(uid);
    if (!p) return;
    p.voiceOn = false;
    io.to('floor:' + p.floor).emit('voice:state', { uid, on: false });
  });

  // シグナリング: offer / answer / ice を指定peerへ転送
  socket.on('voice:signal', (data) => {
    if (!data || !data.to) return;
    const target = presence.get(data.to);
    if (!target) return;
    const s = io.sockets.sockets.get(target.socketId);
    if (!s) return;
    s.emit('voice:signal', {
      from: uid,
      type: data.type,
      payload: data.payload,
    });
  });

  // 話者インジケータ (発話検知時)
  socket.on('voice:speaking', (data) => {
    const p = presence.get(uid);
    if (!p) return;
    io.to('floor:' + p.floor).emit('voice:speaking', { uid, on: !!(data && data.on) });
  });

  // 画面共有 状態通知 (情報表示のみ)
  socket.on('screen:state', (data) => {
    const p = presence.get(uid);
    if (!p) return;
    io.to('floor:' + p.floor).emit('screen:state', { uid, on: !!(data && data.on) });
  });

  // ホワイトボード 共同編集
  socket.on('wb:update', (data) => {
    const content = (data && data.content || '').toString().slice(0, 100000);
    const p = presence.get(uid); if (!p) return;
    const room = p.floor;
    getDb().prepare(`INSERT INTO whiteboards (room_code, content, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(room_code) DO UPDATE SET content=excluded.content, updated_by=excluded.updated_by, updated_at=datetime('now')`).run(room, content, uid);
    socket.to('floor:' + room).emit('wb:update', { content, from: uid, at: new Date().toISOString() });
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
    // 音声参加中なら切断通知
    if (p.voiceOn) {
      p.voiceOn = false;
      io.to('floor:' + p.floor).emit('voice:state', { uid, on: false });
    }
    p.status = 'offline';
    io.to('floor:' + p.floor).emit('user:update', { uid, x: p.x, y: p.y, status: 'offline' });
    io.emit('floor:counts', floorCountMap());
    setTimeout(() => {
      const cur = presence.get(uid);
      if (cur && cur.socketId === socket.id) presence.delete(uid);
    }, 2000);
  });
});

// 60日より古いメッセージの自動削除（毎時）
setInterval(() => {
  try {
    getDb().prepare("DELETE FROM messages WHERE created_at < datetime('now', '-60 days')").run();
  } catch (e) {}
}, 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log('CoHub Express サーバー起動: http://localhost:' + PORT);
});
