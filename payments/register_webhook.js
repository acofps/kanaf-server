// يُشغَّل مرة واحدة لكل بيئة (مفتاح الاختبار، ثم مرة أخرى بعد
// التحويل لمفتاح الإنتاج) — يسجّل عنوان الـwebhook لدى Moyasar.
//
//   node payments/register_webhook.js https://yourdomain.com/api/payments/webhook
//
// PAYMENT_SECRET_KEY و PAYMENT_WEBHOOK_SECRET لازم يكونان مضبوطين في
// .env — السكربت يستخدم PAYMENT_WEBHOOK_SECRET كـshared_secret الذي
// يضمّنه Moyasar في كل حمولة، وهو نفسه ما يقارنه isGenuineWebhook.
//
// ⚠️ تصحيح جوهري في هذه النسخة:
// النسخة السابقة كانت تسجّل حدثين فقط — payment_paid و
// payment_failed — بينما معالج الـwebhook يحتوي فرعاً كاملاً
// لـpayment_refunded. أي أن استرداداً يتم من لوحة Moyasar نفسها ما
// كان ليصل الخادم إطلاقاً: العميل يستلم ماله، والاشتراك يبقى فعّالاً
// عندنا، ولا يصدر إشعار دائن. عطل صامت تماماً، ومصدره سطر واحد في
// سكربت إعداد لا في منطق العمل.
import "dotenv/config";
import { createWebhook, fetchAvailableWebhookEvents, HANDLED_WEBHOOK_EVENTS } from "./moyasar.js";

const url = process.argv[2];
if (!url || !url.startsWith("https://")) {
  console.error("Usage: node payments/register_webhook.js https://yourdomain.com/api/payments/webhook");
  console.error("العنوان لازم يكون HTTPS — Moyasar ما يسلّم webhooks لعنوان http في وضع الإنتاج.");
  process.exit(1);
}
if (!process.env.PAYMENT_WEBHOOK_SECRET) {
  console.error("اضبط PAYMENT_WEBHOOK_SECRET في .env أولاً — ولّده بـ: openssl rand -hex 24");
  process.exit(1);
}

// نتقاطع مع ما يدعمه المزوّد فعلاً بدل تخمين أسماء الأحداث. لو
// المسار غير متاح نمضي بالقائمة كما هي وندع Moyasar يرفض ما لا
// يعرفه — الأهم ألا نسجّل بصمت أقل مما نعالج.
const available = await fetchAvailableWebhookEvents();
const events = available
  ? HANDLED_WEBHOOK_EVENTS.filter((e) => available.includes(e))
  : [...HANDLED_WEBHOOK_EVENTS];

const missing = HANDLED_WEBHOOK_EVENTS.filter((e) => !events.includes(e));
if (available && missing.length) {
  console.warn(
    `تنبيه: هذي الأحداث يعالجها الخادم لكن المزوّد ما يعلنها كمدعومة: ${missing.join(", ")}.\n` +
    `راجع لوحة Moyasar — ومعالجها عندنا يبقى موجوداً بلا ضرر، لكنه لن يُستدعى.`
  );
}

const webhook = await createWebhook({
  url,
  sharedSecret: process.env.PAYMENT_WEBHOOK_SECRET,
  events,
});

console.log("تم تسجيل الـwebhook:", webhook);
console.log("الأحداث المسجَّلة:", events.join(", "));
console.log("\nتأكّد من هذا في لوحة Moyasar تحت Developers → Webhooks.");
console.log("وبعدها افتح صفحة «سجل أحداث الدفع» في لوحة كنف — أول حدث حقيقي لازم يظهر فيها.");
