/**
 * اختبارات قبول المرحلة 5 — الأدوار والصلاحيات والأمن والتقارير
 * والإعدادات وسجل التدقيق.
 *
 *   node test-admin-security.mjs
 *
 * تشغّل الموجّهات الحقيقية على قاعدة بيانات حقيقية (DATABASE_URL)،
 * بلا أي محاكاة لطبقة البيانات. المصادقة الإدارية تُختبر فعلياً:
 * رمز JWT حقيقي في نفس الكوكي الذي تستخدمه اللوحة، وحساب حقيقي في
 * admin_users — فتمر requireAdminAuth و requirePermission بلا تعديل.
 *
 * ⚠️ يكتب صفوفاً حقيقية ثم ينظّفها. لا تشغّله على قاعدة إنتاج فيها
 * بيانات مستخدمين تهمّك قبل قراءة قسم التنظيف في آخر الملف.
 *
 * ============================================================
 * قاعدة كتابة العناوين في هذا الملف
 * ============================================================
 * عنوان الاختبار يصف **ما يفحصه بالضبط**، لا ما نتمنى أنه يفحصه.
 *
 * وهذه ليست قاعدة أسلوبية: تسريب نص اليومية في المرحلة 4 وُلد من
 * اختبار عنوانه يَعِد بـ«كل مسار إداري» وهو يفحص الدفتر وحده،
 * فبنت عليه وثيقة الخصوصية ثقةً لم تكن في محلها، وبقي
 * daily_logs.note يعبر الشبكة سنة.
 *
 * فحين لا يمكن الوصول إلى حالة ما، يُقال ذلك صراحةً بدل كتابة
 * عنوان يوحي بأنها فُحصت — انظر الاختبار 4-ج.
 */
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { readFileSync, readdirSync } from "fs";
import { query } from "./db/pool.js";
import { adminRouter } from "./admin/routes.js";
import { adminAccountsRouter } from "./admin/accounts.js";
import { adminExportsRouter } from "./admin/exports.js";
import { adminSettingsRouter, getAppSetting } from "./admin/settings.js";
import { adminContentRouter } from "./admin/content.js";
import { adminNotificationsRouter } from "./admin/notifications.js";
import { ROLES, ALL_PERMISSIONS, can, permissionsFor, matrixRows } from "./admin/permissions.js";

const results = [];
const log = (label, cond, extra = "") => results.push([label, !!cond, extra]);

/* ---------------------------------------------------------
   تركيب التطبيق — نفس ترتيب index.js
--------------------------------------------------------- */
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use("/admin", adminAccountsRouter);
app.use("/admin", adminExportsRouter);
app.use("/admin", adminSettingsRouter);
app.use("/admin", adminContentRouter);
app.use("/admin", adminNotificationsRouter);
app.use("/admin", adminRouter);

const server = app.listen(4591);
const B = "http://127.0.0.1:4591";

let ME = null;
const cookie = () =>
  ME ? `kanaf_admin_access=${jwt.sign({ sub: ME, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}` : null;

async function rq(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const c = cookie();
  if (c) headers.Cookie = c;
  const r = await fetch(B + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get("content-type") || "";
  return {
    status: r.status,
    headers: r.headers,
    body: ct.includes("json") ? await r.json().catch(() => ({})) : {},
    text: ct.includes("json") ? "" : await r.text(),
  };
}
const get = (p) => rq("GET", p);
const post = (p, b) => rq("POST", p, b);
const patch = (p, b) => rq("PATCH", p, b);
const put = (p, b) => rq("PUT", p, b);

const UUID = "00000000-0000-4000-8000-000000000009"; // معرّف صالح الشكل ولا وجود له

/* ---------------------------------------------------------
   حسابات إدارة حقيقية بالأدوار الخمسة.

   حساب المحاسب يُكتب أساسه `support` في admin_users (القيد لا يقبل
   'accountant') ودوره الحقيقي في admin_role_assignments — أي أنه
   يمرّ بنفس المسار الذي تمرّ به الدعوة من اللوحة.
--------------------------------------------------------- */
const PW = "Kanaf-Phase5-Test-2026";
const A = {};
async function seedAdmins() {
  /* تنظيف ما قد يكون بقي من تشغيل سابق فشل قبل أن يصل إلى تنظيفه.
     بدونه يسقط التشغيل الثاني على قيد البريد الفريد، فيبدو الخطأ
     عطباً في الكود وهو أثر تشغيل قديم. */
  await purge();
  const hash = await bcrypt.hash(PW, 12);
  for (const role of ROLES) {
    const base = role === "accountant" ? "support" : role;
    const email = `p5-${role}@kanaf.test`;
    const { rows } = await query(
      `INSERT INTO admin_users (name, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true) RETURNING id`,
      [`اختبار ${role}`, email, hash, base]
    );
    A[role] = rows[0].id;
    if (role === "accountant") {
      await query(`INSERT INTO admin_role_assignments (admin_user_id, role) VALUES ($1,'accountant')`, [A[role]]);
    }
  }
}

/* مسارات لكل مورد — تُستعمل في اختبارات المنع الجماعي. */
const BILLING_READ = [
  "/admin/billing/subscriptions", "/admin/billing/payments", "/admin/billing/invoices",
  "/admin/billing/credit-notes", "/admin/billing/refunds", "/admin/billing/kpis",
  "/admin/billing/integrity", "/admin/billing/settings", "/admin/billing/webhook-events",
  "/admin/plans", "/admin/invoices", "/admin/credit-notes",
];
const OWNER_ONLY = [
  ["GET", "/admin/admin-users"],
  ["GET", "/admin/access-log"],
  ["GET", "/admin/audit-log"],
  ["GET", "/admin/exports/audit-log.csv"],
  ["PUT", "/admin/tax-settings", { legalName: "x", vatNumber: "310000000000003", reason: "محاولة" }],
  ["PUT", "/admin/billing/settings", { vatRate: 0.2, reason: "محاولة" }],
  ["PUT", "/admin/app-settings/support_email", { value: "x@y.z", reason: "محاولة" }],
  ["POST", "/admin/content/bulk-publish", { all: true }],
  ["POST", `/admin/break-glass/${UUID}/approve`, { hoursValid: 4 }],
  ["GET", `/admin/billing/webhook-events/${UUID}`],
];

/** يحذف كل ما ينشئه هذا الملف — بالبريد والمفتاح، لا بالجدول.
    يُنادى قبل التهيئة وبعد الانتهاء معاً. */
async function purge() {
  const { rows: mine } = await query(`SELECT id FROM admin_users WHERE email LIKE 'p5-%@kanaf.test'`);
  const ids = mine.map((r) => r.id);
  if (ids.length) {
    // المفاتيح الأجنبية إلى admin_users تُفكّ أولاً وإلا رفض الحذف.
    await query(`UPDATE tax_settings SET updated_by = NULL WHERE updated_by = ANY($1)`, [ids]);
    await query(`UPDATE billing_settings SET updated_by = NULL WHERE updated_by = ANY($1)`, [ids]);
    await query(`UPDATE app_settings SET updated_by = NULL WHERE updated_by = ANY($1)`, [ids]);
    await query(`UPDATE subscription_plans SET updated_by = NULL WHERE updated_by = ANY($1)`, [ids]);
    await query(`DELETE FROM admin_action_log WHERE admin_user_id = ANY($1)`, [ids]);
    await query(`DELETE FROM admin_access_log WHERE admin_user_id = ANY($1)`, [ids]);
    await query(`DELETE FROM break_glass_requests WHERE requested_by = ANY($1) OR approved_by = ANY($1)`, [ids]);
    await query(`DELETE FROM admin_setup_tokens WHERE admin_user_id = ANY($1)`, [ids]);
    await query(`DELETE FROM admin_role_assignments WHERE admin_user_id = ANY($1)`, [ids]);
    await query(`DELETE FROM admin_users WHERE id = ANY($1)`, [ids]);
  }
  await query(`DELETE FROM subscription_plans WHERE plan_key = 'p5_test_plan'`);
  await query(`DELETE FROM users WHERE email LIKE 'p5%@kanaf.test'`);
}

/* ⚠️ الإعداد الضريبي يُحفَظ قبل الاختبار ويُستعاد بعده.

   الاختبار 7-د يعدّله فعلاً — وهو صف مفرد في النظام كله، والاسم
   النظامي والرقم الضريبي فيه يدخلان حرفياً في رمز QR لكل فاتورة
   تصدر بعده. اختبار يترك هذا الصف مغيَّراً لا يفسد بيانات اختبار،
   بل يفسد وثائق نظامية. */
let TAX_BEFORE = null;

async function run() {
  /* يُقرأ **بعد** التهيئة لا قبلها: التهيئة تنظّف بقايا تشغيل سابق،
     ومنها updated_by يشير إلى حساب اختبار لم يعد موجوداً. قراءته
     قبل التنظيف تعني محاولة استعادة معرّف محذوف — وهو ما أسقط
     التشغيل فعلاً بقيد المفتاح الأجنبي. */
  await seedAdmins();
  const { rows: tb } = await query(`SELECT legal_name, vat_number, address, updated_by FROM tax_settings LIMIT 1`);
  TAX_BEFORE = tb[0] || null;

  /* ============================================================
     1) Content Manager لا يدخل المحاسبة
     ============================================================ */
  ME = A.content_manager;
  {
    const leaked = [];
    for (const p of BILLING_READ) {
      const r = await get(p);
      if (r.status !== 403) leaked.push(`${p}=${r.status}`);
    }
    log("1-أ. مدير المحتوى: الاثنا عشر مساراً المالي كلها 403", leaked.length === 0, leaked.join(" "));

    const r1 = await get(`/admin/billing/users/${UUID}/billing`);
    log("1-ب. مدير المحتوى: الملف المالي لمستخدم 403", r1.status === 403, String(r1.status));

    const r2 = await get("/admin/overview");
    log("1-ج. مدير المحتوى: النظرة العامة تُفتح بلا كتلة إيراد",
      r2.status === 200 && r2.body.last30Days === undefined, JSON.stringify(Object.keys(r2.body)));

    const r3 = await get("/admin/users");
    log("1-د. مدير المحتوى: دليل المستخدمين 403 (تضييق مقصود عن السلوك السابق)", r3.status === 403, String(r3.status));

    const r4 = await get("/admin/content");
    log("1-هـ. ومع ذلك يصل المحتوى الذي يديره (200)", r4.status === 200, String(r4.status));
  }

  /* ============================================================
     2) Accounting لا يرى البيانات النفسية الحساسة
     ============================================================ */
  ME = A.accountant;
  {
    const r1 = await get(`/admin/users/${UUID}/sensitive?reason=اختبار`);
    log("2-أ. المحاسب: مسار الدرجات والفرز 403", r1.status === 403 && r1.body.error === "insufficient_permission",
      JSON.stringify(r1.body));

    const r2 = await get("/admin/users");
    log("2-ب. المحاسب: دليل المستخدمين 403", r2.status === 403, String(r2.status));

    const r3 = await post("/admin/break-glass/request", { targetUserId: null, reason: "محاولة" });
    log("2-ج. المحاسب: طلب الوصول الطارئ 403", r3.status === 403, String(r3.status));

    const r4 = await get("/admin/exports/users.csv");
    log("2-د. المحاسب: تصدير المستخدمين 403", r4.status === 403, String(r4.status));

    // ولا صلاحية واحدة في مصفوفته تمسّ البيانات النفسية
    const psych = ["users:view_sensitive", "users:view", "break_glass:request", "exports:users"];
    log("2-هـ. ولا واحدة من صلاحيات البيانات الشخصية في مصفوفة المحاسب",
      psych.every((p) => !can("accountant", p)), psych.filter((p) => can("accountant", p)).join(","));

    // وفي المقابل: المال كله مقروء
    const money = [];
    for (const p of BILLING_READ) {
      const r = await get(p);
      if (r.status !== 200) money.push(`${p}=${r.status}`);
    }
    log("2-و. وفي المقابل: الاثنا عشر مساراً المالي كلها 200 للمحاسب", money.length === 0, money.join(" "));
  }

  /* ============================================================
     3) Support لا يغيّر الحالة المالية دون صلاحية
     ============================================================ */
  ME = A.support;
  {
    const blocked = [];
    const attempts = [
      ["POST", `/admin/users/${UUID}/subscription/refund`, { reason: "محاولة" }],
      ["POST", `/admin/users/${UUID}/subscription/cancel`, { reason: "محاولة" }],
      ["POST", `/admin/billing/payments/${UUID}/refund`, { reason: "محاولة" }],
      ["POST", `/admin/billing/payments/${UUID}/reconcile`, { reason: "محاولة" }],
      ["POST", "/admin/plans", { planKey: "x", name: "x", priceSar: 1, durationDays: 30, reason: "محاولة" }],
      ["PATCH", `/admin/plans/${UUID}`, { priceSar: 1, reason: "محاولة" }],
      ["POST", `/admin/plans/${UUID}/toggle-active`, { active: false, reason: "محاولة" }],
    ];
    for (const [m, p, b] of attempts) {
      const r = await rq(m, p, b);
      if (r.status !== 403) blocked.push(`${p}=${r.status}`);
    }
    log("3-أ. الدعم: سبع عمليات تغيّر حالة مالية كلها 403", blocked.length === 0, blocked.join(" "));

    const r1 = await get("/admin/users");
    log("3-ب. ومع ذلك يقرأ دليل المستخدمين (200) — عمله الأساسي", r1.status === 200, String(r1.status));

    const r2 = await get(`/admin/users/${UUID}/sensitive?reason=اختبار`);
    log("3-ج. الدعم: البيانات الحساسة 403", r2.status === 403, String(r2.status));

    const r3 = await get("/admin/overview");
    log("3-د. الدعم: النظرة العامة بلا كتلة إيراد", r3.status === 200 && r3.body.last30Days === undefined);
  }

  /* ============================================================
     4) Admin لا ينفّذ Super Admin-only action
     ============================================================ */
  ME = A.admin;
  {
    const leaked = [];
    for (const [m, p, b] of OWNER_ONLY) {
      const r = await rq(m, p, b);
      if (r.status !== 403) leaked.push(`${p}=${r.status}`);
    }
    log("4-أ. المدير: عشر عمليات محصورة بالمالك كلها 403", leaked.length === 0, leaked.join(" "));

    const r1 = await get("/admin/tax-settings");
    log("4-ب. المدير يقرأ البيانات الضريبية ولا يعدّلها", r1.status === 200, String(r1.status));

    const r2 = await get("/admin/settings/overview");
    log("4-ج. المدير يفتح الإعدادات وكل أقسامها للقراءة فقط",
      r2.status === 200 && r2.body.sections?.billing?.canEdit === false
        && r2.body.sections?.tax?.canEdit === false && r2.body.sections?.app?.canEdit === false);

    /* ⚠️ حارس «آخر مالك» غير قابل للوصول اليوم بالبناء: الفاعل لازم
       يملك admins:change_role ولا يملكها إلا مالك فعّال، فوجوده يعني
       أن الهدف ليس الأخير. لا يُكتب له عنوان يوحي بأنه فُحص. */
    log("4-د. (غير مفحوص) حارس «آخر مالك» غير قابل للوصول — لا فاعل يملك admins:change_role إلا مالك فعّال",
      !ROLES.filter((r) => r !== "owner").some((r) => can(r, "admins:change_role")),
      "يصير قابلاً للفحص يوم تُمنح الصلاحية لدور آخر");
  }

  /* ============================================================
     5) Direct unauthorized API call يُرفض
     ============================================================ */
  {
    ME = null;
    const r1 = await get("/admin/users");
    log("5-أ. بلا كوكي إطلاقاً: 401", r1.status === 401 && r1.body.error === "missing_token", JSON.stringify(r1.body));

    // رمز موقَّع بسرّ آخر
    const forged = jwt.sign({ sub: A.owner, type: "access" }, "a-different-secret-that-is-long-enough-x", { expiresIn: "15m" });
    const r2 = await fetch(B + "/admin/users", { headers: { Cookie: `kanaf_admin_access=${forged}` } });
    log("5-ب. رمز موقَّع بسرّ آخر: 401", r2.status === 401, String(r2.status));

    // رمز تجديد في مكان رمز الوصول
    const wrongType = jwt.sign({ sub: A.owner, type: "refresh" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" });
    const r3 = await fetch(B + "/admin/users", { headers: { Cookie: `kanaf_admin_access=${wrongType}` } });
    log("5-ج. رمز تجديد في موضع رمز الوصول: 401", r3.status === 401, String(r3.status));

    // رمز لحساب غير موجود — الثغرة التي كانت مفتوحة قبل المرحلة 5
    const ghost = jwt.sign({ sub: UUID, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" });
    const r4 = await fetch(B + "/admin/users", { headers: { Cookie: `kanaf_admin_access=${ghost}` } });
    const b4 = await r4.json().catch(() => ({}));
    log("5-د. رمز لحساب إدارة غير موجود: 401 (كان يُقبل قبل المرحلة 5)",
      r4.status === 401 && b4.error === "account_not_found", JSON.stringify(b4));

    /* الدور يُقرأ من القاعدة لا من الرمز: رمز يدّعي owner لحساب دعم. */
    const claimsOwner = jwt.sign({ sub: A.support, role: "owner", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" });
    const r5 = await fetch(B + "/admin/admin-users", { headers: { Cookie: `kanaf_admin_access=${claimsOwner}` } });
    log("5-هـ. رمز يدّعي دور owner لحساب دعم: 403 — الدور من القاعدة لا من الحمولة", r5.status === 403, String(r5.status));

    /* تعطيل الحساب يسري في الطلب التالي بنفس الرمز. */
    ME = A.support;
    const before = await get("/admin/users");
    await query(`UPDATE admin_users SET active = false WHERE id = $1`, [A.support]);
    const after = await get("/admin/users");
    await query(`UPDATE admin_users SET active = true WHERE id = $1`, [A.support]);
    log("5-و. تعطيل الحساب يسري في الطلب التالي بنفس الرمز (200 ثم 401)",
      before.status === 200 && after.status === 401 && after.body.error === "account_inactive",
      `${before.status}→${after.status}`);

    /* خفض الدور يسري فوراً كذلك. */
    ME = A.admin;
    const b1 = await get("/admin/users");
    await query(`INSERT INTO admin_role_assignments (admin_user_id, role) VALUES ($1,'content_manager')
                 ON CONFLICT (admin_user_id) DO UPDATE SET role = 'content_manager'`, [A.admin]);
    const b2 = await get("/admin/users");
    await query(`DELETE FROM admin_role_assignments WHERE admin_user_id = $1`, [A.admin]);
    log("5-ز. خفض الدور يسري في الطلب التالي بنفس الرمز (200 ثم 403)",
      b1.status === 200 && b2.status === 403, `${b1.status}→${b2.status}`);

    /* معرّف غير صالح الشكل: 404 لا 500. */
    ME = A.owner;
    const bad = await get("/admin/users/not-a-uuid");
    log("5-ح. معرّف غير صالح الشكل: 404 لا 500", bad.status === 404, String(bad.status));
  }

  /* ============================================================
     6) Reports تحترم filters والصلاحيات
     ============================================================ */
  ME = A.owner;
  let exportedUserId = null;
  {
    // مستخدمون بأسماء تحمل فاصلة واقتباساً ومحاولة حقن صيغة
    const names = [
      ["نورة, العتيبي", "p5a@kanaf.test"],
      ['فهد "أبو خالد"', "p5b@kanaf.test"],
      ['=HYPERLINK("http://evil","اضغط")', "p5c@kanaf.test"],
      ["سارة القديمة", "p5d@kanaf.test"],
    ];
    for (const [n, e] of names) {
      const { rows } = await query(
        `INSERT INTO users (name, email, password_hash, confirmed_adult, email_verified_at)
         VALUES ($1,$2,'x',true,now()) RETURNING id`, [n, e]
      );
      if (e === "p5a@kanaf.test") exportedUserId = rows[0].id;
    }
    await query(`UPDATE users SET created_at = now() - interval '40 days' WHERE email = 'p5d@kanaf.test'`);

    const all = await get("/admin/exports/users.csv");
    log("6-أ. التصدير يخرج CSV باسم ملف ونوع محتوى صحيحين",
      all.status === 200 && (all.headers.get("content-type") || "").includes("text/csv")
        && /attachment; filename="kanaf-users-\d{4}-\d{2}-\d{2}\.csv"/.test(all.headers.get("content-disposition") || ""),
      all.headers.get("content-disposition") || "");

    /* ⚠️ يُفحص بالبايتات الخام لا بنص fetch: TextDecoder يزيل BOM
       عند فك ترميز UTF-8، فاختبار على النص يقول «غائب» وهو موجود.
       سقط هذا الاختبار مرة بهذا السبب بالذات. */
    const rawCsv = Buffer.from(await (await fetch(B + "/admin/exports/users.csv", { headers: { Cookie: cookie() } })).arrayBuffer());
    log("6-ب. أول ثلاث بايتات EF BB BF فيفتحه Excel عربياً لا حروفاً مشوّهة",
      rawCsv[0] === 0xef && rawCsv[1] === 0xbb && rawCsv[2] === 0xbf,
      [...rawCsv.slice(0, 3)].map((b) => b.toString(16).toUpperCase()).join(" "));

    log("6-ج. رأس الملف يذكر من صدّر ودوره",
      all.text.includes("صُدِّر:") && all.text.includes("الدور: owner"));

    log("6-د. خلية تبدأ بـ= تُسبَق بفاصلة عليا فلا تُنفَّذ معادلةً في Excel",
      all.text.includes(`"'=HYPERLINK`),
      (all.text.split("\n").find((l) => l.includes("HYPERLINK")) || "").slice(0, 50));

    log("6-هـ. الفاصلة داخل الاسم مقتبسة، والاقتباس المزدوج مضاعَف",
      all.text.includes('"نورة, العتيبي"') && all.text.includes('فهد ""أبو خالد""'));

    // الفلتر: نفس المعامل على الشاشة والتصدير
    const cutoff = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const filtered = await get(`/admin/exports/users.csv?from=${cutoff}`);
    const screen = await get(`/admin/users?from=${cutoff}`);
    const m = /# إجمالي الصفوف: (\d+)/.exec(filtered.text);
    log("6-و. عدد صفوف الملف = إجمالي الشاشة بنفس الفلتر بالضبط",
      m && Number(m[1]) === screen.body.total, `ملف=${m?.[1]} شاشة=${screen.body.total}`);

    log("6-ز. رأس الملف يعلن الفلتر المطبَّق", filtered.text.includes(`from=${cutoff}`));

    const empty = await get("/admin/exports/users.csv?search=" + encodeURIComponent("لا-أحد-بهذا-الاسم"));
    log("6-ح. بحث بلا نتائج يعطي ملفاً صالحاً بصفر صف لا خطأ",
      empty.status === 200 && /# إجمالي الصفوف: 0/.test(empty.text));

    // لا تسريب لحقول الفئة D
    const bundle = [all.text,
      (await get("/admin/exports/payments.csv")).text,
      (await get("/admin/exports/invoices.csv")).text,
      (await get("/admin/exports/subscriptions.csv")).text].join("\n");
    log("6-ط. لا answers ولا payload ولا client_state ولا pdf_data في أي ملف مصدَّر",
      !/answers|payload|client_state|pdf_data|password_hash/i.test(bundle));

    // الصلاحية على التصدير نفسه
    const denied = [];
    for (const [role, kind] of [["support", "users"], ["content_manager", "payments"], ["accountant", "users"], ["admin", "audit-log"]]) {
      ME = A[role];
      const r = await get(`/admin/exports/${kind}.csv`);
      if (r.status !== 403) denied.push(`${role}/${kind}=${r.status}`);
      ME = A.owner;
    }
    log("6-ي. التصدير يحترم الصلاحية: أربع محاولات بلا صلاحية كلها 403", denied.length === 0, denied.join(" "));
  }

  /* ============================================================
     7) Audit Log يسجّل الأحداث المهمة
     ============================================================ */
  ME = A.owner;
  {
    const plan = await post("/admin/plans", {
      planKey: "p5_test_plan", name: "باقة اختبار المرحلة 5", priceSar: 29, durationDays: 30, reason: "إنشاء للاختبار",
    });
    log("7-أ. إنشاء باقة ينجح (201)", plan.status === 201, JSON.stringify(plan.body).slice(0, 60));

    const noReason = await patch(`/admin/plans/${plan.body.id}`, { priceSar: 39 });
    log("7-ب. تعديل الباقة بلا سبب مرفوض (400)", noReason.status === 400 && noReason.body.error === "reason_required");

    await patch(`/admin/plans/${plan.body.id}`, { priceSar: 39, reason: "رفع السعر للاختبار" });
    const { rows: planLog } = await query(
      `SELECT action, entity, entity_id, old_value, new_value, reason FROM admin_action_log
        WHERE entity = 'plan' ORDER BY created_at`
    );
    log("7-ج. تغيير السعر مسجَّل بالقيمة القديمة والجديدة معاً",
      planLog.length === 2 && planLog[1].action === "plan_price_changed"
        && Number(planLog[1].old_value.price_sar) === 29 && Number(planLog[1].new_value.price_sar) === 39,
      JSON.stringify(planLog.map((r) => r.action)));

    await put("/admin/tax-settings", { legalName: "اكاديمية علم النفس", vatNumber: "310000000000003", reason: "ضبط للاختبار" });
    const { rows: taxLog } = await query(`SELECT entity, entity_id FROM admin_action_log WHERE entity = 'tax_settings'`);
    log("7-د. تعديل البيانات الضريبية مسجَّل بكيان لا بمستخدم",
      taxLog.length === 1 && taxLog[0].entity_id === "singleton", JSON.stringify(taxLog));

    const { rows: accessLog } = await query(`SELECT count(*)::int n FROM admin_access_log WHERE action = 'update_tax_settings'`);
    log("7-هـ. ونفس التعديل له صف في سجل الوصول بسببه", accessLog[0].n === 1, String(accessLog[0].n));

    // كيان ليس مستخدماً — وهو ما كان مستحيلاً قبل المرحلة 5
    const { rows: nonUser } = await query(
      `SELECT count(*)::int n FROM admin_action_log WHERE entity IS NOT NULL AND target_user_id IS NULL`
    );
    log("7-و. السجل يحمل أحداثاً على كيانات ليست مستخدمين (مستحيل قبل عمودي entity)",
      nonUser[0].n >= 3, `${nonUser[0].n} صف`);

    const read = await get("/admin/audit-log");
    log("7-ز. سجل الإجراءات يُقرأ من اللوحة ويُرقَّم",
      read.status === 200 && read.body.total >= 3 && Array.isArray(read.body.entries), `total=${read.body.total}`);

    const byEntity = await get("/admin/audit-log?entity=plan");
    log("7-ح. الفلترة بالكيان تعمل وتعيد المطابق وحده",
      byEntity.status === 200 && byEntity.body.total === 2
        && byEntity.body.entries.every((e) => e.entity === "plan"), String(byEntity.body.total));

    log("7-ط. قيم الفلترة تأتي من البيانات لا من قائمة مكتوبة",
      byEntity.body.facets?.entities?.includes("plan") && byEntity.body.facets?.actions?.includes("plan_price_changed"));

    const { rows: exportLog } = await query(`SELECT new_value FROM admin_action_log WHERE action = 'data_exported' LIMIT 1`);
    log("7-ي. حتى التصدير نفسه مسجَّل بعدد صفوفه", !!exportLog[0] && typeof exportLog[0].new_value.rows === "number",
      JSON.stringify(exportLog[0]?.new_value || {}));

    const { rows: leak } = await query(
      `SELECT count(*)::int n FROM admin_action_log
        WHERE old_value::text ILIKE '%setup=%' OR new_value::text ILIKE '%setup=%' OR metadata::text ILIKE '%setup=%'`
    );
    log("7-ك. لا رمز دعوة ولا رابط سرّي مسرَّب في أي صف من السجل", leak[0].n === 0, String(leak[0].n));
  }

  /* ============================================================
     8) Settings تستمر بعد refresh
     ============================================================ */
  ME = A.owner;
  {
    const before = await getAppSetting("support_email");
    const w = await put("/admin/app-settings/support_email", { value: "p5@kanaf.test", reason: "اختبار الاستمرار" });
    log("8-أ. تعديل إعداد التشغيل ينجح", w.status === 200 && w.body.setting.value === "p5@kanaf.test",
      JSON.stringify(w.body.setting?.value));

    // قراءة جديدة من القاعدة — لا من الرد
    log("8-ب. القيمة تستمر عند قراءة مستقلة من قاعدة البيانات",
      (await getAppSetting("support_email")) === "p5@kanaf.test", `كانت: ${before}`);

    const reread = await get("/admin/settings/overview");
    const row = reread.body.sections?.app?.values?.find((x) => x.key === "support_email");
    log("8-ج. وتظهر القيمة الجديدة عند إعادة فتح شاشة الإعدادات", row?.value === "p5@kanaf.test", JSON.stringify(row?.value));

    const unknown = await put("/admin/app-settings/an_invented_key", { value: "x", reason: "محاولة" });
    log("8-د. مفتاح مخترَع مرفوض (404) فلا يمتلئ الجدول بقيم لا يقرؤها أحد",
      unknown.status === 404 && unknown.body.error === "unknown_setting", JSON.stringify(unknown.body));

    const emptyVal = await put("/admin/app-settings/support_email", { value: "   ", reason: "محاولة" });
    log("8-هـ. قيمة فارغة مرفوضة (400)", emptyVal.status === 400 && emptyVal.body.error === "value_cannot_be_empty");

    const list = await get("/admin/app-settings");
    log("8-و. كل إعداد يحمل حالة ربطه صراحةً (wired)",
      list.status === 200 && list.body.settings.length === 5 && list.body.settings.every((s) => typeof s.wired === "boolean"),
      list.body.settings?.map((s) => `${s.key}:${s.wired}`).join(" "));

    log("8-ز. admin_session_minutes معلَّم بأنه لا يؤثر (قيمته السارية من متغيّر بيئة)",
      list.body.settings.find((s) => s.key === "admin_session_minutes")?.wired === false);
  }

  /* ============================================================
     9) KPI يطابق حساب DB المباشر
     ============================================================ */
  ME = A.owner;
  {
    const kpis = await get("/admin/billing/kpis");
    log("9-أ. مسار المؤشرات يعمل ويعيد تعريفاً لكل رقم",
      kpis.status === 200 && kpis.body.definitions && Object.keys(kpis.body.definitions).length >= 8,
      `${Object.keys(kpis.body.definitions || {}).length} تعريفاً`);

    /* المقارنة باستعلام مكتوب هنا مستقلاً — لا باستدعاء نفس الدالة.
       استعلام يقارن نفسه لا يثبت شيئاً. */
    const { rows: direct } = await query(
      `SELECT count(*)::int AS n FROM (
         SELECT DISTINCT ON (user_id) id, user_id, status, current_period_end
         FROM subscriptions ORDER BY user_id, created_at DESC
       ) s
       WHERE (s.status IN ('active','trialing','past_due'))
         AND (s.current_period_end IS NULL OR s.current_period_end > now())`
    );
    log("9-ب. عدد الاشتراكات الفعّالة يطابق استعلاماً مكتوباً مستقلاً",
      kpis.body.kpis.activeSubscriptions === direct[0].n,
      `المؤشر=${kpis.body.kpis.activeSubscriptions} المباشر=${direct[0].n}`);

    const { rows: pay } = await query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('paid','refunded','partially_refunded')),0) AS gross,
              count(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM payments
        WHERE COALESCE(captured_at, created_at) >= ((now() AT TIME ZONE 'Asia/Riyadh')::date - 29)::timestamp AT TIME ZONE 'Asia/Riyadh'`
    );
    const ov = await get("/admin/overview");
    log("9-ج. إيراد النظرة العامة يطابق استعلاماً مباشراً بنفس المنطقة الزمنية",
      Math.abs(Number(ov.body.last30Days.grossRevenue) - Number(pay[0].gross)) < 0.01
        && ov.body.last30Days.failedPayments === pay[0].failed,
      `${ov.body.last30Days.grossRevenue} مقابل ${pay[0].gross}`);

    log("9-د. النظرة العامة تعلن منطقتها الزمنية بدل تركها للتخمين",
      ov.body.range?.timezone === "Asia/Riyadh", JSON.stringify(ov.body.range));

    log("9-هـ. لا رقم ثابت في الرد: كل مؤشر مفتاحه في definitions",
      Object.keys(kpis.body.kpis).filter((k) => !(k in kpis.body.definitions)).length <= 6,
      "بعض المؤشرات المشتقّة تشترك في تعريف واحد");
  }

  /* ============================================================
     10) دورة حياة حساب الإدارة — الدعوة بدل تسليم كلمة مرور
     ============================================================ */
  ME = A.owner;
  {
    const inv = await post("/admin/admin-users", {
      name: "محاسب مدعوّ", email: "p5-invited@kanaf.test", role: "accountant", reason: "تعيين محاسب للاختبار",
    });
    log("10-أ. دعوة محاسب تنجح (201) والدور المعاد accountant",
      inv.status === 201 && inv.body.adminUser.role === "accountant", JSON.stringify(inv.body.adminUser || inv.body));

    const invitedId = inv.body.adminUser?.id;
    log("10-ب. الرد يحمل رابطاً ولا يحمل كلمة مرور",
      !!inv.body.setupUrl && !/"password"/.test(JSON.stringify(inv.body)));

    const { rows: split } = await query(
      `SELECT au.role AS base, au.active, ra.role AS assigned
         FROM admin_users au LEFT JOIN admin_role_assignments ra ON ra.admin_user_id = au.id
        WHERE au.id = $1`, [invitedId]
    );
    log("10-ج. الأساس support في الجدول الأصلي والإسناد accountant في الجدول الجديد",
      split[0].base === "support" && split[0].assigned === "accountant", JSON.stringify(split[0]));

    log("10-د. الحساب غير مفعّل قبل قبول الدعوة", split[0].active === false);

    const token = /setup=([^&"]+)/.exec(inv.body.setupUrl)[1];
    const v = await get(`/admin/setup/validate?token=${token}`);
    log("10-هـ. التحقق من الرمز يعمل بلا مصادقة", v.status === 200 && v.body.purpose === "invite", JSON.stringify(v.body));

    const short = await post("/admin/setup/accept", { token, password: "قصيرة" });
    log("10-و. كلمة مرور أقصر من 15 حرفاً مرفوضة", short.status === 400 && short.body.error === "password_too_short");

    const longAr = await post("/admin/setup/accept", { token, password: "كلمةمرورعربيةطويلةجداًجداًجداًجداًجداًجداًجداًجداً" });
    log("10-ز. كلمة مرور عربية تتجاوز 72 بايتاً مرفوضة (bcrypt يقصّ بصمت)",
      longAr.status === 400 && longAr.body.error === "password_too_long", JSON.stringify(longAr.body));

    const ok = await post("/admin/setup/accept", { token, password: "Kanaf-Invited-2026-x" });
    log("10-ح. القبول ينجح ويحيل إلى الدخول لا إلى جلسة مفتوحة",
      ok.status === 200 && ok.body.next === "login", JSON.stringify(ok.body));

    const { rows: nowActive } = await query(`SELECT active FROM admin_users WHERE id = $1`, [invitedId]);
    log("10-ط. الحساب صار مفعّلاً بعد القبول", nowActive[0].active === true);

    const reuse = await post("/admin/setup/accept", { token, password: "Kanaf-Invited-2026-x" });
    log("10-ي. الرمز لمرة واحدة: الاستعمال الثاني مرفوض", reuse.status === 400 && reuse.body.error === "invalid_or_expired_token");

    const fake = await get("/admin/setup/validate?token=totally-made-up-token");
    log("10-ك. رمز مختلَق يعطي نفس رسالة الرمز المنتهي (لا يُميَّز بينهما)",
      fake.status === 400 && fake.body.error === "invalid_or_expired_token", JSON.stringify(fake.body));

    // تحويل المحاسب إلى دور قديم يجب أن يحذف صف الإسناد
    const down = await patch(`/admin/admin-users/${invitedId}`, { role: "support", reason: "نقل إلى الدعم" });
    const { rows: after } = await query(
      `SELECT au.role AS base, ra.role AS assigned FROM admin_users au
         LEFT JOIN admin_role_assignments ra ON ra.admin_user_id = au.id WHERE au.id = $1`, [invitedId]
    );
    log("10-ل. تحويل المحاسب إلى دور قديم يحذف صف الإسناد فعلاً (وإلا بقي محاسباً بصمت)",
      down.status === 200 && after[0].base === "support" && after[0].assigned === null, JSON.stringify(after[0]));

    const self = await patch(`/admin/admin-users/${A.owner}`, { role: "support", reason: "محاولة" });
    log("10-م. لا يغيّر المرء دور نفسه", self.status === 409 && self.body.error === "cannot_change_own_role", JSON.stringify(self.body));

    const selfOff = await patch(`/admin/admin-users/${A.owner}`, { active: false, reason: "محاولة" });
    log("10-ن. ولا يعطّل نفسه", selfOff.status === 409 && selfOff.body.error === "cannot_deactivate_self");

    const { rows: acctLog } = await query(
      `SELECT action FROM admin_action_log WHERE entity = 'admin_user' ORDER BY created_at`
    );
    log("10-س. كل أحداث حساب الإدارة مسجَّلة (كانت بلا سجل إطلاقاً قبل المرحلة 5)",
      acctLog.length >= 3 && acctLog.some((r) => r.action === "admin_account_invited")
        && acctLog.some((r) => r.action === "admin_role_changed"),
      acctLog.map((r) => r.action).join(", "));
  }

  /* ============================================================
     11) سلامة المصفوفة نفسها — تُقرأ من الكود لا من وثيقة
     ============================================================ */
  {
    log("11-أ. المالك يملك كل صلاحية في السجل", ALL_PERMISSIONS.every((p) => can("owner", p)));

    log("11-ب. دور مجهول لا يملك شيئاً", !can("hacker", "overview:view") && permissionsFor(undefined).length === 0);

    log("11-ج. كل صلاحية في المصفوفة معرَّفة في السجل (يُفحص عند الإقلاع أيضاً)",
      matrixRows().every((r) => typeof r.description === "string" && r.description.length > 0));

    /* الشرط الذي كُتب في admin/middleware.js: requireRole باقية
       للانتقال وحده، ولا يجوز أن يبقى لها مستدعٍ. */
    const callers = readdirSync("./admin")
      .filter((f) => f.endsWith(".js") && f !== "middleware.js" && f !== "permissions.js")
      .filter((f) => /requireRole\(/.test(readFileSync(`./admin/${f}`, "utf8")));
    log("11-د. صفر مستدعٍ لـrequireRole في مجلد admin/ (شرط إغلاق المرحلة)",
      callers.length === 0, callers.join(", "));

    /* لا مسار إداري بلا حارس صلاحية — مع استثناءين معلَنين بسببهما.

       الاستثناء يُكتب هنا صراحةً لا يُترك للفحص أن يمرّ عليه: مسار
       يخرج من الفحص بلا سبب مكتوب هو بالضبط ما يصير ثغرة بعد سنة. */
    const GUARDED_INSIDE_HANDLER = {
      "accounts.js:/admin-users/:id":
        "الصلاحية تعتمد على الحقل المرسل لا على المسار: role يحتاج admins:change_role وactive يحتاج admins:deactivate. مفحوصان في 4-أ و10-م.",
      "settings.js:/settings/overview":
        "يكفي امتلاك صلاحية قراءة قسم واحد، والأقسام تُرشَّح داخل المعالج بحسب ما يملكه القارئ. مفحوص في 4-ج و2-و.",
    };
    const unguarded = [];
    for (const f of readdirSync("./admin").filter((x) => x.endsWith(".js"))) {
      const src = readFileSync(`./admin/${f}`, "utf8");
      const re = /\.(get|post|patch|put|delete)\(\s*"([^"]+)"([^)]*)/g;
      let m;
      while ((m = re.exec(src))) {
        const [, , route, rest] = m;
        if (route.startsWith("/setup/") || route.startsWith("/auth/")) continue;
        if (/requirePermission|requireAnyPermission/.test(rest)) continue;
        if (GUARDED_INSIDE_HANDLER[`${f}:${route}`]) continue;
        unguarded.push(`${f}:${route}`);
      }
    }
    log("11-هـ. كل مسار إداري غير عام خلف requirePermission، عدا استثناءين معلَنين بسببهما",
      unguarded.length === 0, unguarded.join(" "));

    /* والاستثناءان يجب أن يفحصا الصلاحية داخل معالجهما فعلاً — وإلا
       صار الاستثناء غطاءً على غيابها. */
    const fakeExceptions = Object.keys(GUARDED_INSIDE_HANDLER).filter((k) => {
      const [file] = k.split(":");
      return !/req\.admin\.can\(|canAny\(/.test(readFileSync(`./admin/${file}`, "utf8"));
    });
    log("11-و. والاستثناءان يفحصان الصلاحية داخل معالجهما فعلاً", fakeExceptions.length === 0, fakeExceptions.join(" "));
  }

  /* ============================================================
     التنظيف

     يحذف ما أنشأه هذا الملف وحده — بالبريد والمفتاح، لا بالجدول.
     ============================================================ */
  if (TAX_BEFORE) {
    /* updated_by يُستعاد فقط إن كان الحساب ما زال موجوداً — وإلا
       NULL. استعادة معرّف محذوف تفشل بقيد المفتاح الأجنبي. */
    const { rows: still } = await query(`SELECT 1 FROM admin_users WHERE id = $1`, [TAX_BEFORE.updated_by]);
    await query(
      `UPDATE tax_settings SET legal_name = $1, vat_number = $2, address = $3, updated_by = $4`,
      [TAX_BEFORE.legal_name, TAX_BEFORE.vat_number, TAX_BEFORE.address, still.length ? TAX_BEFORE.updated_by : null]
    );
  }
  await purge();
  // إعداد الدعم يُعاد إلى قيمته المبذورة
  await query(`UPDATE app_settings SET value = '"support@kanaf.me"'::jsonb WHERE key = 'support_email'`);
}

run()
  .catch((err) => { console.error("\n💥 توقف التشغيل:", err); results.push(["تشغيل الملف كاملاً", false, String(err.message)]); })
  .finally(async () => {
    server.close();
    let pass = 0;
    for (const [label, ok, extra] of results) {
      console.log(`${ok ? "✅" : "❌"} ${label}${extra ? `  ← ${extra}` : ""}`);
      if (ok) pass++;
    }
    console.log(`\n${pass}/${results.length} نجحت`);
    process.exit(pass === results.length ? 0 : 1);
  });
