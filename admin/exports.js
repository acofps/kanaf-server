import express from "express";
import { query } from "../db/pool.js";
import {
  requireAdminAuth, requirePermission, logAdminAction, fail,
} from "./middleware.js";
import {
  buildSubscriptionFilter, buildPaymentFilter, buildInvoiceFilter, buildRefundFilter,
} from "./filters.js";
import { buildUserListFilter, buildAuditFilter } from "./routes.js";
import { entitledSql } from "../billing/subscription.js";
import { getBillingSettings } from "../billing/config.js";

export const adminExportsRouter = express.Router();

/* ============================================================
   التصدير — البند 8 من المرحلة 5

   ------------------------------------------------------------
   الحالة قبل هذا الملف
   ------------------------------------------------------------
   البند يقول «راجع CSV/Excel/PDF إن كانت موجودة». الجواب الصادق:
   **لم تكن موجودة إطلاقاً**. لا مسار تصدير واحد في المستودع كله،
   ولا زر في اللوحة. الشيء الوحيد الذي يخرج من النظام كملف هو
   الفاتورة الضريبية، وهي وثيقة لا تقرير.

   ولذلك كان اختبار القبول «Reports تحترم filters والصلاحيات» غير
   قابل للتنفيذ: لا شيء يُفحص.

   ------------------------------------------------------------
   1) الفلاتر — نفس الشرط لا نسخة منه
   ------------------------------------------------------------
   كل مسار هنا ينادي **نفس** بنّاء الشرط الذي تناديه الشاشة
   (admin/filters.js). لا يوجد شرط ثانٍ يمكن أن ينحرف.

   وهذا ليس حرصاً زائداً: الانحراف هنا صامت تماماً. المسؤول يفلتر
   على شهر ويصدّر، فيخرج ملف بكل التاريخ — ولا شيء في الملف يقول
   ذلك، فيُبنى عليه قرار مالي.

   ولذلك أيضاً يحمل كل ملف **سطر تعريف في رأسه** يذكر الفلاتر
   المطبَّقة والنطاق والمنطقة الزمنية ووقت التصدير ومن صدّره. ملف
   بلا سياق يصير بعد أسبوع رقماً بلا مصدر.

   ------------------------------------------------------------
   2) الحجم — دفعات لا تجميعة واحدة
   ------------------------------------------------------------
   الشكل السهل `const { rows } = await query(...)` يحمّل النتيجة
   كلها في ذاكرة العملية قبل أن يُكتب حرف واحد. وحاوية Render خطة
   Starter فيها 512 ميغابايت، ويقاسمها Chromium الذي يطبع الفواتير.
   تصدير مئة ألف صف بهذه الطريقة لا يُبطئ الخادم — يقتله، ومعه كل
   طلب آخر جارٍ.

   الحل هنا القراءة على دفعات ثابتة الحجم والكتابة أولاً بأول،
   فاستهلاك الذاكرة محدود بحجم الدفعة مهما كبر الجدول.

   ولم تُستعمل pg-query-stream رغم أنها الأداة المخصصة لهذا: قاعدة
   المشروع صريحة في ألا تُضاف طبقة جديدة إلا لحاجة **لا يمكن
   تنفيذها بأمان بالبنية الحالية**، وهذه يمكن. اعتمادية أقل تعني
   نشراً أقل عرضة للكسر — والمشروع دفع ثمن أمر بناء يُعاد تعيينه
   فيسقط النشر الثاني بعد نجاح الأول.

   ⚠️ ثمن الاختيار، مكتوباً لا مسكوتاً عنه: الدفعات تُقرأ بـOFFSET،
   فلو تغيّرت البيانات أثناء تصدير طويل قد يتكرّر صف أو يُفلت. لذلك
   يحمل رأس الملف لحظة التصدير، ويحمل ذيله عدد الصفوف الفعلي. وعلى
   أحجام هذا المشروع — آلاف الصفوف لا ملايين — الفارق نظري.

   وأثر ثانٍ: الرؤوس تُرسَل قبل أن تُقرأ آخر دفعة، فخطأ في المنتصف
   لا يمكن تحويله إلى 500. يُكتب سطر خطأ صريح **داخل الملف نفسه**
   ثم يُقطع — فمن يفتحه يرى أنه ناقص بدل أن يظنه كاملاً.

   ------------------------------------------------------------
   3) ما لا يُصدَّر
   ------------------------------------------------------------
   لا عمود من أعمدة الفئة D يظهر في أي ملف هنا: لا daily_logs.note
   ولا screenings.answers ولا user_notebook_entries.answers ولا
   user_cbt_sessions.payload ولا client_state.

   ولا يوجد تصدير للبيانات النفسية أصلاً — لا بصلاحية ولا بدونها.
   الملف يغادر حراسة الخادم إلى قرص شخص، فما لا يجوز عرضه على شاشة
   لا يجوز أن يصير ملفاً بالأولى.

   وتصدير سجل التدقيق محصور بالمالك للسبب نفسه: هو سجل من فعل ماذا،
   وإخراجه من النظام يخرجه من حراسته.
   ============================================================ */

/* ------------------------------------------------------------
   تهيئة خلية CSV.

   ⚠️ البادئات الأربع ليست تجميلاً: خلية تبدأ بـ= أو + أو - أو @
   تُفسَّر **معادلة** في Excel و Google Sheets. واسم مستخدم مثل
   `=HYPERLINK(...)` أو `=cmd|...` يتحول إلى تنفيذ عند فتح الملف.
   وهي ثغرة حقيقية اسمها CSV Injection، ومدخلها هنا اسم يكتبه
   المستخدم بنفسه ويصل الملف بلا مرور على أي منقّي.

   الحل المعتمد: تسبيق الخلية بفاصلة عليا داخل الاقتباس، فتُقرأ
   نصاً ويظل الأصل مقروءاً للإنسان.
   ------------------------------------------------------------ */
function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") value = JSON.stringify(value);

  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const csvRow = (values) => values.map(csvCell).join(",") + "\r\n";

/* ------------------------------------------------------------
   ⚠️ BOM في أول الملف — سطر واحد يمنع عطباً يظهر عند المالك وحده.

   Excel على ويندوز يفتح CSV بترميز النظام المحلي لا UTF-8 ما لم
   يجد BOM، فتخرج كل الأسماء العربية حروفاً مشوّهة. الملف سليم
   والقارئ هو من يخطئ قراءته — وهذا أسوأ أنواع الأعطال: صحيح عند من
   بناه، مكسور عند من يستعمله. والمالك على ويندوز.

   ويُكتب بترميزه الصريح \uFEFF لا بمحرفه نفسه: محرف غير مرئي في
   ملف مصدر يبتلعه أي محرر أو أداة رفع تُطبّع الترميز، فيختفي بلا
   أن يظهر في أي فرق نصّي — والعطب الناتج يظهر عند من يفتح الملف
   وحده. والملف يُرفع يدوياً في هذا المشروع.
   ------------------------------------------------------------ */
const BOM = "\uFEFF";

function startCsv(res, filename) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // لا تخزين مؤقت: التقرير لقطة لحظة، ونسخة قديمة منه أسوأ من لا شيء.
  res.setHeader("Cache-Control", "no-store");
  res.write(BOM);
}

/** سطر التعريف — من صدّر، ومتى، وبأي فلاتر، وبأي منطقة زمنية. */
function writeMeta(res, { title, admin, filters, timezone, extra = {} }) {
  const parts = Object.entries({ ...filters, ...extra })
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== "all")
    .map(([k, v]) => `${k}=${v}`);
  res.write(csvRow([
    `# ${title}`,
    `صُدِّر: ${new Date().toISOString()}`,
    `بواسطة: ${admin.email}`,
    `الدور: ${admin.role}`,
    `المنطقة الزمنية: ${timezone}`,
    parts.length ? `الفلاتر: ${parts.join(" · ")}` : "الفلاتر: لا شيء (كل السجلات)",
  ]));
}

const BATCH = 500;

/**
 * يكتب نتيجة استعلام على دفعات.
 *
 * `map` يحوّل صف قاعدة البيانات إلى مصفوفة خلايا — فالأعمدة
 * المصدَّرة تُختار صراحة هنا، ولا يمكن لعمود جديد في الجدول أن يجد
 * طريقه إلى ملف بلا قرار. وهذا مقصود بعد درس daily_logs.note.
 */
async function streamRows(res, { sql, params, headers, map, where }) {
  res.write(csvRow(headers));

  let count = 0;
  try {
    for (let offset = 0; ; offset += BATCH) {
      const { rows } = await query(
        `${sql} LIMIT ${BATCH} OFFSET ${offset}`,
        params
      );
      if (rows.length === 0) break;

      /* تُجمَّع الدفعة في نص واحد ثم تُكتب مرة واحدة: خمسمئة نداء
         write منفصل لكل دفعة يُثقل حلقة الأحداث بلا داعٍ. */
      let chunk = "";
      for (const row of rows) chunk += csvRow(map(row));
      res.write(chunk);
      count += rows.length;

      if (rows.length < BATCH) break;

      /* مهلة صفرية بين الدفعات: تصدير كبير لا يجوز أن يحتكر حلقة
         الأحداث فيتوقف كل طلب آخر — بما فيها مسار الأمان. */
      await new Promise((r) => setImmediate(r));
    }

    res.write(csvRow([`# إجمالي الصفوف: ${count}`]));
    res.end();
    return count;
  } catch (err) {
    /* الرؤوس أُرسلت بالفعل، فلا يمكن الرد بـ500. الصادق هنا أن
       يُكتب سطر خطأ داخل الملف ثم يُقطع: من يفتحه يرى أنه ناقص بدل
       أن يظنه كاملاً. */
    console.error(`[admin/exports] ${where} انقطع بعد ${count} صف:`, err.message);
    try {
      res.write(csvRow([`# ⚠️ انقطع التصدير بعد ${count} صف — الملف ناقص. راجع سجل الخادم.`]));
    } catch { /* الاتصال أُغلق أصلاً */ }
    res.end();
    return count;
  }
}

/** كل تصدير حدث يستحق التسجيل: بيانات غادرت النظام. */
async function logExport(req, { kind, filters, rows }) {
  await logAdminAction({
    adminUserId: req.admin.id,
    action: "data_exported",
    entity: "export", entityId: kind,
    newValue: { kind, rows, filters },
    reason: `تصدير ${kind}`,
    ipAddress: req.ip,
  }).catch((err) => console.error("[admin/exports] تعذّر تسجيل التصدير:", err.message));
}

const stamp = () => new Date().toISOString().slice(0, 10);

/* ============================================================
   المدفوعات
   ============================================================ */
adminExportsRouter.get("/exports/payments.csv", requireAdminAuth, requirePermission("exports:billing"), async (req, res) => {
  try {
    const settings = await getBillingSettings();
    const { fromAndJoins, params, orderBy, filters } = buildPaymentFilter(req.query);

    startCsv(res, `kanaf-payments-${stamp()}.csv`);
    writeMeta(res, { title: "المدفوعات", admin: req.admin, filters, timezone: settings.reportingTimezone });

    const rows = await streamRows(res, {
      where: "payments",
      sql: `SELECT p.id, p.created_at, p.captured_at, u.name AS user_name, u.email AS user_email,
                   i.zatca_invoice_number, p.amount, p.currency, p.status, p.method,
                   p.card_brand, p.card_last4, p.provider, p.provider_payment_id,
                   p.refunded_amount, p.failure_reason
              ${fromAndJoins}
             ORDER BY ${orderBy.col} ${orderBy.dir} NULLS LAST, p.id DESC`,
      params,
      headers: ["معرّف الدفعة", "تاريخ الإنشاء", "تاريخ التحصيل", "الاسم", "البريد",
                "رقم الفاتورة", "المبلغ", "العملة", "الحالة", "الوسيلة",
                "نوع البطاقة", "آخر 4 أرقام", "المزوّد", "معرّف المعاملة",
                "المسترد", "سبب الفشل"],
      map: (r) => [r.id, r.created_at, r.captured_at, r.user_name, r.user_email,
                   r.zatca_invoice_number, r.amount, r.currency, r.status, r.method,
                   r.card_brand, r.card_last4, r.provider, r.provider_payment_id,
                   r.refunded_amount, r.failure_reason],
    });
    await logExport(req, { kind: "payments", filters, rows });
  } catch (err) {
    if (!res.headersSent) return fail(res, err, "admin/exports:payments", req);
    res.end();
  }
});

/* ============================================================
   الفواتير
   ============================================================ */
adminExportsRouter.get("/exports/invoices.csv", requireAdminAuth, requirePermission("exports:billing"), async (req, res) => {
  try {
    const settings = await getBillingSettings();
    const { fromAndJoins, params, orderBy, filters } = buildInvoiceFilter(req.query);

    startCsv(res, `kanaf-invoices-${stamp()}.csv`);
    writeMeta(res, { title: "الفواتير الضريبية", admin: req.admin, filters, timezone: settings.reportingTimezone });

    const rows = await streamRows(res, {
      where: "invoices",
      // pdf_data غير مُنتقى عمداً: عمود ثنائي بحجم ~95 كيلوبايت للصف
      // الواحد. اختياره هنا يحوّل تصدير ألف فاتورة إلى 95 ميغابايت
      // من البيانات المُرمَّزة داخل خلايا نصية.
      sql: `SELECT i.id, i.zatca_invoice_number, i.created_at, i.zatca_issued_at,
                   u.name AS user_name, u.email AS user_email,
                   i.plan_id, sp.name AS plan_name,
                   i.subtotal_sar, i.vat_sar, i.amount_sar, st.vat_rate,
                   COALESCE(st.currency, 'SAR') AS currency, i.status
              ${fromAndJoins}
             ORDER BY ${orderBy.col} ${orderBy.dir} NULLS LAST, i.id DESC`,
      params,
      headers: ["معرّف الفاتورة", "الرقم الضريبي", "تاريخ الإنشاء", "تاريخ الإصدار",
                "الاسم", "البريد", "مفتاح الباقة", "اسم الباقة",
                "قبل الضريبة", "الضريبة", "الإجمالي", "نسبة الضريبة", "العملة", "الحالة"],
      map: (r) => [r.id, r.zatca_invoice_number, r.created_at, r.zatca_issued_at,
                   r.user_name, r.user_email, r.plan_id, r.plan_name,
                   r.subtotal_sar, r.vat_sar, r.amount_sar, r.vat_rate, r.currency, r.status],
    });
    await logExport(req, { kind: "invoices", filters, rows });
  } catch (err) {
    if (!res.headersSent) return fail(res, err, "admin/exports:invoices", req);
    res.end();
  }
});

/* ============================================================
   الاشتراكات
   ============================================================ */
adminExportsRouter.get("/exports/subscriptions.csv", requireAdminAuth, requirePermission("exports:billing"), async (req, res) => {
  try {
    const settings = await getBillingSettings();
    const { fromAndJoins, params, statusExpr, orderBy, filters } = buildSubscriptionFilter(req.query);

    startCsv(res, `kanaf-subscriptions-${stamp()}.csv`);
    writeMeta(res, { title: "الاشتراكات", admin: req.admin, filters, timezone: settings.reportingTimezone });

    const rows = await streamRows(res, {
      where: "subscriptions",
      // الحالة المصدَّرة هي **الفعلية** لا المخزّنة، ومعها المخزّنة
      // بجانبها. تصدير status الخام كان سيقول «فعّال» عن اشتراك
      // انتهى قبل شهور — نفس العطب الذي أصلحته المرحلة 3 في العدّاد.
      sql: `SELECT s.id, s.user_id, u.name AS user_name, u.email AS user_email,
                   s.plan_id, sp.name AS plan_name,
                   ${statusExpr} AS effective_status, s.status AS stored_status,
                   ${entitledSql("s")} AS entitled,
                   s.started_at, ss.current_period_start, s.current_period_end,
                   s.canceled_at, ss.cancel_at_period_end,
                   ss.billing_cycle, ss.plan_price_sar,
                   COALESCE(ss.currency, 'SAR') AS currency, s.payment_provider
              ${fromAndJoins}
             ORDER BY ${orderBy.col} ${orderBy.dir} NULLS LAST, s.id DESC`,
      params,
      headers: ["معرّف الاشتراك", "معرّف المستخدم", "الاسم", "البريد",
                "مفتاح الباقة", "اسم الباقة", "الحالة الفعلية", "الحالة المخزّنة", "مستحق",
                "البداية", "بداية الفترة", "نهاية الفترة", "تاريخ الإلغاء", "إلغاء بنهاية المدة",
                "دورة الفوترة", "السعر", "العملة", "المزوّد"],
      map: (r) => [r.id, r.user_id, r.user_name, r.user_email,
                   r.plan_id, r.plan_name, r.effective_status, r.stored_status, r.entitled,
                   r.started_at, r.current_period_start, r.current_period_end,
                   r.canceled_at, r.cancel_at_period_end,
                   r.billing_cycle, r.plan_price_sar, r.currency, r.payment_provider],
    });
    await logExport(req, { kind: "subscriptions", filters, rows });
  } catch (err) {
    if (!res.headersSent) return fail(res, err, "admin/exports:subscriptions", req);
    res.end();
  }
});

/* ============================================================
   الاستردادات
   ============================================================ */
adminExportsRouter.get("/exports/refunds.csv", requireAdminAuth, requirePermission("exports:billing"), async (req, res) => {
  try {
    const settings = await getBillingSettings();
    const { fromAndJoins, params, orderBy, filters } = buildRefundFilter(req.query);

    startCsv(res, `kanaf-refunds-${stamp()}.csv`);
    writeMeta(res, { title: "الاستردادات", admin: req.admin, filters, timezone: settings.reportingTimezone });

    const rows = await streamRows(res, {
      where: "refunds",
      sql: `SELECT r.id, r.created_at, u.name AS user_name, u.email AS user_email,
                   r.payment_id, cn.zatca_credit_note_number,
                   r.amount, r.currency, r.kind, r.status, r.provider, r.provider_refund_id,
                   r.initiated_by, r.reason, r.error
              ${fromAndJoins}
             ORDER BY ${orderBy.col} ${orderBy.dir}, r.id DESC`,
      params,
      headers: ["معرّف الاسترداد", "التاريخ", "الاسم", "البريد", "معرّف الدفعة",
                "رقم الإشعار الدائن", "المبلغ", "العملة", "النوع", "الحالة",
                "المزوّد", "معرّف الاسترداد لدى المزوّد", "البادئ", "السبب", "الخطأ"],
      map: (r) => [r.id, r.created_at, r.user_name, r.user_email, r.payment_id,
                   r.zatca_credit_note_number, r.amount, r.currency, r.kind, r.status,
                   r.provider, r.provider_refund_id, r.initiated_by, r.reason, r.error],
    });
    await logExport(req, { kind: "refunds", filters, rows });
  } catch (err) {
    if (!res.headersSent) return fail(res, err, "admin/exports:refunds", req);
    res.end();
  }
});

/* ============================================================
   المستخدمون

   ⚠️ الأعمدة المصدَّرة هنا مطابقة تماماً لما تعرضه شاشة المستخدمين:
   اسم وبريد وتواريخ وحالة حساب واشتراك. ولا شيء غيرها.

   ولا يوجد — ولن يوجد — تصدير لليوميات ولا نتائج الفرز ولا محتوى
   الدفاتر. الشاشة نفسها لا تعرض نصوصها (المرحلة 5 أزالت آخر ما كان
   يعبر الشبكة منها)، والملف الذي يغادر إلى قرص شخص أبعد عن الحراسة
   من الشاشة، لا أقرب.
   ============================================================ */
adminExportsRouter.get("/exports/users.csv", requireAdminAuth, requirePermission("exports:users"), async (req, res) => {
  try {
    const settings = await getBillingSettings();
    const { fromAndJoins, params, filters, subscriptionStatusExpr } = buildUserListFilter(req.query);

    startCsv(res, `kanaf-users-${stamp()}.csv`);
    writeMeta(res, { title: "المستخدمون", admin: req.admin, filters, timezone: settings.reportingTimezone });

    const rows = await streamRows(res, {
      where: "users",
      sql: `SELECT u.id, u.name, u.email, u.created_at, u.email_verified_at,
                   s.last_login_at, s.suspended_at,
                   CASE
                     WHEN u.deleted_at IS NOT NULL     THEN 'deleted'
                     WHEN s.suspended_at IS NOT NULL   THEN 'suspended'
                     WHEN u.email_verified_at IS NULL  THEN 'pending_verification'
                     ELSE 'active'
                   END AS account_status,
                   /* الحالة الفعلية لا العمود المخزّن — نفس التعبير
                      الذي ترسم به الشاشة، مصدَّراً من بنّاء الشرط
                      نفسه (المرحلة 6).

                      البند المحفوظ من المرحلة 5 يقول: «شرط واحد
                      للشاشة والتصدير — الانحراف هنا صامت، ويُبنى
                      عليه قرار مالي». وكان الانحراف واقعاً فعلاً:
                      الشاشة كانت تقرأ العمود الخام أيضاً، فلما
                      صُحّحت وحدها كان الملف سيقول «نشط» لمشترك
                      تقول عنه الشاشة «منتهٍ». والملف يغادر إلى قرص
                      شخص، فتصحيحه بعد خروجه مستحيل. */
                   ${subscriptionStatusExpr} AS subscription_status,
                   sub.plan_id AS subscription_plan
              ${fromAndJoins}
             ORDER BY u.created_at DESC, u.id DESC`,
      params,
      headers: ["المعرّف", "الاسم", "البريد", "تاريخ التسجيل", "تاريخ توثيق البريد",
                "آخر دخول", "تاريخ التعليق", "حالة الحساب", "حالة الاشتراك", "الباقة"],
      map: (r) => [r.id, r.name, r.email, r.created_at, r.email_verified_at,
                   r.last_login_at, r.suspended_at, r.account_status,
                   r.subscription_status, r.subscription_plan],
    });
    await logExport(req, { kind: "users", filters, rows });
  } catch (err) {
    if (!res.headersSent) return fail(res, err, "admin/exports:users", req);
    res.end();
  }
});

/* ============================================================
   سجل التدقيق — للمالك وحده

   من يُدقَّق عليه لا يصدّر سجل تدقيقه. والتصدير نفسه يُسجَّل، فيبقى
   في السجل أثر لمن أخرجه.
   ============================================================ */
adminExportsRouter.get("/exports/audit-log.csv", requireAdminAuth, requirePermission("exports:audit"), async (req, res) => {
  try {
    const settings = await getBillingSettings();
    const { whereSql, params, filters } = buildAuditFilter(req.query);

    startCsv(res, `kanaf-audit-log-${stamp()}.csv`);
    writeMeta(res, { title: "سجل الإجراءات الإدارية", admin: req.admin, filters, timezone: settings.reportingTimezone });

    const rows = await streamRows(res, {
      where: "audit-log",
      sql: `SELECT al.created_at, au.name AS admin_name, au.email AS admin_email,
                   al.action, al.entity, al.entity_id, al.target_user_id,
                   al.old_value, al.new_value, al.reason, al.metadata, al.ip_address
              FROM admin_action_log al
              LEFT JOIN admin_users au ON au.id = al.admin_user_id
              ${whereSql}
             ORDER BY al.created_at DESC, al.id DESC`,
      params,
      headers: ["الوقت", "المسؤول", "بريد المسؤول", "الإجراء", "الكيان", "معرّف الكيان",
                "المستخدم الهدف", "القيمة السابقة", "القيمة الجديدة", "السبب", "بيانات إضافية", "العنوان"],
      map: (r) => [r.created_at, r.admin_name, r.admin_email, r.action, r.entity, r.entity_id,
                   r.target_user_id, r.old_value, r.new_value, r.reason, r.metadata, r.ip_address],
    });
    await logExport(req, { kind: "audit-log", filters, rows });
  } catch (err) {
    if (!res.headersSent) return fail(res, err, "admin/exports:audit-log", req);
    res.end();
  }
});
