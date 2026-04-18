const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let _db = null;

function getDb() {
  if (_db) return _db;
  const dbDir = path.join(__dirname, '..', 'db');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'cohub.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  const schema = fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8');
  _db.exec(schema);
  return _db;
}

module.exports = { getDb };
