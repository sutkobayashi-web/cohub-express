// 会社メール(IMAP/SMTP)連携 — 各メンバーが自分の @stdun.co.jp 受信箱をCoHub内で閲覧/送信
// パスワードは AES-256-GCM で暗号化保存。接続時のみ復号。
const express = require('express');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

const router = express.Router();

// ===== 暗号化 (AES-256-GCM) =====
const KEY_HEX = process.env.MAIL_ENC_KEY || '';
const KEY = KEY_HEX ? Buffer.from(KEY_HEX, 'hex') : null;
function encrypt(plain) {
  if (!KEY || KEY.length !== 32) throw new Error('MAIL_ENC_KEY未設定/不正');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.slice(0, 12), tag = buf.slice(12, 28), enc = buf.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function getCred(uid) {
  return getDb().prepare('SELECT * FROM user_mail_credentials WHERE user_id = ?').get(uid);
}
async function imapClient(cred) {
  const client = new ImapFlow({
    host: cred.imap_host, port: cred.imap_port, secure: true,
    auth: { user: cred.email, pass: decrypt(cred.enc_password) },
    logger: false,
    emitLogs: false,
  });
  await client.connect();
  return client;
}
function fromText(addr) {
  if (!addr || !addr[0]) return { name: '', address: '' };
  return { name: addr[0].name || '', address: addr[0].address || '' };
}
function hasAttachments(bs) {
  if (!bs) return false;
  if (bs.disposition === 'attachment') return true;
  if (Array.isArray(bs.childNodes)) return bs.childNodes.some(hasAttachments);
  return false;
}

// ===== 設定状況 =====
router.get('/status', authUser, (req, res) => {
  const c = getCred(req.uid);
  res.json({ success: true, configured: !!c, email: c ? c.email : '', imap_host: c ? c.imap_host : 'z114.secure.ne.jp', smtp_port: c ? c.smtp_port : 465 });
});

// ===== 資格情報の保存 (保存前にIMAPログイン検証) =====
router.post('/credentials', authUser, express.json(), async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().slice(0, 200);
  const password = String(b.password || '');
  if (!email || !password) return res.status(400).json({ success: false, msg: 'メールアドレスとパスワードは必須です' });
  if (!KEY || KEY.length !== 32) return res.status(500).json({ success: false, msg: 'サーバー暗号鍵が未設定です' });
  const imap_host = String(b.imap_host || 'z114.secure.ne.jp').slice(0, 100);
  const imap_port = parseInt(b.imap_port) || 993;
  const smtp_host = String(b.smtp_host || 'z114.secure.ne.jp').slice(0, 100);
  const smtp_port = parseInt(b.smtp_port) || 465;
  // 検証: 実際にIMAPログインできるか
  let client;
  try {
    client = new ImapFlow({ host: imap_host, port: imap_port, secure: true, auth: { user: email, pass: password }, logger: false, emitLogs: false });
    await client.connect();
    await client.logout();
  } catch (e) {
    try { if (client) await client.close(); } catch (_) {}
    const authFail = !!e.authenticationFailed;
    const resp = e.responseText || e.serverResponseCode || (e.response && (e.response.text || e.response)) || '';
    console.error('[mail-cred] login fail user=%s host=%s:%s authFailed=%s code=%s msg=%s resp=%s',
      email, imap_host, imap_port, authFail, e.code || '', e.message || '', String(resp).slice(0, 200));
    const detail = authFail ? '認証失敗（パスワード違いの可能性）' : ((e.message || '接続エラー') + (resp ? ' / ' + String(resp).slice(0, 120) : ''));
    // 422で返す: 401だとクライアントが「CoWellセッション切れ」と誤認してログアウトしてしまうため
    return res.status(422).json({ success: false, msg: 'メールにログインできませんでした（アドレス/パスワードをご確認ください）', detail: String(detail).slice(0, 180), auth_failed: authFail });
  }
  const enc = encrypt(password);
  getDb().prepare(`INSERT INTO user_mail_credentials (user_id, email, enc_password, imap_host, imap_port, smtp_host, smtp_port, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET email=excluded.email, enc_password=excluded.enc_password,
      imap_host=excluded.imap_host, imap_port=excluded.imap_port, smtp_host=excluded.smtp_host, smtp_port=excluded.smtp_port, updated_at=datetime('now')`)
    .run(req.uid, email, enc, imap_host, imap_port, smtp_host, smtp_port);
  res.json({ success: true, msg: '接続できました。保存しました' });
});

// ===== 資格情報の削除 =====
router.delete('/credentials', authUser, (req, res) => {
  getDb().prepare('DELETE FROM user_mail_credentials WHERE user_id = ?').run(req.uid);
  res.json({ success: true });
});

// ===== 受信一覧 (直近N件) =====
router.get('/inbox', authUser, async (req, res) => {
  const cred = getCred(req.uid);
  if (!cred) return res.status(400).json({ success: false, msg: 'メール未設定です', need_setup: true });
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const mailbox = String(req.query.mailbox || 'INBOX').slice(0, 60);
  let client;
  try {
    client = await imapClient(cred);
    const lock = await client.getMailboxLock(mailbox);
    try {
      const total = client.mailbox.exists || 0;
      const items = [];
      if (total > 0) {
        const start = Math.max(1, total - limit + 1);
        for await (const msg of client.fetch(`${start}:*`, { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true })) {
          const f = fromText(msg.envelope && msg.envelope.from);
          items.push({
            uid: msg.uid,
            subject: (msg.envelope && msg.envelope.subject) || '(件名なし)',
            from_name: f.name, from_addr: f.address,
            date: (msg.envelope && msg.envelope.date) || msg.internalDate,
            seen: msg.flags ? msg.flags.has('\\Seen') : true,
            attach: hasAttachments(msg.bodyStructure),
          });
        }
      }
      items.reverse(); // 新しい順
      res.json({ success: true, total, items });
    } finally { lock.release(); }
  } catch (e) {
    res.status(500).json({ success: false, msg: '受信箱の取得に失敗しました', detail: (e.message || '').slice(0, 150) });
  } finally {
    try { if (client) await client.logout(); } catch (_) {}
  }
});

// ===== 本文取得 (uid指定) + 既読化 =====
router.get('/message/:uid', authUser, async (req, res) => {
  const cred = getCred(req.uid);
  if (!cred) return res.status(400).json({ success: false, msg: 'メール未設定です' });
  const uid = parseInt(req.params.uid);
  if (!uid) return res.status(400).json({ success: false, msg: 'uid不正' });
  const mailbox = String(req.query.mailbox || 'INBOX').slice(0, 60);
  let client;
  try {
    client = await imapClient(cred);
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return res.status(404).json({ success: false, msg: 'メッセージが見つかりません' });
      const parsed = await simpleParser(msg.source);
      try { await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); } catch (_) {}
      res.json({
        success: true,
        subject: parsed.subject || '(件名なし)',
        from: parsed.from ? parsed.from.text : '',
        to: parsed.to ? parsed.to.text : '',
        cc: parsed.cc ? parsed.cc.text : '',
        date: parsed.date || null,
        text: parsed.text || '',
        html: parsed.html || '',
        attachments: (parsed.attachments || []).map(a => ({ filename: a.filename || '添付', contentType: a.contentType, size: a.size })),
      });
    } finally { lock.release(); }
  } catch (e) {
    res.status(500).json({ success: false, msg: '本文の取得に失敗しました', detail: (e.message || '').slice(0, 150) });
  } finally {
    try { if (client) await client.logout(); } catch (_) {}
  }
});

module.exports = router;
