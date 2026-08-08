import { query } from "../db/pool.js";

/**
 * الإعداد المالي والضريبي المركزي — مصدر واحد لنسبة الضريبة والعملة
 * والمنطقة الزمنية المحاسبية وبادئات أرقام الوثائق.
 *
 * قبل هذا الملف كانت هذه القيم موزّعة على أربعة مواضع لا تعرف
 * بعضها: VAT_RATE ثابتة في invoicing/zatca.js، ونص "(15%)" مكتوب
 * حرفياً مرتين داخل invoicing/pdf.js، و"SAR" حرفياً في
 * payments/moyasar.js، وبادئة "INV-" داخل invoicing/generate.js.
 * تغيير النسبة كان يتطلب تعديل أربعة ملفات، ونسيان أحدها ينتج
 * فاتورة أرقامها لا تطابق نصّها.
 *
 * ⚠️ لم تُخترع هنا أي نسبة ولا متطلب قانوني. القيم الافتراضية في
 * الترحيل 004 مطابقة حرفياً للسلوك الذي كان يعمل به المشروع، وأي
 * تغيير عليها قرار إداري يُتخذ من صفحة الإعدادات ويُسجَّل باسم من
 * غيّره.
 */

const FALLBACK = Object.freeze({
  vatRate: 0.15,
  pricesIncludeVat: true,
  currency: "SAR",
  invoiceNumberPrefix: "INV",
  creditNoteNumberPrefix: "CN",
  reportingTimezone: "Asia/Riyadh",
});

/**
 * يقرأ الإعداد من قاعدة البيانات في كل نداء — بلا طبقة تخزين مؤقت.
 * هذا مقصود: المشروع بلا Cache Layer، وإضافتها لصف واحد صغير تُدخل
 * مشكلة إبطال أخطر من الاستعلام نفسه. لو صار هذا محسوساً يوماً،
 * فالحل ذاكرة مؤقتة قصيرة داخل العملية لا Redis.
 *
 * يقبل `client` اختياري ليعمل داخل معاملة قائمة — الفاتورة يجب أن
 * تُصدر بالنسبة التي قُرئت في نفس المعاملة، لا بنسخة أحدث قُرئت
 * خارجها.
 */
export async function getBillingSettings(client) {
  const runner = client || { query };
  try {
    const { rows } = await runner.query(
      `SELECT vat_rate, prices_include_vat, currency,
              invoice_number_prefix, credit_note_number_prefix, reporting_timezone
       FROM billing_settings LIMIT 1`
    );
    if (!rows[0]) return { ...FALLBACK, source: "fallback" };
    return {
      vatRate: Number(rows[0].vat_rate),
      pricesIncludeVat: rows[0].prices_include_vat,
      currency: rows[0].currency,
      invoiceNumberPrefix: rows[0].invoice_number_prefix,
      creditNoteNumberPrefix: rows[0].credit_note_number_prefix,
      reportingTimezone: rows[0].reporting_timezone,
      source: "database",
    };
  } catch (err) {
    // جدول الإعداد غير موجود (ترحيل 004 لم يُطبَّق بعد) — لا يجوز أن
    // يمنع ذلك إصدار فاتورة لعميل دفع فعلاً. نعود للقيم التي كان
    // الكود يعمل بها أصلاً، ونصرخ في السجل بدل الفشل الصامت.
    console.error(
      "[billing/config] تعذّرت قراءة billing_settings — استُخدمت القيم الافتراضية المطابقة للسلوك السابق. " +
      "طبّق الترحيل 004_billing_model.sql:", err.message
    );
    return { ...FALLBACK, source: "fallback" };
  }
}

/**
 * يفصل المبلغ إلى وعاء ضريبي وضريبة وإجمالي، حسب ما إذا كان السعر
 * المعروض شاملاً للضريبة أو غير شامل.
 *
 * يعيد نصوصاً بمنزلتين عشريتين — لا أرقاماً عائمة — لأن نفس القيمة
 * بالضبط تدخل في حمولة TLV للـQR وفي نص الـPDF، وأي اختلاف في
 * التقريب بينهما يجعل الفاتورة ورمزها يقولان رقمين مختلفين.
 */
export function splitVat(amount, { vatRate, pricesIncludeVat }) {
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    throw new Error(`splitVat: مبلغ غير صالح (${amount})`);
  }
  const rate = Number(vatRate);
  if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
    throw new Error(`splitVat: نسبة ضريبة غير صالحة (${vatRate})`);
  }

  if (pricesIncludeVat) {
    const subtotal = value / (1 + rate);
    return {
      subtotal: subtotal.toFixed(2),
      vat: (value - subtotal).toFixed(2),
      total: value.toFixed(2),
    };
  }
  const vat = value * rate;
  return {
    subtotal: value.toFixed(2),
    vat: vat.toFixed(2),
    total: (value + vat).toFixed(2),
  };
}

/** نص النسبة كما يظهر للمستخدم: 0.15 ← "15%" و 0.05 ← "5%" */
export function formatVatRate(vatRate) {
  const pct = Number(vatRate) * 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

export const BILLING_FALLBACK = FALLBACK;
