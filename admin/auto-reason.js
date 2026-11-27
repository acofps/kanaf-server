/* ============================================================
   السبب التلقائي — ملحق KANAF-ORD-0013، قرار المالك 1

   نصّ المالك: «ولا في أي مكان اكتب السبب — إلغاؤه والاكتفاء بسجلّ قبل/بعد».
   فلا تطلب اللوحة سبباً مكتوباً في أي موضع.

   لكن admin_action_log.reason و admin_access_log.reason هما TEXT NOT NULL
   (الترحيل 003)، والمسارات القائمة تشترط السبب. ولا يُحذف عمود ولا يُخفَّف قيد.
   فيولّد الخادم السبب من نوع الإجراء وهدفه، قبل أن يبلغ الطلب أي معالج:
   وسيطة واحدة على /admin تملأ reason في الجسم والاستعلام إن غاب.

   ما يبقى كما هو بلا نقصان: من عدّل، ومتى، والقيمة قبل، والقيمة بعد، وعنوان IP.
   السبب التلقائي لا يُكتب فارغاً أبداً، ولا «—». وسبب يرسله مستدعٍ للواجهة
   البرمجية يبقى مقبولاً كما هو، وإن كانت اللوحة لم تعد ترسله.
   ============================================================ */

const ID = "[^/]+";
/* ملاحظة: المالية مركّبة تحت /admin/billing (admin/routes.js:30)، فمساراتها هنا بالبادئة. */
/** [الطريقة، قالب المسار تحت /admin، النص]. الترتيب مهم: الأخصّ قبل الأعم. */
export const AUTO_REASONS = [
  // العملاء
  ["PATCH",  "/users/:id/profile",              "تعديل ملف العميل من اللوحة"],
  ["PUT",    "/users/:id/avatar",               "تغيير صورة العميل من اللوحة"],
  ["DELETE", "/users/:id/avatar",               "حذف صورة العميل من اللوحة"],
  ["PATCH",  "/users/:id/subscription",         "تعديل اشتراك العميل يدوياً من اللوحة"],
  ["POST",   "/users/:id/subscription/cancel",  "إلغاء اشتراك العميل من اللوحة"],
  ["POST",   "/users/:id/subscription/refund",  "استرداد اشتراك العميل من اللوحة"],
  ["POST",   "/users/:id/suspend",              "تعليق حساب العميل من اللوحة"],
  ["POST",   "/users/:id/restore",              "رفع تعليق حساب العميل من اللوحة"],
  ["POST",   "/users/:id/purge",                "الحذف النهائي لحساب معطَّل من اللوحة"],
  ["POST",   "/users/:id/autorenew/disable",    "إيقاف التجديد التلقائي للعميل من اللوحة"],
  ["GET",    "/users/:id/sensitive",            "عرض بيانات المتابعة الحسّاسة في ملف العميل"],
  ["GET",    "/users/:id/actions",              "عرض سجل إجراءات العميل في ملفه"],
  // المالية
  ["POST",   "/billing/payments/:id/refund",            "استرداد دفعة من اللوحة"],
  ["POST",   "/billing/payments/:id/reconcile",         "تسوية دفعة مع المزوّد من اللوحة"],
  ["POST",   "/billing/webhook-events/:id/replay",      "إعادة تشغيل حدث دفع من اللوحة"],
  ["POST",   "/billing/payment-holds/:id/recheck",      "إعادة فحص دفعة معلّقة من اللوحة"],
  ["POST",   "/billing/payment-holds/:id/dismiss",      "صرف دفعة معلّقة من اللوحة"],
  ["PUT",    "/billing/settings",               "تعديل الإعداد المالي من اللوحة"],
  ["PUT",    "/tax-settings",                   "تعديل الإعداد الضريبي من اللوحة"],
  ["PUT",    "/site-front",                     "تعديل واجهة الموقع (روابطها ونصّيها القانونيين) من اللوحة"],
  ["POST",   "/invoices/:id/regenerate",        "إعادة توليد مستند فاتورة من اللوحة"],
  // الباقات والخصم
  ["POST",   "/plans/:id/toggle-active",        "تفعيل باقة أو إيقافها من اللوحة"],
  ["PATCH",  "/plans/:id",                      "تعديل باقة من اللوحة"],
  ["POST",   "/plans",                          "إنشاء باقة من اللوحة"],
  ["POST",   "/discount-codes/:id/active",      "تفعيل كود خصم أو إيقافه من اللوحة"],
  ["POST",   "/discount-codes",                 "إنشاء كود خصم من اللوحة"],
  // المحتوى
  ["POST",   "/content/bulk-publish",           "نشر جماعي للمحتوى من اللوحة"],
  ["POST",   "/content/:id/toggle-launch",      "تبديل إتاحة محتوى عند الإطلاق من اللوحة"],
  ["POST",   "/content/:id/review",             "مراجعة محتوى من اللوحة"],
  ["PATCH",  "/content/:type/:key/presentation","تعديل عرض محتوى من اللوحة"],
  ["POST",   "/content/:type/:key/schedule",    "جدولة نشر محتوى من اللوحة"],
  // الإشعارات والرسائل
  ["POST",   "/notifications/:id/send",         "إرسال حملة إشعارات من اللوحة"],
  ["POST",   "/notifications/:id/cancel",       "إلغاء حملة إشعارات من اللوحة"],
  ["PUT",    "/message-catalog/:key",           "تعديل نصّ رسالة نظام أو قالبها أو قنواتها من اللوحة"],
  ["DELETE", "/message-catalog/:key",           "إعادة رسالة نظام إلى نصّها الافتراضي من اللوحة"],
  ["POST",   "/message-templates",              "إنشاء قالب بريد من اللوحة"],
  ["PUT",    "/message-templates/:id",          "تعديل قالب بريد من اللوحة"],
  ["DELETE", "/message-templates/:id",          "حذف قالب بريد من اللوحة"],
  // الإعدادات والتكاملات
  ["PUT",    "/app-settings/:key",              "تعديل إعداد تشغيل من اللوحة"],
  ["PUT",    "/integrations/:service/:key",     "حفظ اعتماد تكامل من اللوحة"],
  ["DELETE", "/integrations/:service/:key",     "حذف اعتماد تكامل من اللوحة"],
  ["POST",   "/integrations/:service/test",     "فحص اتصال تكامل من اللوحة"],
  // حسابات الإدارة
  ["POST",   "/admin-users/direct",             "إضافة حساب إدارة مباشرة من اللوحة"],
  ["PATCH",  "/admin-users/:id/pages",          "تعديل صفحات حساب إدارة من اللوحة"],
  ["POST",   "/admin-users/:id/resend-invite",  "إعادة إرسال دعوة حساب إدارة من اللوحة"],
  ["POST",   "/admin-users/:id/reset-password", "إعادة ضبط كلمة مرور حساب إدارة من اللوحة"],
  ["PATCH",  "/admin-users/:id",                "تعديل حساب إدارة من اللوحة"],
  ["POST",   "/admin-users",                    "دعوة حساب إدارة من اللوحة"],
  // التشغيل
  ["DELETE", "/system-errors/:id",              "إزالة خطأ نظام عولج من اللوحة"],
];

const COMPILED = AUTO_REASONS.map(([method, tpl, text]) => ({
  method, text, re: new RegExp(`^${tpl.replace(/:[a-z_]+/g, ID)}/?$`),
}));

/** النص التلقائي لطلب على /admin، أو null لطلب قراءة عادي لا يحتاج سبباً. */
export function autoReasonFor(method, path) {
  const hit = COMPILED.find((c) => c.method === method && c.re.test(path));
  if (hit) return hit.text;
  // كتابة غير مُدرجة (مسار يُضاف لاحقاً): نصّ مقروء غير فارغ، لا «—».
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    return `إجراء من لوحة الإدارة: ${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")}`;
  }
  return null;
}

/** وسيطة /admin: تملأ reason إن غاب أو كان فارغاً، في الجسم والاستعلام معاً. */
export function autoReasonMiddleware(req, res, next) {
  const given = String(req.body?.reason ?? req.query?.reason ?? "").trim();
  if (given) return next();
  const text = autoReasonFor(req.method, req.path);
  if (!text) return next();
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) req.body.reason = text;
  else if (!req.body) req.body = { reason: text };
  if (req.query && typeof req.query === "object") req.query.reason = text;
  req.autoReason = text;
  next();
}
