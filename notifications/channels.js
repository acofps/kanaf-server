import { query } from "../db/pool.js";
import { isConfigured as isMailConfigured } from "../mail/send.js";
import { isPushConfigured } from "./push.js";
import { encryptionConfigured, decryptSecret } from "../integrations/crypto.js";

/* ============================================================
   توفّر قنوات الإرسال — KANAF-ORD-0013 §4.4 و§9.5

   🔴 قناة بلا اعتمادها لا تُعرض متاحة، ولا تُقبل في حملة ثم تفشل بصمت
   (عطب مكرّر في تاريخ هذا المشروع). كل قناة: { ok, reason } بسبب عربي
   صريح يُعرض كما هو في اللوحة.

   • in_app: كتابة في قاعدتنا — متاحة دائماً.
   • email: إعداد SMTP على الخادم (SMTP_HOST/USER/PASS).
   • push: مفتاحا VAPID.
   • whatsapp: اعتمادا WhatsApp Cloud API من «التكاملات» (رمز الوصول ومعرّف الرقم).
   • sms: مزوّد الرسائل النصية لم يُحدَّد (ORD-0008 §7) — لا إرسال قبل معرفته،
     ولو حُفظت مفاتيح: لا نخمّن مسار API لمزوّد غير معروف.
   ============================================================ */

export const CHANNEL_KEYS = ["in_app", "email", "push", "sms", "whatsapp"];

/** قيم التكامل مفكوكة — للاستعمال داخل الخادم فقط، لا تُعاد في أي ردّ. */
export async function integrationValues(service) {
  if (!encryptionConfigured()) return {};
  const { rows } = await query(`SELECT key_name, ciphertext, iv, auth_tag FROM integration_credentials WHERE service = $1`, [service]);
  const out = {};
  for (const r of rows) { try { out[r.key_name] = decryptSecret(r); } catch { /* مفتاح تشفير تغيّر: كأنه غير مضبوط */ } }
  return out;
}

export async function channelAvailability() {
  const wa = await integrationValues("whatsapp").catch(() => ({}));
  return {
    in_app: { ok: true },
    email: isMailConfigured() ? { ok: true } : { ok: false, reason: "البريد غير مضبوط على الخادم (SMTP)." },
    push: isPushConfigured() ? { ok: true } : { ok: false, reason: "الإشعار على الجهاز غير مضبوط (مفتاحا VAPID)." },
    whatsapp: wa.access_token && wa.phone_number_id ? { ok: true }
      : { ok: false, reason: "تكامل واتساب غير مضبوط — أضف رمز الوصول ومعرّف الرقم من «التكاملات»." },
    sms: { ok: false, reason: "تكامل الرسائل النصية غير مضبوط — مزوّد SMS لم يُحدَّد بعد." },
  };
}

/** يرفض أي قناة غير متاحة بسببها — قبل إنشاء الحملة لا بعد فشلها. */
export async function unavailableChannels(chans) {
  const av = await channelAvailability();
  return chans.filter((c) => !av[c]?.ok).map((c) => ({ channel: c, reason: av[c]?.reason || "قناة غير معروفة" }));
}
