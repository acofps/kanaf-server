/* ============================================================
   هوية اللوحة البصرية — «تنفس بحرية».

   الألوان كلها رموز CSS معرَّفة في index.css: الوضع الفاتح أولاً
   (الافتراضي)، ثم الداكن. هنا مراجع إليها فقط — `C.text` يساوي
   "var(--text)" — فكل صفحة تقرأ من C تتبدّل مع الوضع دون أن تُمسّ.
   (KANAF-ORD-0008 §2.3)

   أسماء المفاتيح (teal وغيرها) معرّفات تقرؤها الصفحات، فبقيت كما
   هي: teal = لون العلامة النشط (brand-600 فاتحاً، brand-300 داكناً).

   الذهبي لشارة «تنفس+» وحدها، ولا يظهر في شارة حالة أبداً.
   ============================================================ */
export const C = {
  bg: "var(--bg)",
  surface: "var(--surface)",
  surfaceAlt: "var(--surface-alt)",
  line: "var(--line)",
  lineSoft: "var(--line-soft)",
  text: "var(--text)",
  textMuted: "var(--text-muted)",
  textFaint: "var(--text-faint)",
  teal: "var(--accent)",
  tealSoft: "var(--accent-soft)",
  onAccent: "var(--on-accent)",
  gold: "var(--gold-text)",
  goldSoft: "var(--gold-soft)",
  goldLine: "var(--gold-line)",
  amber: "var(--amber)",
  amberSoft: "var(--amber-soft)",
  crisis: "var(--crisis)",
  crisisSoft: "var(--crisis-soft)",
  crisisSignal: "var(--crisis-signal)",
  crisisSignalSoft: "var(--crisis-soft)",
  green: "var(--green)",
  greenSoft: "var(--green-soft)",
  overlay: "var(--overlay)",
};

/* ------------------------------------------------------------
   لون كل قسم — إشارة تموضع لا زينة (KANAF-ORD-0008 §2.5).
   القيم في index.css (--sec-*) مقيسة: الأيقونة ≥ 4.5:1 على خلفية
   مربّعها وعلى السطح، في الوضعين. التعبئة نسبة من اللون نفسه.
   ------------------------------------------------------------ */
export function sectionTone(key) {
  const fg = `var(--sec-${key}, var(--accent))`;
  return { fg, soft: `color-mix(in srgb, ${fg} var(--sec-tint), transparent)` };
}

/* ------------------------------------------------------------
   الوضع الفاتح/الداكن — اختيار المسؤول في متصفّحه وحده.
   التخزين المحلي قد يكون محجوباً (تصفّح خاص)؛ عندها يبقى الفاتح.
   ------------------------------------------------------------ */
const THEME_KEY = "tanaffus-admin-theme";
export function readTheme() {
  try { return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"; } catch { return "light"; }
}
export function applyTheme(mode) {
  const m = mode === "dark" ? "dark" : "light";
  if (m === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", m === "dark" ? "#1A1223" : "#FFFFFF");
  try { localStorage.setItem(THEME_KEY, m); } catch { /* لا تخزين — يبقى للجلسة */ }
  return m;
}

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
  cbt_tool: "أداة تنفس بحرية",
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
  abandoned_carts: "أصحاب سلات متروكة",
  inactive: "مَن لم يدخل منذ مدة",
};

export const CHANNEL_LABEL = { in_app: "داخل التطبيق", email: "بريد", push: "إشعار جهاز", whatsapp: "واتساب", sms: "رسالة نصية" };

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
  /* KANAF-ORD-0015 §2.6.4: سنة/شهر/يوم بأرقام لاتينية **بلا علامات اتجاه**. نصّ ar-SA يحمل علامات
     RLM فكان التاريخ يتبعثر («252026/11/») في أي خلية اتجاهها ltr؛ وهذا الشكل يُقرأ هو نفسه
     في الاتجاهين، وهو ما كان يظهر أصلاً في الخلايا العربية. */
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "—";
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}/${p.month}/${p.day}`;
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
