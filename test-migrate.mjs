import { runMigrations, migrationStatus } from "./db/migrate.js";
import { query } from "./db/pool.js";

const out = [];
const log = () => {};

// Before: the tables the auth layer needs should not exist yet.
let before = "missing";
try { await query("SELECT 1 FROM user_sessions LIMIT 1"); before = "present"; } catch { }
out.push(["user_sessions absent before migrating", before === "missing", before]);

let st = await migrationStatus();
out.push(["status lists the migration as unapplied", st.length === 1 && st[0].applied === false, JSON.stringify(st)]);

// First run
let r = await runMigrations({ log });
out.push(["first run applies it", r.length === 1 && r[0].status === "applied", JSON.stringify(r)]);

// Tables now exist
let ok = true;
for (const t of ["user_sessions", "email_verification_codes"]) {
  try { await query(`SELECT 1 FROM ${t} LIMIT 1`); } catch (e) { ok = false; out.push([`table ${t} created`, false, e.message]); }
}
if (ok) out.push(["both new tables created", true]);

// Added columns exist
try {
  await query("SELECT failed_login_count, locked_until, last_login_at FROM users LIMIT 1");
  out.push(["lockout columns added to users", true]);
} catch (e) { out.push(["lockout columns added to users", false, e.message]); }

// Second run — the important one
r = await runMigrations({ log });
out.push(["second run is a no-op", r.length === 1 && r[0].status === "skipped", JSON.stringify(r)]);

st = await migrationStatus();
out.push(["status now shows applied with a timestamp", st[0].applied === true && !!st[0].appliedAt, JSON.stringify(st)]);

const { rows } = await query("SELECT count(*)::int n FROM schema_migrations");
out.push(["recorded exactly once", rows[0].n === 1, JSON.stringify(rows)]);

let pass = 0, fail = 0;
for (const [l, c, e] of out) { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${e ? ` (${e})` : ""}`); } }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
