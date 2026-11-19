/* ============================================================
   تمرين الترحيل على مرحلتين معزولاً — KANAF-ORD-0003 N-03
     node test-support/n03-drill.mjs <baseline 22fead5> <prep commit> <candidate>
   كل وسيط مجلد بناء نظيف (git clone + npm install/ci) — انظر logs/ord0003/N-03-clean-build.txt.

   الفكرة: بدل نافذة يعمل فيها الكود الجديد على مخطط قديم (PKG-D: دخول الإدارة وخطة الأمان ترد 500
   حتى يُشغَّل الترحيل)، يُنشر أولاً commit تحضيري = كود الإنتاج نفسه (22fead5) + ملفات الترحيل وحدها،
   فيطبّقها الكود القديم بنقطته المعتادة؛ ثم يُنشر المرشح على مخطط جاهز فلا نافذة.

     0. الإنتاج الحالي (22fead5) على قالب المخطط: ترحيلاته، مسؤول أول، مستخدم، تسجيل، دفعة.
     1. المرحلة 1 — prep: ‏الكود القديم يرى 011…015 معلّقة ويطبّقها (نداءان متزامنان: migrate.js القديم
        بلا قفل — يُسجَّل ما يحدث)، ثم مسارات الكود القديم كلها على المخطط المرحَّل.
     1R. تراجع المرحلة 1: إعادة 22fead5 كما هو على المخطط المرحَّل.
     2. المرحلة 2 — المرشح: لا ترحيل معلّق، لا نافذة؛ نداءان متزامنان no-op؛ فاتورة أُنشئت في المرحلة 1
        (بلا صف متوقع) تُطابَق بقاعدة legacy؛ وحدث غير مطابق يُحجز.
     2R. تراجع المرحلة 2: العودة إلى prep (الكود القديم) والجداول الجديدة باقية بلا أثر عليه.
     2F. التقدم مجدداً إلى المرشح: لا شيء يُعاد، والمحجوز باقٍ.
   بصمة المخطط (أعمدة الجداول) تُقارن بعد كل خطوة: التراجع لا يغيّر المخطط ولا يحذف بيانات.
   كل خادم بـ --require net-local-only.cjs (لا اتصال إلا بـ127.0.0.1)، وقاعدة معزولة جديدة عبر الحارس.
   النتيجة: test-support/.local/logs/ord0003/n03-drill.{log,json}
   ============================================================ */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [BASE_DIR, PREP_DIR, CAND_DIR] = process.argv.slice(2, 5).map((d) => d && path.resolve(d));
if (![BASE_DIR, PREP_DIR, CAND_DIR].every((d) => d && fs.existsSync(path.join(d, "index.js")))) {
  console.error("usage: node test-support/n03-drill.mjs <baseline dir> <prep dir> <candidate dir>"); process.exit(2);
}
const rev = (d) => execFileSync("git", ["-C", d, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const LOG_DIR = path.join(HERE, ".local", "logs", "ord0003"); fs.mkdirSync(LOG_DIR, { recursive: true });
const lines = []; const say = (s) => { lines.push(s); console.log(s); };
const R = []; const ok = (id, label, cond, x = "") => { R.push({ id, label, pass: !!cond, detail: x }); say(`${cond ? "PASS" : "FAIL"}  ${id} ${label}${x ? `  (${String(x).slice(0, 300)})` : ""}`); };
const obs = []; const note = (id, label, value) => { obs.push({ id, label, value }); say(`OBS   ${id} ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`); };

const envLines = execFileSync(process.execPath, [path.join(HERE, "create-db.mjs"), "n03-drill", "schema"], { encoding: "utf8" });
const DB_URL = /TEST_DATABASE_URL='([^']+)'/.exec(envLines)[1];
process.env.TEST_DATABASE_URL = DB_URL; process.env.KANAF_TEST_MARKER = /KANAF_TEST_MARKER='([^']+)'/.exec(envLines)[1];
await import("./guard.mjs");
const { default: pg } = await import("pg");
const db = new pg.Pool({ connectionString: DB_URL, ssl: false, max: 3 });
const q = (sql, p) => db.query(sql, p);

const SECRETS = { SETUP_TOKEN: crypto.randomBytes(24).toString("hex"), USER_JWT_SECRET: crypto.randomBytes(32).toString("hex"), ADMIN_JWT_SECRET: crypto.randomBytes(32).toString("hex") };
const WEBHOOK_SECRET = "n03-drill-webhook-secret";
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const serverEnv = (port) => ({
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", PORT: String(port), DATABASE_URL: DB_URL, DB_SSL: "false",
  ...SECRETS, SKIP_PDF_BOOT_CHECK: "1", ALLOWED_ORIGINS: "http://127.0.0.1:5173",
  SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", ANTHROPIC_API_KEY: "",
  PAYMENT_SECRET_KEY: "sk_test_n03_fake", PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
  SWEEP_MIN_INTERVAL_MS: "999999999", REMINDER_SWEEP_MIN_INTERVAL_MS: "999999999",
});
async function start(dir, tag) {
  const port = await freePort();
  const out = fs.openSync(path.join(LOG_DIR, `n03-drill.${tag}.server.log`), "w");
  const p = spawn(process.execPath, ["--require", path.join(HERE, "net-local-only.cjs"), "index.js"], { cwd: dir, env: serverEnv(port), stdio: ["ignore", out, out] });
  const B = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(B + "/api/health"); if (r.ok) return { p, B, tag }; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  p.kill(); throw new Error(`${tag} did not start`);
}
const stop = async (s) => { if (s.p.exitCode === null) { s.p.kill("SIGTERM"); await new Promise((r) => s.p.once("exit", r)); } };
async function call(B, method, p, { body, token, cookie, headers = {} } = {}) {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, setCookie: r.headers.getSetCookie?.() || [] };
}
const adminCookie = (res) => res.setCookie.map((c) => c.split(";")[0]).join("; ");
const hashWith = (dir, pw) => execFileSync(process.execPath, ["--input-type=module", "-e",
  `import { hashPassword } from "./auth/tokens.js"; process.stdout.write(await hashPassword(${JSON.stringify(pw)}));`],
  { cwd: dir, env: { PATH: process.env.PATH, USER_JWT_SECRET: "x".repeat(64), DATABASE_URL: DB_URL, DB_SSL: "false" }, encoding: "utf8" });
const schemaPrint = async () => {
  const { rows } = await q(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
                            WHERE table_schema = 'public' ORDER BY table_name, column_name`);
  return { tables: new Set(rows.map((r) => r.table_name)).size, sha: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16) };
};
const migs = async () => (await q(`SELECT filename FROM schema_migrations ORDER BY filename`)).rows.map((r) => r.filename);
const counts = async () => (await q(`SELECT (SELECT count(*)::int FROM users) users, (SELECT count(*)::int FROM daily_logs) logs,
  (SELECT count(*)::int FROM payments) payments, (SELECT count(*)::int FROM subscriptions) subs,
  (SELECT count(*)::int FROM invoices) invoices`)).rows[0];
const holdsOpen = async () => { try { return (await q(`SELECT reason, provider_payment_id FROM payment_event_holds WHERE status = 'open'`)).rows; } catch { return null; } };
let P = 0;
const webhook = (B, inv, over = {}) => call(B, "POST", "/api/payments/webhook", { body: { id: `evt_${crypto.randomUUID()}`, type: "payment_paid", secret_token: WEBHOOK_SECRET,
  data: { id: `mo_pay_n03_${++P}`, status: "paid", amount: 2900, currency: "SAR", invoice_id: inv.prov, source: { type: "creditcard", company: "mada", number: "XXXX4444" }, metadata: { kanaf_invoice_id: inv.id }, ...over } } });
async function legacyInvoice(userId, tag) {
  /* فاتورة كما يكتبها create-invoice في 22fead5 (لا صف متوقع). المزوّد خارجي ومحجوب في التمرين، فيُكتب الصف مباشرة. */
  const prov = `mo_inv_n03_${tag}`;
  const { rows: [i] } = await q(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, provider_invoice_id, checkout_url) VALUES ($1, 'monthly', 29.00, 'pending', $2, 'https://checkout.test/x') RETURNING id`, [userId, prov]);
  return { id: i.id, prov };
}

const USER_EMAIL = "n03-user@kanaf.test", USER_PW = "N03-Base-Pass-2026!";
const ADMIN_EMAIL = "n03-owner@kanaf.test", ADMIN_PW = "N03-Owner-Long-Pass-2026!";
/* KANAF-ORD-0012 §5: كانت القائمة ثابتة 011…015 (prep الأول). صارت تُشتقّ: كل ترحيلة في المرشح ليست في
   خط الأساس — فيصلح التمرين لـn03-prep-22fead5 (011…015 مع مرشح أكتوبر) ولـn03-prep-v2-22fead5 (011…020). */
const migsIn = (d) => fs.readdirSync(path.join(d, "db/migrations")).filter((f) => f.endsWith(".sql"));
const NEW_MIGS = migsIn(CAND_DIR).filter((f) => !migsIn(BASE_DIR).includes(f)).sort();
if (!NEW_MIGS.length) { console.error("no new migrations in candidate vs baseline"); process.exit(2); }
say(`REVISION baseline=${rev(BASE_DIR)} prep=${rev(PREP_DIR)} candidate=${rev(CAND_DIR)} db=${new URL(DB_URL).pathname.slice(1)} node=${process.version}`);
const prepFiles = execFileSync("git", ["-C", PREP_DIR, "diff", "--name-only", rev(BASE_DIR), "HEAD"], { encoding: "utf8" }).trim().split("\n");
ok("P0", "prep commit = baseline + migration files only", prepFiles.length === NEW_MIGS.length && prepFiles.every((f) => NEW_MIGS.includes(path.basename(f)) && f.startsWith("db/migrations/")), prepFiles.join(","));
const sameBytes = NEW_MIGS.every((f) => fs.readFileSync(path.join(PREP_DIR, "db/migrations", f)).equals(fs.readFileSync(path.join(CAND_DIR, "db/migrations", f))));
ok("P1", "prep migration files are byte-identical to the candidate's", sameBytes);

let s = null;
const prints = {};
try {
  /* ---------- 0) الإنتاج الحالي ---------- */
  s = await start(BASE_DIR, "0-base");
  let r = await call(s.B, "POST", "/api/setup/run-migrations", { body: { token: SECRETS.SETUP_TOKEN } });
  ok("B1", "baseline applies its own migrations", r.status === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 120));
  r = await call(s.B, "POST", "/api/setup/create-first-admin", { body: { token: SECRETS.SETUP_TOKEN, name: "مالك التمرين", email: ADMIN_EMAIL, password: ADMIN_PW } });
  ok("B2", "first admin created by baseline code", [200, 201].includes(r.status), String(r.status));
  const { rows: [u] } = await q(`INSERT INTO users (name, email, password_hash, confirmed_adult, agreed_policy_at, email_verified_at) VALUES ('مستخدم التمرين', $1, $2, true, now(), now()) RETURNING id`, [USER_EMAIL, hashWith(BASE_DIR, USER_PW)]);
  await q(`INSERT INTO subscription_plans (plan_key,name,price_sar,duration_days,display_order) VALUES ('monthly','الباقة الشهرية',29.00,30,1) ON CONFLICT (plan_key) DO NOTHING`);
  await q(`INSERT INTO billing_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`);
  r = await call(s.B, "POST", "/api/auth/login", { body: { email: USER_EMAIL, password: USER_PW } });
  let tok = r.body.accessToken;
  ok("B3", "user logs in and writes a log on baseline", !!tok && [200, 201].includes((await call(s.B, "POST", "/api/me/logs", { token: tok, body: { mood: 6, sleep: 6, energy: 6, note: "قبل المرحلة 1", tags: [], loggedOn: "2026-10-01" } })).status));
  prints.base = await schemaPrint(); const migsBase = await migs();
  note("B4", "baseline schema", { ...prints.base, migrations: migsBase.length });
  await stop(s);

  /* ---------- 1) المرحلة 1: prep ---------- */
  s = await start(PREP_DIR, "1-prep");
  /* KANAF-ORD-0012: الصيغة نفسها التي في RELEASE_RUNBOOK الخطوة 3-ب — كود 22fead5 يقرأ الرمز من ?token= وحده
     (كان التمرين يرسله في ترويسة يتجاهلها الكود القديم، فلم تُختبر صيغة الدليل). */
  r = await call(s.B, "GET", `/api/setup/migration-status?token=${encodeURIComponent(SECRETS.SETUP_TOKEN)}`);
  const st1 = (r.body.migrations || []).filter((m) => !m.applied).map((m) => m.filename);
  ok("S1a", "prep (old code) migration-status with ?token= (runbook 3-b) lists exactly the new migrations as pending", r.status === 200 && JSON.stringify(st1) === JSON.stringify(NEW_MIGS), `${r.status} ${st1.join(",")}`);
  const hdr = await call(s.B, "GET", "/api/setup/migration-status", { headers: { "X-Setup-Token": SECRETS.SETUP_TOKEN } });
  note("S1a2", "old code ignores the X-Setup-Token header (runbook must use ?token= before stage 2)", hdr.status);
  /* قبل الترحيل: الكود القديم ما زال يعمل (لا نافذة في المرحلة 1 — الكود لا يعتمد على الجديد) */
  r = await call(s.B, "POST", "/api/auth/login", { body: { email: USER_EMAIL, password: USER_PW } });
  ok("S1b", "before migrating, prep = baseline code: user login works", r.status === 200, String(r.status));
  const [m1, m2] = await Promise.all([1, 2].map(() => call(s.B, "POST", "/api/setup/run-migrations", { body: { token: SECRETS.SETUP_TOKEN } })));
  const applied1 = [...(m1.body.results || []), ...(m2.body.results || [])].filter((x) => x.status === "applied").map((x) => x.file || x.filename);
  note("S1c", "two concurrent run-migrations on the OLD migrate.js (no advisory lock)", { first: m1.status, second: m2.status, applied: applied1, errors: [m1.body.error, m2.body.error].filter(Boolean) });
  r = await call(s.B, "POST", "/api/setup/run-migrations", { body: { token: SECRETS.SETUP_TOKEN } });
  const after1 = await migs();
  ok("S1d", "after the concurrent pair and one more call: each new migration recorded exactly once, last call all skipped", NEW_MIGS.every((f) => after1.filter((x) => x === f).length === 1) && r.status === 200 && (r.body.results || []).every((x) => x.status === "skipped"), `${r.status} ${JSON.stringify(after1.slice(-6))}`);
  r = await call(s.B, "GET", `/api/setup/migration-status?token=${encodeURIComponent(SECRETS.SETUP_TOKEN)}`);
  ok("S1d2", "after migrating, runbook 3-b on old code shows nothing pending", r.status === 200 && (r.body.migrations || []).every((m) => m.applied), String(r.status));
  const { rows: dupm } = await q(`SELECT filename FROM schema_migrations GROUP BY 1 HAVING count(*) > 1`);
  ok("S1e", "no duplicate schema_migrations rows (each file applied once even without the lock)", dupm.length === 0, JSON.stringify(dupm));
  ok("S1f", "at most one of the two concurrent calls failed, and that failure left nothing half-applied", [m1.status, m2.status].filter((x) => x === 200).length >= 1, `${m1.status} ${m2.status}`);
  prints.stage1 = await schemaPrint();
  note("S1g", "schema after stage 1", prints.stage1);
  /* الكود القديم على المخطط المرحَّل */
  r = await call(s.B, "POST", "/api/auth/login", { body: { email: USER_EMAIL, password: USER_PW } }); tok = r.body.accessToken;
  ok("S1h", "old code on the migrated schema: login, read and write logs", !!tok && (await call(s.B, "GET", "/api/me/logs?days=400", { token: tok })).status === 200 && [200, 201].includes((await call(s.B, "POST", "/api/me/logs", { token: tok, body: { mood: 5, sleep: 5, energy: 5, note: "في المرحلة 1", tags: [], loggedOn: "2026-10-02" } })).status));
  ok("S1i", "old code on the migrated schema: screening without clientRef", (await call(s.B, "POST", "/api/me/screenings", { token: tok, body: { kind: "gad7", total: 3, bandLabel: "طفيف", answers: {} } })).status === 201);
  r = await call(s.B, "POST", "/admin/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PW } });
  const ck1 = adminCookie(r);
  ok("S1j", "old code on the migrated schema: admin login, users and billing pages", r.status === 200 && (await call(s.B, "GET", "/admin/users", { cookie: ck1 })).status === 200 && (await call(s.B, "GET", "/admin/billing/payments", { cookie: ck1 })).status === 200, String(r.status));
  const invA = await legacyInvoice(u.id, "A"); // تُدفع في المرحلة 2
  const { rows: [u2] } = await q(`INSERT INTO users (name, email, password_hash, confirmed_adult, email_verified_at) VALUES ('دافع المرحلة 1', 'n03-pay1@kanaf.test', 'x', true, now()) RETURNING id`);
  const invS1 = await legacyInvoice(u2.id, "S1");
  r = await webhook(s.B, invS1);
  const { rows: [ps1] } = await q(`SELECT status FROM invoices WHERE id = $1`, [invS1.id]);
  ok("S1k", "old code on the migrated schema: a paid webhook is processed (invoice paid)", r.status === 200 && ps1.status === "paid", `${r.status} ${JSON.stringify(r.body)} ${ps1.status}`);
  note("S1l", "stage 1 keeps the old payment acceptance (N-02 arrives only with the candidate); 015 tables unused by old code", { holds: await holdsOpen(), expectations: (await q(`SELECT count(*)::int n FROM invoice_payment_expectations`)).rows[0].n });
  const c1 = await counts();
  await stop(s);

  /* ---------- 1R) تراجع المرحلة 1 ---------- */
  s = await start(BASE_DIR, "1R-base");
  r = await call(s.B, "POST", "/api/auth/login", { body: { email: USER_EMAIL, password: USER_PW } }); tok = r.body.accessToken;
  ok("R1a", "stage-1 rollback (22fead5 again): login, logs read and write", !!tok && (await call(s.B, "GET", "/api/me/logs?days=400", { token: tok })).status === 200 && [200, 201].includes((await call(s.B, "POST", "/api/me/logs", { token: tok, body: { mood: 4, sleep: 4, energy: 4, note: "تراجع المرحلة 1", tags: [], loggedOn: "2026-10-03" } })).status));
  r = await call(s.B, "POST", "/admin/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PW } });
  ok("R1b", "stage-1 rollback: admin login and users", r.status === 200 && (await call(s.B, "GET", "/admin/users", { cookie: adminCookie(r) })).status === 200);
  r = await call(s.B, "POST", "/api/setup/run-migrations", { body: { token: SECRETS.SETUP_TOKEN } });
  ok("R1c", "stage-1 rollback: baseline migration endpoint is a no-op, schema unchanged, nothing deleted", r.status === 200 && (r.body.results || []).every((x) => x.status === "skipped") && (await schemaPrint()).sha === prints.stage1.sha && (await counts()).invoices === c1.invoices, JSON.stringify(r.body).slice(0, 120));
  await stop(s);

  /* ---------- 2) المرحلة 2: المرشح ---------- */
  s = await start(CAND_DIR, "2-candidate");
  r = await call(s.B, "GET", "/api/setup/migration-status", { headers: { "X-Setup-Token": SECRETS.SETUP_TOKEN } });
  const pending2 = (r.body.migrations || []).filter((m) => !m.applied).map((m) => m.file || m.filename);
  ok("S2a", "candidate on the stage-1 schema: no pending migration (no window)", r.status === 200 && pending2.length === 0, `${r.status} pending=${pending2.join(",")}`);
  r = await call(s.B, "POST", "/api/auth/login", { body: { email: USER_EMAIL, password: USER_PW } }); tok = r.body.accessToken;
  const win = {
    user_login: r.status,
    safety_plan_put: (await call(s.B, "PUT", "/api/me/safety-plan", { token: tok, body: { warningSigns: "", copingStrategies: "أتمشى", safePlace: "", baseVersion: null } })).status,
    screening_clientRef: (await call(s.B, "POST", "/api/me/screenings", { token: tok, body: { kind: "gad7", total: 2, bandLabel: "طفيف", answers: {}, clientRef: crypto.randomUUID() } })).status,
  };
  r = await call(s.B, "POST", "/admin/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PW } });
  const ck2 = adminCookie(r); win.admin_login = r.status;
  win.holds_list = (await call(s.B, "GET", "/admin/billing/payment-holds", { cookie: ck2 })).status;
  note("S2b", "candidate immediately after deploy, before any migration call", win);
  ok("S2c", "the PKG-D window is gone: admin login, safety plan and new app writes all work at once", win.user_login === 200 && win.admin_login === 200 && win.safety_plan_put === 200 && win.screening_clientRef === 201 && win.holds_list === 200, JSON.stringify(win));
  const [n1, n2] = await Promise.all([1, 2].map(() => call(s.B, "POST", "/api/setup/run-migrations", { headers: { "X-Setup-Token": SECRETS.SETUP_TOKEN } })));
  ok("S2d", "two concurrent run-migrations on the candidate (advisory lock): both 200, nothing applied", n1.status === 200 && n2.status === 200 && [...(n1.body.results || []), ...(n2.body.results || [])].every((x) => x.status === "skipped"), `${n1.status} ${n2.status}`);
  ok("S2e", "schema unchanged by stage 2", (await schemaPrint()).sha === prints.stage1.sha);
  r = await webhook(s.B, invA, { amount: 100 });
  const { rows: [pa0] } = await q(`SELECT status FROM invoices WHERE id = $1`, [invA.id]);
  ok("S2f", "candidate: a mismatching payment for a stage-1 (legacy) invoice is held, not activated", r.status === 200 && pa0.status === "pending" && ((await holdsOpen()) || []).some((h) => h.reason === "amount_mismatch"), `${JSON.stringify(r.body)} ${pa0.status}`);
  r = await webhook(s.B, invA);
  const { rows: [pa1] } = await q(`SELECT status FROM invoices WHERE id = $1`, [invA.id]);
  ok("S2g", "candidate: the exact payment for that stage-1 invoice is accepted by the legacy rule (amount_sar×100, currency unchanged)", r.status === 200 && pa1.status === "paid", `${JSON.stringify(r.body)} ${pa1.status}`);
  const { rows: [u3] } = await q(`INSERT INTO users (name, email, password_hash, confirmed_adult, email_verified_at) VALUES ('محجوز', 'n03-held@kanaf.test', 'x', true, now()) RETURNING id`);
  const invH = await legacyInvoice(u3.id, "H");
  await webhook(s.B, invH, { currency: "USD" });
  const heldBefore = (await holdsOpen()).length;
  await stop(s);

  /* ---------- 2R) تراجع المرحلة 2: إلى prep ---------- */
  s = await start(PREP_DIR, "2R-prep");
  r = await call(s.B, "POST", "/api/auth/login", { body: { email: USER_EMAIL, password: USER_PW } }); tok = r.body.accessToken;
  const logs = (await call(s.B, "GET", "/api/me/logs?days=400", { token: tok })).body.logs || [];
  ok("R2a", "stage-2 rollback (prep = old code): login and logs from every stage readable", !!tok && ["قبل المرحلة 1", "في المرحلة 1", "تراجع المرحلة 1"].every((n) => logs.some((l) => l.note === n)), JSON.stringify(logs.map((l) => l.note)));
  r = await call(s.B, "POST", "/admin/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PW } });
  ok("R2b", "stage-2 rollback: admin login and billing pages", r.status === 200 && (await call(s.B, "GET", "/admin/billing/payments", { cookie: adminCookie(r) })).status === 200);
  ok("R2c", "stage-2 rollback: schema and held events untouched (old code ignores the new tables)", (await schemaPrint()).sha === prints.stage1.sha && (await holdsOpen()).length === heldBefore, `${heldBefore}`);
  r = await call(s.B, "POST", "/api/setup/run-migrations", { body: { token: SECRETS.SETUP_TOKEN } });
  ok("R2d", "stage-2 rollback: old migration endpoint is a no-op", r.status === 200 && (r.body.results || []).every((x) => x.status === "skipped"));
  await stop(s);

  /* ---------- 2F) التقدم مجدداً ---------- */
  s = await start(CAND_DIR, "2F-candidate");
  r = await call(s.B, "POST", "/api/setup/run-migrations", { headers: { "X-Setup-Token": SECRETS.SETUP_TOKEN } });
  ok("F1", "roll forward again: nothing applied", r.status === 200 && (r.body.results || []).every((x) => x.status === "skipped"));
  r = await call(s.B, "POST", "/admin/auth/login", { body: { email: ADMIN_EMAIL, password: ADMIN_PW } });
  const hl = await call(s.B, "GET", "/admin/billing/payment-holds", { cookie: adminCookie(r) });
  ok("F2", "roll forward: the events held before the rollback are still listed", hl.status === 200 && (hl.body.holds || []).length === heldBefore, `${hl.status} ${(hl.body.holds || []).length}/${heldBefore}`);
  await stop(s); s = null;
} catch (e) { ok("!!", "stopped", false, String(e.stack || e).slice(0, 400)); }
finally {
  if (s) await stop(s).catch(() => {});
  await db.end().catch(() => {});
}
const f = R.filter((r) => !r.pass).length;
say(`\n${R.length - f}/${R.length} passed`);
fs.writeFileSync(path.join(LOG_DIR, "n03-drill.json"), JSON.stringify({ at: new Date().toISOString(), node: process.version, baseline: rev(BASE_DIR), prep: rev(PREP_DIR), candidate: rev(CAND_DIR), results: R, observations: obs }, null, 2));
fs.writeFileSync(path.join(LOG_DIR, "n03-drill.log"), lines.join("\n") + "\n");
process.exit(f ? 1 : 0);
