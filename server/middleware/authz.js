// ===== 認可の中央集約 (2026-07-21) =====
// 背景: 594あるAPIの窓口のうち 525 が `authUser`(ログイン済みなら誰でも通る)だけで守られており、
// 「誰が見てよいか」は各実装任せだった。その結果、権限外の情報が広範に閲覧できていた。
//
// ここは「入口の粗い権限」を1か所で宣言して強制するための層。
// データ行単位の絞り込み(自分の分だけ/自拠点だけ)は各routeの責務で、この層では扱わない。
//
// 使い方: POLICY に { re, need } を足す。enforce:false の間は遮断せず記録だけ行うので、
//   ①検知モードで実利用を観測 → ②誰も困らないと確認 → ③enforce:true に切替
// という順で安全に締められる。
const { getDb } = require('../services/db');
const { audit } = require('../services/audit');
const { verifyToken } = require('./auth');

function ctxOf(uid) {
  const u = getDb().prepare(
    `SELECT id, display_name, company_code, employee_type, role, is_manager, is_branch_head,
            is_ops_manager, is_field_promoter, is_warehouse_promoter, is_guest_reviewer
       FROM users WHERE id = ?`).get(uid);
  if (!u) return null;
  u.is_mgr = !!(u.is_manager || u.employee_type === 'admin' || u.role === 'admin');
  u.is_hq = u.company_code === 'ADMIN';
  u.is_promoter = !!(u.is_field_promoter || u.is_warehouse_promoter);
  u.is_guest = !!u.is_guest_reviewer;
  return u;
}

// need: (ctx) => true で許可
// ⚠️社外ゲスト(is_guest_reviewer)は、たとえ role='admin' 等のフラグを持っていても
// 管理職とは見なさない。実際に大学のゲスト1名が role='admin' を保持しており、
// 各所の isManager() 判定(role==='admin' を管理職とみなす実装)を通過していた。
const NEED = {
  manager: c => !!c && c.is_mgr && !c.is_guest,
  managerOrPromoter: c => !!c && (c.is_mgr || c.is_promoter) && !c.is_guest,
  notGuest: c => !!c && !c.is_guest,
};

// ⚠️ 上から順に最初に一致したものを適用する
const POLICY = [
  // 関東BC (別会社の業務データ: 日報・クレーム・荷主向け事故報告・改善施策)。
  // 一般社員に開いている必要が無い。検知モードで実利用を観測してから締める。
  { re: /^\/kbc(\/|$)/, need: NEED.manager, enforce: false, label: 'kbc' },

  // 事故アーカイブ / AI分析。
  // ⭐2026-08-02 (社長): 過去事例は『同じ原因を繰り返さない』ための教材なので、**閲覧は全社員**に開放。
  //   取込済み93件は氏名が伏字(対象者: 中● 等)・電話番号なしであることを確認済み。
  //   ⚠️登録/削除(POST/DELETE)は管理職のまま。今後アップされるPDFに未処理の個人情報が混じり得るため。
  //   ⚠️AI分析(analysis)は経営判断向けの傾向分析なので管理職のまま。
  //   ⭐2026-08-03 (社長): 共同研究の閲覧アカウントは参照だけ許可 (氏名は研究閲覧モードで匿名化)。
  { re: /^\/accident\/archive(\/|$)/, methods: ['GET'], need: NEED.notGuest, enforce: true, label: 'accident-archive-read' },
  { re: /^\/accident\/(archive|analysis)(\/|$)/, need: NEED.manager, enforce: true, label: 'accident-archive' },

  // 全拠点のWi-Fi設定(パスワード平文)。利用実績ゼロ。社外ゲストにも見えていた。
  { re: /^\/branch-wifi\/list$/, need: NEED.notGuest, enforce: true, label: 'branch-wifi' },
];

// ============================================================
// 研究閲覧モード (社外ゲスト) — 2026-08-03 社長判断
//  帝京大学との共同研究で「アプリの全機能を見てもらう」ため、社外ゲスト(is_guest_reviewer)に
//  各画面を開ける。ただし研究利用の同意は161名中15名しか取れていないので、次の2点を
//  **各画面の実装に依存せず、この1か所で機械的に**強制する。
//   ① 書き込み一切不可 (GET以外は403。ログイン/読み上げ等の最小限だけ許可)
//   ② レスポンスに出る社員の氏名は必ずニックネームへ置換・顔写真は外す
//  ⚠️置換はフィールド名に頼らず、文字列の中身(memo/チャット本文など)まで全部見る。
//    氏名は本文に埋め込まれて出てくる(例:「【自己チェック】○○さんの体調」)ため。
//  既読の記録だけは許す (2026-08-04 社長判断)。止めると未読バッジが永久に消えず
//  「壊れている」と見えるため。⚠️発言・投稿・承認など内容を変える書き込みは従来どおり禁止。
//  ・POST /chat/read           = 自分がどこまで読んだかの記録
//  ・POST /chat/messages/readers-bulk = 既読者の一覧取得(POSTだが中身は参照のみ)
const GUEST_WRITE_ALLOW = [
  /^\/auth(\/|$)/, /^\/voice(\/|$)/, /^\/usage(\/|$)/,
  /^\/chat\/read$/, /^\/chat\/messages\/readers-bulk$/,
];
const GUEST_DROP_KEYS = ['avatar_url', 'subject_avatar', 'poster_avatar', 'avatar', 'login_id'];

let _maskCache = { at: 0, re: null, map: null };
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function nameVariants(n) {
  const s = String(n).trim();
  return [...new Set([s, s.replace(/[　\s]+/g, ' '), s.replace(/[　\s]+/g, '')])];
}
// 氏名→ニックネームの置換表。60秒キャッシュ(社員追加/改名に追随する程度で十分)。
function nameMasker() {
  const now = Date.now();
  if (_maskCache.re !== null && now - _maskCache.at < 60000) return _maskCache;
  let rows = [];
  try {
    // ⚠️botは対象外。葵・ヘルスアドバイザー・健康推進室などの名前まで置換すると本文が壊れる
    //   (「健康推進室より」→「社員bot_より」)。個人情報でもない。
    rows = getDb().prepare(
      `SELECT id, display_name, nickname FROM users
       WHERE COALESCE(display_name,'') <> '' AND COALESCE(role,'') <> 'bot' AND id NOT LIKE 'bot_%'`).all();
  } catch (e) { rows = []; }
  const map = new Map();
  const owner = new Map();          // 表記 → その表記を持つ人のid集合 (姓の重複を見るため)
  const put = (k, r, alias) => {
    if (!k || k.length < 2) return;
    const o = owner.get(k) || new Set(); o.add(r.id); owner.set(k, o);
    // ⚠️同じ姓の人が複数いる表記は、特定の誰かのニックネームに寄せず「社員」にする
    //   (「鈴木さん」を実在の別人のニックネームに置換すると読み手を誤解させる)
    map.set(k, o.size > 1 ? '社員' : alias);
  };
  for (const r of rows) {
    const alias = (r.nickname && String(r.nickname).trim()) || ('社員' + String(r.id).slice(0, 4));
    for (const v of nameVariants(r.display_name)) put(v, r, alias);
    // ⚠️姓だけ・名だけの表記も必ず潰す。葵の挨拶やAIの返答は「立石さん」のように姓しか
    //   使わないため、フルネームだけ見ていると素通りしていた (2026-08-03 社長の確認で発覚)。
    for (const p of String(r.display_name).split(/[\s　]+/)) put(p, r, alias);
  }
  // 長い表記から先に当てる (「立石　宗貴」を「立石」より優先)
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  _maskCache = { at: now, map, re: keys.length ? new RegExp(keys.map(escapeRe).join('|'), 'g') : null };
  return _maskCache;
}
function maskDeep(v, mk, key) {
  if (v == null) return v;
  if (typeof v === 'string') {
    if (GUEST_DROP_KEYS.indexOf(key) >= 0) return '';
    return mk.re ? v.replace(mk.re, m => mk.map.get(m) || m) : v;
  }
  if (Array.isArray(v)) return v.map(x => maskDeep(x, mk));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = maskDeep(v[k], mk, k);
    return out;
  }
  return v;
}

// この層は各routeの authUser より前に走るため、req.uid はまだ無い。
// ここではトークンを「読むだけ」で本人を特定する (認証の可否は各routeの authUser が判定する)。
function peekUid(req) {
  if (req.uid) return req.uid;
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return null;
  try { return verifyToken(t).uid || null; } catch (e) { return null; }
}

function policyGate(req, res, next) {
  const uid = peekUid(req);
  // 未ログインは各routeの authUser に任せる (ここでは判定しない)
  if (!uid) return next();
  req.uid = req.uid || uid;
  const p = req.path || '';
  let ctx = null;
  try { ctx = ctxOf(req.uid); } catch (e) { ctx = null; }      // 判定不能時は既存動作を優先

  // --- 研究閲覧モード: 社外ゲストは「読むだけ・氏名は匿名」を全APIで強制 ---
  if (ctx && ctx.is_guest) {
    if (req.method !== 'GET' && !GUEST_WRITE_ALLOW.some(re => re.test(p))) {
      audit(req, 'guest_write_block', { actor_name: ctx.display_name, target: req.method + ' ' + p });
      return res.status(403).json({ success: false, msg: '研究閲覧アカウントのため、記録・変更はできません（閲覧のみ）' });
    }
    const origJson = res.json.bind(res);
    res.json = (body) => {
      try { return origJson(maskDeep(body, nameMasker())); }
      catch (e) { console.warn('[guest-mask]', e.message); return origJson(body); }
    };
  }

  const rule = POLICY.find(r => r.re.test(p) && (!r.methods || r.methods.indexOf(req.method) >= 0));
  if (!rule) return next();
  if (rule.need(ctx)) return next();

  if (rule.enforce) {
    audit(req, 'authz_block', { actor_name: ctx && ctx.display_name, target: rule.label + ' ' + req.method + ' ' + p });
    return res.status(403).json({ success: false, msg: 'この情報を閲覧する権限がありません' });
  }
  // 検知モード: 遮断せず記録だけ (どの権限の人が実際に使っているかを観測する)
  console.warn('[authz-detect]', rule.label, req.method, p, 'uid=' + req.uid,
    'mgr=' + (ctx && ctx.is_mgr), 'co=' + (ctx && ctx.company_code));
  return next();
}

// ソケット配信など res.json を通らない経路から使う匿名化 (index.js の研究閲覧ソケット)
function maskForGuest(payload) {
  try { return maskDeep(payload, nameMasker()); } catch (e) { return payload; }
}

module.exports = { policyGate, ctxOf, NEED, POLICY, maskForGuest };
