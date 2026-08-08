import QRCode from "qrcode";
import { buildZatcaQrPayload } from "./zatca.js";
import { splitVat, formatVatRate, BILLING_FALLBACK } from "../billing/config.js";
import { renderHtmlToPdf } from "./render.js";
import { buildInvoiceHtml, buildCreditNoteHtml, paymentInstrumentLabel } from "./template.js";

/**
 * ============================================================
 * توليد الفاتورة الضريبية وإشعار الدائن
 * ============================================================
 *
 * ما تغيّر عن النسخة السابقة
 * --------------------------
 * كانت الوثيقة تُرسم بـpdfkit سطراً سطراً مع «تشكيل» عربي يدوي.
 * pdfkit لا يصل الحروف ولا يطبّق bidi، والحيلة اليدوية تعتمد على
 * كتلة Presentation Forms-B التي لا يحتوي عليها خط التطبيق أصلاً،
 * فخرجت الفاتورة الأولى بحروف مقطّعة مقلوبة. الآن تُبنى الوثيقة
 * HTML وتُطبع في Chromium الذي يملك تشكيلاً كاملاً — انظر
 * render.js و template.js.
 *
 * ما لم يتغيّر عمداً
 * ------------------
 * توقيع الدالتين ومخرجاتهما كما هي: { pdfBuffer, qrPayload,
 * subtotalSar, vatSar, totalSar }. الأرقام تُحسب بنفس splitVat
 * ونفس القيمة بالضبط تدخل في حمولة TLV وفي نص الوثيقة، فلا يقول
 * الرمز رقماً ويقول المطبوع غيره.
 *
 * الفشل يُرمى للأعلى ولا يُبتلع هنا: كل استدعاء يجري في مسار
 * مستقل بعد ترسيب معاملة المال (issueInvoiceDocument /
 * issueCreditNoteDocument)، فرمي الاستثناء لا يهدّد دفعة ولا
 * اشتراكاً — وهذا هو الترتيب الذي أُصلح بعد حادثة الدفعة المفقودة.
 */

/** ما نطبعه في خانة «طريقة الدفع» — كل مبيعات المنصة إلكترونية. */
const PAYMENT_METHOD_LABEL = "دفع إلكتروني";

function sellerBlock(taxSettings, settings) {
  const suffix = settings.sellerDisplaySuffix ? ` ${settings.sellerDisplaySuffix}` : "";
  return {
    // الاسم النظامي وحده هو ما يدخل في QR؛ اللاحقة عرض فقط.
    legalName: taxSettings.legalName,
    displayName: `${taxSettings.legalName}${suffix}`,
    vatNumber: taxSettings.vatNumber,
    address: taxSettings.address || null,
    email: settings.sellerEmail || null,
    phone: settings.sellerPhone || null,
  };
}

function periodLabel(start, end) {
  if (!start || !end) return null;
  const d = (v) => new Date(v).toISOString().slice(0, 10);
  return `${d(start)} → ${d(end)}`;
}

/** التاريخ كما يُطبع: ثوانٍ بلا منطقة زمنية، أرقام لاتينية. */
function stampLabel(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * فاتورة ضريبية مبسّطة.
 *
 * `invoice`: { invoiceNumber, planName, totalSar, discountSar, issuedAt,
 *              buyerEmail, buyerName, buyerPhone, periodStart, periodEnd,
 *              paymentMethod, paymentBrand }
 *
 * `discountSar` هو الخصم المطبَّق قبل الوصول إلى `totalSar`؛ نعرضه
 * ولا نطرحه مرة أخرى. المبلغ المدفوع فعلاً هو المرجع الوحيد
 * للضريبة — خصم يُطرح مرتين ينتج ضريبة أقل مما حُصِّل.
 */
export async function generateInvoicePdf({ taxSettings, invoice, settings = BILLING_FALLBACK }) {
  const { subtotal, vat, total } = splitVat(invoice.totalSar, settings);
  const vatLabel = formatVatRate(settings.vatRate);
  const issuedAtIso = invoice.issuedAt.toISOString();
  const discount = Number(invoice.discountSar || 0);

  const qrPayload = buildZatcaQrPayload({
    sellerName: taxSettings.legalName,
    vatNumber: taxSettings.vatNumber,
    timestampIso: issuedAtIso,
    invoiceTotal: total,
    vatTotal: vat,
  });
  const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 300, margin: 0 });

  const instrument = paymentInstrumentLabel(invoice.paymentMethod, invoice.paymentBrand);

  const html = buildInvoiceHtml({
    number: invoice.invoiceNumber,
    issuedAt: stampLabel(invoice.issuedAt),
    seller: sellerBlock(taxSettings, settings),
    buyer: { name: invoice.buyerName, email: invoice.buyerEmail, phone: invoice.buyerPhone },
    vatLabel,
    qrDataUrl,
    paymentMethod: PAYMENT_METHOD_LABEL,
    paymentInstrument: instrument,
    items: [{
      description: `اشتراك كنف+ ${"—"} ${invoice.planName}`,
      period: periodLabel(invoice.periodStart, invoice.periodEnd),
      quantity: 1,
      paymentMethod: PAYMENT_METHOD_LABEL,
      paymentInstrument: instrument,
      gross: Number(total) + discount,
      discount,
      subtotal,
      vat,
      total,
    }],
    totals: {
      gross: Number(total) + discount,
      discount,
      subtotal,
      vat,
      total,
      // مدفوعة بالكامل: لا يوجد متبقٍ. الفاتورة لا تصدر أصلاً قبل
      // تأكيد الدفع من الويبهوك.
      due: 0,
    },
  });

  const pdfBuffer = await renderHtmlToPdf(html);
  return { pdfBuffer, qrPayload, subtotalSar: subtotal, vatSar: vat, totalSar: total };
}

/**
 * إشعار دائن (استرداد) — وثيقة نظامية تصحّح فاتورة صدرت فعلاً.
 *
 * نفس بنية TLV للـQR، مع إلزام الإشارة إلى رقم الفاتورة الأصلية:
 * إشعار لا يشير إلى فاتورة قائمة يصحّح لا شيء.
 */
export async function generateCreditNotePdf({ taxSettings, creditNote, settings = BILLING_FALLBACK }) {
  const { subtotal, vat, total } = splitVat(creditNote.totalSar, settings);
  const vatLabel = formatVatRate(settings.vatRate);
  const issuedAtIso = creditNote.issuedAt.toISOString();

  const qrPayload = buildZatcaQrPayload({
    sellerName: taxSettings.legalName,
    vatNumber: taxSettings.vatNumber,
    timestampIso: issuedAtIso,
    invoiceTotal: total,
    vatTotal: vat,
  });
  const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 300, margin: 0 });

  const instrument = paymentInstrumentLabel(creditNote.paymentMethod, creditNote.paymentBrand);

  const html = buildCreditNoteHtml({
    number: creditNote.creditNoteNumber,
    originalInvoiceNumber: creditNote.originalInvoiceNumber,
    reason: creditNote.reason || null,
    issuedAt: stampLabel(creditNote.issuedAt),
    seller: sellerBlock(taxSettings, settings),
    buyer: { name: creditNote.buyerName, email: creditNote.buyerEmail, phone: creditNote.buyerPhone },
    vatLabel,
    qrDataUrl,
    paymentMethod: PAYMENT_METHOD_LABEL,
    paymentInstrument: instrument,
    items: [{
      description: `استرداد اشتراك كنف+ ${"—"} ${creditNote.planName}`,
      period: null,
      quantity: 1,
      paymentMethod: PAYMENT_METHOD_LABEL,
      paymentInstrument: instrument,
      gross: total,
      discount: 0,
      subtotal,
      vat,
      total,
    }],
    totals: { gross: total, discount: 0, subtotal, vat, total, due: total },
  });

  const pdfBuffer = await renderHtmlToPdf(html);
  return { pdfBuffer, qrPayload, subtotalSar: subtotal, vatSar: vat, totalSar: total };
}
