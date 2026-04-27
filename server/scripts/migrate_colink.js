// CoLink (kanto-bc) → CoHub データ移行スクリプト (2026-04-28)
// 一回限りの実行を想定。冪等性を確保するため legacy_colink_id を見て重複スキップ。
// Usage: node server/scripts/migrate_colink.js [--dry]
//   --dry: 件数だけ確認、実書き込みなし

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DRY = process.argv.includes('--dry');
const COLINK_DB = process.env.COLINK_DB || '/opt/kanto-bc/data/kanto.db';
const COHUB_DB = process.env.COHUB_DB || '/opt/cohub/server/db/cohub.db';

if (!fs.existsSync(COLINK_DB)) { console.error('CoLink DB not found:', COLINK_DB); process.exit(1); }
if (!fs.existsSync(COHUB_DB))  { console.error('CoHub DB not found:',  COHUB_DB);  process.exit(1); }

const src = new Database(COLINK_DB, { readonly: true });
const dst = new Database(COHUB_DB);

console.log('===== CoLink → CoHub Migration =====');
console.log('src:', COLINK_DB, '\ndst:', COHUB_DB, '\nDRY-RUN:', DRY, '\n');

// ----- 1. ユーザー: 橋本 雄三 のみ追加 (他6名は display_name で既存マッチ済み) -----
function migrateUsers() {
  const colinkUsers = src.prepare('SELECT id, name, role, password, floors, is_admin, avatar FROM users').all();
  console.log(`[users] CoLink ${colinkUsers.length}名を確認`);
  let added = 0, matched = 0, skipped = 0;
  // 名前比較時に全角/半角スペースの揺れを吸収
  const normalize = (s) => String(s || '').replace(/[　\s]+/g, '').trim();
  for (const u of colinkUsers) {
    const norm = normalize(u.name);
    const all = dst.prepare('SELECT id, login_id, display_name FROM users').all();
    const existing = all.find(r => normalize(r.display_name) === norm);
    if (existing) {
      matched++;
      console.log(`  ✓ matched: ${u.name} → ${existing.login_id} (${existing.id})`);
      continue;
    }
    // 新規追加: ログインID をローマ字推測 (橋本 雄三 → y_hashimoto)
    const loginIdGuess = u.name === '橋本 雄三' ? 'y_hashimoto' : ('kbc_' + u.id);
    const newUid = crypto.randomUUID();
    const pwHash = bcrypt.hashSync('Cohub2026!Initial', 10);
    if (!DRY) {
      dst.prepare(`INSERT INTO users (id, login_id, password_hash, display_name, company_code, role, employee_type, avatar_url)
                   VALUES (?, ?, ?, ?, 'KBC', 'member', 'field', ?)`).run(newUid, loginIdGuess, pwHash, u.name, u.avatar || '');
    }
    added++;
    console.log(`  + added: ${u.name} → ${loginIdGuess} (${newUid}) [初期パスワード: Cohub2026!Initial]`);
  }
  console.log(`[users] matched=${matched}, added=${added}, skipped=${skipped}\n`);
}

// ----- 2. accident_cause_master -----
function migrateMasters() {
  // 原因マスタ
  {
    const rows = src.prepare('SELECT category, template, keywords, sort_order FROM accident_cause_master').all();
    let inserted = 0;
    if (!DRY) {
      const existing = dst.prepare('SELECT COUNT(*) AS c FROM kbc_accident_cause_master').get().c;
      if (existing > 0) {
        console.log(`[kbc_accident_cause_master] 既に ${existing} 件あり、スキップ`);
      } else {
        const ins = dst.prepare('INSERT INTO kbc_accident_cause_master (category, template, keywords, sort_order) VALUES (?, ?, ?, ?)');
        for (const r of rows) { ins.run(r.category, r.template, r.keywords, r.sort_order); inserted++; }
      }
    } else {
      inserted = rows.length;
    }
    console.log(`[kbc_accident_cause_master] ${inserted}件`);
  }
  // 商品マスタ
  {
    const rows = src.prepare('SELECT product_category, product_name, sort_order FROM accident_product_master').all();
    let inserted = 0;
    if (!DRY) {
      const existing = dst.prepare('SELECT COUNT(*) AS c FROM kbc_accident_product_master').get().c;
      if (existing > 0) {
        console.log(`[kbc_accident_product_master] 既に ${existing} 件あり、スキップ`);
      } else {
        const ins = dst.prepare('INSERT INTO kbc_accident_product_master (product_category, product_name, sort_order) VALUES (?, ?, ?)');
        for (const r of rows) { ins.run(r.product_category, r.product_name, r.sort_order); inserted++; }
      }
    } else {
      inserted = rows.length;
    }
    console.log(`[kbc_accident_product_master] ${inserted}件`);
  }
  console.log('');
}

// ----- 3. accident_reports -----
function migrateAccidents() {
  const rows = src.prepare('SELECT * FROM accident_reports ORDER BY id').all();
  console.log(`[accident_reports] CoLink ${rows.length}件`);
  let inserted = 0, skipped = 0;
  if (!DRY) {
    const checkExist = dst.prepare('SELECT id FROM kbc_accident_reports WHERE legacy_colink_id = ?');
    const ins = dst.prepare(`INSERT INTO kbc_accident_reports
      (accident_date, accident_time, weather, timing, location_floor, location_area,
       reporter_name, accident_type, product_code, product_name, product_category, quantity,
       cause_category, cause_detail, situation_template, situation_detail, damage_description,
       media_paths, label_photo_path, reporter_reflection, similar_accident_known,
       handling, handling_instruction, cost_amount, cost_status, status, manager_comment,
       approved_by, approved_at, rejected_reason, pdf_path, reported_to, reported_where,
       police_contact, legacy_colink_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)`);
    for (const r of rows) {
      if (checkExist.get(r.id)) { skipped++; continue; }
      ins.run(r.accident_date, r.accident_time, r.weather, r.timing, r.location_floor, r.location_area,
        r.reporter_name, r.accident_type, r.product_code, r.product_name, r.product_category, r.quantity,
        r.cause_category, r.cause_detail, r.situation_template, r.situation_detail, r.damage_description,
        r.media_paths, r.label_photo_path, r.reporter_reflection, r.similar_accident_known,
        r.handling, r.handling_instruction, r.cost_amount, r.cost_status, r.status, r.manager_comment,
        r.approved_by, r.approved_at, r.rejected_reason, r.pdf_path, r.reported_to, r.reported_where,
        r.police_contact, r.id, r.created_at, r.updated_at);
      inserted++;
    }
  } else {
    inserted = rows.length;
  }
  console.log(`[kbc_accident_reports] inserted=${inserted}, skipped=${skipped}\n`);
}

// ----- 4. daily_reports (1464件) -----
function migrateDailyReports() {
  const rows = src.prepare('SELECT * FROM daily_reports ORDER BY id').all();
  console.log(`[daily_reports] CoLink ${rows.length}件`);
  let inserted = 0, skipped = 0;
  if (!DRY) {
    const checkExist = dst.prepare('SELECT id FROM kbc_daily_reports WHERE legacy_colink_id = ?');
    const ins = dst.prepare(`INSERT OR IGNORE INTO kbc_daily_reports
      (user_name, report_date, start_time, end_time, break_minutes, staff, temp_workers, part_workers,
       workers, shipping_total, memo, phase1_at,
       floor_1f_in, floor_1f_out, floor_2f_in, floor_2f_out, floor_3f_in, floor_3f_out,
       floor_4f_in, floor_4f_out, floor_5f_in, floor_5f_out,
       inbound_total, outbound_total, phase2_at, legacy_colink_id, created_at)
      VALUES (?,?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?)`);
    const tx = dst.transaction(() => {
      for (const r of rows) {
        if (checkExist.get(r.id)) { skipped++; continue; }
        const result = ins.run(r.user_name, r.report_date, r.start_time, r.end_time, r.break_minutes,
          r.staff, r.temp_workers, r.part_workers, r.workers, r.shipping_total, r.memo, r.phase1_at,
          r.floor_1f_in, r.floor_1f_out, r.floor_2f_in, r.floor_2f_out, r.floor_3f_in, r.floor_3f_out,
          r.floor_4f_in, r.floor_4f_out, r.floor_5f_in, r.floor_5f_out,
          r.inbound_total, r.outbound_total, r.phase2_at, r.id, r.created_at);
        if (result.changes > 0) inserted++; else skipped++;
      }
    });
    tx();
  } else {
    inserted = rows.length;
  }
  console.log(`[kbc_daily_reports] inserted=${inserted}, skipped=${skipped}\n`);
}

// ----- 5. claims (60件) -----
function migrateClaims() {
  const rows = src.prepare('SELECT * FROM claims ORDER BY id').all();
  console.log(`[claims] CoLink ${rows.length}件`);
  let inserted = 0, skipped = 0;
  if (!DRY) {
    const checkExist = dst.prepare('SELECT id FROM kbc_claims WHERE legacy_colink_id = ?');
    const ins = dst.prepare(`INSERT INTO kbc_claims
      (claim_month, product_category, product_name, quantity, amount, area, cause, reporter, memo,
       legacy_colink_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of rows) {
      if (checkExist.get(r.id)) { skipped++; continue; }
      ins.run(r.claim_month, r.product_category, r.product_name, r.quantity, r.amount,
        r.area, r.cause, r.reporter, r.memo, r.id, r.created_at);
      inserted++;
    }
  } else {
    inserted = rows.length;
  }
  console.log(`[kbc_claims] inserted=${inserted}, skipped=${skipped}\n`);
}

// ----- 6. bc_reports (10件) -----
function migrateBcReports() {
  const rows = src.prepare('SELECT * FROM bc_reports ORDER BY id').all();
  console.log(`[bc_reports] CoLink ${rows.length}件`);
  let inserted = 0, skipped = 0;
  if (!DRY) {
    const checkExist = dst.prepare('SELECT id FROM kbc_bc_reports WHERE legacy_colink_id = ?');
    const ins = dst.prepare(`INSERT INTO kbc_bc_reports
      (source_report_id, report_type, occurrence_time, location, product_code, product_name,
       quantity, damaged_item, cause, damage_detail, action_taken, prevention,
       inspection_code, inspection_name, inspection_qty, inspection_detail, inspection_result,
       reporter, photo_path, status, client_comment, confirmed_at, confirmed_by, media_paths,
       legacy_colink_id, created_at)
      VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?)`);
    for (const r of rows) {
      if (checkExist.get(r.id)) { skipped++; continue; }
      ins.run(r.source_report_id, r.report_type, r.occurrence_time, r.location, r.product_code, r.product_name,
        r.quantity, r.damaged_item, r.cause, r.damage_detail, r.action_taken, r.prevention,
        r.inspection_code, r.inspection_name, r.inspection_qty, r.inspection_detail, r.inspection_result,
        r.reporter, r.photo_path, r.status, r.client_comment, r.confirmed_at, r.confirmed_by, r.media_paths,
        r.id, r.created_at);
      inserted++;
    }
  } else {
    inserted = rows.length;
  }
  console.log(`[kbc_bc_reports] inserted=${inserted}, skipped=${skipped}\n`);
}

// ----- 7. action_plans (10件) -----
function migrateActionPlans() {
  const rows = src.prepare('SELECT * FROM action_plans ORDER BY id').all();
  console.log(`[action_plans] CoLink ${rows.length}件`);
  let inserted = 0, skipped = 0;
  if (!DRY) {
    const checkExist = dst.prepare('SELECT id FROM kbc_action_plans WHERE legacy_colink_id = ?');
    const ins = dst.prepare(`INSERT INTO kbc_action_plans
      (priority, category, issue, action, person, deadline, status, legacy_colink_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const r of rows) {
      if (checkExist.get(r.id)) { skipped++; continue; }
      ins.run(r.priority, r.category, r.issue, r.action, r.person, r.deadline, r.status, r.id, r.created_at);
      inserted++;
    }
  } else {
    inserted = rows.length;
  }
  console.log(`[kbc_action_plans] inserted=${inserted}, skipped=${skipped}\n`);
}

// ============================================================
// 実行
// ============================================================
try {
  migrateUsers();
  migrateMasters();
  migrateAccidents();
  migrateDailyReports();
  migrateClaims();
  migrateBcReports();
  migrateActionPlans();
  console.log('===== ' + (DRY ? '🔎 DRY-RUN完了' : '✅ 移行完了') + ' =====');
} catch (e) {
  console.error('❌ 移行失敗:', e);
  process.exit(2);
} finally {
  src.close();
  dst.close();
}
