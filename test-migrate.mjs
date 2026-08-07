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

let pass = 0, fail = 0;
for (const [l, c, e] of out) { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${e ? ` (${e})` : ""}`); } }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
