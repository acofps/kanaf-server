// Moyasar integration. Verified against Moyasar's own current docs
// before writing this (docs.moyasar.com) rather than assumed —
// two details that are easy to get wrong from memory/generic
// payment-gateway patterns:
//
// 1. Auth is HTTP Basic with the secret key as the username and an
//    EMPTY password (`-u sk_xxx:`) — not a Bearer token.
// 2. Webhook verification is NOT an HMAC signature header. Moyasar
//    embeds a `secret_token` field directly in the webhook's JSON
//    body, which you compare against the `shared_secret` you set
//    when registering the webhook. A generic "compute HMAC-SHA256 of
//    the raw body" implementation (the default assumption for most
//    payment gateways) would NOT work here and would silently accept
//    forged webhooks if built that way.

const MOYASAR_API_BASE = "https://api.moyasar.com/v1";

function authHeader() {
  const key = process.env.PAYMENT_SECRET_KEY;
  if (!key) throw new Error("PAYMENT_SECRET_KEY is not set");
  // HTTP Basic auth: "secret_key:" (empty password), base64-encoded.
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

async function moyasarRequest(path, { method = "GET", body } = {}) {
  const res = await fetch(`${MOYASAR_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || `Moyasar request failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

/**
 * Creates a hosted-checkout invoice. The `url` in the response is
 * where you redirect the payer — Moyasar hosts the actual card form,
 * so this app never sees a card number, which keeps it out of
 * PCI-DSS scope entirely (the alternative — embedding Moyasar's card
 * widget yourself — still avoids raw PAN handling but is more surface
 * area to get right; the hosted page is the simpler, safer default
 * for a first integration).
 *
 * amountSar: a plain number of Saudi Riyals (e.g. 29.00) — this
 * function does the halala conversion (SAR × 100) so callers never
 * have to remember Moyasar wants the smallest currency unit.
 */
export async function createInvoice({ amountSar, description, callbackUrl, successUrl, backUrl, expiresAt, currency = "SAR", metadata }) {
  const amountHalalas = Math.round(amountSar * 100);
  return moyasarRequest("/invoices", {
    method: "POST",
    body: {
      amount: amountHalalas,
      // العملة تأتي من الإعداد المركزي (billing_settings) بدل نص
      // ثابت هنا — القيمة الافتراضية مطابقة للسلوك السابق.
      currency,
      ...(metadata ? { metadata } : {}),
      description,
      callback_url: callbackUrl,
      success_url: successUrl,
      back_url: backUrl,
      ...(expiresAt ? { expired_at: expiresAt } : {}),
    },
  });
}

export async function fetchInvoice(invoiceId) {
  return moyasarRequest(`/invoices/${invoiceId}`);
}

/**
 * يقرأ حالة دفعة واحدة من المزوّد مباشرة.
 *
 * هذه هي "الحقيقة النهائية" حين تختلف قاعدتنا مع المزوّد: تُستخدم
 * في مسار التسوية اليدوية من اللوحة، وفي إعادة تشغيل حدث webhook
 * فشلت معالجته، بدل الاعتماد على حمولة قديمة قد تكون تجاوزها
 * الواقع.
 */
export async function fetchPayment(paymentId) {
  return moyasarRequest(`/payments/${paymentId}`);
}

/**
 * استرداد حقيقي عبر المزوّد — كامل أو جزئي.
 *
 * هذه الدالة هي ما كان ناقصاً فعلياً: مسار الاسترداد الإداري كان
 * يعلّم الفاتورة "مستردة" ويصدر إشعاراً دائناً **دون أن ينادي
 * Moyasar إطلاقاً**. النتيجة دفاتر تقول إن المبلغ رُدّ، وحساب بنكي
 * لم يغادره ريال. أسوأ من عطل ظاهر لأنه يبدو ناجحاً.
 *
 * `amountSar` اختياري: تركه فارغاً يعني استرداداً كاملاً — وهذا
 * سلوك Moyasar الافتراضي، لا افتراض من عندنا. تمريره يحوّل العملية
 * إلى استرداد جزئي، والتحويل إلى الهللات يتم هنا مرة واحدة حتى لا
 * يتكرر في كل مُنادٍ.
 */
export async function refundPayment(paymentId, amountSar) {
  const body = {};
  if (amountSar !== undefined && amountSar !== null) {
    const halalas = Math.round(Number(amountSar) * 100);
    if (!Number.isFinite(halalas) || halalas <= 0) {
      throw new Error(`refundPayment: مبلغ استرداد غير صالح (${amountSar})`);
    }
    body.amount = halalas;
  }
  return moyasarRequest(`/payments/${paymentId}/refund`, { method: "POST", body });
}

/**
 * قائمة الأحداث التي يدعمها المزوّد فعلاً.
 *
 * موجودة لأن سكربت تسجيل الـwebhook كان يسجّل حدثين فقط
 * (payment_paid و payment_failed) بينما الكود يعالج
 * payment_refunded — أي أن معالج الاسترداد لم يكن ليُستدعى أبداً في
 * الإنتاج مهما كان صحيحاً. يُستدعى هذا المسار قبل التسجيل لتقاطع
 * ما نريده مع ما هو مدعوم فعلاً، بدل تخمين الأسماء.
 *
 * يعيد null لو لم يكن المسار متاحاً — والمُنادي يتراجع عندها إلى
 * القائمة المطلوبة كما هي بدل أن يفشل.
 */
export async function fetchAvailableWebhookEvents() {
  try {
    const data = await moyasarRequest("/webhooks/available_events");
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.events)) return data.events;
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * الأحداث التي يعالجها هذا الخادم فعلياً. أي حدث خارج هذه القائمة
 * يُسجَّل ويُتجاهل بوعي، لا يُسقط بصمت.
 */
export const HANDLED_WEBHOOK_EVENTS = Object.freeze([
  "payment_paid",
  "payment_failed",
  "payment_refunded",
  "payment_voided",
]);

/**
 * Registers a real Moyasar webhook against your account. Run this
 * ONCE per environment (test/live), not on every server start — see
 * payments/README.md for the one-time setup command. Exported here
 * so the setup script can reuse the same authenticated request logic.
 */
export async function createWebhook({ url, sharedSecret, events }) {
  return moyasarRequest("/webhooks", {
    method: "POST",
    body: { http_method: "post", url, shared_secret: sharedSecret, events },
  });
}

/**
 * Verifies an incoming webhook is genuinely from Moyasar. Per their
 * actual mechanism, this is a direct comparison of the `secret_token`
 * field embedded in the webhook body against the shared secret you
 * configured — NOT a cryptographic signature. Still use a
 * constant-time comparison to avoid leaking timing information about
 * how much of the secret matched, same discipline as if it were HMAC.
 */
export function isGenuineWebhook(webhookBody) {
  const expected = process.env.PAYMENT_WEBHOOK_SECRET || "";
  const received = webhookBody?.secret_token || "";
  if (!expected || !received) return false;
  return timingSafeEqualStrings(expected, received);
}

function timingSafeEqualStrings(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
