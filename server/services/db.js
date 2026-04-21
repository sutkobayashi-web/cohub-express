const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let _db = null;

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function getDb() {
  if (_db) return _db;
  const dbDir = path.join(__dirname, '..', 'db');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cohub.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  const schema = fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8');
  _db.exec(schema);
  // 既存DB向けマイグレーション (idempotent)
  ensureColumn(_db, 'users', 'google_cal_id', 'google_cal_id TEXT');
  ensureColumn(_db, 'users', 'last_cal_dm_date', 'last_cal_dm_date TEXT');
  // 事務所棟フロアの登場位置を正面玄関(下中央)に揃える
  _db.prepare(`UPDATE floors SET entry_x=672, entry_y=678
               WHERE code IN ('lobby','office','meeting_a','meeting_b','meeting_c')
                 AND (entry_x <> 672 OR entry_y <> 678)`).run();
  return _db;
}

module.exports = { getDb };
