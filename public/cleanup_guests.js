#!/usr/bin/env node
// 重複ゲスト削除 + パスワード一括リセット
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('/opt/cohub/server/db/cohub.db');

const dupesToDelete = [
  { cw_id: '68551fe2-ee2f-45be-9a1d-26493c72d0e7', login_id: 'cw_68551fe2', name: '鈴木有博 (重複)' },
  { cw_id: 'cb96df5c-dd38-41f1-8fb3-9a5c7515a8b9', login_id: 'saito',      name: '齋藤 (重複, 0件)' },
];
for (const d of dupesToDelete) {
  const u = db.prepare('SELECT id FROM users WHERE login_id = ?').get(d.login_id);
  if (u) {
    db.prepare('UPDATE cw_users SET cohub_uid = NULL, map_method = NULL WHERE cw_id = ?').run(d.cw_id);
    db.prepare('DELETE FROM positions WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM chat_group_members WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    console.log('削除:', d.name, '(' + d.login_id + ')');
  } else {
    console.log('スキップ:', d.name, '(既に存在しない)');
  }
}

// 全ゲストのパスワードを 00112233 にリセット
const defaultHash = bcrypt.hashSync('00112233', 10);
const guests = db.prepare('SELECT id, login_id FROM users WHERE is_guest_reviewer = 1').all();
const upd = db.prepare('UPDATE users SET password_hash = ?, session_token = NULL WHERE id = ?');
for (const g of guests) upd.run(defaultHash, g.id);
console.log('ゲスト', guests.length, '名のパスワードを 00112233 にリセット');
