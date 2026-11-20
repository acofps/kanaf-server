/* ============================================================
   كتابة fixture في قاعدة اختبار E2E — عبر الحارس نفسه (ORD-0003 ACC-03/12)
     node test-support/fixture-sql.mjs "<SQL>"
   يتطلب TEST_DATABASE_URL و KANAF_TEST_MARKER كما يطبعهما create-db.mjs.
   الحارس يُستورد أولاً: يرفض أي هدف غير قاعدة اختبار معلنة (مضيف، دور، علامة، nonce)
   قبل أي اتصال كاتب. يطبع عدد الصفوف المتأثرة؛ يخرج بغير صفر عند أي خطأ.
   ============================================================ */
import "./guard.mjs";
const sql = process.argv[2];
if (!sql) { console.error("SQL مطلوب"); process.exit(2); }
const { query, pool } = await import("../db/pool.js");
try {
  const r = await query(sql);
  console.log(`fixture-sql: ${r.command} ${r.rowCount ?? 0}`);
} catch (e) {
  console.error(`fixture-sql failed: ${e.message}`);
  process.exitCode = 1;
} finally { await pool.end().catch(() => {}); }
