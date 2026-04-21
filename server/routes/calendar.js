const express = require('express');
const { authUser } = require('../middleware/auth');
const { getDb } = require('../services/db');
const gcal = require('../services/gcal');

const router = express.Router();

// 連携状態
router.get('/status', authUser, (req, res) => {
  const u = getDb().prepare('SELECT google_cal_id FROM users WHERE id = ?').get(req.uid);
  res.json({
    success: true,
    linked: !!(u && u.google_cal_id),
    calendar_id: (u && u.google_cal_id) || null,
    service_account_email: gcal.getServiceAccountEmail(),
    service_available: !gcal.getInitError(),
    error: gcal.getInitError(),
  });
});

// 連携(カレンダーID登録+即テスト)
router.post('/link', authUser, express.json(), async (req, res) => {
  const calendarId = (req.body && req.body.calendar_id || '').trim();
  if (!calendarId) return res.status(400).json({ success: false, msg: 'カレンダーIDを入力してください' });
  // 基本バリデーション: メール形式か groupカレンダー形式
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(calendarId)) {
    return res.status(400).json({ success: false, msg: 'カレンダーIDの形式が正しくありません' });
  }
  // 接続テスト
  const test = await gcal.testAccess(calendarId);
  if (!test.ok) {
    return res.status(400).json({ success: false, msg: test.reason || '接続テスト失敗' });
  }
  getDb().prepare('UPDATE users SET google_cal_id = ? WHERE id = ?').run(calendarId, req.uid);
  res.json({ success: true, calendar_id: calendarId });
});

// 連携解除
router.delete('/link', authUser, (req, res) => {
  getDb().prepare('UPDATE users SET google_cal_id = NULL, last_cal_dm_date = NULL WHERE id = ?').run(req.uid);
  res.json({ success: true });
});

// 自分の直近予定(葵に質問された時のコンテキスト用)
router.get('/my-events', authUser, async (req, res) => {
  const u = getDb().prepare('SELECT google_cal_id, display_name FROM users WHERE id = ?').get(req.uid);
  if (!u || !u.google_cal_id) return res.json({ success: true, linked: false, events: [] });
  try {
    const events = await gcal.fetchEvents(u.google_cal_id, 7, 20);
    res.json({ success: true, linked: true, events });
  } catch (e) {
    res.status(503).json({ success: false, msg: e.message });
  }
});

module.exports = router;
