import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0001 — مشغّل المجدول المحمي (R15-14)،
 * تنظيف الرموز المنتهية (R15-15)، الجاهزية (X10)، رمز الإعداد (X06).
 * الخادم الكامل على قاعدة معزولة. «بلا حركة مستخدمين» = لا طلب واحد
 * من مستخدم؛ النداء الوحيد هو نداء المشغّل الخارجي.
 */
requireDedicatedDatabase(import.meta.url);
import bcrypt from "bcrypt";

process.env.PORT = "4635";
process.env.SKIP_PDF_BOOT_CHECK = "1";
process.env.ALLOWED_ORIGINS = "http://127.0.0.1:5173";
process.env.SWEEP_TRIGGER_TOKEN = "t".repeat(40);
process.env.SETUP_TOKEN = "setup-token-for-isolated-test-0123456789";
process.env.AUTH_CLEANUP_RETENTION_DAYS = "30";
process.env.SWEEP_MIN_INTERVAL_MS = "999999999";          // لا مسح على هامش الطلبات أثناء الاختبار
process.env.REMINDER_SWEEP_MIN_INTERVAL_MS = "999999999";
const logs = []; const rl = console.log, re = console.error, rw = console.warn;
console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
await new Promise((r) => setTimeout(r, 300));
const B = "http://127.0.0.1:4635";
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
async function call(method, path, { body, headers = {} } = {}) {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, text: JSON.stringify(j) };
}
const TOK = { "X-Sweep-Token": process.env.SWEEP_TRIGGER_TOKEN };

try {
  /* أول طلب يطلق مسح الهامش (sweepMiddleware) مرة؛ ننتظر انتهاءه حتى
     يُقاس المشغّل الخارجي وحده لا مسحاً متزامناً معه. */
  await call("GET", "/api/health"); await new Promise((r) => setTimeout(r, 1500));
  /* ---------- R15-14 ---------- */
  let r = await call("POST", "/api/internal/sweep");
  ok("T1 no token → 403", r.status === 403, String(r.status));
  r = await call("POST", "/api/internal/sweep", { headers: { "X-Sweep-Token": "x".repeat(40) } });
  ok("T2 wrong token → 403", r.status === 403);
  r = await call("POST", `/api/internal/sweep?token=${process.env.SWEEP_TRIGGER_TOKEN}`);
  ok("T3 token in the URL is not accepted (header only)", r.status === 403);

  const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at,reminders_on) VALUES ('تذكير','rem@kanaf.test','x',now(),true) RETURNING id`);
  await query(`INSERT INTO user_reminder_prefs (user_id, local_time, timezone, last_sent_on)
               VALUES ($1, ((now() AT TIME ZONE 'UTC') - interval '30 minutes')::time, 'UTC', NULL)`, [u.id]);
  r = await call("POST", "/api/internal/sweep", { headers: TOK });
  const { rows: n1 } = await query(`SELECT count(*)::int n FROM user_notifications WHERE user_id = $1`, [u.id]);
  ok("T4 due reminder delivered by the external trigger alone (no user traffic)", r.status === 200 && r.body.reminders?.swept >= 1 && n1[0].n === 1, `${r.status} ${r.text} inbox=${n1[0].n}`);
  r = await call("POST", "/api/internal/sweep", { headers: TOK });
  const { rows: n2 } = await query(`SELECT count(*)::int n FROM user_notifications WHERE user_id = $1`, [u.id]);
  ok("T5 a second trigger the same day sends nothing new", r.status === 200 && n2[0].n === 1, String(n2[0].n));
  const both = await Promise.all([1, 2, 3].map(() => call("POST", "/api/internal/sweep", { headers: TOK })));
  ok("T6 concurrent triggers are safe (all 200, no duplicate)", both.every((x) => x.status === 200) && (await query(`SELECT count(*)::int n FROM user_notifications WHERE user_id=$1`, [u.id])).rows[0].n === 1);

  /* ---------- R15-15 ---------- */
  const ins = (sql, p) => query(sql, p);
  await ins(`INSERT INTO email_verification_codes (email, code_hash, purpose, expires_at, consumed_at, created_at) VALUES
    ('old@k.test','h','signup', now()-interval '31 days', now()-interval '31 days', now()-interval '31 days'),
    ('mid@k.test','h','signup', now()-interval '29 days', now()-interval '29 days', now()-interval '29 days'),
    ('live@k.test','h','signup', now()+interval '10 minutes', NULL, now())`);
  await ins(`INSERT INTO user_sessions (user_id, token_hash, expires_at, revoked_at, created_at) VALUES
    ($1,'active-old', now()+interval '5 days', NULL, now()-interval '40 days'),
    ($1,'revoked-31', now()+interval '5 days', now()-interval '31 days', now()-interval '35 days'),
    ($1,'revoked-29', now()+interval '5 days', now()-interval '29 days', now()-interval '35 days'),
    ($1,'expired-31', now()-interval '31 days', NULL, now()-interval '61 days')`, [u.id]);
  r = await call("POST", "/api/internal/sweep", { headers: TOK });
  const codes = (await query(`SELECT email FROM email_verification_codes ORDER BY email`)).rows.map((x) => x.email);
  const sess = (await query(`SELECT token_hash FROM user_sessions ORDER BY token_hash`)).rows.map((x) => x.token_hash);
  ok("C1 codes: >30d consumed deleted; 29d kept; live code kept", JSON.stringify(codes) === JSON.stringify(["live@k.test", "mid@k.test"]), JSON.stringify(codes));
  ok("C2 sessions: revoked/expired >30d deleted; revoked 29d kept; ACTIVE session never deleted", JSON.stringify(sess) === JSON.stringify(["active-old", "revoked-29"]), JSON.stringify(sess));
  ok("C3 cleanup counts reported", r.body.cleanup?.verification_codes === 1 && r.body.cleanup?.sessions === 2, JSON.stringify(r.body.cleanup));

  /* ---------- X10 ---------- */
  r = await call("GET", "/api/internal/ready");
  ok("R1 readiness: db ok + last sweep success time, no secrets", r.status === 200 && r.body.db === "ok" && !!r.body.sweep.lastSuccessAt && !/token|secret|password/i.test(r.text), r.text);

  /* ---------- X06 setup token ---------- */
  r = await call("GET", "/api/setup/migration-status", { headers: { "X-Setup-Token": process.env.SETUP_TOKEN } });
  ok("S1 setup token accepted from header", r.status === 200 && Array.isArray(r.body.migrations));
  r = await call("GET", `/api/setup/migration-status?token=${encodeURIComponent(process.env.SETUP_TOKEN)}`);
  ok("S2 legacy query-string token still accepted (compat)", r.status === 200);
  r = await call("GET", "/api/setup/migration-status", { headers: { "X-Setup-Token": process.env.SETUP_TOKEN.slice(0, -1) + "x" } });
  ok("S3 wrong setup token → 403", r.status === 403);
  r = await call("POST", "/api/setup/create-first-admin", { headers: { "X-Setup-Token": process.env.SETUP_TOKEN }, body: { name: "مالك", email: "first@kanaf.test", password: "a-very-long-owner-password" } });
  ok("S4 first owner via header token on an empty admin table", r.status === 201, JSON.stringify(r.body));
  r = await call("POST", "/api/setup/create-first-admin", { headers: { "X-Setup-Token": process.env.SETUP_TOKEN }, body: { name: "ثاني", email: "second@kanaf.test", password: "a-very-long-owner-password" } });
  ok("S5 second owner refused even with the right token", r.status === 409);
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

console.log = rl; console.error = re; console.warn = rw;
let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
if (f) console.log(logs.slice(-12).join("\n"));
await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
