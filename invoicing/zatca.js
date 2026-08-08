// ZATCA (Saudi tax authority) Simplified Tax Invoice QR code — Phase 1
// specification (5 mandatory TLV tags). Phase 2 adds 4 more tags
// (invoice hash, digital signature, public key, certificate stamp)
// that require a real cryptographic stamp issued by ZATCA after
// business onboarding — NOT implemented here, see invoicing/README.md
// for why that can't be faked and what's needed when Phase 2 applies
// to this account.
//
// Verified against ZATCA's own published guideline structure before
// writing this — TLV = Tag (1 byte) + Length (1 byte, value's UTF-8
// byte length) + Value (UTF-8 bytes), five tags concatenated, then
// the whole binary blob is base64-encoded.

const TAGS = {
  SELLER_NAME: 1,
  VAT_NUMBER: 2,
  TIMESTAMP: 3,
  INVOICE_TOTAL: 4,
  VAT_TOTAL: 5,
};

function encodeTlvField(tag, value) {
  const valueBuf = Buffer.from(String(value), "utf8");
  if (valueBuf.length > 255) {
    // A single TLV length byte can only hold 0-255 — every real
    // field here (name, VAT number, ISO timestamp, formatted amount)
    // is comfortably under this, but fail loudly instead of silently
    // truncating a legal document field if it ever isn't.
    throw new Error(`TLV field for tag ${tag} exceeds 255 UTF-8 bytes — cannot encode safely`);
  }
  return Buffer.concat([Buffer.from([tag]), Buffer.from([valueBuf.length]), valueBuf]);
}

/**
 * Builds the base64 TLV payload for a Phase 1 Simplified Tax Invoice
 * QR code. `invoiceTotal` and `vatTotal` should be strings already
 * formatted to 2 decimal places (e.g. "29.00"), matching what ZATCA's
 * own examples show — pass strings, not floats, to avoid any locale-
 * dependent formatting surprises.
 */
export function buildZatcaQrPayload({ sellerName, vatNumber, timestampIso, invoiceTotal, vatTotal }) {
  if (!sellerName || !vatNumber || !timestampIso || invoiceTotal === undefined || vatTotal === undefined) {
    throw new Error("buildZatcaQrPayload: all five fields are required — refusing to generate an incomplete QR code");
  }
  const buf = Buffer.concat([
    encodeTlvField(TAGS.SELLER_NAME, sellerName),
    encodeTlvField(TAGS.VAT_NUMBER, vatNumber),
    encodeTlvField(TAGS.TIMESTAMP, timestampIso),
    encodeTlvField(TAGS.INVOICE_TOTAL, invoiceTotal),
    encodeTlvField(TAGS.VAT_TOTAL, vatTotal),
  ]);
  return buf.toString("base64");
}

/* ------------------------------------------------------------
   نسبة الضريبة لم تعد ثابتة هنا.

   كانت `const VAT_RATE = 0.15` في هذا الملف، ونص "(15%)" مكتوباً
   حرفياً مرتين في invoicing/pdf.js. أي تعديل مستقبلي على النسبة كان
   يتطلب تذكّر أربعة مواضع، ونسيان أحدها يُنتج فاتورة أرقامها لا
   تطابق نصّها — وهي وثيقة قانونية.

   المصدر الآن جدول billing_settings عبر billing/config.js. الدالة
   أدناه محفوظة كما هي للتوافق مع أي مُنادٍ قديم، بقيمة افتراضية
   مطابقة تماماً للسلوك السابق، لكن المسارات الحيّة كلها تمرّر النسبة
   المقروءة من الإعداد صراحةً.
   ------------------------------------------------------------ */
export const DEFAULT_VAT_RATE = 0.15;

/**
 * يفصل الإجمالي الشامل للضريبة إلى وعاء وضريبة.
 * أسعار كنف معروضة شاملة الضريبة، وهذا يستخرج التفصيل منها.
 * يعيد نصوصاً بمنزلتين — نفس القيمة بالضبط تدخل الـPDF وحمولة الـQR.
 */
export function splitVatInclusiveAmount(totalInclVat, vatRate = DEFAULT_VAT_RATE) {
  const total = Number(totalInclVat);
  const rate = Number(vatRate);
  if (!Number.isFinite(rate) || rate < 0 || rate >= 1) {
    throw new Error(`splitVatInclusiveAmount: نسبة ضريبة غير صالحة (${vatRate})`);
  }
  const subtotal = total / (1 + rate);
  const vat = total - subtotal;
  return {
    subtotal: subtotal.toFixed(2),
    vat: vat.toFixed(2),
    total: total.toFixed(2),
  };
}
