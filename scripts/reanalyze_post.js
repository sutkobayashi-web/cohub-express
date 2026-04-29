// 既存 plaza_posts レコードを再分析するワンショットスクリプト
// usage: node scripts/reanalyze_post.js <post_id>
// 例: node scripts/reanalyze_post.js 4

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getDb } = require('../server/services/db');
const { analyzeFoodImage } = require('../server/services/ai');

const postId = parseInt(process.argv[2]);
if (!postId) { console.error('post_id required'); process.exit(1); }

function collectRecentMeals(uid, beforeTs) {
  const db = getDb();
  const rows = [];
  try {
    const r1 = db.prepare(`SELECT created_at AS ts, nutrition_scores AS ns FROM plaza_posts
      WHERE author_id=? AND category='食事' AND nutrition_scores IS NOT NULL AND deleted_at IS NULL
      AND created_at < ? AND created_at >= datetime(?, '-7 days')
      ORDER BY created_at DESC LIMIT 7`).all(uid, beforeTs, beforeTs);
    rows.push(...r1);
  } catch (e) { console.warn('plaza_posts lookup err', e.message); }
  try {
    const cwIds = db.prepare(`SELECT cw_id FROM cw_users WHERE cohub_uid=?`).all(uid).map(r => r.cw_id);
    if (cwIds.length) {
      const ph = cwIds.map(() => '?').join(',');
      const r2 = db.prepare(`SELECT cw_created_at AS ts, nutrition_scores AS ns FROM cw_posts
        WHERE cw_user_id IN (${ph}) AND category LIKE '%食事%' AND nutrition_scores IS NOT NULL
        AND cw_created_at < ? AND cw_created_at >= datetime(?, '-7 days')
        ORDER BY cw_created_at DESC LIMIT 7`).all(...cwIds, beforeTs, beforeTs);
      rows.push(...r2);
    }
  } catch (e) { console.warn('cw_posts lookup err', e.message); }
  rows.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  const summarize = (ns) => {
    let s; try { s = typeof ns === 'string' ? JSON.parse(ns) : ns; } catch { return null; }
    const v = (k) => { const x = s && s[k]; return (x && typeof x === 'object') ? Number(x.value) : (typeof x === 'number' ? x : 0); };
    return { kcal: v('calories'), protein: v('protein'), fat: v('fat'), carbs: v('carbs'), veg: v('vitamin'), ca: v('mineral'), salt: v('salt'), fiber: v('fiber'), alc: v('alcohol') };
  };
  const result = [];
  for (const r of rows) {
    const sm = summarize(r.ns);
    if (!sm) continue;
    result.push({ date: (r.ts || '').slice(0, 10), ...sm });
    if (result.length >= 7) break;
  }
  return result;
}

(async () => {
  const db = getDb();
  const post = db.prepare(`SELECT id, author_id, category, content, image_url, created_at FROM plaza_posts WHERE id=?`).get(postId);
  if (!post) { console.error('post not found'); process.exit(1); }
  if (post.category !== '食事') { console.error('not a 食事 post'); process.exit(1); }
  if (!post.image_url) { console.error('no image'); process.exit(1); }
  const imgPath = path.join(__dirname, '..', post.image_url);  // /uploads/... → repo root基準
  if (!fs.existsSync(imgPath)) { console.error('image file missing:', imgPath); process.exit(1); }

  console.log('[reanalyze] post', postId, 'image:', imgPath, 'created_at:', post.created_at);
  const recentMeals = collectRecentMeals(post.author_id, post.created_at);
  console.log('[reanalyze] trend rows:', recentMeals.length);
  recentMeals.forEach(m => console.log('  ', m.date, m.kcal + 'kcal', '塩' + m.salt + 'g', '酒' + m.alc + 'g'));

  const buf = fs.readFileSync(imgPath);
  const mime = imgPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const r = await analyzeFoodImage(buf, mime, post.content || '', recentMeals);

  const cn = typeof r.comment_nutrition === 'string' ? r.comment_nutrition.trim() : '';
  const ch = typeof r.comment_health === 'string' ? r.comment_health.trim() : '';
  let aiComment = null;
  if (cn || ch) {
    const parts = [];
    if (cn) parts.push('【AI栄養アドバイザー】\n' + cn);
    if (ch) parts.push('【AIヘルスアドバイザー】\n' + ch);
    aiComment = parts.join('\n\n').slice(0, 1500);
  } else if (r.comment) {
    aiComment = String(r.comment).slice(0, 1500);
  }

  const NUTRI_KEYS = ['calories','protein','fat','carbs','vitamin','mineral','salt','fiber','alcohol'];
  const scores = {};
  for (const k of NUTRI_KEYS) if (r[k] != null) scores[k] = r[k];
  if (r.has_alcohol != null) scores.has_alcohol = !!r.has_alcohol;
  if (r.confidence != null) scores.confidence = r.confidence;
  const nutritionScores = JSON.stringify(scores);

  console.log('[reanalyze] new comment_len:', aiComment ? aiComment.length : 0);
  console.log('[reanalyze] new scores keys:', Object.keys(scores).join(','));

  db.prepare(`UPDATE plaza_posts SET ai_comment=?, nutrition_scores=? WHERE id=?`).run(aiComment, nutritionScores, postId);
  console.log('[reanalyze] DB updated for post', postId);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
