/* ============================================================
   تشغيل الخادم الكامل (index.js) محلياً على قاعدة اختبار معزولة
   بمزودات وهمية — للاختبار اليدوي ورحلات E2E فقط.

     node test-support/run-local-server.mjs   (يحتاج TEST_DATABASE_URL و KANAF_TEST_MARKER)

   • الحارس أولاً: لا قاعدة غير معلنة، لا SMTP/VAPID/Anthropic، لا شبكة خارجية.
   • Moyasar وهمي داخل العملية: create-invoice يعيد رابط دفع محلياً
     لا يُخدَم؛ الدفع يُحاكى بإرسال webhook يدوياً بنفس سر الاختبار.
   • Anthropic: لا مفتاح؛ /api/chat و /api/plan يفشلان بأمان (502/500)
     ما لم يُضبط KANAF_FAKE_MODEL=1 فيرد نموذج وهمي حتمي.
   ============================================================ */
import "./guard.mjs";

const fakeMoyasar = { invoiceSeq: 0, payments: new Map() };
globalThis.__kanafFakeMoyasar = fakeMoyasar;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  if (href.startsWith("https://api.moyasar.com")) {
    const p = href.replace("https://api.moyasar.com/v1", "");
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (p === "/invoices" && opts.method === "POST") {
      const id = `fake_inv_${++fakeMoyasar.invoiceSeq}`;
      return json(201, { id, status: "initiated", amount: body.amount, currency: body.currency, url: `http://127.0.0.1:${process.env.PORT || 3001}/__fake-checkout/${id}` });
    }
    const m = /^\/payments\/([^/]+)(\/refund)?$/.exec(p);
    if (m) {
      let pay = fakeMoyasar.payments.get(m[1]);
      /* دفعات E2E تُحاكى بـwebhook من خارج العملية فلا يعرفها المزوّد الوهمي.
         عند أول استرداد أو مطابقة تُنشأ له كدفعة مدفوعة (المبلغ من الطلب أو
         KANAF_FAKE_PAYMENT_HALALAS). اختبار فقط — لا وجود له خارج هذا الملف. */
      if (!pay && process.env.KANAF_FAKE_LAZY_PAYMENTS === "1") {
        const amount = Number(process.env.KANAF_FAKE_PAYMENT_HALALAS || 2900);
        pay = { id: m[1], status: "paid", amount, refunded: 0, currency: "SAR" };
        fakeMoyasar.payments.set(m[1], pay);
      }
      if (!pay) return json(404, { message: "not found" });
      if (m[2]) { const amt = body.amount ?? pay.amount - pay.refunded; pay.refunded += amt; pay.status = pay.refunded >= pay.amount ? "refunded" : "paid"; }
      return json(200, { ...pay, refunded_amount: pay.refunded });
    }
    return json(404, { message: `fake moyasar: unmocked ${p}` });
  }
  if (href.startsWith("https://api.anthropic.com") && process.env.KANAF_FAKE_MODEL === "1") {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const isPlan = String(body.system || "").includes("JSON");
    const text = isPlan
      ? JSON.stringify({ summary: "ملخص اصطناعي للاختبار", focus_areas: [{ title: "النوم", goal: "انتظام النوم", small_step: "نم في وقت ثابت" }, { title: "الحركة", goal: "مشي يومي", small_step: "عشر دقائق مشي" }], specialist_note: null })
      : "رد اصطناعي للاختبار.";
    return json(200, { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  }
  return realFetch(url, opts);
};
if (process.env.KANAF_FAKE_MODEL === "1") process.env.ANTHROPIC_API_KEY = "sk-ant-fake-local";
process.env.SKIP_PDF_BOOT_CHECK = process.env.SKIP_PDF_BOOT_CHECK || "1";
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || "http://127.0.0.1:5173,http://localhost:5173";

await import("../index.js");
