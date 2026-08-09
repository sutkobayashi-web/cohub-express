// 天気予報プロキシ (共用タブレットのログイン画面用・公開)。
// 設置拠点(company_code)→座標→Open-Meteo(無料/キー不要)で当日の天気を返す。30分キャッシュ。
// ⚠️座標は暫定(拠点の正確な住所が不明なため概算)。要確認・補正可。
const express = require('express');
const router = express.Router();

const LOC = {
  SU_HQ:       { lat: 35.446, lon: 139.391, name: '海老名' },
  SU_SAITAMA:  { lat: 35.862, lon: 139.646, name: '埼玉' },
  SU_ZAMA:     { lat: 35.489, lon: 139.408, name: '座間' },
  SU_MKANTO:   { lat: 35.446, lon: 139.391, name: '南関東' },
  SU_KANRI:    { lat: 35.446, lon: 139.391, name: '海老名' },
  SUZUE:       { lat: 34.718, lon: 137.851, name: '磐田' },
  IBA_SANWA:   { lat: 36.178, lon: 139.755, name: '三和' },
  IBA_KASHIMA: { lat: 35.965, lon: 140.645, name: '鹿嶋' }
};
const DEFAULT = LOC.SU_HQ;

// WMO weather code → 絵文字・日本語
function descOf(code) {
  if (code === 0) return { i: '☀️', t: '快晴' };
  if (code === 1 || code === 2) return { i: '🌤️', t: '晴れ' };
  if (code === 3) return { i: '☁️', t: 'くもり' };
  if (code === 45 || code === 48) return { i: '🌫️', t: '霧' };
  if (code >= 51 && code <= 57) return { i: '🌦️', t: '霧雨' };
  if (code >= 61 && code <= 67) return { i: '🌧️', t: '雨' };
  if (code >= 71 && code <= 77) return { i: '🌨️', t: '雪' };
  if (code >= 80 && code <= 82) return { i: '🌦️', t: 'にわか雨' };
  if (code >= 85 && code <= 86) return { i: '🌨️', t: 'にわか雪' };
  if (code >= 95) return { i: '⛈️', t: '雷雨' };
  return { i: '🌡️', t: '' };
}

const cache = {};            // key -> { at, data }
const TTL = 30 * 60 * 1000;  // 30分

router.get('/', async (req, res) => {
  const co = String(req.query.loc || '').toUpperCase();
  const loc = LOC[co] || DEFAULT;
  const key = LOC[co] ? co : 'DEFAULT';
  try {
    const c = cache[key];
    if (c && (Date.now() - c.at) < TTL) return res.json(c.data);
    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + loc.lat + '&longitude=' + loc.lon
      + '&current=temperature_2m,weather_code'
      + '&daily=temperature_2m_max,temperature_2m_min,weather_code'
      + '&timezone=Asia%2FTokyo&forecast_days=1';
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('open-meteo ' + r.status);
    const j = await r.json();
    const cur = j.current || {};
    const day = j.daily || {};
    const wc = (cur.weather_code != null) ? cur.weather_code
      : ((day.weather_code && day.weather_code[0] != null) ? day.weather_code[0] : 0);
    const d = descOf(wc);
    const rd = (v) => (v == null || isNaN(v)) ? null : Math.round(v);
    const data = {
      success: true,
      place: loc.name,
      temp: rd(cur.temperature_2m),
      hi: rd((day.temperature_2m_max || [])[0]),
      lo: rd((day.temperature_2m_min || [])[0]),
      icon: d.i,
      desc: d.t
    };
    cache[key] = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    // 直近キャッシュがあれば古くても返す(APIダウン時の劣化運用)
    if (cache[key]) return res.json(cache[key].data);
    res.json({ success: false });
  }
});

module.exports = router;
