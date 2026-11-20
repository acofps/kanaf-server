/* ============================================================
   R15-16 — يطبّق db/owner-actions/R15-16_audit_log_hardening.sql على
   قاعدة معزولة جديدة (بالمستخدم الفائق، كما سيفعل مالك القاعدة)،
   ثم يثبت بدور التشغيل:
     • لا UPDATE / DELETE / TRUNCATE / ALTER / DROP / GRANT على السجلات الثلاثة،
     • ولا تصعيد دور (SET ROLE / CREATE ROLE)،
     • و INSERT/SELECT ما زالا يعملان، ومسار إداري حقيقي يكتب سطر تدقيق،
     • وملف التراجع يعيد الحال.
     node test-support/audit-hardening-check.mjs
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, ".local", "test-env.json"), "utf8"));
const DB = "kanaf_t_audit_hardening";
const u = (db, su) => { const x = new URL(cfg.superuserUrl); x.pathname = `/${db}`; if (!su) { x.username = cfg.runtimeRole; x.password = cfg.runtimePassword; } return x.toString(); };
async function q(db, su, sql, p) { const c = new pg.Client({ connectionString: u(db, su), ssl: false }); await c.connect(); try { return await c.query(sql, p); } finally { await c.end(); } }
const psql = (file) => execFileSync("psql", ["-v", `app_role=${cfg.runtimeRole}`, "-f", file, u(DB, true)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const R = []; const ok = (l, c, x = "") => { R.push([l, !!c]); console.log(`${c ? "PASS" : "FAIL"}  ${l}${!c && x ? `  (${x})` : ""}`); };
async function denied(sql) { try { await q(DB, false, sql); return "allowed"; } catch (e) { return /permission denied|must be owner|must be member/.test(e.message) ? "denied" : e.message; } }

await q("postgres", true, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await q("postgres", true, `CREATE DATABASE ${DB} TEMPLATE kanaf_tpl_migrated`);
const { rows: [adm] } = await q(DB, true, `INSERT INTO admin_users (name,email,password_hash,role) VALUES ('م','o@h.test','x','owner') RETURNING id`);
const { rows: [usr] } = await q(DB, true, `INSERT INTO users (name,email,password_hash) VALUES ('م','u@h.test','x') RETURNING id`);
await q(DB, true, `INSERT INTO admin_action_log (admin_user_id, action, entity_type, entity_id, reason) VALUES ($1,'seed','user',$2,'seed')`, [adm.id, usr.id]).catch(async () =>
  q(DB, true, `INSERT INTO admin_action_log (admin_user_id, target_user_id, action, reason) VALUES ($1,$2,'seed','seed')`, [adm.id, usr.id]));

ok("B0 before hardening: runtime CAN delete audit rows (the reported defect)", (await denied(`DELETE FROM admin_action_log WHERE false`)) === "allowed");
psql(path.resolve(HERE, "../db/owner-actions/R15-16_audit_log_hardening.sql"));
for (const t of ["admin_action_log", "admin_access_log", "content_versions"]) {
  ok(`H ${t}: UPDATE denied`, (await denied(`UPDATE ${t} SET created_at = created_at WHERE true`)) === "denied");
  ok(`H ${t}: DELETE denied`, (await denied(`DELETE FROM ${t}`)) === "denied");
  ok(`H ${t}: TRUNCATE denied`, (await denied(`TRUNCATE ${t}`)) === "denied");
  ok(`H ${t}: ALTER denied`, (await denied(`ALTER TABLE ${t} ADD COLUMN x int`)) === "denied");
  ok(`H ${t}: DROP denied`, (await denied(`DROP TABLE ${t}`)) === "denied");
  await denied(`GRANT UPDATE, DELETE ON ${t} TO ${cfg.runtimeRole}`); // PostgreSQL: تحذير «no privileges were granted» لا خطأ
  ok(`H ${t}: self-GRANT has no effect (UPDATE still denied after it)`, (await denied(`UPDATE ${t} SET created_at = created_at WHERE true`)) === "denied");
  ok(`H ${t}: SELECT still allowed`, (await denied(`SELECT 1 FROM ${t} LIMIT 1`)) === "allowed");
}
ok("E runtime cannot SET ROLE kanaf_audit_owner", (await denied(`SET ROLE kanaf_audit_owner`)) !== "allowed");
ok("E runtime cannot CREATE ROLE", (await denied(`CREATE ROLE x_escalate`)) !== "allowed");
ok("I INSERT into admin_action_log still allowed", (await denied(`INSERT INTO admin_action_log (admin_user_id, target_user_id, action, reason) SELECT admin_user_id, target_user_id, 'probe', 'probe' FROM admin_action_log LIMIT 1`)) === "allowed");
ok("I INSERT into admin_access_log still allowed", (await denied(`INSERT INTO admin_access_log (admin_user_id, target_user_id, action, reason) VALUES ('${adm.id}','${usr.id}','probe','probe')`)) === "allowed");

/* مسار إداري حقيقي على القاعدة المقوّاة: تعليق حساب يكتب سطر تدقيق */
await q(DB, true, `UPDATE kanaf_test_env_marker SET purpose = 'audit-flow-probe.mjs'`);
const probe = path.join(HERE, ".local", "audit-flow-probe.mjs");
fs.writeFileSync(probe, `import "../guard.mjs";
import express from "express"; import cookieParser from "cookie-parser"; import jwt from "jsonwebtoken";
const { adminRouter } = await import("../../admin/routes.js"); const { query, pool } = await import("../../db/pool.js");
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/admin", adminRouter);
const srv = app.listen(4633);
const c = "kanaf_admin_access=" + jwt.sign({ sub: "${adm.id}", role: "owner", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "5m" });
const r = await fetch("http://127.0.0.1:4633/admin/users/${usr.id}/suspend", { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify({ reason: "تحقق من سجل التدقيق" }) });
const { rows } = await query("SELECT count(*)::int n FROM admin_action_log WHERE action = 'suspend_account'");
console.log(JSON.stringify({ status: r.status, rows: rows[0].n })); srv.close(); await pool.end();\n`);
const out = execFileSync(process.execPath, [probe], { cwd: path.resolve(HERE, ".."), encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME,
  TEST_DATABASE_URL: u(DB, false), KANAF_TEST_MARKER: cfg.marker, USER_JWT_SECRET: "u".repeat(40), ADMIN_JWT_SECRET: "a".repeat(40), KANAF_TEST_GUARD_QUIET: "1" } });
const res = JSON.parse(out.trim().split("\n").pop());
ok("F real admin action (suspend) still succeeds and writes its audit row on the hardened DB", res.status === 200 && res.rows === 1, JSON.stringify(res));

psql(path.resolve(HERE, "../db/owner-actions/R15-16_audit_log_hardening_ROLLBACK.sql"));
ok("R rollback restores the previous behaviour", (await denied(`DELETE FROM admin_action_log WHERE false`)) === "allowed");
await q("postgres", true, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
const f = R.filter((r) => !r[1]).length; console.log(`\n${R.length - f}/${R.length} passed`); process.exit(f ? 1 : 0);
