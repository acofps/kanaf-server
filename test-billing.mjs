/**
 * اختبارات القبول للمرحلة 3 — الاشتراك والدفع والفاتورة والضريبة
 * والاسترداد.
 *
 * تشغّل **الموجّهات الحقيقية** (auth + payments + admin) على قاعدة
 * PostgreSQL حقيقية، مع محاكاة Moyasar وحدها — لأن استدعاء بوابة
 * دفع حقيقية في اختبار ليس اختباراً بل صرف مال.
 *
 * التشغيل:
 *   DATABASE_URL=postgresql://... \
 *   USER_JWT_SECRET=$(openssl rand -hex 32) \
 *   ADMIN_JWT_SECRET=$(openssl rand -hex 32) \
 *   PAYMENT_SECRET_KEY=sk_test_fake \
 *   PAYMENT_WEBHOOK_SECRET=test-shared-secret \
 *   NODE_ENV=development AUTH_RATE_LIMIT_MAX=500 \
 *   node test-billing.mjs
 */
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { query, pool } from "./db/pool.js";

/* ============================================================
   محاكاة Moyasar — تسجّل كل نداء حتى نتحقق أن المزوّد نُودي فعلاً
   ============================================================ */
const moyasarCalls = [];
const moyasarState = { payments: new Map(), invoiceSeq: 0, paymentSeq: 0, failRefund: false };
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (!href.startsWith("https://api.moyasar.com")) return realFetch(url, opts);

  const path = href.replace("https://api.moyasar.com/v1", "");
  const body = opts.body ? JSON.parse(opts.body) : {};
  moyasarCalls.push({ path, method: opts.method || "GET", body });

  const json = (status, payload) =>
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

  if (path === "/invoices" && opts.method === "POST") {
    const id = `mo_inv_${++moyasarState.invoiceSeq}`;
    return json(201, { id, status: "initiated", amount: body.amount, currency: body.currency, url: `https://checkout.moyasar.test/${id}` });
  }
  const refundMatch = /^\/payments\/([^/]+)\/refund$/.exec(path);
  if (refundMatch && opts.method === "POST") {
    if (moyasarState.failRefund) return json(400, { message: "refund rejected by provider" });
    const p = moyasarState.payments.get(refundMatch[1]);
    if (!p) return json(404, { message: "payment not found" });
    const requested = body.amount === undefined ? p.amount - p.refunded_amount : body.amount;
    if (requested > p.amount - p.refunded_amount) return json(400, { message: "amount exceeds refundable" });
    p.refunded_amount += requested;
    p.status = p.refunded_amount >= p.amount ? "refunded" : "paid";
    return json(200, { ...p });
  }
  const payMatch = /^\/payments\/([^/]+)$/.exec(path);
  if (payMatch) {
    const p = moyasarState.payments.get(payMatch[1]);
    return p ? json(200, p) : json(404, { message: "not found" });
  }
  if (path === "/webhooks/available_events") {
    return json(200, ["payment_paid", "payment_failed", "payment_refunded", "payment_voided"]);
  }
  return json(404, { message: `unmocked ${path}` });
};

/** ينشئ دفعة لدى المزوّد الوهمي ويعيد حمولة حدث webhook مطابقة لشكل Moyasar. */
function makeWebhookBody(type, { providerInvoiceId, amountSar, metadata, paymentId, refundedSar, message }) {
  const id = paymentId || `mo_pay_${++moyasarState.paymentSeq}`;
  const amount = Math.round(Number(amountSar) * 100);
  const payment = {
    id,
    status: type === "payment_paid" ? "paid" : type === "payment_failed" ? "failed" : type === "payment_refunded" ? "refunded" : "voided",
    amount,
    currency: "SAR",
    refunded: refundedSar !== undefined ? Math.round(refundedSar * 100) : 0,
    refunded_amount: refundedSar !== undefined ? Math.round(refundedSar * 100) : 0,
    invoice_id: providerInvoiceId || null,
    description: "اشتراك كنف+",
    source: { type: "creditcard", company: "mada", number: "XXXXXXXXXXXX4444", message: message || null },
    metadata: metadata || {},
  };
  moyasarState.payments.set(id, payment);
  return {
    id: `evt_${crypto.randomUUID()}`,
    type,
    created_at: new Date().toISOString(),
    secret_token: process.env.PAYMENT_WEBHOOK_SECRET,
    account_name: "kanaf-test",
    live: false,
    data: payment,
  };
}

/* ============================================================
   تهيئة الخادم
   ============================================================ */
const { authRouter } = await import("./auth/routes.js");
const { paymentsRouter } = await import("./payments/routes.js");
const { adminRouter } = await import("./admin/routes.js");

let CURRENT_ADMIN = null;
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);
app.use("/api/payments", paymentsRouter);
app.use("/admin", adminRouter);
const server = app.listen(4599);
const B = "http://127.0.0.1:4599";

function adminCookie() {
  if (!CURRENT_ADMIN) return null;
  const token = jwt.sign({ sub: CURRENT_ADMIN.id, role: CURRENT_ADMIN.role, type: "access" },
    process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" });
  return `kanaf_admin_access=${token}`;
}

async function req(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (path.startsWith("/admin")) { const c = adminCookie(); if (c) headers.Cookie = c; }
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await realFetch(B + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("json") ? await r.json().catch(() => ({})) : await r.text(), raw: r };
}
const get = (p, t) => req("GET", p, undefined, t);
const post = (p, b, t) => req("POST", p, b, t);
const put = (p, b, t) => req("PUT", p, b, t);

/* ---- التقاط أكواد التحقق من مُرسل البريد في وضع التطوير ---- */
const sentMail = [];
const realLog = console.log;
const realErr = console.error;
const noisyLogs = [];
console.log = (...a) => { const l = a.join(" "); if (l.includes("[dev] Would send")) sentMail.push(l); else noisyLogs.push(l); };
console.error = (...a) => { noisyLogs.push(a.join(" ")); };

const results = [];
const log = (label, cond, extra = "") => results.push([label, !!cond, extra]);

async function makeUser(name, email, password = "Kanaf-Test-2026-a") {
  await post("/api/auth/register", { name, email, password, confirmedAdult: true, agreedPolicy: true });
  const entry = [...sentMail].reverse().find((m) => m.toLowerCase().includes(email.toLowerCase()));
  const code = /(\d{6})/.exec(entry)[1];
  const r = await post("/api/auth/verify-email", { email, code });
  const { rows } = await query(`SELECT id FROM users WHERE LOWER(email) = $1`, [email.toLowerCase()]);
  return { id: rows[0].id, email, token: r.body.accessToken, refreshToken: r.body.refreshToken };
}

/** يشتري باقة ويعيد { invoiceId, providerInvoiceId } دون أن يدفع. */
async function startCheckout(user, planId) {
  const r = await post("/api/payments/create-invoice", { planId }, user.token);
  const { rows } = await query(`SELECT provider_invoice_id FROM invoices WHERE id = $1`, [r.body.invoiceId]);
  return { ...r.body, providerInvoiceId: rows[0].provider_invoice_id, httpStatus: r.status };
}

const sendWebhook = (body) => post("/api/payments/webhook", body);

/* ============================================================ */
async function run() {
  const ADMIN_ID = crypto.randomUUID();

  // تنظيف كامل — الاختبار يفترض قاعدة نظيفة.
  await query(`TRUNCATE refunds, webhook_events, payments, invoice_state, subscription_state,
               credit_notes, invoices, subscriptions, admin_action_log, admin_access_log,
               user_sessions, user_auth_state, email_verification_codes, users, admin_users
               RESTART IDENTITY CASCADE`);
  await query(`ALTER SEQUENCE kanaf_invoice_number_seq RESTART WITH 1`);
  await query(`ALTER SEQUENCE kanaf_credit_note_number_seq RESTART WITH 1`);
  // subscription_plans و tax_settings يشيران إلى admin_users، فيمسحهما
  // TRUNCATE ... CASCADE معه. نعيد بذرهما بنفس قيم schema.sql.
  await query(
    `INSERT INTO subscription_plans (plan_key, name, price_sar, duration_days, features, display_order) VALUES
       ('monthly', 'الباقة الشهرية', 29.00, 30, ARRAY['كل أدوات كنف الأربع'], 1),
       ('6_months', 'باقة 6 أشهر', 139.00, 182, ARRAY['خصم مقارنة بالدفع الشهري'], 2),
       ('annual', 'الباقة السنوية', 229.00, 365, ARRAY['أكبر خصم متاح'], 3)
     ON CONFLICT (plan_key) DO NOTHING`
  );
  await query(`INSERT INTO billing_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO UPDATE SET vat_rate = 0.15, currency = 'SAR', reporting_timezone = 'Asia/Riyadh'`);
  await query(`INSERT INTO admin_users (id, name, email, password_hash, role) VALUES ($1,'مالك','owner@kanaf.test','x','owner')`, [ADMIN_ID]);
  await query(`INSERT INTO tax_settings (singleton, legal_name, vat_number, address)
               VALUES (true,'مؤسسة كنف','300000000000003','الرياض')
               ON CONFLICT (singleton) DO UPDATE SET legal_name = EXCLUDED.legal_name`);
  CURRENT_ADMIN = { id: ADMIN_ID, role: "owner" };

  /* ========================================================
     A) اشتراك شهري: تسجيل → دفع → تفعيل → دفعة → فاتورة → لوحة
     ======================================================== */
  const u1 = await makeUser("نورة العتيبي", "noura@kanaf.test");
  const co1 = await startCheckout(u1, "monthly");
  log("A1 إنشاء فاتورة يعيد رابط دفع من المزوّد", co1.httpStatus === 201 && String(co1.checkoutUrl).includes("checkout.moyasar.test"), co1.checkoutUrl);

  let r = await get("/api/payments/subscription", u1.token);
  log("A2 قبل الدفع: لا اشتراك ولا استحقاق", r.body.subscription === null && r.body.entitled === false, JSON.stringify(r.body));

  const paidEvt = makeWebhookBody("payment_paid", { providerInvoiceId: co1.providerInvoiceId, amountSar: 29, metadata: { kanaf_invoice_id: co1.invoiceId } });
  r = await sendWebhook(paidEvt);
  log("A3 الـwebhook قُبل وعالج التفعيل", r.status === 200 && r.body.outcome === "subscription_activated", JSON.stringify(r.body));

  r = await get("/api/payments/subscription", u1.token);
  log("A4 الاشتراك صار فعّالاً بحالة مشتقّة", r.body.subscription?.status === "active" && r.body.entitled === true, JSON.stringify(r.body.subscription?.status));
  log("A5 دورة الفوترة شهرية وتاريخ التجديد بعد 30 يوماً",
    r.body.subscription?.billingCycle === "monthly" &&
    Math.round((new Date(r.body.subscription.renewalDate) - Date.now()) / 86400000) === 30,
    `${r.body.subscription?.billingCycle} / ${r.body.subscription?.renewalDate}`);
  log("A6 لقطة السعر محفوظة مع الاشتراك", Number(r.body.subscription?.priceSar) === 29, String(r.body.subscription?.priceSar));

  const { rows: payRows } = await query(`SELECT * FROM payments WHERE user_id = $1`, [u1.id]);
  log("A7 سُجّلت دفعة واحدة بكيان مستقل", payRows.length === 1 && payRows[0].status === "paid", JSON.stringify(payRows.map((p) => p.status)));
  log("A8 الدفعة تحمل رقم المعاملة وطريقة الدفع", payRows[0]?.provider_payment_id === paidEvt.data.id && payRows[0]?.method === "creditcard", JSON.stringify([payRows[0]?.provider_payment_id, payRows[0]?.method, payRows[0]?.card_last4]));
  log("A9 الدفعة مربوطة بالاشتراك والفاتورة", !!payRows[0]?.subscription_id && payRows[0]?.invoice_id === co1.invoiceId);

  const { rows: invRows } = await query(`SELECT * FROM invoices WHERE id = $1`, [co1.invoiceId]);
  log("A10 الفاتورة مدفوعة ولها رقم ضريبي", invRows[0].status === "paid" && /^INV-\d{4}-000001$/.test(invRows[0].zatca_invoice_number), invRows[0].zatca_invoice_number);
  log("A11 الفاتورة تحمل ملف PDF وحمولة QR", !!invRows[0].pdf_data && !!invRows[0].zatca_qr_payload, String(invRows[0].pdf_data?.length));
  log("A12 الفاتورة مربوطة بالاشتراك (subscription_id لم يعد فارغاً)", !!invRows[0].subscription_id);
  log("A13 تفصيل الضريبة صحيح 29 = 25.22 + 3.78",
    Number(invRows[0].subtotal_sar) === 25.22 && Number(invRows[0].vat_sar) === 3.78,
    `${invRows[0].subtotal_sar} + ${invRows[0].vat_sar}`);

  const { rows: stateRows } = await query(`SELECT * FROM invoice_state WHERE invoice_id = $1`, [co1.invoiceId]);
  log("A14 لقطة البائع والمشتري والنسبة محفوظة مع الفاتورة",
    stateRows[0]?.seller_vat_number === "300000000000003" &&
    stateRows[0]?.buyer_email === "noura@kanaf.test" &&
    Number(stateRows[0]?.vat_rate) === 0.15,
    JSON.stringify([stateRows[0]?.seller_vat_number, stateRows[0]?.buyer_email, stateRows[0]?.vat_rate]));

  r = await get("/api/payments/invoices", u1.token);
  log("A15 المستخدم يرى فاتورته في ملفه الشخصي", r.body.total === 1 && r.body.invoices[0].has_pdf === true, JSON.stringify(r.body.total));
  const pdfRes = await get(`/api/payments/invoices/${co1.invoiceId}/pdf`, u1.token);
  log("A16 المستخدم يقدر يحمّل فاتورته الضريبية", pdfRes.status === 200 && pdfRes.raw.headers.get("content-type") === "application/pdf", String(pdfRes.status));

  r = await get("/admin/billing/subscriptions");
  log("A17 الاشتراك ظاهر في صفحة الاشتراكات بالإدارة", r.body.total === 1 && r.body.subscriptions[0].status === "active", JSON.stringify(r.body.total));
  r = await get("/admin/billing/payments");
  log("A18 الدفعة ظاهرة في صفحة المدفوعات بكل حقولها",
    r.body.total === 1 && r.body.payments[0].transaction_id === paidEvt.data.id && r.body.payments[0].user_email === "noura@kanaf.test",
    JSON.stringify(r.body.payments?.[0] && Object.keys(r.body.payments[0]).length));
  r = await get(`/admin/billing/users/${u1.id}/billing`);
  log("A19 User 360 يجمع الاشتراك والدفعة والفاتورة لنفس المستخدم",
    r.body.subscriptions.length === 1 && r.body.payments.length === 1 && r.body.invoices.length === 1 && Number(r.body.totals.lifetimeNet) === 29,
    JSON.stringify(r.body.totals));

  /* ========================================================
     B) اشتراك سنوي مستقل
     ======================================================== */
  const u2 = await makeUser("فهد القحطاني", "fahad@kanaf.test");
  const co2 = await startCheckout(u2, "annual");
  await sendWebhook(makeWebhookBody("payment_paid", { providerInvoiceId: co2.providerInvoiceId, amountSar: 229 }));
  r = await get("/api/payments/subscription", u2.token);
  log("B1 الاشتراك السنوي فعّال بدورة annual",
    r.body.subscription?.status === "active" && r.body.subscription?.billingCycle === "annual",
    JSON.stringify([r.body.subscription?.status, r.body.subscription?.billingCycle]));
  log("B2 مدة السنوي 365 يوماً لا 30",
    Math.round((new Date(r.body.subscription.renewalDate) - Date.now()) / 86400000) === 365,
    r.body.subscription?.renewalDate);

  const { rows: inv2 } = await query(`SELECT zatca_invoice_number, subtotal_sar, vat_sar FROM invoices WHERE user_id = $1`, [u2.id]);
  log("B3 رقم الفاتورة تسلسلي وفريد", inv2[0].zatca_invoice_number === `INV-${new Date().getFullYear()}-000002`, inv2[0].zatca_invoice_number);
  log("B4 ضريبة السنوي 229 = 199.13 + 29.87", Number(inv2[0].subtotal_sar) === 199.13 && Number(inv2[0].vat_sar) === 29.87, `${inv2[0].subtotal_sar}+${inv2[0].vat_sar}`);

  /* ========================================================
     C) دفع فاشل → لا استحقاق  (+ العطب الحرج: نجاح بعد فشل)
     ======================================================== */
  const u3 = await makeUser("سارة الدوسري", "sara@kanaf.test");
  const co3 = await startCheckout(u3, "monthly");
  r = await sendWebhook(makeWebhookBody("payment_failed", { providerInvoiceId: co3.providerInvoiceId, amountSar: 29, message: "بطاقة مرفوضة" }));
  log("C1 الدفع الفاشل عولج بلا منح استحقاق", r.body.outcome === "payment_failed_no_entitlement_granted", JSON.stringify(r.body));

  r = await get("/api/payments/subscription", u3.token);
  log("C2 لا اشتراك بعد دفع فاشل", r.body.subscription === null && r.body.entitled === false, JSON.stringify(r.body.subscription));

  const { rows: c3inv } = await query(`SELECT status FROM invoices WHERE id = $1`, [co3.invoiceId]);
  log("C3 الفاتورة معلّمة فاشلة", c3inv[0].status === "failed", c3inv[0].status);

  const { rows: c3pay } = await query(`SELECT status, failure_reason FROM payments WHERE user_id = $1`, [u3.id]);
  log("C4 الدفعة الفاشلة مسجّلة بسبب الرفض", c3pay[0]?.status === "failed" && c3pay[0]?.failure_reason === "بطاقة مرفوضة", JSON.stringify(c3pay[0]));

  // 🔴 العطب الأصلي: المحاولة الناجحة بعد الفاشلة كانت تُرفض كـ"مكررة"
  r = await sendWebhook(makeWebhookBody("payment_paid", { providerInvoiceId: co3.providerInvoiceId, amountSar: 29 }));
  log("C5 ★ إعادة المحاولة الناجحة على نفس الفاتورة تُفعّل الاشتراك",
    r.body.outcome === "subscription_activated", JSON.stringify(r.body));
  r = await get("/api/payments/subscription", u3.token);
  log("C6 ★ المستخدم صار مستحقاً بعد نجاح المحاولة الثانية", r.body.entitled === true, JSON.stringify(r.body.subscription?.status));

  const { rows: c3pays } = await query(`SELECT status FROM payments WHERE user_id = $1 ORDER BY created_at`, [u3.id]);
  log("C7 المحاولتان محفوظتان كدفعتين منفصلتين لا واحدة تمحو الأخرى",
    c3pays.length === 2 && c3pays[0].status === "failed" && c3pays[1].status === "paid",
    JSON.stringify(c3pays.map((p) => p.status)));

  // حدث فشل متأخر يصل بعد النجاح — يجب أن يُتجاهل أثره
  const lateFail = makeWebhookBody("payment_failed", { providerInvoiceId: co3.providerInvoiceId, amountSar: 29, paymentId: c3pays[1] && (await query(`SELECT provider_payment_id FROM payments WHERE user_id=$1 AND status='paid'`, [u3.id])).rows[0].provider_payment_id });
  r = await sendWebhook(lateFail);
  log("C8 ★ حدث فشل متأخر لا يخفض دفعة ناجحة", r.body.outcome === "ignored_out_of_order_after_success", JSON.stringify(r.body));
  const { rows: c3after } = await query(`SELECT status FROM invoices WHERE id = $1`, [co3.invoiceId]);
  log("C9 ★ الفاتورة بقيت مدفوعة رغم الحدث المتأخر", c3after[0].status === "paid", c3after[0].status);

  /* ========================================================
     D) التجديد
     ======================================================== */
  const beforeRenew = (await get("/api/payments/subscription", u1.token)).body.subscription.renewalDate;
  const co1b = await startCheckout(u1, "monthly");
  await sendWebhook(makeWebhookBody("payment_paid", { providerInvoiceId: co1b.providerInvoiceId, amountSar: 29 }));
  r = await get("/api/payments/subscription", u1.token);
  const added = Math.round((new Date(r.body.subscription.renewalDate) - new Date(beforeRenew)) / 86400000);
  log("D1 التجديد يمدّد 30 يوماً من نهاية الفترة لا من اليوم", added === 30, String(added));

  const { rows: d1subs } = await query(`SELECT count(*)::int n FROM subscriptions WHERE user_id = $1`, [u1.id]);
  log("D2 التجديد لا ينشئ اشتراكاً ثانياً", d1subs[0].n === 1, String(d1subs[0].n));

  const { rows: d1inv } = await query(`SELECT count(*)::int n FROM invoices WHERE user_id = $1 AND status='paid'`, [u1.id]);
  log("D3 التجديد أصدر فاتورة ضريبية ثانية", d1inv[0].n === 2, String(d1inv[0].n));

  // ترقية: شراء السنوي وهو على الشهري
  const co1c = await startCheckout(u1, "annual");
  await sendWebhook(makeWebhookBody("payment_paid", { providerInvoiceId: co1c.providerInvoiceId, amountSar: 229 }));
  r = await get("/api/payments/subscription", u1.token);
  log("D4 الترقية تبدّل الباقة فوراً وتمدّد المدة",
    r.body.subscription.planId === "annual" && r.body.subscription.billingCycle === "annual",
    JSON.stringify([r.body.subscription.planId, r.body.subscription.billingCycle]));

  /* ========================================================
     E) الإلغاء وإعادة التفعيل
     ======================================================== */
  r = await post("/api/payments/subscription/cancel", { reason: "ما عاد أحتاجه" }, u2.token);
  log("E1 الإلغاء الافتراضي بنهاية المدة لا فوري", r.status === 200 && r.body.mode === "at_period_end", JSON.stringify(r.body));
  r = await get("/api/payments/subscription", u2.token);
  log("E2 الحالة صارت canceling والوصول باقٍ",
    r.body.subscription.status === "canceling" && r.body.entitled === true, JSON.stringify(r.body.subscription.status));

  r = await post("/api/payments/subscription/reactivate", {}, u2.token);
  log("E3 التراجع عن الإلغاء يعيد الحالة active", r.status === 200, JSON.stringify(r.body));
  r = await get("/api/payments/subscription", u2.token);
  log("E4 الحالة رجعت active بعد إعادة التفعيل", r.body.subscription.status === "active", r.body.subscription.status);

  r = await post("/api/payments/subscription/cancel", { atPeriodEnd: false, reason: "إلغاء فوري" }, u2.token);
  log("E5 الإلغاء الفوري ينهي الاشتراك", r.status === 200 && r.body.mode === "immediate", JSON.stringify(r.body));
  r = await get("/api/payments/subscription", u2.token);
  log("E6 لا استحقاق بعد الإلغاء الفوري", r.body.subscription.status === "canceled" && r.body.entitled === false, JSON.stringify([r.body.subscription.status, r.body.entitled]));
  const { rows: e6 } = await query(`SELECT canceled_at FROM subscriptions WHERE user_id = $1`, [u2.id]);
  log("E7 canceled_at مكتوب (كان يُهمَل تماماً)", !!e6[0].canceled_at, String(e6[0].canceled_at));

  r = await post("/api/payments/subscription/reactivate", {}, u2.token);
  log("E8 لا يمكن إعادة تفعيل اشتراك منتهٍ فعلياً", r.status === 409, JSON.stringify(r.body));

  // الانتهاء بمرور الوقت — بلا cron
  const u4 = await makeUser("عبدالله الحربي", "abdullah@kanaf.test");
  const co4 = await startCheckout(u4, "monthly");
  await sendWebhook(makeWebhookBody("payment_paid", { providerInvoiceId: co4.providerInvoiceId, amountSar: 29 }));
  await query(`UPDATE subscriptions SET current_period_end = now() - interval '1 day' WHERE user_id = $1`, [u4.id]);
  r = await get("/api/payments/subscription", u4.token);
  log("E9 ★ الاشتراك المنتهي يظهر expired تلقائياً بلا أي وظيفة دورية",
    r.body.subscription.status === "expired" && r.body.entitled === false, JSON.stringify(r.body.subscription.status));
  r = await get("/admin/billing/subscriptions?status=expired");
  log("E10 فلتر «منتهية» في اللوحة يلتقطه", r.body.total === 1 && r.body.subscriptions[0].user_email === "abdullah@kanaf.test", JSON.stringify(r.body.total));

  /* ========================================================
     F) الـwebhook المكرر
     ======================================================== */
  const u5 = await makeUser("ريم الشمري", "reem@kanaf.test");
  const co5 = await startCheckout(u5, "monthly");
  const evt5 = makeWebhookBody("payment_paid", { providerInvoiceId: co5.providerInvoiceId, amountSar: 29 });

  const before5 = await get("/api/payments/subscription", u5.token);
  r = await sendWebhook(evt5);
  const firstEnd = (await get("/api/payments/subscription", u5.token)).body.subscription.renewalDate;

  const dup1 = await sendWebhook(evt5);                     // نفس معرّف الحدث بالضبط
  log("F1 التسليم المكرر يُردّ عليه 200 ويوسم duplicate", dup1.status === 200 && dup1.body.duplicate === true, JSON.stringify(dup1.body));

  const dup2 = await sendWebhook({ ...evt5, id: `evt_${crypto.randomUUID()}` }); // معرّف حدث مختلف، نفس الدفعة
  log("F2 ★ حدث بمعرّف جديد لنفس الدفعة لا يُفعّل مرتين", dup2.body.outcome === "payment_already_recorded", JSON.stringify(dup2.body));

  const afterEnd = (await get("/api/payments/subscription", u5.token)).body.subscription.renewalDate;
  log("F3 ★ المدة لم تُمدَّد مرة ثانية", new Date(afterEnd).getTime() === new Date(firstEnd).getTime(), `${firstEnd} → ${afterEnd}`);

  const { rows: f4 } = await query(
    `SELECT (SELECT count(*)::int FROM payments WHERE user_id=$1) p,
            (SELECT count(*)::int FROM invoices WHERE user_id=$1 AND status='paid') i,
            (SELECT count(*)::int FROM subscriptions WHERE user_id=$1) s`, [u5.id]);
  log("F4 ★ ولا دفعة ولا فاتورة ولا اشتراك مكرر", f4[0].p === 1 && f4[0].i === 1 && f4[0].s === 1, JSON.stringify(f4[0]));

  const { rows: f5 } = await query(`SELECT count(*)::int n FROM invoices WHERE user_id=$1 AND zatca_invoice_number IS NOT NULL`, [u5.id]);
  log("F5 ★ لم يُستهلك رقم فاتورة ضريبي ثانٍ", f5[0].n === 1, String(f5[0].n));

  r = await sendWebhook({ ...evt5, id: `evt_${crypto.randomUUID()}`, secret_token: "wrong-secret" });
  log("F6 حدث بسر خاطئ مرفوض 401", r.status === 401, String(r.status));
  const { rows: f6 } = await query(`SELECT count(*)::int n FROM webhook_events WHERE payload::text LIKE '%wrong-secret%'`);
  log("F7 الحدث المرفوض لم يُكتب في السجل إطلاقاً", f6[0].n === 0, String(f6[0].n));

  const { rows: f8 } = await query(`SELECT count(*)::int n FROM webhook_events WHERE payload::text LIKE '%secret_token%'`);
  log("F8 ★ لا سر مخزّن في أي حمولة محفوظة", f8[0].n === 0, String(f8[0].n));

  r = await get("/admin/billing/webhook-events");
  log("F9 سجل الأحداث ظاهر للإدارة بعدّاداته", r.body.total > 0 && typeof r.body.summary === "object", JSON.stringify(r.body.summary));

  /* ========================================================
     G) الاسترداد — كامل وجزئي، عبر المزوّد فعلاً
     ======================================================== */
  const { rows: g0 } = await query(`SELECT id, provider_payment_id, amount FROM payments WHERE user_id=$1 AND status='paid'`, [u5.id]);
  const payment5 = g0[0];
  const callsBefore = moyasarCalls.length;

  r = await post(`/admin/billing/payments/${payment5.id}/refund`, { amountSar: 10, reason: "اختبار استرداد جزئي" });
  log("G1 استرداد جزئي ينجح", r.status === 200 && r.body.kind === "partial" && Number(r.body.amount) === 10, JSON.stringify(r.body));
  const refundCalls = moyasarCalls.slice(callsBefore).filter((c) => c.path.endsWith("/refund"));
  log("G2 ★ المزوّد نُودي فعلاً بمبلغ الاسترداد (10 ريال = 1000 هللة)",
    refundCalls.length === 1 && refundCalls[0].body.amount === 1000, JSON.stringify(refundCalls));

  const { rows: g3 } = await query(`SELECT status, refunded_amount FROM payments WHERE id=$1`, [payment5.id]);
  log("G3 الدفعة صارت partially_refunded بمبلغ صحيح",
    g3[0].status === "partially_refunded" && Number(g3[0].refunded_amount) === 10, JSON.stringify(g3[0]));

  const { rows: g4 } = await query(`SELECT status FROM invoices WHERE user_id=$1 AND status='paid'`, [u5.id]);
  log("G4 الاسترداد الجزئي لا يحوّل الفاتورة إلى مستردة", g4.length === 1, JSON.stringify(g4));
  r = await get("/api/payments/subscription", u5.token);
  log("G5 الاسترداد الجزئي لا يقطع الوصول", r.body.entitled === true, String(r.body.entitled));

  const { rows: g6 } = await query(`SELECT zatca_credit_note_number, amount_sar FROM credit_notes WHERE user_id=$1`, [u5.id]);
  log("G6 صدر إشعار دائن بمبلغ الاسترداد الجزئي وحده",
    g6.length === 1 && Number(g6[0].amount_sar) === 10 && /^CN-\d{4}-000001$/.test(g6[0].zatca_credit_note_number),
    JSON.stringify(g6[0]));

  r = await post(`/admin/billing/payments/${payment5.id}/refund`, { amountSar: 25, reason: "تجاوز المتاح" });
  log("G7 ★ استرداد يتجاوز المتبقّي مرفوض", r.status === 409 && r.body.error === "refund_exceeds_available_amount", JSON.stringify(r.body));

  r = await post(`/admin/billing/payments/${payment5.id}/refund`, { reason: "استرداد الباقي" });
  log("G8 استرداد المتبقّي ينجح ويصير كاملاً", r.status === 200 && Number(r.body.amount) === 19, JSON.stringify(r.body));

  const { rows: g9 } = await query(`SELECT status, refunded_amount FROM payments WHERE id=$1`, [payment5.id]);
  log("G9 الدفعة صارت refunded بالكامل", g9[0].status === "refunded" && Number(g9[0].refunded_amount) === 29, JSON.stringify(g9[0]));
  const { rows: g10 } = await query(`SELECT status FROM invoices WHERE id=$1`, [(await query(`SELECT invoice_id FROM payments WHERE id=$1`, [payment5.id])).rows[0].invoice_id]);
  log("G10 الاسترداد الكامل يحوّل الفاتورة إلى refunded", g10[0].status === "refunded", g10[0].status);
  r = await get("/api/payments/subscription", u5.token);
  log("G11 الاسترداد الكامل يقطع الوصول فوراً", r.body.entitled === false && r.body.subscription.status === "canceled", JSON.stringify([r.body.subscription.status, r.body.entitled]));

  r = await post(`/admin/billing/payments/${payment5.id}/refund`, { reason: "محاولة ثالثة" });
  log("G12 ★ لا يمكن استرداد دفعة استُردت بالكامل", r.status === 409, JSON.stringify(r.body));

  // استرداد يفشل عند المزوّد → لا شيء يتغيّر عندنا
  const { rows: g13p } = await query(`SELECT id FROM payments WHERE user_id=$1 AND status='paid' LIMIT 1`, [u1.id]);
  moyasarState.failRefund = true;
  r = await post(`/admin/billing/payments/${g13p[0].id}/refund`, { reason: "فشل مزوّد" });
  moyasarState.failRefund = false;
  log("G13 ★ فشل المزوّد يُرجع 502 ولا يعلّم شيئاً مستردّاً", r.status === 502, JSON.stringify(r.body));
  const { rows: g14 } = await query(`SELECT status, refunded_amount FROM payments WHERE id=$1`, [g13p[0].id]);
  log("G14 ★ الدفعة بقيت paid ومبلغها المسترد صفر", g14[0].status === "paid" && Number(g14[0].refunded_amount) === 0, JSON.stringify(g14[0]));
  const { rows: g15 } = await query(`SELECT status, error FROM refunds WHERE payment_id=$1`, [g13p[0].id]);
  log("G15 محاولة الاسترداد الفاشلة محفوظة بسببها", g15[0]?.status === "failed" && !!g15[0]?.error, JSON.stringify(g15[0]?.status));

  // استرداد من لوحة المزوّد يصل عبر webhook
  const { rows: g16p } = await query(`SELECT id, provider_payment_id, amount FROM payments WHERE user_id=$1 AND status='paid' LIMIT 1`, [u3.id]);
  r = await sendWebhook(makeWebhookBody("payment_refunded", { paymentId: g16p[0].provider_payment_id, amountSar: 29, refundedSar: 29 }));
  log("G16 استرداد من لوحة المزوّد يصل ويُعالَج", r.body.outcome === "refunded_full", JSON.stringify(r.body));
  const { rows: g17 } = await query(`SELECT status FROM payments WHERE id=$1`, [g16p[0].id]);
  log("G17 الدفعة صارت مستردة عبر الـwebhook", g17[0].status === "refunded", g17[0].status);

  /* ========================================================
     تكامل البيانات والمؤشرات والإعداد الضريبي
     ======================================================== */
  r = await get("/admin/billing/integrity");
  const failing = (r.body.checks || []).filter((c) => c.count > 0);
  log("H1 تقرير التكامل نظيف بلا حالات مالية غير منطقية", failing.length === 0,
    JSON.stringify(failing.map((c) => `${c.key}=${c.count}`)));

  r = await get("/admin/billing/kpis");
  const k = r.body.kpis;
  const { rows: realActive } = await query(
    `SELECT count(*)::int n FROM (SELECT DISTINCT ON (user_id) id, status, current_period_end FROM subscriptions ORDER BY user_id, created_at DESC) s
     WHERE s.status IN ('active','trialing','past_due') AND s.current_period_end > now()`);
  log("H2 مؤشر الاشتراكات الفعّالة يطابق الواقع لا العمود المخزّن", k.activeSubscriptions === realActive[0].n, `${k.activeSubscriptions} vs ${realActive[0].n}`);
  log("H3 كل مؤشر له تعريف مكتوب", Object.keys(r.body.definitions).length >= 10, String(Object.keys(r.body.definitions || {}).length));
  log("H4 صافي الإيراد = الإجمالي − الاستردادات",
    Math.abs(k.netRevenue - (k.grossRevenue - k.refunds)) < 0.01, JSON.stringify([k.grossRevenue, k.refunds, k.netRevenue]));
  log("H5 المدفوعات الفاشلة معدودة", k.failedPayments >= 1, String(k.failedPayments));
  log("H6 المنطقة الزمنية المحاسبية بالرياض لا UTC", r.body.range.timezone === "Asia/Riyadh", r.body.range.timezone);

  const { rows: h7 } = await query(`SELECT count(*)::int n FROM subscriptions WHERE status='active'`);
  log("H7 ★ العدّاد الخام (status='active') أكبر من الواقع — وهذا سبب استبداله",
    h7[0].n >= realActive[0].n, `خام=${h7[0].n} فعلي=${realActive[0].n}`);

  // تغيير النسبة لا يمس الفواتير الصادرة
  const oldSubtotal = (await query(`SELECT subtotal_sar FROM invoices WHERE id=$1`, [co1.invoiceId])).rows[0].subtotal_sar;
  r = await put("/admin/billing/settings", { vatRate: 0.05, reason: "اختبار تغيير النسبة" });
  log("I1 تغيير النسبة الضريبية مقبول من owner بسبب مكتوب", r.status === 200 && Number(r.body.settings.vat_rate) === 0.05, JSON.stringify(r.body));
  const newSubtotal = (await query(`SELECT subtotal_sar FROM invoices WHERE id=$1`, [co1.invoiceId])).rows[0].subtotal_sar;
  log("I2 ★ الفواتير الصادرة لم تتغير أرقامها", String(oldSubtotal) === String(newSubtotal), `${oldSubtotal} → ${newSubtotal}`);

  const u6 = await makeUser("منى الغامدي", "mona@kanaf.test");
  const co6 = await startCheckout(u6, "monthly");
  await sendWebhook(makeWebhookBody("payment_paid", { providerInvoiceId: co6.providerInvoiceId, amountSar: 29 }));
  const { rows: i3 } = await query(`SELECT subtotal_sar, vat_sar FROM invoices WHERE id=$1`, [co6.invoiceId]);
  log("I3 ★ الفاتورة الجديدة تستخدم النسبة الجديدة 5% (27.62 + 1.38)",
    Number(i3[0].subtotal_sar) === 27.62 && Number(i3[0].vat_sar) === 1.38, `${i3[0].subtotal_sar}+${i3[0].vat_sar}`);
  const { rows: i4 } = await query(`SELECT vat_rate FROM invoice_state WHERE invoice_id=$1`, [co6.invoiceId]);
  log("I4 النسبة المطبَّقة مجمّدة مع الفاتورة", Number(i4[0].vat_rate) === 0.05, String(i4[0].vat_rate));

  r = await put("/admin/billing/settings", { vatRate: 15, reason: "قيمة خاطئة" });
  log("I5 نسبة مكتوبة كـ15 بدل 0.15 مرفوضة", r.status === 400, JSON.stringify(r.body));
  await put("/admin/billing/settings", { vatRate: 0.15, reason: "إرجاع النسبة" });

  /* ========================================================
     الصلاحيات والتحقق
     ======================================================== */
  CURRENT_ADMIN = { id: ADMIN_ID, role: "support" };
  r = await post(`/admin/billing/payments/${payment5.id}/refund`, { reason: "تجاوز صلاحية" });
  log("J1 موظف الدعم لا يقدر يسترد", r.status === 403, String(r.status));
  r = await get("/admin/billing/subscriptions");
  log("J2 موظف الدعم يقدر يشوف الاشتراكات", r.status === 200, String(r.status));
  r = await put("/admin/billing/settings", { vatRate: 0.2, reason: "تجاوز" });
  log("J3 موظف الدعم لا يعدّل الإعداد الضريبي", r.status === 403, String(r.status));

  CURRENT_ADMIN = { id: ADMIN_ID, role: "admin" };
  r = await post(`/admin/billing/payments/${payment5.id}/refund`, {});
  log("J4 الاسترداد بلا سبب مكتوب مرفوض", r.status === 400 && r.body.error === "reason_required", JSON.stringify(r.body));

  CURRENT_ADMIN = null;
  r = await get("/admin/billing/payments");
  log("J5 بلا جلسة إدارة → 401", r.status === 401, String(r.status));
  r = await get("/api/payments/subscription");
  log("J6 بلا رمز مستخدم → 401 على مسار الاشتراك", r.status === 401, String(r.status));

  // فاتورة مستخدم آخر
  r = await get(`/api/payments/invoices/${co1.invoiceId}/pdf`, u3.token);
  log("J7 ★ مستخدم لا يقدر يحمّل فاتورة غيره (نفس رد 404)", r.status === 404, String(r.status));
  r = await get(`/api/payments/status/${co1.invoiceId}`, u3.token);
  log("J8 حالة فاتورة غيره غير مقروءة", r.status === 404, String(r.status));

  // إعادة استخدام الفاتورة المعلّقة
  const u7 = await makeUser("خالد السبيعي", "khaled@kanaf.test");
  const a = await startCheckout(u7, "monthly");
  const b = await startCheckout(u7, "monthly");
  log("K1 ضغطتان متتاليتان على الدفع تعيدان نفس الفاتورة المعلّقة", a.invoiceId === b.invoiceId, `${a.invoiceId} / ${b.invoiceId}`);
  const { rows: k1 } = await query(`SELECT count(*)::int n FROM invoices WHERE user_id=$1 AND status='pending'`, [u7.id]);
  log("K2 لم تتراكم فواتير معلّقة", k1[0].n === 1, String(k1[0].n));

  /* ---- النتائج ---- */
  console.log = realLog; console.error = realErr;
  let pass = 0, fail = 0;
  for (const [label, cond, extra] of results) {
    if (cond) { pass++; console.log(`  ✔  ${label}`); }
    else { fail++; console.log(`  ✘  ${label}${extra ? `  (القيمة: ${extra})` : ""}`); }
  }
  console.log(`\n  ${pass} ناجح، ${fail} فاشل  (من ${results.length})`);
  if (fail > 0) {
    console.log("\n--- آخر سجلات الخادم ---");
    console.log(noisyLogs.slice(-25).join("\n"));
  }
  server.close();
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(async (e) => {
  console.log = realLog; console.error = realErr;
  console.error(e);
  console.log(noisyLogs.slice(-30).join("\n"));
  server.close();
  await pool.end().catch(() => {});
  process.exit(1);
});
