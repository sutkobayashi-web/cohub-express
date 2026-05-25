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
    // デバイス種別ごとのセッション照合 (PC1台 + モバイル1台まで併用可、同種別は新ログインで旧をキック)
    // dev 未指定 (旧トークン) の場合は互換のため session_token と照合
    if (payload.sid) {
      try {
        const u = getDb().prepare('SELECT pc_session_token, mobile_session_token, session_token, role FROM users WHERE id = ?').get(payload.uid);
        if (!u) return res.status(401).json({ success: false, msg: 'ユーザー無効' });
        // bot は照合不要 (ログインしない)
        if (u.role !== 'bot') {
          let ok = false;
          if (payload.dev === 'mobile') ok = u.mobile_session_token && u.mobile_session_token === payload.sid;
          else if (payload.dev === 'pc') ok = u.pc_session_token && u.pc_session_token === payload.sid;
          else {
            // 旧JWT互換: dev未指定なら3フィールドのいずれかに一致すればOK
            ok = (u.session_token && u.session_token === payload.sid)
              || (u.pc_session_token && u.pc_session_token === payload.sid)
              || (u.mobile_session_token && u.mobile_session_token === payload.sid);
          }
          if (!ok) {
            return res.status(401).json({ success: false, msg: '別の端末で同じアカウントがログインされたため、このセッションは終了しました', code: 'session_kicked' });
          }
        }
      } catch (e) { /* DB エラー時は通す (フェイルオープン) */ }
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
