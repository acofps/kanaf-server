/**
 * اختبار انحدار لعطب أسقط أول دفعة حقيقية على الإنتاج.
 *
 * السيناريو: إصدار الفاتورة الضريبية يفشل بخطأ **من قاعدة البيانات**
 * (صلاحية مفقودة على تسلسل الأرقام — وهو ما حدث فعلاً).
 *
 * قبل الإصلاح: try/catch حول التوليد داخل معاملة الدفع كان يبتلع
 * الخطأ ويكمل، بينما PostgreSQL قد أجهض المعاملة — فـ COMMIT ينفّذ
 * ROLLBACK بصمت وتضيع الدفعة والاشتراك معاً.
 *
 * بعد الإصلاح: معاملة المال تُثبَّت وحدها، وإصدار المستند في معاملة
 * مستقلة بعدها. فشله يترك فاتورة مدفوعة بلا رقم ضريبي — قابلة
 * للإصلاح بإعادة التشغيل.
 */
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pg from "pg";
import { query, pool } from "./db/pool.js";

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const SEQ = "kanaf_invoice_number_seq";
const APP_ROLE = process.env.APP_ROLE || "app_role";
const admin = new pg.Pool({ connectionString: process.env.SUPERUSER_URL });
const setSeqAccess = (grant) =>
  admin.query(`${grant ? "GRANT USAGE, SELECT" : "REVOKE ALL"} ON SEQUENCE ${SEQ} ${grant ? "TO" : "FROM"} ${APP_ROLE}`);

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (!href.startsWith("https://api.moyasar.com")) return realFetch(url, opts);
  const body = opts.body ? JSON.parse(opts.body) : {};
  return new Response(JSON.stringify({ id: "mo_inv_r1", amount: body.amount, url: "https://checkout.test/x" }),
    { status: 201, headers: { "Content-Type": "application/json" } });
};

const { authRouter } = await import("./auth/routes.js");
const { paymentsRouter } = await import("./payments/routes.js");
const { adminRouter } = await import("./admin/routes.js");
let CURRENT_ADMIN = null;
const app = express();
app.set("trust proxy", 1); app.use(express.json()); app.use(cookieParser());
app.use("/api/auth", authRouter); app.use("/api/payments", paymentsRouter); app.use("/admin", adminRouter);
const server = app.listen(4611); const B = "http://127.0.0.1:4611";

const sent = []; const realLog = console.log, realErr = console.error; const noise = [];
console.log = (...a) => { const l = a.join(" "); if (l.includes("[dev] Would send")) sent.push(l); else noise.push(l); };
console.error = (...a) => noise.push(a.join(" "));

const cookie = () => CURRENT_ADMIN ? `kanaf_admin_access=${jwt.sign({ sub: CURRENT_ADMIN.id, role: CURRENT_ADMIN.role, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}` : null;
async function req(m, p, b, t) {
  const h = { "Content-Type": "application/json" };
  if (p.startsWith("/admin")) { const c = cookie(); if (c) h.Cookie = c; }
  if (t) h.Authorization = `Bearer ${t}`;
  const r = await realFetch(B + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

try {
  const ADMIN_ID = crypto.randomUUID();
  await query(`TRUNCATE refunds, webhook_events, payments, invoice_state, subscription_state,
               credit_notes, invoices, subscriptions, admin_action_log, admin_access_log,
               user_sessions, user_auth_state, email_verification_codes, users, admin_users
               RESTART IDENTITY CASCADE`);
  await query(`INSERT INTO subscription_plans (plan_key,name,price_sar,duration_days,display_order)
               VALUES ('monthly','الباقة الشهرية',29.00,30,1) ON CONFLICT (plan_key) DO NOTHING`);
  await query(`INSERT INTO billing_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`);
  await query(`INSERT INTO tax_settings (singleton,legal_name,vat_number) VALUES (true,'مؤسسة كنف','300000000000003')
               ON CONFLICT (singleton) DO UPDATE SET legal_name=EXCLUDED.legal_name`);
  await query(`INSERT INTO admin_users (id,name,email,password_hash,role) VALUES ($1,'م','o@k.test','x','owner')`, [ADMIN_ID]);
  CURRENT_ADMIN = { id: ADMIN_ID, role: "owner" };

  const EMAIL = `res-${Date.now()}@kanaf.test`;
  const reg = await req("POST", "/api/auth/register", { name: "عادل التجريبي", email: EMAIL, password: "Kanaf-Test-2026-a", confirmedAdult: true, agreedPolicy: true });
  ok("التسجيل", reg.status===201, JSON.stringify(reg.body).slice(0,120));
  const code = /كود تأكيد بريدك في كنف: (\d{6})/.exec([...sent].reverse().find((m) => m.includes(EMAIL)))[1];
  const v = await req("POST", "/api/auth/verify-email", { email: EMAIL, code });
  const token = v.body.accessToken;
  ok("التحقق أصدر جلسة", !!token, JSON.stringify(v.body).slice(0,150));
  const ci = await req("POST", "/api/payments/create-invoice", { planId: "monthly" }, token);
  const invoiceId = ci.body.invoiceId;
  ok("إنشاء الفاتورة نجح", ci.status === 201 && !!invoiceId, JSON.stringify(ci.body).slice(0,120));
  const { rows: dbg } = await query(`SELECT id, provider_invoice_id, status FROM invoices`);
  ok("صف الفاتورة موجود بمعرّف المزوّد", dbg.length===1 && dbg[0].provider_invoice_id==="mo_inv_r1", JSON.stringify(dbg));

  // 🔴 نمنع الصلاحية — نفس خطأ الإنتاج بالضبط
  await setSeqAccess(false);

  const evt = {
    id: `evt_${crypto.randomUUID()}`, type: "payment_paid", secret_token: process.env.PAYMENT_WEBHOOK_SECRET,
    data: { id: "mo_pay_r1", status: "paid", amount: 2900, currency: "SAR", invoice_id: "mo_inv_r1",
            source: { type: "creditcard", company: "mada", number: "XXXX4444" }, metadata: { kanaf_invoice_id: invoiceId } },
  };
  const w = await req("POST", "/api/payments/webhook", evt);
  ok("الـwebhook رد 200 رغم فشل إصدار المستند", w.status === 200, JSON.stringify(w.body));

  const { rows: p } = await query(`SELECT status, amount FROM payments`);
  ok("★ الدفعة نجت — لم تُمحَ مع فشل المستند", p.length === 1 && p[0].status === "paid", JSON.stringify(p));
  const { rows: i } = await query(`SELECT status, zatca_invoice_number FROM invoices WHERE id=$1`, [invoiceId]);
  ok("★ الفاتورة مدفوعة", i[0].status === "paid", i[0].status);
  ok("★ ولا رقم ضريبي لها (فشل المستند وحده)", i[0].zatca_invoice_number === null, String(i[0].zatca_invoice_number));
  const { rows: s } = await query(`SELECT status FROM subscriptions`);
  ok("★ الاشتراك فُعّل ونجا", s.length === 1 && s[0].status === "active", JSON.stringify(s));

  const integ = await req("GET", "/admin/billing/integrity");
  const flagged = (integ.body.checks || []).find((c) => c.key === "paid_invoice_without_tax_number");
  ok("★ تقرير التكامل يرصدها بدل أن تختفي", flagged && flagged.count === 1, JSON.stringify(flagged?.count));

  // نعيد الصلاحية ونعيد تشغيل الحدث
  await setSeqAccess(true);
  const { rows: ev } = await query(`SELECT id, status FROM webhook_events LIMIT 1`);
  ok("الحدث مسجَّل بحالة processed", ev[0].status === "processed", ev[0].status);
  const rp = await req("POST", `/admin/billing/webhook-events/${ev[0].id}/replay`, { reason: "إصلاح بعد استعادة الصلاحية" });
  ok("★ إعادة تشغيل حدث معالَج مسموحة (كانت مرفوضة 409)", rp.status === 200, JSON.stringify(rp.body).slice(0, 90));

  const { rows: i2 } = await query(`SELECT status, zatca_invoice_number, (pdf_data IS NOT NULL) AS pdf FROM invoices WHERE id=$1`, [invoiceId]);
  ok("★ الفاتورة الضريبية صدرت بعد الإصلاح", /^INV-\d{4}-\d{6}$/.test(i2[0].zatca_invoice_number || ""), String(i2[0].zatca_invoice_number));
  ok("★ ومعها ملف PDF", i2[0].pdf === true);
  const { rows: p2 } = await query(`SELECT count(*)::int n FROM payments`);
  ok("★ إعادة التشغيل لم تُنشئ دفعة مكررة", p2[0].n === 1, String(p2[0].n));
  const { rows: s2 } = await query(`SELECT count(*)::int n FROM subscriptions`);
  ok("★ ولا اشتراكاً مكرراً", s2[0].n === 1, String(s2[0].n));
} catch (e) { R.push(["!! توقف: " + String(e).slice(0, 140), false]); }

console.log = realLog; console.error = realErr;
let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  ✔  ${l}`); } else { fail++; console.log(`  ✘  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${pass} ناجح، ${fail} فاشل`);
if (fail) console.log(noise.slice(-12).join("\n"));
server.close(); await pool.end(); await admin.end();
process.exit(fail ? 1 : 0);
