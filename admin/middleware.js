import { verifyToken } from "./auth.js";
import { query } from "../db/pool.js";
import { can, canAny, permissionsFor, isValidRole } from "./permissions.js";

/* ============================================================
   وسيطة الإدارة — المصادقة، والصلاحية، وسجل التدقيق.

   تغيّر فيها ثلاثة أشياء جوهرية في المرحلة 5:
     1. الدور يُقرأ من قاعدة البيانات لا من داخل الرمز.
     2. الصلاحية بالاسم لا بالرتبة (admin/permissions.js).
     3. سجل الإجراءات صار يعرف على أي **كيان** وقع الفعل.
   ============================================================ */

/* ------------------------------------------------------------
   الدور الفعلي — استعلام واحد

   COALESCE(admin_role_assignments.role, admin_users.role):
   الجدول الأصلي admin_users يملكه postgres وقيد CHECK على عموده
   لا يقبل 'accountant'، فالدور الجديد يسكن الجدول الذي أنشأه
   الترحيل 008. والترتيب يجعل الإسناد يعلو على الأساس.

   `active` من الجدول الأصلي وحده: تعطيل الحساب قرار على الحساب
   نفسه لا على إسناد دوره.
   ------------------------------------------------------------ */
const EFFECTIVE_ADMIN_SQL = `
  SELECT au.id, au.name, au.email, au.active,
         COALESCE(ra.role, au.role) AS role,
         au.role                    AS base_role,
         ra.role                    AS assigned_role
    FROM admin_users au
    LEFT JOIN admin_role_assignments ra ON ra.admin_user_id = au.id
   WHERE au.id = $1`;

/** يقرأ الدور الفعلي وحالة الحساب. يُصدّر لأن مسارات المصادقة
    تحتاجه أيضاً (تسجيل الدخول، تجديد الرمز، /auth/me). */
export async function loadEffectiveAdmin(adminId) {
  const { rows } = await query(EFFECTIVE_ADMIN_SQL, [adminId]);
  return rows[0] || null;
}

/**
 * يتحقق من كوكي `kanaf_admin_access` ثم **يقرأ الحساب من قاعدة
 * البيانات**، ويعلّق req.admin = { id, name, email, role, permissions, can }.
 *
 * ============================================================
 * لماذا استعلام في كل طلب إداري — وهو تغيير مقصود
 * ============================================================
 * كان الدور يُقرأ من حمولة الرمز: `req.admin = { id: payload.sub,
 * role: payload.role }`. والرمز يُوقَّع عند الدخول ويبقى صالحاً
 * خمس عشرة دقيقة، فالدور المكتوب فيه **لقطة لحظة الدخول** لا
 * الحقيقة الحالية.
 *
 * النتيجة عطبان حقيقيان، وكلاهما في الاتجاه الخطر:
 *
 *   • خفض دور مسؤول من owner إلى support لا يسري. يبقى مالكاً
 *     خمس عشرة دقيقة كاملة بعد أن قرر أحدهم أنه لم يعد كذلك.
 *   • تعطيل حساب مسؤول لا يوقفه. `active` كانت تُفحص عند تجديد
 *     الرمز فقط، فرمز أُصدر قبل التعطيل بدقيقة يظل يعمل حتى
 *     ينتهي.
 *
 * وحين يكون سبب التعطيل مغادرة موظف أو اشتباه تسريب، فإن ربع
 * ساعة ليست تفصيلاً — هي بالضبط النافذة التي يُغلق الباب لأجلها.
 *
 * الثمن استعلام واحد بمفتاح أوّلي لكل طلب إداري. اللوحة يستخدمها
 * أفراد معدودون، والاستعلام على PRIMARY KEY، والبديل كان صلاحية
 * لا تسري. ولا تخزين مؤقت هنا عمداً: المشروع بلا طبقة Cache،
 * وإدخال واحدة لتوفير استعلام كهذا يعيد المشكلة نفسها بمدة أقصر.
 *
 * الرمز يظل يحمل `role` — لكنها لم تعد تُقرأ للتصريح إطلاقاً.
 * ============================================================
 */
export async function requireAdminAuth(req, res, next) {
  const token = req.cookies?.kanaf_admin_access;
  if (!token) return res.status(401).json({ error: "missing_token" });

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(401).json({ error: "invalid_or_expired_token" });
  }
  if (payload.type !== "access") return res.status(401).json({ error: "wrong_token_type" });

  try {
    const admin = await loadEffectiveAdmin(payload.sub);

    // الحساب حُذف بعد إصدار الرمز.
    if (!admin) return res.status(401).json({ error: "account_not_found" });
    // عُطِّل بعد إصدار الرمز — يسري الآن لا بعد انتهاء الرمز.
    if (!admin.active) return res.status(401).json({ error: "account_inactive" });

    /* دور لا تعرفه المصفوفة — قيمة أُدخلت يدوياً في القاعدة مثلاً.
       يُرفض بدل أن يُعامل كدور بلا صلاحيات: حساب يعمل بلا أي
       صلاحية يُشخَّص كعطب في اللوحة، والرفض الصريح يقول السبب. */
    if (!isValidRole(admin.role)) {
      console.error(`[admin/auth] دور غير معروف على الحساب ${admin.id}: ${admin.role}`);
      return res.status(403).json({ error: "unknown_role" });
    }

    const permissions = permissionsFor(admin.role);
    req.admin = {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      permissions,
      can: (p) => can(admin.role, p),
    };
    next();
  } catch (err) {
    console.error("[admin/auth] تعذّر قراءة حساب الإدارة:", err);
    res.status(500).json({ error: "internal_error" });
  }
}

/* ------------------------------------------------------------
   الصلاحية بالاسم

   `requirePermission("payments:refund")` تقرأ كما تُنطق، وتقول
   بالضبط ما يفعله المسار. البديل السابق `requireRole("admin")`
   كان يقول من يدخل، ولا يقول لماذا — فيصعب مراجعته، ويصعب أكثر
   ملاحظة أن دوراً آخر يمرّ منه بحكم رتبته.
   ------------------------------------------------------------ */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.admin?.can(permission)) {
      return res.status(403).json({ error: "insufficient_permission", required: permission });
    }
    next();
  };
}

/** يكفي امتلاك واحدة من عدة صلاحيات — لمسار يخدم غرضين. */
export function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!canAny(req.admin?.role, permissions)) {
      return res.status(403).json({ error: "insufficient_permission", requiredAny: permissions });
    }
    next();
  };
}

/* ------------------------------------------------------------
   ⚠️ requireRole — باقية للانتقال وحده، ولا يجوز أن يبقى لها
   مستدعٍ حين تُغلق المرحلة 5.

   سببها الوحيد أن ملفات الإدارة تُرفع إلى المستودع ملفاً ملفاً،
   وحذفها من هنا قبل تحديث آخر ملف يكسر مساراً على الإنتاج بين
   رفعتين — وهو بالضبط ما حصل في هذا المشروع مرتين في يوم واحد
   حين حُذف مسار تناديه نسخة منشورة.

   وسلوكها هنا **ليس** سلوكها السابق حرفياً: الدور الجديد
   `accountant` يحصل على رتبة صفر، فيُرفض من أي مسار لم يُحدَّث
   بعد. الاتجاه مقصود — مسار منسي يمنع المحاسب، ولا يمنحه شيئاً
   لم يُقرَّر له.

   واختبار المرحلة يفحص أن عدد مستدعيها في مجلد admin/ صار صفراً.
   ------------------------------------------------------------ */
const LEGACY_RANK = { support: 1, content_manager: 2, admin: 3, owner: 4 };

export function requireRole(minRole) {
  const minRank = LEGACY_RANK[minRole];
  return (req, res, next) => {
    const rank = LEGACY_RANK[req.admin?.role] || 0;
    if (rank < minRank) {
      return res.status(403).json({ error: "insufficient_role", required: minRole });
    }
    next();
  };
}

/* ------------------------------------------------------------
   حارس معرّف UUID — كان مكرراً في ملفين

   بدونه يذهب `/admin/users/not-a-uuid` إلى Postgres فيرد 22P02،
   فيُترجَم إلى 500 internal_error: خطأ خادم يُبلَّغ عن خطأ عميل،
   ويلوّث السجل بضجيج يخفي الأعطال الحقيقية.

   كان معرَّفاً مرتين — في admin/content.js و admin/notifications.js
   — ومغيَّباً عن admin/routes.js و admin/billing.js حيث معظم
   المسارات ذات المعرّفات. نسخة واحدة هنا، ومسارات المستخدمين
   والفواتير تستعملها الآن.
   ------------------------------------------------------------ */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuidParam(name = "id") {
  return (req, res, next) => {
    if (!UUID_RE.test(String(req.params[name] || ""))) {
      return res.status(404).json({ error: "not_found" });
    }
    next();
  };
}

/* ============================================================
   سجل التدقيق
   ============================================================ */

/**
 * صف واحد في admin_access_log — سجل **القراءات**.
 *
 * يُنادى من داخل المعالج **قبل** إعادة البيانات الحساسة، لا بعدها،
 * حتى لا يتيح انهيارٌ خروجَ بيانات بلا قيد مقابل.
 *
 * لا توجد في المستودع كله دالة تحديث أو حذف لهذا الجدول، وهذا
 * مقصود. لكن الحراسة الحقيقية سحب صلاحية UPDATE/DELETE من مستخدم
 * التطبيق، وهي خطوة يملكها مالك القاعدة وحده — موثّقة في
 * الترحيل 008 §5 وفي البند 12.19.
 */
export async function logSensitiveAccess({ adminUserId, targetUserId = null, action, reason, ipAddress = null }) {
  if (!reason || !reason.trim()) {
    throw new Error("logSensitiveAccess: a non-empty reason is required");
  }
  await query(
    `INSERT INTO admin_access_log (admin_user_id, target_user_id, action, reason, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [adminUserId, targetUserId, action, reason.trim(), ipAddress]
  );
}

/**
 * صف واحد في admin_action_log — سجل **التغييرات**.
 *
 * يُنادى **بعد** نجاح الكتابة، داخل نفس كتلة try — عكس ترتيب سجل
 * القراءات، وعكسه عن قصد: خطر القراءة أن تخرج بيانات بلا أثر،
 * وخطر الكتابة أن يدّعي السجل تغييراً لم يحدث.
 *
 * ============================================================
 * entity / entityId — أُضيفا في المرحلة 5
 * ============================================================
 * كان الجدول يعرف "على أي **مستخدم**" وقع الفعل عبر
 * target_user_id، ولا شيء غير ذلك. فكل فعل لا يخصّ مستخدماً —
 * تعديل سعر باقة، تغيير الرقم الضريبي، ترقية مسؤول إلى مالك،
 * إرسال حملة — كان يُكتب بهدف NULL، ولا يبقى ما يميّزه إلا نص
 * `action` وحقل metadata حرّ لا يمكن الفلترة عليه ولا الوثوق
 * بشكله.
 *
 * وأسوأ من ذلك أن target_user_id له مفتاح أجنبي إلى users، فوضع
 * معرّف **مسؤول** فيه يفشل بقيد المفتاح. وهذا ليس افتراضاً: هو
 * حرفياً العطب الذي أوقف الاسترداد في المرحلة 3 حين كُتب معرّف
 * دفعة في هذا العمود، فردّت الوسيطة 500 والعملية لم تبدأ.
 *
 * entity نصّي بلا مفتاح أجنبي لأن الكيانات أنواع مختلفة:
 *   user · admin_user · plan · content · campaign · payment
 *   invoice · tax_settings · billing_settings · app_setting
 *
 * وحين يكون الكيان مستخدماً، يُملأ العمودان معاً: target_user_id
 * لأجل المفتاح الأجنبي والاستعلامات القائمة، وentity/entity_id
 * لأجل التوحيد. لا ازدواج في مصدر الحقيقة — بل عمود قديم يبقى
 * على عهده وعمود جديد يسع ما لا يسعه.
 * ============================================================
 *
 * ولا يُكتب هنا أبداً: كلمات مرور، أو رموز، أو أسرار، أو بيانات
 * بطاقة، أو نص المستخدم النفسي. السجل يقرؤه المالك، وليس مكاناً
 * لشيء من ذلك.
 */
export async function logAdminAction({
  adminUserId, targetUserId = null, action,
  entity = null, entityId = null,
  oldValue = null, newValue = null, reason, metadata = null, ipAddress = null,
}) {
  if (!reason || !String(reason).trim()) {
    throw new Error("logAdminAction: a non-empty reason is required");
  }

  // كيان المستخدم يُستنتج حين لا يُصرَّح به — فالمسارات القديمة
  // التي تمرّر targetUserId وحده تبقى صحيحة بلا تعديل.
  const resolvedEntity = entity || (targetUserId ? "user" : null);
  const resolvedEntityId = entityId || (targetUserId ? String(targetUserId) : null);

  await query(
    `INSERT INTO admin_action_log
       (admin_user_id, target_user_id, action, entity, entity_id,
        old_value, new_value, reason, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      adminUserId, targetUserId, action,
      resolvedEntity, resolvedEntityId,
      oldValue === null ? null : JSON.stringify(oldValue),
      newValue === null ? null : JSON.stringify(newValue),
      String(reason).trim(),
      metadata === null ? null : JSON.stringify(metadata),
      ipAddress,
    ]
  );
}

/**
 * وسيطة: تشترط سبباً مكتوباً، وتسجّله، ثم تمرّر.
 *
 * ============================================================
 * options.resolveTargetUserId — أُضيف في المرحلة 3، وسببه عطب حقيقي
 * ============================================================
 * كان الهدف يُستنتج دائماً بـ`req.params.userId || req.params.id`.
 * الافتراض الضمني: كل مسار محمي بهذه الوسيطة معرّفه في المسار هو
 * معرّف مستخدم. كان صحيحاً حين كُتب — كل المسارات وقتها كانت
 * /users/:id/... — وسقط فور وجود مسار مالي معرّفه معرّف **دفعة**:
 *
 *   POST /admin/billing/payments/:id/refund
 *
 * فيُكتب معرّف دفعة في عمود admin_access_log.target_user_id الذي له
 * مفتاح أجنبي إلى users، فيرفضه القيد، فترد الوسيطة 500
 * audit_log_failed — و**الاسترداد كله يتوقف قبل أن يبدأ**.
 *
 * الحمد لله أن ترتيب الفشل كان في الاتجاه الآمن: العملية لم تُنفَّذ
 * أصلاً لأن السجل يُكتب قبل المعالج. لو كان الترتيب معكوساً لكان
 * المال قد استُرد بلا أثر في سجل التدقيق.
 *
 * الحل: المسار يعلن كيف يُشتق هدفه — دالة قد تكون غير متزامنة، أو
 * () => null لمسار لا هدف مستخدم له أصلاً (تعديل الإعداد الضريبي
 * مثلاً). والسلوك الافتراضي كما كان تماماً.
 * ============================================================
 */
export function requireReasonAndLog(action, options = {}) {
  const resolveTargetUserId =
    options.resolveTargetUserId || ((req) => req.params.userId || req.params.id || null);

  return async (req, res, next) => {
    const reason = req.body?.reason || req.query?.reason;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: "reason_required", message: "لازم تكتب سبب قبل ما تشوف بيانات حساسة." });
    }
    try {
      const targetUserId = (await resolveTargetUserId(req)) || null;
      await logSensitiveAccess({
        adminUserId: req.admin.id,
        targetUserId,
        action,
        reason: String(reason),
        ipAddress: req.ip,
      });
      next();
    } catch (err) {
      console.error("[admin/audit] تعذّر كتابة سجل الوصول:", err);
      res.status(500).json({ error: "audit_log_failed" });
    }
  };
}

/* ============================================================
   أخطاء منظّمة — البند 10

   الممنوع في المرحلة 5 صريح: لا فشل صامت، ولا console.log وحده،
   ولا catch فارغ. والموجود قبلها كان `console.error(err)` عارياً:
   يطبع الأثر بلا سياق — أي مسار، وأي مسؤول، وأي طلب — فيصير سجل
   الإنتاج صعب الربط بالحادثة.

   `fail()` تفعل ثلاثة أشياء في نداء واحد:
     • تطبع سطراً واحداً يحمل الموضع والمسؤول والمسار والسبب
     • ترد جسماً ثابت الشكل { error, message } — رمز للبرنامج
       ونص عربي للإنسان
     • تميّز الخطأ المتوقَّع (err.status) عن غير المتوقَّع، فلا
       يُبلَّغ عن 404 بوصفه عطب خادم

   ولا تُسرَّب تفاصيل داخلية للعميل: نص الاستثناء يبقى في السجل.
   ============================================================ */

const ARABIC_FALLBACK = "صار خلل غير متوقع. الفريق يقدر يشوف التفاصيل في السجل.";

export function fail(res, err, where, req = null) {
  // خطأ متوقَّع رفعه المعالج بنفسه — ليس عطباً، ولا يُسجَّل كعطب.
  if (err?.status && err.status < 500) {
    return res.status(err.status).json({
      error: err.message || "request_failed",
      ...(err.detail ? { detail: err.detail } : {}),
    });
  }

  console.error(
    `[${where}] ${req?.method || ""} ${req?.originalUrl || ""} ` +
    `admin=${req?.admin?.id || "-"} (${req?.admin?.role || "-"}): ${err?.message || err}`,
    err?.stack || ""
  );

  res.status(500).json({ error: "internal_error", message: ARABIC_FALLBACK });
}

/** خطأ متوقَّع بحالة HTTP — يُرمى من المعالج ويلتقطه fail(). */
export function httpError(status, code, detail) {
  return Object.assign(new Error(code), { status, ...(detail ? { detail } : {}) });
}
