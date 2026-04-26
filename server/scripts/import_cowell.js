#!/usr/bin/env node
// CoWell (health) DB → CoHub DB アーカイブ取込
//
// 使い方:
//   node server/scripts/import_cowell.js --dry-run            # 確認のみ
//   node server/scripts/import_cowell.js                       # 実行
//   node server/scripts/import_cowell.js --health-db /path     # 別パス指定

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { getDb } = require('../services/db');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const dbArgIdx = args.indexOf('--health-db');
const healthDbPath = dbArgIdx >= 0 ? args[dbArgIdx + 1] : '/opt/health/server/db/health.db';

if (!fs.existsSync(healthDbPath)) {
  console.error('❌ CoWell DB not found:', healthDbPath);
  process.exit(1);
}

const cohubDb = getDb();
const cwDb = new Database(healthDbPath, { readonly: true });

console.log('=== CoWell → CoHub アーカイブ取込 ===');
console.log('source:', healthDbPath);
console.log('target:', cohubDb.name);
console.log('mode:', isDryRun ? 'DRY-RUN (DB変更なし)' : '本番実行');
console.log('');

const stats = {};

function tx(label, fn) {
  if (isDryRun) {
    const dryDb = { ...cohubDb, prepare: () => ({ run: () => ({ changes: 0 }), get: () => null }) };
    fn(dryDb);
    return;
  }
  const trx = cohubDb.transaction(fn);
  trx(cohubDb);
}

// 1. ユーザーマッピング (real_name で完全一致 → cohub_uid)
function importUsers() {
  const cwUsers = cwDb.prepare('SELECT id, nickname, real_name, department, avatar, created_at FROM users').all();
  const cohubUsers = cohubDb.prepare('SELECT id, display_name FROM users').all();
  // 半角/全角スペース正規化して比較
  const norm = s => (s || '').replace(/[\s　]+/g, '').toLowerCase();
  const nameMap = new Map();
  for (const u of cohubUsers) nameMap.set(norm(u.display_name), u.id);

  let inserted = 0, updated = 0, mapped = 0;
  const insStmt = cohubDb.prepare(`INSERT INTO cw_users (cw_id, nickname, real_name, department, avatar, cohub_uid, map_method, cw_created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cw_id) DO UPDATE SET nickname=excluded.nickname, real_name=excluded.real_name, department=excluded.department,
                                     avatar=excluded.avatar, cohub_uid=excluded.cohub_uid, map_method=excluded.map_method`);
  for (const u of cwUsers) {
    const cohubUid = nameMap.get(norm(u.real_name)) || null;
    const method = cohubUid ? 'auto_realname' : 'unmapped';
    if (cohubUid) mapped++;
    if (!isDryRun) {
      const r = insStmt.run(u.id, u.nickname, u.real_name, u.department, u.avatar, cohubUid, method, u.created_at);
      if (r.changes) inserted++;
    }
    console.log(`  ${cohubUid ? '✓' : '✗'} ${u.nickname} (${u.real_name || '-'}) → ${cohubUid || '未マップ'}`);
  }
  stats.users = { total: cwUsers.length, mapped, inserted };
  console.log(`  → ${cwUsers.length}件 / ${mapped}件マップ済`);
}

// 2. posts (食事/相談/雑談投稿)
function importPosts() {
  const rows = cwDb.prepare(`SELECT post_id, user_id, content, analysis, nickname, image_url, category,
                                    nutrition_scores, status, created_at FROM posts`).all();
  const ins = cohubDb.prepare(`INSERT INTO cw_posts (cw_post_id, cw_user_id, content, analysis, nickname,
    image_url, category, nutrition_scores, status, cw_created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cw_post_id) DO UPDATE SET content=excluded.content, analysis=excluded.analysis,
      image_url=excluded.image_url, nutrition_scores=excluded.nutrition_scores, status=excluded.status`);
  let n = 0;
  for (const r of rows) {
    if (!isDryRun) ins.run(r.post_id, r.user_id, r.content, r.analysis, r.nickname, r.image_url,
      r.category, r.nutrition_scores, r.status, r.created_at);
    n++;
  }
  stats.posts = { total: n };
  console.log(`  posts: ${n}件`);
}

// 3. buddy_messages
function importBuddy() {
  const rows = cwDb.prepare('SELECT id, user_id, role, content, created_at FROM buddy_messages').all();
  const ins = cohubDb.prepare(`INSERT INTO cw_buddy_messages (cw_id, cw_user_id, role, content, cw_created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(cw_id) DO NOTHING`);
  let n = 0;
  for (const r of rows) {
    if (!isDryRun) ins.run(r.id, r.user_id, r.role, r.content, r.created_at);
    n++;
  }
  stats.buddy_messages = { total: n };
  console.log(`  buddy_messages: ${n}件`);
}

// 4. step_log
function importSteps() {
  const rows = cwDb.prepare('SELECT user_id, step_date, steps FROM step_log').all();
  const ins = cohubDb.prepare(`INSERT INTO cw_step_log (cw_user_id, step_date, steps) VALUES (?, ?, ?)
    ON CONFLICT(cw_user_id, step_date) DO UPDATE SET steps=excluded.steps`);
  let n = 0;
  for (const r of rows) {
    if (!isDryRun) ins.run(r.user_id, r.step_date, r.steps);
    n++;
  }
  stats.step_log = { total: n };
  console.log(`  step_log: ${n}件`);
}

// 5. food_weekly_reports
function importFoodReports() {
  const rows = cwDb.prepare(`SELECT report_id, user_id, nickname, week_start, week_end, meal_count,
                                    report_text, admin_comment, nutrition_scores, created_at FROM food_weekly_reports`).all();
  const ins = cohubDb.prepare(`INSERT INTO cw_food_weekly_reports (cw_report_id, cw_user_id, nickname,
    week_start, week_end, meal_count, report_text, admin_comment, nutrition_scores, cw_created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cw_report_id) DO UPDATE SET report_text=excluded.report_text, admin_comment=excluded.admin_comment`);
  let n = 0;
  for (const r of rows) {
    if (!isDryRun) ins.run(r.report_id, r.user_id, r.nickname, r.week_start, r.week_end,
      r.meal_count, r.report_text, r.admin_comment, r.nutrition_scores, r.created_at);
    n++;
  }
  stats.food_weekly_reports = { total: n };
  console.log(`  food_weekly_reports: ${n}件`);
}

// 6. blood_pressure
function importBP() {
  const rows = cwDb.prepare('SELECT id, user_id, systolic, diastolic, pulse, measured_at, created_at FROM blood_pressure').all();
  const ins = cohubDb.prepare(`INSERT INTO cw_blood_pressure (cw_id, cw_user_id, systolic, diastolic, pulse, measured_at, cw_created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cw_id) DO NOTHING`);
  let n = 0;
  for (const r of rows) {
    if (!isDryRun) ins.run(r.id, r.user_id, r.systolic, r.diastolic, r.pulse, r.measured_at, r.created_at);
    n++;
  }
  stats.blood_pressure = { total: n };
  console.log(`  blood_pressure: ${n}件`);
}

console.log('--- ユーザー ---');
tx('users', importUsers);
console.log('--- 投稿 ---');
tx('posts', importPosts);
console.log('--- バディー会話 ---');
tx('buddy', importBuddy);
console.log('--- 歩数 ---');
tx('step', importSteps);
console.log('--- 食事週次レポート ---');
tx('food_reports', importFoodReports);
console.log('--- 血圧 ---');
tx('bp', importBP);

if (!isDryRun) {
  cohubDb.prepare(`INSERT INTO cw_import_log (table_name, rows_inserted, notes) VALUES ('all', ?, ?)`)
    .run(Object.values(stats).reduce((a, s) => a + (s.total || 0), 0), JSON.stringify(stats));
}

console.log('');
console.log('=== 完了 ===');
console.log(JSON.stringify(stats, null, 2));
if (isDryRun) console.log('\n⚠ DRY-RUN: DBは変更されていません。本番実行は --dry-run を外してください。');
cwDb.close();
