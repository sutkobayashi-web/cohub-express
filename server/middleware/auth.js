const jwt = require('jsonwebtoken');
const { getDb } = require('../services/db');

const JWT_SECRET = () => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');
  return process.env.JWT_SECRET;
};

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET(), { expiresIn: '30d' });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET());
}

function authUser(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, msg: '認証が必要です' });
  try {
    const payload = verifyToken(token);
    req.user = payload;
    req.uid = payload.uid;
    if (payload.sid) {
      try {
        const u = getDb().prepare('SELECT session_token FROM users WHERE id = ?').get(payload.uid);
        if (u && u.session_token && u.session_token !== payload.sid) {
          return res.status(401).json({ success: false, msg: '別端末でログインされました', code: 'SESSION_EXPIRED' });
        }
      } catch (e) {}
    }
    next();
  } catch (e) {
    res.status(401).json({ success: false, msg: 'トークンが無効です' });
  }
}

// 管理画面 (admin.html) アクセス権: role='admin' かつ employee_type='admin' (=管理職)
// 推進メンバーが role='admin' を持っていてもチャットログ等は閲覧不可にする
function authAdmin(req, res, next) {
  authUser(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
    try {
      const u = getDb().prepare('SELECT employee_type FROM users WHERE id = ?').get(req.uid);
      if (!u || u.employee_type !== 'admin') {
        return res.status(403).json({ success: false, msg: '管理職権限が必要です (employee_type=admin)' });
      }
    } catch (e) {
      return res.status(500).json({ success: false, msg: '権限確認エラー' });
    }
    next();
  });
}

module.exports = { generateToken, verifyToken, authUser, authAdmin };
