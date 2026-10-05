/* يطبّق الترحيلات الحقيقية (db/migrate.js) على قاعدة الاختبار المعزولة
   فقط — الحارس أول استيراد، فلا يصل إلى أي قاعدة لم تُعلَن. */
import "./guard.mjs";
const { runMigrations } = await import("../db/migrate.js");
const { pool } = await import("../db/pool.js");
const results = await runMigrations({ log: () => {} });
for (const r of results) console.log(`${r.status.padEnd(8)} ${r.filename}${r.error ? `  — ${r.error}` : ""}`);
await pool.end();
process.exit(results.some((r) => r.status === "failed") ? 1 : 0);
