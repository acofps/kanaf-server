import crypto from "crypto";
import { query } from "../db/pool.js";

/* ============================================================
   كتالوج المحتوى — مصدر الحقيقة الوحيد لما يراه المستخدم.

   ------------------------------------------------------------
   المشكلة التي يحلها هذا الملف
   ------------------------------------------------------------
   كان ظهور المحتوى محكوماً بثلاثة ثوابت JS داخل حزمة التطبيق:
   JOURNEY_LAUNCH_CONFIG و OVERLAY_LAUNCH_CONFIG و
   NOTEBOOK_LAUNCH_CONFIG — كلها { enabled: true } مكتوبة يدوياً.
   ومعها clinical_review_status محفور في تعريف كل عنصر بقيمة
   "review_required". النتيجة على الإنتاج:

     • إيقاف رحلة واحدة يحتاج تعديل كود وبناء ورفع يدوي إلى cPanel.
     • لوحة الإدارة تقرأ جدولاً فارغاً لا علاقة له بما يُعرض.
     • كل الرحلات والدفاتر معروضة وغير قابلة للفتح، لأن دوال
       canEnrollInJourney / canOpenNotebook ترفض ما ليس "approved".

   الآن القرار من الخادم: التطبيق يجلب هذا الكتالوج عند الإقلاع
   ويستبدل به الثوابت الثلاثة. نصوص المحتوى تبقى في حزمة التطبيق —
   ما انتقل هو **قرار الظهور والطبقة**، وهو بالضبط ما كانت اللوحة
   تدّعي أنها تديره.

   ------------------------------------------------------------
   لماذا لا يوجد Cache هنا
   ------------------------------------------------------------
   المشروع بلا طبقة Cache، ولم تُضف واحدة لهذا التدفق. الكتالوج
   64 صفاً بلا JOIN مكلف، والقراءة أرخص من أي آلية إبطال. وإضافة
   Cache هنا كانت ستُدخل السؤال الذي لا نريده: "أوقفتُ الرحلة —
   بعد كم دقيقة تختفي فعلاً؟" الجواب الآن: فوراً.
   ============================================================ */

/* ------------------------------------------------------------
   شرط "منشور فعلاً" — تعريف واحد يستخدمه الجميع.

   أربعة شروط، وكلها يجب أن تتحقق:
     1. المراجعة السريرية اعتمدته.
     2. مفتاح الإطلاق مرفوع (كاسر دائرة مستقل عن المراجعة).
     3. وقت النشر حان أو غير محدد.
     4. وقت الإيقاف لم يحن أو غير محدد.

   الشرطان 3 و4 هما الجدولة كلها. لا وظيفة خلفية تحوّل "مجدول" إلى
   "منشور" — الحالة تُحسب من الوقت في كل قراءة. لهذا يستحيل على هذا
   النظام أن يقول "نُشر" قبل النشر: لا يوجد عمود يكذب.
   ------------------------------------------------------------ */
export const PUBLISHED_SQL = `
  cp.content_key IS NOT NULL
  AND ci.clinical_review_status = 'approved'
  AND ci.launch_enabled = true
  AND (cp.publish_at   IS NULL OR cp.publish_at   <= now())
  AND (cp.unpublish_at IS NULL OR cp.unpublish_at >  now())`;

/* ------------------------------------------------------------
   الشرط الأول (`cp.content_key IS NOT NULL`) ليس حشواً.

   الربط أدناه LEFT JOIN لا INNER JOIN، لسبب اكتُشف في المراجعة:
   بـINNER JOIN، أي صف في content_items بلا صف عرض يختفي من
   كتالوج المستخدم **ومن الكتالوج الإداري معاً** — فلا يمكن حتى
   تشخيصه من اللوحة. صار يظهر للمسؤول موسوماً بـmissing_presentation،
   ولا يظهر للمستخدم لأن الشرط الأول يمنعه.

   ------------------------------------------------------------
   DISTINCT ON — تحديد النسخة الحالية

   content_items فريد على (نوع، مفتاح، **نسخة**)، وcontent_presentation
   فريد على (نوع، مفتاح) فقط. إضافة نسخة 2.0.0 لمفتاح قائم كانت
   تكرّره في كل استعلام كتالوج، وassertContentAvailable كانت تختار
   بـLIMIT 1 بلا ترتيب — أي أن الطبقة المفروضة تصير عشوائية بين
   النسختين. الترتيب التنازلي بالنسخة يجعل الأحدث هو الحاكم دائماً.

   كامن اليوم (1.0.0 وحدها مبذورة) ويظهر أول يوم يُنشَّأ فيه إصدار
   ثانٍ — وهو ما وُجد content_version أصلاً من أجله.
   ------------------------------------------------------------ */
const CATALOG_BASE = `
  FROM content_items ci
  LEFT JOIN content_presentation cp
    ON cp.content_type = ci.content_type
   AND cp.content_key  = ci.content_key`;

/**
 * الكتالوج كما يراه المستخدم: العناصر المنشورة فقط.
 *
 * لا يعيد سبب الإخفاء ولا تواريخ الجدولة ولا ملاحظات المراجعة —
 * تسريب "هذا العنصر مجدول ليوم كذا" من مسار عام يكشف خطة منتج بلا
 * داعٍ. المسار الإداري يعيد كل ذلك.
 */
export async function getPublishedCatalog() {
  const { rows } = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (ci.content_type, ci.content_key)
              ci.content_type, ci.content_key, ci.content_version,
              cp.title, cp.category, cp.subscription_tier, cp.display_order,
              GREATEST(ci.updated_at, cp.updated_at) AS touched_at
       ${CATALOG_BASE}
       WHERE ${PUBLISHED_SQL}
       ORDER BY ci.content_type, ci.content_key, ci.content_version DESC
     ) c
     ORDER BY c.content_type, c.display_order, c.title`
  );

  // مجمّع حسب النوع لأن التطبيق يستهلكه كخريطة مفاتيح لكل سجل
  // (رحلات، تراكبات، دفاتر...) لا كقائمة مسطّحة.
  const byType = {};
  for (const r of rows) {
    (byType[r.content_type] ||= {})[r.content_key] = {
      enabled: true,
      version: r.content_version,
      title: r.title,
      category: r.category,
      subscription_tier: r.subscription_tier,
      display_order: r.display_order,
      // التطبيق يقرأ هذا الحقل في canEnrollInJourney / canOpenNotebook.
      // إرساله "approved" صراحةً بدل الاعتماد على الثابت المضمّن في
      // الحزمة هو ما يفك القفل الحالي — وبقراره من الخادم لا من الكود.
      clinical_review_status: "approved",
    };
  }

  /* ------------------------------------------------------------
     البصمة تُحسب من الحمولة نفسها.

     ⚠️ النسخة الأولى كانت `${rows.length}:${مجموع أطوال المفاتيح}`
     — وهي لا تتغيّر حين يتغيّر **محتوى** الصفوف. أثبتت المراجعة
     العطب عملياً: تغيير عنوان رحلة وتحويل طبقتها من free إلى plus
     أبقى الـETag كما هو، فيرد الخادم 304 على عميل يحمل النسخة
     القديمة — أي أن تحويل محتوى إلى كنف+ **لا يصل جهازاً مثبَّتاً
     أبداً**. عكس ما يعد به هذا الملف حرفياً.

     الآن: تجزئة SHA-1 لخريطة الأنواع كاملةً. أي تغيير في عنوان أو
     طبقة أو تصنيف أو ترتيب أو ظهور يغيّر البصمة.
     ------------------------------------------------------------ */
  const revision = crypto
    .createHash("sha1")
    .update(JSON.stringify(byType))
    .digest("base64url")
    .slice(0, 22);

  return {
    revision,
    counts: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Object.keys(v).length])),
    types: byType,
  };
}

/**
 * الكتالوج الإداري: كل عنصر بحالته الحقيقية، منشوراً كان أم لا،
 * مع سبب عدم الظهور محسوباً في الخادم لا مستنتجاً في الواجهة.
 *
 * يدعم البحث والفلترة والترقيم من طرف الخادم (البند 10). الترتيب
 * ينتهي بـcontent_key لتثبيته — بدون مفتاح فاصل مستقر تتكرر صفوف
 * وتُفقد أخرى بين الصفحات، وهو نفس العطب الذي أُصلح في قائمة
 * المستخدمين.
 */
export async function getAdminCatalog({
  type = null, status = null, search = null, published = null,
  limit = 50, offset = 0,
} = {}) {
  const where = [];
  const params = [];

  if (type) { params.push(type); where.push(`ci.content_type = $${params.length}`); }
  if (status) { params.push(status); where.push(`ci.clinical_review_status = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(cp.title ILIKE $${params.length} OR ci.content_key ILIKE $${params.length})`);
  }
  if (published === true) where.push(`(${PUBLISHED_SQL})`);
  if (published === false) where.push(`NOT (${PUBLISHED_SQL})`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  params.push(limit, offset);
  const { rows } = await query(
    `SELECT ci.id, ci.content_type, ci.content_key, ci.content_version,
            ci.clinical_review_status, ci.launch_enabled, ci.reviewed_at,
            ci.reviewer_admin_id, ci.review_notes, ci.updated_at,
            cp.title, cp.category, cp.subscription_tier, cp.display_order,
            cp.publish_at, cp.unpublish_at, cp.updated_by, cp.updated_at AS presentation_updated_at,
            (cp.content_key IS NULL) AS missing_presentation,
            (${PUBLISHED_SQL}) AS is_live
     ${CATALOG_BASE}
     ${whereSql}
     ORDER BY ci.content_type, COALESCE(cp.display_order, 9999), ci.content_key, ci.content_version DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const { rows: countRows } = await query(
    `SELECT count(*)::int AS total ${CATALOG_BASE} ${whereSql}`,
    params.slice(0, params.length - 2)
  );

  return {
    items: rows.map((r) => ({ ...r, hidden_reason: hiddenReason(r) })),
    total: countRows[0].total,
    limit,
    offset,
  };
}

/**
 * لماذا لا يظهر هذا العنصر للمستخدم؟ محسوب في الخادم لأن الواجهة
 * لا يجوز أن تعيد تنفيذ منطق النشر — تكرار المنطق في مكانين يعني
 * أنهما سيختلفان يوماً ما، والواجهة ستقول "منشور" والخادم يحجبه.
 */
function hiddenReason(row) {
  if (row.is_live) return null;
  if (row.missing_presentation) return "لا يوجد صف عرض لهذا العنصر — لن يظهر إطلاقاً";
  if (row.clinical_review_status === "rejected") return "مرفوض في المراجعة السريرية";
  if (row.clinical_review_status === "retired") return "متقاعد";
  if (row.clinical_review_status !== "approved") return "قيد المراجعة السريرية";
  if (!row.launch_enabled) return "مفتاح الإطلاق مغلق";
  if (row.publish_at && new Date(row.publish_at) > new Date()) return "مجدول للنشر لاحقاً";
  if (row.unpublish_at && new Date(row.unpublish_at) <= new Date()) return "انتهى وقت عرضه";
  return "غير منشور";
}

/**
 * فحص عنصر واحد — تستخدمه مسارات البيانات التشغيلية قبل أن تسمح
 * للمستخدم ببدء رحلة أو فتح دفتر.
 *
 * هذه هي النقطة التي تجعل الحجب حقيقياً لا شكلياً: إخفاء العنصر من
 * الكتالوج وحده يعني أن من يعرف المفتاح يقدر يبدأ رحلة موقوفة
 * بنداء مباشر. الفحص هنا على مستوى الخادم، لا بإخفاء زر.
 */
export async function assertContentAvailable(contentType, contentKey) {
  const { rows } = await query(
    `SELECT cp.subscription_tier, (${PUBLISHED_SQL}) AS is_live
     ${CATALOG_BASE}
     WHERE ci.content_type = $1 AND ci.content_key = $2
     ORDER BY ci.content_version DESC
     LIMIT 1`,
    [contentType, contentKey]
  );
  const row = rows[0];
  if (!row) throw Object.assign(new Error("content_not_found"), { status: 404 });
  if (!row.is_live) throw Object.assign(new Error("content_not_published"), { status: 403 });
  return { subscriptionTier: row.subscription_tier };
}

/**
 * سجل تغييرات المحتوى. يُكتب صف لكل تغيير — لا تحديث ولا حذف.
 *
 * منفصل عن admin_action_log لأن ذاك مربوط بـtarget_user_id
 * (مفتاح أجنبي إلى users)، وتغييرات المحتوى بلا مستخدم هدف. حشر
 * حدث محتوى فيه كان سيعني عموداً فارغاً أبداً وفهرساً بلا فائدة.
 */
export async function recordContentChange(client, {
  contentType, contentKey, contentVersion = "1.0.0", changeKind,
  oldValue = null, newValue = null, changedBy = null, note = null,
}) {
  const q = client?.query ? client.query.bind(client) : query;
  await q(
    `INSERT INTO content_versions
       (content_type, content_key, content_version, change_kind, old_value, new_value, changed_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      contentType, contentKey, contentVersion, changeKind,
      oldValue === null ? null : JSON.stringify(oldValue),
      newValue === null ? null : JSON.stringify(newValue),
      changedBy, note,
    ]
  );
}
