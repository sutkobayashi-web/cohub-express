// Google Cloud Text-to-Speech: 葵の読み上げ用 (CoWell流)
const express = require('express');
const { authUser } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_VOICES = [
  'ja-JP-Neural2-B', 'ja-JP-Neural2-C', 'ja-JP-Neural2-D',
  'ja-JP-Wavenet-A', 'ja-JP-Wavenet-B', 'ja-JP-Wavenet-C', 'ja-JP-Wavenet-D',
];
const DEFAULT_VOICE = 'ja-JP-Neural2-B';

router.post('/tts', authUser, express.json(), async (req, res) => {
  try {
    const text = ((req.body && req.body.text) || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const clipped = text.slice(0, 3000);
    const voice = ((req.body && req.body.voice) || DEFAULT_VOICE).toString();
    const safeVoice = ALLOWED_VOICES.includes(voice) ? voice : DEFAULT_VOICE;
    const speed = Math.max(0.5, Math.min(2.0, parseFloat(req.body && req.body.speed) || 1.0));
    const pitch = Math.max(-10, Math.min(10, parseFloat(req.body && req.body.pitch) || 0));

    const apiKey = process.env.GOOGLE_TTS_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'TTS API key未設定' });

    const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: clipped },
        voice: { languageCode: 'ja-JP', name: safeVoice },
        audioConfig: { audioEncoding: 'MP3', speakingRate: speed, pitch },
      }),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      return res.status(500).json({ error: (data.error && data.error.message) || 'TTS失敗' });
    }
    const buf = Buffer.from(data.audioContent, 'base64');
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

module.exports = router;
