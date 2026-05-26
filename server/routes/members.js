const express = require('express');
const router = express.Router();
const { getDb } = require('../services/db');
const { authUser } = require('../middleware/auth');

// GET /api/members - 全社員一覧 (閲覧専用、認証必要)
router.get('/', authUser, (req, res) => {
  try {
    // ニックネームは匿名投稿のアイデンティティとして使われるため、
    // メンバーディレクトリでは返さない (実名とニックネームを紐付けさせない)
    const rows = getDb().prepare(`
      SELECT
        id,
        display_name,
        company_code,
        dm_group,
        dm_rank,
        avatar_url,
        employee_type,
        role,
        is_field_promoter,
        last_seen_at
      FROM users
      WHERE COALESCE(status, 'active') NOT IN ('deleted', 'archived')
        AND COALESCE(role, '') <> 'bot'
        AND COALESCE(employee_type, '') <> 'bot'
        AND id NOT LIKE 'bot_%'
      ORDER BY
        CASE WHEN dm_group IS NULL OR dm_group = '' THEN 1 ELSE 0 END,
        dm_group COLLATE NOCASE,
        COALESCE(dm_rank, 0) DESC,
        display_name COLLATE NOCASE
    `).all();

    // 兼務: 機能/部署グループ(事業本部・管理職・経営管理部・管理部)への所属。
    // 支店GCは主所属(dm_group)扱いなので兼務には含めない。主所属と同名のものは除外。
    const KENMU_GROUPS = ['g_jigyo_honbu', '286a21e1-5555-4c78-a3de-c3bcbaa6f53b', 'g_keieikanri', 'g_kanribu'];
    const kenmuMap = {};
    try {
      const ph = KENMU_GROUPS.map(() => '?').join(',');
      const kr = getDb().prepare(
        `SELECT m.user_id AS uid, g.name AS gname
         FROM chat_group_members m JOIN chat_groups g ON g.id = m.group_id
         WHERE m.group_id IN (${ph})`).all(...KENMU_GROUPS);
      for (const r of kr) (kenmuMap[r.uid] = kenmuMap[r.uid] || []).push(r.gname);
    } catch (e) {}
    const stripIcon = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();

    const items = rows.map(r => ({
      id: r.id,
      name: r.display_name,
      company: r.company_code || 'STD',
      group: r.dm_group || '',
      // 兼務(主所属を除く機能/部署グループ。先頭の絵文字は除去して表示用に)
      concurrent: (kenmuMap[r.id] || [])
        .filter(n => n !== (r.dm_group || ''))
        .map(stripIcon)
        .filter(Boolean),
      rank: r.dm_rank | 0,
      avatar: r.avatar_url || '',
      type: r.employee_type || 'office',
      promoter: !!r.is_field_promoter,
      role: r.role || 'member',
    }));

    res.json({ success: true, total: items.length, items });
  } catch (e) {
    console.error('[members] list error:', e);
    res.status(500).json({ success: false, msg: 'メンバー一覧取得失敗' });
  }
});

module.exports = router;
