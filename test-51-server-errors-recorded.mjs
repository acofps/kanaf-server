import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0015 §2.2 — كل 5xx يصل «أخطاء النظام»، وعطب الدفع مرئيّ ومفهوم.
 *  S) 🔴 فحص ثابت: لا res.status(5xx) مكتوب بيد في أي ملف خادم — الطريق الوحيد serverError/expectedUnavailable.
 *  N) شبكة الأمان: ردّ 5xx بيدٍ (يُضاف غداً) يُسجَّل؛ والحالة المعلنة لا؛ وما سُجِّل لا يُكرَّر.
 *  P) 🔴 زرّ الاشتراك — الحالات الثلاث على خادم محلي، وما يراه العضو في كلٍّ، وما يراه المالك:
 *     P1 المفتاح غائب · P2 المزوّد يرفض (مفتاح خاطئ) · P3 المزوّد لا يردّ · P4 روابط الإنتاج خاطئة · P5 النجاح كما كان.
 */
requireDedicatedDatabase(import.meta.url);
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const express = (await import("express")).default;
const { query, pool } = await import("./db/pool.js");

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const out = (s) => process.stdout.write(s + "\n");
for (const k of ["error", "warn", "log"]) console[k] = () => {};

/* ---------- S) ثابت ---------- */
const files = execFileSync("git", ["ls-files", "*.js"], { encoding: "utf8" }).split("\n")
  .filter((f) => f && !/^(admin-ui|admin-src)\//.test(f) && !f.startsWith("test") && f !== "ops/http-errors.js" && !f.startsWith("node_modules"));
const hand = [];
for (const f of files) fs.readFileSync(f, "utf8").split("\n").forEach((l, i) => {
  if (/\.(status|sendStatus)\(\s*5\d\d\s*\)|\.status\([^)]*\?\s*5\d\d\b|\.status\([^)]*:\s*5\d\d\s*\)|statusCode\s*=\s*5\d\d/.test(l)) hand.push(`${f}:${i + 1}`);
});
ok(`S1 🔴 لا ردّ 5xx مكتوب بيد في ${files.length} ملف خادم (كان 75 موضعاً، منها 63 ردّ 500 لا يُسجَّل في 13 ملفاً)`, hand.length === 0, hand.join(" "));
const idx = fs.readFileSync("index.js", "utf8");
ok("S2 شبكة الأمان مركّبة أول التطبيق (قبل أي مسار)", idx.indexOf("app.use(record5xxNet)") > 0 && idx.indexOf("app.use(record5xxNet)") < idx.indexOf("app.use(\"/api/payments\""));

/* ---------- مزوّد مزيّف ---------- */
const prov = { mode: "ok", n: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (!href.startsWith("https://api.moyasar.com")) return realFetch(url, opts);
  if (prov.mode === "reject") return new Response(JSON.stringify({ type: "authentication_error", message: "Invalid authorization credentials", errors: null }), { status: 401, headers: { "Content-Type": "application/json" } });
  if (prov.mode === "hang") return await new Promise((_, rej) => opts.signal?.addEventListener("abort", () => rej(opts.signal.reason)));
  const id = `mo_inv_${++prov.n}`;
  return new Response(JSON.stringify({ id, url: `https://checkout.test/${id}` }), { status: 201, headers: { "Content-Type": "application/json" } });
};
process.env.KANAF_PAYMENT_PROVIDER_TIMEOUT_MS = "400";
const { paymentsRouter } = await import("./payments/routes.js");
const { paymentConfigProblems } = await import("./payments/config-check.js");
const { record5xxNet, serverError, expectedUnavailable } = await import("./ops/http-errors.js");
const { fail } = await import("./admin/middleware.js");
const { issueAccessToken } = await import("./auth/tokens.js");

const app = express(); app.use(record5xxNet); app.use(express.json());
app.use("/api/payments", paymentsRouter);
app.get("/t/hand", (req, res) => res.status(500).json({ error: "x" }));            // ما قد يُضاف غداً بيد
app.get("/t/expected", (req, res) => expectedUnavailable(res, 503, { error: "y" }));
app.get("/t/fail", (req, res) => fail(res, new Error("boom-fail"), "t:fail", req));
app.get("/t/server", (req, res) => serverError(res, new Error("boom-server"), "t:server", req));
const server = app.listen(0); const B = `http://127.0.0.1:${server.address().port}`;
const settle = () => new Promise((r) => setTimeout(r, 250));
const errRows = async (like) => (await query(`SELECT kind, message, location, count, http_status FROM system_errors WHERE location LIKE $1`, [like])).rows;
const call = async (p, body, token) => {
  const r = await realFetch(B + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

try {
  /* ---------- N) ---------- */
  await query(`DELETE FROM system_errors`);
  await call("/t/hand"); await call("/t/expected"); await call("/t/fail"); await call("/t/server"); await settle();
  const all = (await query(`SELECT kind, location, count FROM system_errors ORDER BY location`)).rows;
  ok("N1 ردّ 500 بيدٍ في مسار جديد يُسجَّل (Unrecorded5xx بموضعه)", all.some((r) => r.kind === "Unrecorded5xx" && r.location === "GET /t/hand"), JSON.stringify(all));
  ok("N2 الحالة المعلنة (expectedUnavailable) لا تُسجَّل عطباً", !all.some((r) => r.location.includes("/t/expected")));
  ok("N3 fail() في اللوحة وserverError يُسجَّلان مرة واحدة لا مرتين (الشبكة لا تكرّر)",
    all.filter((r) => r.location.includes("/t/fail")).length === 1 && all.filter((r) => r.location.includes("/t/server")).length === 1 && all.every((r) => r.count === 1), JSON.stringify(all));

  /* ---------- P) الدفع ---------- */
  const { rows: [u] } = await query(`INSERT INTO users (name, email, password_hash, confirmed_adult, email_verified_at) VALUES ('مشترك', $1, 'x', true, now()) RETURNING id`, [`pay-${crypto.randomBytes(3).toString("hex")}@kanaf.test`]);
  const token = issueAccessToken({ id: u.id });
  const invoices = async () => (await query(`SELECT status, checkout_url FROM invoices WHERE user_id = $1 ORDER BY created_at`, [u.id])).rows;
  const KEY = process.env.PAYMENT_SECRET_KEY;

  delete process.env.PAYMENT_SECRET_KEY;
  let r = await call("/api/payments/create-invoice", { planId: "monthly" }, token); await settle();
  let e = await errRows("payments:create-invoice%");
  ok("P1 المفتاح غائب → 503 payment_provider_not_configured بنصّ عربي، ولا فاتورة معلّقة تُنشأ",
    r.status === 503 && r.body.error === "payment_provider_not_configured" && /لم يُخصم منك شيء/.test(r.body.message) && (await invoices()).length === 0, JSON.stringify(r));
  ok("P1b 🔴 والمالك يراه في «أخطاء النظام» باسم المتغيّر (كان يُبتلع في console.error)",
    e.length === 1 && e[0].kind === "payment_provider_not_configured" && /PAYMENT_SECRET_KEY/.test(e[0].message) && e[0].http_status === 503, JSON.stringify(e));
  process.env.PAYMENT_SECRET_KEY = KEY || "sk_test_dummy";

  await query(`DELETE FROM system_errors`);
  prov.mode = "reject";
  r = await call("/api/payments/create-invoice", { planId: "monthly" }, token); await settle();
  e = await errRows("payments:create-invoice%");
  let inv = await invoices();
  ok("P2 المزوّد يرفض (401 مفتاح خاطئ) → 502 payment_provider_rejected بنصّ عربي",
    r.status === 502 && r.body.error === "payment_provider_rejected" && /حاول بعد دقائق/.test(r.body.message), JSON.stringify(r));
  ok("P2b السجل: provider_http_401 بسبب المزوّد، والفاتورة failed لا «سلة متروكة»",
    e.length === 1 && e[0].kind === "provider_http_401" && /Invalid authorization credentials/.test(e[0].message) && inv.length === 1 && inv[0].status === "failed", JSON.stringify({ e, inv }));

  await query(`DELETE FROM system_errors`);
  prov.mode = "hang";
  const t0 = Date.now();
  r = await call("/api/payments/create-invoice", { planId: "monthly" }, token); await settle();
  e = await errRows("payments:create-invoice%");
  inv = await invoices();
  ok("P3 المزوّد لا يردّ → 502 payment_provider_unreachable بعد المهلة (لا انتظار بلا حدّ)",
    r.status === 502 && r.body.error === "payment_provider_unreachable" && Date.now() - t0 < 5000 && e.length === 1 && e[0].kind === "TimeoutError", JSON.stringify({ r, e }));
  ok("P3b النتيجة مجهولة → الفاتورة تبقى pending بلا رابط (لا يُعاد استعمالها)", inv.length === 2 && inv[1].status === "pending" && !inv[1].checkout_url);

  const prodBad = paymentConfigProblems({ NODE_ENV: "production", PAYMENT_SECRET_KEY: "sk_live_x", APP_BASE_URL: "http://localhost:5173" });
  const prodTest = paymentConfigProblems({ NODE_ENV: "production", PAYMENT_SECRET_KEY: "sk_test_x", SERVER_BASE_URL: "https://kanaf-server.onrender.com", APP_BASE_URL: "https://tanfs.net" });
  ok("P4 في الإنتاج: SERVER_BASE_URL غائب أو APP_BASE_URL على localhost يمنعان (دفع بلا تفعيل)، والمفتاح التجريبي تحذير",
    prodBad.blocking.map((b) => b.name).join() === "SERVER_BASE_URL,APP_BASE_URL" && prodTest.blocking.length === 0 && prodTest.warnings[0]?.name === "PAYMENT_SECRET_KEY"
    && !JSON.stringify(prodBad).includes("sk_live_x"), JSON.stringify(prodBad));

  prov.mode = "ok";
  const { rows: [u2] } = await query(`INSERT INTO users (name, email, password_hash, confirmed_adult, email_verified_at) VALUES ('مشترك 2', $1, 'x', true, now()) RETURNING id`, [`pay2-${crypto.randomBytes(3).toString("hex")}@kanaf.test`]);
  r = await call("/api/payments/create-invoice", { planId: "monthly" }, issueAccessToken({ id: u2.id }));
  ok("P5 المسار السليم كما كان: 201 ورابط صفحة الدفع", r.status === 201 && /^https:\/\/checkout\.test\//.test(r.body.checkoutUrl), JSON.stringify(r));
  /* P6 أمر التشخيص للمالك (Render Shell): يرى المفتاح المرفوض والضغطات الفاشلة دون أن يُطبع سرّ */
  const { checkPayments } = await import("./ops/check-payments.mjs");
  const lines = [];
  const chk = await checkPayments({ env: { PAYMENT_SECRET_KEY: "sk_live_secretvalue", SERVER_BASE_URL: "https://kanaf-server.onrender.com" },
    fetchImpl: async () => new Response("{}", { status: 401 }), connectionString: process.env.DATABASE_URL || process.env.TEST_DATABASE_URL,
    log: (o, k, v) => lines.push(`${o === null ? "INFO" : o ? "OK" : "CHECK"} ${k} ${v}`) });
  ok("P6 أمر التشخيص: APP_BASE_URL ناقص، والمفتاح مرفوض (401)، وعدد الضغطات الفاشلة، بلا قيمة سرّ في المخرَج",
    chk.blocking.join() === "APP_BASE_URL" && chk.provider === 401 && chk.orphans >= 1 && lines.some((l) => /^CHECK PROVIDER_KEY REJECTED/.test(l))
    && !lines.join("\n").includes("secretvalue"), lines.join(" | "));
} catch (err) { ok("!! توقّف: " + String(err.stack || err).slice(0, 400), false); }
finally { server.close(); await pool.end().catch(() => {}); }

let pass = 0, failN = 0;
for (const [l, c, x] of R) { if (c) { pass++; out(`  PASS  ${l}`); } else { failN++; out(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 500)})` : ""}`); } }
out(`\n  ${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
