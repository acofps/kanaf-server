/**
 * KANAF-ORD-0004 COR-03 — إعادة الفحص الإدارية تقرأ دليل المزوّد دائماً حين يوجد معرّف دفعة،
 * مستقلةً عن KANAF_PAYMENT_PROVIDER_VERIFY (المعطّل افتراضياً، ويحكم التحقق التلقائي في webhook وحده).
 *
 * التشخيص (يفشل هذا الملف على 955df25؛ السجل NEGATIVE في test-support/.local/logs/ord0004):
 *   والمفتاح معطّل كانت إعادة الفحص تعيد تمرير الحمولة المحفوظة نفسها على المحقق. فحجز amount_invalid
 *   (مبلغ نصّي مثلاً) لا يُحل أبداً بإعادة الفحص ولو أكد المزوّد دفعة سليمة مطابقة: يبقى للمشغّل «الإغلاق بلا أثر» وحده.
 *
 * الحالات (كلها والمفتاح معطّل): دليل مطابق ← قبول وتفعيل مرة واحدة وحل الحجز؛ دليل غير مطابق ← يبقى؛
 * مزوّد لا يرد ← 503 برد واضح ويبقى الحجز؛ إعادة الفحص مرتين (متتاليتين ومتزامنتين) ← لا تفعيل مزدوج؛
 * دور بلا payments:reconcile ← 403؛ دليل لا يرتبط بالفاتورة ← ليس قبولاً (يبقى، والرد لا يقول «طابق»). المزوّد مزيّف بالكامل؛ لا طلب إلى api.moyasar.com.
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

  /* ================= K — إعادة الفحص والمفتاح معطّل ================= */
  AS = "admin";
  const recheck = (hid, reason = "إعادة فحص من المزوّد", role = "admin") => asAdmin(role, "POST", `/admin/billing/payment-holds/${hid}/recheck`, { reason });
  const openHold = (s, reason) => s.open.find((h) => h.reason === reason);
  ok("K0 the provider check flag is off for this whole file", !process.env.KANAF_PAYMENT_PROVIDER_VERIFY, String(process.env.KANAF_PAYMENT_PROVIDER_VERIFY));

  /* K1–K3: حمولة مشوّهة (مبلغ نصّي) ← amount_invalid؛ المزوّد يؤكد دفعة سليمة مطابقة */
  {
    const i1 = await newInvoice(); const d = pay(i1, { amount: "2900" });
    prov.calls = 0;
    const s0 = await expectHeld("K1 a malformed event (amount \"2900\" as a string), flag off", i1, d, "amount_invalid");
    ok("K1b with the flag off the webhook itself made no provider call", prov.calls === 0, String(prov.calls));
    const hid = openHold(s0, "amount_invalid")?.id;
    prov.payments.set(d.id, { ...d, amount: 2900 }); prov.calls = 0;
    const rk = await recheck(hid);
    const s1 = await st(i1);
    const h1 = s1.holds.find((h) => h.id === hid);
    ok("K2 recheck reads the provider (flag off); matching evidence → accepted, activated once, hold resolved",
      rk.status === 200 && rk.body.ok === true && rk.body.held === false && rk.body.providerChecked === true && prov.calls >= 1
      && s1.inv === "paid" && s1.subs === 1 && s1.pays === 1 && s1.invNo !== null && h1?.status === "resolved" && s1.open.length === 0,
      `${rk.status} ${JSON.stringify(rk.body)} calls=${prov.calls} ${brief(s1)} hold=${h1?.status}`);
    const rk2 = await recheck(hid, "مرة ثانية");
    const s2 = await st(i1);
    ok("K3 a second recheck of the same hold → 409 hold_not_open, still one subscription, one payment, same document number",
      rk2.status === 409 && rk2.body.error === "hold_not_open" && s2.subs === 1 && s2.pays === 1 && s2.invNo === s1.invNo,
      `${rk2.status} ${JSON.stringify(rk2.body)} ${brief(s2)}`);
  }

  /* K4: دليل مزوّد غير مطابق ← يبقى محجوزاً */
  {
    const i2 = await newInvoice(); const d = pay(i2, { amount: "2900" });
    const s0 = await expectHeld("K4a malformed event, flag off", i2, d, "amount_invalid");
    const hid = openHold(s0, "amount_invalid")?.id;
    prov.payments.set(d.id, { ...d, amount: 100 });
    const rk = await recheck(hid);
    const s1 = await st(i2);
    ok("K4 recheck with provider evidence that does not match (100 halalas on a 2900 invoice) → still held, nothing activated",
      rk.status === 200 && rk.body.held === true && rk.body.ok === false && rk.body.providerChecked === true && notActivated(s1) && s1.open.length >= 1,
      `${JSON.stringify(rk.body)} ${brief(s1)}`);
    prov.payments.set(d.id, { ...d, amount: 2900, status: "failed" });
    const rk2 = await recheck(hid, "المزوّد يقول فاشلة");
    ok("K4b provider evidence with status failed → not accepted, nothing activated", rk2.status === 200 && rk2.body.ok === false && notActivated(await st(i2)), JSON.stringify(rk2.body));
    prov.payments.set(d.id, { ...d, amount: 2900, currency: "USD" });
    const rk3 = await recheck(hid, "المزوّد يقول دولار");
    ok("K4c provider evidence in another currency → still held, nothing activated", rk3.status === 200 && rk3.body.held === true && notActivated(await st(i2)), JSON.stringify(rk3.body));
  }

  /* K5: مزوّد لا يرد ← يبقى محجوزاً برد واضح */
  {
    const i3 = await newInvoice(); const d = pay(i3, { amount: "2900" });
    const s0 = await expectHeld("K5a malformed event, flag off", i3, d, "amount_invalid");
    const hid = openHold(s0, "amount_invalid")?.id;
    prov.payments.set(d.id, { ...d, amount: 2900 });
    prov.mode = "fail"; prov.calls = 0;
    const rk = await recheck(hid, "المزوّد متعطل");
    prov.mode = "ok";
    const s1 = await st(i3);
    const { rows: aud } = await query(`SELECT new_value, metadata FROM admin_action_log WHERE action = 'payment_hold_recheck' AND metadata->>'hold_id' = $1`, [hid]);
    ok("K5 provider unavailable → 503 provider_unavailable with held:true, hold still open, nothing activated, the attempt is audited",
      rk.status === 503 && rk.body.error === "provider_unavailable" && rk.body.held === true && prov.calls === 2
      && notActivated(s1) && s1.holds.find((h) => h.id === hid)?.status === "open" && aud.some((a) => a.new_value?.outcome === "provider_unavailable"),
      `${rk.status} ${JSON.stringify(rk.body)} calls=${prov.calls} ${brief(s1)} aud=${JSON.stringify(aud)}`);
    prov.mode = "hang"; const t0 = Date.now();
    const rkh = await recheck(hid, "المزوّد معلّق");
    prov.mode = "ok";
    ok("K5b a hanging provider is cut by the timeout → 503, hold still open", rkh.status === 503 && rkh.body.held === true && Date.now() - t0 < 4000 && notActivated(await st(i3)), `${rkh.status} ${JSON.stringify(rkh.body)}`);
    const rk2 = await recheck(hid, "المزوّد عاد");
    ok("K5c once the provider answers, the same hold is accepted on recheck", rk2.status === 200 && rk2.body.ok === true && (await st(i3)).subs === 1, JSON.stringify(rk2.body));
  }

  /* K6: إعادتا فحص متزامنتان للحجز نفسه ← تفعيل واحد */
  {
    const i4 = await newInvoice(); const d = pay(i4, { amount: "2900" });
    const s0 = await expectHeld("K6a malformed event, flag off", i4, d, "amount_invalid");
    const hid = openHold(s0, "amount_invalid")?.id;
    prov.payments.set(d.id, { ...d, amount: 2900 });
    const g = gate();
    const a = recheck(hid, "متزامنة 1"), b = recheck(hid, "متزامنة 2");
    for (let k = 0; k < 100 && prov.live < 2; k++) await new Promise((r) => setTimeout(r, 20));
    g.release(); prov.gate = null;
    const [ra, rb] = await Promise.all([a, b]);
    const s1 = await st(i4);
    ok("K6 two concurrent rechecks of the same hold (both read the provider before either settles) → one subscription, one payment, hold resolved",
      ra.status < 500 && rb.status < 500 && s1.subs === 1 && s1.pays === 1 && s1.inv === "paid" && s1.open.length === 0,
      `${ra.status} ${JSON.stringify(ra.body)} | ${rb.status} ${JSON.stringify(rb.body)} ${brief(s1)}`);
  }

  /* K7: الصلاحيات */
  {
    const i5 = await newInvoice(); const d = pay(i5, { amount: "2900" });
    const s0 = await expectHeld("K7a malformed event, flag off", i5, d, "amount_invalid");
    const hid = openHold(s0, "amount_invalid")?.id;
    prov.payments.set(d.id, { ...d, amount: 2900 }); prov.calls = 0;
    const perms = {};
    for (const role of ["accountant", "support", "content_manager"]) perms[role] = (await recheck(hid, "محاولة بلا صلاحية", role)).status;
    const s1 = await st(i5);
    ok("K7 roles without payments:reconcile (accountant, support, content manager) → 403, no provider call, nothing activated, hold open",
      Object.values(perms).every((c) => c === 403) && prov.calls === 0 && notActivated(s1) && s1.holds.find((h) => h.id === hid)?.status === "open",
      `${JSON.stringify(perms)} calls=${prov.calls} ${brief(s1)}`);
    const own = await recheck(hid, "المالك يعيد الفحص", "owner");
    ok("K7b the owner (payments:reconcile) may recheck → accepted on matching evidence", own.status === 200 && own.body.ok === true && (await st(i5)).subs === 1, JSON.stringify(own.body));
  }

  /* K9: دليل لا يرتبط بالفاتورة (لا invoice_id ولا metadata) ← ليس قبولاً: الحجز يبقى والرد لا يقول «طابق» */
  {
    const i6 = await newInvoice(); const d = pay(i6, { amount: "2900" });
    const s0 = await expectHeld("K9a malformed event, flag off", i6, d, "amount_invalid");
    const hid = openHold(s0, "amount_invalid")?.id;
    prov.payments.set(d.id, { id: d.id, status: "paid", amount: 2900, currency: "SAR" });
    const rk = await recheck(hid, "دليل بلا ربط");
    const s1 = await st(i6);
    ok("K9 provider evidence that cannot be linked to the invoice → ok:false, held:true, hold still open, nothing activated",
      rk.status === 200 && rk.body.ok === false && rk.body.held === true && notActivated(s1) && s1.holds.find((h) => h.id === hid)?.status === "open",
      `${JSON.stringify(rk.body)} ${brief(s1)}`);
  }

  /* K8: لا «اجعلها مدفوعة» */
  {
    for (const path of ["accept", "mark-paid", "force"]) {
      const x = await req("POST", `/admin/billing/payment-holds/${crypto.randomUUID()}/${path}`, { reason: "لا يوجد" });
      ok(`K8 there is no «make paid» route (/${path} → 404)`, x.status === 404, String(x.status));
    }
  }
} catch (e) { R.push(["!! stopped: " + String(e?.stack || e).slice(0, 300), false]); }

console.log = realLog; console.error = realErr; console.warn = realWarn;
let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  ✔  ${l}`); } else { fail++; console.log(`  ✘  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${pass} ناجح، ${fail} فاشل`);
if (fail) console.log(noise.filter((l) => !/^\[webhook\] payment_/.test(l)).slice(-15).join("\n"));
server.close(); await pool.end();
process.exit(fail ? 1 : 0);
