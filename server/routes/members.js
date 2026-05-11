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

    const items = rows.map(r => ({
      id: r.id,
      name: r.display_name,
      company: r.company_code || 'STD',
      group: r.dm_group || '',
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
