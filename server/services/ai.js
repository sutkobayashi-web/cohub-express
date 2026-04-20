// Gemini 画像生成（アニメ風アバター変換・3バリエーション）

const ANIME_VARIANTS = {
  bright: {
    label: '明るめアニメ',
    prompt: '明るく親しみやすい日本アニメ調のキャラクターイラスト。クリアな線、鮮やかで温かみのある色調、大きめの瞳、優しい笑顔。'
  },
  cool: {
    label: 'クールアニメ',
    prompt: 'シャープでスタイリッシュな現代アニメ調のキャラクターイラスト。細めの線、引き締まった陰影、落ち着いた色調、知的な表情。'
  },
  soft: {
    label: 'ソフトアニメ',
    prompt: '柔らかく穏やかな日常系アニメ調のキャラクターイラスト。淡いパステルの配色、ふんわりした塗り、リラックスした表情。'
  },
};

async function generateAvatarOne(photoBase64, mimeType, variantKey) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const v = ANIME_VARIANTS[variantKey] || ANIME_VARIANTS.bright;
  const prompt = `以下の写真の人物を、${v.prompt}
人物の特徴（髪型、メガネの有無、服装の雰囲気、性別、年齢感）は保ちつつ、イラスト調に変換してください。
重要: 正方形フレーム、人物は中央、顔と肩から上の胸までが入る構図。背景は白または透明。`;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mimeType, data: photoBase64 } }
      ]
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 1.0,
    }
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Gemini API error: ' + resp.status + ' ' + txt.slice(0, 200));
  }
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('Gemini応答に画像が含まれていません');
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      return { data: inline.data, mime_type: inline.mimeType || inline.mime_type || 'image/png', variant: variantKey, label: v.label };
    }
  }
  throw new Error('画像生成に失敗しました');
}

// 3バリエーション並列生成
async function generateAvatarSet(photoBase64, mimeType) {
  const keys = Object.keys(ANIME_VARIANTS);
  const results = await Promise.allSettled(keys.map(k => generateAvatarOne(photoBase64, mimeType, k)));
  const ok = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') ok.push(results[i].value);
    else console.error('[avatar variant fail]', keys[i], results[i].reason && results[i].reason.message);
  }
  if (ok.length === 0) throw new Error('すべてのバリエーション生成に失敗しました');
  return ok;
}

// 会議録音 → AI議事録 (Gemini 2.5 Flash マルチモーダル)
async function transcribeRecording(audioBase64, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const prompt = `以下の音声は日本企業内の会議録音です。以下の形式で **日本語のマークダウン** で議事録を作成してください。

# 議事録

## 参加者
- (話者の数・特徴から推測。氏名不明なら「参加者A/B/C」)

## 議題
- (箇条書き3〜5項目)

## 主な発言・議論
(発言者ごとに要約。話が聞き取れない部分は省略)

## 決定事項
- (決定1)
- (決定2)

## 次回アクション (誰が何をいつまで)
- (アクション項目)

## 所感・補足
(会議の雰囲気、未解決論点など一段落)

※**事実でない推測は避ける**。不明瞭な箇所は「(聞き取り不能)」と明記。話者氏名が音声から分からない場合は「参加者A」等で統一。`;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mimeType || 'audio/webm', data: audioBase64 } },
      ]
    }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 6000 },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Gemini error: ' + resp.status + ' ' + txt.slice(0, 400));
  }
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('Gemini応答なし');
  for (const p of parts) if (p.text) return p.text;
  throw new Error('議事録テキスト生成に失敗');
}

// 受付AI案内員 → Gemini で返答
const CONCIERGE_PROMPTS = {
  bot_aoi: `あなたは「葵(あおい)」、CoHub Express(企業向けバーチャルオフィスSaaS)の1F受付案内員です。
明るく親しみやすい性格で、フロアや機能の案内が得意です。回答は2-3文で簡潔に。語尾は「〜ですね」「〜ですよ」など丁寧かつ柔らかく。

【CoHubの構成】
- 1Fロビー: 訪問者受付・待合(私はここに居ます)
- 2F事務フロア: メンバーの溜まり場、近接音声220px、右上に「🎙️ハドル席」(独立音声)
- 3F役員会議室/会議室B/大会議室: 施錠+承認制で機密保持
- 現場棟: 乗務員詰所/倉庫/現場ミーティング(棟外からは要承認)

【主な機能】
- ステータス: 在席/退席/会議中/🎯集中中
- 👋肩たたき: 同フロア+440px以内、相手にOS通知が飛ぶ
- DM・グループチャット・フロアチャット(60日保存)
- 会議室ではビデオ・画面共有・ホワイトボード・録音(管理者のみ)
- 左レール❓で詳しいヘルプ

【あなたの返事のスタイル】
最初に共感や挨拶、次に必要な情報、最後に「他にも気になることあれば声かけてくださいね」など促す。`,

  bot_yui: `あなたは「結衣(ゆい)」、CoHub Express(企業向けバーチャルオフィスSaaS)の1F受付案内員です。
落ち着いた優しい性格で、操作トラブルや使い方の相談が得意です。回答は2-3文で簡潔に。語尾は「〜です」「〜ますね」など穏やかに。

【トラブル対応の引き出し】
- 音声が聞こえない → スピーカーOFF/ブラウザ通知許可/フロア違い/ハドル席外を確認
- マイクONできない → ブラウザのマイク許可が必要
- 会議室入れない → 施錠中or承認制の可能性、🔔ノックで管理者に承認依頼
- 通知が来ない → ヘッダーの🔔ベルでPWAプッシュ許可+OS通知許可
- アバター変更 → 左レール⚙設定 → アバター撮影
- 棟外フロア入れない → 承認制(室内の人がOK出すと入れます)

返事の最初は「はい、〜の件ですね」など受け止めから。`,
};

async function chatBot(botId, userMessage, history) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const sysPrompt = CONCIERGE_PROMPTS[botId];
  if (!sysPrompt) throw new Error('未知のbot: ' + botId);
  const contents = [];
  // history (直近10件、user/bot 交互)
  if (Array.isArray(history)) {
    for (const m of history.slice(-10)) {
      contents.push({ role: m.role === 'bot' ? 'model' : 'user', parts: [{ text: m.text }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: userMessage }] });
  const body = {
    systemInstruction: { parts: [{ text: sysPrompt }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 400 },
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Gemini error: ' + resp.status + ' ' + txt.slice(0, 300));
  }
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('Gemini応答なし');
  for (const p of parts) if (p.text) return p.text.trim();
  throw new Error('応答テキストなし');
}

module.exports = { generateAvatarOne, generateAvatarSet, ANIME_VARIANTS, transcribeRecording, chatBot };
