const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateAvatar } = require('../services/ai');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// 漫画風アバター生成（元写真はサーバー保存しない。生成結果のみ保存）
router.post('/generate', authUser, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, msg: '写真が添付されていません' });
    const style = (req.body.style || 'shonen').toString();
    const base64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const result = await generateAvatar(base64, mimeType, style);

    // 保存先
    const dir = path.join(__dirname, '..', '..', 'uploads', 'avatars');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = (result.mime_type || '').includes('png') ? 'png' : 'jpg';
    const filename = req.uid + '_' + Date.now() + '.' + ext;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, Buffer.from(result.data, 'base64'));
    const publicUrl = '/uploads/avatars/' + filename;

    getDb().prepare('UPDATE users SET avatar_url = ?, avatar_style = ? WHERE id = ?').run(publicUrl, style, req.uid);
    // 元写真はバッファのみ、関数を抜けたら自動解放
    res.json({ success: true, avatar_url: publicUrl, style });
  } catch (e) {
    console.error('[avatar/generate]', e);
    res.status(500).json({ success: false, msg: e.message });
  }
});

// アバター削除
router.post('/remove', authUser, (req, res) => {
  const u = getDb().prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.uid);
  if (u && u.avatar_url) {
    try {
      const filepath = path.join(__dirname, '..', '..', u.avatar_url.replace(/^\//, ''));
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    } catch (e) {}
  }
  getDb().prepare("UPDATE users SET avatar_url = '', avatar_style = '' WHERE id = ?").run(req.uid);
  res.json({ success: true });
});

module.exports = router;
