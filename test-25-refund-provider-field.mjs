/**
 * KANAF-ORD-0004 COR-02 — إجمالي المسترد كما يسمّيه المزوّد في كائن الدفعة: `refunded`.
 *
 * التشخيص (يفشل هذا الملف على 955df25 وعلى b3f17aa؛ سجلاه NEGATIVE في test-support/.local/logs/ord0004):
 *   الكود كان يقرأ الإجمالي من `refunded_amount` وحده. وثائق ميسّر العامة (كما قرأها المستشار بخلاصة،
 *   ORD-0004 أ-5) تسمّي الحقل `refunded` ولا تذكر `refunded_amount`. فحدث استرداد بالحقل الموثق كان:
 *   على b3f17aa يُقرأ استرداداً **كاملاً** دائماً (الغائب = كامل)، وعلى 955df25 **يُحجز دائماً** (refund_amount_missing).
 *
 * القرار (payments/verify.js providerRefundedTotal): `refunded` هو المصدر؛ `refunded_amount` اسم بديل
 * يُقبل وحده؛ الحقلان مختلفان ← حجز refund_total_conflict؛ غائبان ← حجز refund_amount_missing.
 * يُقرأ من دالة واحدة في: حدث الاسترداد، مفتاح منع التكرار، رد الاسترداد الإداري، المطابقة.
 * المزوّد مزيّف بالكامل؛ لا طلب إلى api.moyasar.com.
 */
import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { query, pool } from "./db/pool.js";

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);

/* ---------- مزوّد مزيّف بكائن الدفعة الموثق (refunded فقط) ---------- */
const prov = { payments: new Map(), refundExtraHalalas: 0, n: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (!href.startsWith("https://api.moyasar.com")) return realFetch(url, opts);
  const path = href.replace("https://api.moyasar.com/v1", "");
  const body = opts.body ? JSON.parse(opts.body) : {};
  const json = (s, p) => new Response(JSON.stringify(p), { status: s, headers: { "Content-Type": "application/json" } });
  if (path === "/invoices") return json(201, { id: `mo_inv_${++prov.n}`, amount: body.amount, url: "https://checkout.test/x" });
  const m = /^\/payments\/([^/]+)(\/refund)?$/.exec(path);
  if (m) {
    const p = prov.payments.get(m[1]);
    if (!p) return json(404, { message: "nf" });
    if (!m[2]) return json(200, { ...p });
    /* استرداد إداري: يعيد كائن الدفعة بإجماليه في `refunded` وحده (refundExtraHalalas = استرداد سابق
       نُفّذ من لوحة المزوّد ولا نعرفه — يثبت أن الإجمالي يُقرأ من المزوّد لا من حسابنا) */
    const amt = body.amount ?? p.amount - p.refunded;
    p.refunded += amt + prov.refundExtraHalalas; prov.refundExtraHalalas = 0;
    p.status = p.refunded >= p.amount ? "refunded" : "paid";
    return json(200, { id: `rf_${crypto.randomBytes(3).toString("hex")}`, ...p });
  }
  return json(404, { message: "unmocked" });
};

const { paymentsRouter } = await import("./payments/routes.js");
const { adminRouter } = await import("./admin/routes.js");
const app = express();
app.set("trust proxy", 1); app.use(express.json()); app.use(cookieParser());
app.use("/api/payments", paymentsRouter); app.use("/admin", adminRouter);
const server = app.listen(0); const B = `http://127.0.0.1:${server.address().port}`;
const realLog = console.log, realErr = console.error, realWarn = console.warn; const noise = [];
console.log = (...a) => noise.push(a.join(" ")); console.error = (...a) => noise.push(a.join(" ")); console.warn = (...a) => noise.push(a.join(" "));

const ADMIN_ID = crypto.randomUUID();
const cookie = () => `kanaf_admin_access=${jwt.sign({ sub: ADMIN_ID, role: "owner", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
async function req(m, p, b) {
  const r = await realFetch(B + p, { method: m, headers: { "Content-Type": "application/json", ...(p.startsWith("/admin") ? { Cookie: cookie() } : {}) }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const hook = (type, data, id = `evt_${crypto.randomUUID()}`) => req("POST", "/api/payments/webhook", { id, type, secret_token: process.env.PAYMENT_WEBHOOK_SECRET, data });
let N = 0;
/* دفعة مقبولة 29.00 عبر المسار الحقيقي (فاتورة بصف متوقع + حدث «مدفوع» مطابق) */
async function paid() {
  const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,confirmed_adult,email_verified_at) VALUES ($1,$2,'x',true,now()) RETURNING id`, [`r${++N}`, `r${N}-${crypto.randomBytes(2).toString("hex")}@kanaf.test`]);
  const { issueAccessToken } = await import("./auth/tokens.js");
  const t = issueAccessToken({ id: u.id });
  const r = await realFetch(B + "/api/payments/create-invoice", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({ planId: "monthly" }) }).then((x) => x.json());
  const { rows: [inv] } = await query(`SELECT id, provider_invoice_id FROM invoices WHERE id = $1`, [r.invoiceId]);
  const pid = `mo_pay_r${N}_${crypto.randomBytes(2).toString("hex")}`;
  const data = { id: pid, status: "paid", amount: 2900, currency: "SAR", refunded: 0, invoice_id: inv.provider_invoice_id, source: { type: "creditcard", company: "mada", number: "XXXX4444" }, metadata: { kanaf_invoice_id: inv.id } };
  prov.payments.set(pid, { ...data });
  await hook("payment_paid", data);
  const { rows: [p] } = await query(`SELECT id FROM payments WHERE provider_payment_id = $1`, [pid]);
  return { pid, payId: p?.id, data, invoiceId: inv.id };
}
const pay = async (pid) => (await query(`SELECT status, refunded_amount::float AS r FROM payments WHERE provider_payment_id = $1`, [pid])).rows[0];
const openRefundHolds = async (pid) => { try { return (await query(`SELECT id, reason FROM payment_event_holds WHERE provider_payment_id = $1 AND event_type = 'payment_refunded' AND status = 'open'`, [pid])).rows; } catch { return []; } };
const refundEvt = (d, fields) => { const x = { ...d, status: "refunded", ...fields }; delete x.refunded_amount; delete x.refunded; return { ...x, ...fields }; };

try {
  requireDedicatedDatabase(import.meta.url);
  await query(`INSERT INTO subscription_plans (plan_key,name,price_sar,duration_days,display_order) VALUES ('monthly','الباقة الشهرية',29.00,30,1) ON CONFLICT (plan_key) DO NOTHING`);
  await query(`INSERT INTO billing_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`);
  await query(`INSERT INTO tax_settings (singleton,legal_name,vat_number) VALUES (true,'مؤسسة كنف','300000000000003') ON CONFLICT (singleton) DO UPDATE SET legal_name=EXCLUDED.legal_name`);
  await query(`INSERT INTO admin_users (id,name,email,password_hash,role) VALUES ($1,'م','o25@k.test','x','owner')`, [ADMIN_ID]);

  /* ===== webhook بالحقل الموثق ===== */
  let a = await paid();
  ok("F0 setup: a paid payment of 29.00 exists", (await pay(a.pid))?.status === "paid", JSON.stringify(await pay(a.pid)));
  let w = await hook("payment_refunded", refundEvt(a.data, { refunded: 2900 }));
  let p = await pay(a.pid);
  ok("D1 full refund with the documented field only (refunded=2900) → applied: payment refunded, 29.00", w.status === 200 && /refunded_full/.test(w.body.outcome) && p.status === "refunded" && p.r === 29, `${JSON.stringify(w.body)} ${JSON.stringify(p)}`);

  a = await paid();
  w = await hook("payment_refunded", refundEvt(a.data, { refunded: 1000 }));
  p = await pay(a.pid);
  ok("D2 partial refund (refunded=1000) → 10.00 recorded, partially_refunded", /refunded_partial/.test(w.body.outcome) && p.status === "partially_refunded" && p.r === 10, `${JSON.stringify(w.body)} ${JSON.stringify(p)}`);
  w = await hook("payment_refunded", refundEvt(a.data, { refunded: 2000 }));
  p = await pay(a.pid);
  ok("D3 a second partial refund sends the TOTAL (refunded=2000) → +10.00, total 20.00", /refunded_partial/.test(w.body.outcome) && p.r === 20, `${JSON.stringify(w.body)} ${JSON.stringify(p)}`);
  w = await hook("payment_refunded", refundEvt(a.data, { refunded: 2000 }));
  p = await pay(a.pid);
  const { rows: [rc] } = await query(`SELECT count(*)::int n FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.provider_payment_id = $1`, [a.pid]);
  ok("D4 the same total again (new event id) → no new refund row, total stays 20.00", w.status === 200 && p.r === 20 && rc.n === 2, `${JSON.stringify(w.body)} ${JSON.stringify(p)} refunds=${rc.n}`);

  a = await paid();
  w = await hook("payment_refunded", refundEvt(a.data, { refunded: 2900, refunded_amount: 2900 }));
  ok("D5 both fields present and equal → applied", /refunded_full/.test(w.body.outcome) && (await pay(a.pid)).r === 29, JSON.stringify(w.body));

  a = await paid();
  w = await hook("payment_refunded", refundEvt(a.data, { refunded: 1000, refunded_amount: 2900 }));
  p = await pay(a.pid);
  ok("D6 both fields present and different → held «refund_total_conflict», payment unchanged", w.status === 200 && w.body.outcome === "held:refund_total_conflict" && p.status === "paid" && p.r === 0 && (await openRefundHolds(a.pid)).some((h) => h.reason === "refund_total_conflict"), `${JSON.stringify(w.body)} ${JSON.stringify(p)}`);
  w = await hook("payment_refunded", refundEvt(a.data, {}));
  ok("D7 both fields absent → held «refund_amount_missing», payment unchanged (a missing value never becomes an amount)", w.body.outcome === "held:refund_amount_missing" && (await pay(a.pid)).r === 0, JSON.stringify(w.body));
  w = await hook("payment_refunded", refundEvt(a.data, { refunded: 3000 }));
  ok("D8 refunded above the payment (3000 > 2900) → held «refund_amount_invalid»", w.body.outcome === "held:refund_amount_invalid" && (await pay(a.pid)).r === 0, JSON.stringify(w.body));
  w = await hook("payment_refunded", refundEvt(a.data, { refunded: "2900" }));
  ok("D9 refunded as a string → held «refund_amount_invalid»", w.body.outcome === "held:refund_amount_invalid", JSON.stringify(w.body));

  /* ===== المطابقة: المزوّد يقول refunded بالحقل الموثق ===== */
  a = await paid();
  prov.payments.set(a.pid, { ...a.data, status: "refunded", refunded: 2900 });
  const rcn = await req("POST", `/admin/billing/payments/${a.payId}/reconcile`, { reason: "مطابقة استرداد بالحقل الموثق" });
  p = await pay(a.pid);
  ok("D10 reconcile with the provider reporting status refunded and refunded=2900 → applied through the same verifier", rcn.status === 200 && /refunded_full/.test(rcn.body.outcome) && p.status === "refunded" && p.r === 29, `${JSON.stringify(rcn.body)} ${JSON.stringify(p)}`);

  /* ===== حجز من الكود السابق يُحل بإعادة الفحص بعد الإصلاح =====
     الحالة كما تركها 955df25 لحدث بالحقل الموثق: صف webhook_events بالحمولة وحجز refund_amount_missing مفتوح. */
  a = await paid();
  const legacy = refundEvt(a.data, { refunded: 2900 });
  prov.payments.set(a.pid, { ...a.data, status: "refunded", refunded: 2900 });
  const { rows: [ev] } = await query(`INSERT INTO webhook_events (provider, provider_event_id, event_type, dedup_key, object_id, signature_valid, status, payload, outcome)
    VALUES ('moyasar', $1, 'payment_refunded', $2, $3, true, 'ignored', $4::jsonb, '{"outcome":"held:refund_amount_missing"}') RETURNING id`,
    [`evt_legacy_${a.pid}`, `moyasar:payment_refunded:${a.pid}:refunded:legacy`, a.pid, JSON.stringify({ id: `evt_legacy_${a.pid}`, type: "payment_refunded", data: legacy })]);
  const { rows: [hd] } = await query(`INSERT INTO payment_event_holds (kind, reason, source, event_type, webhook_event_id, provider_payment_id, expected, received)
    VALUES ('mismatch','refund_amount_missing','webhook','payment_refunded',$1,$2,'null','{"refunded_amount":null}') RETURNING id`, [ev.id, a.pid]);
  const rk = await req("POST", `/admin/billing/payment-holds/${hd.id}/recheck`, { reason: "إعادة فحص بعد تصحيح اسم الحقل" });
  p = await pay(a.pid);
  const { rows: [hs] } = await query(`SELECT status FROM payment_event_holds WHERE id = $1`, [hd.id]);
  ok("D11 a refund hold left by the previous code (refund_amount_missing on a payload with `refunded`) is resolved by recheck after the fix, and the refund is applied once",
    rk.status === 200 && rk.body.held === false && p.status === "refunded" && p.r === 29 && hs.status === "resolved", `${rk.status} ${JSON.stringify(rk.body)} ${JSON.stringify(p)} hold=${hs.status}`);
  const rk2 = await req("POST", `/admin/billing/payment-holds/${hd.id}/recheck`, { reason: "مرة ثانية" });
  ok("D12 the resolved hold cannot be rechecked again (409) and nothing is refunded twice", rk2.status === 409 && (await pay(a.pid)).r === 29, String(rk2.status));

  /* ===== رد الاسترداد الإداري بالحقل الموثق ===== */
  a = await paid();
  prov.refundExtraHalalas = 500;   // استرداد 5.00 سابق نُفّذ من لوحة المزوّد ولا نعرفه
  const ar = await req("POST", `/admin/billing/payments/${a.payId}/refund`, { amountSar: 10, reason: "اختبار رد المزوّد بالحقل الموثق" });
  p = await pay(a.pid);
  ok("D13 admin refund: the provider's response carries the total only in `refunded` (1500) → our total follows the provider (15.00), not our own sum (10.00)",
    ar.status === 200 && p.r === 15, `${ar.status} ${JSON.stringify(ar.body).slice(0, 160)} ${JSON.stringify(p)}`);

  /* ===== الاسم البديل وحده ما زال مقبولاً ===== */
  a = await paid();
  w = await hook("payment_refunded", refundEvt(a.data, { refunded_amount: 1000 }));
  ok("D14 the legacy name alone (refunded_amount=1000) is accepted as an alias → 10.00", /refunded_partial/.test(w.body.outcome) && (await pay(a.pid)).r === 10, JSON.stringify(w.body));
} catch (e) { R.push(["!! stopped: " + String(e?.stack || e).slice(0, 300), false]); }

console.log = realLog; console.error = realErr; console.warn = realWarn;
let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  ✔  ${l}`); } else { fail++; console.log(`  ✘  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${pass} ناجح، ${fail} فاشل`);
if (fail) console.log(noise.filter((l) => !/^\[webhook\] payment_/.test(l)).slice(-12).join("\n"));
server.close(); await pool.end();
process.exit(fail ? 1 : 0);
