const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// お助けを呼ぶ: 当面の運用窓口 (小林猛・立石・吉沢) へSOSのDMを送信
// 本人 → 各窓口 (個別DM)。各窓口にプッシュ通知 + ソケット即時配信。
const SOS_TARGETS = ['taketake', 'm_tateishi', 'y_yoshizawa'];

router.post('/sos', authUser, (req, res) => {
  const db = getDb();
  const note = String((req.body && req.body.note) || '').slice(0, 400).trim();
  const sender = db.prepare('SELECT id, display_name, nickname FROM users WHERE id = ?').get(req.uid);
  if (!sender) return res.status(404).json({ success: false, msg: 'ユーザー不明' });
  const targets = db.prepare(
    `SELECT id, login_id, display_name FROM users WHERE login_id IN (${SOS_TARGETS.map(() => '?').join(',')})`
  ).all(...SOS_TARGETS);
  if (!targets.length) return res.status(500).json({ success: false, msg: 'SOS窓口が未登録です' });
  const senderName = sender.display_name || sender.nickname || sender.id;
  const header = `🆘 お助けコール — ${senderName}さんからCoWell操作のヘルプ依頼です`;
  const body = note ? `${header}\n\n📝 メッセージ:\n${note}` : header;
  const emit = req.app && req.app.locals && req.app.locals.emitToUser;
  const push = req.app && req.app.locals && req.app.locals.sendPushToUser;
  let delivered = 0;
  const ids = [];
  for (const t of targets) {
    if (t.id === req.uid) continue; // 自分宛は飛ばさない
    try {
      const ins = db.prepare("INSERT INTO messages (sender_id, receiver_id, content, room_code) VALUES (?, ?, ?, 'dm')")
        .run(req.uid, t.id, body);
      ids.push(ins.lastInsertRowid);
      const payload = {
        id: ins.lastInsertRowid,
        from: req.uid,
        to: t.id,
        content: body,
        at: new Date().toISOString(),
        attach: null,
      };
      if (emit) emit(t.id, 'dm:msg', payload);
      if (push) push(t.id, {
        title: '🆘 お助けコール',
        body: senderName + 'さんがCoWellヘルプ依頼',
        tag: 'sos-' + req.uid,
        url: '/',
      }).catch(() => {});
      delivered++;
    } catch (e) { console.warn('[help/sos] send fail to', t.login_id, e.message); }
  }
  res.json({ success: delivered > 0, delivered, recipients: targets.map(t => t.display_name), ids });
});

module.exports = router;
