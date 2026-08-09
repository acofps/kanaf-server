import express from "express";
import { query } from "../db/pool.js";
import {
  requireAdminAuth, requirePermission, requireReasonAndLog,
  logAdminAction, fail, httpError,
} from "./middleware.js";
import { getBillingSettings } from "../billing/config.js";

export const adminSettingsRouter = express.Router();

/* ============================================================
   الإعدادات — البند 6 من المرحلة 5

   نصّ البند: «راجع صفحة Settings وحدد ما هو UI-only وما هو مربوط
   فعلياً… اجعل لكل Setting مصدر حقيقة واحد ولا تكرر القيم في عدة
   ملفات».

   ------------------------------------------------------------
   ما كانت عليه الحال
   ------------------------------------------------------------
   لا توجد «صفحة إعدادات» في اللوحة أصلاً. الإعدادات موزّعة على
   ثلاثة جداول وشاشتين وواجهة غائبة:

     billing_settings   نسبة الضريبة · العملة · المنطقة الزمنية
                        المحاسبية · بادئات أرقام الوثائق
                        → **بلا أي شاشة**. المسار موجود ومختبَر منذ
                          المرحلة 3، ولا زر يناديه. تغيير نسبة
                          الضريبة كان يحتاج نداءً مباشراً.

     tax_settings       الاسم النظامي · الرقم الضريبي · العنوان
                        → داخل صفحة «الباقات»، وهو موضع غريب:
                          البيانات الضريبية ليست باقة.

     app_settings       أُنشئ في الترحيل 008 — **بلا قارئ ولا كاتب**.

   ------------------------------------------------------------
   السجلّ أدناه هو الإجابة
   ------------------------------------------------------------
   لكل إعداد سطر يعلن: أين يسكن، ومن يقدر يعدّله، و**من يقرؤه
   فعلاً** في الكود. وحقل `wired` يقول الحقيقة بلا تجميل: مربوط
   بسلوك حقيقي، أم معروض ولا يؤثر بعد.

   وهذا الحقل ليس زينة توثيقية. الإعداد الذي يظهر في شاشة ولا يقرؤه
   أحد أخطر من الإعداد الغائب: المسؤول يغيّره، ويرى «حُفظ»، ويبني
   على أنه سرى. وهو نفس نمط العطب الذي كلّف هذا المشروع مرتين —
   البث الذي يعيد dev-mock ويُحسب نجاحاً، والوثيقة التي وصفت
   استعلاماً بغير ما يفعل.

   فالمكتوب هنا يُقرأ من الكود لا من الذاكرة، ويُعرض في الشاشة
   بشارة صريحة، ويولَّد منه 05_SETTINGS_AUDIT.md.
   ============================================================ */

/* ------------------------------------------------------------
   سجلّ الإعدادات

   source      الجدول الذي يملك القيمة — مصدر الحقيقة الوحيد
   readBy      الملفات التي تقرؤه فعلاً (فارغة = غير مربوط)
   wired       هل يغيّر تغييرُه سلوكاً حقيقياً اليوم؟
   editPerm    صلاحية التعديل
   ------------------------------------------------------------ */
export const SETTINGS_REGISTRY = [
  /* ---------- الإعداد المالي ---------- */
  {
    key: "vat_rate", label: "نسبة ضريبة القيمة المضافة",
    source: "billing_settings", editPerm: "billing_settings:edit", wired: true,
    readBy: ["billing/config.js", "payments/webhook.js", "payments/refund.js", "invoicing/generate.js"],
    note: "تُفكَّك مرة واحدة بـsplitVat، ونفس القيمة تدخل TLV الخاص بـQR ونص الوثيقة. الفواتير الصادرة لا تتأثر — نسبتها مجمّدة في invoice_state وقت إصدارها.",
  },
  {
    key: "prices_include_vat", label: "الأسعار شاملة الضريبة",
    source: "billing_settings", editPerm: "billing_settings:edit", wired: true,
    readBy: ["billing/config.js", "invoicing/generate.js"],
    note: "يحدّد هل يُشتق المبلغ قبل الضريبة بالقسمة أم تُضاف الضريبة فوقه.",
  },
  {
    key: "currency", label: "العملة",
    source: "billing_settings", editPerm: "billing_settings:edit", wired: true,
    readBy: ["billing/config.js", "payments/moyasar.js", "payments/routes.js"],
    note: "عملة واحدة في النظام كله — لا تحويل، فالمبالغ تُجمع مباشرة.",
  },
  {
    key: "reporting_timezone", label: "المنطقة الزمنية المحاسبية",
    source: "billing_settings", editPerm: "billing_settings:edit", wired: true,
    readBy: ["admin/billing.js", "admin/routes.js", "admin/exports.js"],
    note: "كل حدود التقارير محسوبة بها لا بتوقيت الخادم (UTC على Render). خطأ هنا ينسب مبيعات ثلاث ساعات لليوم الخطأ.",
  },
  {
    key: "invoice_number_prefix", label: "بادئة رقم الفاتورة",
    source: "billing_settings", editPerm: "billing_settings:edit", wired: true,
    readBy: ["invoicing/generate.js"],
    note: "تغييرها لا يمسّ الفواتير الصادرة — رقمها محفوظ كاملاً.",
  },
  {
    key: "credit_note_number_prefix", label: "بادئة رقم الإشعار الدائن",
    source: "billing_settings", editPerm: "billing_settings:edit", wired: true,
    readBy: ["payments/refund.js"],
  },

  /* ---------- البيانات الضريبية ---------- */
  {
    key: "legal_name", label: "الاسم النظامي للبائع",
    source: "tax_settings", editPerm: "tax_settings:edit", wired: true,
    readBy: ["invoicing/zatca.js", "invoicing/template.js"],
    note: "يدخل **حرفياً** في رمز QR للفاتورة. أي اختلاف عن شهادة التسجيل الضريبي عيب نظامي في كل فاتورة تصدر بعده.",
  },
  {
    key: "vat_number", label: "الرقم الضريبي",
    source: "tax_settings", editPerm: "tax_settings:edit", wired: true,
    readBy: ["invoicing/zatca.js", "invoicing/template.js"],
    note: "خمسة عشر رقماً. يدخل في TLV الخاص بـQR.",
  },
  {
    key: "address", label: "عنوان البائع",
    source: "tax_settings", editPerm: "tax_settings:edit", wired: true,
    readBy: ["invoicing/template.js"],
  },

  /* ---------- إعدادات التشغيل ----------

     ⚠️ الأربعة الأولى `wired: false` اليوم، وأقولها صراحةً بدل أن
     أعرضها كأنها تعمل: الترحيل 008 أنشأ الجدول وبذر القيم، وهذه
     المرحلة بنت لها قراءة وكتابة وشاشة — والخادم يقدّمها الآن على
     GET /api/support-info، لكن **تطبيق المستخدم لا يقرؤها بعد**،
     لأن تحديث التطبيق ليس ضمن المرحلة 5.

     فحالتها الصادقة: جاهزة في الخادم، غير مستهلَكة في الواجهة.
     تُعرض في اللوحة بشارة «لا يؤثر بعد»، ومقيَّدة في
     05_SETTINGS_AUDIT.md كبند مفتوح. ------------------------- */
  {
    key: "support_email", label: "بريد الدعم المعروض",
    source: "app_settings", editPerm: "app_settings:edit", wired: false,
    readBy: ["index.js (/api/support-info)"],
    note: "يقدّمه الخادم؛ التطبيق يعرضه حين يُحدَّث.",
  },
  {
    key: "support_hours", label: "أوقات عمل الدعم",
    source: "app_settings", editPerm: "app_settings:edit", wired: false,
    readBy: ["index.js (/api/support-info)"],
    note: "يقدّمه الخادم؛ التطبيق يعرضه حين يُحدَّث.",
  },
  {
    key: "app_public_name", label: "الاسم التجاري المعروض",
    source: "app_settings", editPerm: "app_settings:edit", wired: false,
    readBy: ["index.js (/api/support-info)"],
    note: "نصوص الرسائل الحالية تكتب «كنف» حرفياً. توحيدها على هذا الإعداد بند مفتوح.",
  },
  {
    key: "marketing_email_footer", label: "تذييل رسائل البث",
    source: "app_settings", editPerm: "app_settings:edit", wired: false,
    readBy: [],
    note: "notifications/service.js يبني تذييله حرفياً اليوم. ربطه بهذا الإعداد بند مفتوح.",
  },
  {
    key: "admin_session_minutes", label: "عمر جلسة الإدارة (عرض فقط)",
    source: "app_settings", editPerm: "app_settings:edit", wired: false,
    readBy: [],
    note: "⚠️ للعرض وحده ولا يمكن ربطه: القيمة السارية من متغيّر البيئة ADMIN_JWT_EXPIRES_IN، والرمز يُوقَّع بمدته عند الإصدار. تعديله هنا لا يفعل شيئاً — وهذا مكتوب في الشاشة أيضاً.",
  },
];

const REGISTRY_BY_KEY = Object.fromEntries(SETTINGS_REGISTRY.map((s) => [s.key, s]));

/* مفاتيح app_settings القابلة للتعديل — قائمة بيضاء مشتقّة من
   السجلّ. بدونها يقدر مسؤول أن يكتب مفتاحاً مخترَعاً في الجدول،
   فيمتلئ بقيم لا يقرؤها أحد ولا أحد يعرف من أين جاءت. */
const EDITABLE_APP_KEYS = new Set(
  SETTINGS_REGISTRY.filter((s) => s.source === "app_settings").map((s) => s.key)
);

/* ------------------------------------------------------------
   قارئ app_settings — يستعمله الخادم لا اللوحة وحدها.

   بلا تخزين مؤقت، للسبب نفسه المكتوب في billing/config.js: المشروع
   بلا Cache Layer، وإدخال واحدة لصفوف قليلة تُدخل مشكلة إبطال أخطر
   من الاستعلام نفسه.
   ------------------------------------------------------------ */
export async function getAppSettings(keys = null) {
  const { rows } = keys
    ? await query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [keys])
    : await query(`SELECT key, value FROM app_settings`);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function getAppSetting(key, fallback = null) {
  const { rows } = await query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return rows[0] ? rows[0].value : fallback;
}

/* ============================================================
   نظرة موحّدة على كل الإعدادات

   ثلاثة جداول في رد واحد، وكل قسم يظهر فقط لمن يملك صلاحية قراءته.
   ============================================================ */

adminSettingsRouter.get(
  "/settings/overview",
  requireAdminAuth,
  // يكفي أن يملك القارئ صلاحية قراءة قسم واحد؛ الأقسام تُرشَّح أدناه.
  (req, res, next) => {
    const any = ["billing_settings:view", "tax_settings:view", "app_settings:view"]
      .some((p) => req.admin.can(p));
    if (!any) return res.status(403).json({ error: "insufficient_permission" });
    next();
  },
  async (req, res) => {
    try {
      const sections = {};

      if (req.admin.can("billing_settings:view")) {
        const b = await getBillingSettings();
        sections.billing = {
          canEdit: req.admin.can("billing_settings:edit"),
          values: {
            vat_rate: b.vatRate,
            prices_include_vat: b.pricesIncludeVat,
            currency: b.currency,
            reporting_timezone: b.reportingTimezone,
            invoice_number_prefix: b.invoiceNumberPrefix,
            credit_note_number_prefix: b.creditNoteNumberPrefix,
          },
        };
      }

      if (req.admin.can("tax_settings:view")) {
        const { rows } = await query(
          `SELECT legal_name, vat_number, address, updated_at FROM tax_settings LIMIT 1`
        );
        sections.tax = {
          canEdit: req.admin.can("tax_settings:edit"),
          values: rows[0] || { legal_name: null, vat_number: null, address: null },
        };
      }

      if (req.admin.can("app_settings:view")) {
        const { rows } = await query(
          `SELECT key, value, category, description, updated_at FROM app_settings ORDER BY category, key`
        );
        sections.app = {
          canEdit: req.admin.can("app_settings:edit"),
          values: rows,
        };
      }

      /* السجلّ يُرسَل مع القيم لا منفصلاً عنها: الشاشة ترسم شارة
         «لا يؤثر بعد» من `wired`، ولا تحمل قائمتها الخاصة التي
         تتقادم. نفس مبدأ إرسال الصلاحيات في /auth/me. */
      res.json({
        sections,
        registry: SETTINGS_REGISTRY.filter((s) => {
          const viewPerm = s.editPerm.replace(":edit", ":view");
          return req.admin.can(viewPerm);
        }),
      });
    } catch (err) { fail(res, err, "admin/settings:overview", req); }
  }
);

/* ============================================================
   إعدادات التشغيل — قراءة وكتابة
   ============================================================ */

adminSettingsRouter.get(
  "/app-settings",
  requireAdminAuth, requirePermission("app_settings:view"),
  async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT s.key, s.value, s.category, s.description, s.updated_at,
                au.name AS updated_by_name
           FROM app_settings s
           LEFT JOIN admin_users au ON au.id = s.updated_by
          ORDER BY s.category, s.key`
      );
      res.json({
        settings: rows.map((r) => ({
          ...r,
          wired: REGISTRY_BY_KEY[r.key]?.wired ?? false,
          note: REGISTRY_BY_KEY[r.key]?.note || null,
          label: REGISTRY_BY_KEY[r.key]?.label || r.key,
        })),
      });
    } catch (err) { fail(res, err, "admin/settings:app-list", req); }
  }
);

/**
 * PUT /admin/app-settings/:key  { value, reason }
 *
 * القيمة JSONB، فيمكن أن تكون نصاً أو رقماً أو منطقياً. ولا تُقبل
 * إلا لمفتاح في السجلّ: الجدول لا يصير مقلباً لمفاتيح مخترَعة.
 *
 * ------------------------------------------------------------
 * ملاحظة على السجلّين — سلوك مقصود لاحظه الاختبار
 * ------------------------------------------------------------
 * requireReasonAndLog تكتب في admin_access_log **قبل** المعالج، فكل
 * محاولة تُسجَّل ولو رُفضت بعدها (مفتاح مجهول، قيمة فارغة). بينما
 * admin_action_log لا يُكتب فيه إلا بعد نجاح التعديل فعلاً.
 *
 * فثلاث محاولات على هذا المسار تعطي ثلاثة صفوف في سجل الوصول وصفاً
 * واحداً في سجل الإجراءات. وهذا هو المطلوب بالضبط: الأول يجيب «من
 * حاول ولماذا»، والثاني يجيب «ما الذي تغيّر فعلاً». وخلطهما كان
 * سيجعل السجل يدّعي تغييراً لم يقع، أو يُسقط محاولة وقعت.
 */
adminSettingsRouter.put(
  "/app-settings/:key",
  requireAdminAuth,
  requirePermission("app_settings:edit"),
  requireReasonAndLog("update_app_setting", { resolveTargetUserId: () => null }),
  async (req, res) => {
    const key = String(req.params.key || "");
    const reason = String(req.body?.reason || req.query?.reason || "").trim();
    try {
      if (!EDITABLE_APP_KEYS.has(key)) throw httpError(404, "unknown_setting");
      if (req.body?.value === undefined) throw httpError(400, "value_required");

      const value = req.body.value;
      // النص الفارغ ليس قيمة صالحة لإعداد معروض للمستخدم — يترك
      // شاشة فيها فراغ بلا أن يقول أحد إن الإعداد ناقص.
      if (typeof value === "string" && !value.trim()) throw httpError(400, "value_cannot_be_empty");
      // حدّ طول معقول: هذه إعدادات عرض لا مقالات.
      if (typeof value === "string" && value.length > 500) throw httpError(400, "value_too_long");

      const { rows: before } = await query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
      if (!before[0]) throw httpError(404, "unknown_setting");

      const { rows } = await query(
        `UPDATE app_settings SET value = $2::jsonb, updated_by = $3, updated_at = now()
          WHERE key = $1
          RETURNING key, value, category, description, updated_at`,
        [key, JSON.stringify(value), req.admin.id]
      );

      await logAdminAction({
        adminUserId: req.admin.id, action: "app_setting_updated",
        entity: "app_setting", entityId: key,
        oldValue: { value: before[0].value }, newValue: { value: rows[0].value },
        reason, ipAddress: req.ip,
      });

      res.json({
        setting: {
          ...rows[0],
          wired: REGISTRY_BY_KEY[key]?.wired ?? false,
          note: REGISTRY_BY_KEY[key]?.note || null,
          label: REGISTRY_BY_KEY[key]?.label || key,
        },
      });
    } catch (err) { fail(res, err, "admin/settings:app-update", req); }
  }
);
