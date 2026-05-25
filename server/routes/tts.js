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
      .replace(/[ \t　]{2,}/g, ' ')
      .trim();
    if (!clipped) return res.status(400).json({ error: '読み上げる文字がありません' });
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
