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
// 大きいmax_tokens(>8192)はSDKがstreaming必須化するためstreamで実装
async function generateTextClaude(prompt, opts) {
  opts = opts || {};
  const model = opts.model || 'claude-sonnet-4-6';
  const maxTokens = opts.maxTokens || 16000;
  const temperature = opts.temperature != null ? opts.temperature : 0.3;
  const wantsJson = (opts.responseMimeType === 'application/json');
  // Claude 4.x はassistant pre-fill非対応。userメッセージで強い指示
  let userContent = prompt;
  if (wantsJson) {
    userContent = prompt + '\n\n【出力厳守】JSONのみを返す。「```」やコメントや説明文を一切含めない。"{" で始めて "}" で終わる純粋なJSONのみ。';
  }
  const stream = await getClient().messages.stream({
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: 'user', content: userContent }],
  });
  let text = '';
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
      text += ev.delta.text;
    }
  }
  // 万一 ```json...``` で囲まれた場合の救済
  if (wantsJson) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
  }
  return text;
}

// 車種表記の正規化 (AIの誤記を吸収)
const VEHICLE_TYPE_ALIASES = {
  '2tｼｮｴﾄ': '2tｼｮｰﾄ',
  '2tｼｮｰｴ': '2tｼｮｰﾄ',
  '2tショート': '2tｼｮｰﾄ',
  '2t SHORT': '2tｼｮｰﾄ',
  '2tショート平ボディ': '2tｼｮｰﾄ平ﾎﾞﾃﾞｨ',
  '2tスリム': '2tｽﾘﾑ',
  '2t平ボディ': '2t平ﾎﾞﾃﾞｨ',
  '2tワイド': '2ワイド',
  'ハイエース': 'ハイエース',
  '軽バン': '軽ﾊﾞﾝ',
};
function normalizeVehicleType(vt) {
  if (!vt) return vt;
  const s = String(vt).trim();
  return VEHICLE_TYPE_ALIASES[s] || s;
}

module.exports = { generateTextClaude, normalizeVehicleType };
