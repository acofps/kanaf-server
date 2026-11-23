import crypto from "node:crypto";
import { query } from "../db/pool.js";

/* ============================================================
   سجلّ أخطاء النظام — KANAF-ORD-0013 §11

   🔴 11.1 التنقية قبل التخزين، لا عند العرض. رسالة الخطأ تحمل أحياناً محتوى
   المستخدم: نصاً أرسله، أو قيمة حقل («Key (email)=(x@y) already exists»)، أو
   سلسلة اتصال. سجلّ غير منقّى منفذٌ خلفيّ لكل ما أُغلق في الواجهة. فيُزال:
     • سلاسل الاتصال (postgres://…) وأي user:pass@host
     • البريد والجوال وأرقام الهوية الطويلة
     • الرموز والأسرار: JWT، وBearer، وsk_/pk_، وأي سلسلة hex/base64 طويلة
     • كل قيمة بين علامتي تنصيص أو بين أقواس بعد «=» — هناك يضع Postgres
       والمكتبات قيمة المستخدم.
     • عناوين IP
   11.2 المتكرر صفّ واحد (fingerprint) بعدّاد وأول/آخر ظهور، وسقف للصفوف
        ودورة تنظيف بالعمر.
   11.5 لا يُسقط الطلب أبداً: recordError لا يرمي، ولا يُنتظر في مسار الطلب.
        إن فشلت الكتابة يكفي السجل النصّي (console) ويمضي الطلب.
   ============================================================ */

export const ERROR_LOG_MAX_ROWS = 2000;
export const ERROR_LOG_RETENTION_DAYS = 30;

const RULES = [
  [/\b(postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp):\/\/\S+/gi, "[connection-string]"],
  [/\b[\w.+-]+:[^\s@/]+@[\w.-]+(:\d+)?/g, "[credentials@host]"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, "[jwt]"],
  [/\bBearer\s+[\w.~+/=-]+/gi, "Bearer [token]"],
  [/\b(sk|pk|rk)_(live|test)_[\w]+/gi, "[api-key]"],
  [/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, "[email]"],
  [/"(?:[^"\\]|\\.)*"/g, '"[…]"'],
  [/'(?:[^'\\]|\\.)*'/g, "'[…]'"],
  [/=\((?:[^()]|\([^()]*\))*\)/g, "=([…])"],
  [/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "[ip]"],
  [/\+?\b\d[\d\s-]{7,}\d\b/g, "[number]"],
  /* KANAF-ORD-0014 §2.6: رمز تحقق أو استعادة (4–8 أرقام مستقلة) كان يمرّ — القاعدة السابقة تبدأ من 9.
     ما يتبع «:» يبقى (موضع السطر والعمود في مسار الاستدعاء: routes.js:1146:12). */
  [/(?<![:\w.\/-])\d{4,8}(?![\w:])/g, "[number]"],
  /* ونصّ المستخدم في هذا التطبيق عربي: كان يُحذف مقتبساً فقط، ويمرّ إن جاء بلا علامتي تنصيص. */
  [/[\u0600-\u06FF]+(?:[\s\u060C\u061B\u061F.!—-]+[\u0600-\u06FF]+)*/g, "[نص]"],
  [/\b[A-Fa-f0-9]{24,}\b/g, "[hex]"],
  /* بلا «/»: مسار ملف طويل (/opt/render/project/src/admin/routes.js) كان يُبتلع كله «[secret]»
     فيفقد مسار الاستدعاء أسماء ملفاته. الرموز ذات الشكل المعروف (JWT، sk_…، Bearer) لها قواعدها أعلاه. */
  [/\b[A-Za-z0-9+_-]{32,}={0,2}/g, "[secret]"],
];

/** تنقية نصّ خطأ — مُصدَّرة ليختبرها test-39 مباشرةً. */
export function sanitizeErrorText(text, max = 500) {
  let s = String(text ?? "");
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s.slice(0, max);
}

/** المسار بلا معرّفات: /admin/users/<uuid> → /admin/users/:id — لا معرّف عميل في السجل. */
export function normalizeLocation(loc) {
  return String(loc || "unknown")
    .split("?")[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:n")
    .slice(0, 200);
}

let lastCleanup = 0;
async function cleanupIfDue() {
  if (Date.now() - lastCleanup < 10 * 60 * 1000) return;
  lastCleanup = Date.now();
  await query(`DELETE FROM system_errors WHERE last_seen < now() - make_interval(days => $1)`, [ERROR_LOG_RETENTION_DAYS]);
  await query(
    `DELETE FROM system_errors WHERE id IN (
       SELECT id FROM system_errors ORDER BY last_seen DESC OFFSET $1)`, [ERROR_LOG_MAX_ROWS]);
}

/** يسجّل الخطأ منقّى. لا يرمي ولا يُسقط شيئاً — ويعيد Promise يُتجاهل عادةً. */
export function recordError(err, { location, status = null } = {}) {
  return (async () => {
    try {
      // رمز الخطأ (23505، ECONNREFUSED، TypeError) تشخيص لا بيانات: يبقى كما هو إن كان بهذا الشكل وحده.
      // code الرقمي ليس رمزاً (DOMException.code لانتهاء المهلة = 23): الاسم أوضح — KANAF-ORD-0015.
      const rawKind = String((typeof err?.code === "string" && err.code) || err?.name || "Error");
      const kind = /^[A-Za-z0-9_]{1,40}$/.test(rawKind) ? rawKind : sanitizeErrorText(rawKind, 60);
      const message = sanitizeErrorText(err?.message || err, 500);
      const stack = err?.stack ? sanitizeErrorText(String(err.stack).split("\n").slice(1, 15).join("\n"), 4000) : null;
      const where = normalizeLocation(location);
      // البصمة بلا أرقام: «timeout after 5012ms» و«after 5013ms» خطأ واحد.
      const fingerprint = crypto.createHash("sha256").update(`${kind}|${where}|${message.replace(/\d+/g, "#")}`).digest("hex");
      await query(
        `INSERT INTO system_errors (fingerprint, kind, message, stack, location, http_status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (fingerprint) DO UPDATE SET count = system_errors.count + 1, last_seen = now(),
           stack = COALESCE(EXCLUDED.stack, system_errors.stack), http_status = EXCLUDED.http_status`,
        [fingerprint, kind, message, stack, where, status]);
      await cleanupIfDue();
    } catch (e) {
      // 11.5: أداة التشخيص لا تكون سبب عطل — السجل النصّي يكفي هنا.
      console.error("[error-log] تعذّر تسجيل الخطأ في القاعدة:", e?.code || e?.message);
    }
  })();
}

/** للاختبار: إعادة ضبط مؤقّت التنظيف. */
export function _resetCleanupTimer() { lastCleanup = 0; }
