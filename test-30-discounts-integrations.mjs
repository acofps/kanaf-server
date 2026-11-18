import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0008 §6 و§7 و§12.6.
 *
 *  D) أكواد الخصم: الإنشاء والتحقق (مدة، حد، باقة)، والقرار المحدَّد (لا 100%،
 *     ولا مبلغ يبلغ السعر)، والصلاحية من الخادم، والسبب والسجل، والحالة الفارغة.
 *  L) 🔴 لا ربط بالدفع: لا ملف في الدفع أو الفوترة أو البريد أو الإشعارات أو
 *     الاشتراك يستورد وحدات الخصم أو التكاملات.
 *  K) التكاملات: للمالك وحده؛ بلا مفتاح تشفير لا حفظ؛ لا سرّ في أي رد ولا في
 *     أي عمود نصي ولا في سجل الإجراءات ولا في مخرج الخادم؛ فحص اتصال بمزوّد وهمي.
 *  U) §12.6: لا تكرار في أسماء المفاتيح عبر الإعدادات والتكاملات معاً.
 */
requireDedicatedDatabase(import.meta.url);
import fs from "node:fs";
import path from "node:path";
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { discountsRouter } = await import("./admin/discounts.js");
const { integrationsRouter } = await import("./admin/integrations.js");
const { INTEGRATIONS, allFullKeyNames } = await import("./integrations/catalog.js");
const { SETTINGS_REGISTRY } = await import("./admin/settings.js");

/* كل ما يطبعه الخادم يُلتقط — لا يجوز أن يظهر فيه سرّ. */
const printed = [];
for (const k of ["log", "error", "warn"]) { const o = console[k]; console[k] = (...a) => { printed.push(a.map(String).join(" ")); if (k !== "log") return; o(...a); }; }
const out = (s) => process.stdout.write(s + "\n");

/* مزوّد وهمي لفحص الاتصال — يسجّل ما وصله، ولا طلب يغادر الجهاز */
const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (href.startsWith("https://api.moyasar.com")) { seen.push({ href, auth: opts.headers?.Authorization }); return new Response(JSON.stringify({ payments: [] }), { status: 200 }); }
  return realFetch(url, opts);
};

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/admin", discountsRouter); app.use("/admin", integrationsRouter);
const server = app.listen(4630); const B = "http://127.0.0.1:4630";
let cookie = "";
const as = async (role) => {
  const base = role === "accountant" ? "support" : role;
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ($1,$2,'x',$3) RETURNING id`, [`di ${role}`, `di-${role}-${Math.random()}@kanaf.test`, base]);
  if (role === "accountant") await query(`INSERT INTO admin_role_assignments (admin_user_id, role) VALUES ($1,'accountant')`, [a.id]);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: a.id, role: base, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  return a.id;
};
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ } return { status: r.status, body: json, raw };
};

try {
  /* ================= D) أكواد الخصم ================= */
  await query(`INSERT INTO subscription_plans (plan_key, name, price_sar, duration_days, features, display_order)
               VALUES ('monthly', 'الباقة الشهرية', 29.00, 30, ARRAY['x'], 1), ('yearly', 'الباقة السنوية', 290.00, 365, ARRAY['x'], 2)
               ON CONFLICT (plan_key) DO UPDATE SET price_sar = EXCLUDED.price_sar`);
  await as("admin");
  let r = await call("GET", "/admin/discount-codes");
  ok("D0 حالة فارغة: 200، صفر، وlinkedToPayments=false", r.status === 200 && r.body.total === 0 && r.body.codes.length === 0 && r.body.linkedToPayments === false);
  r = await call("POST", "/admin/discount-codes", { code: "spring20", kind: "percent", value: 20 });
  ok("D1 بلا سبب → 400", r.status === 400 && r.body.error === "reason_required");
  r = await call("POST", "/admin/discount-codes", { code: "spring20", kind: "percent", value: 20, reason: "حملة الربيع" });
  ok("D2 إنشاء → 201 والكود بحروف كبيرة", r.status === 201 && r.body.code === "SPRING20", r.raw);
  const audit = (await query(`SELECT action, reason FROM admin_action_log WHERE entity = 'discount_code' AND entity_id = $1`, [r.body.id])).rows;
  ok("D3 الإنشاء في سجل الإجراءات بسببه", audit.length === 1 && audit[0].action === "discount_code_create" && audit[0].reason === "حملة الربيع");
  r = await call("POST", "/admin/discount-codes", { code: "SPRING20", kind: "amount", value: 5, reason: "x" });
  ok("D4 كود مكرر → 409", r.status === 409);
  r = await call("POST", "/admin/discount-codes", { code: "FREE100", kind: "percent", value: 100, reason: "x" });
  ok("D5 خصم 100% مرفوض (قرار محدَّد لا مكتشَف)", r.status === 400 && r.body.error === "percent_must_be_below_100");
  r = await call("POST", "/admin/discount-codes/check", { code: "spring20", planKey: "monthly" });
  ok("D6 فحص صالح: 29 → 23.20، والضريبة تُعاد حسابها على الوعاء الجديد", r.body.valid === true && r.body.preview.finalSar === 23.2 && r.body.preview.vatSplitAfter.total === "23.20"
    && r.body.preview.vatSplitAfter.vat !== r.body.preview.vatSplitBefore.vat, JSON.stringify(r.body.preview));
  await call("POST", "/admin/discount-codes", { code: "BIG30", kind: "amount", value: 30, reason: "x" });
  r = await call("POST", "/admin/discount-codes/check", { code: "BIG30", planKey: "monthly" });
  ok("D7 مبلغ يبلغ السعر أو يتجاوزه → غير صالح (لا فاتورة بصفر)", r.body.valid === false && r.body.reason === "discount_reaches_price");
  const { body: yr } = await call("POST", "/admin/discount-codes", { code: "YEARLY10", kind: "percent", value: 10, planKeys: ["yearly"], reason: "x" });
  r = await call("POST", "/admin/discount-codes/check", { code: "YEARLY10", planKey: "monthly" });
  ok("D8 باقة غير مشمولة → plan_not_eligible", r.body.reason === "plan_not_eligible");
  await call("POST", "/admin/discount-codes", { code: "OLD", kind: "percent", value: 10, validFrom: "2025-01-01T00:00:00Z", validUntil: "2025-02-01T00:00:00Z", reason: "x" });
  r = await call("POST", "/admin/discount-codes/check", { code: "OLD", planKey: "monthly" });
  ok("D9 منتهي المدة → expired", r.body.reason === "expired");
  const { body: lim } = await call("POST", "/admin/discount-codes", { code: "ONCE", kind: "percent", value: 10, maxRedemptions: 1, reason: "x" });
  const { rows: [u] } = await query(`INSERT INTO users (name, email, password_hash) VALUES ('مستخدم', 'disc-u@example.com', 'x') RETURNING id`);
  await query(`INSERT INTO discount_code_redemptions (discount_code_id, user_id) VALUES ($1, $2)`, [lim.id, u.id]);
  r = await call("POST", "/admin/discount-codes/check", { code: "ONCE", planKey: "monthly" });
  ok("D10 بلغ حد الاستعمال → limit_reached", r.body.reason === "limit_reached");
  r = await call("GET", `/admin/discount-codes/${lim.id}/redemptions`);
  ok("D11 «من استعمله» مقنَّع", r.body.redemptions.length === 1 && r.body.redemptions[0].user_email_masked === "d***@example.com");
  const sp = (await call("GET", "/admin/discount-codes")).body.codes.find((c) => c.code === "SPRING20");
  r = await call("POST", `/admin/discount-codes/${sp.id}/active`, { active: false, reason: "إيقاف" });
  const chk = await call("POST", "/admin/discount-codes/check", { code: "SPRING20", planKey: "monthly" });
  ok("D12 الإيقاف بسبب، ثم الفحص → inactive", r.status === 200 && chk.body.reason === "inactive");
  const p1 = await call("GET", "/admin/discount-codes?pageSize=2&page=1"), p3 = await call("GET", "/admin/discount-codes?pageSize=2&page=3");
  ok("D13 الترقيم", p1.body.codes.length === 2 && p1.body.totalPages === 3 && p3.body.codes.length === 1, `${p1.body.total}`);
  await as("accountant");
  r = await call("GET", "/admin/discount-codes"); const w = await call("POST", "/admin/discount-codes", { code: "ACC", kind: "percent", value: 5, reason: "x" });
  ok("D14 المحاسب يقرأ ولا يكتب (403 من الخادم)", r.status === 200 && w.status === 403);
  await as("support");
  ok("D15 الدعم لا يرى (403)", (await call("GET", "/admin/discount-codes")).status === 403);

  /* ================= L) لا ربط بالدفع ================= */
  const scan = ["payments", "invoicing", "mail", "notifications", "auth", "userdata", "content"].flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".js")).map((f) => path.join(d, f)))
    .concat(["billing/subscription.js", "billing/config.js", "index.js"]);
  const linked = scan.filter((f) => /from\s+["'][^"']*(billing\/discounts|integrations\/)/.test(fs.readFileSync(f, "utf8")));
  ok(`L1 🔴 لا ملف تشغيلي يستورد الخصم أو التكاملات (${scan.length} ملفاً)`, linked.length === 0, linked.join(" "));

  /* ================= K) التكاملات ================= */
  const SECRET = `sk_test_${"Q".repeat(12)}Zx9WAbcd`;
  await as("admin");
  r = await call("GET", "/admin/integrations");
  ok("K1 المدير (غير المالك) → 403 من الخادم", r.status === 403);
  const owner = await as("owner");
  delete process.env.INTEGRATIONS_ENC_KEY;
  r = await call("GET", "/admin/integrations");
  ok("K2 القائمة تعلن أن التشفير غير مضبوط", r.status === 200 && r.body.encryptionConfigured === false && r.body.services.length === Object.keys(INTEGRATIONS).length);
  r = await call("PUT", "/admin/integrations/moyasar/secret_key", { value: SECRET, reason: "ضبط" });
  ok("K3 بلا INTEGRATIONS_ENC_KEY لا حفظ إطلاقاً (503) ولا صف", r.status === 503 && (await query(`SELECT count(*)::int AS n FROM integration_credentials`)).rows[0].n === 0);
  process.env.INTEGRATIONS_ENC_KEY = "a".repeat(64);
  r = await call("PUT", "/admin/integrations/moyasar/secret_key", { value: SECRET });
  ok("K4 بلا سبب → 400", r.status === 400);
  r = await call("PUT", "/admin/integrations/moyasar/secret_key", { value: SECRET, reason: "ضبط مفتاح الاختبار" });
  ok("K5 الحفظ → 200 ومقنَّع بآخر أربعة فقط", r.status === 200 && r.body.masked === "••••Abcd" && !r.raw.includes(SECRET.slice(0, -4)), r.raw);
  const { rows: [row] } = await query(`SELECT ciphertext, iv, auth_tag, last4 FROM integration_credentials WHERE service='moyasar' AND key_name='secret_key'`);
  ok("K6 المخزَّن مشفَّر: لا نص صريح في البايتات", row && !Buffer.from(row.ciphertext).toString("latin1").includes("sk_test_") && row.iv.length === 12 && row.auth_tag.length === 16);
  const { rows: textCols } = await query(`SELECT c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t
    ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.data_type IN ('text','character varying','jsonb','json','ARRAY')`);
  const hits = [];
  for (const { table_name: tb, column_name: col } of textCols) {
    const { rows } = await query(`SELECT count(*)::int AS n FROM "${tb}" WHERE "${col}"::text LIKE $1`, [`%${SECRET.slice(0, 16)}%`]);
    if (rows[0].n) hits.push(`${tb}.${col}`);
  }
  ok("K7 🔴 السرّ غير موجود في أي عمود نصي — ولا في سجل الإجراءات", hits.length === 0, hits.join(" "));
  const logRows = (await query(`SELECT action, old_value, new_value, metadata FROM admin_action_log WHERE entity = 'integration_credential'`)).rows;
  ok("K8 سجل الإجراءات: صف بالسبب، بلا قيمة ولا آخر أربعة", logRows.length === 1 && logRows[0].action === "integration_credential_set" && !JSON.stringify(logRows).includes("Abcd"), JSON.stringify(logRows));
  r = await call("GET", "/admin/integrations");
  const mf = r.body.services.find((s) => s.service === "moyasar").fields.find((f) => f.key === "secret_key");
  ok("K9 القائمة: configured ومقنَّع، ولا سرّ في الرد كله", mf.configured === true && mf.masked === "••••Abcd" && !r.raw.includes(SECRET.slice(0, 12)));
  r = await call("PUT", "/admin/integrations/moyasar/secret_key", { value: SECRET + "2", reason: "تدوير" });
  ok("K10 الاستبدال يُسجَّل replace", (await query(`SELECT count(*)::int AS n FROM admin_action_log WHERE action = 'integration_credential_replace'`)).rows[0].n === 1);
  await call("PUT", "/admin/integrations/moyasar/secret_key", { value: SECRET, reason: "إرجاع" });
  r = await call("PUT", "/admin/integrations/moyasar/not_a_field", { value: "x", reason: "x" });
  ok("K11 حقل خارج الكتالوج → 404", r.status === 404);
  r = await call("PUT", "/admin/integrations/mailgun/region", { value: "asia", reason: "x" });
  ok("K12 قيمة خارج المسموح (region) → 400", r.status === 400);
  r = await call("POST", "/admin/integrations/moyasar/test", { reason: "فحص" });
  ok("K13 فحص الاتصال بمزوّد وهمي: ok، والمفتاح فُكّ تشفيره داخل الخادم فقط",
    r.status === 200 && r.body.ok === true && r.body.httpStatus === 200 && seen.length === 1 && seen[0].auth === `Basic ${Buffer.from(`${SECRET}:`).toString("base64")}` && !r.raw.includes(SECRET.slice(0, 12)), r.raw);
  r = await call("POST", "/admin/integrations/qoyod/test", { reason: "فحص" });
  ok("K14 خدمة بلا فحص موثَّق → 501 صريح لا تخمين", r.status === 501 && r.body.error === "test_not_available");
  r = await call("DELETE", "/admin/integrations/moyasar/secret_key", { reason: "حذف" });
  const after = (await call("GET", "/admin/integrations")).body.services.find((s) => s.service === "moyasar").fields.find((f) => f.key === "secret_key");
  ok("K15 الحذف بسبب → غير مضبوط", r.status === 200 && after.configured === false);
  ok("K16 🔴 لا سرّ في أي سطر طبعه الخادم", !printed.some((s) => s.includes(SECRET.slice(0, 12))));

  /* ================= U) §12.6 تفرّد أسماء المفاتيح ================= */
  const integ = allFullKeyNames();
  const { rows: dbKeys } = await query(`SELECT key FROM app_settings`);
  const settingKeys = [...new Set([...dbKeys.map((x) => x.key), ...SETTINGS_REGISTRY.map((s) => s.key)])];
  const dupInteg = integ.filter((k, i) => integ.indexOf(k) !== i);
  const cross = integ.filter((k) => settingKeys.includes(k));
  ok(`U1 لا تكرار داخل التكاملات (${integ.length} مفتاحاً)`, dupInteg.length === 0, dupInteg.join(","));
  ok(`U2 لا اسم مفتاح مشترك بين التكاملات والإعدادات (${settingKeys.length} إعداداً)`, cross.length === 0 && settingKeys.length > 5, cross.join(","));
  const regDup = SETTINGS_REGISTRY.map((s) => s.key).filter((k, i, a) => a.indexOf(k) !== i);
  ok("U3 لا تكرار داخل سجل الإعدادات نفسه", regDup.length === 0, regDup.join(","));
  void owner;
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; out(`  PASS  ${l}`); } else { f++; out(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
out(`\n  ${p} passed, ${f} failed`);
server.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
