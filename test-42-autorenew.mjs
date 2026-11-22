import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0013 §7 — التجديد التلقائي، على مزوّد وهمي (لا اتصال بـMoyasar ولا بالإنتاج).
 *  K) المفتاح: معطَّل = لا عرض ولا موافقة ولا مسح ولا حفظ بطاقة — والإلغاء متاح دائماً.
 *  1) 7.1 رمز البطاقة وحده، مشفّراً، ولا يخرج في أي رد؛ آخر أربعة أرقام والعلامة للعرض.
 *  2) 7.2 الموافقة صريحة بنصّها ونسختها ووقتها، ولا أثر رجعي على المشتركين القائمين.
 *  3) 7.3 إشعار قبل الخصم بالمهلة المضبوطة؛ ولا خصم قبل مرورها ولا بلا إشعار مسلَّم.
 *  4) 🔴 7.4 مسحان متزامنان → خصم واحد (بالقفل، وبلا القفل أيضاً).
 *  5) 7.5 فاتورة ضريبية على تسلسل TNFS-INV نفسه، وتمديد الاشتراك بمدة الباقة.
 *  6) 7.6 محاولات محدودة ثم توقّف؛ والنتيجة المجهولة لا تُعاد أبداً.
 *  7) 7.7 واجهة الإلغاء بعقدها.  8) 7.8 عرض الإدارة وإيقافها بسبب.
 */
requireDedicatedDatabase(import.meta.url);
import { startSmtpSink, mimeParts } from "./test-support/smtp-sink.mjs";
const sink = await startSmtpSink();
process.env.INTEGRATIONS_ENC_KEY = "a".repeat(64);
process.env.AUTORENEW_ENABLED = "1";
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { issueAccessToken } = await import("./auth/tokens.js");
const { autorenewRouter } = await import("./billing/autorenew-routes.js");
const { adminAutorenewRouter } = await import("./admin/autorenew.js");
const { autoReasonMiddleware } = await import("./admin/auto-reason.js"); // ملحق القرار 1: كما في index.js
const AR = await import("./billing/autorenew.js");
const { saveCard, captureCardAfterPayment } = await import("./billing/payment-methods.js");
const { setRenewalProviderForTests } = await import("./billing/renewal-provider.js");
const { issueInvoiceDocument } = await import("./payments/webhook.js");
const { formatDocumentNumber } = await import("./billing/config.js");
for (const k of ["error", "warn", "log"]) console[k] = () => {};

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* مزوّد وهمي: يسجّل كل نداء، ويؤخّر الرد ليكشف أي سباق. */
const fake = {
  name: "fake", calls: [], mode: "paid", delay: 0, seq: 0,
  async chargeToken(a) {
    this.calls.push(a);
    await sleep(this.delay);
    if (this.mode === "throw") throw Object.assign(new Error("timeout"), { code: "provider_timeout" });
    const id = `fake_pay_${++this.seq}`;
    if (this.mode === "failed") return { status: "failed", id, failureCode: "insufficient_funds" };
    return { status: "paid", id, amountHalalas: a.amountHalalas, currency: a.currency, brand: "mada", last4: "4242" };
  },
};
setRenewalProviderForTests(fake);

const app = express(); app.use(express.json()); app.use(cookieParser());
app.use("/api/billing/autorenew", autorenewRouter); app.use("/admin", autoReasonMiddleware); app.use("/admin", adminAutorenewRouter);
const server = app.listen(4643); const B = "http://127.0.0.1:4643";
const call = async (method, p, { token, cookie, body } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(B + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ } return { status: r.status, body: json, raw };
};
const adminCookie = async (role) => {
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ($1,$2,'x',$3) RETURNING id`, [`ar ${role}`, `ar-${role}-${Math.random().toString(36).slice(2, 7)}@kanaf.test`, role]);
  return { id: a.id, cookie: `kanaf_admin_access=${jwt.sign({ sub: a.id, role, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}` };
};
const mkUser = async (tag, { endsInHours }) => {
  const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at,confirmed_adult) VALUES ($1,$2,'x',now(),true) RETURNING id, name, email`, [`عضو ${tag}`, `ar-${tag}@example.com`]);
  const { rows: [s] } = await query(`INSERT INTO subscriptions (user_id, plan_id, status, started_at, current_period_end, payment_provider) VALUES ($1,'monthly','active', now() - interval '27 days', now() + make_interval(hours => $2), 'moyasar') RETURNING id, current_period_end`, [u.id, endsInHours]);
  await query(`INSERT INTO subscription_state (subscription_id, user_id, billing_cycle, billing_period_days, plan_price_sar, currency, current_period_start, provider) VALUES ($1,$2,'monthly',30,29,'SAR', now() - interval '27 days','moyasar')`, [s.id, u.id]);
  return { ...u, subId: s.id, token: issueAccessToken({ id: u.id }) };
};
const mailsTo = (email) => sink.inbox.filter((m) => m.to.join(",").includes(email)).map((m) => { const p = mimeParts(m.data); return p.find((x) => x.type === "text/plain")?.text || ""; });
const cycleOf = async (subId) => (await query(`SELECT * FROM renewal_cycles WHERE subscription_id = $1 ORDER BY created_at DESC LIMIT 1`, [subId])).rows[0];
/* «مرور الوقت»: نهاية الفترة بعد 12 ساعة، والإشعار أُرسل قبل N يوم */
const makeDue = async (u, noticeDaysAgo = 4) => {
  await query(`UPDATE subscriptions SET current_period_end = date_trunc('second', now()) + interval '12 hours' WHERE id = $1`, [u.subId]);
  await query(`UPDATE renewal_cycles rc SET period_end = s.current_period_end, notice_sent_at = now() - make_interval(days => $2)
                FROM subscriptions s WHERE s.id = rc.subscription_id AND rc.subscription_id = $1 AND rc.status = 'noticed'`, [u.subId, noticeDaysAgo]);
};

try {
  /* الإنتاج بعد خطوة الترقيم: TNFS-INV بلا رمز */
  await query(`INSERT INTO billing_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`);
  await query(`UPDATE billing_settings SET invoice_number_prefix = 'TNFS-INV', document_number_token = NULL WHERE singleton`);
  await query(`INSERT INTO tax_settings (singleton, legal_name, vat_number, address) VALUES (true,'مؤسسة اختبار','399999999900003','جدة') ON CONFLICT (singleton) DO NOTHING`);

  /* ---------- K) المفتاح ---------- */
  const a = await mkUser("a", { endsInHours: 84 });
  process.env.AUTORENEW_ENABLED = "0";
  const cap0 = await captureCardAfterPayment("00000000-0000-0000-0000-000000000000", { source: { token: "tok_x" } });
  let r = await call("GET", "/api/billing/autorenew", { token: a.token });
  ok("K1 معطَّل: الحالة available=false بلا عرض موافقة", r.status === 200 && r.body.available === false && r.body.offer === null);
  r = await call("POST", "/api/billing/autorenew/consent", { token: a.token, body: { consentVersion: AR.CONSENT_VERSION, amountSar: 29 } });
  ok("K2 معطَّل: الموافقة → 409 autorenew_unavailable", r.status === 409 && r.body.error === "autorenew_unavailable");
  ok("K3 معطَّل: المسح يعود فوراً، ولا حفظ بطاقة بعد الدفع", (await AR.sweepAutoRenewals()).reason === "autorenew_disabled" && cap0.reason === "autorenew_disabled");
  r = await call("POST", "/api/billing/autorenew/cancel", { token: a.token });
  ok("K4 الإلغاء متاح ولو كان المفتاح معطَّلاً (200، لم يكن مفعَّلاً)", r.status === 200 && r.body.wasActive === false);
  process.env.AUTORENEW_ENABLED = "1";

  /* ---------- 1) 7.1 البطاقة ---------- */
  const { rows: [inv0] } = await query(`INSERT INTO invoices (user_id, plan_id, amount_sar, status) VALUES ($1,'monthly',29,'paid') RETURNING id`, [a.id]);
  const cap = await captureCardAfterPayment(inv0.id, { id: "pay_1", status: "paid", source: { type: "creditcard", company: "mada", number: "4201-32XX-XXXX-4242", token: "token_SECRET_abc123" } });
  const { rows: cols } = await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'payment_methods'`);
  const { rows: [pm] } = await query(`SELECT * FROM payment_methods WHERE user_id = $1`, [a.id]);
  ok("1a بعد الدفع يُحفظ الرمز وحده: العلامة وآخر أربعة أرقام للعرض", cap.saved && pm.card_brand === "mada" && pm.card_last4 === "4242");
  ok("1b لا عمود لرقم البطاقة ولا للانتهاء ولا لـCVV", !cols.some((c) => /pan|number|cvv|cvc|expir|exp_/.test(c.column_name)), cols.map((c) => c.column_name).join(","));
  ok("1c الرمز مشفَّر في القاعدة (لا يظهر نصّه)", !Buffer.from(pm.token_ciphertext).toString("latin1").includes("token_SECRET") && !JSON.stringify(pm).includes("token_SECRET"));
  r = await call("GET", "/api/billing/autorenew", { token: a.token });
  ok("1d رد التطبيق يعرض mada ••4242 ولا يحمل الرمز", r.status === 200 && r.body.card?.last4 === "4242" && !r.raw.includes("token_SECRET"));

  /* ---------- 2) 7.2 الموافقة ---------- */
  const b = await mkUser("b", { endsInHours: 84 });
  await saveCard(b.id, { provider: "fake", token: "token_b", brand: "visa", last4: "1111" });
  ok("2a لا أثر رجعي: لا موافقة مزروعة، وكل الاشتراكات القائمة يدوية", (await query(`SELECT count(*)::int n FROM autorenew_consents`)).rows[0].n === 0
     && (await query(`SELECT count(*)::int n FROM subscription_state WHERE renewal_mode <> 'manual'`)).rows[0].n === 0);
  ok("2b العرض يحمل نصّ الموافقة بالباقة والمبلغ والبطاقة والمهلة", r.body.offer && r.body.offer.text.includes("الباقة الشهرية") && r.body.offer.text.includes("29.00 ر.س") && r.body.offer.text.includes("4242") && r.body.offer.text.includes("3 أيام"));
  r = await call("POST", "/api/billing/autorenew/consent", { token: a.token, body: { consentVersion: "2020-old", amountSar: 29 } });
  ok("2c نسخة نصّ قديمة → 409 consent_version_outdated", r.status === 409 && r.body.error === "consent_version_outdated");
  r = await call("POST", "/api/billing/autorenew/consent", { token: a.token, body: { consentVersion: AR.CONSENT_VERSION, amountSar: 19 } });
  ok("2d مبلغ غير المعروض → 409 consent_terms_changed (لا يُحفظ نصّ لم يره)", r.status === 409 && r.body.error === "consent_terms_changed");
  r = await call("POST", "/api/billing/autorenew/consent", { token: a.token, body: { consentVersion: AR.CONSENT_VERSION, amountSar: 29 } });
  const { rows: [ca] } = await query(`SELECT c.*, ss.renewal_mode FROM autorenew_consents c JOIN subscription_state ss ON ss.subscription_id = c.subscription_id WHERE c.user_id = $1`, [a.id]);
  ok("2e الموافقة → 201، محفوظة بنصّها ونسختها ووقتها، والتجديد صار تلقائياً", r.status === 201 && ca.consent_text === r.body.consent.text && ca.consent_version === AR.CONSENT_VERSION && ca.granted_at && ca.renewal_mode === "automatic");
  r = await call("POST", "/api/billing/autorenew/consent", { token: a.token, body: { consentVersion: AR.CONSENT_VERSION, amountSar: 29 } });
  ok("2f موافقة ثانية → 409 already_active", r.status === 409 && r.body.error === "already_active");
  r = await call("GET", "/api/billing/autorenew");
  ok("2g بلا جلسة → 401", r.status === 401);

  /* ---------- 3) 7.3 الإشعار ---------- */
  await AR.sweepAutoRenewals();
  await sink.waitMail(1);
  let ca1 = await cycleOf(a.subId);
  const notice = mailsTo(a.email);
  ok("3a إشعار قبل الخصم بالبريد: التاريخ والمبلغ والبطاقة", ca1?.status === "noticed" && notice.length === 1 && notice[0].includes("29.00 ر.س") && notice[0].includes("4242") && notice[0].includes(new Date(ca1.period_end).toISOString().slice(0, 10)), notice[0]?.slice(0, 160));
  ok("3b لا خصم وقت الإشعار، ولا شيء لمن لم يوافق (ب)", fake.calls.length === 0 && !(await cycleOf(b.subId)) && mailsTo(b.email).length === 0);
  await AR.sweepAutoRenewals();
  ok("3c مسح ثانٍ لا يكرر الإشعار", mailsTo(a.email).length === 1);
  await makeDue(a, 1);
  await AR.sweepAutoRenewals();
  ok("3d حلّ موعد الخصم لكن لم تمضِ مهلة الإشعار (يوم من 3) → لا خصم", fake.calls.length === 0 && (await cycleOf(a.subId)).status === "noticed");

  const c = await mkUser("c", { endsInHours: 84 });
  await saveCard(c.id, { provider: "fake", token: "token_c", brand: "visa", last4: "3333" });
  await AR.grantConsent(c.id, { consentVersion: AR.CONSENT_VERSION, amountSar: 29 });
  sink.ctl.reject = (line) => line.includes(c.email);
  await AR.sweepAutoRenewals();
  sink.ctl.reject = null;
  ok("3e إشعار لم يُسلَّم (رفض الخادم) → لا دورة، فلا خصم أبداً بلا إشعار", !(await cycleOf(c.subId)));
  await AR.sweepAutoRenewals();
  ok("3f ويُعاد في المسح التالي حين يُسلَّم", (await cycleOf(c.subId))?.status === "noticed");

  /* ---------- 4) 🔴 7.4 خصم واحد ---------- */
  // فاتورة عادية أولاً على التسلسل نفسه، لتُثبت 5) أن التجديد يأخذ الرقم التالي منه.
  const { rows: [reg] } = await query(`INSERT INTO invoices (user_id, plan_id, amount_sar, status) VALUES ($1,'monthly',29,'paid') RETURNING id`, [b.id]);
  const regNumber = await issueInvoiceDocument(reg.id);
  const periodBefore = (await query(`SELECT current_period_end FROM subscriptions WHERE id = $1`, [a.subId])).rows[0].current_period_end;
  await makeDue(a, 4);
  fake.delay = 300;
  const [s1, s2] = await Promise.all([AR.sweepAutoRenewals(), AR.sweepAutoRenewals()]);
  fake.delay = 0;
  const pays = (await query(`SELECT * FROM payments WHERE user_id = $1 AND provider = 'fake'`, [a.id])).rows;
  ok("4a 🔴 مسحان متزامنان → نداء خصم واحد ودفعة واحدة، والثاني انسحب", fake.calls.length === 1 && pays.length === 1 && [s1, s2].filter((x) => x.reason === "sweep_already_running").length === 1, `calls=${fake.calls.length} pays=${pays.length}`);
  ok("4b مفتاح منع التكرار لدى المزوّد = معرّف المحاولة، والمبلغ بالهللة هو المعلَن", fake.calls[0].idempotencyKey === (await query(`SELECT id FROM renewal_attempts WHERE cycle_key = $1`, [ca1.cycle_key])).rows[0].id && fake.calls[0].amountHalalas === 2900 && fake.calls[0].token === "token_SECRET_abc123");

  // بلا القفل: تمريرتان متوازيتان على دورة مستحقة (ج) — المطالبة الشرطية وحدها تمنع الخصم المزدوج.
  await makeDue(c, 4);
  fake.delay = 300;
  await Promise.all([AR.runRenewalPass(), AR.runRenewalPass(), AR.runRenewalPass()]);
  fake.delay = 0;
  ok("4c 🔴 ثلاث تمريرات بلا قفل متوازية → خصم واحد (المطالبة بالدورة)", fake.calls.filter((x) => x.token === "token_c").length === 1 && (await query(`SELECT count(*)::int n FROM payments WHERE user_id = $1`, [c.id])).rows[0].n === 1);
  await AR.sweepAutoRenewals();
  ok("4d ومسح لاحق لا يخصم الدورة الناجحة مرة أخرى", fake.calls.length === 2);

  /* ---------- 5) 7.5 الفاتورة والتمديد ---------- */
  const { rows: [renewInv] } = await query(`SELECT i.* FROM invoices i JOIN renewal_cycles rc ON rc.invoice_id = i.id WHERE rc.cycle_key = $1`, [ca1.cycle_key]);
  const regN = Number(regNumber.slice(-6));
  ok("5a فاتورة ضريبية على تسلسل TNFS-INV نفسه: الرقم التالي للفاتورة العادية", renewInv.status === "paid" && renewInv.zatca_invoice_number === formatDocumentNumber("TNFS-INV", null, regN + 1), `${regNumber} → ${renewInv.zatca_invoice_number}`);
  const periodAfter = (await query(`SELECT s.current_period_end, s.status, ss.renewal_mode FROM subscriptions s JOIN subscription_state ss ON ss.subscription_id = s.id WHERE s.id = $1`, [a.subId])).rows[0];
  ok("5b الاشتراك مُدَّد 30 يوماً من نهاية فترته، وبقي تلقائياً", Math.round((new Date(periodAfter.current_period_end) - new Date((await cycleOf(a.subId)).period_end)) / 86400000) === 30 && periodAfter.status === "active" && periodAfter.renewal_mode === "automatic", `${periodBefore} → ${periodAfter.current_period_end}`);
  await sink.waitMail(sink.inbox.length + 1);
  ok("5c رسالة «تجدّد اشتراكك» برقم الفاتورة", mailsTo(a.email).some((t) => t.includes(renewInv.zatca_invoice_number)));

  /* ---------- 6) 7.6 الفشل والتوقّف والمجهول ---------- */
  const d = await mkUser("d", { endsInHours: 84 });
  await saveCard(d.id, { provider: "fake", token: "token_d", brand: "visa", last4: "4444" });
  await AR.grantConsent(d.id, { consentVersion: AR.CONSENT_VERSION, amountSar: 29 });
  await AR.sweepAutoRenewals(); await makeDue(d, 4);
  fake.mode = "failed";
  await AR.sweepAutoRenewals();
  let cd = await cycleOf(d.subId);
  const hours = (new Date(cd.next_attempt_at) - Date.now()) / 3600000;
  ok("6a فشل أول → محاولة لاحقة بعد 24 ساعة، والاشتراك متعثّر لا ملغى", cd.status === "retry" && cd.attempts === 1 && hours > 23 && hours <= 24
     && (await query(`SELECT status FROM subscriptions WHERE id = $1`, [d.subId])).rows[0].status === "past_due");
  await sink.waitMail(sink.inbox.length + 1);
  ok("6b رسالة «تعذّر التجديد» بموعد المحاولة التالية", mailsTo(d.email).some((t) => t.includes(new Date(cd.next_attempt_at).toISOString().slice(0, 10))));
  await AR.sweepAutoRenewals();
  ok("6c قبل موعد المحاولة: لا نداء", fake.calls.filter((x) => x.token === "token_d").length === 1);
  for (let i = 0; i < 2; i++) { await query(`UPDATE renewal_cycles SET next_attempt_at = now() - interval '1 minute' WHERE cycle_key = $1 AND status = 'retry'`, [cd.cycle_key]); await AR.sweepAutoRenewals(); }
  cd = await cycleOf(d.subId);
  const { rows: [cdc] } = await query(`SELECT c.revoked_by, c.revoke_reason, ss.renewal_mode FROM autorenew_consents c JOIN subscription_state ss ON ss.subscription_id = c.subscription_id WHERE c.user_id = $1`, [d.id]);
  ok("6d بعد 3 محاولات: توقّف، وسُحبت الموافقة (system/retries_exhausted)، والتجديد يدوي", cd.status === "stopped" && cd.attempts === 3 && cdc.revoked_by === "system" && cdc.revoke_reason === "retries_exhausted" && cdc.renewal_mode === "manual");
  await query(`UPDATE renewal_cycles SET next_attempt_at = now() - interval '1 day' WHERE cycle_key = $1`, [cd.cycle_key]);
  await AR.sweepAutoRenewals();
  ok("6e لا محاولة رابعة أبداً", fake.calls.filter((x) => x.token === "token_d").length === 3 && (await query(`SELECT count(*)::int n FROM renewal_attempts WHERE cycle_key = $1`, [cd.cycle_key])).rows[0].n === 3);
  await sink.waitMail(sink.inbox.length + 1);
  ok("6f رسالة «توقّف التجديد التلقائي»", mailsTo(d.email).some((t) => t.includes("توقّف التجديد التلقائي")));

  const e = await mkUser("e", { endsInHours: 84 });
  await saveCard(e.id, { provider: "fake", token: "token_e", brand: "visa", last4: "5555" });
  await AR.grantConsent(e.id, { consentVersion: AR.CONSENT_VERSION, amountSar: 29 });
  await AR.sweepAutoRenewals(); await makeDue(e, 4);
  fake.mode = "throw";
  await AR.sweepAutoRenewals();
  fake.mode = "paid";
  let ce = await cycleOf(e.subId);
  for (let i = 0; i < 2; i++) { await query(`UPDATE renewal_cycles SET updated_at = now() - interval '1 day', next_attempt_at = now() - interval '1 day' WHERE cycle_key = $1`, [ce.cycle_key]); await AR.sweepAutoRenewals(); }
  ok("6g 🔴 نتيجة مجهولة (مهلة) → unknown، ولا إعادة محاولة مهما مرّ الوقت", (await cycleOf(e.subId)).status === "unknown" && fake.calls.filter((x) => x.token === "token_e").length === 1);
  await query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [ce.invoice_id]); // كأن الـwebhook سوّاها
  await AR.sweepAutoRenewals();
  ok("6h وإن سوّى الـwebhook فاتورتها تصير ناجحة بلا خصم جديد", (await cycleOf(e.subId)).status === "succeeded" && fake.calls.filter((x) => x.token === "token_e").length === 1);

  /* ---------- 7) 7.7 الإلغاء ---------- */
  const f = await mkUser("f", { endsInHours: 84 });
  await saveCard(f.id, { provider: "fake", token: "token_f", brand: "visa", last4: "6666" });
  await AR.grantConsent(f.id, { consentVersion: AR.CONSENT_VERSION, amountSar: 29 });
  await AR.sweepAutoRenewals();
  const endF = (await query(`SELECT current_period_end FROM subscriptions WHERE id = $1`, [f.subId])).rows[0].current_period_end;
  r = await call("POST", "/api/billing/autorenew/cancel", { token: f.token });
  ok("7a الإلغاء → 200 wasActive، والاشتراك باقٍ إلى نهايته", r.status === 200 && r.body.wasActive === true && new Date(r.body.subscriptionEndsAt).getTime() === new Date(endF).getTime());
  await query(`UPDATE subscriptions SET current_period_end = now() + interval '12 hours' WHERE id = $1`, [f.subId]);
  await query(`UPDATE renewal_cycles SET period_end = now() + interval '12 hours', notice_sent_at = now() - interval '4 days' WHERE subscription_id = $1`, [f.subId]);
  await AR.sweepAutoRenewals();
  const { rows: [cf] } = await query(`SELECT rc.status, ss.renewal_mode FROM renewal_cycles rc JOIN subscription_state ss ON ss.subscription_id = rc.subscription_id WHERE rc.subscription_id = $1`, [f.subId]);
  ok("7b بعد الإلغاء: الدورة ملغاة ولا خصم في موعدها، والتجديد يدوي", cf.status === "cancelled" && cf.renewal_mode === "manual" && !fake.calls.some((x) => x.token === "token_f"));
  r = await call("POST", "/api/billing/autorenew/cancel", { token: f.token });
  const g = await call("GET", "/api/billing/autorenew", { token: f.token });
  ok("7c إلغاء ثانٍ آمن (200 wasActive=false)، والحالة active=false والبطاقة باقية لإعادة التفعيل", r.status === 200 && r.body.wasActive === false && g.body.active === false && g.body.card?.last4 === "6666");
  r = await call("DELETE", "/api/billing/autorenew/card", { token: f.token });
  ok("7d إزالة البطاقة → لا بطاقة بعدها", r.status === 200 && r.body.cardRemoved === true && (await call("GET", "/api/billing/autorenew", { token: f.token })).body.card === null);

  /* ---------- 8) 7.8 الإدارة ---------- */
  const owner = await adminCookie("owner"), support = await adminCookie("support");
  r = await call("GET", `/admin/users/${a.id}/autorenew`, { cookie: owner.cookie });
  ok("8a العرض: الموافقة بنصّها، والبطاقة ••4242، والدورات بمحاولاتها ورقم الفاتورة — بلا رمز", r.status === 200 && r.body.active?.consent_text && r.body.cards[0].last4 === "4242"
     && r.body.cycles[0].invoice_number === renewInv.zatca_invoice_number && r.body.cycles[0].attempts_log.length === 1 && !r.raw.includes("token_SECRET") && !r.raw.includes("ciphertext"));
  r = await call("GET", `/admin/autorenew?status=unknown`, { cookie: owner.cookie });
  ok("8b قائمة الدورات بفلتر الحالة", r.status === 200 && r.body.enabled === true && r.body.counts.active_consents >= 2 && r.body.cycles.every((x) => x.status === "unknown"));
  r = await call("POST", `/admin/users/${a.id}/autorenew/disable`, { cookie: support.cookie, body: { reason: "x" } });
  ok("8c الدعم لا يوقف (subscriptions:edit) → 403", r.status === 403);
  // ملحق القرار 1: لا سبب مكتوب — الإيقاف ينجح والسبب تلقائي.
  r = await call("POST", `/admin/users/${a.id}/autorenew/disable`, { cookie: owner.cookie, body: {} });
  ok("8d بلا سبب مكتوب → 200 (لا 400)", r.status === 200, r.raw);
  const { rows: [aud] } = await query(`SELECT old_value, new_value, reason, target_user_id FROM admin_action_log WHERE action = 'autorenew_disable' ORDER BY created_at DESC LIMIT 1`);
  const { rows: [cr] } = await query(`SELECT revoked_by, revoked_by_admin, revoke_reason FROM autorenew_consents WHERE user_id = $1 ORDER BY granted_at DESC LIMIT 1`, [a.id]);
  ok("8e الإيقاف: الموافقة مسحوبة باسم المشرف وبسبب تلقائي، وفي سجل الإجراءات بالقيمتين", cr.revoked_by === "admin" && cr.revoked_by_admin === owner.id && cr.revoke_reason === "إيقاف التجديد التلقائي للعميل من اللوحة" && aud.reason === "إيقاف التجديد التلقائي للعميل من اللوحة"
     && aud.old_value.autorenew === "active" && aud.new_value.autorenew === "disabled_by_admin" && aud.target_user_id === a.id);
  r = await call("POST", `/admin/users/${a.id}/autorenew/disable`, { cookie: owner.cookie, body: { reason: "مرة ثانية" } });
  ok("8f إيقاف ما ليس مفعَّلاً → 409", r.status === 409);

  /* ---------- 9) استبدال البطاقة ---------- */
  const h = await mkUser("h", { endsInHours: 200 });
  await saveCard(h.id, { provider: "fake", token: "token_h1", brand: "visa", last4: "7777" });
  await AR.grantConsent(h.id, { consentVersion: AR.CONSENT_VERSION, amountSar: 29 });
  const rep = await saveCard(h.id, { provider: "fake", token: "token_h2", brand: "mada", last4: "8888" });
  ok("9a بطاقة جديدة تُخرج السابقة وتسحب الموافقة (نصّها ذكر البطاقة السابقة)", rep.consentRevoked && (await query(`SELECT count(*)::int n FROM payment_methods WHERE user_id = $1 AND removed_at IS NULL`, [h.id])).rows[0].n === 1
     && (await query(`SELECT revoke_reason FROM autorenew_consents WHERE user_id = $1`, [h.id])).rows[0].revoke_reason === "card_replaced");
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 400), false); }
finally { setRenewalProviderForTests(null); server.close(); sink.close(); await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; process.stdout.write(`  PASS  ${l}\n`); } else { fail++; process.stdout.write(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 300)})` : ""}\n`); } }
process.stdout.write(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
