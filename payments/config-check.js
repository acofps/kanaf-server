/* ============================================================
   فحص إعداد الدفع — KANAF-ORD-0015 §2.2

   زرّ الاشتراك كان «يحمّل ثم يتوقّف» والسبب لا يُرى: المسار يبتلع عطبه.
   ثلاثة أسباب ممكنة من الكود نفسه، اثنان منها إعداد على Render:
     • PAYMENT_SECRET_KEY غائب → لا يُنادى المزوّد أصلاً.
     • SERVER_BASE_URL غائب أو ليس https عاماً → رابط الإشعار (callback) يشير إلى
       localhost: يدفع العضو ولا يصل الحدث، فلا يُفعَّل اشتراكه — دفعٌ بلا دخول.
     • APP_BASE_URL غائب أو localhost → صفحة العودة بعد الدفع تُفتح على جهاز العضو نفسه.
   في الإنتاج تمنع هذه الثلاثة إنشاء صفحة الدفع، ويُسجَّل اسم المتغيّر (لا قيمته) في
   «أخطاء النظام». والمفتاح التجريبي (sk_test_) في الإنتاج تحذير لا منع: الصفحة تعمل
   ببطاقات الاختبار وحدها.
   لا قيمة تُطبع ولا تُعاد: أسماء المتغيّرات وأسباب عربية فقط.
   ============================================================ */

function badPublicUrl(v) {
  if (!v) return "غائب";
  let u; try { u = new URL(v); } catch { return "ليس رابطاً صالحاً"; }
  if (u.protocol !== "https:") return "ليس https";
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname)) return "يشير إلى جهاز محلي";
  return null;
}

/** { blocking: [{ name, why }], warnings: [{ name, why }] } — في غير الإنتاج لا شيء يمنع (التطوير المحلي). */
export function paymentConfigProblems(env = process.env) {
  const blocking = [], warnings = [];
  const production = env.NODE_ENV === "production";
  if (!env.PAYMENT_SECRET_KEY) blocking.push({ name: "PAYMENT_SECRET_KEY", why: "غائب — لا يمكن مناداة مزوّد الدفع" });
  else if (production && /^sk_test_/.test(env.PAYMENT_SECRET_KEY)) warnings.push({ name: "PAYMENT_SECRET_KEY", why: "مفتاح تجريبي (sk_test_) — صفحة الدفع تقبل بطاقات الاختبار وحدها" });
  if (production) {
    const s = badPublicUrl(env.SERVER_BASE_URL);
    if (s) blocking.push({ name: "SERVER_BASE_URL", why: `${s} — إشعار الدفع لن يصل الخادم فلا يُفعَّل الاشتراك بعد الدفع` });
    const a = badPublicUrl(env.APP_BASE_URL);
    if (a) blocking.push({ name: "APP_BASE_URL", why: `${a} — صفحة العودة بعد الدفع لن تُفتح` });
  }
  return { blocking, warnings };
}
