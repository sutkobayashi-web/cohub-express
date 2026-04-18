// Gemini 画像生成（漫画風アバター変換）

const STYLE_PROMPTS = {
  shonen: '少年漫画風のキャラクターイラストに変換してください。明瞭で太めの線、ダイナミックな陰影、親しみやすい表情、肩から上のポートレート、背景は白または透明。',
  anime: '柔らかいアニメ調のキャラクターイラストに変換してください。優しい線、明るい色調、大きめの瞳、穏やかな表情、肩から上のポートレート、背景は白または透明。',
  pixar: 'ピクサー風の3Dキャラクターイラストに変換してください。立体的で温かみのあるレンダリング、親しみやすい表情、肩から上のポートレート、背景は白または透明。',
  watercolor: '水彩スケッチ風のキャラクターイラストに変換してください。柔らかい線と透明感のある色、親しみやすい表情、肩から上のポートレート、背景は白または透明。',
};

async function generateAvatar(photoBase64, mimeType, style) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const stylePrompt = STYLE_PROMPTS[style] || STYLE_PROMPTS.shonen;
  const prompt = `以下の写真の人物を、${stylePrompt}
人物の特徴（髪型、メガネの有無、服装の雰囲気）は保ちつつ、イラスト調に変換してください。
重要: 正方形フレーム、人物は中央、顔がはっきり見える構図。`;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: photoBase64 } }
      ]
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
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
    if (p.inline_data && p.inline_data.data) {
      return { data: p.inline_data.data, mime_type: p.inline_data.mime_type || 'image/png' };
    }
  }
  throw new Error('画像生成に失敗しました');
}

module.exports = { generateAvatar };
