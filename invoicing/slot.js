/* ============================================================
   بوابة إصدار الوثائق — KANAF-ORD-0001 X09

   رسم الـPDF متسلسل أصلاً (طابور render.js)، لكن كل إصدار فاتورة أو
   إشعار دائن يفتح معاملة ويقفل صفّه **ثم** ينتظر دوره في الطابور. فكل
   منتظر يمسك اتصالاً من المجمّع (10). القياس (test-support/measure-pdf.mjs،
   80 حدث دفع متزامن): 71 منتظراً على المجمّع، «timeout exceeded when
   trying to connect»، 3 أحداث دفع ردّت 500، و20 فاتورة مدفوعة بلا وثيقة،
   وطلبات غير متعلقة انتظرت حتى 4.6 ثانية.

   البوابة تؤخذ **قبل** المعاملة: المنتظر هنا لا يمسك اتصالاً. لا يعمل
   أكثر من DOC_CONCURRENCY إصداراً في آن (واحد يرسم وآخر يجهّز بياناته)،
   وإن تجاوز المنتظرون DOC_MAX_WAITING يُرفض الإصدار فوراً بخطأ
   document_queue_full — والمستدعون يعاملونه كأي فشل إصدار سابق: المال
   سليم، والوثيقة تظهر في تقرير التكامل لإعادة الإصدار.
   ============================================================ */
const DOC_CONCURRENCY = Math.max(1, Number(process.env.PDF_DOC_CONCURRENCY || 2));
const DOC_MAX_WAITING = Math.max(0, Number(process.env.PDF_DOC_MAX_WAITING || 200));

let active = 0;
const waiting = [];

export function documentSlotStats() {
  return { active, waiting: waiting.length, concurrency: DOC_CONCURRENCY, maxWaiting: DOC_MAX_WAITING };
}

export async function withDocumentSlot(fn) {
  if (active >= DOC_CONCURRENCY) {
    if (waiting.length >= DOC_MAX_WAITING) {
      throw Object.assign(new Error("document_queue_full"), { status: 503 });
    }
    await new Promise((resolve) => waiting.push(resolve));
  } else {
    active += 1;
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();          // يُسلَّم المقعد مباشرة؛ active لا يتغير
    else active -= 1;
  }
}
