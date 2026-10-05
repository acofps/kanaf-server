import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0001 — خطة الأمان ودائرة الدعم (R15-01)،
 * طلب حذف الحساب (R15-02)، تصدير البيانات (R15-03)، وتدوير رمز
 * التجديد تحت التزامن (X05).
 *
 * يشغّل index.js الكامل (نفس ترتيب الوسائط في الإنتاج) على قاعدة
 * معزولة مخصّصة. بيانات اصطناعية فقط. Moyasar وهمي داخل العملية؛
 * النموذج غير متاح (الحارس يمنع الشبكة) فمسار المحادثة يُختبر حتى
 * حدود المصادقة وجدار الأمان فقط.
 */
requireDedicatedDatabase(import.meta.url);
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import fs from "node:fs";

const PORT = 4627;
process.env.PORT = String(PORT);
process.env.SKIP_PDF_BOOT_CHECK = "1";
process.env.ALLOWED_ORIGINS = "http://127.0.0.1:5173";

/* Moyasar وهمي — قبل استيراد الخادم */
const realFetch = globalThis.fetch;
let invSeq = 0;
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (!href.startsWith("https://api.moyasar.com")) return realFetch(url, opts);
  const body = opts.body ? JSON.parse(opts.body) : {};
  return new Response(JSON.stringify({ id: `mo_inv_${++invSeq}`, status: "initiated", amount: body.amount, url: "https://checkout.test/x" }),
    { status: 201, headers: { "Content-Type": "application/json" } });
};
const logs = [];
const realLog = console.log, realErr = console.error, realWarn = console.warn;
console.log = (...a) => logs.push(a.join(" "));
console.error = (...a) => logs.push(a.join(" "));
console.warn = (...a) => logs.push(a.join(" "));

await import("./index.js");
const { query, pool } = await import("./db/pool.js");
const { purgeDeletedAccount } = await import("./userdata/account.js");
await new Promise((r) => setTimeout(r, 300));

const B = `http://127.0.0.1:${PORT}`;
const R = [];
const ok = (label, cond, extra = "") => R.push([label, !!cond, extra]);
async function call(method, path, { body, token, cookie } = {}) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  const r = await realFetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text, headers: r.headers };
}

const PW = "Kanaf-Test-2026-a";
async function makeUser(tag) {
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, confirmed_adult, agreed_policy_at, email_verified_at)
     VALUES ($1, $2, $3, true, now(), now()) RETURNING id, email`,
    [`مستخدم ${tag}`, `acct-${tag}-${crypto.randomBytes(3).toString("hex")}@kanaf.test`, await bcrypt.hash(PW, 4)]);
  const login = await call("POST", "/api/auth/login", { body: { email: rows[0].email, password: PW } });
  return { id: rows[0].id, email: rows[0].email, token: login.body.accessToken, refresh: login.body.refreshToken };
}

try {
  const A = await makeUser("a");
  const Bu = await makeUser("b");
  ok("setup: two verified users logged in", A.token && Bu.token, JSON.stringify([!!A.token, !!Bu.token]));

  /* ================= R15-01 خطة الأمان ================= */
  let r = await call("GET", "/api/me/safety-plan", { token: A.token });
  ok("S1 empty plan initially", r.status === 200 && r.body.plan === null && Array.isArray(r.body.contacts) && r.body.contacts.length === 0, JSON.stringify(r.body));
  ok("S1b no-store caching header", r.headers.get("cache-control") === "no-store");

  const MARK = `علامة-خطة-${crypto.randomBytes(4).toString("hex")}`;
  r = await call("PUT", "/api/me/safety-plan", { token: A.token, body: { warningSigns: MARK, copingStrategies: "أتمشى", safePlace: "بيت أهلي" } });
  ok("S2 save plan → 200 version 1", r.status === 200 && r.body.plan?.version === 1 && r.body.plan?.warningSigns === MARK, JSON.stringify(r.body));

  /* «تحديث الصفحة» = جلسة جديدة بالكامل: خروج ثم دخول */
  await call("POST", "/api/auth/logout", { body: { refreshToken: A.refresh } });
  const relog = await call("POST", "/api/auth/login", { body: { email: A.email, password: PW } });
  A.token = relog.body.accessToken; A.refresh = relog.body.refreshToken;
  r = await call("GET", "/api/me/safety-plan", { token: A.token });
  ok("S3 plan survives logout/login (server is source of truth)", r.body.plan?.warningSigns === MARK, JSON.stringify(r.body.plan));

  r = await call("GET", "/api/me/safety-plan", { token: Bu.token });
  ok("S4 another user sees only their own (empty) plan", r.body.plan === null && !r.text.includes(MARK), r.text.slice(0, 100));

  r = await call("PUT", "/api/me/safety-plan", { token: A.token, body: { warningSigns: "قديم", copingStrategies: "", safePlace: "", baseVersion: 0 } });
  ok("S5 stale baseVersion from another device → 409", r.status === 409 && r.body.error === "safety_plan_changed_elsewhere", JSON.stringify(r.body));
  r = await call("GET", "/api/me/safety-plan", { token: A.token });
  ok("S5b rejected save changed nothing", r.body.plan?.warningSigns === MARK && r.body.plan?.version === 1);

  r = await call("PUT", "/api/me/safety-plan", { token: A.token, body: { warningSigns: "x".repeat(2001) } });
  ok("S6 over-long field → 400 field_too_long", r.status === 400 && r.body.error === "field_too_long", JSON.stringify(r.body));

  /* حفظ بلا baseVersion فوق خطة قائمة (تحميل فشل عند الدخول) لا يستبدلها */
  r = await call("PUT", "/api/me/safety-plan", { token: A.token, body: { warningSigns: "استبدال أعمى", copingStrategies: "", safePlace: "" } });
  const afterBlind = await call("GET", "/api/me/safety-plan", { token: A.token });
  ok("S9 a save without baseVersion over an existing plan is refused 409 and the plan is untouched", r.status === 409 && afterBlind.body.plan?.warningSigns === MARK, `${r.status} ${afterBlind.body.plan?.warningSigns}`);
  r = await call("PUT", "/api/me/safety-plan", { token: A.token, body: { warningSigns: MARK, copingStrategies: "أكلم صديق", safePlace: "", baseVersion: 1 } });
  ok("S7 save with current baseVersion → version 2", r.status === 200 && r.body.plan?.version === 2, JSON.stringify(r.body.plan));

  r = await call("GET", "/api/me/safety-plan");
  ok("S8 no token → 401", r.status === 401);

  /* دائرة الدعم */
  r = await call("POST", "/api/me/support-contacts", { token: A.token, body: { name: "أخوي", phone: "05 0000 0001", relationship: "أخ" } });
  ok("C1 add contact → 201 normalised phone", r.status === 201 && r.body.contact?.phone === "0500000001", JSON.stringify(r.body));
  const c1 = r.body.contact?.id;
  r = await call("POST", "/api/me/support-contacts", { token: A.token, body: { name: "x", phone: "abc" } });
  ok("C2 invalid phone → 400", r.status === 400 && r.body.error === "invalid_phone", JSON.stringify(r.body));
  const burst = await Promise.all([1, 2, 3].map((i) => call("POST", "/api/me/support-contacts", { token: A.token, body: { name: `شخص ${i}`, phone: `05000000${10 + i}` } })));
  const created = burst.filter((x) => x.status === 201).length;
  const full = burst.filter((x) => x.status === 409 && x.body.error === "support_circle_full").length;
  ok("C3 three concurrent adds with one slot left → exactly 1 created, 2 rejected", created === 1 && full === 2, JSON.stringify(burst.map((x) => x.status)));
  const { rows: cc } = await query(`SELECT count(*)::int n FROM user_support_contacts WHERE user_id = $1`, [A.id]);
  ok("C4 database holds at most 2 contacts", cc[0].n === 2, String(cc[0].n));
  r = await call("DELETE", `/api/me/support-contacts/${c1}`, { token: Bu.token });
  ok("C5 another user cannot delete my contact (404, not 403)", r.status === 404);
  r = await call("GET", "/api/me/safety-plan", { token: A.token });
  ok("C6 my contact still there after foreign delete attempt", r.body.contacts?.some((c) => c.id === c1));
  r = await call("DELETE", `/api/me/support-contacts/${c1}`, { token: A.token });
  ok("C7 owner deletes contact", r.status === 200);

  /* الخصوصية: لا مسار إداري يقرأ الخطة أو الدائرة */
  const adminFiles = fs.readdirSync("./admin").filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(`./admin/${f}`, "utf8")).join("\n");
  ok("P1 no admin module references user_safety_plans / user_support_contacts", !/user_safety_plans|user_support_contacts/.test(adminFiles));
  const { rows: [adm] } = await query(`INSERT INTO admin_users (name, email, password_hash, role) VALUES ('مالك','owner-acct@kanaf.test','x','owner') RETURNING id`);
  const cookie = `kanaf_admin_access=${jwt.sign({ sub: adm.id, role: "owner", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  const detail = await call("GET", `/admin/users/${A.id}`, { cookie });
  const sens = await call("GET", `/admin/users/${A.id}/sensitive?reason=${encodeURIComponent("اختبار خصوصية")}`, { cookie });
  ok("P2 owner's user detail + sensitive view never contain the plan text", detail.status === 200 && !detail.text.includes(MARK) && !sens.text.includes(MARK), `${detail.status}/${sens.status}`);

  /* مسار الأمان العام بلا حساب */
  r = await call("POST", "/api/crisis-signal", { body: { source: "manual_button" } });
  ok("P3 crisis signal works without any account", r.status === 200 && r.body.ok === true);
  r = await call("POST", "/api/chat", { body: { messages: [{ role: "user", content: "أفكر في الانتحار" }] } });
  ok("P4 crisis firewall answers before auth (no account, no plan needed)", r.status === 200 && r.body.crisis === true, JSON.stringify(r.body));

  /* ================= R15-03 التصدير ================= */
  await call("POST", "/api/me/logs", { token: A.token, body: { mood: 5, sleep: 6, energy: 4, note: `ملاحظة-${MARK}` } });
  const BMARK = `علامة-ب-${crypto.randomBytes(4).toString("hex")}`;
  await call("POST", "/api/me/logs", { token: Bu.token, body: { mood: 3, sleep: 3, energy: 3, note: BMARK } });
  r = await call("POST", "/api/me/export", { token: A.token, body: {} });
  ok("E1 export without password → 400", r.status === 400 && r.body.error === "password_required");
  r = await call("POST", "/api/me/export", { token: A.token, body: { password: "wrong-password-x" } });
  ok("E2 export with wrong password → 401", r.status === 401 && r.body.error === "invalid_password");
  r = await call("POST", "/api/me/export", { token: A.token, body: { password: PW } });
  ok("E3 export OK as attachment, no-store", r.status === 200 && /attachment/.test(r.headers.get("content-disposition") || "") && r.headers.get("cache-control") === "no-store");
  ok("E4 export contains my own log note and safety plan", r.text.includes(`ملاحظة-${MARK}`) && r.body.sections?.safety_plan?.[0]?.warning_signs === MARK);
  ok("E5 export contains nothing of the other user", !r.text.includes(BMARK) && !r.text.includes(Bu.email));
  ok("E6 export carries no hashes or tokens", !/password_hash|pin_hash|token_hash|code_hash|refresh/i.test(r.text));

  /* ================= X05 تدوير رمز التجديد تحت التزامن ================= */
  const pair = await Promise.all([1, 2].map(() => call("POST", "/api/auth/refresh", { body: { refreshToken: A.refresh } })));
  const won = pair.filter((x) => x.status === 200);
  ok("X1 two concurrent refreshes with one token → exactly one succeeds", won.length === 1, JSON.stringify(pair.map((x) => x.status)));
  A.refresh = won[0]?.body.refreshToken; A.token = won[0]?.body.accessToken || A.token;

  /* ================= R15-02 طلب الحذف ================= */
  await call("POST", "/api/me/push/subscribe", { token: A.token, body: { subscription: { endpoint: `https://push.invalid/${MARK}`, keys: { p256dh: "k", auth: "a" } } } });
  const co = await call("POST", "/api/payments/create-invoice", { token: A.token, body: { planId: "monthly" } });
  ok("D0 setup: pending invoice before deletion", co.status === 201, JSON.stringify(co.body).slice(0, 80));

  r = await call("POST", "/api/me/account/delete", { token: A.token, body: { password: PW } });
  ok("D1 missing explicit confirmation → 400", r.status === 400 && r.body.error === "confirmation_required");
  r = await call("POST", "/api/me/account/delete", { token: A.token, body: { password: "wrong-password-x", confirm: "DELETE" } });
  ok("D2 wrong password → 401, account untouched", r.status === 401 && (await query(`SELECT deleted_at FROM users WHERE id=$1`, [A.id])).rows[0].deleted_at === null);
  r = await call("POST", "/api/me/account/delete", { token: A.token, body: { password: PW, confirm: "DELETE" } });
  ok("D3 delete request → deactivated, sessions revoked", r.status === 200 && r.body.status === "deactivated" && r.body.sessionsRevoked >= 1, JSON.stringify(r.body));
  ok("D3b push subscription removed", r.body.pushRemoved === 1, String(r.body.pushRemoved));
  r = await call("POST", "/api/auth/refresh", { body: { refreshToken: A.refresh } });
  ok("D4 refresh token dead after deletion", r.status === 401, String(r.status));
  r = await call("GET", "/api/me/safety-plan", { token: A.token });
  ok("D5 still-unexpired access token rejected on data routes", r.status === 401 && r.body.error === "account_not_found", JSON.stringify(r.body));
  r = await call("POST", "/api/chat", { token: A.token, body: { messages: [{ role: "user", content: "مرحبا" }] } });
  ok("D6 deleted account cannot spend model cost via /api/chat", r.status === 401, String(r.status));
  r = await call("POST", "/api/auth/login", { body: { email: A.email, password: PW } });
  ok("D7 login refused with the generic error (no disclosure)", r.status === 401 && r.body.error === "invalid_credentials", JSON.stringify(r.body));
  const { rows: [st] } = await query(`SELECT u.reminders_on, u.marketing_opt_out, (SELECT count(*)::int FROM account_deletion_requests WHERE user_id=u.id) req FROM users u WHERE id=$1`, [A.id]);
  ok("D8 reminders off, marketing opt-out, request recorded", st.reminders_on === false && st.marketing_opt_out === true && st.req === 1, JSON.stringify(st));

  /* حدث دفع يصل بعد الحذف */
  const sessionsBefore = (await query(`SELECT count(*)::int n FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL`, [A.id])).rows[0].n;
  const { rows: [inv] } = await query(`SELECT id, provider_invoice_id FROM invoices WHERE id = $1`, [co.body.invoiceId]);
  const evt = { id: `evt_${crypto.randomUUID()}`, type: "payment_paid", secret_token: process.env.PAYMENT_WEBHOOK_SECRET, live: false,
    data: { id: `mo_pay_${crypto.randomBytes(3).toString("hex")}`, status: "paid", amount: 2900, currency: "SAR", invoice_id: inv.provider_invoice_id,
      source: { type: "creditcard", company: "mada", number: "XXXX4444" }, metadata: { kanaf_invoice_id: inv.id } } };
  r = await call("POST", "/api/payments/webhook", { body: evt });
  ok("D9 late payment webhook is still recorded (money is not lost)", r.status === 200, JSON.stringify(r.body));
  const { rows: [after] } = await query(`SELECT deleted_at IS NOT NULL AS still_deleted,
      (SELECT count(*)::int FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL) live_sessions FROM users WHERE id=$1`, [A.id]);
  ok("D10 webhook did not revive the account nor mint a session", after.still_deleted && after.live_sessions === sessionsBefore && sessionsBefore === 0, JSON.stringify(after));
  r = await call("POST", "/api/auth/login", { body: { email: A.email, password: PW } });
  ok("D11 still cannot log in after the webhook", r.status === 401);

  /* إعادة التسجيل بنفس البريد = حساب جديد لا يرى شيئاً من القديم */
  const { rows: [fresh] } = await query(`INSERT INTO users (name, email, password_hash, confirmed_adult, email_verified_at)
    VALUES ('جديد', $1, $2, true, now()) RETURNING id`, [A.email, await bcrypt.hash(PW, 4)]);
  const fl = await call("POST", "/api/auth/login", { body: { email: A.email, password: PW } });
  r = await call("GET", "/api/me/safety-plan", { token: fl.body.accessToken });
  ok("D12 same e-mail re-registered gets a new, empty account", fresh.id !== A.id && r.status === 200 && r.body.plan === null, JSON.stringify(r.body));

  /* الحذف النهائي — مختبَر هنا، غير مفعّل في أي مسار (D-01) */
  let threw = null; try { await purgeDeletedAccount(A.id); } catch (e) { threw = e.message; }
  ok("D13 purge refuses without an explicit policy", threw === "purge_policy_required", threw);
  threw = null; try { await purgeDeletedAccount(Bu.id, { policy: "test" }); } catch (e) { threw = e.message; }
  ok("D14 purge refuses an account that was not deactivated", threw === "account_not_deactivated", threw);
  const invBefore = (await query(`SELECT count(*)::int n FROM invoices WHERE user_id=$1`, [A.id])).rows[0].n;
  const counts = await purgeDeletedAccount(A.id, { policy: "TEST_ONLY_not_an_approved_policy" });
  const { rows: [left] } = await query(`SELECT
      (SELECT count(*)::int FROM daily_logs WHERE user_id=$1) logs,
      (SELECT count(*)::int FROM user_safety_plans WHERE user_id=$1) plans,
      (SELECT count(*)::int FROM user_support_contacts WHERE user_id=$1) contacts,
      (SELECT count(*)::int FROM invoices WHERE user_id=$1) invoices,
      (SELECT email FROM users WHERE id=$1) email`, [A.id]);
  ok("D15 purge removes psychological data", left.logs === 0 && left.plans === 0 && left.contacts === 0, JSON.stringify(counts));
  ok("D16 purge keeps financial records (invoice count unchanged)", left.invoices === invBefore && invBefore >= 1, `${invBefore} → ${left.invoices}`);
  ok("D17 purge anonymises the user row", left.email !== A.email && /@deleted\.invalid$/.test(left.email), left.email);
  const bLogs = (await query(`SELECT count(*)::int n FROM daily_logs WHERE user_id=$1`, [Bu.id])).rows[0].n;
  ok("D18 other user's data untouched", bLogs === 1, String(bLogs));
} catch (e) {
  R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]);
}

console.log = realLog; console.error = realErr; console.warn = realWarn;
let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) console.log(logs.slice(-15).join("\n"));
await pool.end().catch(() => {});
process.exit(fail ? 1 : 0);
