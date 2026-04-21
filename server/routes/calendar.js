const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { authUser } = require('../middleware/auth');

const router = express.Router();

const SA_PATH = process.env.GOOGLE_SA_JSON || path.join(__dirname, '..', '..', 'config', 'google-sa.json');
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'lmaqhcdd4dg1a21thectfstdtg@group.calendar.google.com';
const TIME_ZONE = 'Asia/Tokyo';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_EVENTS = 20;

let calendarClient = null;
let initError = null;
function initClient() {
  if (calendarClient || initError) return;
  try {
    if (!fs.existsSync(SA_PATH)) {
      initError = 'サービスアカウントJSONが配置されていません';
      return;
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: SA_PATH,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    calendarClient = google.calendar({ version: 'v3', auth });
  } catch (e) {
    initError = e.message;
  }
}

let cache = { at: 0, data: null };
let inflight = null;

async function fetchUpcoming() {
  initClient();
  if (!calendarClient) throw new Error(initError || 'Calendar未初期化');
  const res = await calendarClient.events.list({
    calendarId: CALENDAR_ID,
    timeMin: new Date().toISOString(),
    maxResults: MAX_EVENTS,
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: TIME_ZONE,
  });
  const items = (res.data.items || []).map(ev => ({
    id: ev.id,
    summary: ev.summary || '(無題)',
    start: ev.start && (ev.start.dateTime || ev.start.date),
    end: ev.end && (ev.end.dateTime || ev.end.date),
    allDay: !!(ev.start && ev.start.date && !ev.start.dateTime),
    location: ev.location || '',
    htmlLink: ev.htmlLink || '',
  }));
  return { updated_at: Date.now(), events: items };
}

router.get('/upcoming', authUser, async (req, res) => {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_TTL_MS) {
    return res.json({ success: true, cached: true, ...cache.data });
  }
  try {
    if (!inflight) inflight = fetchUpcoming().finally(() => { inflight = null; });
    const data = await inflight;
    cache = { at: now, data };
    res.json({ success: true, cached: false, ...data });
  } catch (e) {
    console.warn('calendar fetch err:', e.message);
    if (cache.data) {
      return res.json({ success: true, cached: true, stale: true, ...cache.data });
    }
    res.status(503).json({ success: false, msg: 'カレンダーを取得できません', detail: e.message });
  }
});

module.exports = router;
