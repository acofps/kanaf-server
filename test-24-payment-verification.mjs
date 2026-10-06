/**
 * KANAF-ORD-0003 N-02 — التحقق المالي لحدث الدفع، عبر المسار الحقيقي (Express + القاعدة المعزولة).
 *
 * التشخيص المطلوب إثباته (يفشل هذا الملف على b3f17aa، والسجل NEGATIVE في test-support/.local/logs/ord0003):
 *   حدث payment_paid أصيل التوقيع كان يُطابَق بفاتورتنا بأول معرّف يطابق، ثم يفعّل الاشتراك ويصدر الوثيقة
 *   دون أي مقارنة لمبلغه أو عملته أو حالته بما أُنشئت به الفاتورة. حدث بمبلغ هللة واحدة يفعّل باقة 29 ر.س.
 *
 * الأقسام:
 *   A — المطابقة المحلية (أ): المبلغ بالهللة حرفياً، العملة، ربط الكيان، الحالات والتكرار، التزامن، الفواتير القديمة.
 *   C — المحقق الواحد للمنافذ الثلاثة (ج): webhook / replay / reconcile / recheck، النتائج الخمس، 200 = استلام،
 *       مسار استعادة بلا صف payments، شاشة الاستثناءات وصلاحياتها (Direct API)، لا «اعتبرها مدفوعة».
 *   B — تحقق المزوّد خلف مفتاح (ب): معطّل افتراضياً، مهلة ومحاولتان، لا قفل أثناء الاتصال، إعادة التحقق تحت القفل.
 *   R — حدث الاسترداد: إجمالي غائب/غير صالح/عملة مختلفة ← معلّق بلا أثر.
 * المزوّد مزيّف بالكامل (لا طلب واحد إلى api.moyasar.com).
 */
import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { query, pool } from "./db/pool.js";

process.env.KANAF_PAYMENT_PROVIDER_TIMEOUT_MS = "400"; // قبل استيراد moyasar.js
delete process.env.KANAF_PAYMENT_PROVIDER_VERIFY;       // الافتراضي: معطّل

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);

/* ---------- مزوّد مزيّف ---------- */
const prov = { payments: new Map(), mode: "ok", calls: 0, gate: null, live: 0, n: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (!href.startsWith("https://api.moyasar.com")) return realFetch(url, opts);
  const u = new URL(href);
  if (u.pathname === "/v1/invoices" && opts.method === "POST") {
    const body = JSON.parse(opts.body);
    const id = `mo_inv_${++prov.n}`;
    return new Response(JSON.stringify({ id, amount: body.amount, currency: body.currency, url: `https://checkout.test/${id}` }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  const m = /^\/v1\/payments\/([^/]+)$/.exec(u.pathname);
  if (m && (!opts.method || opts.method === "GET")) {
    prov.calls++; prov.live++;
    try {
      if (prov.gate) await prov.gate.promise;
      if (prov.mode === "fail") return new Response(JSON.stringify({ message: "unavailable" }), { status: 503 });
      if (prov.mode === "hang") return await new Promise((_, rej) => opts.signal?.addEventListener("abort", () => rej(opts.signal.reason)));
      const p = prov.payments.get(m[1]);
      return p ? new Response(JSON.stringify(p), { status: 200 }) : new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    } finally { prov.live--; }
  }
  throw new Error(`unexpected provider call ${opts.method || "GET"} ${href}`);
};
const gate = () => { let release; const promise = new Promise((r) => { release = r; }); prov.gate = { promise, release }; return prov.gate; };

const { paymentsRouter } = await import("./payments/routes.js");
const { adminRouter } = await import("./admin/routes.js");
const { issueAccessToken } = await import("./auth/tokens.js");
const app = express();
app.set("trust proxy", 1); app.use(express.json()); app.use(cookieParser());
app.use("/api/payments", paymentsRouter); app.use("/admin", adminRouter);
const server = app.listen(0); const B = `http://127.0.0.1:${server.address().port}`;

const realLog = console.log, realErr = console.error, realWarn = console.warn; const noise = [];
console.log = (...a) => noise.push(a.join(" ")); console.error = (...a) => noise.push(a.join(" ")); console.warn = (...a) => noise.push(a.join(" "));

let AS = null; // الدور الإداري الحالي
const ADMINS = {};
const adminCookie = () => AS ? `kanaf_admin_access=${jwt.sign({ sub: ADMINS[AS], role: AS, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}` : null;
async function req(m, p, b, t) {
  const h = { "Content-Type": "application/json" };
  if (p.startsWith("/admin")) { const c = adminCookie(); if (c) h.Cookie = c; }
  if (t) h.Authorization = `Bearer ${t}`;
  const r = await realFetch(B + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const asAdmin = async (role, m, p, b) => { const prev = AS; AS = role; try { return await req(m, p, b); } finally { AS = prev; } };

let U = 0;
async function mkUser() {
  const { rows } = await query(`INSERT INTO users (name, email, password_hash, confirmed_adult, email_verified_at)
                                VALUES ($1, $2, 'x', true, now()) RETURNING id`, [`دفع ${++U}`, `pv-${U}-${crypto.randomBytes(3).toString("hex")}@kanaf.test`]);
  return { id: rows[0].id, token: issueAccessToken({ id: rows[0].id }) };
}
async function newInvoice(plan = "monthly") {
  const u = await mkUser();
  const r = await req("POST", "/api/payments/create-invoice", { planId: plan }, u.token);
  if (r.status !== 201) throw new Error(`create-invoice ${r.status} ${JSON.stringify(r.body)}`);
  const { rows } = await query(`SELECT provider_invoice_id FROM invoices WHERE id = $1`, [r.body.invoiceId]);
  return { id: r.body.invoiceId, prov: rows[0].provider_invoice_id, user: u };
}
let P = 0;
const pay = (inv, over = {}) => ({
  id: `mo_pay_${++P}`, status: "paid", amount: 2900, currency: "SAR", invoice_id: inv.prov,
  source: { type: "creditcard", company: "mada", number: "XXXX4444" }, metadata: { kanaf_invoice_id: inv.id }, ...over,
});
const hook = (type, data) => req("POST", "/api/payments/webhook", { id: `evt_${crypto.randomUUID()}`, type, secret_token: process.env.PAYMENT_WEBHOOK_SECRET, data });
async function st(inv) {
  const { rows: [i] } = await query(`SELECT status, provider_payment_id, zatca_invoice_number FROM invoices WHERE id = $1`, [inv.id]);
  const { rows: [s] } = await query(`SELECT count(*)::int n FROM subscriptions WHERE user_id = $1`, [inv.user.id]);
  const { rows: [p] } = await query(`SELECT count(*)::int n FROM payments WHERE invoice_id = $1`, [inv.id]);
  let holds = [];
  try { ({ rows: holds } = await query(`SELECT * FROM payment_event_holds WHERE invoice_id = $1 OR provider_payment_id = ANY($2) ORDER BY created_at`, [inv.id, inv.pids || []])); } catch {}
  return { inv: i.status, invNo: i.zatca_invoice_number, subs: s.n, pays: p.n, holds, open: holds.filter((h) => h.status === "open") };
}
const lastEvent = async (pid) => (await query(`SELECT id, status, outcome FROM webhook_events WHERE object_id = $1 ORDER BY received_at DESC LIMIT 1`, [pid])).rows[0];
const notActivated = (s) => s.inv === "pending" && s.subs === 0 && s.invNo === null;
const brief = (s) => JSON.stringify({ inv: s.inv, subs: s.subs, pays: s.pays, open: s.open.map((h) => h.reason) });

/* حالة «لا تفعيل + معلّق بسبب محدد»: الحدث رد 200 (استلام فقط) والحدث مسجل ignored */
async function expectHeld(label, inv, data, reason, type = "payment_paid") {
  inv.pids = [...(inv.pids || []), data.id].filter(Boolean);
  const w = await hook(type, data);
  const s = await st(inv);
  const ev = data.id ? await lastEvent(data.id) : null;
  ok(`${label} → no activation, held «${reason}», 200 = receipt only`,
    w.status === 200 && notActivated(s) && s.open.some((h) => h.reason === reason) && (!ev || ev.status === "ignored"),
    `http ${w.status} ${JSON.stringify(w.body)} ${brief(s)} ev=${ev?.status}`);
  return s;
}

try {
  requireDedicatedDatabase(import.meta.url);
  await query(`INSERT INTO subscription_plans (plan_key,name,price_sar,duration_days,display_order)
               VALUES ('monthly','الباقة الشهرية',29.00,30,1), ('yearly','الباقة السنوية',290.00,365,2) ON CONFLICT (plan_key) DO NOTHING`);
  await query(`INSERT INTO billing_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`);
  await query(`INSERT INTO tax_settings (singleton,legal_name,vat_number) VALUES (true,'مؤسسة كنف','300000000000003')
               ON CONFLICT (singleton) DO UPDATE SET legal_name=EXCLUDED.legal_name`);
  for (const role of ["owner", "admin", "accountant", "support", "content_manager"]) {
    ADMINS[role] = crypto.randomUUID();
    /* المحاسب يُخزَّن حساب support + إسناد دور (قيد admin_users القديم؛ كما في test-14) */
    await query(`INSERT INTO admin_users (id,name,email,password_hash,role) VALUES ($1,$2,$3,'x',$4)`, [ADMINS[role], role, `${role}@pv.test`, role === "accountant" ? "support" : role]);
    if (role === "accountant") await query(`INSERT INTO admin_role_assignments (admin_user_id, role) VALUES ($1,'accountant')`, [ADMINS[role]]);
  }

  /* ================= A — المطابقة المحلية ================= */
  let inv = await newInvoice();
  let exp = []; try { ({ rows: exp } = await query(`SELECT amount_halalas::int a, currency FROM invoice_payment_expectations WHERE invoice_id = $1`, [inv.id])); } catch {}
  ok("A0 creating an invoice records its expected amount (halalas) and currency in the same transaction", exp[0]?.a === 2900 && exp[0]?.currency === "SAR", JSON.stringify(exp));

  await expectHeld("A1 DIAGNOSIS a genuine payment_paid for 1 halala on a 29 SAR invoice", inv, pay(inv, { amount: 1 }), "amount_mismatch");
  await expectHeld("A2 amount 2899 (one halala short)", inv, pay(inv, { amount: 2899 }), "amount_mismatch");
  await expectHeld("A3 amount 29 (riyals sent where halalas are required)", inv, pay(inv, { amount: 29 }), "amount_mismatch");
  await expectHeld("A4 amount 2900.5 (not an integer)", inv, pay(inv, { amount: 2900.5 }), "amount_invalid");
  await expectHeld("A5 amount \"2900\" (string)", inv, pay(inv, { amount: "2900" }), "amount_invalid");
  await expectHeld("A6 amount missing", inv, pay(inv, { amount: undefined }), "amount_missing");
  await expectHeld("A7 currency USD", inv, pay(inv, { currency: "USD" }), "currency_mismatch");
  await expectHeld("A8 currency missing", inv, pay(inv, { currency: undefined }), "currency_missing");
  await expectHeld("A9 currency \"sar\" (not ISO upper-case)", inv, pay(inv, { currency: "sar" }), "currency_invalid");
  await expectHeld("A10 payment_paid whose payment status is \"failed\"", inv, pay(inv, { status: "failed" }), "status_mismatch");
  const other = await newInvoice();
  await expectHeld("A11 entity link: provider invoice id of one invoice, metadata of another", inv, pay(inv, { metadata: { kanaf_invoice_id: other.id } }), "invoice_identity_conflict");
  {
    const d = pay(inv, { id: undefined });
    const w = await hook("payment_paid", d); const s = await st(inv);
    const { rows: mh } = await query(`SELECT 1 FROM payment_event_holds WHERE reason = 'missing_payment_id' AND status = 'open'`).catch(() => ({ rows: [] }));
    ok("A12 payment id missing → no activation, held «missing_payment_id»", w.status === 200 && notActivated(s) && mh.length === 1, `${w.status} ${brief(s)} holds=${mh.length}`);
  }
  {
    const before = await st(inv);
    const d = pay(inv, { amount: 1 }); inv.pids.push(d.id);
    await hook("payment_paid", d); await hook("payment_paid", d); // تسليم مكرر بمعرّف حدث مختلف (مفتاح التكرار يشمل معرّف الحدث)
    const { rows } = await query(`SELECT seen_count FROM payment_event_holds WHERE provider_payment_id = $1 AND status='open'`, [d.id]).catch(() => ({ rows: [] }));
    ok("A13 a repeated mismatching delivery keeps one open hold (seen_count 2), still no activation",
      rows.length === 1 && rows[0].seen_count === 2 && notActivated(await st(inv)) && before.subs === 0, JSON.stringify(rows));
  }
  {
    const d = pay(inv, { metadata: {}, invoice_id: "mo_inv_unknown" });
    const w = await hook("payment_paid", d); const ev = await lastEvent(d.id);
    ok("A14 a payment for no invoice of ours → unmatched_invoice, ignored, nothing activated", w.status === 200 && ev?.status === "ignored" && /unmatched_invoice/.test(JSON.stringify(ev?.outcome)), `${w.status} ${ev?.status}`);
  }
  /* الصحيح يقبل، ويحل المعلّقات لنفس الدفعة إن وُجدت */
  const good = pay(inv); inv.pids.push(good.id);
  let w = await hook("payment_paid", good);
  let s = await st(inv);
  ok("A15 the exact event (2900 halalas, SAR, same invoice, status paid) activates once", w.status === 200 && s.inv === "paid" && s.subs === 1 && s.pays === 1 && /^INV-KANAF-/.test(s.invNo || ""), `${w.status} ${JSON.stringify(w.body)} ${brief(s)}`);
  w = await hook("payment_paid", good);
  s = await st(inv);
  ok("A16 the same payment again (new event id) → duplicate, no second subscription or payment", w.status === 200 && s.subs === 1 && s.pays === 1 && (w.body.duplicate || /payment_already_recorded/.test(w.body.outcome || "")), JSON.stringify(w.body));
  await (async () => {
    const d = pay(inv); inv.pids.push(d.id);
    const w2 = await hook("payment_paid", d); const s2 = await st(inv);
    ok("A17 a second, different payment for an already-paid invoice → held «second_payment_for_paid_invoice», no second subscription",
      w2.status === 200 && s2.subs === 1 && s2.pays === 1 && s2.open.some((h) => h.reason === "second_payment_for_paid_invoice"), `${JSON.stringify(w2.body)} ${brief(s2)}`);
  })();

  /* لقطة المتوقع: تغيير سعر الباقة وعملة الإعدادات بعد إنشاء الفاتورة لا يغيّر ما يُطابَق عليه */
  {
    const i2 = await newInvoice();
    await query(`UPDATE subscription_plans SET price_sar = 39.00 WHERE plan_key = 'monthly'`);
    await query(`UPDATE billing_settings SET currency = 'USD'`);
    const d = pay(i2); i2.pids = [d.id];
    const r = await hook("payment_paid", d); const s2 = await st(i2);
    ok("A18 price and currency changed after the invoice → the invoice's own 2900 SAR still matches", r.status === 200 && s2.inv === "paid" && s2.subs === 1, `${JSON.stringify(r.body)} ${brief(s2)}`);
    await query(`UPDATE subscription_plans SET price_sar = 29.00 WHERE plan_key = 'monthly'`);
    await query(`UPDATE billing_settings SET currency = 'SAR'`);
  }
  /* التزامن */
  {
    const i3 = await newInvoice(); const d = pay(i3); i3.pids = [d.id];
    const rs = await Promise.all([hook("payment_paid", d), hook("payment_paid", d), hook("payment_paid", d)]);
    const s3 = await st(i3);
    ok("A19 three concurrent deliveries of the same payment → one payment, one subscription", rs.every((x) => x.status === 200) && s3.pays === 1 && s3.subs === 1 && s3.inv === "paid", `${rs.map((x) => x.status)} ${brief(s3)}`);
    const i4 = await newInvoice(); const d1 = pay(i4), d2 = pay(i4); i4.pids = [d1.id, d2.id];
    const r2 = await Promise.all([hook("payment_paid", d1), hook("payment_paid", d2)]);
    const s4 = await st(i4);
    ok("A20 two different payments for one invoice at the same time → one accepted, the other held", r2.every((x) => x.status === 200) && s4.pays === 1 && s4.subs === 1 && s4.open.filter((h) => h.reason === "second_payment_for_paid_invoice").length === 1, brief(s4));
  }
  /* الفواتير القديمة (بلا صف متوقع) */
  {
    const u = await mkUser();
    const { rows: [li] } = await query(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, provider_invoice_id, created_at)
      VALUES ($1, 'monthly', 29.00, 'pending', 'mo_inv_legacy_1', now() - interval '1 day') RETURNING id`, [u.id]);
    const L1 = { id: li.id, prov: "mo_inv_legacy_1", user: u };
    await expectHeld("A21 legacy invoice (no expectation row): 1 halala is still refused against amount_sar×100", L1, pay(L1, { amount: 1 }), "amount_mismatch");
    const d = pay(L1); L1.pids.push(d.id);
    const r = await hook("payment_paid", d); const s5 = await st(L1);
    ok("A22 legacy invoice, currency unchanged since it was issued → 2900 SAR accepted", r.status === 200 && s5.inv === "paid" && s5.subs === 1, `${JSON.stringify(r.body)} ${brief(s5)}`);
    const u2 = await mkUser();
    const { rows: [lj] } = await query(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, provider_invoice_id, created_at)
      VALUES ($1, 'monthly', 29.00, 'pending', 'mo_inv_legacy_2', now() - interval '1 day') RETURNING id`, [u2.id]);
    await query(`INSERT INTO admin_action_log (admin_user_id, action, old_value, new_value, reason)
      VALUES ($1, 'update_billing_settings', '{"currency":"USD"}', '{"currency":"SAR"}', 'اختبار')`, [ADMINS.owner]);
    const L2 = { id: lj.id, prov: "mo_inv_legacy_2", user: u2 };
    await expectHeld("A23 legacy invoice issued before a recorded currency change → currency not provable, held", L2, pay(L2), "legacy_currency_unverifiable");
  }

  /* ================= C — المحقق الواحد للمنافذ ================= */
  AS = "owner";
  {
    const i5 = await newInvoice(); const d = pay(i5, { amount: 100 }); i5.pids = [d.id];
    await hook("payment_paid", d);
    const ev = await lastEvent(d.id);
    const rp = await req("POST", `/admin/billing/webhook-events/${ev.id}/replay`, { reason: "اختبار إعادة حدث غير مطابق" });
    const s5 = await st(i5); const ev2 = await lastEvent(d.id);
    ok("C1 replaying a mismatching event goes through the same verifier → still held, event stays ignored, no activation",
      rp.status === 200 && rp.body.held === true && rp.body.ok === false && notActivated(s5) && ev2.status === "ignored", `${rp.status} ${JSON.stringify(rp.body)} ${brief(s5)} ${ev2.status}`);

    /* المطابقة: الدفعة مسجّلة فاشلة، والمزوّد يقول «مدفوعة» لكن بمبلغ خاطئ */
    const i6 = await newInvoice(); const f = pay(i6, { status: "failed" }); i6.pids = [f.id];
    await hook("payment_failed", f);
    const { rows: [prow] } = await query(`SELECT id, status FROM payments WHERE provider_payment_id = $1`, [f.id]);
    prov.payments.set(f.id, { ...f, status: "paid", amount: 2800 });
    const rc = await req("POST", `/admin/billing/payments/${prow.id}/reconcile`, { reason: "اختبار مطابقة بمبلغ خاطئ" });
    const s6 = await st(i6);
    ok("C2 reconcile with the provider reporting paid but 2800 halalas → held amount_mismatch, no activation", rc.status === 200 && rc.body.held === true && rc.body.holdReason === "amount_mismatch" && s6.inv !== "paid" && s6.subs === 0 && s6.invNo === null, `${rc.status} ${JSON.stringify(rc.body)} ${brief(s6)}`);
    prov.payments.set(f.id, { ...f, status: "paid", amount: 2900 });
    const rc2 = await req("POST", `/admin/billing/payments/${prow.id}/reconcile`, { reason: "اختبار مطابقة صحيحة" });
    const s7 = await st(i6);
    ok("C3 reconcile once the provider reports the exact amount → activates and resolves the hold", rc2.status === 200 && rc2.body.ok === true && s7.inv === "paid" && s7.subs === 1 && s7.open.length === 0, `${JSON.stringify(rc2.body)} ${brief(s7)}`);

    /* الاستثناءات: القائمة والصلاحيات */
    const L = await req("GET", "/admin/billing/payment-holds?status=open");
    const row = (L.body.holds || []).find((h) => h.providerPaymentId === d.id);
    ok("C4 the exceptions list shows the held event with reason, expected and received (no raw payload)",
      L.status === 200 && row && row.reason === "amount_mismatch" && row.expected?.amount === 2900 && row.received?.amount === 100 && !("payload" in row) && row.nextStep,
      JSON.stringify(row || L.body).slice(0, 200));
    const perms = {
      accountantList: (await asAdmin("accountant", "GET", "/admin/billing/payment-holds")).status,
      supportList: (await asAdmin("support", "GET", "/admin/billing/payment-holds")).status,
      contentList: (await asAdmin("content_manager", "GET", "/admin/billing/payment-holds")).status,
      accountantRecheck: (await asAdmin("accountant", "POST", `/admin/billing/payment-holds/${row?.id}/recheck`, { reason: "محاولة بلا صلاحية" })).status,
      supportDismiss: (await asAdmin("support", "POST", `/admin/billing/payment-holds/${row?.id}/dismiss`, { reason: "محاولة بلا صلاحية" })).status,
      anonList: (await (async () => { const prev = AS; AS = null; try { return (await req("GET", "/admin/billing/payment-holds")).status; } finally { AS = prev; } })()),
    };
    ok("C5 Direct API permissions: payments:view lists (accountant/support 200), content manager 403, no session 401; recheck/dismiss need payments:reconcile (403)",
      perms.accountantList === 200 && perms.supportList === 200 && perms.contentList === 403 && perms.anonList === 401 && perms.accountantRecheck === 403 && perms.supportDismiss === 403, JSON.stringify(perms));
    const noReason = await req("POST", `/admin/billing/payment-holds/${row?.id}/recheck`, {});
    ok("C6 recheck without a written reason → 400", noReason.status === 400, String(noReason.status));
    const rk = await asAdmin("admin", "POST", `/admin/billing/payment-holds/${row?.id}/recheck`, { reason: "إعادة فحص بالحمولة المحفوظة" });
    ok("C7 recheck (admin) re-runs the verifier on the stored payload → still held, nothing activated", rk.status === 200 && rk.body.held === true && notActivated(await st(i5)), JSON.stringify(rk.body));
    for (const path of ["accept", "mark-paid", "approve"]) {
      const x = await req("POST", `/admin/billing/payment-holds/${row?.id}/${path}`, { reason: "لا يوجد" });
      ok(`C8 there is no «make paid» route (/${path} → 404)`, x.status === 404, String(x.status));
    }
    const ds = await req("POST", `/admin/billing/payment-holds/${row?.id}/dismiss`, { reason: "ثبت لدى المزوّد أنه حدث تجريبي" });
    const s8 = await st(i5);
    const { rows: aud } = await query(`SELECT action, reason FROM admin_action_log WHERE action IN ('payment_hold_dismiss','payment_hold_recheck') ORDER BY created_at`);
    ok("C9 dismiss closes the hold with no money effect and is audited with its reason", ds.status === 200 && notActivated(s8) && s8.holds.some((h) => h.id === row?.id && h.status === "dismissed") && aud.some((a) => a.action === "payment_hold_dismiss" && /حدث تجريبي/.test(a.reason)) && aud.some((a) => a.action === "payment_hold_recheck"), `${ds.status} ${JSON.stringify(aud)}`);
    const again = await req("POST", `/admin/billing/payment-holds/${row?.id}/dismiss`, { reason: "مرة ثانية" });
    ok("C10 a closed hold cannot be acted on again (409)", again.status === 409, String(again.status));
    const integ = await req("GET", "/admin/billing/integrity");
    const ih = (integ.body.checks || []).find((c) => c.key === "open_payment_event_holds");
    const { rows: [oc] } = await query(`SELECT count(*)::int n FROM payment_event_holds WHERE status='open'`).catch(() => ({ rows: [{ n: -1 }] }));
    ok("C11 the integrity report counts open holds", ih && ih.count === oc.n && oc.n > 0, JSON.stringify({ ih: ih?.count, open: oc.n }));
  }

  /* ================= B — تحقق المزوّد (خلف مفتاح) ================= */
  {
    const i7 = await newInvoice(); const d = pay(i7); i7.pids = [d.id];
    prov.calls = 0;
    await hook("payment_paid", d);
    ok("B1 the provider check is off by default: a matching event is accepted without any provider call", prov.calls === 0 && (await st(i7)).subs === 1, String(prov.calls));

    process.env.KANAF_PAYMENT_PROVIDER_VERIFY = "1";
    const i8 = await newInvoice(); const d8 = pay(i8); i8.pids = [d8.id];
    prov.payments.set(d8.id, { ...d8 }); prov.calls = 0;
    w = await hook("payment_paid", d8);
    ok("B2 flag on, provider agrees → accepted after one provider read", w.status === 200 && (await st(i8)).subs === 1 && prov.calls === 1, `${JSON.stringify(w.body)} calls=${prov.calls}`);

    const i9 = await newInvoice(); const d9 = pay(i9); i9.pids = [d9.id];
    prov.payments.set(d9.id, { ...d9, amount: 100 });
    await expectHeld("B3 flag on, the event says 2900 but the provider says 100", i9, d9, "provider_disagrees");

    const i10 = await newInvoice(); const d10 = pay(i10); i10.pids = [d10.id];
    prov.mode = "fail"; prov.calls = 0;
    w = await hook("payment_paid", d10);
    let s10 = await st(i10); let ev = await lastEvent(d10.id);
    ok("B4 provider unavailable → limited retry (2 calls), temporary hold, 500 so the provider retries, event kept as failed, no activation",
      w.status === 500 && prov.calls === 2 && notActivated(s10) && s10.open.some((h) => h.kind === "verification_unavailable") && ev.status === "failed", `${w.status} calls=${prov.calls} ${brief(s10)} ${ev.status}`);
    prov.mode = "ok"; prov.payments.set(d10.id, { ...d10 });
    const hid = s10.open.find((h) => h.kind === "verification_unavailable")?.id;
    const rk = await req("POST", `/admin/billing/payment-holds/${hid}/recheck`, { reason: "المزوّد عاد" });
    s10 = await st(i10);
    ok("B5 recovery without any payments row: recheck reads the provider again and activates; the hold is resolved",
      rk.status === 200 && rk.body.ok === true && rk.body.providerChecked === true && s10.subs === 1 && s10.open.length === 0, `${JSON.stringify(rk.body)} ${brief(s10)}`);

    const i11 = await newInvoice(); const d11 = pay(i11); i11.pids = [d11.id];
    prov.mode = "hang"; prov.calls = 0;
    const t0 = Date.now(); w = await hook("payment_paid", d11); const took = Date.now() - t0;
    prov.mode = "ok";
    ok("B6 a hanging provider is cut by the timeout (2 × 400 ms + backoff), temporary hold, no activation", w.status === 500 && took < 4000 && prov.calls === 2 && notActivated(await st(i11)), `took=${took}ms calls=${prov.calls}`);

    /* لا قفل أثناء الاتصال الخارجي، والتحقق يعاد تحت القفل */
    const i12 = await newInvoice(); const d12 = pay(i12); const e12 = pay(i12); i12.pids = [d12.id, e12.id];
    prov.payments.set(d12.id, { ...d12 }); prov.payments.set(e12.id, { ...e12 });
    const g = gate();
    const first = hook("payment_paid", d12);
    for (let k = 0; k < 100 && prov.live === 0; k++) await new Promise((r) => setTimeout(r, 20));
    let lockFree = false;
    { const c = await pool.connect(); try { await c.query("BEGIN"); await c.query(`SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE NOWAIT`, [i12.id]); lockFree = true; } catch { lockFree = false; } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); } }
    ok("B7 while the provider call is pending, the invoice row is not locked (FOR UPDATE NOWAIT succeeds)", prov.live > 0 && lockFree, `live=${prov.live} lockFree=${lockFree}`);
    /* دفعة أخرى تسدد الفاتورة أثناء الانتظار */
    prov.gate = null; const second = await hook("payment_paid", e12);
    g.release(); const r1 = await first;
    const s12 = await st(i12);
    ok("B8 recheck under the lock after the call: another payment settled the invoice meanwhile → the first is held, one subscription",
      second.status === 200 && r1.status === 200 && s12.subs === 1 && s12.pays === 1 && s12.open.some((h) => h.provider_payment_id === d12.id && h.reason === "second_payment_for_paid_invoice"), `${JSON.stringify(r1.body)} ${brief(s12)}`);
    delete process.env.KANAF_PAYMENT_PROVIDER_VERIFY;
  }

  /* ================= R — حدث الاسترداد ================= */
  {
    const i13 = await newInvoice(); const d = pay(i13); i13.pids = [d.id];
    await hook("payment_paid", d);
    const before = (await query(`SELECT status, refunded_amount FROM payments WHERE provider_payment_id = $1`, [d.id])).rows[0];
    const s13 = await expectHeldRefund("R1 refund event without refunded_amount (was treated as a full refund)", i13, { ...d, status: "refunded", refunded_amount: undefined }, "refund_amount_missing", before);
    await expectHeldRefund("R2 refunded_amount above the captured amount", i13, { ...d, status: "refunded", refunded_amount: 99999 }, "refund_amount_invalid", before);
    await expectHeldRefund("R3 refunded_amount in a different currency", i13, { ...d, status: "refunded", refunded_amount: 1000, currency: "USD" }, "refund_currency_mismatch", before);
    const ok4 = await hook("payment_refunded", { ...d, status: "refunded", refunded_amount: 2900 });
    const after = (await query(`SELECT status, refunded_amount FROM payments WHERE provider_payment_id = $1`, [d.id])).rows[0];
    ok("R4 a well-formed full refund is still applied", ok4.status === 200 && after.status === "refunded" && Number(after.refunded_amount) === 29, `${JSON.stringify(ok4.body)} ${JSON.stringify(after)}`);
    void s13;
  }
} catch (e) { R.push(["!! stopped: " + String(e?.stack || e).slice(0, 300), false]); }

async function expectHeldRefund(label, inv, data, reason, before) {
  const w = await hook("payment_refunded", data);
  const now = (await query(`SELECT status, refunded_amount FROM payments WHERE provider_payment_id = $1`, [data.id])).rows[0];
  let holds = []; try { ({ rows: holds } = await query(`SELECT reason FROM payment_event_holds WHERE provider_payment_id = $1 AND event_type = 'payment_refunded' AND status = 'open'`, [data.id])); } catch {}
  ok(`${label} → held «${reason}», payment unchanged`, w.status === 200 && now.status === before.status && Number(now.refunded_amount) === Number(before.refunded_amount) && holds.some((h) => h.reason === reason),
    `${JSON.stringify(w.body)} ${JSON.stringify(now)} ${JSON.stringify(holds)}`);
}

console.log = realLog; console.error = realErr; console.warn = realWarn;
let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  ✔  ${l}`); } else { fail++; console.log(`  ✘  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${pass} ناجح، ${fail} فاشل`);
if (fail) console.log(noise.filter((l) => !/^\[webhook\] payment_/.test(l)).slice(-15).join("\n"));
server.close(); await pool.end();
process.exit(fail ? 1 : 0);
