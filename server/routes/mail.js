// 会社メール(IMAP/SMTP)連携 — 各メンバーが自分の @stdun.co.jp 受信箱をCoHub内で閲覧/送信
// パスワードは AES-256-GCM で暗号化保存。接続時のみ復号。
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { Readable } = require('stream');
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// ===== ウイルススキャン (ClamAV / clamd) =====
let _clamPromise = null;
function getClam() {
  if (!_clamPromise) {
    const NodeClam = require('clamscan');
    _clamPromise = new NodeClam().init({
      removeInfected: false,
      clamdscan: { socket: '/run/clamav/clamd.ctl', localFallback: false, timeout: 30000 },
      preference: 'clamdscan',
    }).catch(e => { console.warn('[clam] init fail:', e.message); return null; });
  }
  return _clamPromise;
}
// 戻り: { ok:true } 安全 / { infected:true, virus } 検出 / { error } スキャン不能(=フェイルオープン: 端末AVが最後の砦)
async function scanBuffer(buf) {
  try {
    if (!buf || !buf.length) return { ok: true };
    const clam = await getClam();
    if (!clam) return { error: 'clamd未初期化' };
    const res = await clam.scanStream(Readable.from(buf));
    if (res && res.isInfected) return { infected: true, virus: (res.viruses && res.viruses[0]) || 'Unknown' };
    return { ok: true };
  } catch (e) { return { error: (e && e.message) || 'scan error' }; }
}

// multer(busboy)はファイル名をlatin1で渡すため日本語が文字化け→往復一致時のみutf8復元
function decodeFilename(name) {
  if (!name) return name;
  try {
    const buf = Buffer.from(name, 'latin1');
    const utf8 = buf.toString('utf8');
    if (Buffer.from(utf8, 'utf8').equals(buf)) return utf8;
  } catch (e) {}
  return name;
}
// 送信添付: メモリ保存(nodemailerへbufferで渡す)。1ファイル20MB・最大10件
const mailUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 10 } });

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

// z114.secure.ne.jp は古いメールサーバーで TLS1.0 のみ・レガシー再ネゴシエーション必須。
// Nodeの既定では接続できないため、レガシーTLSを明示的に許可する (実測で確定した組み合わせ)。
const MAIL_TLS = {
  minVersion: 'TLSv1',
  ciphers: 'DEFAULT@SECLEVEL=0',
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
};

function getCred(uid) {
  return getDb().prepare('SELECT * FROM user_mail_credentials WHERE user_id = ?').get(uid);
}
async function imapClient(cred) {
  const client = new ImapFlow({
    host: cred.imap_host, port: cred.imap_port, secure: true,
    auth: { user: cred.email, pass: decrypt(cred.enc_password) },
    tls: MAIL_TLS,
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
// 自動振り分け: ルール(優先度順)を評価し最初に一致した label_id を返す。無ければ null。
// fields = { from, subject, to } (いずれも小文字化前の文字列)
function classifyLabel(fields, rules) {
  for (const r of rules) {
    if (!r.enabled) continue;
    const hay = String(fields[r.field] != null ? fields[r.field] : '').toLowerCase();
    const needle = String(r.value || '').toLowerCase().trim();
    if (!needle) continue;
    let hit;
    if (r.op === 'equals') hit = (hay === needle);
    else if (r.op === 'starts') hit = hay.startsWith(needle);
    else hit = hay.includes(needle); // contains (既定)
    if (hit) return r.label_id;
  }
  return null;
}
// IMAPメールボックスの役割を判定 (special-use優先、無ければ名前で推定)
function mailboxRole(box) {
  const su = String(box.specialUse || '').toLowerCase();
  if (su.includes('sent')) return 'sent';
  if (su.includes('draft')) return 'drafts';
  if (su.includes('trash')) return 'trash';
  if (su.includes('junk')) return 'junk';
  if ((box.path || '').toUpperCase() === 'INBOX') return 'inbox';
  const n = (box.name || box.path || '').toLowerCase();
  if (/sent|送信/.test(n)) return 'sent';
  if (/draft|下書|草稿/.test(n)) return 'drafts';
  if (/trash|deleted|ゴミ|ごみ|削除/.test(n)) return 'trash';
  if (/junk|spam|迷惑/.test(n)) return 'junk';
  return 'other';
}
// 指定役割のメールボックスのパスを返す (見つからなければ null)
async function findMailboxPath(client, role) {
  try {
    const list = await client.list();
    for (const b of list) {
      const flags = b.flags || new Set();
      if (flags.has && flags.has('\\Noselect')) continue;
      if (mailboxRole(b) === role) return b.path;
    }
  } catch (_) {}
  return null;
}
// rootId とその子孫すべてのラベルIDの集合 (多層階フォルダの親選択時に配下も含めるため)
function descendantIds(rootId, labels) {
  const childrenOf = {};
  for (const l of labels) { const p = l.parent_id || 0; (childrenOf[p] = childrenOf[p] || []).push(l.id); }
  const out = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of (childrenOf[cur] || [])) { if (!out.has(c)) { out.add(c); stack.push(c); } }
  }
  return out;
}

// ===== 設定状況 =====
router.get('/status', authUser, (req, res) => {
  const c = getCred(req.uid);
  res.json({ success: true, configured: !!c, email: c ? c.email : '', imap_host: c ? c.imap_host : 'z114.secure.ne.jp', smtp_port: c ? c.smtp_port : 465,
    display_name: c ? (c.display_name || '') : '', signature: c ? (c.signature || '') : '' });
});

// ===== 差出人名・署名の保存 (パスワード再入力不要) =====
router.post('/settings', authUser, express.json(), (req, res) => {
  const c = getCred(req.uid);
  if (!c) return res.status(400).json({ success: false, msg: '先にメール設定（アドレス/パスワード）が必要です' });
  const display_name = String((req.body && req.body.display_name) || '').slice(0, 100);
  const signature = String((req.body && req.body.signature) || '').slice(0, 2000);
  getDb().prepare("UPDATE user_mail_credentials SET display_name=?, signature=?, updated_at=datetime('now') WHERE user_id=?")
    .run(display_name, signature, req.uid);
  res.json({ success: true });
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
    client = new ImapFlow({ host: imap_host, port: imap_port, secure: true, auth: { user: email, pass: password }, tls: MAIL_TLS, logger: false, emitLogs: false });
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
  const mailbox = String(req.query.mailbox || 'INBOX').slice(0, 200);
  const isInbox = (mailbox === 'INBOX');
  // role: 標準フォルダ種別。sent/drafts は「宛先(To)」を相手として表示
  const role = String(req.query.role || '').slice(0, 20);
  const outgoing = (role === 'sent' || role === 'drafts');
  // folder: 'inbox'(既定/未ラベル) | 'all'(全件) | '<labelId>'(そのフォルダ)  ※INBOX時のみ有効
  const folder = String(req.query.folder || 'inbox');
  // 最新から scan 件のヘッダを取得対象にする(ローカル蓄積なしのためルールはこの範囲に適用)
  const scan = Math.min(Math.max(parseInt(req.query.scan) || 120, 30), 400);
  let client;
  try {
    // 個人のラベルと有効ルール(優先度順) ※振り分けはINBOXのみ
    const labels = isInbox ? getDb().prepare('SELECT id, name, color, parent_id FROM mail_labels WHERE user_id = ? ORDER BY sort_order, id').all(req.uid) : [];
    const rules = isInbox ? getDb().prepare('SELECT id, label_id, field, op, value, enabled FROM mail_rules WHERE user_id = ? AND enabled = 1 ORDER BY sort_order, id').all(req.uid) : [];

    client = await imapClient(cred);
    // 読み取り専用(EXAMINE)で開く: サーバーに\Seenを付けない/移動削除もしない=元メーラー(Gmail POP3取込等)に非干渉。
    // ※書き込みSELECTで本文(BODY[])を取得するとサーバーが自動で\Seenを付け、Gmailの他アカ取込が既読を取り込まず取りこぼす問題への対処。
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const total = client.mailbox.exists || 0;
      const all = [];
      const cohubSeen = new Set(getDb().prepare('SELECT message_id FROM cohub_mail_seen WHERE user_id = ?').all(req.uid).map(r => r.message_id));
      const memberMap = {};
      for (const r of getDb().prepare(`SELECT LOWER(mc.email) AS email, u.avatar_url AS avatar, u.display_name AS name
        FROM user_mail_credentials mc JOIN users u ON u.id = mc.user_id`).all()) {
        if (r.email) memberMap[r.email] = { avatar: r.avatar || null, name: r.name || '' };
      }
      const blockSet = new Set(getDb().prepare('SELECT address FROM user_mail_blocklist WHERE user_id = ?').all(req.uid).map(r => (r.address || '').toLowerCase()));
      const hiddenSet = new Set(getDb().prepare('SELECT message_id FROM user_mail_hidden WHERE user_id = ?').all(req.uid).map(r => r.message_id));
      const end = total;
      if (total > 0) {
        const start = Math.max(1, end - scan + 1);
        for await (const msg of client.fetch(`${start}:${end}`, { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true })) {
          const f = fromText(msg.envelope && msg.envelope.from);
          const t = fromText(msg.envelope && msg.envelope.to);
          const peer = outgoing ? t : f; // 送信系は宛先、それ以外は差出人を「相手」として表示
          const mid = (msg.envelope && msg.envelope.messageId) || '';
          if (!outgoing && f.address && blockSet.has(f.address.toLowerCase())) continue; // 迷惑メール除外は受信系のみ
          if (mid && hiddenSet.has(mid)) continue;
          const serverSeen = msg.flags ? msg.flags.has('\\Seen') : true;
          const mem = peer.address ? memberMap[peer.address.toLowerCase()] : null;
          const subject = (msg.envelope && msg.envelope.subject) || '(件名なし)';
          // 自動振り分け: 一致ラベルを判定 (INBOXのみ)
          const labelId = isInbox ? classifyLabel(
            { from: (f.address || '') + ' ' + (f.name || ''), subject, to: t.address || '' },
            rules
          ) : null;
          all.push({
            uid: msg.uid,
            message_id: mid,
            subject,
            from_name: peer.name, from_addr: peer.address,
            avatar_url: mem ? mem.avatar : null,
            is_member: !!mem,
            date: (msg.envelope && msg.envelope.date) || msg.internalDate,
            seen: serverSeen || (!!mid && cohubSeen.has(mid)),
            attach: hasAttachments(msg.bodyStructure),
            label_id: labelId,
            outgoing,
          });
        }
      }
      all.reverse(); // 新しい順

      // INBOX以外(標準フォルダ)はルール非適用で全件そのまま返す
      if (!isInbox) {
        return res.json({ success: true, total, scanned: scan, mailbox, role, outgoing, items: all, labels: [], counts: {} });
      }

      // フォルダ別「未読」カウント (scan範囲内)。inbox=未ラベル。既読(cohub_mail_seen/サーバ\Seen)は数えない
      const counts = { inbox: 0 };
      for (const l of labels) counts[l.id] = 0;
      for (const m of all) {
        if (m.seen) continue; // 既読は未読バッジに含めない
        if (m.label_id == null) counts.inbox++;
        else if (counts[m.label_id] != null) counts[m.label_id]++;
        else counts.inbox++; // ラベル削除済みは受信箱扱い
      }

      // 要求フォルダで絞り込み (親フォルダ選択時は子孫フォルダのメールも含める)
      let items;
      if (folder === 'all') items = all;
      else if (folder === 'inbox') items = all.filter(m => m.label_id == null || counts[m.label_id] == null);
      else {
        const fid = parseInt(folder);
        const set = descendantIds(fid, labels);
        items = all.filter(m => m.label_id != null && set.has(m.label_id));
      }

      res.json({ success: true, total, scanned: scan, folder, mailbox, items, labels, counts });
    } finally { lock.release(); }
  } catch (e) {
    res.status(500).json({ success: false, msg: '受信箱の取得に失敗しました', detail: (e.message || '').slice(0, 150) });
  } finally {
    try { if (client) await client.logout(); } catch (_) {}
  }
});

// ===== 標準フォルダ(送信済み/下書き/ゴミ箱/迷惑メール)の一覧 =====
router.get('/mailboxes', authUser, async (req, res) => {
  const cred = getCred(req.uid);
  if (!cred) return res.status(400).json({ success: false, msg: 'メール未設定です', need_setup: true });
  const ROLE_NAME = { sent: '送信済み', drafts: '下書き', junk: '迷惑メール', trash: 'ゴミ箱' };
  const ORDER = ['sent', 'drafts', 'junk', 'trash'];
  let client;
  try {
    client = await imapClient(cred);
    const list = await client.list();
    const seen = {};
    const std = [];
    for (const b of list) {
      const flags = b.flags || new Set();
      if (flags.has && flags.has('\\Noselect')) continue;
      const role = mailboxRole(b);
      if (ROLE_NAME[role] && !seen[role]) { seen[role] = true; std.push({ path: b.path, role, name: ROLE_NAME[role] }); }
    }
    std.sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role));
    res.json({ success: true, mailboxes: std });
  } catch (e) {
    res.status(500).json({ success: false, msg: 'フォルダ一覧の取得に失敗しました', detail: (e.message || '').slice(0, 150) });
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
  const mailbox = String(req.query.mailbox || 'INBOX').slice(0, 200);
  let client;
  try {
    client = await imapClient(cred);
    // 読み取り専用(EXAMINE)で開く: サーバーに\Seenを付けない/移動削除もしない=元メーラー(Gmail POP3取込等)に非干渉。
    // ※書き込みSELECTで本文(BODY[])を取得するとサーバーが自動で\Seenを付け、Gmailの他アカ取込が既読を取り込まず取りこぼす問題への対処。
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return res.status(404).json({ success: false, msg: 'メッセージが見つかりません' });
      const parsed = await simpleParser(msg.source);
      // ★サーバーの\\Seenは付けない: 元のメールソフトで「新着(未読)」のまま残すため(削除・移動もしない)。
      //   既読管理はCoHub内だけで行う(message_idを記録)。
      try { if (parsed.messageId) getDb().prepare('INSERT OR IGNORE INTO cohub_mail_seen (user_id, message_id) VALUES (?, ?)').run(req.uid, parsed.messageId); } catch (_) {}
      const fromAddr = (parsed.from && parsed.from.value && parsed.from.value[0]) ? parsed.from.value[0].address : '';
      // 添付をウイルススキャン(ClamAV)して感染フラグを付ける
      const attachments = await Promise.all((parsed.attachments || []).map(async (a, i) => {
        const sc = await scanBuffer(a.content);
        return { index: i, filename: a.filename || ('添付' + (i + 1)), contentType: a.contentType, size: a.size,
          infected: !!sc.infected, virus: sc.virus || null, scanned: !sc.error };
      }));
      res.json({
        success: true,
        subject: parsed.subject || '(件名なし)',
        from: parsed.from ? parsed.from.text : '',
        from_addr: fromAddr,
        to: parsed.to ? parsed.to.text : '',
        cc: parsed.cc ? parsed.cc.text : '',
        to_addrs: (parsed.to && parsed.to.value || []).map(v => v.address).filter(Boolean),
        cc_addrs: (parsed.cc && parsed.cc.value || []).map(v => v.address).filter(Boolean),
        date: parsed.date || null,
        text: parsed.text || '',
        html: parsed.html || '',
        message_id: parsed.messageId || '',
        references: parsed.references || '',
        attachments,
      });
    } finally { lock.release(); }
  } catch (e) {
    res.status(500).json({ success: false, msg: '本文の取得に失敗しました', detail: (e.message || '').slice(0, 150) });
  } finally {
    try { if (client) await client.logout(); } catch (_) {}
  }
});

// ===== 添付ダウンロード =====
router.get('/message/:uid/attachment/:idx', authUser, async (req, res) => {
  const cred = getCred(req.uid);
  if (!cred) return res.status(400).json({ success: false, msg: 'メール未設定です' });
  const uid = parseInt(req.params.uid);
  const idx = parseInt(req.params.idx);
  if (!uid || isNaN(idx)) return res.status(400).json({ success: false, msg: 'パラメータ不正' });
  const mailbox = String(req.query.mailbox || 'INBOX').slice(0, 200);
  let client;
  try {
    client = await imapClient(cred);
    // 読み取り専用(EXAMINE)で開く: サーバーに\Seenを付けない/移動削除もしない=元メーラー(Gmail POP3取込等)に非干渉。
    // ※書き込みSELECTで本文(BODY[])を取得するとサーバーが自動で\Seenを付け、Gmailの他アカ取込が既読を取り込まず取りこぼす問題への対処。
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return res.status(404).json({ success: false, msg: 'メッセージが見つかりません' });
      const parsed = await simpleParser(msg.source);
      const att = (parsed.attachments || [])[idx];
      if (!att) return res.status(404).json({ success: false, msg: '添付が見つかりません' });
      // ★ダウンロード前にウイルススキャン。検出したら配信せずブロック
      const sc = await scanBuffer(att.content);
      if (sc.infected) {
        console.warn('[mail-virus] blocked download user=%s virus=%s file=%s', cred.email, sc.virus, att.filename);
        return res.status(422).json({ success: false, msg: 'ウイルスを検出したためダウンロードをブロックしました', virus: sc.virus, blocked: true });
      }
      const fn = encodeURIComponent(att.filename || ('attachment-' + idx));
      res.set('Content-Type', att.contentType || 'application/octet-stream');
      res.set('Content-Disposition', "attachment; filename*=UTF-8''" + fn);
      res.send(att.content);
    } finally { lock.release(); }
  } catch (e) {
    res.status(500).json({ success: false, msg: '添付の取得に失敗しました', detail: (e.message || '').slice(0, 150) });
  } finally {
    try { if (client) await client.logout(); } catch (_) {}
  }
});

// ===== 送信 / 返信 (SMTP・添付対応) =====
router.post('/send', authUser, (req, res) => {
  mailUpload.array('files', 10)(req, res, async (uerr) => {
    if (uerr) return res.status(422).json({ success: false, msg: (uerr.code === 'LIMIT_FILE_SIZE') ? '添付は1ファイル20MBまでです' : '添付の処理に失敗しました' });
    const cred = getCred(req.uid);
    if (!cred) return res.status(400).json({ success: false, msg: 'メール未設定です' });
    const b = req.body || {};
    const to = String(b.to || '').trim().slice(0, 1000);
    if (!to) return res.status(400).json({ success: false, msg: '宛先(To)は必須です' });
    const subject = String(b.subject || '').slice(0, 300);
    const text = String(b.body || '').slice(0, 100000);
    const cc = b.cc ? String(b.cc).trim().slice(0, 1000) : undefined;
    const attachments = (req.files || []).map(f => ({ filename: decodeFilename(f.originalname), content: f.buffer, contentType: f.mimetype || undefined }));
    // 転送: 元メール(forward_uid)の添付を取り込んで一緒に送る
    const fwdUid = parseInt(b.forward_uid);
    if (fwdUid) {
      let ic;
      try {
        ic = await imapClient(cred);
        const lk = await ic.getMailboxLock('INBOX');
        try {
          const om = await ic.fetchOne(String(fwdUid), { source: true }, { uid: true });
          if (om && om.source) {
            const op = await simpleParser(om.source);
            for (const a of (op.attachments || [])) {
              if (a.content) attachments.push({ filename: a.filename || 'attachment', content: a.content, contentType: a.contentType || undefined });
            }
          }
        } finally { lk.release(); }
      } catch (e) { console.warn('[mail-send] forward attach fail', (e.message || '').slice(0, 100)); }
      finally { try { if (ic) await ic.logout(); } catch (_) {} }
    }
    try {
      const transporter = nodemailer.createTransport({
        host: cred.smtp_host, port: cred.smtp_port, secure: true,
        auth: { user: cred.email, pass: decrypt(cred.enc_password) },
        tls: MAIL_TLS,
      });
      const mailOptions = {
        from: cred.display_name ? { name: cred.display_name, address: cred.email } : cred.email,
        to, cc, subject, text,
        inReplyTo: b.in_reply_to || undefined,
        references: b.references || undefined,
        attachments: attachments.length ? attachments : undefined,
      };
      const info = await transporter.sendMail(mailOptions);
      res.json({ success: true, message_id: info.messageId });
      // 送信控えを「送信済み」フォルダへ保存 (IMAP APPEND)。失敗しても送信は成立済みなので無視
      try {
        const raw = await new Promise((resolve, reject) =>
          new MailComposer(mailOptions).compile().build((err, m) => err ? reject(err) : resolve(m)));
        let ic;
        try {
          ic = await imapClient(cred);
          const sentPath = await findMailboxPath(ic, 'sent');
          if (sentPath) await ic.append(sentPath, raw, ['\\Seen']);
        } finally { try { if (ic) await ic.logout(); } catch (_) {} }
      } catch (e2) { console.warn('[mail-send] 送信済みへの保存に失敗:', (e2.message || '').slice(0, 120)); }
    } catch (e) {
      console.error('[mail-send] fail user=%s -> %s', cred.email, (e.message || ''));
      // 422で返す (401はクライアントがログアウト誤作動するため)
      res.status(422).json({ success: false, msg: '送信に失敗しました', detail: (e.message || '').slice(0, 160) });
    }
  });
});

// ===== 迷惑メール(送信者ブロック): 以後このアドレスをCoHub受信箱に表示しない =====
router.post('/block', authUser, express.json(), (req, res) => {
  const address = String((req.body && req.body.address) || '').trim().toLowerCase().slice(0, 200);
  if (!address) return res.status(400).json({ success: false, msg: 'アドレスが必要です' });
  getDb().prepare('INSERT OR IGNORE INTO user_mail_blocklist (user_id, address) VALUES (?, ?)').run(req.uid, address);
  res.json({ success: true });
});
router.delete('/block', authUser, express.json(), (req, res) => {
  const address = String((req.body && req.body.address) || (req.query && req.query.address) || '').trim().toLowerCase().slice(0, 200);
  getDb().prepare('DELETE FROM user_mail_blocklist WHERE user_id = ? AND address = ?').run(req.uid, address);
  res.json({ success: true });
});
router.get('/blocklist', authUser, (req, res) => {
  const rows = getDb().prepare('SELECT address, created_at FROM user_mail_blocklist WHERE user_id = ? ORDER BY created_at DESC').all(req.uid);
  res.json({ success: true, blocked: rows });
});

// ===== 個別メールの非表示(削除): CoHub受信箱から消す(サーバーのメールは残す) =====
router.post('/hide', authUser, express.json(), (req, res) => {
  const mid = String((req.body && req.body.message_id) || '').trim().slice(0, 500);
  if (!mid) return res.status(400).json({ success: false, msg: 'message_idが必要です' });
  getDb().prepare('INSERT OR IGNORE INTO user_mail_hidden (user_id, message_id) VALUES (?, ?)').run(req.uid, mid);
  res.json({ success: true });
});

// ===== 一括処理: 複数メールをまとめて 非表示/既読/送信者ブロック (ジャンク一掃用) =====
// body: { hide_ids:[message_id], seen_ids:[message_id], block_addresses:[addr] }
router.post('/bulk', authUser, express.json({ limit: '256kb' }), (req, res) => {
  const b = req.body || {};
  const arr = (v) => Array.isArray(v) ? v : [];
  const hideIds = arr(b.hide_ids).map(x => String(x || '').trim().slice(0, 500)).filter(Boolean).slice(0, 500);
  const seenIds = arr(b.seen_ids).map(x => String(x || '').trim().slice(0, 500)).filter(Boolean).slice(0, 500);
  const addrs = arr(b.block_addresses).map(a => String(a || '').trim().toLowerCase().slice(0, 200)).filter(Boolean).slice(0, 200);
  const db = getDb();
  const hideStmt = db.prepare('INSERT OR IGNORE INTO user_mail_hidden (user_id, message_id) VALUES (?, ?)');
  const seenStmt = db.prepare('INSERT OR IGNORE INTO cohub_mail_seen (user_id, message_id) VALUES (?, ?)');
  const blockStmt = db.prepare('INSERT OR IGNORE INTO user_mail_blocklist (user_id, address) VALUES (?, ?)');
  db.transaction(() => {
    for (const id of hideIds) hideStmt.run(req.uid, id);
    for (const id of seenIds) seenStmt.run(req.uid, id);
    for (const a of addrs) blockStmt.run(req.uid, a);
  })();
  res.json({ success: true, hidden: hideIds.length, seen: seenIds.length, blocked: addrs.length });
});

// ===== ラベル(フォルダ) + 自動振り分けルール (個人ごと) =====
const RULE_FIELDS = ['from', 'subject', 'to'];
const RULE_OPS = ['contains', 'equals', 'starts'];

// ラベル一覧 + 各ラベルのルールを同梱 (parent_id で多層階)
router.get('/labels', authUser, (req, res) => {
  const db = getDb();
  const labels = db.prepare('SELECT id, name, color, parent_id, sort_order FROM mail_labels WHERE user_id = ? ORDER BY sort_order, id').all(req.uid);
  const rules = db.prepare('SELECT id, label_id, field, op, value, enabled, sort_order FROM mail_rules WHERE user_id = ? ORDER BY sort_order, id').all(req.uid);
  const byLabel = {};
  for (const r of rules) { (byLabel[r.label_id] = byLabel[r.label_id] || []).push(r); }
  res.json({ success: true, labels: labels.map(l => ({ ...l, rules: byLabel[l.id] || [] })) });
});

// ラベル作成 (parent_id 指定で子フォルダ)
router.post('/labels', authUser, express.json(), (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  const color = String((req.body && req.body.color) || '#0d9488').trim().slice(0, 20);
  let parentId = parseInt(req.body && req.body.parent_id);
  if (!name) return res.status(400).json({ success: false, msg: 'フォルダ名が必要です' });
  if (!parentId || isNaN(parentId)) parentId = null;
  else {
    const p = getDb().prepare('SELECT id FROM mail_labels WHERE id = ? AND user_id = ?').get(parentId, req.uid);
    if (!p) return res.status(400).json({ success: false, msg: '親フォルダが見つかりません' });
  }
  const n = getDb().prepare('SELECT COUNT(*) AS c FROM mail_labels WHERE user_id = ?').get(req.uid).c;
  if (n >= 100) return res.status(400).json({ success: false, msg: 'フォルダは最大100個までです' });
  const ins = getDb().prepare('INSERT INTO mail_labels (user_id, name, color, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)').run(req.uid, name, color, parentId, n);
  res.json({ success: true, id: ins.lastInsertRowid });
});

// ラベル編集 (名前/色/親フォルダ移動)
router.put('/labels/:id', authUser, express.json(), (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const own = db.prepare('SELECT id FROM mail_labels WHERE id = ? AND user_id = ?').get(id, req.uid);
  if (!own) return res.status(404).json({ success: false });
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  const color = String((req.body && req.body.color) || '').trim().slice(0, 20);
  if (name) db.prepare('UPDATE mail_labels SET name = ? WHERE id = ?').run(name, id);
  if (color) db.prepare('UPDATE mail_labels SET color = ? WHERE id = ?').run(color, id);
  // 親フォルダの変更 (循環防止: 自分自身や自分の子孫を親にできない)
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'parent_id')) {
    let pid = parseInt(req.body.parent_id);
    if (!pid || isNaN(pid)) pid = null;
    if (pid != null) {
      if (pid === id) return res.status(400).json({ success: false, msg: '自分自身を親にできません' });
      const labels = db.prepare('SELECT id, parent_id FROM mail_labels WHERE user_id = ?').all(req.uid);
      const set = descendantIds(id, labels);
      if (set.has(pid)) return res.status(400).json({ success: false, msg: '配下のフォルダを親にできません' });
      const p = db.prepare('SELECT id FROM mail_labels WHERE id = ? AND user_id = ?').get(pid, req.uid);
      if (!p) return res.status(400).json({ success: false, msg: '親フォルダが見つかりません' });
    }
    db.prepare('UPDATE mail_labels SET parent_id = ? WHERE id = ?').run(pid, id);
  }
  res.json({ success: true });
});

// ラベル削除 (子孫フォルダと全ルールもまとめて削除。メール自体は残り受信箱へ戻る)
router.delete('/labels/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  const db = getDb();
  const own = db.prepare('SELECT id FROM mail_labels WHERE id = ? AND user_id = ?').get(id, req.uid);
  if (!own) return res.json({ success: true, already: true });
  const labels = db.prepare('SELECT id, parent_id FROM mail_labels WHERE user_id = ?').all(req.uid);
  const ids = Array.from(descendantIds(id, labels)); // 自分+子孫
  const ph = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM mail_rules WHERE user_id = ? AND label_id IN (${ph})`).run(req.uid, ...ids);
  db.prepare(`DELETE FROM mail_labels WHERE user_id = ? AND id IN (${ph})`).run(req.uid, ...ids);
  res.json({ success: true, deleted: ids.length });
});

// ルール追加
router.post('/rules', authUser, express.json(), (req, res) => {
  const labelId = parseInt(req.body && req.body.label_id);
  const field = String((req.body && req.body.field) || 'from');
  const op = String((req.body && req.body.op) || 'contains');
  const value = String((req.body && req.body.value) || '').trim().slice(0, 200);
  if (!RULE_FIELDS.includes(field) || !RULE_OPS.includes(op)) return res.status(400).json({ success: false, msg: '条件が不正です' });
  if (!value) return res.status(400).json({ success: false, msg: '一致する文字列が必要です' });
  const own = getDb().prepare('SELECT id FROM mail_labels WHERE id = ? AND user_id = ?').get(labelId, req.uid);
  if (!own) return res.status(400).json({ success: false, msg: 'フォルダが見つかりません' });
  const n = getDb().prepare('SELECT COUNT(*) AS c FROM mail_rules WHERE user_id = ?').get(req.uid).c;
  const ins = getDb().prepare('INSERT INTO mail_rules (user_id, label_id, field, op, value, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(req.uid, labelId, field, op, value, n);
  res.json({ success: true, id: ins.lastInsertRowid });
});

// ルール削除
router.delete('/rules/:id', authUser, (req, res) => {
  const id = parseInt(req.params.id);
  getDb().prepare('DELETE FROM mail_rules WHERE id = ? AND user_id = ?').run(id, req.uid);
  res.json({ success: true });
});

module.exports = router;
