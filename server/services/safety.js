// AIチャット安全フィルタ (L1: 入力スクリーニング)
// 露骨な性的・暴力・誹謗中傷・差別表現を事前ブロック → AI に渡さず定型応答
// 完全網羅は不可能。Phase 2 で機械学習ベースに置換予定

// カテゴリ別キーワードリスト (大文字小文字・全角半角を正規化して照合)
// 「明確に問題」レベルのみ。判定が分かれる単語は含めない (誤検知よりGeminiのsafetySettings側に任せる)
const PATTERNS = {
  sexual: [
    'セックス', 'エッチ', 'ヤリたい', 'ヤらせ', 'おっぱい', '巨乳', 'ぱいおつ',
    'ちんこ', 'ちんちん', 'ちんぽ', 'まんこ', 'まんま', 'おまんこ', 'クリトリス',
    'アナル', 'フェラ', 'クンニ', 'マスターベ', 'オナニー', 'オナる',
    '裸', '全裸', 'ヌード', '射精', '勃起', '挿入', 'ガチイキ', 'イカせ',
    'ハメ撮り', 'AV女優', 'エロ動画', '風俗', 'ソープ', 'デリヘル',
    // English
    'fuck', 'fucking', 'pussy', 'dick', 'cock', 'tits', 'porn', 'nude',
  ],
  harassment: [
    '死ね', '殺す', '殺してやる', '消えろ', '消えてくれ', 'クズ',
    'バカ野郎', 'アホ', 'ボケ', 'カス', 'ゴミ', '無能', '役立たず',
    'クソ女', 'クソ男', 'クソ野郎', 'ブス', 'デブ', 'チビ', 'ハゲ',
    '辞めろ', 'クビにしろ', '辞めさせろ',
    // English
    'kill yourself', 'go die', 'shut up', 'asshole',
  ],
  defamation: [  // 誹謗中傷 - 名前を伴うネガティブ言及はAI判定に任せ、ここは自己完結する典型のみ
    '〇〇は最低', '〇〇は嘘つき',
  ],
  discrimination: [
    'チョン', 'シナ人', 'ジャップ', 'ニガー', '部落',
    '障害者は',  // 「障害者は〜だ」のような断定差別 (障害者単独は中立語)
  ],
  violence_crime: [
    '爆弾', '爆破', 'テロ', 'ハッキング方法', '違法薬物', '麻薬', '覚醒剤',
    '銃の作り方', '人の殺し方', '毒の作り方',
  ],
  // メンタル危機 (リスク話題、専用フローで対応):
  // → ブロックではなく特別ルートで対応 (相談窓口を即提示)
  mental_crisis: [
    '自殺', '死にたい', '自殺したい', '消えてしまいたい', '楽になりたい',
    'リストカット', '飛び降り',
  ],
};

// 文字列正規化 (大文字→小文字、全角英数→半角)
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

// 主検査: 入力テキストから不適切カテゴリを検出
// returns null (clean) または { category, matched, severity }
function checkInappropriate(text) {
  const t = normalize(text);
  if (!t) return null;
  for (const [category, words] of Object.entries(PATTERNS)) {
    for (const w of words) {
      if (t.includes(normalize(w))) {
        const severity = (category === 'violence_crime' || category === 'mental_crisis') ? 'high'
          : (category === 'sexual' || category === 'discrimination') ? 'high'
          : 'medium';
        return { category, matched: w, severity };
      }
    }
  }
  return null;
}

// カテゴリ別の bot 拒否応答テンプレ (社内相談窓口への橋渡し)
const REFUSAL_TEMPLATES = {
  sexual: 'ごめんなさい、その内容にはお答えできません。もし職場でハラスメントに関するお困りごとがあれば、社内相談窓口 (人事部) または産業医にご相談ください。',
  harassment: 'ごめんなさい、その表現にはお答えできません。職場のことで困っていることがあれば、社内相談窓口 (人事部) や上司に相談していただけると幸いです。',
  defamation: '特定の人への評価には立ち入れません。何か不公平を感じる出来事があれば、社内相談窓口 (人事部) にご相談くださいね。',
  discrimination: 'その表現にはお答えできません。差別やいじめに関する困りごとは、社内相談窓口 (人事部) にご相談ください。',
  violence_crime: 'ごめんなさい、その内容にはお答えできません。緊急性のあるご相談であれば、警察(110)または専門機関へ。',
  mental_crisis: 'お話してくれてありがとうございます。とても辛い気持ちが伝わってきました。\n\n今すぐお話を聞いてくれる窓口があります:\n・よりそいホットライン: 0120-279-338 (24時間・無料)\n・いのちの電話: 0570-783-556\n・職場の産業医・社内相談窓口 (人事部) も気軽にご活用ください。\n\nあなたは一人ではありません。',
};

function refusalResponse(category) {
  return REFUSAL_TEMPLATES[category] || REFUSAL_TEMPLATES.harassment;
}

module.exports = { checkInappropriate, refusalResponse, PATTERNS };
