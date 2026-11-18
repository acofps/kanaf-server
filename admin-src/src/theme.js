/* ============================================================
   هوية اللوحة البصرية — «تنفس» (كنف سابقاً).

   اللوحة وضع واحد داكن، فالقيم هنا قيم الوضع الليلي في
   KANAF-ORD-0005 §5، المبني على عمق لون الشعار #8D79A3.
   أسماء المفاتيح (teal وغيرها) معرّفات تقرؤها الصفحات، فبقيت كما
   هي، وتغيّرت قيمها فقط: teal هو لون العلامة على الداكن (brand-300).

   الذهبي (gold-300 على الداكن، §4.5) لشارة «تنفس+» وحدها، ولا يظهر
   في شارة حالة أبداً. الشارات الدلالية تبقى amber/crisis/green.
   ============================================================ */
export const C = {
  bg: "#1A1223",
  surface: "#241A2F",
  surfaceAlt: "#2E2340",
  line: "#3A2D4D",
  text: "#EFE9F5",
  textMuted: "#B6A8C6",
  textFaint: "#857699",
  teal: "#C1AED5",
  tealSoft: "rgba(193,174,213,0.16)",
  gold: "#EACD86",
  goldSoft: "rgba(234,205,134,0.14)",
  amber: "#D9A441",
  amberSoft: "rgba(217,164,65,0.14)",
  crisis: "#E2574C",
  crisisSoft: "rgba(226,87,76,0.14)",
  green: "#4CAF7D",
  greenSoft: "rgba(76,175,125,0.14)",
};

export const ROLE_LABEL = {
  support: "دعم فني",
  content_manager: "مدير محتوى",
  accountant: "محاسب",
  admin: "مدير",
  owner: "مالك",
};

export const ROLE_HINT = {
  support: "يرى الحسابات والرسائل وحالة الاشتراك، ولا يغيّر شيئاً مالياً ولا يرى بيانات نفسية.",
  content_manager: "المحتوى وعرضه فقط.",
  accountant: "يقرأ الدفاتر كاملة، ولا يرى بيانات نفسية ولا يحرّك مالاً.",
  admin: "التشغيل اليومي عدا ما يخصّ المالك.",
  owner: "كل شيء.",
};

/* ============================================================
   ⚠️ لا جدول رتب في هذا الملف بعد اليوم.

   كان هنا:  const RANK = { support: 1, content_manager: 2, ... }
   ودالة atLeast(role, min) تقارن رقمين.

   وهو نسخة ثانية من نموذج الخادم، ونسختان تختلفان يوماً ما. وقد
   اختلفتا فعلاً: الرتبة كانت تعطي مدير المحتوى وصولاً لكل ما هو
   عند «دعم» — بما فيه صفحة الباقات — لأن رقمه أكبر.

   الآن اللوحة **لا تعرف** الأدوار إطلاقاً. تستقبل قائمة صلاحيات
   جاهزة من GET /admin/auth/me وترسم منها. مصدر واحد في
   admin/permissions.js، ولا شيء هنا يمكن أن يخالفه.

   ويبقى الأصل: هذا كله إخفاء لراحة العين. المنع في الخادم، وكل
   مسار يفحص بنفسه ويردّ 403 لمن كتب العنوان يدوياً.
   ============================================================ */

/** هل يملك المسؤول هذه الصلاحية؟ `me` من /admin/auth/me. */
export function can(me, permission) {
  return Array.isArray(me?.permissions) && me.permissions.includes(permission);
}

/** هل يملك أياً من هذه الصلاحيات؟ */
export function canAny(me, permissions) {
  return permissions.some((p) => can(me, p));
}

export const CONTENT_TYPE_LABEL = {
  journey: "رحلة",
  overlay: "نسخة سياقية",
  notebook: "دفتر",
  cbt_tool: "أداة تنفس",
  library_article: "مقالة مكتبة",
};

export const REVIEW_LABEL = {
  review_required: "قيد المراجعة",
  approved: "معتمد",
  rejected: "مرفوض",
  retired: "متقاعد",
};

export const AUDIENCE_LABEL = {
  all: "كل المستخدمين",
  active_subscribers: "المشتركون النشطون",
  trial_or_free: "غير المشتركين",
  selected_users: "مستخدمون محددون",
  account_status: "حسب حالة الحساب",
};

export const CHANNEL_LABEL = { in_app: "داخل التطبيق", email: "بريد", push: "إشعار جهاز" };

/* حالات الحملة — الألوان تعكس المعنى لا الشكل:
   partially_failed كهرماني لا أخضر، لأن من يقرأ "تم" لن يفتح
   التفاصيل ليكتشف أن جزءاً لم يصل. */
export const CAMPAIGN_STATUS = {
  draft: { label: "مسودة", color: "textMuted" },
  scheduled: { label: "مجدولة", color: "teal" },
  sending: { label: "جارٍ الإرسال", color: "amber" },
  sent: { label: "أُرسلت", color: "green" },
  partially_failed: { label: "نجاح جزئي", color: "amber" },
  failed: { label: "فشلت", color: "crisis" },
  canceled: { label: "ملغاة", color: "textFaint" },
};

export const DELIVERY_STATUS = {
  queued: { label: "بالانتظار", color: "textMuted" },
  processing: { label: "جارٍ", color: "amber" },
  sent: { label: "أُرسل", color: "green" },
  delivered: { label: "وصل", color: "green" },
  failed: { label: "فشل", color: "crisis" },
  skipped: { label: "متجاوَز", color: "textFaint" },
};

/* التواريخ ميلادية بأرقام لاتينية — الوثيقة الضريبية تحمل تاريخها
   الميلادي، وعرض هجري بجانبها يجعلهما يقولان يومين. */
export function fmtDate(v) {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", {
      year: "numeric", month: "2-digit", day: "2-digit",
    });
  } catch { return "—"; }
}

export function fmtDateTime(v) {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString("ar-SA-u-ca-gregory-nu-latn", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}

/** ISO بإزاحة صريحة — الخادم يقارن بـnow() في UTC، وتخزين وقت
    محلي بلا إزاحة ينشر في ساعة خاطئة. */
export function toIsoWithOffset(localValue) {
  if (!localValue) return null;
  const d = new Date(localValue);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** قيمة لحقل datetime-local من طابع ISO. */
export function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
