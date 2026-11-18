/* ============================================================
   كتالوج التكاملات — KANAF-ORD-0008 §7

   صفحة اعتمادات ≠ تكامل. هذا الكتالوج يحدد ما يُحفظ وكيف يُفحص
   الاتصال مرة واحدة، ولا شيء أكثر. لا خدمة هنا يقرؤها مسار تشغيلي:
   ميسر يعمل اليوم من متغيرات البيئة كما كان، وحفظ مفاتيحه هنا لا يغيّر
   ذلك. ربط أي خدمة فعلياً أمر مستقل — وتمارا خصوصاً بوابة دفع.

   أسماء المفاتيح قياسية بحسب توثيق كل مزوّد، لا من «الأكاديمية»
   (مستودعها غير متاح؛ مطابقتها تحتاج وصولاً — §7.5).

   test: فحص اتصال للقراءة فقط بمسار موثَّق نعرفه يقيناً. حيث لا نعرفه
   يقيناً تُرك null وسُجِّل — لا نخمّن مسار API لمزوّد.
   ============================================================ */

export const INTEGRATIONS = {
  mailgun: {
    label: "البريد — Mailgun",
    fields: { api_key: "مفتاح API الخاص (Private API key)", domain: "النطاق المُرسِل (Sending domain)", region: "المنطقة: us أو eu" },
    test: "mailgun_domain",
  },
  sms: {
    label: "رسائل SMS",
    fields: { provider: "اسم المزوّد", api_key: "مفتاح API", sender_name: "اسم المرسل المعتمد" },
    test: null, // المزوّد لم يُحدَّد بعد — لا فحص قبل معرفته
  },
  whatsapp: {
    label: "واتساب — WhatsApp Cloud API",
    fields: { access_token: "رمز الوصول (Access token)", phone_number_id: "معرّف رقم الهاتف (Phone number ID)", business_account_id: "معرّف حساب الأعمال (WABA ID)" },
    test: "whatsapp_phone_number",
  },
  qoyod: {
    label: "المحاسبة — قيود",
    fields: { api_key: "مفتاح API" },
    test: null, // يحتاج توثيق قيود الرسمي — لم يُتحقَّق منه في هذا الأمر
  },
  moyasar: {
    label: "الدفع — ميسر (قائم من متغيرات البيئة)",
    fields: { secret_key: "المفتاح السري (sk_…)", publishable_key: "المفتاح العام (pk_…)" },
    test: "moyasar_payments",
  },
  tamara: {
    label: "التقسيط — تمارا",
    fields: { api_token: "رمز API", notification_key: "مفتاح الإشعارات", environment: "البيئة: sandbox أو production" },
    test: null, // بوابة دفع: الربط والفحص أمر مستقل (§7.2)
  },
};

/** الاسم الكامل الفريد للمفتاح عبر النظام: <service>_<key> — يُقارن بأسماء app_settings (§7.4). */
export const fullKeyName = (service, key) => `${service}_${key}`;
export function allFullKeyNames() {
  return Object.entries(INTEGRATIONS).flatMap(([s, d]) => Object.keys(d.fields).map((k) => fullKeyName(s, k)));
}
export const isKnownField = (service, key) => Boolean(INTEGRATIONS[service]?.fields?.[key]);
