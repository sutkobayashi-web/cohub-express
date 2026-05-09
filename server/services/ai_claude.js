// Claude (Anthropic) APIラッパー — Gemini と同等のインターフェース
// 使い方: const { generateTextClaude } = require('./ai_claude'); await generateTextClaude(prompt, opts);
const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY未設定');
  _client = new Anthropic({ apiKey });
  return _client;
}

// モデル別の標準呼び出し
// model: 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7'
async function generateTextClaude(prompt, opts) {
  opts = opts || {};
  const model = opts.model || 'claude-sonnet-4-6';
  const maxTokens = opts.maxTokens || 16000;
  const temperature = opts.temperature != null ? opts.temperature : 0.3;
  // JSON強制したい場合は system に強い指示+ユーザーメッセージで pre-fill
  const wantsJson = (opts.responseMimeType === 'application/json');
  const messages = [
    { role: 'user', content: prompt },
  ];
  // JSON先頭で開始するよう assistant pre-fill (Anthropicの推奨技法)
  if (wantsJson) {
    messages.push({ role: 'assistant', content: '{' });
  }
  const resp = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    messages,
  });
  const blocks = resp.content || [];
  let text = '';
  for (const b of blocks) {
    if (b.type === 'text') text += b.text;
  }
  if (wantsJson) {
    // pre-fillの { を頭に戻す
    if (!text.startsWith('{')) text = '{' + text;
  }
  return text;
}

module.exports = { generateTextClaude };
