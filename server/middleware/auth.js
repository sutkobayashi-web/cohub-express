const jwt = require('jsonwebtoken');
const { getDb } = require('../services/db');
const { trustedClientIp, ipAllowed } = require('../services/net');

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

// /uploads の認証ゲート用セッションCookie (2026-07-21)。
// <img>/<video> は Authorization ヘッダを送れないため、API呼び出しのついでに
// HttpOnly Cookie を配り、それでアップロードファイルの配信を認可する。
function setSessionCookie(req, res, sid) {
  if (!sid) return;
  try {
    if ((req.headers.cookie || '').indexOf('cohub_s=' + sid) !== -1) return;
    res.cookie('cohub_s', sid, {
      httpOnly: true, sameSite: 'lax', secure: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, path: '/',
    });
  } catch (e) { /* Cookie 発行失敗で本処理は止めない */ }
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
        const u = getDb().prepare('SELECT pc_session_token, mobile_session_token, kiosk_session_token, session_token, role FROM users WHERE id = ?').get(payload.uid);
        if (!u) return res.status(401).json({ success: false, msg: 'ユーザー無効' });
        // bot は照合不要 (ログインしない)
        if (u.role !== 'bot') {
          let ok = false;
          if (payload.dev === 'mobile') ok = u.mobile_session_token && u.mobile_session_token === payload.sid;
          // ⭐2026-08-02 (社長): 共用タブレットは専用の枠にする。以前は共用タブレットもモバイル扱いで、
          //   同じ人が『タブレット』と『自分のスマホ』を使うと互いを蹴り合い、書きかけの報告が消えていた。
          else if (payload.dev === 'kiosk') ok = u.kiosk_session_token && u.kiosk_session_token === payload.sid;
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
      setSessionCookie(req, res, payload.sid);
    }
    next();
  } catch (e) {
    res.status(401).json({ success: false, msg: 'トークンが無効です' });
  }
}

// 管理画面 (admin.html) アクセス権: 会長 + 管理部長の2名のみ (2026-07-29 会長判断でさらに限定)
//   2026-07-21 に役員5名+IT推進(立石)の6名へ限定 → 2026-07-29 に2名へ。
// role/employee_type ではなく login_id の固定リストで判定する。
// ※ home.html の ADMIN_CONSOLE_IDS (⚙️ボタン表示) と同じ内容を保つこと
const ADMIN_CONSOLE_LOGIN_IDS = new Set([
  'taketake',    // 小林 猛 (代表取締役会長)
  'y_yoshizawa', // 吉沢 佑也 (管理部長)
]);

function authAdmin(req, res, next) {
  authUser(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, msg: '管理者権限が必要です' });
    try {
      const u = getDb().prepare('SELECT employee_type, login_id, display_name FROM users WHERE id = ?').get(req.uid);
      if (!u || u.employee_type !== 'admin') {
        return res.status(403).json({ success: false, msg: '管理職権限が必要です (employee_type=admin)' });
      }
      if (!ADMIN_CONSOLE_LOGIN_IDS.has(u.login_id)) {
        require('../services/audit').audit(req, 'admin_denied', { actor_name: u.display_name, target: `login_id=${u.login_id}` });
        return res.status(403).json({ success: false, msg: '管理画面は限定メンバーのみ利用できます' });
      }
    } catch (e) {
      return res.status(500).json({ success: false, msg: '権限確認エラー' });
    }
    next();
  });
}

// Cookie(またはBearer)で「ログイン済みか」だけを判定する。/uploads 配信ゲート用。
function hasValidSession(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)cohub_s=([A-Za-z0-9._-]+)/);
  const sid = m && m[1];
  if (sid) {
    try {
      const u = getDb().prepare(
        'SELECT 1 FROM users WHERE pc_session_token = ? OR mobile_session_token = ? OR session_token = ?'
      ).get(sid, sid, sid);
      if (u) return true;
    } catch (e) { /* 判定不能時は下の Bearer 判定へ */ }
  }
  const bearer = (req.headers.authorization || '').replace('Bearer ', '');
  if (bearer) { try { verifyToken(bearer); return true; } catch (e) { /* 無効 */ } }
  return false;
}

// 事業所ネットワークからのアクセスか (.env TABLET_SETUP_ALLOW_IPS・前方一致)。
// ⚠️ログイン前に社員名簿を出す画面(共用タブレットの名前選択)を社外から叩かせないための判定。
//   routes/auth.js の isSetupAllowedIp と同じ土俵。どちらかを直したらもう一方も直すこと。
//   未設定なら true (締め出し事故の防止) — 設定漏れは "守れていない" ので運用で確認する。
function officeIp(req) {
  const list = String(process.env.TABLET_SETUP_ALLOW_IPS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return true;
  return ipAllowed(trustedClientIp(req), list);   // ⚠️X-Forwarded-Forは信じない(services/net.js参照)
}

// Cookie(またはBearer)から「誰か」を引く。静的ファイルの配信ゲート用
// (hasValidSession は可否だけなので、本人を見て出し分けたい時はこちら)。
// ⚠️共用タブレットは kiosk_session_token を使うのでここも見る。
function sessionUserId(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)cohub_s=([A-Za-z0-9._-]+)/);
  const sid = m && m[1];
  if (sid) {
    try {
      const u = getDb().prepare(
        `SELECT id FROM users WHERE pc_session_token = ? OR mobile_session_token = ?
           OR kiosk_session_token = ? OR session_token = ?`).get(sid, sid, sid, sid);
      if (u) return u.id;
    } catch (e) { /* Bearer 判定へ */ }
  }
  const bearer = (req.headers.authorization || '').replace('Bearer ', '');
  if (bearer) { try { return verifyToken(bearer).uid || null; } catch (e) { /* 無効 */ } }
  return null;
}

module.exports = { generateToken, verifyToken, authUser, authAdmin, setSessionCookie, hasValidSession, sessionUserId, officeIp };
