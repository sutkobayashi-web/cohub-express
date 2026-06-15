// 音声文字起こし (2026-06-16) — 録音した音声をGeminiで日本語テキスト化。
// iPhone(Safari)はブラウザ音声認識(Web Speech API)非対応のため、MediaRecorder録音→サーバー文字起こし方式で全端末対応。
const express = require('express');
const router = express.Router();
const { authUser } = require('../middleware/auth');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.post('/transcribe', authUser, upload.single('audio'), async (req, res) => {
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    return res.status(400).json({ success: false, msg: '音声がありません' });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, msg: 'AI未設定' });
  let mime = (req.file.mimetype || 'audio/webm').split(';')[0];
  if (!/^audio\//.test(mime)) mime = 'audio/webm';
  const b64 = req.file.buffer.toString('base64');
  const prompt = 'これは日本語の音声メモです。話された内容をそのまま日本語で文字起こししてください。句読点を適切に付け、話し言葉のまま。前置きや説明・カギカッコは不要で、本文テキストだけを出力。聞き取れない場合は空文字を返してください。';
  const body = {
    contents: [{ parts: [{ inlineData: { mimeType: mime, data: b64 } }, { text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 1024 },
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { console.error('[voice/transcribe]', r.status, JSON.stringify(d).slice(0, 300)); return res.status(502).json({ success: false, msg: '文字起こしに失敗しました' }); }
    const text = (((((d.candidates || [])[0] || {}).content) || {}).parts || []).map(p => p.text || '').join('').trim();
    res.json({ success: true, text });
  } catch (e) {
    console.error('[voice/transcribe]', e.message);
    res.status(500).json({ success: false, msg: '通信エラー' });
  }
});

module.exports = router;
