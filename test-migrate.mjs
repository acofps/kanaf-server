import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
// يطبّق الترحيلات (DDL) ويفترض قاعدة بلا ترحيلات — قالب المخطط الأصلي فقط.
requireDedicatedDatabase(import.meta.url);
import { runMigrations, migrationStatus } from "./db/migrate.js";
import { query } from "./db/pool.js";

const out = [];
const log = () => {};

// Before: the tables the auth layer needs should not exist yet.
let before = "missing";
try { await query("SELECT 1 FROM user_sessions LIMIT 1"); before = "present"; } catch { }
out.push(["user_sessions absent before migrating", before === "missing", before]);

let st = await migrationStatus();
out.push(["status lists all migrations as unapplied", st.length >= 1 && st.every(m => m.applied === false), JSON.stringify(st)]);

// First run
let r = await runMigrations({ log });
out.push(["first run applies every pending migration", r.length >= 1 && r.every(m => m.status === "applied"), JSON.stringify(r)]);

// Tables now exist
let ok = true;
for (const t of ["user_sessions", "email_verification_codes"]) {
  try { await query(`SELECT 1 FROM ${t} LIMIT 1`); } catch (e) { ok = false; out.push([`table ${t} created`, false, e.message]); }
}
if (ok) out.push(["both new tables created", true]);

// Lockout state lives in its own table now, because the app's DB user
// cannot ALTER the postgres-owned users table.
try {
  await query("SELECT user_id, failed_login_count, locked_until, last_login_at FROM user_auth_state LIMIT 1");
  out.push(["user_auth_state created with the lockout fields", true]);
} catch (e) { out.push(["user_auth_state created with the lockout fields", false, e.message]); }

// And must NOT have been added to users — that statement is what
// failed in production.
try {
  await query("SELECT failed_login_count FROM users LIMIT 1");
  out.push(["users table left untouched", false, "column was added to users"]);
} catch { out.push(["users table left untouched", true]); }

try {
  await query("SELECT admin_user_id, old_value, new_value FROM admin_action_log LIMIT 1");
  out.push(["003 created admin_action_log", true]);
} catch (e) { out.push(["003 created admin_action_log", false, e.message]); }

try {
  await query("SELECT suspended_at, suspended_reason FROM user_auth_state LIMIT 1");
  out.push(["003 added suspension columns to user_auth_state", true]);
} catch (e) { out.push(["003 added suspension columns to user_auth_state", false, e.message]); }

// Second run — the important one
r = await runMigrations({ log });
out.push(["second run is a no-op", r.length >= 1 && r.every(m => m.status === "skipped"), JSON.stringify(r)]);

st = await migrationStatus();
out.push(["status now shows applied with timestamps", st.every(m => m.applied === true && !!m.appliedAt), JSON.stringify(st)]);

const { rows } = await query("SELECT count(*)::int n FROM schema_migrations");
out.push(["each migration recorded exactly once", rows[0].n === st.length, JSON.stringify(rows)]);

/* KANAF-ORD-0012 §2.4 — قفل الترحيل لا يبقى معلّقاً على اتصال في المجمّع.
   يُفحص من جلسة مستقلة: إن أمسك اتصالٌ في المجمّع القفل، فشلت pg_try_advisory_lock هنا. */
const { default: pg } = await import("pg");
const { pool } = await import("./db/pool.js");
async function lockFreeFromOutside() {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  await c.connect();
  try {
    const { rows: [x] } = await c.query(`SELECT pg_try_advisory_lock(hashtext('kanaf_schema_migrations')) AS got`);
    if (x.got) await c.query(`SELECT pg_advisory_unlock(hashtext('kanaf_schema_migrations'))`);
    return x.got;
  } finally { await c.end(); }
}
out.push(["advisory lock released after a normal run", await lockFreeFromOutside()]);
// فشل الإطلاق مُفتعَل: اتصال القفل يرفض جملة الإطلاق وحدها
const realConnect = pool.connect.bind(pool);
const quiet = console.error; console.error = () => {};
pool.connect = (...a) => {
  if (typeof a[0] === "function") return realConnect(...a); // pool.query الداخلي: يمرّ كما هو
  return realConnect().then((c) => wrapLockClient(c));
};
function wrapLockClient(c) {
  if (!c.__wrapped) {
    const q = c.query.bind(c);
    c.query = (sql, ...rest) => (typeof sql === "string" && /pg_advisory_unlock/.test(sql) ? Promise.reject(new Error("simulated unlock failure")) : q(sql, ...rest));
    c.__wrapped = true;
  }
  return c;
}
let simulated;
try { simulated = await runMigrations({ log }); } finally { pool.connect = realConnect; console.error = quiet; }
out.push(["unlock failure: run still answers (all skipped)", simulated.every((m) => m.status === "skipped"), JSON.stringify(simulated.slice(0, 2))]);
out.push(["unlock failure: the locked connection is discarded, so the lock is not left on a pooled connection", await lockFreeFromOutside()]);
r = await runMigrations({ log });
out.push(["unlock failure: the next run-migrations is not blocked", r.every((m) => m.status === "skipped")]);

let pass = 0, fail = 0;
for (const [l, c, e] of out) { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${e ? ` (${e})` : ""}`); } }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
