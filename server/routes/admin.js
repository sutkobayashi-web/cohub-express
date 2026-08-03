const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('../services/db');
const { authAdmin } = require('../middleware/auth');
const { transcribeRecording } = require('../services/ai');
const { audit } = require('../services/audit');

// === dm_group → 自動グループチャット同期 ===
// dm_group ラベルと同名の chat_groups を自動作成 + 同ラベルの全ユーザーをメンバーに
function syncDmGroupMembership(uid, newDmGroup, oldDmGroup, byUid) {
  const db = getDb();
  const ndg = (newDmGroup || '').toString().trim() || null;
  const odg = (oldDmGroup || '').toString().trim() || null;
  if (ndg === odg) return;
  // 旧グループから離脱
  if (odg) {
    const og = db.prepare('SELECT id FROM chat_groups WHERE name = ?').get(odg);
    if (og) db.prepare('DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?').run(og.id, uid);
  }
  // 新グループに加入 (なければ作成 + 同ラベル既存ユーザー全員バックフィル)
  if (ndg) {
    let g = db.prepare('SELECT id FROM chat_groups WHERE name = ?').get(ndg);
    if (!g) {
      const gid = crypto.randomUUID();
      db.prepare('INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)')
        .run(gid, ndg, '🏷', byUid || null);
      g = { id: gid };
      // 同じ dm_group を持つ既存ユーザーを全員バックフィル
      const peers = db.prepare('SELECT id FROM users WHERE dm_group = ?').all(ndg);
      const ins = db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)');
      for (const p of peers) ins.run(g.id, p.id);
    }
    db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(g.id, uid);
  }
}

const recDir = path.join(__dirname, '..', '..', 'uploads', 'recordings');
if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });
const recUpload = multer({
  storage: multer.diskStorage({
    destination: recDir,
    filename: (req, file, cb) => cb(null, Date.now() + '_' + (req.uid || 'anon').slice(0, 8) + '.webm'),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ユーザー一覧 (AIボットはインフラなので非表示。削除しても ensureConciergeBots が再生成するため、UIに出さない)
router.get('/users', authAdmin, (req, res) => {
  const rows = getDb().prepare(`SELECT u.id, u.login_id, u.display_name, u.company_code, u.role, u.employee_type, u.job_role, u.dm_group, u.dm_rank, u.dm_restricted, u.avatar_url, u.birth_date, u.is_guest_reviewer, u.guest_org, u.is_field_promoter, u.is_warehouse_promoter, u.is_manager, u.is_ops_manager, u.is_branch_head,
    CASE WHEN u.tablet_pin_hash IS NOT NULL AND u.tablet_pin_hash <> '' THEN 1 ELSE 0 END AS has_tablet_pin,
    CASE WHEN EXISTS(SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = u.id) THEN 1 ELSE 0 END AS has_push,
    u.last_seen_at, p.status FROM users u LEFT JOIN positions p ON p.user_id = u.id WHERE u.role != 'bot' ORDER BY u.created_at DESC`).all();
  res.json({ success: true, users: rows });
});

// プッシュ通知のカバレッジ (未購読者の可視化・フォロー用)
router.get('/push-coverage', authAdmin, (req, res) => {
  const db = getDb();
  const members = db.prepare("SELECT COUNT(*) c FROM users WHERE role != 'bot'").get().c;
  const subscribed = db.prepare('SELECT COUNT(DISTINCT user_id) c FROM push_subscriptions').get().c;
  const unsubscribed = db.prepare(`SELECT display_name, company_code FROM users
    WHERE role != 'bot' AND id NOT IN (SELECT user_id FROM push_subscriptions)
    ORDER BY company_code, display_name`).all();
  res.json({ success: true, members, subscribed, rate: members ? Math.round(subscribed / members * 100) : 0, unsubscribed });
});

// 監査ログ閲覧 (直近・管理者のみ)。?action=login 等で絞り込み可
router.get('/audit', authAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const action = req.query.action ? String(req.query.action).slice(0, 60) : null;
  try {
    const db = getDb();
    const sql = "SELECT id, actor_id, actor_name, action, target, ip, datetime(created_at,'+9 hours') AS jst FROM audit_log"
      + (action ? ' WHERE action = ?' : '') + ' ORDER BY id DESC LIMIT ?';
    const rows = action ? db.prepare(sql).all(action, limit) : db.prepare(sql).all(limit);
    res.json({ success: true, entries: rows });
  } catch (e) { res.json({ success: true, entries: [], note: '監査ログはまだありません' }); }
});

function normalizeRank(r) {
  const n = parseInt(r);
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(3, n));
}

// 生年月日のバリデーション → 常に YYYY-MM-DD に正規化して返す
// Excelが CSV の "1900-01-01" を勝手に "1900/01/01" や "1900.1.1" に変換してしまう問題に対応し、
// 区切りは - / . のいずれも許容する (年が先頭の YYYY 区切り MM 区切り DD 形式)。
function normalizeBirthDate(s) {
  if (s === null || s === undefined) return null;
  const str = String(s).trim();
  if (!str) return null;
  const m = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  const y = parseInt(m[1]), mo = parseInt(m[2]), d = parseInt(m[3]);
  if (y < 1900 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// ユーザー作成（1件）
router.post('/users', authAdmin, (req, res) => {
  const { login_id, display_name, company_code, password, role, employee_type, job_role, dm_group, dm_rank, dm_restricted, birth_date, is_guest_reviewer, guest_org } = req.body;
  if (!login_id || !display_name || !company_code || !password) {
    return res.status(400).json({ success: false, msg: '必須項目が不足しています' });
  }
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(login_id);
  if (exists) return res.status(400).json({ success: false, msg: 'このログインIDは既に使われています' });
  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync(password, 10);
  // 職種 (job_role): 既知の5職種のみ許可。管理職は etype で表現するため job_role は職務の方を保持。
  const jr = JOB_ROLES_BULK[job_role] ? job_role : null;
  // employee_type は明示指定優先。未指定かつ職種があれば職種から導出 (現場系→field / 事務→office)。
  const etype = (employee_type === 'field' || employee_type === 'admin') ? employee_type
              : (jr ? JOB_ROLES_BULK[jr] : 'office');
  const dg = (dm_group || '').toString().trim().slice(0, 40) || null;
  const dr = normalizeRank(dm_rank);
  const bd = normalizeBirthDate(birth_date);
  const guest = is_guest_reviewer ? 1 : 0;
  const gorg = (guest_org || '').toString().trim().slice(0, 100) || null;
  // DM制限: 明示指定なし & 一般社員(member + non-admin etype + non-guest) なら デフォルトON
  const isPlainMember = (role || 'member') === 'member' && etype !== 'admin' && !guest;
  const dmr = (dm_restricted === undefined || dm_restricted === null) ? (isPlainMember ? 1 : 0) : (dm_restricted ? 1 : 0);
  db.prepare(`INSERT INTO users (id, login_id, password_hash, display_name, company_code, role, employee_type, job_role, dm_group, dm_rank, dm_restricted, birth_date, is_guest_reviewer, guest_org)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, login_id, hash, display_name, company_code, role || 'member', etype, jr, dg, dr, dmr, bd, guest, gorg);
  // dm_group が設定されてれば同名グループチャットに自動加入 (なければ作成)
  try { syncDmGroupMembership(id, dg, null, req.uid); } catch (e) { console.warn('[dm_group sync]', e.message); }
  res.json({ success: true, id });
});

// ユーザー更新 (dm_group, dm_rank 等の編集)
router.patch('/users/:id', authAdmin, (req, res) => {
  const { display_name, company_code, role, employee_type, job_role, dm_group, dm_rank, dm_restricted, birth_date, is_guest_reviewer, guest_org, is_field_promoter, is_warehouse_promoter, is_manager, is_ops_manager, is_branch_head } = req.body;
  const db = getDb();
  const u = db.prepare('SELECT id, dm_group FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ success: false, msg: 'ユーザーが見つかりません' });
  const oldDmGroup = u.dm_group;
  const updates = [];
  const params = [];
  if (display_name !== undefined) { updates.push('display_name = ?'); params.push(String(display_name).slice(0, 80)); }
  if (company_code !== undefined) { updates.push('company_code = ?'); params.push(String(company_code).slice(0, 20)); }
  if (role !== undefined) { updates.push('role = ?'); params.push(role === 'admin' ? 'admin' : 'member'); }
  if (employee_type !== undefined) {
    const etype = (employee_type === 'field' || employee_type === 'admin') ? employee_type : 'office';
    updates.push('employee_type = ?'); params.push(etype);
  }
  if (job_role !== undefined) {
    const jr = JOB_ROLES_BULK[job_role] ? job_role : null;
    updates.push('job_role = ?'); params.push(jr);
  }
  if (dm_group !== undefined) {
    const dg = (dm_group || '').toString().trim().slice(0, 40) || null;
    updates.push('dm_group = ?'); params.push(dg);
  }
  if (dm_rank !== undefined) {
    updates.push('dm_rank = ?'); params.push(normalizeRank(dm_rank));
  }
  if (birth_date !== undefined) {
    updates.push('birth_date = ?'); params.push(birth_date === null || birth_date === '' ? null : normalizeBirthDate(birth_date));
  }
  if (is_guest_reviewer !== undefined) {
    updates.push('is_guest_reviewer = ?'); params.push(is_guest_reviewer ? 1 : 0);
  }
  if (guest_org !== undefined) {
    updates.push('guest_org = ?'); params.push((guest_org || '').toString().trim().slice(0, 100) || null);
  }
  if (dm_restricted !== undefined) {
    updates.push('dm_restricted = ?'); params.push(dm_restricted ? 1 : 0);
  }
  if (is_field_promoter !== undefined) {
    updates.push('is_field_promoter = ?'); params.push(is_field_promoter ? 1 : 0);
  }
  if (is_manager !== undefined) {
    updates.push('is_manager = ?'); params.push(is_manager ? 1 : 0);
  }
  if (is_warehouse_promoter !== undefined) {
    updates.push('is_warehouse_promoter = ?'); params.push(is_warehouse_promoter ? 1 : 0);
  }
  if (is_ops_manager !== undefined) {
    updates.push('is_ops_manager = ?'); params.push(is_ops_manager ? 1 : 0);
  }
  if (is_branch_head !== undefined) {
    updates.push('is_branch_head = ?'); params.push(is_branch_head ? 1 : 0);
  }
  if (updates.length === 0) return res.json({ success: true });
  params.push(req.params.id);
  db.prepare('UPDATE users SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
  // dm_group が変わった場合のみグループ所属を再同期
  if (dm_group !== undefined) {
    const newDg = (dm_group || '').toString().trim() || null;
    if (newDg !== oldDmGroup) {
      try { syncDmGroupMembership(req.params.id, newDg, oldDmGroup, req.uid); } catch (e) { console.warn('[dm_group sync]', e.message); }
    }
  }
  // 推進メンバーフラグが変わった場合は対応するGCに自動加入させる
  try {
    const db2 = getDb();
    const memInsert = db2.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)');
    if (is_field_promoter === true || is_field_promoter === 1) {
      memInsert.run('g_field_voice', req.params.id);
      memInsert.run('g_wellness_disc', req.params.id);
    }
    if (is_warehouse_promoter === true || is_warehouse_promoter === 1) {
      // 倉庫推進メンバーも統合後の現場の声 (g_field_voice) に加入
      memInsert.run('g_field_voice', req.params.id);
    }
  } catch (e) { console.warn('[promoter GC sync]', e.message); }
  res.json({ success: true });
});

// CSV一括登録
// フォーマット: login_id,display_name,company_code,password[,role[,employee_type[,dm_group[,dm_rank]]]]
// 全ユーザーの dm_group を権威的に一括同期
// - dm_group が設定されているユーザーは同名のチャットグループに加入
// - 旧 dm_group の(別名)チャットグループからは離脱
// - dm_group 未設定のユーザーはdm_group由来のGCから全離脱
// - 特殊GC (g_* プレフィックス) と「X 現場」suffix GC は触らない
// - 孤立メンバーシップ (削除済みユーザー残骸) を掃除
// - 空かつ現役dm_groupに無いdm_group由来GCを削除
router.post('/sync-dm-groups', authAdmin, (req, res) => {
  const db = getDb();

  // dm_group由来GCの判定: id が g_* で始まらないもの (= 通常のdm_group同期対象)
  const isDmDerivedGroup = (g) => {
    if (!g) return false;
    if (g.id && g.id.startsWith('g_')) return false;
    return true;
  };

  // ユーザー一覧 (bot除外)
  const users = db.prepare("SELECT id, dm_group FROM users WHERE role != 'bot'").all();
  const activeDmGroups = new Set(users.map(u => u.dm_group).filter(Boolean));

  // 既存の dm_group 由来チャットグループ と name→id マップ
  const allGroups = db.prepare('SELECT id, name FROM chat_groups').all();
  const dmGroupSet = new Set();
  const groupByName = {};
  for (const g of allGroups) {
    if (!isDmDerivedGroup(g)) continue;
    dmGroupSet.add(g.id);
    if (g.name) groupByName[g.name] = g.id;
  }

  let added = 0, removed = 0, created = 0, orphans = 0, deletedGroups = 0;

  const txn = db.transaction(() => {
    // STEP 1: 孤立メンバーシップ掃除 (削除済みユーザーが残してた行)
    orphans = db.prepare('DELETE FROM chat_group_members WHERE user_id NOT IN (SELECT id FROM users)').run().changes;

    // STEP 2: ユーザーごとに正しいdm_group GCに揃える
    for (const u of users) {
      let expectedGid = null;
      if (u.dm_group) {
        expectedGid = groupByName[u.dm_group];
        // GC未作成なら作成
        if (!expectedGid) {
          expectedGid = crypto.randomUUID();
          db.prepare('INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)')
            .run(expectedGid, u.dm_group, '🏷', req.uid);
          groupByName[u.dm_group] = expectedGid;
          dmGroupSet.add(expectedGid);
          created++;
        }
      }

      // 現在加入グループ
      const currentGids = db.prepare('SELECT group_id FROM chat_group_members WHERE user_id = ?').all(u.id).map(r => r.group_id);
      // dm_group由来GCで expectedGid 以外から離脱
      for (const gid of currentGids) {
        if (!dmGroupSet.has(gid)) continue;
        if (gid === expectedGid) continue;
        db.prepare('DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?').run(gid, u.id);
        removed++;
      }
      // 期待GCに未加入なら追加
      if (expectedGid && !currentGids.includes(expectedGid)) {
        db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(expectedGid, u.id);
        added++;
      }
    }

    // STEP 3: 空かつ現役dm_groupに無いdm_group由来GCを削除
    for (const g of allGroups) {
      if (!isDmDerivedGroup(g)) continue;
      if (activeDmGroups.has(g.name)) continue;
      const cnt = db.prepare('SELECT COUNT(*) AS n FROM chat_group_members WHERE group_id = ?').get(g.id).n;
      if (cnt === 0) {
        db.prepare('DELETE FROM chat_groups WHERE id = ?').run(g.id);
        deletedGroups++;
      }
    }
  });
  txn();

  res.json({ success: true, total: users.length, added, removed, created, orphans, deletedGroups });
});

// パスワードリセット
router.post('/users/:id/password', authAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ success: false, msg: 'パスワードを指定してください' });
  const hash = bcrypt.hashSync(password, 10);
  const r = getDb().prepare('UPDATE users SET password_hash = ?, session_token = NULL, pc_session_token = NULL, mobile_session_token = NULL WHERE id = ?').run(hash, req.params.id);
  res.json({ success: r.changes > 0 });
});

// ============================================================
// 設置端末(共用タブレット)の一覧・失効 (2026-08-04)
//  端末トークンを持つ端末は、事業所ネットワークの外からでも名前選択画面(=氏名一覧)を開ける。
//  盗難・廃棄・入れ替えのときに管理側から止められないと、その口が開いたままになる。
// ============================================================
router.get('/kiosk-devices', authAdmin, (req, res) => {
  const db = getDb();
  require('../services/net').ensureDeviceTable(db);
  const rows = db.prepare(`SELECT d.id, d.company_code, d.label, d.created_at, d.created_ip,
      d.last_seen_at, d.last_seen_ip, d.revoked_at, c.name AS company_name
    FROM kiosk_devices d LEFT JOIN companies c ON c.code = d.company_code
    ORDER BY d.revoked_at IS NOT NULL, COALESCE(d.last_seen_at, d.created_at) DESC`).all();
  res.json({ success: true, devices: rows });
});
router.post('/kiosk-devices/:id/revoke', authAdmin, (req, res) => {
  const db = getDb();
  require('../services/net').ensureDeviceTable(db);
  const undo = !!(req.body && req.body.undo);
  const r = db.prepare(`UPDATE kiosk_devices SET revoked_at = ${undo ? 'NULL' : "datetime('now')"} WHERE id = ?`)
    .run(req.params.id);
  if (!r.changes) return res.status(404).json({ success: false, msg: '端末が見つかりません' });
  require('../services/audit').audit(req, undo ? 'device_unrevoke' : 'device_revoke', { target: 'device=' + req.params.id });
  res.json({ success: true, msg: undo ? '端末の登録を戻しました' : '端末を失効しました' });
});

// ============================================================
// 端末のログアウト = セッション失効 (2026-08-04)
//  紛失・盗難・退職のときに「その人の端末から見えなくする」手段が無く、
//  パスワードを強制変更するしか止める方法が無かった(本人にも影響が出る)。
//  ⚠️CoHubは端末にデータを持たない(表示のたびにサーバーから取る)ので、
//    セッションを切れば その端末からは何も見えなくなる=これが遠隔消去の代わりになる。
//  ⚠️PIN・パスワードは変えない。本人は次に自分でログインし直せば元どおり使える。
// ============================================================
router.post('/users/:id/logout-devices', authAdmin, (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ success: false, msg: '対象が見つかりません' });
  const scope = String((req.body && req.body.scope) || 'all');   // all | pc | mobile | kiosk
  const cols = scope === 'pc' ? ['pc_session_token']
    : scope === 'mobile' ? ['mobile_session_token']
    : scope === 'kiosk' ? ['kiosk_session_token']
    : ['session_token', 'pc_session_token', 'mobile_session_token', 'kiosk_session_token'];
  db.prepare(`UPDATE users SET ${cols.map(c => c + ' = NULL').join(', ')} WHERE id = ?`).run(u.id);
  require('../services/audit').audit(req, 'force_logout', { target: `uid=${u.id} scope=${scope}` });
  res.json({ success: true, msg: u.display_name + ' の端末をログアウトしました (' + scope + ')' });
});

// タブレットPIN管理者発行/リセット (2026-05-12)
// body: { pin: '0000-9999' } または { clear: true } で削除
router.post('/users/:id/tablet-pin', authAdmin, (req, res) => {
  const { pin, clear } = req.body || {};
  const db = getDb();
  if (clear) {
    const r = db.prepare('UPDATE users SET tablet_pin_hash = NULL WHERE id = ?').run(req.params.id);
    return res.json({ success: r.changes > 0, msg: 'PINを削除しました' });
  }
  if (!pin || !/^\d{4}$/.test(String(pin))) return res.status(400).json({ success: false, msg: 'PINは4桁の数字' });
  const hash = bcrypt.hashSync(String(pin), 10);
  const r = db.prepare('UPDATE users SET tablet_pin_hash = ? WHERE id = ?').run(hash, req.params.id);
  res.json({ success: r.changes > 0, msg: 'タブレットPINを発行しました' });
});

// ユーザー削除
router.delete('/users/:id', authAdmin, (req, res) => {
  const db = getDb();
  // AIボット (role=bot) はチャット基盤として常駐させる必要があるため削除不可
  const tgt = db.prepare('SELECT role FROM users WHERE id = ?').get(req.params.id);
  if (tgt && tgt.role === 'bot') {
    return res.status(400).json({ success: false, msg: 'AIボットはシステム必須のため削除できません' });
  }
  db.prepare('DELETE FROM positions WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').run(req.params.id, req.params.id);
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: r.changes > 0 });
});

// ========== 一括操作 (2026-05-08) ==========
// 未使用アカウント抽出: last_seen_at が指定日数以上前 or 一度もログインしていない
router.get('/users/inactive', authAdmin, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
  const sinceISO = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const db = getDb();
  const rows = db.prepare(`SELECT u.id, u.login_id, u.display_name, u.company_code, u.role, u.dm_group,
    u.last_seen_at, u.created_at,
    (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS msg_count,
    julianday('now') - julianday(COALESCE(u.last_seen_at, u.created_at)) AS days_since
    FROM users u WHERE u.role != 'bot'
      AND (u.last_seen_at IS NULL OR u.last_seen_at < ?)
    ORDER BY u.last_seen_at ASC`).all(sinceISO);
  res.json({ success: true, days, count: rows.length, users: rows });
});

// 一括 dm_group 変更
router.post('/users/bulk-update-group', authAdmin, express.json(), (req, res) => {
  const ids = Array.isArray(req.body && req.body.user_ids) ? req.body.user_ids : [];
  const newGroup = (req.body && req.body.dm_group !== undefined) ? (String(req.body.dm_group || '').trim().slice(0, 40) || null) : undefined;
  if (newGroup === undefined) return res.status(400).json({ success: false, msg: 'dm_group 未指定' });
  if (ids.length === 0) return res.status(400).json({ success: false, msg: '対象ユーザーなし' });
  const db = getDb();
  let changed = 0;
  db.transaction(() => {
    for (const uid of ids) {
      const u = db.prepare('SELECT id, dm_group FROM users WHERE id = ? AND role != ?').get(uid, 'bot');
      if (!u) continue;
      const oldDg = u.dm_group;
      db.prepare('UPDATE users SET dm_group = ? WHERE id = ?').run(newGroup, uid);
      try { syncDmGroupMembership(uid, newGroup, oldDg, req.uid); } catch (e) { console.warn('[bulk dm_group sync]', uid, e.message); }
      changed++;
    }
  })();
  res.json({ success: true, changed });
});

// 一括削除 (関連メッセージも消える)
router.post('/users/bulk-delete', authAdmin, express.json(), (req, res) => {
  const ids = Array.isArray(req.body && req.body.user_ids) ? req.body.user_ids : [];
  if (ids.length === 0) return res.status(400).json({ success: false, msg: '対象ユーザーなし' });
  // 自分自身は弾く (ロックアウト防止)
  const filtered = ids.filter(x => x !== req.uid);
  if (filtered.length === 0) return res.status(400).json({ success: false, msg: '自分自身は削除できません' });
  const db = getDb();
  let deleted = 0;
  db.transaction(() => {
    for (const uid of filtered) {
      const u = db.prepare("SELECT id, role FROM users WHERE id = ? AND role != 'bot'").get(uid);
      if (!u) continue;
      db.prepare('DELETE FROM positions WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').run(uid, uid);
      db.prepare('DELETE FROM chat_group_members WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM message_reads WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM users WHERE id = ?').run(uid);
      deleted++;
    }
  })();
  res.json({ success: true, deleted, skipped: ids.length - filtered.length });
});

// ============================================================
// CSV 一括登録 (2026-05-22)
// 列: login_id, display_name, nickname, company_code, job_role, dm_group, birth_date
// 推進メンバーから登録権限を剥がしたため、事務局がここから一括登録する。
// ============================================================
const JOB_ROLES_BULK = {
  driver:        'field',
  warehouse:     'field',
  office:        'office',
  construction:  'field',
  manufacturing: 'field',
};
function genBulkPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}
router.post('/users/bulk-enroll', authAdmin, express.json({ limit: '2mb' }), (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ success: false, msg: '行が空です' });
  if (rows.length > 500) return res.status(400).json({ success: false, msg: '一度に登録できるのは500行までです' });

  const db = getDb();
  const companyMap = {};
  for (const c of db.prepare('SELECT code, name FROM companies').all()) companyMap[c.code] = c.name;

  const results = [];
  const seenLogin = new Set();
  const seenNick = new Set();
  // 既存DB照合用
  const existsLogin = db.prepare('SELECT 1 FROM users WHERE login_id = ?');
  const existsNick = db.prepare('SELECT 1 FROM users WHERE LOWER(nickname) = LOWER(?)');

  // バリデーション (DB書き込みなし)
  const valid = [];
  rows.forEach((raw, i) => {
    const lineNo = i + 1;
    const r = raw || {};
    const loginId = String(r.login_id || '').trim().toLowerCase();
    const displayName = String(r.display_name || '').trim();
    const nickname = String(r.nickname || '').trim();
    const companyCode = String(r.company_code || '').trim();
    const jobRole = String(r.job_role || '').trim();
    const dmGroupInput = String(r.dm_group || '').trim();
    const birthRaw = String(r.birth_date || '').trim();

    const errs = [];
    if (!/^[a-z0-9_.-]{3,30}$/.test(loginId)) errs.push('login_id形式不正');
    if (!displayName || displayName.length > 80) errs.push('display_name必須');
    if (!nickname || nickname.length < 2 || nickname.length > 20) errs.push('nickname 2-20文字必須');
    if (nickname && /[\x00-\x1f\x7f]/.test(nickname)) errs.push('nickname不正文字');
    if (!companyCode || !companyMap[companyCode]) errs.push('company_code不正');
    if (!JOB_ROLES_BULK[jobRole]) errs.push('job_role不正');
    const birth = normalizeBirthDate(birthRaw);
    if (!birth) errs.push('birth_date不正(YYYY-MM-DD / YYYY/MM/DD)');

    if (!errs.length) {
      if (seenLogin.has(loginId)) errs.push('CSV内login_id重複');
      else if (existsLogin.get(loginId)) errs.push('login_id既存');
      if (seenNick.has(nickname.toLowerCase())) errs.push('CSV内nickname重複');
      else if (existsNick.get(nickname)) errs.push('nickname既存');
    }

    if (errs.length) {
      results.push({ line: lineNo, login_id: loginId, status: 'error', errors: errs });
    } else {
      seenLogin.add(loginId);
      seenNick.add(nickname.toLowerCase());
      const employeeType = JOB_ROLES_BULK[jobRole];
      const dmGroup = dmGroupInput || companyMap[companyCode] || '';
      valid.push({ lineNo, loginId, displayName, nickname, companyCode, jobRole, employeeType, dmGroup, birth });
    }
  });

  // 1件でもエラーがあれば全件中止 (CSVを修正して再投入させる方が事故が少ない)
  const dryRun = !!(req.body && req.body.dry_run);
  const hasErr = results.some(r => r.status === 'error');
  if (hasErr || dryRun) {
    // 成功予定の行も含めて返す
    valid.forEach(v => results.push({ line: v.lineNo, login_id: v.loginId, status: dryRun && !hasErr ? 'preview' : 'skipped(他行エラーのため未登録)' }));
    results.sort((a, b) => a.line - b.line);
    return res.json({ success: !hasErr, dry_run: dryRun, total: rows.length, error_count: results.filter(r => r.status === 'error').length, results });
  }

  // 本実行
  const insStmt = db.prepare(`INSERT INTO users
    (id, login_id, password_hash, display_name, nickname, company_code, role, employee_type, job_role, dm_group, dm_rank, dm_restricted, birth_date)
    VALUES (?, ?, ?, ?, ?, ?, 'member', ?, ?, ?, 0, 1, ?)`);
  const out = [];
  const tx = db.transaction(() => {
    for (const v of valid) {
      const id = crypto.randomUUID();
      const password = '00112233'; // 一括登録も全社共通デフォルト(個別登録と統一・控え不要)
      const hash = bcrypt.hashSync(password, 10);
      insStmt.run(id, v.loginId, hash, v.displayName, v.nickname, v.companyCode, v.employeeType, v.jobRole, v.dmGroup || null, v.birth);
      try { syncDmGroupMembership(id, v.dmGroup || null, null, req.uid); } catch (e) { console.warn('[bulk-enroll dm_group sync]', e.message); }
      out.push({ line: v.lineNo, login_id: v.loginId, status: 'ok', initial_password: password, display_name: v.displayName });
    }
  });
  tx();

  res.json({ success: true, total: rows.length, registered: out.length, results: out });
});

// 会社(company_code)からdm_groupを一括設定 + 同期
// dm_group 未設定 のユーザーに対して、所属会社名を dm_group として設定し、
// その後 権威的同期を実施する。
// option: overwrite=true なら設定済みも上書き
router.post('/auto-assign-from-company', authAdmin, express.json(), (req, res) => {
  const overwrite = !!(req.body && req.body.overwrite);
  const db = getDb();
  // 会社 code → 会社名
  const companies = db.prepare('SELECT code, name FROM companies').all();
  const nameByCode = {};
  for (const c of companies) nameByCode[c.code] = c.name;

  const users = db.prepare("SELECT id, company_code, dm_group FROM users WHERE role != 'bot'").all();
  let updated = 0;
  db.transaction(() => {
    for (const u of users) {
      if (!u.company_code) continue;
      const newDg = nameByCode[u.company_code];
      if (!newDg) continue;
      if (!overwrite && u.dm_group) continue; // 既設定はスキップ
      if (u.dm_group === newDg) continue;
      db.prepare('UPDATE users SET dm_group = ? WHERE id = ?').run(newDg, u.id);
      updated++;
    }
  })();

  // 続けて権威的同期 (上の sync-dm-groups と同じロジック)
  const SPECIAL_GROUP_IDS = ['g_field_voice', 'g_wellness_disc'];
  const allGroups = db.prepare('SELECT id, name FROM chat_groups').all();
  const dmGroupSet = new Set();
  const groupByName = {};
  for (const g of allGroups) {
    if (SPECIAL_GROUP_IDS.includes(g.id)) continue;
    dmGroupSet.add(g.id);
    if (g.name) groupByName[g.name] = g.id;
  }
  const usersAfter = db.prepare("SELECT id, dm_group FROM users WHERE role != 'bot'").all();
  let added = 0, removed = 0, created = 0;
  db.transaction(() => {
    for (const u of usersAfter) {
      let expectedGid = null;
      if (u.dm_group) {
        expectedGid = groupByName[u.dm_group];
        if (!expectedGid) {
          expectedGid = crypto.randomUUID();
          db.prepare('INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)')
            .run(expectedGid, u.dm_group, '🏢', req.uid);
          groupByName[u.dm_group] = expectedGid;
          dmGroupSet.add(expectedGid);
          created++;
        }
      }
      const currentGids = db.prepare('SELECT group_id FROM chat_group_members WHERE user_id = ?').all(u.id).map(r => r.group_id);
      for (const gid of currentGids) {
        if (!dmGroupSet.has(gid)) continue;
        if (gid === expectedGid) continue;
        db.prepare('DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?').run(gid, u.id);
        removed++;
      }
      if (expectedGid && !currentGids.includes(expectedGid)) {
        db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)').run(expectedGid, u.id);
        added++;
      }
    }
  })();

  res.json({ success: true, total: users.length, dm_group_updated: updated, created, added, removed });
});

// 既存の dm_group 候補一覧 (重複排除)
router.get('/dm-groups', authAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT dm_group AS name, COUNT(*) AS cnt FROM users
    WHERE dm_group IS NOT NULL AND dm_group != '' AND role != 'bot'
    GROUP BY dm_group ORDER BY cnt DESC, dm_group`).all();
  res.json({ success: true, groups: rows });
});

// ========== 録音機能 ==========
// バックグラウンド文字起こし: upload直後にキック、完了/失敗で transcript_status 更新
async function backgroundTranscribe(recordingId) {
  const db = getDb();
  try {
    const row = db.prepare('SELECT filename FROM recordings WHERE id = ?').get(recordingId);
    if (!row) return;
    const fp = path.join(recDir, row.filename);
    if (!fs.existsSync(fp)) {
      db.prepare("UPDATE recordings SET transcript_status='failed' WHERE id=?").run(recordingId);
      return;
    }
    const stat = fs.statSync(fp);
    if (stat.size > 30 * 1024 * 1024) {
      db.prepare("UPDATE recordings SET transcript_status='failed', transcript=? WHERE id=?")
        .run('ファイルが30MBを超えるため自動生成不可 (長尺会議は分割してください)', recordingId);
      return;
    }
    const buf = fs.readFileSync(fp);
    const b64 = buf.toString('base64');
    const text = await transcribeRecording(b64, 'audio/webm');
    db.prepare("UPDATE recordings SET transcript=?, transcript_at=datetime('now'), transcript_status='done' WHERE id=?").run(text, recordingId);
  } catch (e) {
    console.error('[backgroundTranscribe]', recordingId, e.message);
    try { db.prepare("UPDATE recordings SET transcript_status='failed' WHERE id=?").run(recordingId); } catch {}
  }
}

router.post('/recording/upload', authAdmin, recUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, msg: 'ファイルなし' });
  const duration_ms = parseInt(req.body.duration_ms) || 0;
  const floor_code = (req.body.floor_code || '').toString();
  const note = (req.body.note || '').toString().slice(0, 500);
  const autoTranscribe = String(req.body.auto_transcribe || '') === '1';
  const initialStatus = autoTranscribe ? 'pending' : 'none';
  const ins = getDb().prepare(`INSERT INTO recordings (filename, size, duration_ms, floor_code, recorded_by, note, transcript_status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.file.filename, req.file.size, duration_ms, floor_code, req.uid, note, initialStatus);
  res.json({ success: true, id: ins.lastInsertRowid, auto_transcribe: autoTranscribe });
  if (autoTranscribe) {
    setImmediate(() => backgroundTranscribe(ins.lastInsertRowid));
  }
});

router.get('/recording', authAdmin, (req, res) => {
  const rows = getDb().prepare(`SELECT r.id, r.filename, r.size, r.duration_ms, r.floor_code, r.recorded_by, r.note, r.created_at,
    r.transcript_at, COALESCE(r.transcript_status, 'none') AS transcript_status,
    CASE WHEN r.transcript IS NOT NULL AND length(r.transcript) > 0 THEN 1 ELSE 0 END AS has_transcript,
    u.display_name AS recorded_by_name FROM recordings r LEFT JOIN users u ON u.id = r.recorded_by ORDER BY r.created_at DESC LIMIT 500`).all();
  res.json({ success: true, recordings: rows });
});

// AI議事録 生成 (録音ファイル → Gemini)
router.post('/recording/:id/transcribe', authAdmin, async (req, res) => {
  const row = getDb().prepare('SELECT filename, transcript FROM recordings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, msg: '録音が見つかりません' });
  const fp = path.join(recDir, row.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ success: false, msg: 'ファイル不在' });
  const stat = fs.statSync(fp);
  if (stat.size > 30 * 1024 * 1024) {
    return res.status(400).json({ success: false, msg: 'ファイルが30MBを超えます (長すぎる会議は分割必要)' });
  }
  getDb().prepare("UPDATE recordings SET transcript_status='pending' WHERE id=?").run(req.params.id);
  try {
    const buf = fs.readFileSync(fp);
    const b64 = buf.toString('base64');
    const text = await transcribeRecording(b64, 'audio/webm');
    getDb().prepare("UPDATE recordings SET transcript=?, transcript_at=datetime('now'), transcript_status='done' WHERE id=?").run(text, req.params.id);
    res.json({ success: true, transcript: text });
  } catch (e) {
    console.error('[transcribe]', e);
    try { getDb().prepare("UPDATE recordings SET transcript_status='failed' WHERE id=?").run(req.params.id); } catch {}
    res.status(500).json({ success: false, msg: e.message });
  }
});

router.get('/recording/:id/transcript', authAdmin, (req, res) => {
  const row = getDb().prepare('SELECT transcript, transcript_at FROM recordings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false });
  res.json({ success: true, transcript: row.transcript || '', transcript_at: row.transcript_at });
});

router.get('/recording/:id', authAdmin, (req, res) => {
  const row = getDb().prepare('SELECT filename FROM recordings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).end();
  const fp = path.join(recDir, row.filename);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/webm');
  fs.createReadStream(fp).pipe(res);
});

router.delete('/recording/:id', authAdmin, (req, res) => {
  const row = getDb().prepare('SELECT filename FROM recordings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false });
  try { fs.unlinkSync(path.join(recDir, row.filename)); } catch (e) {}
  getDb().prepare('DELETE FROM recordings WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ========== グループチャット管理 ==========
router.get('/groups', authAdmin, (req, res) => {
  const rows = getDb().prepare(`
    SELECT g.id, g.name, g.icon, g.created_by, g.created_at,
      u.display_name AS created_by_name,
      (SELECT COUNT(*) FROM chat_group_members WHERE group_id = g.id) AS member_count
    FROM chat_groups g LEFT JOIN users u ON u.id = g.created_by
    ORDER BY g.created_at DESC
  `).all();
  res.json({ success: true, groups: rows });
});

router.post('/groups', authAdmin, (req, res) => {
  const name = (req.body.name || '').toString().trim().slice(0, 50);
  const icon = (req.body.icon || '💬').toString().slice(0, 8);
  const memberIds = Array.isArray(req.body.member_ids) ? req.body.member_ids : [];
  if (!name) return res.status(400).json({ success: false, msg: 'グループ名必須' });
  const id = crypto.randomUUID();
  const db = getDb();
  db.prepare('INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)').run(id, name, icon, req.uid);
  const addMember = db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)');
  db.transaction(() => {
    // 作成者も自動参加
    addMember.run(id, req.uid);
    for (const uid of memberIds) if (typeof uid === 'string') addMember.run(id, uid);
  })();
  notifyGroupsChanged(req, 'create', id);
  res.json({ success: true, id });
});

// 変更通知ヘルパ: 全ログイン中クライアントに groups:changed を放送
function notifyGroupsChanged(req, action, gid) {
  try {
    const io = req.app.locals.io;
    if (io) io.emit('groups:changed', { action, gid: gid || null });
  } catch (e) {}
}

router.get('/groups/:gid', authAdmin, (req, res) => {
  const g = getDb().prepare('SELECT id, name, icon, created_by, created_at FROM chat_groups WHERE id = ?').get(req.params.gid);
  if (!g) return res.status(404).json({ success: false });
  const members = getDb().prepare(`SELECT u.id, u.display_name, u.login_id FROM chat_group_members gm
    JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.display_name`).all(req.params.gid);
  res.json({ success: true, group: g, members });
});

router.patch('/groups/:gid', authAdmin, (req, res) => {
  const db = getDb();
  const g = db.prepare('SELECT id FROM chat_groups WHERE id = ?').get(req.params.gid);
  if (!g) return res.status(404).json({ success: false, msg: 'グループが見つかりません' });
  const updates = [];
  const params = [];
  if (req.body.name !== undefined) {
    const n = String(req.body.name || '').trim().slice(0, 50);
    if (!n) return res.status(400).json({ success: false, msg: 'グループ名必須' });
    updates.push('name = ?'); params.push(n);
  }
  if (req.body.icon !== undefined) {
    updates.push('icon = ?'); params.push(String(req.body.icon || '💬').slice(0, 8));
  }
  if (updates.length === 0) return res.json({ success: true });
  params.push(req.params.gid);
  db.prepare('UPDATE chat_groups SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
  notifyGroupsChanged(req, 'update', req.params.gid);
  res.json({ success: true });
});

router.post('/groups/:gid/members', authAdmin, (req, res) => {
  const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids : [];
  const st = getDb().prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)');
  for (const uid of ids) if (typeof uid === 'string') st.run(req.params.gid, uid);
  notifyGroupsChanged(req, 'members_add', req.params.gid);
  res.json({ success: true });
});

router.delete('/groups/:gid/members/:uid', authAdmin, (req, res) => {
  getDb().prepare('DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?').run(req.params.gid, req.params.uid);
  notifyGroupsChanged(req, 'members_remove', req.params.gid);
  res.json({ success: true });
});

router.delete('/groups/:gid', authAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM chat_group_members WHERE group_id = ?').run(req.params.gid);
  db.prepare("DELETE FROM messages WHERE room_code = ?").run('grp_' + req.params.gid);
  db.prepare('DELETE FROM chat_groups WHERE id = ?').run(req.params.gid);
  notifyGroupsChanged(req, 'delete', req.params.gid);
  res.json({ success: true });
});

// グループチャット 全文閲覧 (管理者のみ。メンバーシップ不問)
// 営業所別GCを管理者が監督するための統制機能。
// 2026-07-29: 非メンバーの会話を読む唯一の正規手段のため、閲覧のたびに監査ログへ記録する。
//   既読(group_reads)は付けない = 現場からは「見られた」ことが見えない代わりに、記録が残る。
router.get('/groups/:gid/messages', authAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  const before = (req.query.before || '').toString().trim();
  const db = getDb();
  const g = db.prepare('SELECT id, name, icon FROM chat_groups WHERE id = ?').get(req.params.gid);
  if (!g) return res.status(404).json({ success: false, msg: 'グループが見つかりません' });
  let sql = `SELECT m.id, m.sender_id, m.content, m.has_mention, m.created_at,
    m.attach_url, m.attach_name, m.attach_size, m.attach_type,
    u.display_name AS sender_name, u.avatar_url AS sender_avatar, u.company_code
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.room_code = ?`;
  const params = ['grp_' + req.params.gid];
  if (before) { sql += ' AND m.created_at < ?'; params.push(before); }
  sql += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  try {
    const me = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.uid);
    const isMember = db.prepare('SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ?')
      .get(req.params.gid, req.uid);
    audit(req, isMember ? 'admin_group_view' : 'admin_group_view_nonmember', {
      actor_name: me && me.display_name,
      target: `${g.name} (${g.id}) ${rows.length}件${before ? ' 遡り' : ''}`,
    });
  } catch (e) { /* 監査失敗で閲覧は止めない */ }
  res.json({ success: true, group: g, messages: rows.reverse() });
});

// 出席履歴
router.get('/attendance', authAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
  const userId = (req.query.user_id || '').toString().trim();
  const floor = (req.query.floor || '').toString().trim();
  const since = (req.query.since || '').toString().trim();
  const until = (req.query.until || '').toString().trim();
  let sql = `SELECT a.id, a.user_id, a.floor_code, a.event_type, a.at,
             u.display_name, u.login_id FROM attendance a
             LEFT JOIN users u ON u.id = a.user_id WHERE 1=1`;
  const params = [];
  if (userId) { sql += ' AND a.user_id = ?'; params.push(userId); }
  if (floor) { sql += ' AND a.floor_code = ?'; params.push(floor); }
  if (since) { sql += ' AND a.at >= ?'; params.push(since); }
  if (until) { sql += " AND a.at <= ? || ' 23:59:59'"; params.push(until); }
  sql += ' ORDER BY a.at DESC LIMIT ?';
  params.push(limit);
  const rows = getDb().prepare(sql).all(...params);
  res.json({ success: true, events: rows });
});

module.exports = router;
