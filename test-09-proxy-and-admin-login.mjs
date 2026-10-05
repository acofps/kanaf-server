import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0001 — عنوان العميل خلف الوكلاء (R15-07)
 * وتهدئة دخول الإدارة لكل حساب (R15-23).
 *
 * الخادم الكامل بـTRUST_PROXY_HOPS=2 يحاكي سلسلة: عميل → طرف وسيط
 * (Cloudflare مثلاً) → موازن الاستضافة. الطلبات تأتي من loopback
 * (يمثّل الموازن)، و X-Forwarded-For يحمل «العميل، الطرف».
 * هذا قياس للمنطق في بيئة آمنة — لا يثبت عدد الوكلاء الفعلي على
 * الإنتاج (ذلك يحتاج GET /admin/diagnostics/client-ip بعد نشر مأذون).
 */
requireDedicatedDatabase(import.meta.url);
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

process.env.PORT = "4631";
process.env.SKIP_PDF_BOOT_CHECK = "1";
process.env.ALLOWED_ORIGINS = "http://127.0.0.1:5173";
process.env.TRUST_PROXY_HOPS = "2";
const logs = []; const rl = console.log, re = console.error, rw = console.warn;
console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
await new Promise((r) => setTimeout(r, 300));
const B = "http://127.0.0.1:4631";
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const EDGE = "162.158.1.1";
async function call(method, path, { body, xff, cookie } = {}) {
  const h = { "Content-Type": "application/json" };
  if (xff) h["X-Forwarded-For"] = xff;
  if (cookie) h.Cookie = cookie;
  const t0 = Date.now();
  const r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, ms: Date.now() - t0 };
}

try {
  const PW_A = "Admin-Pass-Long-2026-a", PW_B = "Admin-Pass-Long-2026-b";
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('أ','a-admin@kanaf.test',$1,'owner') RETURNING id`, [await bcrypt.hash(PW_A, 12)]);
  const { rows: [bb] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('ب','b-admin@kanaf.test',$1,'admin') RETURNING id`, [await bcrypt.hash(PW_B, 12)]);
  const cookieFor = (id, role) => `kanaf_admin_access=${jwt.sign({ sub: id, role, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "5m" })}`;

  /* ---------- R15-07 ---------- */
  let r = await call("GET", "/admin/diagnostics/client-ip", { cookie: cookieFor(a.id, "owner"), xff: `203.0.113.7, ${EDGE}` });
  ok("P1 diagnostics (owner): with hops=2 the real client is chosen, not the edge", r.status === 200 && r.body.reqIp === "203.0.113.7" && r.body.candidateByHops["1"] === EDGE, JSON.stringify(r.body));
  r = await call("GET", "/admin/diagnostics/client-ip", { cookie: cookieFor(a.id, "owner"), xff: `6.6.6.6, 203.0.113.7, ${EDGE}` });
  ok("P2 spoofed X-Forwarded-For prepended by the client does not change req.ip", r.body.reqIp === "203.0.113.7", JSON.stringify(r.body.reqIp));
  ok("P3 diagnostics never echoes cookies or auth headers", !JSON.stringify(r.body).includes("kanaf_admin_access"));
  r = await call("GET", "/admin/diagnostics/client-ip", { cookie: cookieFor(bb.id, "admin"), xff: `203.0.113.7, ${EDGE}` });
  ok("P4 diagnostics is owner-only (admin → 403)", r.status === 403, String(r.status));

  /* حد /api/ العام (60) لم يعد مشتركاً بين عملاء خلف نفس الطرف */
  const statusesA = [];
  for (let i = 0; i < 61; i++) statusesA.push((await call("POST", "/api/contact", { body: {}, xff: `198.51.100.10, ${EDGE}` })).status);
  r = await call("POST", "/api/contact", { body: {}, xff: `198.51.100.20, ${EDGE}` });
  ok("P5 client A exhausting the /api/ limit gets 429", statusesA.includes(429), JSON.stringify(statusesA.slice(-3)));
  ok("P6 client B behind the same edge is not affected (separate bucket)", r.status === 400, String(r.status));
  r = await call("POST", "/api/contact", { body: {}, xff: `198.51.100.99, 198.51.100.10, ${EDGE}` });
  ok("P7 client A cannot escape its bucket by prepending a fake address", r.status === 429, String(r.status));

  /* ---------- R15-23 ---------- */
  let ip = 1; const fresh = () => `192.0.2.${ip++}, ${EDGE}`; // مهاجم موزّع: عنوان جديد لكل محاولة
  const wrong = [];
  for (let i = 0; i < 5; i++) wrong.push((await call("POST", "/admin/auth/login", { body: { email: "a-admin@kanaf.test", password: "wrong-" + i }, xff: fresh() })).status);
  ok("L1 five wrong passwords from five different addresses → generic 401 each", wrong.every((s) => s === 401), JSON.stringify(wrong));
  r = await call("POST", "/admin/auth/login", { body: { email: "a-admin@kanaf.test", password: PW_A }, xff: fresh() });
  ok("L2 account is now cooled down: even the right password is refused, same generic error", r.status === 401 && r.body.error === "invalid_credentials", JSON.stringify(r.body));
  r = await call("POST", "/admin/auth/login", { body: { email: "b-admin@kanaf.test", password: PW_B }, xff: fresh() });
  ok("L3 another admin on the same network is unaffected", r.status === 200, String(r.status));
  const unknown = await call("POST", "/admin/auth/login", { body: { email: "nobody-here@kanaf.test", password: "whatever-1" }, xff: fresh() });
  const known = await call("POST", "/admin/auth/login", { body: { email: "b-admin@kanaf.test", password: "wrong-x" }, xff: fresh() });
  ok("L4 unknown e-mail gives the identical response", unknown.status === 401 && unknown.body.error === "invalid_credentials");
  ok("L5 unknown e-mail takes comparable time (bcrypt always runs)", unknown.ms >= known.ms * 0.5, `${unknown.ms}ms vs ${known.ms}ms`);
  await query(`UPDATE admin_auth_state SET locked_until = now() - interval '1 second' WHERE admin_user_id = $1`, [a.id]);
  r = await call("POST", "/admin/auth/login", { body: { email: "a-admin@kanaf.test", password: PW_A }, xff: fresh() });
  ok("L6 after the cooldown the owner logs in (no indefinite lock)", r.status === 200, String(r.status));
  const { rows: st } = await query(`SELECT 1 FROM admin_auth_state WHERE admin_user_id = $1`, [a.id]);
  ok("L7 successful login clears the counter", st.length === 0);
  for (let i = 0; i < 25; i++) {
    await query(`UPDATE admin_auth_state SET locked_until = now() - interval '1 second' WHERE admin_user_id = $1`, [a.id]);
    await call("POST", "/admin/auth/login", { body: { email: "a-admin@kanaf.test", password: "wrong-" + i }, xff: fresh() });
  }
  const { rows: [cap] } = await query(`SELECT EXTRACT(EPOCH FROM (locked_until - now()))::int s, failed_count FROM admin_auth_state WHERE admin_user_id = $1`, [a.id]);
  ok("L8 cooldown is capped at 15 minutes even after 25 failures", cap.s <= 15 * 60 && cap.s > 60, JSON.stringify(cap));
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

console.log = rl; console.error = re; console.warn = rw;
let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
if (f) console.log(logs.slice(-12).join("\n"));
await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
