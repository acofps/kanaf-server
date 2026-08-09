/* ============================================================
   مصفوفة الصلاحيات — Role × Resource × Action

   ------------------------------------------------------------
   لماذا استُبدل نموذج الرتبة الخطّية
   ------------------------------------------------------------
   كان النموذج السابق سُلَّماً من رقم واحد:

     const ROLE_RANK = { support: 1, content_manager: 2, admin: 3, owner: 4 };
     requireRole("support")  →  يمرّ كل من رتبته ≥ 1

   وهو نموذج يحمل افتراضاً واحداً: أن الصلاحيات متداخلة تداخلاً
   تاماً، وأن كل دور أعلى يحتوي كل ما دونه. والافتراض صحيح ما دامت
   الأدوار على خط واحد، ويسقط فور وجود دور **عرضي**.

   والمحاسب هو ذلك الدور بالضبط: يرى المدفوعات والفواتير
   والاسترداد والإيراد والضريبة، ولا يقترب من اليوميات ولا نتائج
   الفرز ولا تعليق الحسابات. فأين يوضع على السلّم؟

     • تحت admin  →  لا يرى الفواتير (فهي عند رتبة 3)
     • عند admin  →  يرى البيانات النفسية ويقدر يعلّق حساباً

   لا موضع صحيح له، لأن السؤال نفسه خطأ. المحاسب ليس "أعلى" ولا
   "أدنى" من مدير المحتوى — هو **في مكان آخر**.

   ------------------------------------------------------------
   والعطب لم يكن نظرياً
   ------------------------------------------------------------
   `content_manager` رتبته 2 و`support` رتبته 1، فكل مسار مكتوب
   بـ requireRole("support") كان يمرّ لمدير المحتوى:

     GET /admin/billing/subscriptions      ← الاشتراكات والأسعار
     GET /admin/billing/payments           ← كل عملية دفع
     GET /admin/billing/users/:id/billing  ← تاريخ مستخدم المالي كاملاً
     GET /admin/plans                      ← الباقات وأسعارها
     GET /admin/overview                   ← الإيراد والاسترداد
     GET /admin/users                      ← دليل المستخدمين
     GET /admin/messages                   ← رسائل التواصل

   أي أن اختبار القبول الأول في المرحلة 5 — «Content Manager لا
   يدخل المحاسبة» — كان يفشل على الإنتاج، لا لأن أحداً قرر ذلك بل
   لأن رقمين تُقورنا. وهذا ما يفعله النموذج الخطّي: يمنح صلاحيات
   لم يكتبها أحد.

   ------------------------------------------------------------
   البديل: قائمة صريحة لكل دور
   ------------------------------------------------------------
   لا رتب ولا مقارنات ولا وراثة ضمنية. كل دور يحمل قائمة ما يقدر
   عليه بالاسم. القوائم أطول، وهذا هو المقصود: الصلاحية التي لم
   تُكتب غير ممنوحة، والصلاحية الممنوحة يمكن قراءة سببها.

   ------------------------------------------------------------
   مصدر حقيقة واحد — للخادم واللوحة معاً
   ------------------------------------------------------------
   هذا الملف يُقرأ في الخادم لفرض الصلاحية، ويُرسَل نصّه المحسوب
   للوحة عبر GET /admin/auth/me لترسم القائمة. فلا جدول رتب ثانٍ
   في `admin-src/src/theme.js` يختلف عن هذا يوماً ما — وهو نفس
   المبدأ الذي حكم PUBLISHED_SQL في المرحلة 4.

   وتبقى القاعدة فوق ذلك كله: **اللوحة تُخفي، والخادم يمنع.** ما
   في هذا الملف يُطبَّق في الطلب نفسه؛ إخفاء الزر راحة عين.
   ============================================================ */

/* ------------------------------------------------------------
   1) السجل الكامل للصلاحيات

   كل صلاحية `resource:action` مع وصفها العربي. الوصف ليس تعليقاً:
   يُرسَل للوحة ويُولَّد منه جدول 05_RBAC_MATRIX.md، فيستحيل أن
   تختلف الوثيقة عن الكود.
   ------------------------------------------------------------ */
export const PERMISSION_CATALOG = {
  /* --- النظرة العامة --- */
  "overview:view":            "فتح الصفحة الرئيسية ومؤشراتها غير المالية",
  "overview:view_revenue":    "رؤية كتلة الإيراد والاسترداد والدفعات الفاشلة في الصفحة الرئيسية",

  /* --- المستخدمون --- */
  "users:view":               "قائمة المستخدمين وبياناتهم غير الحساسة",
  "users:view_sensitive":     "درجات اليوميات ونتائج الفرز — بسبب مكتوب يُسجَّل",
  "users:view_actions":       "سجل الإجراءات الإدارية على مستخدم بعينه",
  "users:suspend":            "تعليق حساب ورفع التعليق",

  /* --- الرسائل --- */
  "messages:view":            "رسائل التواصل الواردة",
  "messages:update_status":   "تغيير حالة الرسالة (مقروءة/مُجاب عليها)",

  /* --- المحتوى --- */
  "content:view":             "تصفّح كتالوج المحتوى وتفاصيله",
  "content:edit_presentation":"تعديل العنوان والتصنيف وترتيب العرض",
  "content:review":           "الاعتماد السريري أو الرفض",
  "content:toggle_launch":    "مفتاح الإطلاق — إيقاف محتوى حيّ فوراً أو إعادته",
  "content:schedule":         "جدولة النشر والإيقاف",
  "content:change_tier":      "تحويل محتوى بين مجاني وكنف+ — قرار مالي",
  "content:bulk_publish":     "النشر الجماعي",

  /* --- الإشعارات --- */
  "notifications:view":       "الحملات وتفاصيل التسليم وحالة المسح الدوري",
  "notifications:create":     "إنشاء حملة",
  "notifications:send":       "تنفيذ الإرسال",
  "notifications:cancel":     "إلغاء حملة مسودة أو مجدولة",
  "notifications:sweep":      "تشغيل المسح الدوري يدوياً",

  /* --- الباقات والإعدادات --- */
  "plans:view":               "عرض الباقات وأسعارها",
  "plans:edit":               "إنشاء باقة أو تعديل سعرها أو تعطيلها",
  "tax_settings:view":        "عرض البيانات الضريبية للبائع",
  "tax_settings:edit":        "تعديل الاسم النظامي والرقم الضريبي — يدخل في كل فاتورة قادمة",
  "billing_settings:view":    "عرض نسبة الضريبة والعملة والمنطقة الزمنية المحاسبية",
  "billing_settings:edit":    "تعديلها — يغيّر كل فاتورة تصدر بعده",
  "app_settings:view":        "عرض إعدادات التشغيل العامة",
  "app_settings:edit":        "تعديل إعدادات التشغيل العامة",

  /* --- المالية --- */
  "subscriptions:view":       "قائمة الاشتراكات",
  "subscriptions:cancel":     "إلغاء اشتراك يدوياً",
  "payments:view":            "قائمة المدفوعات",
  "payments:refund":          "تنفيذ استرداد — نقل مال حقيقي",
  /* المطابقة تسأل المزوّد عن حالة الدفعة الحقيقية وتطبّقها. صلاحية
     مستقلة لا مندمجة في payments:refund: هي ليست استرداداً، وقد
     تُفعّل اشتراكاً لم يُفعَّل. ولا مندمجة في webhooks:replay: تلك
     تعيد تشغيل حدث عندنا، وهذه تسأل خارجاً وتصدّق ما يقوله. */
  "payments:reconcile":       "مطابقة دفعة مع المزوّد وتطبيق حالته",
  "invoices:view":            "الفواتير الضريبية وملفاتها",
  "invoices:regenerate":      "إعادة إصدار وثيقة فاتورة مدفوعة بلا رقم ضريبي",
  "credit_notes:view":        "الإشعارات الدائنة وملفاتها",
  "refunds:view":             "سجل الاستردادات",
  "billing:view_user":        "الملف المالي الكامل لمستخدم واحد",
  "webhooks:view":            "سجل أحداث الدفع الواردة",
  "webhooks:view_payload":    "محتوى حمولة الحدث الخام",
  "webhooks:replay":          "إعادة تشغيل حدث دفع",
  "reports:view_kpis":        "المؤشرات المالية",
  "reports:view_integrity":   "تقرير تكامل البيانات المالية",

  /* --- التصدير --- */
  "exports:billing":          "تصدير المدفوعات والفواتير والاشتراكات",
  "exports:users":            "تصدير قائمة المستخدمين",
  "exports:audit":            "تصدير سجل التدقيق",

  /* --- الإدارة والتدقيق --- */
  "admins:view":              "قائمة حسابات الإدارة",
  "admins:invite":            "إنشاء حساب إدارة جديد",
  "admins:change_role":       "تغيير دور حساب إدارة",
  "admins:deactivate":        "تفعيل أو تعطيل حساب إدارة",
  "audit_log:view_reads":     "سجل الوصول — من قرأ بيانات حساسة ولماذا",
  "audit_log:view_actions":   "سجل الإجراءات — من غيّر ماذا، من أي قيمة إلى أي قيمة",
  "break_glass:request":      "طلب وصول طارئ",
  "break_glass:view":         "عرض طلبات الوصول الطارئ المعلّقة",
  "break_glass:approve":      "اعتماد طلب وصول طارئ",
};

export const ALL_PERMISSIONS = Object.freeze(Object.keys(PERMISSION_CATALOG));

/* ------------------------------------------------------------
   2) الأدوار

   `accountant` جديد في المرحلة 5، والأربعة الباقية مستخرَجة من
   النظام كما هو — لم يُخترع اسم ولم يُحذف دور.

   ⚠️ ثلاثة أمور عن `accountant` تحديداً:

   أولاً، لا يمكن كتابته في admin_users.role: الجدول يملكه
   postgres وقيد CHECK عليه يحصر القيم في الأربعة القديمة، وتوسيعه
   يحتاج ALTER TABLE المرفوض. مصدره الحقيقي جدول
   admin_role_assignments (الترحيل 008)، وأساسه في الجدول الأصلي
   يُكتب `support` — فلو ضاع صف الإسناد يسقط الحساب إلى أضعف دور
   لا إلى أقواه.

   ثانياً، صلاحياته كلها قراءة. المرحلة 5 §4 تقول إن المحاسب
   «يمكن أن **يرى** Payments/Invoices/Refunds/Revenue/Tax» — ولا
   تقول ينفّذها. فالاسترداد يبقى قرار مدير، وتعديل نسبة الضريبة
   يبقى قرار مالك. المحاسب يقرأ الدفاتر ولا يحرّك المال.

   ثالثاً، لا يملك `users:view`. وهذا مقصود: الفصل المطلوب في §4
   ليس «لا يرى الأسماء» — الفاتورة النظامية يجب أن تحمل اسم
   المشتري، ويراه في قوائم المالية بالضرورة — بل «لا يرى البيانات
   النفسية». وغياب users:view يزيد على ذلك أنه لا يتصفّح دليل
   المستخدمين كوجهة قائمة بذاتها.
   ------------------------------------------------------------ */
export const ROLES = Object.freeze([
  "support", "content_manager", "accountant", "admin", "owner",
]);

export const ROLE_LABEL = Object.freeze({
  support: "دعم فني",
  content_manager: "مدير محتوى",
  accountant: "محاسب",
  admin: "مدير",
  owner: "مالك",
});

export const ROLE_DESCRIPTION = Object.freeze({
  support: "يجيب على المستخدمين: يرى الحسابات والرسائل وحالة الاشتراك والدفع، ولا يغيّر شيئاً مالياً ولا يرى بيانات نفسية.",
  content_manager: "يحرّر المحتوى وعرضه فقط. لا محاسبة ولا مستخدمين ولا إشعارات.",
  accountant: "يقرأ الدفاتر كاملة — مدفوعات وفواتير واستردادات وإيراد وضريبة — ولا يرى بيانات نفسية ولا يحرّك مالاً.",
  admin: "التشغيل اليومي كاملاً عدا ما يخصّ المالك: حسابات الإدارة، وسجل التدقيق، وتعديل الضريبة والإعداد المالي.",
  owner: "كل شيء.",
});

/* ------------------------------------------------------------
   3) المصفوفة

   قوائم صريحة بلا وراثة. `admin` يعيد كتابة ما عند من دونه بدل أن
   يرثه ضمناً، لأن الوراثة الضمنية هي بالضبط ما منح مدير المحتوى
   وصولاً للمحاسبة.
   ------------------------------------------------------------ */
const MATRIX = {
  /* الدعم الفني — يجيب على "وش صار في حسابي؟" */
  support: [
    "overview:view",
    "users:view",
    "messages:view", "messages:update_status",
    "plans:view",
    "subscriptions:view", "payments:view", "billing:view_user",
  ],

  /* مدير المحتوى — المحتوى وحده.

     ⚠️ تضييق مقصود عن السلوك السابق: كان يصل إلى المستخدمين
     والرسائل والمحاسبة بحكم رتبته لا بقرار. لو احتاج المالك يوماً
     أن يرى مدير المحتوى دليل المستخدمين، الإضافة سطر واحد هنا —
     والفرق أنه سيكون قراراً مكتوباً. */
  content_manager: [
    "overview:view",
    "content:view", "content:edit_presentation",
  ],

  /* المحاسب — قراءة مالية كاملة، صفر بيانات نفسية، صفر تنفيذ. */
  accountant: [
    "overview:view", "overview:view_revenue",
    "subscriptions:view", "payments:view", "billing:view_user",
    "invoices:view", "credit_notes:view", "refunds:view",
    "reports:view_kpis", "reports:view_integrity",
    "plans:view", "tax_settings:view", "billing_settings:view",
    "webhooks:view",
    "exports:billing",
  ],

  /* المدير — التشغيل. الممنوع عنه أدناه ليس نسياناً:

       admins:*            من يدير من يدير كل شيء = قرار ملكية
       audit_log:*         من يُدقَّق عليه لا يقرأ سجل تدقيقه
       tax_settings:edit   خطأ فيه يفسد كل فاتورة قادمة
       billing_settings:edit  تغيير النسبة يغيّر كل فاتورة قادمة
       app_settings:edit   إعداد يظهر للمستخدم النهائي
       content:bulk_publish  نشر 64 عنصراً بضغطة لا يُترك لدور تشغيلي
       break_glass:approve المعتمِد يجب أن يكون غير الطالب — وadmin هو الطالب
       webhooks:view_payload  الحمولة الخام قد تحمل تفاصيل وسيلة دفع
       exports:audit       تصدير سجل التدقيق يخرجه من حراسة الخادم
  */
  admin: [
    "overview:view", "overview:view_revenue",
    "users:view", "users:view_sensitive", "users:view_actions", "users:suspend",
    "messages:view", "messages:update_status",
    "content:view", "content:edit_presentation", "content:review",
    "content:toggle_launch", "content:schedule", "content:change_tier",
    "notifications:view", "notifications:create", "notifications:send",
    "notifications:cancel", "notifications:sweep",
    "plans:view", "plans:edit",
    "tax_settings:view", "billing_settings:view", "app_settings:view",
    "subscriptions:view", "subscriptions:cancel",
    "payments:view", "payments:refund", "payments:reconcile", "billing:view_user",
    "invoices:view", "invoices:regenerate",
    "credit_notes:view", "refunds:view",
    "webhooks:view", "webhooks:replay",
    "reports:view_kpis", "reports:view_integrity",
    "exports:billing", "exports:users",
    "break_glass:request", "break_glass:view",
  ],

  /* المالك — كل ما في السجل. تُحسب من ALL_PERMISSIONS لا تُكتب
     يدوياً: قائمة مكتوبة يدوياً تنسى كل صلاحية تُضاف لاحقاً، فيصير
     المالك أضعف من المدير في ميزة جديدة — وهو عطب صامت. */
  owner: ALL_PERMISSIONS,
};

/* ------------------------------------------------------------
   4) فحص عند الإقلاع

   خطأ مطبعي في اسم صلاحية داخل المصفوفة لا يظهر كخطأ: يظهر كـ403
   في وجه مسؤول شرعي، بعد أسابيع، ويُشخَّص كعطب في مكان آخر. هذا
   الفحص يحوّله إلى فشل إقلاع صريح — أعلى صوتاً وأرخص بكثير.

   ونفس المنطق الذي يجعل الخادم يرفض الإقلاع حين يتساوى سرّا JWT.
   ------------------------------------------------------------ */
const known = new Set(ALL_PERMISSIONS);
for (const [role, list] of Object.entries(MATRIX)) {
  if (!ROLES.includes(role)) {
    console.error(`FATAL: مصفوفة الصلاحيات تحوي دوراً غير معرَّف: ${role}`);
    process.exit(1);
  }
  const unknown = list.filter((p) => !known.has(p));
  if (unknown.length) {
    console.error(
      `FATAL: الدور ${role} يشير إلى صلاحيات غير موجودة في PERMISSION_CATALOG: ${unknown.join(", ")}`
    );
    process.exit(1);
  }
}
for (const role of ROLES) {
  if (!MATRIX[role]) {
    console.error(`FATAL: الدور ${role} معرَّف في ROLES ولا صف له في المصفوفة.`);
    process.exit(1);
  }
}

/* المجموعات مجمَّدة بعد الفحص — لا شيء في وقت التشغيل يعدّل صلاحية. */
export const ROLE_PERMISSIONS = Object.freeze(
  Object.fromEntries(ROLES.map((r) => [r, Object.freeze(new Set(MATRIX[r]))]))
);

/* ------------------------------------------------------------
   5) الواجهة
   ------------------------------------------------------------ */

/** هل يملك هذا الدور هذه الصلاحية؟ دور مجهول ← لا شيء. */
export function can(role, permission) {
  const set = ROLE_PERMISSIONS[role];
  return set ? set.has(permission) : false;
}

/** هل يملك الدور **أياً** من هذه الصلاحيات؟ */
export function canAny(role, permissions) {
  return permissions.some((p) => can(role, p));
}

/** قائمة صلاحيات الدور — تُرسَل للوحة لترسم قائمتها. */
export function permissionsFor(role) {
  const set = ROLE_PERMISSIONS[role];
  return set ? [...set] : [];
}

export function isValidRole(role) {
  return ROLES.includes(role);
}

/* ------------------------------------------------------------
   6) الدور الأساس في الجدول الأصلي

   admin_users.role لا يقبل إلا الأربعة القديمة. فأي دور خارجها
   يُكتب هناك بـ`support` — أضعف قيمة مقبولة — ويأتي دوره الحقيقي
   من admin_role_assignments.

   والاتجاه مقصود: الاحتياط عند فقد صف الإسناد يهبط بالحساب، ولا
   يرفعه أبداً.
   ------------------------------------------------------------ */
const LEGACY_DB_ROLES = new Set(["support", "content_manager", "admin", "owner"]);

export function baseRoleFor(role) {
  return LEGACY_DB_ROLES.has(role) ? role : "support";
}

/** هل يحتاج هذا الدور صفاً في admin_role_assignments ليعني شيئاً؟ */
export function needsAssignmentRow(role) {
  return !LEGACY_DB_ROLES.has(role);
}

/* ------------------------------------------------------------
   7) المصفوفة كبيانات — لتوليد الوثيقة والاختبار من نفس المصدر

   05_RBAC_MATRIX.md و test-admin-security.mjs يقرآن من هنا. جدول
   في وثيقة يُكتب بيد تختلف عن الكود يوماً ما — وهذا المشروع دفع
   ثمن ذلك مرتين: وثيقة الخصوصية قالت إن أخطر الحقول لا يختارها أي
   استعلام إداري، والكود كان يختار daily_logs.note.
   ------------------------------------------------------------ */
export function matrixRows() {
  return ALL_PERMISSIONS.map((permission) => {
    const [resource, action] = permission.split(":");
    return {
      permission,
      resource,
      action,
      description: PERMISSION_CATALOG[permission],
      roles: Object.fromEntries(ROLES.map((r) => [r, can(r, permission)])),
    };
  });
}
