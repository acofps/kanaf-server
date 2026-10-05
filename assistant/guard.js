import { query } from "../db/pool.js";
import { getUserSubscription } from "../billing/subscription.js";

/* ============================================================
   حماية مسارَي النموذج (/api/chat و /api/plan) — KANAF-ORD-0001 R15-04 · X08

   ثلاث طبقات، كلها **بعد** جدار الأمان (crisisFirewall) وبعد
   requireVerifiedUser، فمسار الأمان العام لا يمرّ بأي منها:

   1) سياسة الوصول — app_settings.assistant_access_policy:
        "all_verified"  أي حساب موثّق (سلوك الإنتاج الحالي — الافتراضي)
        "plus_only"     مشترك كنف+ مستحق فقط (حالة الاشتراك المشتقة)
      اختيار القيمة قرار تجاري للمالك (D-02). الكود لا يغيّر السلوك
      الحالي حتى يُغيَّر الإعداد من اللوحة بسبب مكتوب.

   2) حماية الكلفة لكل مستخدم (لا لكل عنوان IP — المسار مستثنى من حد
      الطلبات العام عمداً كي لا يُحجب مسار الأمان):
        • طلب واحد قيد التنفيذ لكل مستخدم (409).
        • سقف طلبات لكل مستخدم في نافذة 15 دقيقة (429).
      القيم من متغيرات البيئة، والافتراضي اقتراح قابل للمراجعة.
      والسقوف واسعة عمداً: نسخة التطبيق المنشورة ترسل سياقاً (آخر يومية
      + كل نتائج الاستبيانات) ولا تقصّ تاريخ المحادثة، فسقف ضيق كان
      سيكسر سند لمستخدم قديم قبل نشر التطبيق الجديد الذي يقصّ.
      حدّها الصادق: ذاكرة نسخة خادم واحدة.

   3) شكل المحادثة (للمحادثة وحدها): أدوار user/assistant فقط، نص فقط،
      سقف لعدد الرسائل وطولها والمجموع، وآخر رسالة من المستخدم.
      بدونه كان العميل يرسل أي تاريخ بأي حجم حتى 200KB في كل نداء.
   ============================================================ */

const WINDOW_MS = 15 * 60 * 1000;
export const LIMITS = {
  chatPerWindow: Number(process.env.CHAT_MAX_PER_15MIN || 40),
  planPerWindow: Number(process.env.PLAN_MAX_PER_15MIN || 6),
  maxMessages: Number(process.env.CHAT_MAX_MESSAGES || 80),
  maxMessageChars: Number(process.env.CHAT_MAX_MESSAGE_CHARS || 8000),
  maxTotalChars: Number(process.env.CHAT_MAX_TOTAL_CHARS || 32000),
};

export const ASSISTANT_POLICIES = ["all_verified", "plus_only"];

export async function getAssistantPolicy() {
  try {
    const { rows } = await query(`SELECT value FROM app_settings WHERE key = 'assistant_access_policy'`);
    const v = rows[0]?.value;
    return ASSISTANT_POLICIES.includes(v) ? v : "all_verified";
  } catch {
    // تعذّر القراءة لا يجوز أن يقطع خدمة قائمة: يُطبَّق السلوك الحالي.
    return "all_verified";
  }
}

const windows = new Map();   // `${kind}:${userId}` → [timestamps]
const inFlight = new Set();  // `${kind}:${userId}`

function takeSlot(key, max) {
  const now = Date.now();
  const list = (windows.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= max) { windows.set(key, list); return Math.ceil((WINDOW_MS - (now - list[0])) / 1000); }
  list.push(now); windows.set(key, list);
  return 0;
}

export function validateChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "messages_required";
  if (messages.length > LIMITS.maxMessages) return "too_many_messages";
  let total = 0;
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return "invalid_role";
    if (typeof m.content !== "string" || !m.content.trim()) return "invalid_content";
    if (m.content.length > LIMITS.maxMessageChars) return "message_too_long";
    total += m.content.length;
  }
  if (total > LIMITS.maxTotalChars) return "conversation_too_long";
  if (messages[messages.length - 1].role !== "user") return "last_message_must_be_user";
  return null;
}

/** وسيط: kind = "chat" | "plan". يُركَّب بعد requireVerifiedUser. */
export function assistantGate(kind) {
  const perWindow = kind === "chat" ? LIMITS.chatPerWindow : LIMITS.planPerWindow;
  return async (req, res, next) => {
    try {
      if (kind === "chat") {
        const err = validateChatMessages(req.body?.messages);
        if (err) return res.status(400).json({ error: err });
      }
      if ((await getAssistantPolicy()) === "plus_only") {
        const sub = await getUserSubscription(req.userId);
        if (!sub?.entitled) return res.status(402).json({ error: "subscription_required" });
      }
      const key = `${kind}:${req.userId}`;
      // الخطة لها حارسها القائم في index.js (planInFlight → plan_generation_in_progress)
      // والتطبيق المنشور يعرف رمزه؛ فالحارس هنا للمحادثة وحدها.
      if (kind === "chat" && inFlight.has(key)) return res.status(409).json({ error: "chat_in_progress" });
      const wait = takeSlot(key, perWindow);
      if (wait) { res.setHeader("Retry-After", String(wait)); return res.status(429).json({ error: "assistant_rate_limited", retryAfterSeconds: wait }); }
      if (kind !== "chat") return next();
      inFlight.add(key);
      let released = false;
      const release = () => { if (!released) { released = true; inFlight.delete(key); } };
      res.on("finish", release);
      res.on("close", release);
      next();
    } catch (err) {
      console.error(`[assistant/${kind}]`, err.message);
      res.status(500).json({ error: "internal_error" });
    }
  };
}
