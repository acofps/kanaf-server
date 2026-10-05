/* ============================================================
   تمرين خطة النشر والتراجع معزولاً — KANAF-ORD-0002 PKG-D (و CONS-05)
     node test-support/pkgd-drill.mjs <مسار شجرة baseline>
   مثال: git worktree add --detach /tmp/srv-base 22fead5 && (cd /tmp/srv-base && PUPPETEER_SKIP_DOWNLOAD=1 npm install)
         node test-support/pkgd-drill.mjs /tmp/srv-base

   ما يفعله (كله على قاعدة معزولة جديدة من قالب المخطط الأصلي، بلا شبكة خارجية):
     1. الخادم القديم (baseline) يُشغَّل ويطبّق ترحيلاته عبر نقطة النشر نفسها التي على الإنتاج
        (POST /api/setup/run-migrations)، وتُنشأ بيانات بكوده هو: مستخدم بتجزئة bcrypt 5 بكلفة
        الإنتاج (12)، ومسؤول عبر create-first-admin، وتسجيل يومي.
     2. النافذة: الخادم الجديد على المخطط القديم قبل الترحيل — تُسجَّل حالة كل مسار كما هي.
     3. الترحيل عبر نقطة الخادم الجديد (رأس X-Setup-Token، والصيغة القديمة token في الجسم)،
        ونداءان متزامنان ثم نداء ثالث: لا تطبيق مزدوج.
     4. الخادم الجديد بعد الترحيل: دخول المستخدم والمسؤول بتجزئات baseline، ونداءات التطبيق
        القديم (بلا clientRef) والجديد.
     5. التراجع: الخادم القديم على المخطط المرحَّل، والبيانات الجديدة باقية، وتجزئة bcrypt 6
        (كلمة مرور غُيّرت على الجديد) تُقبل في القديم.
     6. العودة للجديد: الترحيل لا يُعاد.
   كل خادم يُشغَّل بـ --require net-local-only.cjs (لا اتصال إلا بـ127.0.0.1).
   النتيجة: test-support/.local/logs/pkgd-drill.json و pkgd-drill.log
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEW_DIR = path.resolve(HERE, "..");
const BASE_DIR = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(BASE_DIR, "index.js"))) { console.error("usage: node test-support/pkgd-drill.mjs <baseline worktree>"); process.exit(2); }
const rev = (d) => execFileSync("git", ["-C", d, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const LOG_DIR = path.join(HERE, ".local", "logs"); fs.mkdirSync(LOG_DIR, { recursive: true });
const lines = []; const say = (s) => { lines.push(s); console.log(s); };
const R = []; const ok = (id, label, cond, x = "") => { R.push({ id, label, pass: !!cond, detail: x }); say(`${cond ? "PASS" : "FAIL"}  ${id} ${label}${!cond && x ? `  (${x})` : ""}`); };
const obs = []; const note = (id, label, value) => { obs.push({ id, label, value }); say(`OBS   ${id} ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`); };

/* ---------- قاعدة معزولة جديدة من قالب «المخطط فقط» ---------- */
const envLines = execFileSync(process.execPath, [path.join(HERE, "create-db.mjs"), "pkgd-drill", "schema"], { encoding: "utf8" });
const DB_URL = /TEST_DATABASE_URL='([^']+)'/.exec(envLines)[1];
const MARKER = /KANAF_TEST_MARKER='([^']+)'/.exec(envLines)[1];
process.env.TEST_DATABASE_URL = DB_URL; process.env.KANAF_TEST_MARKER = MARKER;
await import("./guard.mjs"); // يتحقق أن الهدف قاعدة اختبار معلنة قبل أي كتابة
const { default: pg } = await import("pg");
const db = new pg.Pool({ connectionString: DB_URL, ssl: false, max: 2 });
const q = (sql, p) => db.query(sql, p);

const SECRETS = { SETUP_TOKEN: crypto.randomBytes(24).toString("hex"), USER_JWT_SECRET: crypto.randomBytes(32).toString("hex"), ADMIN_JWT_SECRET: crypto.randomBytes(32).toString("hex") };
const serverEnv = (port) => ({
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", PORT: String(port), DATABASE_URL: DB_URL, DB_SSL: "false",
  ...SECRETS, SKIP_PDF_BOOT_CHECK: "1", ALLOWED_ORIGINS: "http://127.0.0.1:5173",
  SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "",
  PAYMENT_SECRET_KEY: "sk_test_drill_fake", PAYMENT_WEBHOOK_SECRET: "drill-webhook-secret",
  SWEEP_MIN_INTERVAL_MS: "999999999", REMINDER_SWEEP_MIN_INTERVAL_MS: "999999999",
});
async function start(dir, port, tag) {
  const out = fs.openSync(path.join(LOG_DIR, `pkgd-drill.${tag}.server.log`), "a");
  const p = spawn(process.execPath, ["--require", path.join(HERE, "net-local-only.cjs"), "index.js"], { cwd: dir, env: serverEnv(port), stdio: ["ignore", out, out] });
  const B = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(B + "/api/health"); if (r.ok) return { p, B }; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  p.kill(); throw new Error(`${tag} did not start`);
}
const stop = async (s) => { s.p.kill("SIGTERM"); await new Promise((r) => s.p.once("exit", r)); };
async function call(B, method, p, { body, token, cookie, headers = {} } = {}) {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, setCookie: r.headers.getSetCookie?.() || [] };
}
const adminCookie = (res) => res.setCookie.map((c) => c.split(";")[0]).join("; ");
/* تجزئة بكود نسخة معينة وبمكتبتها (bcrypt 5 في baseline، 6 في الجديد) — نفس دالة الإنتاج */
const hashWith = (dir, pw) => execFileSync(process.execPath, ["--input-type=module", "-e",
  `import { hashPassword } from "./auth/tokens.js"; process.stdout.write(await hashPassword(${JSON.stringify(pw)}));`],
  { cwd: dir, env: { PATH: process.env.PATH, USER_JWT_SECRET: "x".repeat(64), DATABASE_URL: DB_URL, DB_SSL: "false" }, encoding: "utf8" });

const USER_EMAIL = "drill-user@kanaf.test", USER_PW = "Drill-Base-Pass-2026!", USER_PW2 = "Drill-New-Pass-2026!";
const ADMIN_EMAIL = "drill-owner@kanaf.test", ADMIN_PW = "Drill-Owner-Long-Pass-2026!";
const PORT_BASE = 3201, PORT_NEW = 3202;
say(`REVISION baseline=${rev(BASE_DIR)} new=${rev(NEW_DIR)} db=${new URL(DB_URL).pathname.slice(1)}`);
let base, nu;
try {
  /* ---------- 1) baseline ---------- */
  base = await start(BASE_DIR, PORT_BASE, "base1");
  let r = await call(base.B, "POST", "/api/setup/run-migrations", { body: { token: SECRETS.SETUP_TOKEN } });
  ok("B1", "baseline applies its own migrations through the production endpoint (body token)", r.status === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 200));
  note("B1a", "baseline migrations applied", (r.body.results || []).map((x) => `${x.file || x.filename}:${x.status}`));
  r = await call(base.B, "POST", "/api/setup/create-first-admin", { body: { token: SECRETS.SETUP_TOKEN, name: "مالك التمرين", email: ADMIN_EMAIL, password: ADMIN_PW } });
  ok("B2", "first admin created by baseline code (its bcrypt 5 hash)", r.status === 200 || r.status === 201, JSON.stringify(r.body).slice(0, 160));
  const baseHash = hashWith(BASE_DIR, USER_PW);
  ok("B3", "user hash made by baseline hashPassword is bcrypt cost 12", /^\$2[aby]\$12\$/.test(baseHash), baseHash.slice(0, 7));
  const { rows: [u] } = await q(`INSERT INTO users (name, email, password_hash, confirmed_adult, agreed_policy_at, email_verified_at) VALUES ('مستخدم التمرين', $1, $2, true, now(), now()) RETURNING id`, [USER_EMAIL, baseHash]);
  r = await call(base.B, "POST", "/api/auth/login", { body: { email: USER_EMAIL, password: USER_PW } });
  const baseToken = r.body.accessToken;
  ok("B4", "user logs in on baseline", r.status === 200 && !!baseToken, String(r.status));
  r = await call(base.B, "POST", "/api/me/logs", { token: baseToken, body: { mood: 6, sleep: 6, energy: 6, note: "قبل الترقية", tags: [], loggedOn: "2026-10-01" } });
  ok("B5", "baseline writes a daily log", r.status === 200 || r.status === 201, String(r.status));
  await stop(base); base = null;

  /* ---------- 2) النافذة: الخادم الجديد على المخطط القديم ---------- */
  nu = await start(NEW_DIR, PORT_NEW, "new-window");
  const win = {};
  r = await call(nu.B, "GET", "/api/setup/migration-status", { headers: { "X-Setup-Token": SECRETS.SETUP_TOKEN } });
  win.migration_status = `${r.status} pending=${(r.body.migrations || []).filter((m) => !m.applied).map((m) => m.file || m.filename).join(",")}`;
  r = await call(nu.B, "POST", "/api/auth/login", { body: { email: USER_EMAIL, password: USER_PW } });
  win.user_login = r.status; const winToken = r.body.accessToken;
  if (winToken) {
    win.logs_get = (await call(nu.B, "GET", "/api/me/logs?days=30", { token: winToken })).status;
    win.logs_post = (await call(nu.B, "POST", "/api/me/logs", { token: winToken, body: { mood: 5, sleep: 5, energy: 5, note: "", tags: [], loggedOn: "2026-10-02" } })).status;
    win.safety_plan_get = (await call(nu.B, "GET", "/api/me/safety-plan", { token: winToken })).status;
    win.screening_with_clientRef = (await call(nu.B, "POST", "/api/me/screenings", { token: winToken, body: { kind: "gad7", total: 3, bandLabel: "طفيف", answers: {}, clientRef: crypto.randomUUID() } })).status;
    win.screening_without_clientRef = (await call(nu.B, "POST", "/api/me/screenings", { token: winToken, body: { kind: "gad7", total: 3, bandLabel: "طفيف", answers: {} } })).status;
    win.assistant_policy = (await call(nu.B, "POST", "/api/chat", { token: winToken, body: { messages: [{ role: "user", content: "مرحبا" }] } })).status;
  }
  r = await call(nu.B, "POST", "/admin/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PW } });
  win.admin_login = r.status;
  note("W1", "new code on the OLD schema before migrating (status per route)", win);
  ok("W2", "the server itself stays up in the window (health 200) so the migration endpoint is reachable", (await fetch(nu.B + "/api/health")).ok);

  /* ---------- 3) الترحيل عبر الخادم الجديد ---------- */
  const [m1, m2] = await Promise.all([1, 2].map(() => call(nu.B, "POST", "/api/setup/run-migrations", { headers: { "X-Setup-Token": SECRETS.SETUP_TOKEN } })));
  const applied = [...(m1.body.results || []), ...(m2.body.results || [])].filter((x) => x.status === "applied").map((x) => x.file || x.filename);
  note("M0", "two concurrent run-migrations calls", { first: m1.status, second: m2.status, applied });
  ok("M1", "each new migration applied exactly once across two concurrent calls", applied.length === new Set(applied).size && applied.length >= 4, JSON.stringify(applied));
  ok("M1b", "both concurrent calls answer 200 (the second waits on the lock, then finds everything applied)", m1.status === 200 && m2.status === 200, `${m1.status} ${m2.status}`);
  r = await call(nu.B, "POST", "/api/setup/run-migrations", { body: { token: SECRETS.SETUP_TOKEN } });
  ok("M2", "a third call (old body-token form) is a no-op (all skipped)", r.status === 200 && (r.body.results || []).every((x) => x.status === "skipped"), JSON.stringify(r.body).slice(0, 160));
  const { rows: sm } = await q(`SELECT filename, count(*)::int n FROM schema_migrations GROUP BY 1 HAVING count(*) > 1`);
  ok("M3", "schema_migrations has no duplicate rows", sm.length === 0, JSON.stringify(sm));
  r = await call(nu.B, "POST", "/api/setup/run-migrations", { headers: { "X-Setup-Token": "wrong" } });
  ok("M4", "wrong setup token refused (403)", r.status === 403);

  /* ---------- 4) الخادم الجديد بعد الترحيل ---------- */
  r = await call(nu.B, "POST", "/api/auth/login", { body: { email: USER_EMAIL, password: USER_PW } });
  const newToken = r.body.accessToken;
  ok("N1", "CONS-05: the baseline bcrypt 5 (cost 12) user hash is accepted by the new code (bcrypt 6)", r.status === 200 && !!newToken, String(r.status));
  r = await call(nu.B, "POST", "/admin/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PW } });
  const ck = adminCookie(r);
  ok("N2", "CONS-05: the admin created by baseline logs in on the new code", r.status === 200 && /kanaf_admin_access=/.test(ck), String(r.status));
  ok("N3", "admin API works after upgrade (GET /admin/users)", (await call(nu.B, "GET", "/admin/users", { cookie: ck })).status === 200);
  const logs = (await call(nu.B, "GET", "/api/me/logs?days=400", { token: newToken })).body.logs || [];
  ok("N4", "data written by baseline is readable on the new code", logs.some((l) => l.note === "قبل الترقية"));
  ok("N5", "old app calls (no clientRef) still accepted", (await call(nu.B, "POST", "/api/me/screenings", { token: newToken, body: { kind: "phq9", total: 2, bandLabel: "طفيف", answers: {} } })).status === 201);
  const ref = crypto.randomUUID();
  const s1 = await call(nu.B, "POST", "/api/me/screenings", { token: newToken, body: { kind: "phq9", total: 2, bandLabel: "طفيف", answers: {}, clientRef: ref } });
  const s2 = await call(nu.B, "POST", "/api/me/screenings", { token: newToken, body: { kind: "phq9", total: 2, bandLabel: "طفيف", answers: {}, clientRef: ref } });
  ok("N6", "new app calls (clientRef) dedupe after the upgrade", s1.status === 201 && s2.status === 200 && s1.body.id === s2.body.id);
  ok("N7", "safety plan route (migration 011) works", (await call(nu.B, "PUT", "/api/me/safety-plan", { token: newToken, body: { warningSigns: "", copingStrategies: "أتمشى", safePlace: "", baseVersion: null } })).status === 200);
  r = await call(nu.B, "POST", "/api/auth/change-password", { token: newToken, body: { currentPassword: USER_PW, newPassword: USER_PW2 } });
  ok("N8", "CONS-05: password change on the new code (new bcrypt 6 hash at cost 12)", r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  const { rows: [h2] } = await q(`SELECT password_hash FROM users WHERE id = $1`, [u.id]);
  ok("N9", "the new hash is cost 12", /^\$2[aby]\$12\$/.test(h2.password_hash), h2.password_hash.slice(0, 7));
  await stop(nu); nu = null;

  /* ---------- 5) التراجع: الكود القديم على المخطط المرحَّل ---------- */
  base = await start(BASE_DIR, PORT_BASE, "base-rollback");
  r = await call(base.B, "POST", "/api/auth/login", { body: { email: USER_EMAIL, password: USER_PW2 } });
  const rbToken = r.body.accessToken;
  ok("T1", "rollback: baseline (bcrypt 5) accepts the password hash written by the new code (bcrypt 6)", r.status === 200 && !!rbToken, String(r.status));
  ok("T2", "rollback: baseline reads logs on the migrated schema", (await call(base.B, "GET", "/api/me/logs?days=400", { token: rbToken })).status === 200);
  ok("T3", "rollback: baseline writes a daily log on the migrated schema", [200, 201].includes((await call(base.B, "POST", "/api/me/logs", { token: rbToken, body: { mood: 7, sleep: 7, energy: 7, note: "بعد التراجع", tags: [], loggedOn: "2026-10-03" } })).status));
  r = await call(base.B, "POST", "/admin/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PW } });
  ok("T4", "rollback: admin login and user list on baseline", r.status === 200 && (await call(base.B, "GET", "/admin/users", { cookie: adminCookie(r) })).status === 200, String(r.status));
  const rows = (await q(`SELECT (SELECT count(*)::int FROM user_write_receipts) receipts, (SELECT count(*)::int FROM user_safety_plans) plans, (SELECT count(*)::int FROM schema_migrations) migs`)).rows[0];
  ok("T5", "rollback deletes nothing: receipts and safety plan from the new code remain", rows.receipts >= 1 && rows.plans >= 1, JSON.stringify(rows));
  r = await call(base.B, "POST", "/api/setup/run-migrations", { body: { token: SECRETS.SETUP_TOKEN } });
  const migsAfter = (await q(`SELECT count(*)::int n FROM schema_migrations`)).rows[0].n;
  ok("T6", "baseline's migration endpoint on the migrated schema is a no-op (no reverse migration, nothing re-applied)", r.status === 200 && (r.body.results || []).every((x) => x.status === "skipped") && migsAfter === rows.migs, JSON.stringify(r.body).slice(0, 160));
  await stop(base); base = null;

  /* ---------- 6) العودة إلى الجديد ---------- */
  nu = await start(NEW_DIR, PORT_NEW, "new-again");
  r = await call(nu.B, "POST", "/api/setup/run-migrations", { headers: { "X-Setup-Token": SECRETS.SETUP_TOKEN } });
  ok("F1", "roll forward again: nothing re-applied", r.status === 200 && (r.body.results || []).every((x) => x.status === "skipped"));
  r = await call(nu.B, "POST", "/api/auth/login", { body: { email: USER_EMAIL, password: USER_PW2 } });
  const ft = r.body.accessToken;
  const l2 = (await call(nu.B, "GET", "/api/me/logs?days=400", { token: ft })).body.logs || [];
  ok("F2", "roll forward: data from baseline, new code and the rollback period all present", ["قبل الترقية", "بعد التراجع"].every((n) => l2.some((l) => l.note === n)), JSON.stringify(l2.map((l) => l.note)));
} catch (e) { ok("!!", "stopped", false, String(e.stack || e).slice(0, 400)); }
finally {
  for (const s of [base, nu]) if (s) await stop(s).catch(() => {});
  await db.end().catch(() => {});
}
const f = R.filter((r) => !r.pass).length;
say(`\n${R.length - f}/${R.length} passed`);
fs.writeFileSync(path.join(LOG_DIR, "pkgd-drill.json"), JSON.stringify({ at: new Date().toISOString(), node: process.version, baseline: rev(BASE_DIR), new: rev(NEW_DIR), results: R, observations: obs }, null, 2));
fs.writeFileSync(path.join(LOG_DIR, "pkgd-drill.log"), lines.join("\n") + "\n");
process.exit(f ? 1 : 0);
