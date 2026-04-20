const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');
const { generateAvatarSet } = require('../services/ai');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function ensureDir() {
  const dir = path.join(__dirname, '..', '..', 'uploads', 'avatars');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 3バリエーションのアニメ風アバターを一括生成（確定前・候補ファイル）
router.post('/generate-set', authUser, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, msg: '写真が添付されていません' });
    const base64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const results = await generateAvatarSet(base64, mimeType);

    const dir = ensureDir();
    const candidates = [];
    for (const r of results) {
      const ext = (r.mime_type || '').includes('png') ? 'png' : 'jpg';
      const filename = req.uid + '_cand_' + r.variant + '_' + Date.now() + '.' + ext;
      const filepath = path.join(dir, filename);
      fs.writeFileSync(filepath, Buffer.from(r.data, 'base64'));
      candidates.push({
        variant: r.variant,
        label: r.label,
        avatar_url: '/uploads/avatars/' + filename,
      });
    }
    // 元写真はバッファのみ、自動解放
    res.json({ success: true, candidates });
  } catch (e) {
    console.error('[avatar/generate-set]', e);
    res.status(500).json({ success: false, msg: e.message });
  }
});

// 候補の中から1つを確定（他の候補＋以前のアバターは削除）
router.post('/select', authUser, express.json(), (req, res) => {
  const chosen = (req.body.avatar_url || '').toString();
  const all = (req.body.candidates || []); // [{avatar_url, variant}, ...]
  if (!chosen || !chosen.startsWith('/uploads/avatars/')) {
    return res.status(400).json({ success: false, msg: '不正なURL' });
  }
  // 選ばれなかった候補を削除
  for (const c of all) {
    if (!c || !c.avatar_url || c.avatar_url === chosen) continue;
    if (!c.avatar_url.startsWith('/uploads/avatars/')) continue;
    try {
      const p = path.join(__dirname, '..', '..', c.avatar_url.replace(/^\//, ''));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {}
  }
  // 以前のアバターも削除
  const prev = getDb().prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.uid);
  if (prev && prev.avatar_url && prev.avatar_url.startsWith('/uploads/avatars/') && prev.avatar_url !== chosen) {
    try {
      const p = path.join(__dirname, '..', '..', prev.avatar_url.replace(/^\//, ''));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {}
  }
  getDb().prepare('UPDATE users SET avatar_url = ?, avatar_style = ? WHERE id = ?').run(chosen, 'anime', req.uid);
  res.json({ success: true, avatar_url: chosen });
});

// 候補を破棄（確定せずに閉じた場合）
router.post('/discard', authUser, express.json(), (req, res) => {
  const all = (req.body.candidates || []);
  for (const c of all) {
    if (!c || !c.avatar_url) continue;
    if (!c.avatar_url.startsWith('/uploads/avatars/')) continue;
    try {
      const p = path.join(__dirname, '..', '..', c.avatar_url.replace(/^\//, ''));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {}
  }
  res.json({ success: true });
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
