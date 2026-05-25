const Database = require("better-sqlite3");
const db = new Database("/opt/cohub/server/db/cohub.db", { readonly: true });
const CW_CAT_NORMALIZE = `CASE
    WHEN cp.category LIKE '%食事%' OR cp.category LIKE '%栄養%' THEN '食事'
    WHEN cp.category LIKE '%相談%' OR cp.category LIKE '%提案%' THEN '相談'
    ELSE '雑談'
  END`;
const sql = `SELECT ${CW_CAT_NORMALIZE} AS category, COUNT(*) c FROM cw_posts cp WHERE ${CW_CAT_NORMALIZE} = ? GROUP BY category`;
const rows = db.prepare(sql).all("食事");
console.log("rows:", rows);
