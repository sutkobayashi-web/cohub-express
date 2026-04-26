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
  bot_aoi: `あなたは「葵(あおい)」、**スタンダード運輸グループ バーチャルオフィス** (CoHub Express) の1F受付案内員です。
明るく親しみやすい性格で、機能案内・操作トラブルの両方を担当します。回答は2-3文で簡潔に。語尾は「〜ですね」「〜ですよ」など丁寧かつ柔らかく。

【ここの呼び方 (重要)】
- 「ここはどこ?」「会社名は?」「何のサイト?」と聞かれたら必ず **「スタンダード運輸グループ バーチャルオフィスです」** と答えてください。
- 「CoHub」というシステム名は社内呼称として補足程度に触れる。

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

【操作トラブルの引き出し】
- 音声が聞こえない → スピーカーOFF/ブラウザ通知許可/フロア違い/ハドル席外を確認
- マイクONできない → ブラウザのマイク許可が必要
- 会議室入れない → 施錠中or承認制の可能性、🔔ノックで管理者に承認依頼
- 通知が来ない → ヘッダーの🔔ベルでPWAプッシュ許可+OS通知許可
- アバター変更 → 左レール⚙設定 → アバター撮影
- 棟外フロア入れない → 承認制(室内の人がOK出すと入れます)

【カレンダー連携】
- 社員が自分のGoogleカレンダーを連携している場合、質問メッセージの冒頭に [社員のGoogleカレンダー予定] として直近の予定一覧が渡されます。その情報を元に具体的な時刻・件名・場所で答えてください。
- 予定が空欄の場合は「直近に登録された予定はなさそうですね」と返す。
- カレンダー未連携者から予定を聞かれた場合は「左上の自分のアイコン → 📅カレンダー連携 から設定できますよ」と案内してください。
- 予定の内容を憶測で補わない。カレンダーに書かれている範囲だけ答える。

【あなたの返事のスタイル】
最初に共感や受け止め、次に必要な情報、最後に「他にも気になることあれば声かけてくださいね」など促す。`,
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

// 汎用テキスト生成 (プロンプト→テキスト) — 健康管理室AI集計などで使用
async function generateText(prompt, opts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  opts = opts || {};
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature != null ? opts.temperature : 0.5,
      maxOutputTokens: opts.maxTokens || 2000,
      responseMimeType: opts.responseMimeType || undefined,
    },
  };
  const model = opts.model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
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

// 食事画像を Gemini Vision で栄養分析 (CoWell ひろば 互換のスコア形式)
async function analyzeFoodImage(imageBuffer, mimeType, userMemo) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const base64 = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : imageBuffer;
  const prompt = `あなたは食事を見るのが好きな栄養のプロです。友達に「これ食べたよ」と見せられたときの自然な反応をしてください。国立長寿医療研究センター「栄養改善パック」(2020) に基づき分析。
${userMemo ? '投稿者メモ: ' + userMemo.slice(0, 200) + '\n' : ''}
画像に成分表示ラベルがあれば優先的に数値を読み取り「【成分表示から読み取り】」と明記。
それ以外は箸/茶碗/手等の基準物から実重量を推定し、食品成分表で算出。

★絶対形式: 純粋なJSON のみ。前置き・コードフェンス・説明文禁止。マークダウン禁止。

{"comment":"60〜120字の自然な感想 (良い点+軽い改善提案)","calories":{"value":数値,"unit":"kcal"},"protein":{"value":数値,"unit":"g"},"fat":{"value":数値,"unit":"g"},"carbs":{"value":数値,"unit":"g"},"vitamin":{"value":数値,"unit":"g"},"mineral":{"value":数値,"unit":"mg"},"salt":{"value":数値,"unit":"g"},"fiber":{"value":数値,"unit":"g"},"alcohol":{"value":数値,"unit":"g"},"has_alcohol":true,"confidence":{"level":数値,"reason":"理由"}}

各値:
- calories: kcal (目標 450-650/食)
- protein: g (目標 20)
- fat: g (目標 12-18)
- carbs: g (目標 69-89)
- vitamin: 野菜量 g (目標 120)
- mineral: カルシウム mg (目標 227)
- salt: 食塩相当量 g (目標 2.5未満)
- fiber: 食物繊維 g (目標 7)
- alcohol: 純アルコール g (酒なし=0)。ビール350ml=14g、日本酒1合=22g
- has_alcohol: 画像に酒類があれば true
- confidence.level: 3(成分表示) / 2(一部成分表示or定番料理) / 1(目視推定)
- confidence.reason: 上記の理由文

数値はカンマ無し。実数または推定実数 (小数点1桁まで)。
不適切画像 (食事ではない) の場合は全 value を 0、comment に理由。`;

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.5, maxOutputTokens: 2500, responseMimeType: 'application/json' },
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Gemini vision HTTP ' + resp.status + ': ' + txt.slice(0, 200));
  }
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  let text = '';
  if (parts) for (const p of parts) if (p.text) text += p.text;
  console.log('[analyzeFoodImage] raw AI response:', text.slice(0, 300));
  // コードフェンス除去 (```json ... ``` パターン全部)
  text = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  // JSON部分だけ抽出 (前後にゴミ文字があっても拾う)
  const m = text.match(/\{[\s\S]*\}/);
  if (m) text = m[0];
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    // 切詰フォールバック: 開きカッコ過多なら閉じる
    let fixed = text;
    const opens = (fixed.match(/\{/g) || []).length;
    const closes = (fixed.match(/\}/g) || []).length;
    if (opens > closes) {
      // 文字列途中切れ対応: 末尾が " で終わっていなければ "" を補完
      if (!/["\d\}]\s*$/.test(fixed)) fixed += '"';
      fixed += '}'.repeat(opens - closes);
    }
    try { parsed = JSON.parse(fixed); }
    catch (e2) {
      console.warn('[analyzeFoodImage] JSON parse failed:', e.message, 'text=', text.slice(0, 300));
      throw new Error('AI応答解析失敗 (出力切詰の可能性、再投稿してください)');
    }
  }
  console.log('[analyzeFoodImage] parsed:', JSON.stringify(parsed).slice(0, 200));
  return parsed;
}

// 血圧計の写真をAIで読み取り (CoWell移植)
async function analyzeBPImage(imageBuffer, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const base64 = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : imageBuffer;
  const prompt = `あなたは血圧計の液晶表示を読み取る専門AIです。
画像の血圧計の数値を正確に読み取って純粋なJSONのみで回答 (前置き・コードフェンス禁止):

{"systolic": 数値またはnull, "diastolic": 数値またはnull, "pulse": 数値またはnull, "confidence": "high"|"medium"|"low", "note": "補足"}

ルール:
- systolic = 最高血圧(上)
- diastolic = 最低血圧(下)
- pulse = 脈拍数 (表示があれば)
- 読み取れない項目は null
- 血圧計以外の画像なら全て null + note に「血圧計の画像ではありません」
- 数値が部分的にしか見えない場合もできるだけ推定して confidence=medium`;

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } },
        { text: prompt },
      ],
    }],
    // Gemini 2.5 は内部 thinking にもトークン消費するため余裕を持たせる
    generationConfig: { temperature: 0.2, maxOutputTokens: 1200, responseMimeType: 'application/json' },
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Gemini vision HTTP ' + resp.status + ': ' + txt.slice(0, 200));
  }
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  let text = '';
  if (parts) for (const p of parts) if (p.text) text += p.text;
  console.log('[analyzeBP] raw:', text.slice(0, 200));
  text = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) text = m[0];
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    // 切詰時のフォールバック: } を補ってもう一度トライ
    let fixed = text;
    const opens = (fixed.match(/\{/g) || []).length;
    const closes = (fixed.match(/\}/g) || []).length;
    if (opens > closes) fixed += '"'.repeat(0) + '}'.repeat(opens - closes);
    try { parsed = JSON.parse(fixed); }
    catch (e2) {
      console.warn('[analyzeBP] parse fail:', text.slice(0, 200));
      throw new Error('AI応答解析失敗 (画像が血圧計か確認してください)');
    }
  }
  return parsed;
}

module.exports = { generateAvatarOne, generateAvatarSet, ANIME_VARIANTS, transcribeRecording, chatBot, generateText, analyzeFoodImage, analyzeBPImage };
