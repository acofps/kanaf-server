import { recordError } from "./error-log.js";

/* ============================================================
   ردّ 5xx واحد للخادم كله — KANAF-ORD-0015 §2.2.3

   صفحة «أخطاء النظام» (ORD-0013 §11) كانت ترى ما يمرّ بـfail() في اللوحة
   وبمعالج Express الأخير وحدهما. وكان 63 موضعاً في 13 ملفاً — منها مسار
   الدفع كله — يكتب console.error ويردّ 500 بيده، فيبقى العطب في سجلّ
   Render النصّي ولا يصل الصفحة التي بُنيت لتريه.

   serverError() هو الطريق الوحيد لردّ 5xx:
     • سطر واحد في السجل النصّي بالموضع والطلب والسبب
     • recordError منقّى (لا يرمي ولا يُنتظر — لا يُسقط الطلب)
     • ردّ ثابت الشكل { error, message } — رمز للبرنامج ونص عربي للإنسان؛
       ولا تفاصيل داخلية للعميل إلا ما يمرّره المنادي صراحةً في body.

   expectedUnavailable() لما ليس عطباً بل حالة معلنة (مفتاح تشفير غير مضبوط،
   فحص اتصال غير متاح لخدمة، فحص الجاهزية والقاعدة غائبة): يُردّ 5xx ولا يُسجَّل.

   وشبكة أمان (record5xxNet) على التطبيق كله: أي ردّ ≥500 لم يمرّ بأحد الطريقين
   يُسجَّل «unrecorded_5xx» بموضعه — فما يُضاف غداً بيدٍ لا يعود أعمى. والفحص
   الدائم (test-51) يسقط إن كُتب res.status(5xx) خارج هذا الملف.
   ============================================================ */

export const ARABIC_FALLBACK = "صار خلل غير متوقع. الفريق يقدر يشوف التفاصيل في السجل.";

/** يردّ 5xx ويسجّله. where: موضع ثابت بلا معرّفات ("payments:create-invoice"). */
export function serverError(res, err, where, req = null, { status = 500, body = null } = {}) {
  const e = err instanceof Error ? err : new Error(String(err ?? "unknown"));
  console.error(`[${where}] ${req?.method || ""} ${req?.originalUrl || ""}${req?.admin ? ` admin=${req.admin.id} (${req.admin.role})` : ""}: ${e.message}`, e.stack || "");
  if (res?.locals) res.locals.errorRecorded = true;
  recordError(e, { location: `${where} · ${req?.method || ""} ${req?.originalUrl || ""}`, status });
  if (res.headersSent) return undefined;
  return res.status(status).json(body || { error: "internal_error", message: ARABIC_FALLBACK });
}

/** حالة معلنة لا عطب — 5xx بلا تسجيل في سجلّ الأخطاء. */
export function expectedUnavailable(res, status, body) {
  if (res?.locals) res.locals.expected5xx = true;
  return res.status(status).json(body);
}

/** يُعلِم أن الخطأ سُجِّل بطريق آخر (معالج Express الأخير، fail() في اللوحة). */
export function markRecorded(res) { if (res?.locals) res.locals.errorRecorded = true; }

/** شبكة الأمان: تُركَّب أول التطبيق. */
export function record5xxNet(req, res, next) {
  res.on("finish", () => {
    if (res.statusCode >= 500 && !res.locals.errorRecorded && !res.locals.expected5xx) {
      const e = new Error(`unrecorded_${res.statusCode}`); e.name = "Unrecorded5xx";
      recordError(e, { location: `${req.method} ${req.originalUrl}`, status: res.statusCode });
    }
  });
  next();
}
