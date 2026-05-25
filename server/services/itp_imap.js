// ITP違反通知メール 自動受信ポーラ (2026-05-25)
// itp_web@stdun.co.jp の未読メールを定期巡回し、本文を alert.ingestText() に渡して取込→既読化。
// 接続情報は .env (ITP_IMAP_*)。設定が無ければ起動しない。
// 堅牢性メモ(2026-05-25事故): z114はSeen化/応答が詰まりやすく、ImapFlowの'error'(Socket timeout)を
// 拾わないとプロセス全体がクラッシュする。error handler + 各操作タイムアウト + 全体killerで防御。
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');

function cfg() {
  const e = process.env;
  if (!e.ITP_IMAP_HOST || !e.ITP_IMAP_USER || !e.ITP_IMAP_PASS) return null;
  return {
    host: e.ITP_IMAP_HOST,
    port: parseInt(e.ITP_IMAP_PORT, 10) || 993,
    secure: e.ITP_IMAP_SECURE !== 'false',
    auth: { user: e.ITP_IMAP_USER, pass: e.ITP_IMAP_PASS },
    logger: false,
    greetingTimeout: 15000,
    socketTimeout: 60000,
    // z114.secure.ne.jp 等の古い共用サーバ対応: TLS1.0許可 + レガシー再ネゴ許可(OpenSSL3対策)
    tls: {
      minVersion: 'TLSv1',
      rejectUnauthorized: e.ITP_IMAP_REJECT_UNAUTH !== 'false',
      secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    },
  };
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error((label || 'op') + ' timeout')), ms)),
  ]);
}

let _running = false;

// 1回の巡回: INBOX の未読を取得→ingest→既読化
async function pollOnce(ingestText) {
  const c = cfg();
  if (!c) return { ok: false, reason: 'IMAP未設定' };
  if (_running) return { ok: false, reason: 'skip(実行中)' };
  _running = true;
  const client = new ImapFlow(c);
  // ★ これが無いと未処理'error'でアプリ全体が落ちる
  client.on('error', (e) => console.warn('[itp-imap] client error:', e && e.message));
  let seen = 0, ingested = 0, dup = 0, skipped = 0, timedOut = false;
  const killer = setTimeout(() => { timedOut = true; try { client.close(); } catch (e) {} }, 90000);
  try {
    await withTimeout(client.connect(), 20000, 'connect');
    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
        if (timedOut) break;
        seen++;
        let text = '';
        try {
          const parsed = await simpleParser(msg.source);
          text = (parsed.subject || '') + '\n' + (parsed.text || htmlToText(parsed.html));
        } catch (e) { text = ''; }
        if (text.trim()) {
          const r = ingestText(text);
          if (r.ok && r.inserted) ingested++;
          else if (r.ok) dup++;
          else skipped++;
        } else skipped++;
        // Seen化はベストエフォート。詰まっても dedup_key(UNIQUE) で二重通知は起きない
        try { await withTimeout(client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true }), 8000, 'flag'); } catch (e) {}
      }
    } finally {
      try { lock.release(); } catch (e) {}
    }
    try { await withTimeout(client.logout(), 5000, 'logout'); } catch (e) {}
  } catch (e) {
    try { client.close(); } catch (_) {}
    clearTimeout(killer);
    _running = false;
    return { ok: false, reason: e.message };
  }
  clearTimeout(killer);
  try { client.close(); } catch (_) {}
  _running = false;
  return { ok: true, seen, ingested, dup, skipped };
}

// 定期巡回を開始 (index.js から呼ぶ)
function start(ingestText) {
  const c = cfg();
  if (!c) { console.log('[itp-imap] 未設定のため自動受信は無効'); return; }
  const interval = parseInt(process.env.ITP_IMAP_INTERVAL_MS, 10) || 300000;
  console.log(`[itp-imap] 自動受信を開始 (${c.auth.user} @ ${c.host}, ${Math.round(interval/1000)}s間隔)`);
  const run = () => pollOnce(ingestText).then(r => {
    if (r.ok && (r.seen || r.ingested)) console.log(`[itp-imap] 巡回: 未読${r.seen} 取込${r.ingested} 重複${r.dup} 除外${r.skipped}`);
    else if (!r.ok && r.reason !== 'skip(実行中)') console.warn('[itp-imap] 巡回失敗:', r.reason);
  }).catch(e => console.warn('[itp-imap] 巡回例外:', e && e.message));
  setTimeout(run, 15000);          // 起動15秒後に初回
  setInterval(run, interval);      // 以降は定期
}

module.exports = { start, pollOnce };
