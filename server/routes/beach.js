// 浜辺さんぽ + ボトルメール (2026-06-02)
// 誰もいない静かな浜辺を一人で歩ける息抜き機能。社会的プレッシャーゼロが狙い。
// 出会いは「同時刻に居合わせる」前提にせず、非同期の "ボトルメール" で起こす:
//   - 流す: 一言メッセージを海に流す
//   - 拾う: 自分以外が流した、自分がまだ拾っていないボトルを1本ランダムに拾う
// CoHub単体で完結。旧CoWell(health-project)には一切依存しない。
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const MAX = 300;

// 起動時マイグレーション
try {
  const db = getDb();
  db.prepare(`CREATE TABLE IF NOT EXISTS beach_bottles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    found_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS beach_bottle_finds (
    bottle_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (bottle_id, user_id)
  )`).run();
} catch (e) { console.warn('[beach] migration skipped:', e.message); }

// ボトルを流す (一言メッセージ)
router.post('/bottles', authUser, express.json({ limit: '4kb' }), (req, res) => {
  const content = String((req.body && req.body.content) || '').trim().slice(0, MAX);
  if (!content) return res.status(400).json({ success: false, msg: 'メッセージを入力してください' });
  const ins = getDb().prepare('INSERT INTO beach_bottles (author_id, content) VALUES (?, ?)').run(req.uid, content);
  res.json({ success: true, id: ins.lastInsertRowid });
});

// ボトルを拾う (自分以外が流した、まだ拾っていないものを1本ランダムに)
router.get('/bottles/pick', authUser, (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT b.id, b.content, b.created_at,
           u.display_name AS author_name, u.avatar_url AS author_avatar
    FROM beach_bottles b
    LEFT JOIN users u ON u.id = b.author_id
    WHERE b.author_id <> ?
      AND NOT EXISTS (SELECT 1 FROM beach_bottle_finds f WHERE f.bottle_id = b.id AND f.user_id = ?)
    ORDER BY RANDOM() LIMIT 1
  `).get(req.uid, req.uid);
  if (!row) return res.json({ success: true, bottle: null });
  // 拾った記録 (二度同じものを拾わない) + 作者の「届いた数」を加算
  try {
    db.prepare('INSERT OR IGNORE INTO beach_bottle_finds (bottle_id, user_id) VALUES (?, ?)').run(row.id, req.uid);
    db.prepare('UPDATE beach_bottles SET found_count = found_count + 1 WHERE id = ?').run(row.id);
  } catch (e) {}
  res.json({ success: true, bottle: row });
});

// 自分が流したボトルの状況 (何人に届いたか)
router.get('/mine', authUser, (req, res) => {
  const rows = getDb().prepare(`
    SELECT id, content, found_count, created_at
    FROM beach_bottles WHERE author_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).all(req.uid);
  res.json({ success: true, bottles: rows });
});

module.exports = router;
