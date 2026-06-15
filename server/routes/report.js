// 報告整形アシスト (2026-05-25): 社員が書いた報告メモをAIが5W1H形式に整える。
// まず事業本部チャット(g_jigyo_honbu)限定で運用。
const express = require('express');
const router = express.Router();
const { authUser } = require('../middleware/auth');
const ai = require('../services/ai');

router.post('/format', authUser, express.json(), async (req, res) => {
  const text = (req.body && req.body.text || '').toString().trim();
  const mode = (req.body && req.body.mode) || 'report';
  if (!text) return res.status(400).json({ success: false, msg: '内容を入力してください' });
  if (text.length > 4000) return res.status(400).json({ success: false, msg: '長すぎます (4000字以内にしてください)' });

  const prompt = (mode === 'diary')
    ? `あなたは「元祖Ｂさんの愛の日記」の整形アシスタントです。話し言葉のメモ(音声入力)を、本人が書いた温かい日記として自然に整えてください。

# 入力(本人が話したメモ)
${text}

# 整形ルール
- 一人称の日記として、やさしく素直な口語にする。本人の言葉づかい・気持ちをそのまま生かす。
- 入力にない出来事や感情は創作・誇張しない。盛らない。短くてもよい。
- 読みやすいところで改行。丁寧すぎず、普段の語り口で。
- Markdown記号(#, *, -, ** など)は使わない。絵文字は文意に沿って控えめに使ってよい(無理に足さない)。
- 暗い気持ちが書かれていても無理に明るく変えない。本人の心情を尊重して、そのまま読みやすくする。`
    : (mode === 'weekly')
    ? `あなたは運送会社の「週報整形アシスタント」です。営業所責任者が書いた週報のメモを、上司が読みやすいように整えてください。

# 入力(メモ)
${text}

# 整形ルール
- 内容ごとに段落・箇条書きで整理し、論点(誰が・何を・どうした・結果・今後)が伝わるようにする。
- 入力にない情報は絶対に創作・推測で足さない。事実のみ。
- 数字(売上・件数・日付)はそのまま正確に残す。
- 丁寧で簡潔な日本語。Markdown記号(#, *, -, **, _ など)や絵文字は一切使わない。箇条書きは行頭に全角「・」を使う。見出しは付けすぎず自然な文章で。`
    : `あなたは運送会社の「報告整形アシスタント」です。社員が書いた報告メモを、上司が一目で把握できる5W1H形式の報告に整えてください。

# 入力(社員のメモ)
${text}

# 整形ルール
- 次の見出しで簡潔にまとめる(該当する項目のみ記載。情報がない見出しは省略してよい):
  【件名】1行の要約
  【日時】いつ
  【場所】どこで
  【関係者】誰が / 誰と
  【内容】何が / 何を
  【経過・結果】どうした / どうなった
  【原因・理由】(分かる場合のみ)
  【今後の対応・依頼】(あれば)
- 入力に書かれていない情報は絶対に創作・推測で埋めない。
- メモから読み取れない重要項目があれば、本文の最後に
  「※確認したい点:」として箇条書きで挙げる(社員が後から追記できるように)。
- 事実のみ。丁寧だが簡潔な日本語。装飾記号や絵文字は使わない。`;

  try {
    // thinkingBudget:0 必須 — 思考トークンが出力上限を食って途中で切れるのを防ぐ (feedback_gemini_thinking_budget)
    const out = await ai.generateText(prompt, { temperature: 0.3, maxTokens: 1800, thinkingBudget: 0 });
    res.json({ success: true, formatted: out });
  } catch (e) {
    console.error('[report/format]', e.message);
    res.status(500).json({ success: false, msg: 'AI整形に失敗しました。時間をおいて再度お試しください。' });
  }
});

module.exports = router;
