// TTS氏名読み辞書 (サーバー単一ソース)。Google TTSの誤読対策 (例: 岡田恭司→オカダキョウジ✕/オカダ ヤスジ◯)。
// 元は public/global-notif.js・chat-simple.html・m.html のクライアント辞書と同内容。新規はここに追記する。
const fs = require('fs');
const path = require('path');

const NAME_READINGS = {
  '小林 猛': 'コバヤシ タケシ', '小林　猛': 'コバヤシ タケシ', '小林猛': 'コバヤシ タケシ',
  '金子 力': 'カネコ チカラ', '金子　力': 'カネコ チカラ', '金子力': 'カネコ チカラ',
  '岡田 恭司': 'オカダ ヤスジ', '岡田　恭司': 'オカダ ヤスジ', '岡田恭司': 'オカダ ヤスジ',
  '土古 辰雄': 'ツチコ タツオ', '土古　辰雄': 'ツチコ タツオ', '土古辰雄': 'ツチコ タツオ',
  '鈴木 有博': 'スズキ アリヒロ', '鈴木　有博': 'スズキ アリヒロ', '鈴木有博': 'スズキ アリヒロ',
};

// 全社員分の読みは public/assets/roster_yomi.json (uid -> カナ) が正。
// タブレット名簿/葵の挨拶はこれを使っているのに、サーバー側TTS(名前の呼び出し等)は上の4名辞書しか
// 見ておらず、他の社員は全員TTSの当て推量で読まれていた (2026-07-21修正)。同じ辞書を共有する。
const ROSTER_PATH = path.join(__dirname, '..', '..', 'public', 'assets', 'roster_yomi.json');
let _roster = {};
let _rosterMtime = -1;
let _byName = null;   // 正規化した表示名 -> カナ (uidが無い経路用)

function rosterYomi() {
  try {
    const mt = fs.statSync(ROSTER_PATH).mtimeMs;   // 読みを直したら即反映 (restart不要)
    if (mt !== _rosterMtime) {
      _roster = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8')) || {};
      _rosterMtime = mt;
      _byName = null;
    }
  } catch (e) { /* 名簿が無ければ4名辞書のみで動作 */ }
  return _roster;
}

const normName = (s) => String(s).replace(/[\s　]+/g, '');

// 氏名しか分からない経路(事故一報の読み上げ等)向けに、名簿を表示名で引けるようにする
function byName() {
  rosterYomi();
  if (_byName) return _byName;
  const map = {};
  try {
    const { getDb } = require('./db');
    const rows = getDb().prepare('SELECT id, display_name FROM users').all();
    for (const r of rows) {
      const y = _roster[String(r.id)];
      if (y && r.display_name) map[normName(r.display_name)] = y;
    }
  } catch (e) { /* DB未初期化時は空マップ */ }
  _byName = map;
  return map;
}

// 完全一致 → 空白(半角/全角)無視の正規化一致 → 名簿(表示名引き) → 無ければ素のまま返す
function readingOf(name) {
  if (!name) return name;
  if (NAME_READINGS[name]) return NAME_READINGS[name];
  const norm = normName(name);
  for (const k in NAME_READINGS) {
    if (Object.prototype.hasOwnProperty.call(NAME_READINGS, k)
        && normName(k) === norm) return NAME_READINGS[k];
  }
  const fromRoster = byName()[norm];
  if (fromRoster) return fromRoster;
  return name;
}

// uidが分かる経路(タブレット等)はこちら: 名簿の読み優先 → 4名辞書 → 素の氏名
function readingOfUid(uid, fallbackName) {
  const y = uid ? rosterYomi()[String(uid)] : null;
  if (y) return y;
  return readingOf(fallbackName);
}

// 名簿の版 (音声キャッシュのキー用)。読みを直せば値が変わり、古い誤読音声が残らない。
function readingsVersion() {
  rosterYomi();
  return String(_rosterMtime);
}

// クライアント(global-notif.js / chat-simple.html)へ配る読み一覧。
// 正規化した表示名(空白除去) -> カナ。手動辞書を名簿より優先で上書きする。
function allReadings() {
  const map = Object.assign({}, byName());
  for (const k in NAME_READINGS) {
    if (Object.prototype.hasOwnProperty.call(NAME_READINGS, k)) map[normName(k)] = NAME_READINGS[k];
  }
  return map;
}

module.exports = { NAME_READINGS, readingOf, readingOfUid, readingsVersion, allReadings };
