// Google Calendar サービス: サービスアカウント経由で各社員のカレンダーを取得
const fs = require('fs');
const path = require('path');

const SA_PATH = process.env.GOOGLE_SA_JSON || path.join(__dirname, '..', '..', 'config', 'google-sa.json');
const TIME_ZONE = 'Asia/Tokyo';

let client = null;
let initError = null;
let serviceAccountEmail = null;

function init() {
  if (client || initError) return;
  try {
    if (!fs.existsSync(SA_PATH)) {
      initError = 'サービスアカウントJSON未配置';
      return;
    }
    const { google } = require('googleapis');
    const saJson = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
    serviceAccountEmail = saJson.client_email;
    const auth = new google.auth.GoogleAuth({
      keyFile: SA_PATH,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    client = google.calendar({ version: 'v3', auth });
  } catch (e) {
    initError = e.message;
  }
}
init();

function getServiceAccountEmail() {
  return serviceAccountEmail || null;
}

function getInitError() {
  return client ? null : (initError || '未初期化');
}

// 指定カレンダーの予定を取得 (今日〜指定日数先)
async function fetchEvents(calendarId, daysAhead = 2, maxResults = 15) {
  if (!client) throw new Error(initError || 'Calendar未初期化');
  const now = new Date();
  const timeMin = new Date(now); timeMin.setHours(0, 0, 0, 0); // 当日0時から
  const timeMax = new Date(now);
  timeMax.setDate(timeMax.getDate() + daysAhead);
  timeMax.setHours(23, 59, 59, 999);
  const res = await client.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: TIME_ZONE,
  });
  return (res.data.items || []).map(ev => ({
    id: ev.id,
    summary: ev.summary || '(無題)',
    start: ev.start && (ev.start.dateTime || ev.start.date),
    end: ev.end && (ev.end.dateTime || ev.end.date),
    allDay: !!(ev.start && ev.start.date && !ev.start.dateTime),
    location: ev.location || '',
  }));
}

// 接続テスト: calendarIdに対してアクセスできるか確認
async function testAccess(calendarId) {
  if (!client) return { ok: false, reason: initError || '未初期化' };
  try {
    await client.calendars.get({ calendarId });
    return { ok: true };
  } catch (e) {
    const code = e.code || 0;
    let reason = e.message.split('\n')[0];
    if (code === 404) reason = 'カレンダーが見つかりません (共有設定を確認してください)';
    else if (code === 403) reason = 'アクセス権限がありません (共有設定を確認してください)';
    return { ok: false, code, reason };
  }
}

// 予定リストを自然な日本語テキストに (葵のDM本文用)
function formatEventsForGreeting(events, userName) {
  if (!events || events.length === 0) {
    return `${userName}さん、おはようございます。本日の予定は登録されていないようです。ゆっくりした1日を。`;
  }
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(tomorrow); dayAfter.setDate(dayAfter.getDate() + 1);

  const pad = n => String(n).padStart(2, '0');
  const fmtTime = ev => {
    if (ev.allDay) return '終日';
    const s = new Date(ev.start);
    return `${pad(s.getHours())}:${pad(s.getMinutes())}`;
  };
  const lines = [];
  const todayEvents = events.filter(ev => {
    const d = new Date(ev.start); d.setHours(0, 0, 0, 0);
    return d.getTime() === today.getTime() && (ev.allDay || new Date(ev.start) >= now);
  });
  const tomorrowEvents = events.filter(ev => {
    const d = new Date(ev.start); d.setHours(0, 0, 0, 0);
    return d.getTime() === tomorrow.getTime();
  });
  if (todayEvents.length > 0) {
    lines.push('【本日】');
    todayEvents.slice(0, 5).forEach(ev => {
      lines.push(`・${fmtTime(ev)} ${ev.summary}${ev.location ? ` @${ev.location}` : ''}`);
    });
  }
  if (tomorrowEvents.length > 0) {
    lines.push('【明日】');
    tomorrowEvents.slice(0, 3).forEach(ev => {
      lines.push(`・${fmtTime(ev)} ${ev.summary}`);
    });
  }
  if (lines.length === 0) {
    return `${userName}さん、おはようございます。以降の予定は登録されていないようです。`;
  }
  return `${userName}さん、本日の予定です。\n${lines.join('\n')}\n\n頑張ってくださいね✨`;
}

module.exports = {
  getServiceAccountEmail,
  getInitError,
  fetchEvents,
  testAccess,
  formatEventsForGreeting,
};
