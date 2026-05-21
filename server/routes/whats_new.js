// What's new: ホーム画面に表示する全社活動の最新ダイジェスト
// 直近の plaza/board/announcement/accident/circle/wellness を統合し時系列で返す
const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

router.use(express.json({ limit: '32kb' }));

function trunc(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function safeAuthor(db, uid, isAnon) {
  if (isAnon) return '匿名さん';
  try {
    const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(uid);
    return u && u.display_name ? u.display_name : '社員';
  } catch (e) { return '社員'; }
}

router.get('/', authUser, (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20);
  const days = Math.min(parseInt(req.query.days, 10) || 14, 60);
  const events = [];

  // plaza_posts (カテゴリ別にラベル切替)
  try {
    const rows = db.prepare(`
      SELECT id, author_id, category, content, is_anonymous, created_at
      FROM plaza_posts
      WHERE deleted_at IS NULL
        AND created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC LIMIT 12
    `).all(days);
    const META = {
      '食事':    { icon: '🍱', label: '食事投稿', link: '/plaza.html?tab=食事' },
      '相談':    { icon: '🆘', label: '悩み相談', link: '/plaza.html?tab=相談' },
      '雑談':    { icon: '💭', label: '雑談',     link: '/plaza.html?tab=雑談' },
      '健康Tips': { icon: '💡', label: '健康Tips', link: '/plaza.html?tab=健康Tips' },
    };
    for (const r of rows) {
      const m = META[r.category] || { icon: '📝', label: r.category, link: '/plaza.html' };
      events.push({
        type: 'plaza:' + r.category,
        icon: m.icon,
        label: m.label,
        summary: trunc(r.content, 36),
        link: m.link,
        author: safeAuthor(db, r.author_id, r.is_anonymous),
        created_at: r.created_at,
      });
    }
  } catch (e) {}

  // board_posts (掲示板)
  try {
    const rows = db.prepare(`
      SELECT id, author_id, content, created_at
      FROM board_posts
      WHERE deleted_at IS NULL
        AND created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC LIMIT 5
    `).all(days);
    for (const r of rows) {
      events.push({
        type: 'board',
        icon: '📋',
        label: '掲示板',
        summary: trunc(r.content, 36),
        link: '/board.html',
        author: safeAuthor(db, r.author_id, 0),
        created_at: r.created_at,
      });
    }
  } catch (e) {}

  // announcements (告知)
  try {
    const rows = db.prepare(`
      SELECT id, author_id, title, created_at
      FROM announcements
      WHERE created_at >= datetime('now', '-' || ? || ' days')
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at DESC LIMIT 5
    `).all(days);
    for (const r of rows) {
      events.push({
        type: 'announce',
        icon: '📢',
        label: '告知',
        summary: trunc(r.title, 36),
        link: '/announcements.html',
        author: safeAuthor(db, r.author_id, 0),
        created_at: r.created_at,
      });
    }
  } catch (e) {}

  // vehicle_accident_reports (車両事故)
  try {
    const rows = db.prepare(`
      SELECT id, reporter_id, reporter_name, accident_type, location, created_at
      FROM vehicle_accident_reports
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC LIMIT 3
    `).all(days);
    for (const r of rows) {
      events.push({
        type: 'accident:vehicle',
        icon: '🚨',
        label: '車両事故',
        summary: trunc([r.accident_type, r.location].filter(Boolean).join(' / '), 36),
        link: '/accident.html',
        author: r.reporter_name || safeAuthor(db, r.reporter_id, 0),
        created_at: r.created_at,
      });
    }
  } catch (e) {}

  // kbc_accident_reports (製品事故)
  try {
    const rows = db.prepare(`
      SELECT id, reporter_name, accident_type, location_area, created_at
      FROM kbc_accident_reports
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC LIMIT 3
    `).all(days);
    for (const r of rows) {
      events.push({
        type: 'accident:product',
        icon: '📦',
        label: '製品事故',
        summary: trunc([r.accident_type, r.location_area].filter(Boolean).join(' / '), 36),
        link: '/accident.html',
        author: r.reporter_name || '報告者',
        created_at: r.created_at,
      });
    }
  } catch (e) {}

  // circle_events (サークル)
  try {
    const rows = db.prepare(`
      SELECT e.id, e.title, e.event_date, e.event_time, e.created_by, e.created_at, g.name AS gname
      FROM circle_events e
      LEFT JOIN chat_groups g ON g.id = e.group_id
      WHERE e.created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY e.created_at DESC LIMIT 4
    `).all(days);
    for (const r of rows) {
      const when = [r.event_date, r.event_time].filter(Boolean).join(' ');
      events.push({
        type: 'circle',
        icon: '🎯',
        label: 'サークル' + (r.gname ? '(' + r.gname + ')' : ''),
        summary: trunc([r.title, when].filter(Boolean).join(' / '), 36),
        link: '/circles.html',
        author: safeAuthor(db, r.created_by, 0),
        created_at: r.created_at,
      });
    }
  } catch (e) {}

  // wellness_posts (健康管理室の現場の声POST)
  try {
    const rows = db.prepare(`
      SELECT id, poster_id, category, memo, identity_mode, created_at
      FROM wellness_posts
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC LIMIT 3
    `).all(days);
    for (const r of rows) {
      const isAnon = r.identity_mode && r.identity_mode !== 'open';
      events.push({
        type: 'wellness',
        icon: '🩺',
        label: '現場の声' + (r.category ? '(' + r.category + ')' : ''),
        summary: trunc(r.memo, 36),
        link: '/wellness.html',
        author: safeAuthor(db, r.poster_id, isAnon),
        created_at: r.created_at,
      });
    }
  } catch (e) {}

  // 時系列降順で並べて limit
  events.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, events: events.slice(0, limit) });
});

module.exports = router;
