/* فحص هوية متزامن يستدعيه guard.mjs في عملية فرعية.
   قراءة فقط: BEGIN READ ONLY ثم ROLLBACK. لا يكتب شيئاً. */
import pg from "pg";

const url = process.env.PROBE_URL;
const marker = process.env.PROBE_MARKER;
const expectSuper = process.env.PROBE_EXPECT_SUPER === "1";

const client = new pg.Client({ connectionString: url, ssl: false, connectionTimeoutMillis: 8000 });
try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const { rows } = await client.query(`
    SELECT current_user AS user, current_database() AS database,
           host(inet_server_addr()) AS addr, inet_server_port() AS port,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
           to_regclass('public.kanaf_test_env_marker') IS NOT NULL AS has_marker`);
  const id = rows[0];
  if (!id.has_marker) throw new Error("لا يوجد جدول kanaf_test_env_marker — ليست قاعدة اختبار معلنة");
  const m = await client.query(`SELECT nonce, purpose FROM kanaf_test_env_marker LIMIT 1`);
  if (!m.rows[0] || m.rows[0].nonce !== marker) throw new Error("nonce العلامة لا يطابق KANAF_TEST_MARKER");
  if (!expectSuper && id.is_super) throw new Error(`الدور ${id.user} superuser — ممنوع لاتصال الاختبار`);
  await client.query("ROLLBACK");
  process.stdout.write(JSON.stringify({ ...id, purpose: m.rows[0].purpose || null }) + "\n");
  await client.end();
  process.exit(0);
} catch (e) {
  process.stderr.write(String(e.message || e) + "\n");
  try { await client.end(); } catch {}
  process.exit(1);
}
