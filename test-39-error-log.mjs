import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0013 §11 — سجلّ أخطاء النظام.
 *  S) 🔴 خطأ تحمل رسالته نصّ مستخدم وسلسلة اتصال وبريداً ورمزاً → الصفّ المخزَّن خالٍ منها كلها.
 *  C) المتكرر صفّ واحد بعدّاد وأول/آخر ظهور، ودورة التنظيف (العمر والسقف).
 *  F) 🔴 فشل الكتابة في السجل لا يُسقط الطلب الأصلي.
 *  P) للمالك والمدير وحدهما.
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { recordError, sanitizeErrorText, _resetCleanupTimer, ERROR_LOG_MAX_ROWS } = await import("./ops/error-log.js");
const { systemErrorsRouter } = await import("./admin/system-errors.js");
const { fail } = await import("./admin/middleware.js");
for (const k of ["error", "warn"]) console[k] = () => {};

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser());
app.use("/admin", systemErrorsRouter);
/* مسار يفشل كما تفشل المسارات الحقيقية: عبر fail() المشتركة */
app.get("/boom", (req, res) => fail(res, Object.assign(new Error(`insert failed: Key (email)=(victim@example.com) already exists; note "أشعر بالحزن الشديد اليوم" via postgres://kanaf_kanaf:S3cretPass@tanfs.net:5432/kanaf_kanaf token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop phone +966512345678`), { code: "23505" }), "test/boom", req));
const server = app.listen(4640); const B = "http://127.0.0.1:4640";
let cookie = "";
const as = async (role) => {
  const base = role === "accountant" ? "support" : role;
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ($1,$2,'x',$3) RETURNING id`, [`el ${role}`, `el-${role}-${Math.random()}@kanaf.test`, base]);
  if (role === "accountant") await query(`INSERT INTO admin_role_assignments (admin_user_id, role) VALUES ($1,'accountant')`, [a.id]);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: a.id, role: base, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
};
const call = async (method, p) => {
  const r = await fetch(B + p, { method, headers: { Cookie: cookie } });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ } return { status: r.status, body: json, raw };
};
const settle = () => new Promise((r) => setTimeout(r, 150));
const SECRETS = ["victim@example.com", "أشعر بالحزن الشديد اليوم", "S3cretPass", "postgres://", "tanfs.net:5432", "eyJhbGciOiJIUzI1NiJ9", "512345678"];

try {
  /* ---------- S) التنقية ---------- */
  let r = await call("GET", "/boom");
  await settle();
  const { rows: stored } = await query(`SELECT kind, message, coalesce(stack,'') AS stack, location, count FROM system_errors`);
  const all = JSON.stringify(stored);
  ok("S0 الطلب الذي فشل ردّ 500 كعادته", r.status === 500);
  ok("S1 صفّ واحد مخزَّن بنوعه ومكانه ووقته", stored.length === 1 && stored[0].kind === "23505" && /test\/boom · GET \/boom/.test(stored[0].location), JSON.stringify(stored[0]));
  ok("S2 🔴 الصفّ خالٍ من نصّ المستخدم وسلسلة الاتصال وكلمة المرور والبريد والرمز والجوال",
    SECRETS.every((x) => !all.includes(x)), SECRETS.filter((x) => all.includes(x)).join(" | ") + " :: " + stored[0]?.message);
  ok("S3 ويبقى ما يفيد التشخيص: نوع العطب وبنية الرسالة", /insert failed: Key \(email\)=\(\[…\]\) already exists/.test(stored[0].message), stored[0].message);
  ok("S4 معرّف العميل في المسار يُستبدل (:id)", sanitizeErrorText("x") === "x" && (await (async () => { await recordError(new Error("y"), { location: "GET /admin/users/0b5a3c9e-1f2d-4c6b-9a8e-7d6c5b4a3f21/billing" }); const { rows } = await query(`SELECT location FROM system_errors WHERE message = 'y'`); return rows[0]?.location === "GET /admin/users/:id/billing"; })()));

  /* ---------- C) التجميع والسقف ---------- */
  for (let i = 0; i < 300; i++) await recordError(new Error(`timeout after ${5000 + i}ms`), { location: "job:sweep" });
  const { rows: [agg] } = await query(`SELECT count(*)::int AS rows, max(count) AS n, bool_and(last_seen >= first_seen) AS ordered FROM system_errors WHERE location = 'job:sweep'`);
  ok("C1 خطأ متكرر 300 مرة (بأرقام مختلفة) = صفّ واحد عدّاده 300، بأول وآخر ظهور", agg.rows === 1 && agg.n === 300 && agg.ordered, JSON.stringify(agg));
  await query(`UPDATE system_errors SET last_seen = now() - interval '40 days' WHERE location = 'job:sweep'`);
  _resetCleanupTimer();
  await recordError(new Error("fresh"), { location: "job:other" });
  const { rows: [old] } = await query(`SELECT count(*)::int n FROM system_errors WHERE location = 'job:sweep'`);
  ok("C2 دورة التنظيف تحذف ما تجاوز مدة الاحتفاظ (30 يوماً)", old.n === 0);
  ok("C3 سقف الصفوف معلَن ومحدود", Number.isInteger(ERROR_LOG_MAX_ROWS) && ERROR_LOG_MAX_ROWS > 0 && ERROR_LOG_MAX_ROWS <= 10000);

  /* ---------- F) فشل الكتابة لا يُسقط الطلب ---------- */
  await query(`ALTER TABLE system_errors RENAME TO system_errors_hidden`);
  let threw = false;
  try { await recordError(new Error("while table is gone"), { location: "x" }); } catch { threw = true; }
  r = await call("GET", "/boom");
  await settle();
  ok("F1 🔴 الكتابة في السجل تفشل (الجدول غائب) فلا ترمي، والطلب الأصلي يُكمل ردّه كالمعتاد", !threw && r.status === 500 && r.body.error === "internal_error", `${threw} ${r.status}`);
  await query(`ALTER TABLE system_errors_hidden RENAME TO system_errors`);

  /* ---------- P) الصلاحية ---------- */
  await as("support");
  ok("P1 الدعم → 403", (await call("GET", "/admin/system-errors")).status === 403);
  await as("accountant");
  ok("P2 المحاسب → 403", (await call("GET", "/admin/system-errors")).status === 403);
  await as("admin");
  r = await call("GET", "/admin/system-errors");
  ok("P3 المدير → 200، والردّ نفسه بلا أسرار", r.status === 200 && r.body.total >= 1 && SECRETS.every((x) => !r.raw.includes(x)));
  await as("owner");
  ok("P4 المالك → 200", (await call("GET", "/admin/system-errors")).status === 200);
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 300), false); }
finally { server.close(); await pool.end().catch(() => {}); }

let pass = 0, fail2 = 0;
for (const [l, c, x] of R) { if (c) { pass++; process.stdout.write(`  PASS  ${l}\n`); } else { fail2++; process.stdout.write(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 300)})` : ""}\n`); } }
process.stdout.write(`\n  ${pass} passed, ${fail2} failed\n`);
process.exit(fail2 ? 1 : 0);
