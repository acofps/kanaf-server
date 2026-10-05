import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0001 — حواف الاسترداد (R15-11) على مزوّد وهمي
 * (sandbox داخل العملية). LIVE_NOT_VERIFIED: لا شيء هنا يثبت سلوك
 * ميسّر الحي؛ يثبت منطقنا أمام ردود المزوّد الممكنة.
 *
 *  • رفض مؤكد (4xx) → يُحرَّر الحجز وتُسمح إعادة المحاولة.
 *  • نتيجة مجهولة (انقطاع/5xx) → يبقى المبلغ محجوزاً، إعادة المحاولة لا
 *    تنادي المزوّد مرة ثانية.
 *  • حدث المزوّد أو المطابقة يحسمان الحجز القديم دون عدّ المال مرتين.
 *  • استردادان متزامنان → نداء مزوّد واحد.
 *  • فشل الإشعار الدائن بعد نجاح المال → المال سليم والتقرير يرصده.
 */
requireDedicatedDatabase(import.meta.url);
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import pg from "pg";

process.env.PORT = "4639";
process.env.SKIP_PDF_BOOT_CHECK = "1";
process.env.ALLOWED_ORIGINS = "http://127.0.0.1:5173";

/* مزوّد قابل للبرمجة */
const prov = { mode: "ok", calls: [], payments: new Map(), delayMs: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (!href.startsWith("https://api.moyasar.com")) return realFetch(url, opts);
  const path = href.replace("https://api.moyasar.com/v1", "");
  const body = opts.body ? JSON.parse(opts.body) : {};
  const json = (s, p) => new Response(JSON.stringify(p), { status: s, headers: { "Content-Type": "application/json" } });
  if (path === "/invoices") return json(201, { id: `mo_inv_${crypto.randomBytes(3).toString("hex")}`, amount: body.amount, url: "https://checkout.test/x" });
  const m = /^\/payments\/([^/]+)(\/refund)?$/.exec(path);
  if (m) {
    const p = prov.payments.get(m[1]);
    if (!m[2]) return p ? json(200, { ...p, refunded_amount: p.refunded }) : json(404, { message: "nf" });
    prov.calls.push({ id: m[1], amount: body.amount });
    if (prov.delayMs) await new Promise((r) => setTimeout(r, prov.delayMs));
    if (prov.mode === "reject") return json(400, { message: "refund rejected" });
    const amt = body.amount ?? p.amount - p.refunded;
    if (prov.mode === "executeThenDrop") { p.refunded += amt; throw new TypeError("fetch failed: socket hang up"); }
    if (prov.mode === "network") throw new TypeError("fetch failed: ECONNRESET");
    if (prov.mode === "5xx") return json(503, { message: "upstream" });
    p.refunded += amt; p.status = p.refunded >= p.amount ? "refunded" : "paid";
    return json(200, { id: `rf_${crypto.randomBytes(3).toString("hex")}`, ...p, refunded_amount: p.refunded });
  }
  return json(404, { message: "unmocked" });
};
const logs = []; const rl = console.log, re = console.error, rw = console.warn;
console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
await new Promise((r) => setTimeout(r, 300));
const B = "http://127.0.0.1:4639";
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
let cookie;
async function call(method, path, body, extra = {}) {
  const r = await realFetch(B + path, { method, headers: { "Content-Type": "application/json", ...(path.startsWith("/admin") ? { Cookie: cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
async function paidPayment(tag) {
  const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at) VALUES ($1,$2,'x',now()) RETURNING id`, [tag, `${tag}-${crypto.randomBytes(2).toString("hex")}@kanaf.test`]);
  const { rows: [inv] } = await query(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, provider_invoice_id) VALUES ($1,'monthly',29,'pending',$2) RETURNING id, provider_invoice_id`, [u.id, `mo_inv_${tag}`]);
  const pid = `mo_pay_${tag}_${crypto.randomBytes(2).toString("hex")}`;
  prov.payments.set(pid, { id: pid, status: "paid", amount: 2900, refunded: 0, currency: "SAR" });
  const evt = { id: `evt_${pid}`, type: "payment_paid", secret_token: process.env.PAYMENT_WEBHOOK_SECRET,
    data: { id: pid, status: "paid", amount: 2900, currency: "SAR", invoice_id: inv.provider_invoice_id, source: { type: "creditcard", company: "mada", number: "XXXX4444" }, metadata: { kanaf_invoice_id: inv.id } } };
  await call("POST", "/api/payments/webhook", evt);
  const { rows: [p] } = await query(`SELECT id FROM payments WHERE provider_payment_id = $1`, [pid]);
  return { pid, payId: p.id };
}
const refund = (payId, amountSar) => call("POST", `/admin/billing/payments/${payId}/refund`, { reason: "اختبار حواف الاسترداد", ...(amountSar ? { amountSar } : {}) });
const state = async (payId) => (await query(`SELECT p.refunded_amount::float r, p.status,
   (SELECT json_agg(json_build_object('s', status, 'a', amount::float, 'e', error) ORDER BY created_at) FROM refunds WHERE payment_id = p.id) rf
   FROM payments p WHERE p.id = $1`, [payId])).rows[0];

try {
  await query(`INSERT INTO tax_settings (singleton, legal_name, vat_number, address) VALUES (true,'مؤسسة اختبار','399999999900003','جدة') ON CONFLICT (singleton) DO NOTHING`);
  const { rows: [own] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('م','own-r@kanaf.test','x','owner') RETURNING id`);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: own.id, role: "owner", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;

  /* 1) رفض مؤكد */
  const a = await paidPayment("a");
  prov.mode = "reject";
  let r = await refund(a.payId, 10);
  let s = await state(a.payId);
  ok("D1 definite 4xx rejection → 502 provider_refund_failed, hold released", r.status === 502 && r.body.error === "provider_refund_failed" && s.rf[0].s === "failed" && s.r === 0, JSON.stringify([r.body, s]));
  prov.mode = "ok";
  r = await refund(a.payId, 10);
  ok("D2 retry after a definite rejection succeeds once", r.status === 200 && (await state(a.payId)).r === 10, JSON.stringify(r.body));

  /* 2) نتيجة مجهولة: نُفّذ لدى المزوّد وضاع الرد */
  const b = await paidPayment("b");
  prov.mode = "executeThenDrop"; prov.calls = [];
  r = await refund(b.payId);
  s = await state(b.payId);
  ok("U1 lost response → 502 provider_outcome_unknown (not 'failed')", r.status === 502 && r.body.error === "provider_outcome_unknown", JSON.stringify(r.body));
  ok("U2 reservation stays pending: amount still held", s.rf.length === 1 && s.rf[0].s === "pending" && /^outcome_unknown/.test(s.rf[0].e), JSON.stringify(s.rf));
  prov.mode = "ok";
  r = await refund(b.payId);
  ok("U3 immediate retry refused by the hold — no second provider call", (r.status === 409) && prov.calls.length === 1, `${r.status} ${r.body.error} calls=${prov.calls.length}`);
  /* حدث المزوّد يصل: المال مسجَّل مرة واحدة */
  const evtRef = (pid, total) => ({ id: `evt_rf_${crypto.randomBytes(3).toString("hex")}`, type: "payment_refunded", secret_token: process.env.PAYMENT_WEBHOOK_SECRET,
    data: { id: pid, status: "refunded", amount: 2900, refunded: total, refunded_amount: total, currency: "SAR", source: { type: "creditcard" } } });
  await call("POST", "/api/payments/webhook", evtRef(b.pid, 2900));
  s = await state(b.payId);
  ok("U4 provider event records the money exactly once (29 refunded)", s.r === 29 && s.rf.filter((x) => x.s === "succeeded").length === 1, JSON.stringify(s));
  ok("U5 a fresh pending hold is NOT released yet (< 10 min, could be in flight)", s.rf.some((x) => x.s === "pending"));
  await query(`UPDATE refunds SET updated_at = now() - interval '11 minutes' WHERE payment_id = $1 AND status = 'pending'`, [b.payId]);
  await call("POST", "/api/payments/webhook", evtRef(b.pid, 2900));   // تسليم مكرر بنفس الإجمالي
  s = await state(b.payId);
  ok("U6 stale hold released once totals match; money still counted once", s.r === 29 && !s.rf.some((x) => x.s === "pending") && s.rf.filter((x) => x.s === "succeeded").length === 1, JSON.stringify(s.rf));

  /* 3) نتيجة مجهولة: لم يُنفَّذ لدى المزوّد (5xx) → المطابقة تحرّر */
  const c = await paidPayment("c");
  prov.mode = "5xx";
  r = await refund(c.payId, 5);
  ok("X1 5xx is treated as unknown, not as a rejection", r.status === 502 && r.body.error === "provider_outcome_unknown");
  await query(`UPDATE refunds SET updated_at = now() - interval '11 minutes' WHERE payment_id = $1 AND status = 'pending'`, [c.payId]);
  prov.mode = "ok";
  r = await call("POST", `/admin/billing/payments/${c.payId}/reconcile`, { reason: "حسم نتيجة مجهولة" });
  ok("X2 reconcile sees provider total 0 = recorded 0 → releases the hold", r.status === 200 && r.body.releasedHolds === 1, JSON.stringify(r.body));
  r = await refund(c.payId, 5);
  s = await state(c.payId);
  ok("X3 after release a genuine retry refunds exactly once", r.status === 200 && s.r === 5, JSON.stringify(s));

  /* 4) تزامن */
  const d = await paidPayment("d");
  prov.mode = "ok"; prov.calls = []; prov.delayMs = 300;
  const both = await Promise.all([refund(d.payId), refund(d.payId)]);
  prov.delayMs = 0;
  ok("C1 two simultaneous full refunds → one provider call, one success, one 409", prov.calls.length === 1 && both.filter((x) => x.status === 200).length === 1 && both.filter((x) => x.status === 409).length === 1, JSON.stringify(both.map((x) => [x.status, x.body.error])));

  /* 5) فشل الإشعار الدائن بعد نجاح المال */
  const e = await paidPayment("e");
  const su = new pg.Client({ connectionString: process.env.SUPERUSER_URL }); await su.connect();
  await su.query(`REVOKE ALL ON SEQUENCE kanaf_credit_note_number_seq FROM ${process.env.APP_ROLE}`);
  r = await refund(e.payId, 7);
  await su.query(`GRANT USAGE, SELECT ON SEQUENCE kanaf_credit_note_number_seq TO ${process.env.APP_ROLE}`); await su.end();
  s = await state(e.payId);
  ok("P1 credit-note failure does not undo the money: refund recorded", r.status === 200 && s.r === 7 && s.rf[0].s === "succeeded" && !r.body.creditNoteNumber, JSON.stringify(r.body));
  const integ = await call("GET", "/admin/billing/integrity");
  const flag = integ.body.checks?.find((x) => x.key === "succeeded_refund_without_credit_note");
  ok("P2 integrity report flags the refund without credit note", flag && flag.count >= 1, JSON.stringify(flag?.count));
} catch (err) { R.push(["!! stopped: " + String(err.stack || err).slice(0, 300), false]); }

console.log = rl; console.error = re; console.warn = rw;
let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
if (f) console.log(logs.slice(-15).join("\n"));
await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
