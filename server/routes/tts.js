// Google Cloud Text-to-Speech: 葵の読み上げ用 (CoWell流)
const express = require('express');
const { authUser } = require('../middleware/auth');
const { getDb } = require('../services/db');
const { readingOf, readingOfNick, applyNickReadings, readingOfUid, readingsVersion } = require('../services/name-readings');

const router = express.Router();

// ⭐2026-08-01: 読み上げの音声をディスクに保存して使い回す。
//   事故・破損のAI解説のように文面が変わらない読み上げは、2回目以降は合成せずに即返せる
//   (共有タブレットで何人も同じ報告を開くため、待ち時間とGoogleの合成料金の両方が減る)。
const fsx = require('fs'), pathx = require('path'), cryptox = require('crypto');
const TTS_CACHE_DIR = pathx.join(__dirname, '..', 'cache', 'tts');
try { fsx.mkdirSync(TTS_CACHE_DIR, { recursive: true }); } catch (e) {}
function ttsCacheKey(text, voice, speed, pitch) {
  return pathx.join(TTS_CACHE_DIR,
    cryptox.createHash('sha1').update([text, voice, speed, pitch].join('|')).digest('hex') + '.mp3');
}

const ALLOWED_VOICES = [
  'ja-JP-Neural2-B', 'ja-JP-Neural2-C', 'ja-JP-Neural2-D',
  'ja-JP-Wavenet-A', 'ja-JP-Wavenet-B', 'ja-JP-Wavenet-C', 'ja-JP-Wavenet-D',
  // 多言語(かんたんモードのcohub_lang連動): PT/EN女性ニューラル音声 (2026-07-09)
  'pt-BR-Neural2-A', 'pt-BR-Neural2-C', 'en-US-Neural2-C', 'en-US-Neural2-F',
  // Chirp3-HD 女性(高品質・⚠️pitch非対応=pitch:0で呼ぶこと)。AIヘルスアドバイザー用に葵と別声。
  // 声の切替はクライアントのvoice名を差し替えるだけ(下記いずれかは許可済)。
  'ja-JP-Chirp3-HD-Kore', 'ja-JP-Chirp3-HD-Aoede', 'ja-JP-Chirp3-HD-Leda',
  'ja-JP-Chirp3-HD-Vindemiatrix', 'ja-JP-Chirp3-HD-Sulafat', 'ja-JP-Chirp3-HD-Callirrhoe',
  'ja-JP-Chirp3-HD-Autonoe', 'ja-JP-Chirp3-HD-Achernar', 'ja-JP-Chirp3-HD-Despina',
];
const DEFAULT_VOICE = 'ja-JP-Neural2-B';

router.post('/tts', authUser, express.json(), async (req, res) => {
  try {
    const text = ((req.body && req.body.text) || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    // 読み上げ前に絵文字・記号(アイコン)を除去 — TTSが「📋」「🍱」等のアイコン種別まで
    // 読み上げてしまうのを防ぐ (2026-05-25 ユーザー要望)。
    const clipped = text.slice(0, 3000)
      .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')   // 絵文字・各種ピクトグラム
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')   // 地域表示記号(国旗)
      .replace(/[\u{2600}-\u{27BF}]/gu, '')     // その他記号・装飾記号(⚠☕✨等)
      .replace(/[\u{2B00}-\u{2BFF}]/gu, '')     // 矢印・記号(⭐等)
      .replace(/[\u{2190}-\u{21FF}]/gu, '')     // 矢印
      .replace(/[︀-️‍]/g, '')   // 異体字セレクタ・ZWJ
      .replace(/[㊗㊙©®‼⁉™ℹ]/g, '') // ㊗㊙©®‼⁉™ℹ
      // 製品名などの読み(デフォルト): CoWell=コーウェル (2026-07-22 社長指示)。英字のままだと綴り読みになるため。
      .replace(/CoWell/gi, 'コーウェル')
      // 当て字のニックネームを読みに置換 (PC版は文章をクライアントで組み立てるためここが唯一の共通点)
      .replace(/^[\s\S]*$/, applyNickReadings)
      .replace(/[ \t　]{2,}/g, ' ')
      .trim();
    if (!clipped) return res.status(400).json({ error: '読み上げる文字がありません' });
    const voice = ((req.body && req.body.voice) || DEFAULT_VOICE).toString();
    const safeVoice = ALLOWED_VOICES.includes(voice) ? voice : DEFAULT_VOICE;
    const langCode = safeVoice.slice(0, 5); // 'ja-JP' / 'pt-BR' / 'en-US' — 声名から言語判定
    const speed = Math.max(0.5, Math.min(2.0, parseFloat(req.body && req.body.speed) || 1.0));
    const pitch = Math.max(-10, Math.min(10, parseFloat(req.body && req.body.pitch) || 0));

    // 同じ文面・同じ声・同じ速さなら、保存済みの音声をそのまま返す(合成待ちゼロ)
    const cpath = ttsCacheKey(clipped, safeVoice, speed, pitch);
    try {
      if (fsx.existsSync(cpath)) {
        const cached = fsx.readFileSync(cpath);
        if (cached.length) {
          res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': cached.length, 'Cache-Control': 'no-cache' });
          return res.send(cached);
        }
      }
    } catch (e) {}

    const apiKey = process.env.GOOGLE_TTS_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'TTS API key未設定' });

    const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: clipped },
        voice: { languageCode: langCode, name: safeVoice },
        audioConfig: { audioEncoding: 'MP3', speakingRate: speed, pitch },
      }),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      return res.status(500).json({ error: (data.error && data.error.message) || 'TTS失敗' });
    }
    const buf = Buffer.from(data.audioContent, 'base64');
    try { fsx.writeFileSync(cpath, buf); } catch (e) {}   // 次回以降は合成しない
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 公開: 共用タブレットの「名前を呼んでPIN入力を促す」音声 (PIN前=未認証で鳴らすため非authUser)。
// 名前は名簿(tablet-roster)で既に公開・文言はサーバー固定ゆえTTS悪用不可。uidごとにキャッシュし実在ユーザーのみ生成。
const kioskPromptCache = new Map(); // uid -> Buffer
router.get('/tts-kiosk', async (req, res) => {
  try {
    const uid = String((req.query && req.query.uid) || '');
    if (!uid) return res.status(400).json({ error: 'uid required' });
    const sendBuf = (buf) => {
      res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
      res.send(buf);
    };
    // キャッシュキーに読み辞書の版を含める: 読みを直したら古い誤読音声を配らない
    const ckey = uid + '|' + readingsVersion();
    if (kioskPromptCache.has(ckey)) return sendBuf(kioskPromptCache.get(ckey));
    const u = getDb().prepare('SELECT display_name, nickname FROM users WHERE id = ?').get(uid);
    if (!u) return res.status(404).json({ error: 'not found' });
    // 実名(display_name)を使う。ニックネームは匿名ハンドル用途のため声に出すと匿名性が割れる(2026-07-01)。
    // 読みは全社員分の名簿 roster_yomi.json (uid引き) を正とする。無ければ辞書→素の氏名。
    const rawName = String(u.display_name || '').replace(/[\u{1F000}-\u{1FAFF}]/gu, '').slice(0, 40).trim();
    const name = readingOfUid(uid, rawName);
    const text = 'PINコードを入力してください。';
    const apiKey = process.env.GOOGLE_TTS_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'TTS API key未設定' });
    const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'ja-JP', name: DEFAULT_VOICE },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 1.2, pitch: 1.0 },
      }),
    });
    const data = await r.json();
    if (!r.ok || data.error) return res.status(500).json({ error: (data.error && data.error.message) || 'TTS失敗' });
    const buf = Buffer.from(data.audioContent, 'base64');
    if (kioskPromptCache.size < 1000) kioskPromptCache.set(ckey, buf);
    sendBuf(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AIヘルスアドバイザーの前置き音声「〇〇さん、今日の〇〇について、解説しますね。」(食事解説の冒頭)。
// 投稿者ニックネームは ひろば の匿名ハンドル=ヘルスが読み上げる(社長方針2026-07-23: ログイン=実名/その他=匿名)。
// nick+meal でキャッシュ(声=Despina)。audio src(GET)で鳴らすため非authUser・文言はサーバー固定テンプレで悪用不可。
const openerCache = new Map();   // nick|meal|rank|i -> Buffer
const OP_MEAL_LABEL = { breakfast: '朝食', lunch: '昼食', dinner: '夕食', snack: 'おやつ', morning: '朝食', noon: '昼食', night: '夕食' };
/* ⭐なぎさの喋り出し (2026-08-07 社長「本題の前のセリフがマンネリ」・タブレット対応)
   ⚠️⚠️ タブレットの前置きは **この音声がすべて** で、tablet-home.html の束(ADV_OPEN_*)は
      使われていなかった(`_advCompose` がどこからも呼ばれておらず、8/7の改修が効いていなかった)。
      文言を増やすときは **必ずここを直す**。クライアント側の束だけ増やしても声は変わらない。
   ⚠️ 文言はサーバー固定。クライアントからは「どれを使うか」(rank と 0-3 の番号)だけ受け取る
      =自由文を読ませられないので悪用できない(非authUserのGETで鳴らすため)。
   ⚠️ 長さは約8〜9秒に揃える(本文TTSの読込を覆うため)。短い文だけにすると本文までに間が空く。 */
const OP_OPEN = {
  // 良い一皿のとき
  good: [
    '今日の{L}、なかなか 良いですよ。',
    'わあ、良い{L}ですね。',
    'これは 良い一皿です。',
    '{L}、よく 整っていますよ。',
  ],
  // 気になる点があるとき
  care: [
    '今日の{L}、気づいた点が いくつか あります。',
    '{L}を 見ていきましょう。惜しい ところも ありますよ。',
    'では、今日の{L}について。',
    '{L}の 記録、ありがとう。',
  ],
  // 判定が出ていないとき
  // ⚠️後ろに付く OP_TAIL[(i+1)%4] と意味が重ならない言い回しにすること
  //   (例:『見せてもらいますね』+『拝見しましたので』は これから/もう見た が食い違う)
  base: [
    '今日の{L}ですね。',
    '{L}の 写真、ありがとう。',
    'では、今日の{L}について。',
    '{L}、記録してくれて ありがとう。',
  ],
};
// 本文の読込を覆う「間つなぎ」。上の喋り出しとずらして組み合わせる(同じ番号どうしにしない)。
const OP_TAIL = [
  '内容を しっかり 拝見しましたので、気づいた点を 順番に お伝えしていきますね。',
  '写真は じっくり 見せてもらいました。大事なところから お話ししていきますね。',
  'ぜんぶ 目を通しましたので、良い点から 順番に お伝えしていきますね。',
  '気づいたことを まとめましたので、ひとつずつ お話ししていきますね。',
];
router.get('/tts-opener', async (req, res) => {
  try {
    const rawNick = String((req.query && req.query.nick) || '')
      .replace(/[\u{1F000}-\u{1FAFF}]/gu, '').replace(/[\r\n\t]/g, '').trim().slice(0, 20);
    const meal = String((req.query && req.query.meal) || '');
    const nick = (rawNick && rawNick !== '匿名') ? rawNick : '';
    const label = OP_MEAL_LABEL[meal] || 'お食事';
    // どの喋り出しを使うか。範囲外・未指定は base の0番(=従来と同じ入り方)に落とす。
    const rank = OP_OPEN[String((req.query && req.query.rank) || '')] ? String(req.query.rank) : 'base';
    let vi = parseInt((req.query && req.query.i), 10); if (!(vi >= 0 && vi <= 3)) vi = 0;
    // 長め(約8〜9秒)にして本文TTSの読込を覆う=前置きと本文が途切れず同一話者に聞こえる(社長指示2026-07-23)
    // ニックネームは当て字が多く誤読されるため読み辞書を通す (2026-08-01 例: 唵斡嚩囉塔囉痲紇哩→オン バサラ タラマ キリク ソワカ)
    // ⚠️声が Chirp3-HD のため SSML(<break>)は使えない。読みの区切り(空白)は読点に置換して一呼吸入れる。
    //   例: 『オン バサラ タラマ キリク ソワカ』→『オン、バサラ、タラマ、キリク、ソワカ』(2026-08-01 社長指示)
    const nickSay = nick ? readingOfNick(nick).replace(/[ 　]+/g, '、') : '';
    const open = OP_OPEN[rank][vi].replace(/\{L\}/g, label);
    const tail = OP_TAIL[(vi + 1) % OP_TAIL.length];   // 喋り出しと間つなぎをずらす
    const text = (nickSay ? nickSay + 'さん、' : '') + 'ヘルスアドバイザーの、なぎさです。' + open + tail;
    const sendBuf = (buf) => {
      res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
      res.send(buf);
    };
    const ckey = nick + '|' + meal + '|' + rank + '|' + vi;
    if (openerCache.has(ckey)) return sendBuf(openerCache.get(ckey));
    const apiKey = process.env.GOOGLE_TTS_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'TTS API key未設定' });
    const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'ja-JP', name: 'ja-JP-Chirp3-HD-Despina' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 1.1 },   // Chirp3-HDはpitch非対応
      }),
    });
    const data = await r.json();
    if (!r.ok || data.error) return res.status(500).json({ error: (data.error && data.error.message) || 'TTS失敗' });
    const buf = Buffer.from(data.audioContent, 'base64');
    if (openerCache.size < 2000) openerCache.set(ckey, buf);
    sendBuf(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 氏名の読み(カナ)を返す (ログイン後あいさつの名前読み上げ補正用・クライアントが使用)。
router.get('/reading', authUser, (req, res) => {
  const name = String((req.query && req.query.name) || '').slice(0, 60);
  const uid = String((req.query && req.query.uid) || '');   // uidがあれば名簿を直接引く(同姓同名対策)
  res.json({ success: true, reading: uid ? readingOfUid(uid, name) : readingOf(name) });
});

module.exports = router;
