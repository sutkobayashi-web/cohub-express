// CoHub Box バックアップ (A: DB日次 / B: uploads 週次差分)
// usage:
//   node server/services/backup.js db        # DB日次
//   node server/services/backup.js uploads   # uploads週次差分
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');
const fetch = require('node-fetch');

const ROOT = path.join(__dirname, '..', '..');
const DB_PATH = path.join(ROOT, 'server', 'db', 'cohub.db');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const BACKUP_DIR = path.join(ROOT, 'backup');
const BOX_FOLDER_ID = process.env.BOX_FOLDER_ID_COHUB || '381851836653';
const KEEP_DAYS_LOCAL = 7;

async function getBoxToken() {
  const res = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.BOX_CLIENT_ID,
      client_secret: process.env.BOX_CLIENT_SECRET,
      grant_type: 'client_credentials',
      box_subject_type: 'enterprise',
      box_subject_id: process.env.BOX_ENTERPRISE_ID || '0',
    }),
  });
  const json = await res.json();
  if (json.access_token) return json.access_token;
  throw new Error('Box token取得失敗: ' + JSON.stringify(json).slice(0, 200));
}

async function uploadToBox(token, filePath, fileName, folderId) {
  // 既存ファイル検索 (同名は上書き=新版アップロード)
  let existing = null;
  try {
    const sr = await fetch(
      `https://api.box.com/2.0/search?query=${encodeURIComponent(fileName)}&ancestor_folder_ids=${folderId}&type=file&limit=5`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    if (sr.ok) {
      const sj = await sr.json();
      existing = (sj.entries || []).find(e => e.name === fileName);
    }
  } catch (e) {}
  const data = fs.readFileSync(filePath);
  const boundary = '----BoxUpload' + Date.now();
  let url, body;
  if (existing) {
    url = `https://upload.box.com/api/2.0/files/${existing.id}/content`;
    body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name=file; filename=${fileName}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      data, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
  } else {
    url = 'https://upload.box.com/api/2.0/files/content';
    const attrs = JSON.stringify({ name: fileName, parent: { id: folderId } });
    body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name=attributes\r\n\r\n${attrs}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name=file; filename=${fileName}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      data, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body,
  });
  if (!res.ok) throw new Error('Box upload失敗 HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function rotateLocal() {
  const cutoff = Date.now() - KEEP_DAYS_LOCAL * 86400 * 1000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const fp = path.join(BACKUP_DIR, f);
    try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch (e) {}
  }
}

async function backupDb() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  console.log(`[${now.toISOString()}] CoHub DB バックアップ開始`);
  if (!fs.existsSync(DB_PATH)) { console.log('  DB未作成、スキップ'); return { success: true, skipped: true }; }
  ensureBackupDir();
  const fname = `cohub_db_${dateStr}.db.gz`;
  const dest = path.join(BACKUP_DIR, fname);
  // gzip圧縮 (sqliteは圧縮効率高い)
  await new Promise((resolve, reject) => {
    const inp = fs.createReadStream(DB_PATH);
    const out = fs.createWriteStream(dest);
    const gz = zlib.createGzip({ level: 6 });
    inp.pipe(gz).pipe(out).on('finish', resolve).on('error', reject);
  });
  const sizeKB = Math.round(fs.statSync(dest).size / 1024);
  console.log(`  圧縮完了: ${fname} (${sizeKB}KB)`);
  const token = await getBoxToken();
  await uploadToBox(token, dest, fname, BOX_FOLDER_ID);
  console.log('  Boxアップロード完了');
  rotateLocal();
  console.log(`[${new Date().toISOString()}] DBバックアップ完了`);
  return { success: true, file: fname, sizeKB };
}

async function backupUploadsWeekly() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  console.log(`[${now.toISOString()}] CoHub Uploads 週次差分バックアップ開始`);
  if (!fs.existsSync(UPLOADS_DIR)) { console.log('  uploads未作成、スキップ'); return { success: true, skipped: true }; }
  ensureBackupDir();
  // 過去8日以内に変更されたファイルだけをtar.gzに固める
  // (毎週日曜深夜実行を想定、念のため余裕持って8日)
  const cutoff = new Date(Date.now() - 8 * 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const fname = `cohub_uploads_${dateStr}.tar.gz`;
  const dest = path.join(BACKUP_DIR, fname);
  // findで新規/変更ファイルだけ列挙してtar.gz化
  // -newermt は ISO date 形式OK、-print0 + tar --null --files-from で安全
  const listFile = path.join(BACKUP_DIR, '.uploads_changed_' + Date.now() + '.lst');
  try {
    execSync(`find . -type f -newermt "${cutoff}" -print > ${listFile}`, { cwd: UPLOADS_DIR });
    const lines = fs.readFileSync(listFile, 'utf-8').split('\n').filter(Boolean);
    if (lines.length === 0) {
      console.log('  変更ファイルなし、スキップ');
      fs.unlinkSync(listFile);
      return { success: true, skipped: true, reason: 'no changes' };
    }
    console.log(`  対象 ${lines.length} ファイル`);
    execSync(`tar -czf ${dest} -T ${listFile}`, { cwd: UPLOADS_DIR });
    fs.unlinkSync(listFile);
  } catch (e) {
    if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
    throw e;
  }
  const sizeKB = Math.round(fs.statSync(dest).size / 1024);
  console.log(`  tar.gz作成完了: ${fname} (${sizeKB}KB)`);
  const token = await getBoxToken();
  await uploadToBox(token, dest, fname, BOX_FOLDER_ID);
  console.log('  Boxアップロード完了');
  rotateLocal();
  console.log(`[${new Date().toISOString()}] Uploadsバックアップ完了`);
  return { success: true, file: fname, sizeKB };
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const mode = process.argv[2] || 'db';
  const fn = mode === 'uploads' ? backupUploadsWeekly : backupDb;
  fn().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.success ? 0 : 1);
  }).catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}

module.exports = { backupDb, backupUploadsWeekly, getBoxToken, uploadToBox };
