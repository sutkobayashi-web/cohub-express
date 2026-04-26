#!/usr/bin/env node
// 未マップのCoWellユーザーを CoHub の guest として一括登録
// + chat_groups に g_guests グループを作成し、全員自動加入
//
// 使い方:
//   node server/scripts/migrate_guest_users.js --dry-run
//   node server/scripts/migrate_guest_users.js

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('../services/db');

const isDryRun = process.argv.includes('--dry-run');
const db = getDb();

console.log('=== ゲスト一括登録 ===');
console.log('mode:', isDryRun ? 'DRY-RUN' : '本番実行');
console.log('');

// 1. g_guests グループを作成 (idempotent)
const GUEST_GID = 'g_guests';
const grp = db.prepare('SELECT id, name FROM chat_groups WHERE id = ?').get(GUEST_GID);
if (!grp) {
  if (!isDryRun) {
    db.prepare("INSERT INTO chat_groups (id, name, icon, created_by) VALUES (?, ?, ?, ?)")
      .run(GUEST_GID, '👥 ゲスト (大学・NPO・外部)', '👥', null);
  }
  console.log('✓ chat_groups に g_guests を作成');
} else {
  console.log('· g_guests グループ既存:', grp.name);
}

// 2. 未マップ cw_users 取得
const unmapped = db.prepare(`SELECT cw_id, nickname, real_name, department, cw_created_at,
  (SELECT COUNT(*) FROM cw_posts WHERE cw_user_id = cw_users.cw_id) AS post_count,
  (SELECT COUNT(*) FROM cw_buddy_messages WHERE cw_user_id = cw_users.cw_id) AS msg_count,
  (SELECT COUNT(*) FROM cw_blood_pressure WHERE cw_user_id = cw_users.cw_id) AS bp_count
  FROM cw_users WHERE cohub_uid IS NULL ORDER BY real_name`).all();

console.log('未マップユーザー数:', unmapped.length);
console.log('');

function genPw() {
  const c = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let p = '';
  for (let i = 0; i < 12; i++) p += c[Math.floor(Math.random() * c.length)];
  return p + '#1';
}

function genLoginId(cwUser) {
  // nickname を ASCII化試行、ダメなら cw_<8chars>
  const nick = (cwUser.nickname || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (nick && /^[a-z0-9]/.test(nick) && nick.length >= 3) {
    // 重複チェック
    const exists = db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(nick);
    if (!exists) return nick;
    // suffix 付与
    for (let i = 2; i < 10; i++) {
      const candidate = nick + i;
      if (!db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(candidate)) return candidate;
    }
  }
  return 'cw_' + (cwUser.cw_id || '').slice(0, 8);
}

// 3. 各ユーザー migrate
const results = [];
const insUser = db.prepare(`INSERT INTO users
  (id, login_id, password_hash, display_name, company_code, role, employee_type,
   is_guest_reviewer, guest_org)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const updateMap = db.prepare("UPDATE cw_users SET cohub_uid = ?, map_method = 'auto_guest' WHERE cw_id = ?");
const addToGroup = db.prepare("INSERT OR IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)");

const txn = db.transaction(() => {
  for (const cw of unmapped) {
    const loginId = genLoginId(cw);
    const password = genPw();
    const hash = bcrypt.hashSync(password, 10);
    const id = crypto.randomUUID();
    const displayName = cw.real_name || cw.nickname || loginId;
    // 福田教授・西村は大学、それ以外はGUEST扱い
    const isAcademic = /福田|西村/.test(cw.real_name || '');
    const companyCode = isAcademic ? 'UNIVERSITY' : 'GUEST';
    const guestOrg = isAcademic ? '帝京大学公衆衛生学研究科' : (cw.department || '外部');

    if (!isDryRun) {
      insUser.run(id, loginId, hash, displayName, companyCode, 'member', 'office', 1, guestOrg);
      updateMap.run(id, cw.cw_id);
      addToGroup.run(GUEST_GID, id);
    }
    results.push({
      login_id: loginId,
      display_name: displayName,
      nickname: cw.nickname,
      company: companyCode,
      data_count: (cw.post_count || 0) + (cw.msg_count || 0) + (cw.bp_count || 0),
      password,
    });
  }
});

txn();

console.log('登録結果:');
console.log('login_id'.padEnd(30) + ' | ' + '表示名'.padEnd(16) + ' | 会社 | データ件数 | パスワード');
console.log('─'.repeat(90));
for (const r of results) {
  console.log(
    r.login_id.padEnd(30) + ' | ' +
    (r.display_name + '       ').slice(0, 16) + ' | ' +
    r.company.padEnd(11) + ' | ' +
    String(r.data_count).padStart(6) + '件 | ' +
    r.password
  );
}
console.log('');
console.log('=== 完了 ===');
console.log('合計:', results.length, '名');
console.log('全員 g_guests グループに自動加入済');
console.log('全員 is_guest_reviewer=1 (施策ボード閲覧可)');

if (isDryRun) console.log('\n⚠ DRY-RUN: DB変更なし。本番実行は --dry-run を外す');
else console.log('\n✓ パスワード一覧は安全な場所に保管し、本人にお知らせください');

// chat_group_members に推進メンバー+admin も追加 (g_guests 閲覧権限付与)
if (!isDryRun) {
  const adminUsers = db.prepare("SELECT id FROM users WHERE employee_type = 'admin' OR is_field_promoter = 1").all();
  const cnt = adminUsers.length;
  for (const u of adminUsers) addToGroup.run(GUEST_GID, u.id);
  console.log(`✓ 推進メンバー+管理職 ${cnt}名 も g_guests に加入 (ゲストとのDM/グループ会話用)`);
}
