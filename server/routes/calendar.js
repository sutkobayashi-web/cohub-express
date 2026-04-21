const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { authUser } = require('../middleware/auth');

const router = express.Router();

const SA_PATH = process.env.GOOGLE_SA_JSON || path.join(__dirname, '..', '..', 'config', 'google-sa.json');
// 複数カレンダー対応: カンマ区切りで指定可
const CALENDAR_IDS = (process.env.GOOGLE_CALENDAR_IDS || 'lmaqhcdd4dg1a21thectfstdtg@group.calendar.google.com,85fffa4dd9edfced539d5e65b7c727c8533b05374bed4180e7e2e08c98c4b80f@group.calendar.google.com')
  .split(',').map(s => s.trim()).filter(Boolean);
const TIME_ZONE = 'Asia/Tokyo';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_EVENTS = 20;
const PER_CAL_MAX = 30;

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

async function fetchOneCalendar(calendarId) {
  try {
    const res = await calendarClient.events.list({
      calendarId,
      timeMin: new Date().toISOString(),
      maxResults: PER_CAL_MAX,
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: TIME_ZONE,
    });
    return (res.data.items || []).map(ev => ({
      id: `${calendarId}:${ev.id}`,
      calendar_id: calendarId,
      summary: ev.summary || '(無題)',
      start: ev.start && (ev.start.dateTime || ev.start.date),
      end: ev.end && (ev.end.dateTime || ev.end.date),
      allDay: !!(ev.start && ev.start.date && !ev.start.dateTime),
      location: ev.location || '',
      htmlLink: ev.htmlLink || '',
    }));
  } catch (e) {
    console.warn('calendar fetch err for', calendarId, ':', e.code || '', e.message.split('\n')[0]);
    return { __error: true, calendar_id: calendarId, code: e.code, msg: e.message.split('\n')[0] };
  }
}

async function fetchUpcoming() {
  initClient();
  if (!calendarClient) throw new Error(initError || 'Calendar未初期化');
  const results = await Promise.all(CALENDAR_IDS.map(id => fetchOneCalendar(id)));
  const errors = results.filter(r => r && r.__error);
  const all = results.filter(r => Array.isArray(r)).flat();
  all.sort((a, b) => new Date(a.start) - new Date(b.start));
  const items = all.slice(0, MAX_EVENTS);
  if (items.length === 0 && errors.length > 0) {
    const e = errors[0];
    throw new Error(`${e.msg || 'Not Found'}`);
  }
  return { updated_at: Date.now(), events: items, errors };
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
