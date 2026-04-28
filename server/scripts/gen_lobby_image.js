// 1Fロビー一人称視点画像をGeminiで生成 (2026-04-28)
// usage: node server/scripts/gen_lobby_image.js
// 出力: /opt/cohub/public/assets/floor_lobby.png (既存を上書き)
require('dotenv').config({ path: '/opt/cohub/.env' });
const fs = require('fs');
const path = require('path');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY未設定'); process.exit(1); }

const logoPath = '/opt/cohub/public/assets/std_logo.png';
const outPath = '/opt/cohub/public/assets/floor_lobby.png';

// スタンダード運輸のロゴをリファレンスとして渡す
const logoBase64 = fs.readFileSync(logoPath).toString('base64');

const prompt = `参考画像はスタンダード運輸グループ (Standard Transport Group) の会社ロゴです。
このロゴをバックパネルに掲げた、現代的なオフィスビル1F受付ロビーの**一人称視点**画像を生成してください。

【視点・構図】
- 玄関を入って受付に向かう人間の目線(身長170cm程度の視点)
- **必ず 16:9 横長アスペクト比** (1344×768 px、横が縦の約1.75倍) — これは絶対条件
- 写真リアル風
- 中央〜やや右に**白い受付カウンター**(腰高、明るい木目縁)、その奥に若い女性受付係が立つスペース
- 受付カウンターの背後の壁に**スタンダード運輸グループのロゴ**を控えめに(壁の20〜22%サイズ)はっきり配置 ※前回より一回り小さめ
- 左側に**待合エリア**(モダンなブルーグレーのソファ2-3席+小さな丸テーブル)
- 右奥にエレベーター(2基、シルバー枠)
- 床はライトグレーの大判タイル、天井は白くダウンライトが点在

【トーン・雰囲気】
- スタンダード運輸ブランドカラーの**ブルー基調** (ロゴと同じ深みのある藍青色をアクセントに)
- 朝の柔らかい光が左の窓から差し込み、爽やかで清潔感のある雰囲気
- リアル写真調 (CG・イラスト風ではなく、実写風レンダリング)
- 観葉植物(モンステラ等)を1〜2鉢配置して温かみを演出

【重要】
- 受付係本人の**顔は描かないでください** (後で別アバターを重ねる予定なのでカウンターは無人で生成)
- 文字・看板・追加ロゴ等の余計なテキストは入れない (会社ロゴだけは残す)
- カウンターの上はスッキリ (PCモニターのみ可)`;

(async () => {
  console.log('Gemini に1Fロビー画像生成リクエスト送信中…');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'image/png', data: logoBase64 } }
      ]
    }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.85 },
  };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) { console.error('API error', resp.status, (await resp.text()).slice(0, 400)); process.exit(2); }
  const data = await resp.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) { console.error('Gemini応答に画像なし', JSON.stringify(data).slice(0, 400)); process.exit(3); }
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      // 既存のロビー画像をバックアップ
      try { fs.copyFileSync(outPath, outPath + '.bak.' + Date.now()); } catch (e) {}
      const tmpPath = outPath + '.raw.png';
      fs.writeFileSync(tmpPath, Buffer.from(inline.data, 'base64'));
      console.log('生成画像保存:', tmpPath);
      // Gemini の出力は 1120x928 等になりがちなので、他フロアと同じ 1344x768 (16:9) にクロップ&リサイズ
      const { execSync } = require('child_process');
      try {
        execSync(`ffmpeg -y -i ${tmpPath} -vf "crop=in_w:in_w*9/16:0:(in_h-in_w*9/16)/2,scale=1344:768" -update 1 -frames:v 1 ${outPath}`, { stdio: 'inherit' });
        fs.unlinkSync(tmpPath);
        const stats = fs.statSync(outPath);
        console.log('✅ 16:9クロップ完了:', outPath, '(' + Math.round(stats.size / 1024) + ' KB)');
      } catch (e) {
        // ffmpeg失敗時は素のまま使う
        fs.renameSync(tmpPath, outPath);
        console.warn('ffmpeg失敗、素の画像を使用:', e.message);
      }
      return;
    } else if (p.text) {
      console.log('[Gemini text]', p.text.slice(0, 200));
    }
  }
  console.error('画像データが返ってきませんでした');
  process.exit(4);
})().catch(e => { console.error(e); process.exit(5); });
