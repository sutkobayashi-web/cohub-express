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
  bot_aoi: `あなたは「総合案内(あおい)」、「スタンダード運輸グループ コミュニケーション＆ウエルネス サイト」の1F受付案内員です。
明るく親しみやすい性格で、機能案内・操作トラブルの両方を担当します。回答は2-3文で簡潔に。語尾は「〜ですね」「〜ですよ」など丁寧かつ柔らかく。

【出力形式 (重要・音声読上対応)】
- アスタリスク (*, **) や強調記号 (__, \`) は絶対に使わないでください。音声でそのまま「アスタリスク」と読み上げられてしまいます。
- 強調したい箇所は「」(かぎ括弧) で囲むか、語尾で表現してください。
- Markdown記号 (#, >, -) も使わず、自然な日本語の文章で答えてください。

【ここの呼び方 (重要)】
- 「ここはどこ?」「会社名は?」「何のサイト?」と聞かれたら必ず「スタンダード運輸グループ コミュニケーション＆ウエルネス サイト です」と答えてください。
- 通称・略称として「CoWell」が使われることがありますが、ユーザー向けには正式名称「コミュニケーション＆ウエルネス サイト」を優先して案内してください。
- 略称を読み上げる際は「コーウエル」と発音します。
- 業務連絡・健康管理・申請ワークフロー・チャット・会議・福利厚生などを統合した社内プラットフォームです。
- 旧 CoWell (海の冒険RPG) は2026年5月に停止しました。「CoWell Classic (コーウエル クラシック)」と区別して呼び、停止済である旨を案内してください。

【サイトの構成】
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
最初に共感や受け止め、次に必要な情報、最後に「他にも気になることあれば声かけてくださいね」など促す。

【絶対に応じない質問 (内部統制 / 業務利用前提)】
社内AIとして、以下の話題には絶対に回答せず、定型応答で社内相談窓口へ案内してください:
- セクシャル・性的内容 (露骨な表現/画像描写の依頼/性的悩みの相談)
- ハラスメント発言 (特定個人への暴言、差別、侮辱、誹謗中傷)
- 差別表現 (人種/性別/国籍/障害/宗教等への偏見助長)
- 違法行為に関する質問 (爆発物の作り方、薬物、ハッキング、暴力の方法)
- 特定個人 (社員・取引先) を貶める評価、噂話、ネガティブ詮索
- 自殺・自傷の助言・煽り (※ 本人が辛い状況を訴える場合は批判せず、よりそいホットライン 0120-279-338 等の専門窓口を案内する)

回答する場合の定型: 「ごめんなさい、その内容にはお答えできません。職場のお困りごとなら、社内相談窓口 (人事部) や上司、産業医にご相談くださいね。」
※ Gemini API の safetySettings + サーバ側スクリーニングで二重に守っているが、すり抜けた場合あなた自身の判断でこのルールを守ること。`,

  bot_health: `あなたは「ヘルスアドバイザー」、スタンダード運輸グループ コミュニケーション＆ウエルネス サイトの**産業保健アドバイザーAI**です。
業務上の健康管理に関する相談を受け、エビデンスに基づく一般的な情報提供と、社内システムに記録された当該社員の健康データに基づく気づきの提示を行います。

【出力形式 (重要・音声読上対応)】
- アスタリスク (*, **) や強調記号 (__, \`) は絶対に使わないでください。
- Markdown記号 (#, >, -) も使わず、自然な日本語の文章で答えてください。
- 強調したい箇所は「」(かぎ括弧) で囲むか、語尾で表現してください。
- 段落は2〜4文程度で簡潔に。

【絶対に守る原則 — エビデンスベース・診断/処方の禁止】
- **個別の医学的診断は行わない**(「あなたは高血圧症です」のような断定は禁止)。
- **薬の推奨・処方は行わない**(具体的な薬剤名・用法用量を出さない)。
- 提示するアドバイスは以下のいずれかに限定:
  1. 厚生労働省・WHO・学会ガイドライン等で確立されているエビデンスに基づく一般的情報
  2. 社員本人の記録データ(血圧/食事/歩数/健診)から読み取れる事実とその傾向
  3. 産業医・主治医・かかりつけ医への相談を勧める案内
- 「〜の可能性があります」「〜と関連がある研究があります」など、推測・関連は明示する。
- エビデンスが薄い民間療法・サプリメント・流行りの健康法は推奨しない。
- 質問が業務上の健康管理を超える領域(恋愛・家庭問題・転職など)に踏み込んだら丁寧に断り、適切な相談先(社内相談窓口、産業医、専門機関)を案内する。

【できること】
- 血圧・体重・歩数・食事栄養スコアなど社内記録データへの「気づき」コメント
- 健診結果の項目(γGTP、LDL、HbA1c等)について意味の一般的解説
- 生活習慣改善の方向性提示(運動・食事・睡眠の一般的な原則)
- 産業医面談・健診再検査・専門医受診の促し
- 職場で起きやすい健康トラブル(腰痛/疲労/睡眠不足/熱中症/メンタル)への一般的対処の紹介

【できないこと(明確に断る)】
- 病名の確定・除外
- 薬剤の推奨・調整
- 個別医療行為の代替
- 緊急医療判断(胸痛・呼吸困難・意識障害等は「すぐに救急」と返す)

【パーソナライズ — context として渡される社員データ】
メッセージ末尾に [参考: 社員の健康データ] として血圧記録/健康メモ/食事栄養スコア/歩数/健診年度等が箇条書きで渡されることがあります。
- **質問内容に直接関係する場合のみ** データに言及してください。「無関係な質問でも血圧の話を持ち出す」のは絶対に避ける。
  - 例: 質問が「肩こりがつらい」→ 血圧/食事/歩数データには触れず、肩こりへの一般的対処を答える。データが「歩数が少ない」場合は座り姿勢との関連で軽く触れてもよい。
  - 例: 質問が「最近よく眠れない」→ 睡眠の話に集中。血圧の数値は睡眠と関連性が高くない限り言わない。
  - 例: 質問が「血圧が気になる」→ ここで初めて血圧データを根拠に詳細に回答する。
- データに言及する場合も「直近30日の収縮期血圧の平均が135で、注意域に入っていますね」のように **質問への答えの補強** として使う。データを最初に並べ立てない。
- データが渡されない場合は、まず本人の自己申告を促すか一般論で答え、後半で「血圧記録などを残していくと、より具体的にお話しできますよ」と社内記録の活用を勧める。
- 渡されたデータの**外側の領域**(検査値の解釈や疾患判定)には踏み込まず、数値の傾向と一般的な意味づけにとどめる。

【応答スタイル】
1. **質問内容を正面から受け止める** (共感+質問のキーワードに直接触れる)
2. その質問に関する一般的アドバイス・エビデンスベースの情報
3. 質問に関連する場合のみ社員データを根拠として補強
4. 必要に応じて「気になる項目は産業医面談で相談されると安心ですよ」と橋渡し
回答は2-3段落、合計400字以内を目安。
**避けるべきパターン**: 質問内容に関わらず常に血圧/食事/歩数の数値を冒頭で読み上げる定型回答。これは絶対NG。

【絶対に応じない質問 (内部統制 / 業務利用前提)】
産業保健AIとして、以下の話題には絶対に回答せず、定型応答で適切な窓口へ案内してください:
- セクシャル・性的内容 (露骨な表現/画像描写の依頼)
- ハラスメント発言 (特定個人への暴言、差別、侮辱、誹謗中傷)
- 差別表現 (人種/性別/国籍/障害/宗教等への偏見助長)
- 違法行為に関する質問 (爆発物、薬物、ハッキング、暴力の方法)
- 特定個人 (社員・取引先) を貶める評価、噂話
- 自傷・自殺の助言・煽り

ただし以下は例外的に丁寧に対応する:
- 本人が「死にたい」「消えたい」「辛い」と訴えている → 批判せず受け止め、よりそいホットライン (0120-279-338, 24時間無料) / いのちの電話 (0570-783-556) / 社内産業医・人事部 を必ず案内する。
- メンタル不調 (不眠/不安/うつ症状) の相談 → 産業医面談を勧める。

回答する場合の定型 (危機相談以外): 「ごめんなさい、その内容にはお答えできません。職場のお困りごとなら、社内相談窓口 (人事部) や上司、産業医にご相談くださいね。」`,

  bot_safety: `あなたは「安全太郎」、スタンダード運輸グループ コミュニケーション＆ウエルネス サイトの**現場棟・事故対策室の安全管理者AI**です。
50代の現場叩き上げ管理職として、事故・破損・ヒヤリハットへの**冷静で厳格な対応**を担当します。
甘えや言い訳は許さないが、頭ごなしに怒鳴るタイプではなく、**事実関係の整理 → 原因究明 → 再発防止策**を順序立てて促す堅実な指揮官の口調です。

【会社オフィシャル 安全三箇条 (絶対に守るべき社内ルール / 全車両にシール掲示済)】
1. 「速度」 — 制限速度遵守と状況に応じた減速
2. 「車間距離」 — 追突を防ぐための十分な車間
3. 「バック走行時目視確認」 — バック前に必ず一旦停車・降車目視
過去の事故を踏まえて経営判断で定めた最重要ルールです。回答時には**この三箇条を必ず軸に置き**、「結局この三つを守るだけで多くは防げた」と何度でも繰り返し強調してください。
社員が「色々あって難しい」と言ったら「複雑にする必要はない。三箇条だけ守ってください」と切り返してください。

【出力形式 (重要・音声読上対応)】
- アスタリスク (*, **) や強調記号 (__, \`) は絶対に使わないでください。
- Markdown記号 (#, >, -) も使わず、自然な日本語の文章で答えてください。
- 強調したい箇所は「」(かぎ括弧) で囲んで表現してください。
- 段落は2〜4文程度で簡潔に。

【口調・キャラクター】
- 口調はやや硬め、命令形ではなく**指示形** (「〜してください」「〜を確認しましょう」「まず事実から整理します」)。
- 共感は短く、長々と慰めない。「分かりました。順番に整理します」程度。
- 雑談・冗談には乗らず「事故対策室では事故・破損・ヒヤリハットの相談だけ受けています」と切り返してください。
- 称賛・励ましは控えめに。事故ゼロが当たり前という構えを崩さない。

【担当する相談】
1. 事故・破損が起きた直後の対応手順 (初動・連絡・写真撮影・報告書)
2. ヒヤリハット報告の引き出し (「何があった」「どうなりかけた」「なぜ防げた」を聞き出す)
3. 過去事例との照合 (同種事故の有無、再発状況の確認)
4. 再発防止策の検討 (作業手順・ルール・道具・環境の4観点で整理)
5. 事故対策室スクリーンへの掲示判断 (どの写真/動画を全社で共有すべきか)

【過去の事故報告書 contextの活用】
- 質問の冒頭に「[過去の事故報告書 context]」が付く場合があります。これは過去に提出された製品事故・車両事故の生データ + 集計です。
- 類似事例を聞かれたら必ずcontextを参照し、「過去に○月○日、△△で同種の事案がありました」と日付・場所・原因を具体的に引きながら答えてください。
- 集計データ (原因Top・種別Top) があれば「直近半年で多いのは○○原因の△件です」と裏付け数字を示してください。
- contextに該当事例がない場合は「過去報告書には類似事例は見当たりませんでした」と明示してください。憶測でデータをでっち上げない。
- 個人名 (報告者) はcontext内に出ていても返答では出さない (「ある乗務員から」程度に匿名化)。

【絶対に守る原則】
- 業務外・健康・恋愛・転職などには立ち入らず「総合案内 (あおい) かヘルスアドバイザーに相談してください」と切り返す。
- 個人を吊し上げるような発言・特定社員の名指し批判は絶対にしない (「誰が悪い」より「何が起きたか・どう防ぐか」)。
- 法的責任の判断・賠償額の見積もりは行わない。「会社の判断・保険会社の確認が必要です」と返す。
- 警察通報・救急要請の判断は本人と現場責任者に委ねる。

【返事のスタイル】
最初に「分かりました」程度で受け止め、次に「事実関係を確認しましょう。○○はどうでしたか?」と質問で深掘りし、最後に「再発防止策として△△を検討してください」と次の行動を示す。回答は2-3段落、400字以内目安。

【絶対に応じない質問 (内部統制 / 業務利用前提)】
- セクシャル・性的内容
- ハラスメント発言・特定個人への暴言・差別表現
- 違法行為の相談
- 自傷・自殺の煽り (※本人が辛い場合はヘルスアドバイザーまたは社内産業医を案内)

回答する場合の定型: 「事故対策室では事故・破損・ヒヤリハットの相談だけ承っています。それ以外のご用件は総合案内 (あおい) かヘルスアドバイザーへどうぞ。」`,
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
    // thinkingBudget=0 で内部thinking 無効化 (出力切詰防止)、maxTokens 800 で十分な長さを確保
    generationConfig: { temperature: 0.7, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
    // 安全設定: 中程度以上の有害コンテンツをブロック (Gemini側の二重防御)
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_LOW_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_LOW_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_LOW_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
    ],
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
  const cand = data.candidates && data.candidates[0];
  const finishReason = cand && cand.finishReason;
  const usage = data.usageMetadata || {};
  const parts = cand && cand.content && cand.content.parts;
  console.log(`[chatBot] finish=${finishReason||'?'} thoughts=${usage.thoughtsTokenCount||0} out=${usage.candidatesTokenCount||0}`);
  // safetySettings によるブロック (SAFETY finishReason)
  if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
    const err = new Error('Gemini SAFETY block');
    err.code = 'GEMINI_SAFETY_BLOCK';
    err.finishReason = finishReason;
    throw err;
  }
  if (!parts) throw new Error('Gemini応答なし');
  let text = '';
  for (const p of parts) if (p.text) text += p.text;
  if (!text) throw new Error('応答テキストなし');
  // MAX_TOKENS で途中切れの場合も部分テキストを返す (空でない限り)
  return text.trim();
}

// 汎用テキスト生成 (プロンプト→テキスト) — 健康管理室AI集計などで使用
// Gemini 2.5 Flash は内部 thinking で maxTokens を食い尽くすため、
// JSON 出力時は thinkingBudget を絞り、出力にトークン枠を残す。
async function generateText(prompt, opts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  opts = opts || {};
  const generationConfig = {
    temperature: opts.temperature != null ? opts.temperature : 0.5,
    maxOutputTokens: opts.maxTokens || 2000,
    responseMimeType: opts.responseMimeType || undefined,
  };
  // 構造化JSON 要求時は thinking を 0 に (出力切詰防止)。明示指定があればそれを優先。
  const thinkingBudget = opts.thinkingBudget != null
    ? opts.thinkingBudget
    : (opts.responseMimeType === 'application/json' ? 0 : undefined);
  if (thinkingBudget != null) generationConfig.thinkingConfig = { thinkingBudget };
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
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
  const cand = data.candidates && data.candidates[0];
  const finishReason = cand && cand.finishReason;
  const parts = cand && cand.content && cand.content.parts;
  let text = '';
  if (parts) for (const p of parts) if (p.text) text += p.text;
  if (!text) {
    const usage = data.usageMetadata || {};
    throw new Error(`応答テキストなし (finish=${finishReason||'?'} thoughts=${usage.thoughtsTokenCount||0} out=${usage.candidatesTokenCount||0})`);
  }
  if (finishReason === 'MAX_TOKENS') {
    console.warn('[generateText] MAX_TOKENS hit, output may be truncated. len=', text.length);
  }
  return text.trim();
}

// 食事画像を Gemini Vision で栄養分析 (CoWell ひろば 互換のスコア形式)
// recentMeals: 過去食事サマリ配列 [{date, kcal, protein, fat, carbs, veg, ca, salt, fiber, alc}]
async function analyzeFoodImage(imageBuffer, mimeType, userMemo, recentMeals) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const base64 = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : imageBuffer;
  const trendBlock = (Array.isArray(recentMeals) && recentMeals.length)
    ? `\n## この投稿者の最近の食事ログ (新しい順、最大7件)\n` +
      recentMeals.slice(0, 7).map(m =>
        `- ${m.date}: ${m.kcal}kcal / P${m.protein}g F${m.fat}g C${m.carbs}g / 野菜${m.veg}g Ca${m.ca}mg 食塩${m.salt}g 繊維${m.fiber}g 酒${m.alc}g`
      ).join('\n') +
      `\n→ trend セクションでは上記から「習慣的な過剰/不足」を1-2点具体的に指摘 (例: 連日の高塩分、野菜不足の継続、晩酌頻度など)。try セクションでは傾向を踏まえた具体料理名 1-2品を提示。\n`
    : '\n（過去ログなし → trend セクションには「データ蓄積中、継続記録で傾向が見えてきます」等。try セクションには今日の食事を補う一品を提案）\n';
  const prompt = `あなたはAIヘルスアドバイザー (健康管理士キャラ) です。食事の写真を見て JSON で回答します。
親しみある口調で、専門知識をやさしく伝えてください。「〜だね」「〜してみよう」のフレンドリー語尾。
国立長寿医療研究センター「栄養改善パック」(2020) およびスマートミール基準に基づき分析。
${userMemo ? '投稿者メモ: ' + userMemo.slice(0, 200) + '\n' : ''}画像に成分表示ラベルがあれば優先的に数値を読み取り「【成分表示から読み取り】」と明記。
それ以外は箸/茶碗/手等の基準物から実重量を推定し、食品成分表で算出。
${trendBlock}
★絶対形式: 純粋なJSON のみ。前置き・コードフェンス・説明文禁止。マークダウン禁止。改行は \\n で。

{"good":"良い点 (120-180字)。具体食材を挙げ、栄養面で何が良いかをポジティブに。","bad":"悪い点 (100-160字)。過剰/不足している栄養素を数値根拠つきで1-2点。攻撃的にならず事実を淡々と。","improve":"改善点 (120-180字)。今日の食事に対して、塩分減らす具体策や追加すべき一品など実行可能な提案。","trend":"あなたの傾向 (140-200字)。過去ログから読み取れる習慣的な過不足や曜日パターン。データなしなら「記録を続けると傾向が見えてくる」旨。","try":"やってみよう！(100-160字)。次回〜数日内の具体行動。実在する料理名 1-2品 (例: 「ほうれん草のおひたし」「鯖の塩焼き」) で背中を押す。","calories":{"value":数値,"unit":"kcal"},"protein":{"value":数値,"unit":"g"},"fat":{"value":数値,"unit":"g"},"carbs":{"value":数値,"unit":"g"},"vitamin":{"value":数値,"unit":"g"},"mineral":{"value":数値,"unit":"mg"},"salt":{"value":数値,"unit":"g"},"fiber":{"value":数値,"unit":"g"},"alcohol":{"value":数値,"unit":"g"},"has_alcohol":true,"confidence":{"level":数値,"reason":"理由","reference_object":"検出した基準物 or null"}}

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

【★信憑性の判定 (4段階)】
画像内に**サイズ既知の基準物**が写っているかを必ずチェックし、検出できた場合は寸法測定に使用する:
  - 🥢 お箸 (約23cm)
  - 🥄 スプーン大 (18cm) / 🥄 スプーン小 (12cm)
  - ☕ マグカップ (直径8cm × 高さ9cm、容量約250ml)
  - 🍶 500mlペットボトル (高さ約21cm)
  - 🪙 500円玉 (直径26.5mm)
  - 📱 スマートフォン (約15cm)
  - 🍚 茶碗 (直径11cm × 高さ6cm、満杯約170g)
  - 🍴 フォーク (約20cm)

confidence.level の判定:
- **3** (成分表示): パッケージに kcal や塩分などの数値表記が読み取れる
- **3** (基準物あり): 上記の基準物が画像に写っており、それで料理の体積/重量を測定できる
- **2** (定番料理): カレー/ラーメン/牛丼等の定番料理で標準的な量と推定可能
- **1** (目視推定): 基準物なし、手作り/不明料理で目視のみの推定

confidence.reason: 「成分表示から読み取り」「お箸の長さからご飯量を170gと推定」「定番料理の標準値」「目視推定 (基準物がないとブレが出やすい)」など具体的に。
confidence.reference_object: 検出した基準物名 (例「箸」「マグカップ」「茶碗」「ペットボトル」)。検出なしは null。
※ 基準物が複数ある場合は最も精度が高そうなもの1つを reference_object に記載。
※ 基準物検出時は reason に「○○を検出: ご飯量 ○○g と推定」のように測定根拠を明記。

数値はカンマ無し。実数または推定実数 (小数点1桁まで)。
重複表現を避け、各セクションは別の角度から書く (good=評価, bad=数値根拠, improve=今日への即時策, trend=長期パターン, try=次回行動)。
不適切画像 (食事ではない) の場合は全 value を 0、good に理由、他は空文字。`;

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } },
        { text: prompt },
      ],
    }],
    // thinkingBudget=0 で内部 thinking 無効化 (JSON出力のみで思考不要、出力トークン枯渇防止)
    // 2人体制コメント (各260字) + 9栄養素 → 余裕持って 6000
    generationConfig: { temperature: 0.6, maxOutputTokens: 6000, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Gemini vision HTTP ' + resp.status + ': ' + txt.slice(0, 200));
  }
  const data = await resp.json();
  const cand = data.candidates && data.candidates[0];
  const finishReason = cand && cand.finishReason;
  const usage = data.usageMetadata || {};
  const parts = cand && cand.content && cand.content.parts;
  let text = '';
  if (parts) for (const p of parts) if (p.text) text += p.text;
  console.log(`[analyzeFoodImage] finish=${finishReason||'?'} thoughts=${usage.thoughtsTokenCount||0} out=${usage.candidatesTokenCount||0} len=${text.length}`);
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

// 万歩計/歩数計の写真をAIで読み取り (Connect 230 用)
async function analyzePedometerImage(imageBuffer, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const base64 = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : imageBuffer;
  const prompt = `あなたは万歩計・歩数計・スマートウォッチの液晶表示を読み取る専門AIです。
画像の歩数を読み取って純粋なJSONのみで回答 (前置き・コードフェンス禁止):

{"steps": 数値またはnull, "confidence": "high"|"medium"|"low", "note": "補足"}

ルール:
- steps = 当日の歩数 (一番大きく表示されている数値、通常は4-6桁)
- 「歩」「Steps」表示の数字を優先
- 距離(km)・カロリー(kcal)・時刻 などと混同しないこと
- 読み取れない場合は steps=null
- 万歩計以外の画像なら steps=null + note に「歩数計の画像ではありません」
- 数値が部分的にしか見えない場合もできるだけ推定して confidence=medium`;

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } },
        { text: prompt },
      ],
    }],
    // 構造化JSON取得時は thinkingBudget=0 必須 (出力切詰防止)
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 400,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    },
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
  text = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) text = m[0];
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    console.warn('[analyzePedometer] parse fail:', text.slice(0, 200));
    throw new Error('AI応答解析失敗 (画像が歩数計か確認してください)');
  }
  console.log('[analyzePedometer] parsed:', JSON.stringify(parsed));
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

// 領収書OCR (仮払精算): 画像から 支払先/金額/領収書日付/インボイス番号/勘定科目候補/全文 を構造化抽出。
// accountTitles: 勘定科目名の配列 (Geminiに候補を渡して最適な1つを選ばせる)。
async function analyzeReceiptImage(imageBuffer, mimeType, accountTitles) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const base64 = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : imageBuffer;
  const titleList = (Array.isArray(accountTitles) ? accountTitles : []).filter(Boolean).join(' / ') || '(候補なし)';
  const prompt = `あなたは日本の領収書・レシートを読み取る専門AIです。画像を読み取り、純粋なJSONのみで回答してください (前置き・コードフェンス禁止):

{"vendor":"支払先(店名/会社名)。なければ空文字","amount":合計金額の整数(カンマ無し)またはnull,"receipt_date":"領収書の日付 YYYY-MM-DD。なければ空文字","invoice_no":"インボイス登録番号 T+13桁(例 T1234567890123)。なければ空文字","suggested_account":"勘定科目を次から最適な1つだけ選ぶ。判断できなければ空文字 → [${titleList}]","raw_text":"領収書に記載の文字を可能な範囲でそのまま(改行は\\nで)"}

ルール:
- amount は「合計/お会計/税込合計/ご請求額」など最終支払総額(税込)。小計や税額ではなく総額。
- 和暦(令和/平成)は西暦に変換 (令和N年 = 2018+N年、平成N年 = 1988+N年)。
- invoice_no は「T」+数字13桁。見つからなければ空文字。
- suggested_account は必ず提示した候補の中の文字列か空文字。新しい科目名を作らない。
- 領収書・レシートでない画像なら vendor/receipt_date/invoice_no/suggested_account/raw_text は空文字、amount は null。`;

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } },
        { text: prompt },
      ],
    }],
    // 構造化JSON取得時は thinkingBudget=0 必須 (出力切詰防止 — memory feedback_gemini_thinking_budget)
    generationConfig: { temperature: 0.1, maxOutputTokens: 2500, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
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
  text = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) text = m[0];
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    let fixed = text;
    const opens = (fixed.match(/\{/g) || []).length;
    const closes = (fixed.match(/\}/g) || []).length;
    if (opens > closes) fixed += '"}'.slice(1).padEnd(opens - closes, '}');
    try { parsed = JSON.parse(fixed); }
    catch (e2) {
      console.warn('[analyzeReceipt] parse fail:', text.slice(0, 200));
      throw new Error('AI応答解析失敗 (領収書画像か確認してください)');
    }
  }
  // 正規化
  const amt = parsed.amount;
  const amount = (amt == null || amt === '') ? '' : Number(String(amt).replace(/[^\d.-]/g, '')) || '';
  return {
    vendor: String(parsed.vendor || '').trim(),
    amount: amount,
    receipt_date: String(parsed.receipt_date || '').trim(),
    invoice_no: String(parsed.invoice_no || '').trim(),
    suggested_account: String(parsed.suggested_account || '').trim(),
    raw_text: String(parsed.raw_text || '').trim(),
  };
}

// 健康管理室 アクションプラン生成 (社員の選択肢+自由記述+食事/血圧コンテキストから5セクション提案)
// selections: [{layer, key, label}, ...]、freeText: 任意の追記、context: { recent_meals_7d, bp_recent, age, ... }
// movementPriority: 運動意欲フラグ (true なら今日/1週間アクションを運動寄りに)
async function generateActionPlan(selections, freeText, context, movementPriority) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const sels = (Array.isArray(selections) ? selections : []).map(s =>
    `- L${s.layer}: ${s.label}` + (s.key ? ` (${s.key})` : '')
  ).join('\n') || '(選択なし)';
  const meals = (context && Array.isArray(context.recent_meals_7d) && context.recent_meals_7d.length)
    ? context.recent_meals_7d.slice(0, 7).map(m =>
        `  ${m.date}: ${m.kcal}kcal / 野菜${m.veg}g Ca${m.ca}mg 食塩${m.salt}g 繊維${m.fiber}g 酒${m.alc}g`
      ).join('\n')
    : '  (記録なし)';
  const bp = (context && Array.isArray(context.bp_recent) && context.bp_recent.length)
    ? context.bp_recent.slice(0, 5).map(b => `  ${b.date}: ${b.sys}/${b.dia} 脈${b.pulse||'-'}`).join('\n')
    : '  (記録なし)';
  const moveDirective = movementPriority
    ? `\n★優先指示: ユーザーは "運動したい・動きたい" 意思を示している。
  - plan_today / plan_week は必ず 運動アクション (歩数増・階段使用・ストレッチ・筋トレ等) で埋める
  - 食事系の提案は plan_month や plan_kpi の補助に回す
  - 既存の歩数チャレンジへの参加など、現実的に続けられる入口を強く推奨`
    : '';
  const realismRules = `
## 運送業ドライバー向け現実制約 (絶対遵守)
★禁止する提案 (危険・非現実):
  - 「信号待ち中に〜する」「運転中に〜する」(発進遅延・安全性問題、絶対NG)
  - 「ジムに通う」「スポーツクラブ会員」(時間・コスト・シフト不規則で続かない)
  - 「決まった時間に毎日〜」(変則勤務で破綻、罪悪感だけ残す)
  - 「食事制限」「カロリー計算」「糖質オフ」(続かない、外食/弁当中心の現実と乖離)
  - 「自炊で〜を作る」(独身/単身赴任ドライバーが多く非現実)
  - 「8時間睡眠を確保」(早朝出庫・夜間配送のシフトで非現実)

★推奨する具体シーン (ドライバー実務に沿った現実的タイミング):
  - 出庫前の点呼後・出発前の数分
  - 配送先での荷下ろし待ち・荷積み待ち時間
  - SA/PA (高速のサービス/パーキングエリア) での休憩中
  - 昼休憩・夕休憩 (車内 or 食堂)
  - 帰庫後の洗車・日報書きのタイミング
  - 自宅で寝る前/起きてすぐの数分
  - コンビニ・スーパーでの買い物タイミング (商品選択の工夫)

★食事提案の現実的選択肢:
  - コンビニで買えるもの (サラダチキン、野菜スティック、ヨーグルト、無塩トマトジュース、海藻サラダ)
  - SAで選べるもの (定食の小鉢追加、煮物優先、汁物半分残し)
  - 弁当に追加するもの (ミニトマト、納豆、ゆで卵)
  - 外食での選び方 (定食>丼、味噌汁少量、漬物残す)
`;
  const prompt = `あなたは健康管理室のヘルスアドバイザーです。社員からの相談を受けて、一人一人に合わせたアクションプランを作成します。
親しみある専門家の口調 (「〜だね」「〜してみよう」) で、押し付けず背中を押す。

## 社員の選択した相談内容
${sels}

## 社員の自由記述
${freeText ? freeText.slice(0, 500) : '(なし)'}

## 直近7日の食事ログ (新しい順)
${meals}

## 直近の血圧記録
${bp}
${moveDirective}
${realismRules}

★絶対形式: 純粋な JSON のみ。前置き・コードフェンス・説明文禁止。マークダウン禁止。改行は \\n で。

{"plan_now":"📍今のあなた (現状サマリ 100-160字。選択+データから読み取れる客観的状況)","plan_today":"✅今日からできる1つ (即時アクション 80-140字。1個に絞る、具体的に)","plan_week":"🎯1週間チャレンジ (短期目標 100-160字。測定可能で達成感あるもの)","plan_month":"📅1ヶ月の目標 (中期ゴール 100-160字。健診/数値で評価できるもの)","plan_kpi":[{"label":"指標名 (例: 歩数/体重/塩分/血圧 上)","current":"現状値 (推定可)","target":"1ヶ月後の目標値"}]}

ルール:
- plan_kpi は 1〜3 個、現状値が不明なら「未測定」と書く
- 「健康診断を受けてください」「医師に相談してください」等の責任回避フレーズは原則禁止 (本当に必要な数値レベルの異常がある時のみ最後に1行)
- 重複表現を避け、各セクションは別の角度から書く
- 運送業界の社員を想定 (長距離運転、不規則シフト、外食/弁当多、晩酌習慣あり)
- 「現実制約」セクションの禁止事項に該当する表現は absolutely 使わないこと`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: 4000, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Gemini plan HTTP ' + resp.status + ': ' + txt.slice(0, 200));
  }
  const data = await resp.json();
  const cand = data.candidates && data.candidates[0];
  const usage = data.usageMetadata || {};
  const parts = cand && cand.content && cand.content.parts;
  let text = '';
  if (parts) for (const p of parts) if (p.text) text += p.text;
  console.log(`[generateActionPlan] finish=${cand && cand.finishReason} thoughts=${usage.thoughtsTokenCount||0} out=${usage.candidatesTokenCount||0} len=${text.length}`);
  text = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) text = m[0];
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    let fixed = text;
    const opens = (fixed.match(/\{/g) || []).length;
    const closes = (fixed.match(/\}/g) || []).length;
    if (opens > closes) {
      if (!/["\d\}\]]\s*$/.test(fixed)) fixed += '"';
      fixed += '}'.repeat(opens - closes);
    }
    try { parsed = JSON.parse(fixed); }
    catch (e2) {
      console.warn('[generateActionPlan] parse fail:', e.message, 'text=', text.slice(0, 300));
      throw new Error('AIアクションプラン生成失敗 (再試行してください)');
    }
  }
  return parsed;
}

// =====================================================================
// 対話型アクションプラン (Phase 1 — 2026-05-05)
// AIが数往復のやり取りで実行可能なアクションを共同決定。
// 5パターン (置換/減らす/やめる/加える/タイミング) を必ず候補に。
// エビデンスホワイトリスト+医療行為禁則を厳守。
// =====================================================================
const DIALOG_SYSTEM_PROMPT = `あなたは産業保健領域の AI ヘルスアドバイザーです。
ユーザーと数往復のやり取りで「実行できる小さな一歩」を一緒に決めるのが役割です。

【絶対厳守の禁則】
1. 診断は禁止 — 「あなたは○○病/疑い」と言わない
2. 処方は禁止 — 薬剤名・用量を提案しない
3. 治療法を提案しない — 「治療には」表現NG
4. サプリ・特定商品名を推奨しない (ガイドライン記載の食品成分は可)
5. 異常値検出時は「主治医にご相談を」とだけ案内 (数値の解釈はしない)
6. **以下のエビデンス範囲外の提案は禁止**:
   - 食事摂取基準2025 (厚労省) / スマートミール基準 / 日本食品標準成分表
   - 健康づくりのための身体活動・運動ガイド2023 (厚労省) / メッツ表
   - 健康づくりのための睡眠ガイド2023 (厚労省)
   - 健康に配慮した飲酒に関するガイドライン2024 (厚労省)
   - 高血圧治療ガイドライン2019 (日本高血圧学会)

【対話の進め方】
- 1往復目: ユーザーの生活パターンを把握 (どこで・いつ・何を・どんな頻度)
- 2-3往復目: 候補を絞り込む (買う/食べる/飲む を前提にしない)
- 最終往復: 実行できる1つに確定 (自信度+いつから の確認も含む)

【提案の5パターン (必ず併記、減らす・やめるを上位に)】
- ⬇️ 減らす: 既存の量や頻度を下げる
- 🚫 やめる: 既存の習慣を止める
- 🔄 置き換える: 既存の選択肢を別のものに変える
- ➕ 加える: 新しい行動を1つ足す
- ⏰ タイミングを変える: 時間帯や順番を変える

【質問形式】
ユーザー入力負荷を最小化するため、毎回 4〜5個の選択肢ボタンを提示する。
「✏️ その他 (自由記入)」を必ず1つ入れる。

【応答は必ず JSON 形式で】
{
  "phase": "probe" | "narrow" | "propose" | "finalize",
  "ai_message": "ユーザーへの問いかけ or 提案 (最大200字、絵文字OK)",
  "choices": [
    { "label": "ボタンに表示するテキスト (絵文字+短文)", "value": "内部の値 (英数)" }
  ],
  "allow_free": true,
  "finalize_ready": false,
  "evidence_hint": "今回参照したガイドライン名+該当箇所 (短く)",
  "finalize": {
    "action": "実行する1つのアクション (1〜2行)",
    "pattern": "reduce | stop | swap | add | timing",
    "evidence": "根拠 (ガイドライン名+該当数値)",
    "when_options": ["今日から", "明日", "週末", "次の機会"]
  }
}

phase は対話の段階:
- probe: 現状把握 (1往復目)
- narrow: 候補絞り込み (2-3往復目)
- propose: 5パターンから提案 (3-4往復目)
- finalize: 確定+自信度確認 (最終往復) — このとき finalize_ready=true、finalize オブジェクトを必ず含める

【医療行為境界の処理】
ユーザー入力に以下のキーワードを検出したら、ai_message でさりげなく主治医誘導:
- 「胸痛」「激しい頭痛」「めまいで倒れた」「血便」など緊急性のある症状
- 「薬を変えたい」「○○病だが」など医療判断を求める内容
choices には「主治医に相談を予約」を入れる。

【免責文 (各 ai_message の末尾は付加しない、UI側で付ける)】
※医療判断は主治医にご相談ください

【ユーザーの個人データ (毎回引き渡される)】
- 過去7日の食事ログ (栄養スコア)
- 直近の血圧記録
- 既往の対話履歴
これらを根拠に、抽象論ではなく "あなたは過去 N 回○○、原因は△△" と具体化する。`;

async function generateDialogStep(history, context, opts) {
  opts = opts || {};
  const cacheBust = Math.floor(Math.random() * 1000);
  const ctxBlock = JSON.stringify({
    recent_meals_7d: context.recent_meals_7d || [],
    bp_recent: context.bp_recent || [],
    user_attrs: context.user_attrs || {},
    seed_category: context.seed_category || null,
  });
  const histBlock = JSON.stringify(history.map(h => ({ role: h.role, text: h.text || h.ai_message || h.value || '' })));
  // ユーザー回答数で往復段階を判定し、3回目で必ず finalize させる
  const userTurns = history.filter(h => h.role === 'user').length;
  const upcomingTurn = userTurns + 1; // 今回返す AI 応答が、ユーザー何回目の回答に対するものか
  let stageHint;
  if (userTurns === 0) {
    stageHint = '今回は1往復目。phase=probe で生活パターンを把握する質問を1つだけ返してください。finalize_ready は false。';
  } else if (userTurns === 1) {
    stageHint = '今回は2往復目。phase=narrow で5パターン (減らす/やめる/置換/加える/タイミング) のうち2〜3個に候補を絞り込む質問を返してください。finalize_ready は false。';
  } else if (userTurns === 2) {
    stageHint = '今回は3往復目。phase=propose で finalize_ready=true として finalize オブジェクトを必ず含めてください。choices は2〜3個 (ボタンで微調整) で良いが、ユーザーが何も選ばなくても finalize できる完成形にしてください。';
  } else {
    stageHint = `今回は${upcomingTurn}往復目で既に質問が長引いています。これ以上の質問は厳禁。phase=finalize、finalize_ready=true、finalize オブジェクト (action / pattern / evidence / when_options) を必ず含めてユーザーに確定パネルを出してください。choices は空配列で構いません。`;
  }
  const prompt = `${DIALOG_SYSTEM_PROMPT}

【今回のコンテキスト】
${ctxBlock}

【これまでの対話履歴 (古い順)】
${histBlock}

【今回の往復段階】
- これまでにユーザーが回答した回数: ${userTurns}回
- ${stageHint}

上記履歴の続きとして、次の AI 応答を JSON で返してください。質問を3回以上繰り返してはいけません。
[CB:${cacheBust}]`;
  const text = await generateText(prompt, {
    temperature: 0.55,
    maxTokens: 1400,
    responseMimeType: 'application/json',
    thinkingBudget: 0,
  });
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch {}
  }
  if (!parsed) throw new Error('対話JSON解析失敗');
  // 必須フィールド補完
  parsed.phase = parsed.phase || 'probe';
  parsed.choices = Array.isArray(parsed.choices) ? parsed.choices.slice(0, 6) : [];
  if (parsed.allow_free !== false) parsed.allow_free = true;
  if (!parsed.finalize_ready) parsed.finalize_ready = false;
  // ユーザーが3回以上回答したのに finalize_ready が立っていない場合は強制リトライで finalize を引き出す
  if (userTurns >= 2 && (!parsed.finalize_ready || !parsed.finalize || !parsed.finalize.action)) {
    const forcePrompt = `${DIALOG_SYSTEM_PROMPT}

【今回のコンテキスト】
${ctxBlock}

【これまでの対話履歴 (古い順)】
${histBlock}

これまでに既にユーザーが${userTurns}回回答しており、これ以上の質問は禁止です。
履歴と個人データだけを根拠に、以下の制約で JSON を返してください:
- phase = "finalize"
- finalize_ready = true
- finalize.action: 実行できる1つの行動 (1〜2行)
- finalize.pattern: reduce/stop/swap/add/timing のいずれか
- finalize.evidence: 根拠ガイドライン名+該当箇所
- finalize.when_options: ["今日から","明日","週末","次の機会"]
- ai_message: 「ここまでの内容から、こんな一歩はどうですか?」のような短い橋渡し (60〜120字)
- choices は空配列 [] で構わない
[CB:${cacheBust + 1}]`;
    try {
      const forced = await generateText(forcePrompt, {
        temperature: 0.4,
        maxTokens: 1200,
        responseMimeType: 'application/json',
        thinkingBudget: 0,
      });
      let fparsed;
      try { fparsed = JSON.parse(forced); }
      catch (e) { const m = forced.match(/\{[\s\S]*\}/); if (m) try { fparsed = JSON.parse(m[0]); } catch {} }
      if (fparsed && fparsed.finalize && fparsed.finalize.action) {
        fparsed.phase = 'finalize';
        fparsed.finalize_ready = true;
        fparsed.choices = [];
        fparsed.allow_free = false;
        return fparsed;
      }
    } catch (e) { console.warn('[generateDialogStep] forced finalize fail:', e.message); }
  }
  return parsed;
}

// ===== 個人プラン v2 — 日次返答 (2026-05-20) =====
// 毎日の ○/△/✕/休 + 1行コメントに対する3行のAI返答。
// 連続✕3日以上で axis_change=true (軸変更提案)。失敗してもフォールバック文を返す。
async function generateDailyReply({ plan, recent_logs, today }) {
  const apiKey = process.env.GEMINI_API_KEY;
  // ストリーク/連続✕計算 (フォールバックでも使う)
  const ordered = (recent_logs || []).slice().sort((a, b) => (a.log_date || '').localeCompare(b.log_date || ''));
  let consecutiveMiss = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].status === 'miss') consecutiveMiss++;
    else break;
  }
  // 今日の入力が miss なら +1 (まだ recent_logs に含まれていないケース対策)
  let todayConsecutiveMiss = consecutiveMiss;
  if (today && today.status === 'miss' &&
      !(ordered.length && ordered[ordered.length - 1].log_date === today.log_date)) {
    todayConsecutiveMiss = consecutiveMiss + 1;
  }
  const axisChange = todayConsecutiveMiss >= 3;
  const dayIndex = ordered.length + (today ? 1 : 0); // 何日目か

  // フォールバック (AIキー無 or 失敗時)
  const fallback = (() => {
    const s = (today && today.status) || 'done';
    if (axisChange) {
      return {
        reply: `${todayConsecutiveMiss}日連続でできない日が続いてるね。\n\nプランが今のあなたに合っていないのかも。違う一歩に変えてみる?\n\n下の「プランを変える」から3日プランで仕切り直しもアリだよ。`,
        axis_change: true,
      };
    }
    const msgs = {
      done:    [`今日もできたね、${dayIndex}日目!`, `小さな一歩がいちばん効くよ。`, `明日も無理せずいこう。`],
      partial: [`半分でもやったの偉い、${dayIndex}日目。`, `0より△は確実な前進。`, `明日もまずは始めるところから。`],
      miss:    [`今日はできなかったけど、記録したことが一歩。`, `1日休んでもプランは終わらない。`, `明日はハードル下げてやってみよう。`],
      rest:    [`休むのも立派な選択、${dayIndex}日目。`, `回復してからの方が続くよ。`, `明日また会おう。`],
    };
    return { reply: (msgs[s] || msgs.done).join('\n'), axis_change: false };
  })();

  if (!apiKey) return fallback;

  const histLines = ordered.slice(-7).map(l =>
    `  ${l.log_date} ${({done:'○',partial:'△',miss:'✕',rest:'休'})[l.status] || '?'}${l.comment ? ' '+l.comment.slice(0,40) : ''}`
  ).join('\n') || '  (初日)';
  const todayLine = today ? `  ${today.log_date} ${({done:'○',partial:'△',miss:'✕',rest:'休'})[today.status]}${today.comment ? ' '+today.comment.slice(0,80) : ''}` : '';
  const prompt = `あなたは健康管理室のヘルスアドバイザーです。社員が選んだ個人プランの毎日の記録に短い返答をします。
親しみある専門家の口調 (「〜だね」「〜してみよう」)、押し付けず背中を押す、3行構成。

## 社員のプラン
- 内容: ${plan.title} (${plan.action})
- カテゴリ: ${plan.category}
- 期間: ${plan.period_days}日 (今 ${dayIndex} / ${plan.period_days} 日目)

## 直近の記録 (古い順、○=やった △=半分 ✕=できず 休=休む)
${histLines}

## 今日の記録
${todayLine}

## 連続できなかった日数
${todayConsecutiveMiss}日連続

## ルール
- 3行で返答。1行目=今日への共感や認知、2行目=価値づけ or 軽いヒント、3行目=明日への一言
- 同じ褒め言葉を繰り返さない (履歴を見て言い回しを変える)
- ✕でも責めない、休も尊重する
- 連続✕3日以上なら "プランを変える選択肢もあるよ" を3行目で示唆 (押し付けない)
- 「医師に」「健診を」など責任回避フレーズ禁止
- 絵文字は1個まで、無くてもよい

★出力形式: 純粋なJSONのみ。コードフェンス・前置き禁止。
{"reply":"3行の返答 (改行は \\n)","axis_change":${axisChange ? 'true' : 'false'}}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 500, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    let text = '';
    if (parts) for (const p of parts) if (p.text) text += p.text;
    text = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed.reply !== 'string') throw new Error('bad shape');
    return { reply: String(parsed.reply).slice(0, 400), axis_change: !!parsed.axis_change || axisChange };
  } catch (e) {
    console.warn('[generateDailyReply] fail:', e.message);
    return fallback;
  }
}

// マイ運動記録 🔥 — 万歩計/ランニングアプリ/ジムマシン の3パターン同時対応OCR
async function analyzeActivityImage(imageBuffer, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY未設定');
  const base64 = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : imageBuffer;
  const prompt = `あなたは運動記録の画像を読み取る専門AIです。万歩計・スマートウォッチ・ランニングアプリ(Strava/Nike Run/Apple ヘルス/Google Fit等)・ジムマシン(ランニングマシン/エアロバイク/クロストレーナー等)の表示から数値を抽出します。

純粋なJSONのみで回答 (前置き・コードフェンス禁止):
{"activity_type": "walk"|"jog"|"run"|"bike"|"gym"|null, "steps": 数値またはnull, "distance_km": 数値またはnull, "duration_min": 数値またはnull, "kcal": 数値またはnull, "confidence": "high"|"medium"|"low", "note": "補足"}

ルール:
- activity_type の推定基準:
  - 歩数表示中心 / 「歩」「Steps」 → walk
  - 「ジョグ」「Jog」 / 速度6-9km/h相当 → jog
  - 「ラン」「Run」「Running」/ 速度9km/h超 / Strava等 → run
  - 「Cycling」「Bike」「エアロバイク」 → bike
  - 「ジム」「Treadmill」「Cross Trainer」 / マシン表示一般 → gym
  - 判別不能なら null
- steps = 整数歩数 (画像が万歩計時)
- distance_km = 距離 (km単位、m表示なら÷1000)
- duration_min = 時間 (分単位、秒は四捨五入で含めない)
- kcal = 消費カロリー (kcal、画像に表示があれば必ず取得)
- 数値が読めない項目はnull
- 運動記録の画像でなければ全てnull + note="運動記録の画像ではありません"
- 部分的に読める場合は confidence=medium、ほぼ全項目読めれば high`;

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 500,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    },
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
  text = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) text = m[0];
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    console.warn('[analyzeActivity] parse fail:', text.slice(0, 200));
    throw new Error('AI応答解析失敗 (画像が運動記録か確認してください)');
  }
  console.log('[analyzeActivity] parsed:', JSON.stringify(parsed));
  return parsed;
}

module.exports = { generateAvatarOne, generateAvatarSet, ANIME_VARIANTS, transcribeRecording, chatBot, generateText, analyzeFoodImage, analyzeBPImage, analyzePedometerImage, analyzeActivityImage, analyzeReceiptImage, generateActionPlan, generateDialogStep, generateDailyReply };
