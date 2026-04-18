require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { getDb } = require('./services/db');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3005;
const PROXIMITY_RADIUS = parseInt(process.env.PROXIMITY_RADIUS || '220', 10);

app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:"],
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

const presence = new Map(); // uid → { x, y, status, socketId, user }

function currentUserList() {
  const db = getDb();
  const users = db.prepare(`SELECT u.id, u.display_name, u.company_code, u.avatar_url, c.ring_color
    FROM users u LEFT JOIN companies c ON c.code = u.company_code`).all();
  return users.map(u => {
    const p = presence.get(u.id);
    return {
      uid: u.id,
      name: u.display_name,
      company: u.company_code,
      avatar: u.avatar_url,
      ring: u.ring_color || '#333',
      x: p ? p.x : null,
      y: p ? p.y : null,
      status: p ? p.status : 'offline',
    };
  });
}

io.on('connection', (socket) => {
  const uid = socket.uid;
  const db = getDb();
  const pos = db.prepare('SELECT x, y FROM positions WHERE user_id = ?').get(uid) || { x: 400, y: 300 };
  presence.set(uid, { x: pos.x, y: pos.y, status: 'online', socketId: socket.id });
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(uid);

  // 初期スナップショット
  socket.emit('snapshot', { users: currentUserList(), me: uid, proximity: PROXIMITY_RADIUS });
  socket.broadcast.emit('user:update', { uid, x: pos.x, y: pos.y, status: 'online' });

  // 移動
  socket.on('move', (data) => {
    const x = Math.max(20, Math.min(1180, parseInt(data.x) || 400));
    const y = Math.max(20, Math.min(680, parseInt(data.y) || 300));
    const p = presence.get(uid);
    if (!p) return;
    p.x = x; p.y = y;
    db.prepare(`INSERT INTO positions (user_id, x, y) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET x=excluded.x, y=excluded.y, updated_at=datetime('now')`).run(uid, x, y);
    io.emit('user:update', { uid, x, y, status: p.status });
  });

  // ステータス
  socket.on('status', (data) => {
    const s = ['online', '退席中', '会議中'].includes(data.status) ? data.status : 'online';
    const p = presence.get(uid); if (!p) return;
    p.status = s;
    io.emit('user:update', { uid, x: p.x, y: p.y, status: s });
  });

  // 近接チャット（半径内にブロードキャスト）
  socket.on('chat', (data) => {
    const content = (data.content || '').toString().trim().slice(0, 500);
    if (!content) return;
    const sender = presence.get(uid);
    if (!sender) return;

    // DB保存（本人のみ閲覧）
    db.prepare('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, NULL, ?)').run(uid, content);

    const payload = { uid, content, x: sender.x, y: sender.y, at: new Date().toISOString() };
    // 近接者にだけ配信
    for (const [targetUid, p] of presence) {
      if (targetUid === uid) { socket.emit('chat:msg', payload); continue; }
      const dx = p.x - sender.x, dy = p.y - sender.y;
      if (dx * dx + dy * dy <= PROXIMITY_RADIUS * PROXIMITY_RADIUS) {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.emit('chat:msg', payload);
      }
    }
  });

  socket.on('disconnect', () => {
    const p = presence.get(uid);
    if (p) p.status = 'offline';
    io.emit('user:update', { uid, x: p ? p.x : 400, y: p ? p.y : 300, status: 'offline' });
    setTimeout(() => {
      const cur = presence.get(uid);
      if (cur && cur.socketId === socket.id) presence.delete(uid);
    }, 2000);
  });
});

// 24h より古いメッセージの自動削除（毎時）
setInterval(() => {
  try {
    getDb().prepare("DELETE FROM messages WHERE created_at < datetime('now', '-24 hours')").run();
  } catch (e) {}
}, 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log('CoHub Express サーバー起動: http://localhost:' + PORT);
});
