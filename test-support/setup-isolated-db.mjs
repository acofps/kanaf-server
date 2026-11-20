/* ============================================================
   تجهيز قاعدة اختبار معزولة تحاكي قيد الملكية في الإنتاج
   KANAF-ORD-0001 / G1 / R15-05

   الاستعمال (على عنقود PostgreSQL محلي مخصّص للاختبار فقط):
     SUPERUSER_URL=postgresql://kanaf_su_sim@127.0.0.1:55432/postgres \
       node test-support/setup-isolated-db.mjs

   ما يفعله:
     • يرفض أي مضيف غير loopback/مقبس محلي، ويرفض عنقوداً فيه قواعد
       غير قواعد الاختبار (العنقود يجب أن يكون مخصّصاً).
     • ينشئ دور تشغيل kanaf_runtime_test بلا superuser ولا عضوية في
       مالك الجداول — يحاكي kanaf_adel.
     • kanaf_tpl_schema: يطبّق db/schema.sql بالمستخدم الفائق (يحاكي
       postgres مالك الجداول الأصلية الخمسة عشر)، ويمنح دور التشغيل
       ما توثّقه الترحيلات 002/004/007 فقط: SELECT/INSERT/UPDATE/DELETE
       على كل الجداول، REFERENCES على users وحده، USAGE+CREATE على
       المخطط. لا ملكية، لا TRUNCATE، لا USAGE على تسلسلات zatca_*.
     • kanaf_tpl_migrated: نسخة منه تُطبَّق عليها الترحيلات بدور
       التشغيل (لا بالفائق) عبر db/migrate.js الحقيقي خلف الحارس.
     • جدول kanaf_test_env_marker (يملكه الفائق، قراءة فقط لدور
       التشغيل) فيه nonce عشوائي — علامة البيئة التي يشترطها الحارس.
     • يكتب test-support/.local/test-env.json (مستثنى من git): عناوين
       الاتصال المحلية وكلمة مرور دور التشغيل الاصطناعية والـnonce.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LOCAL = path.join(HERE, ".local");
const RUNTIME_ROLE = "kanaf_runtime_test";
const TEMPLATES = ["kanaf_tpl_schema", "kanaf_tpl_migrated"];
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function fail(msg) { console.error(`setup-isolated-db: ${msg}`); process.exit(2); }

const SU = process.env.SUPERUSER_URL;
if (!SU) fail("SUPERUSER_URL مطلوب");
const su = new URL(SU);
const suHost = su.searchParams.get("host") || su.hostname;
if (!suHost.startsWith("/") && !LOOPBACK.has(suHost)) fail(`المضيف ${suHost} ليس loopback`);

const withDb = (db) => { const u = new URL(SU); u.pathname = `/${db}`; return u.toString(); };
async function connect(db) { const c = new pg.Client({ connectionString: withDb(db), ssl: false }); await c.connect(); return c; }

const admin = await connect(su.pathname.replace(/^\//, "") || "postgres");
const { rows: [me] } = await admin.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`);
if (!me?.rolsuper) fail("SUPERUSER_URL ليس superuser");

const { rows: dbs } = await admin.query(`SELECT datname FROM pg_database WHERE NOT datistemplate OR datname LIKE 'kanaf_tpl_%'`);
const foreign = dbs.map((d) => d.datname).filter((n) => !["postgres", ...TEMPLATES].includes(n) && !n.startsWith("kanaf_t_"));
if (foreign.length) fail(`العنقود غير مخصّص للاختبار؛ فيه قواعد أخرى: ${foreign.join(", ")}`);

const nonce = crypto.randomBytes(24).toString("hex");
const runtimePass = crypto.randomBytes(18).toString("hex");

const { rows: roleRows } = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [RUNTIME_ROLE]);
if (roleRows.length) await admin.query(`ALTER ROLE ${RUNTIME_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${runtimePass}'`);
else await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${runtimePass}'`);

for (const t of [...TEMPLATES].reverse()) {
  await admin.query(`UPDATE pg_database SET datistemplate = false WHERE datname = $1`, [t]).catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${t} WITH (FORCE)`);
}
await admin.query(`CREATE DATABASE kanaf_tpl_schema`);

/* ---- المخطط الأصلي بالمستخدم الفائق ---- */
const sdb = await connect("kanaf_tpl_schema");
await sdb.query(fs.readFileSync(path.join(ROOT, "db/schema.sql"), "utf8"));
await sdb.query(`
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  GRANT USAGE, CREATE ON SCHEMA public TO ${RUNTIME_ROLE};
  GRANT CONNECT ON DATABASE kanaf_tpl_schema TO ${RUNTIME_ROLE};
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE};
  GRANT REFERENCES ON users TO ${RUNTIME_ROLE};
  CREATE TABLE kanaf_test_env_marker (nonce TEXT NOT NULL, purpose TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  REVOKE ALL ON kanaf_test_env_marker FROM ${RUNTIME_ROLE};
  GRANT SELECT ON kanaf_test_env_marker TO ${RUNTIME_ROLE};
`);
await sdb.query(`INSERT INTO kanaf_test_env_marker (nonce, purpose) VALUES ($1, 'template:schema')`, [nonce]);
const { rows: owners } = await sdb.query(`SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND tableowner = current_user AND tablename <> 'kanaf_test_env_marker'`);
await sdb.end();

/* ---- الترحيلات بدور التشغيل ---- */
await admin.query(`CREATE DATABASE kanaf_tpl_migrated TEMPLATE kanaf_tpl_schema`);
await admin.query(`GRANT CONNECT ON DATABASE kanaf_tpl_migrated TO ${RUNTIME_ROLE}`);
const mdb = await connect("kanaf_tpl_migrated");
await mdb.query(`UPDATE kanaf_test_env_marker SET purpose = 'template:migrated'`);
await mdb.end();

const runtimeUrl = (db) => {
  const u = new URL(withDb(db)); u.username = RUNTIME_ROLE; u.password = runtimePass; return u.toString();
};
fs.mkdirSync(LOCAL, { recursive: true });
const envFile = path.join(LOCAL, "test-env.json");
fs.writeFileSync(envFile, JSON.stringify({
  superuserUrl: SU, runtimeRole: RUNTIME_ROLE, runtimePassword: runtimePass, marker: nonce,
  createdAt: new Date().toISOString(),
}, null, 2), { mode: 0o600 });

let migrateOut;
try {
  migrateOut = execFileSync(process.execPath, [path.join(HERE, "migrate-isolated.mjs")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TEST_DATABASE_URL: runtimeUrl("kanaf_tpl_migrated"), KANAF_TEST_MARKER: nonce },
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
} catch (e) { console.log(e.stdout); fail("تطبيق الترحيلات بدور التشغيل فشل — انظر أعلاه"); }
console.log(migrateOut.trim());

const m2 = await connect("kanaf_tpl_migrated");
const { rows: tbl } = await m2.query(`SELECT tableowner, count(*)::int n FROM pg_tables WHERE schemaname='public' GROUP BY 1 ORDER BY 1`);
const { rows: seqs } = await m2.query(`SELECT sequenceowner, string_agg(sequencename, ',' ORDER BY sequencename) s FROM pg_sequences WHERE schemaname='public' GROUP BY 1`);
const { rows: applied } = await m2.query(`SELECT filename FROM schema_migrations ORDER BY applied_at, filename`);
await m2.end();
await admin.end();

console.log(JSON.stringify({ originalTablesOwnedBySuperuser: owners[0].n, tablesByOwner: tbl, sequencesByOwner: seqs,
  appliedOrder: applied.map((r) => r.filename), envFile }, null, 2));
