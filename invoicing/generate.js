import { query } from "../db/pool.js";
import { generateInvoicePdf, generateCreditNotePdf } from "./pdf.js";
import { getBillingSettings } from "../billing/config.js";

/**
 * يولّد ويحفظ الفاتورة الضريبية لفاتورة صار حالها مدفوعاً.
 *
 * يُستدعى داخل نفس معاملة تأكيد الدفع، فلا يُستهلك رقم تسلسلي قانوني
 * إلا لدفعة تسجَّل فعلاً.
 *
 * يعيد null (مع تسجيل صريح) بدل أن يرمي استثناءً حين لا تكون بيانات
 * البائع الضريبية مضبوطة — رقم ضريبي مفقود يجب ألا يُنتج بصمت
 * "فاتورة" بحقول فارغة.
 *
 * ============================================================
 * ما أُضيف في المرحلة 3
 * ============================================================
 * • النسبة والعملة وبادئة الرقم تأتي من billing_settings لا من ثوابت
 *   موزّعة على الكود.
 * • تُحفظ **لقطة** بيانات البائع والمشتري والنسبة المطبَّقة في
 *   invoice_state. قبل ذلك كانت بيانات البائع تُرسم داخل الـPDF فقط،
 *   فتغيير الرقم الضريبي من صفحة الإعدادات يجعل من المستحيل معرفة ما
 *   كان مطبوعاً على فاتورة قديمة إلا بفتح ملفها وقراءته بالعين.
 *   الفاتورة وثيقة قانونية — ما فيها يجب أن يكون مقروءاً بالاستعلام.
 */
export async function generateAndStoreInvoice({
  invoiceId, userId, planName, planKey, totalSar, buyerEmail, buyerName,
  billingCycle, periodStart, periodEnd,
}, client) {
  const runner = client || { query };

  const { rows: settingsRows } = await runner.query(
    `SELECT legal_name AS "legalName", vat_number AS "vatNumber", address FROM tax_settings LIMIT 1`
  );
  const taxSettings = settingsRows[0];
  if (!taxSettings) {
    console.error(
      `تعذّر توليد فاتورة ZATCA للفاتورة المدفوعة ${invoiceId}: جدول tax_settings فارغ. ` +
      `اضبط بيانات التسجيل الضريبي من صفحة «الإعدادات الضريبية» في اللوحة أولاً — ` +
      `الدفعة مسجَّلة كمدفوعة، لكن لم تصدر فاتورة نظامية. تحتاج تسوية يدوية.`
    );
    return null;
  }

  const settings = await getBillingSettings(client);

  const { rows: seqRows } = await runner.query(`SELECT nextval('zatca_invoice_number_seq') AS n`);
  const seqNumber = seqRows[0].n;
  const year = new Date().getFullYear();
  const invoiceNumber = `${settings.invoiceNumberPrefix}-${year}-${String(seqNumber).padStart(6, "0")}`;
  const issuedAt = new Date();

  const { pdfBuffer, qrPayload, subtotalSar, vatSar, totalSar: totalFormatted } = await generateInvoicePdf({
    taxSettings,
    settings,
    invoice: { invoiceNumber, planName, totalSar, issuedAt, buyerEmail, buyerName, periodStart, periodEnd },
  });

  await runner.query(
    `UPDATE invoices SET
       zatca_invoice_number = $1, subtotal_sar = $2, vat_sar = $3,
       zatca_qr_payload = $4, zatca_issued_at = $5, pdf_data = $6, updated_at = now()
     WHERE id = $7`,
    [invoiceNumber, subtotalSar, vatSar, qrPayload, issuedAt, pdfBuffer, invoiceId]
  );

  // لقطة ما طُبع فعلاً — مجمَّدة، لا تتأثر بأي تعديل لاحق على
  // الإعدادات الضريبية أو على اسم الباقة أو سعرها.
  const lineItems = [{
    description: `اشتراك كنف+ — ${planName}`,
    plan_key: planKey || null,
    quantity: 1,
    unit_price_sar: Number(totalSar),
    subtotal_sar: Number(subtotalSar),
    vat_sar: Number(vatSar),
    total_sar: Number(totalFormatted),
  }];

  await runner.query(
    `INSERT INTO invoice_state
       (invoice_id, user_id, currency, vat_rate, prices_include_vat,
        seller_legal_name, seller_vat_number, seller_address,
        buyer_name, buyer_email, line_items, discount_sar,
        billing_cycle, period_start, period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, $14)
     ON CONFLICT (invoice_id) DO UPDATE SET
       currency = EXCLUDED.currency, vat_rate = EXCLUDED.vat_rate,
       prices_include_vat = EXCLUDED.prices_include_vat,
       seller_legal_name = EXCLUDED.seller_legal_name,
       seller_vat_number = EXCLUDED.seller_vat_number,
       seller_address = EXCLUDED.seller_address,
       buyer_name = EXCLUDED.buyer_name, buyer_email = EXCLUDED.buyer_email,
       line_items = EXCLUDED.line_items,
       billing_cycle = EXCLUDED.billing_cycle,
       period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end`,
    [
      invoiceId, userId, settings.currency, settings.vatRate, settings.pricesIncludeVat,
      taxSettings.legalName, taxSettings.vatNumber, taxSettings.address || null,
      buyerName || null, buyerEmail || null, JSON.stringify(lineItems),
      billingCycle || null, periodStart || null, periodEnd || null,
    ]
  );

  return { invoiceNumber, subtotalSar, vatSar, totalSar: totalFormatted, vatRate: settings.vatRate };
}

/**
 * يولّد ويحفظ إشعاراً دائناً حقيقياً لاسترداد.
 *
 * `originalInvoiceId` لازم يشير إلى فاتورة تحمل رقماً ضريبياً فعلاً —
 * إشعار دائن يصحّح فاتورة لم تصدر أصلاً وثيقة تشير إلى لا شيء.
 *
 * ملاحظة على الاسترداد الجزئي: `amountSar` هو مبلغ **هذا** الاسترداد
 * وحده لا كامل الفاتورة، فاستردادان جزئيان ينتجان إشعارين، وكل واحد
 * يصحّح مبلغه هو. هذا هو الشكل الصحيح نظاماً، وهو ما يجعل مجموع
 * الإشعارات على فاتورة قابلاً للمطابقة مع مجموع المستردات عليها.
 */
export async function generateAndStoreCreditNote({
  originalInvoiceId, userId, planName, amountSar, reason,
  buyerEmail, buyerName, providerRefundId,
}, client) {
  const runner = client || { query };

  const { rows: invRows } = await runner.query(
    `SELECT zatca_invoice_number FROM invoices WHERE id = $1`,
    [originalInvoiceId]
  );
  const originalInvoiceNumber = invRows[0]?.zatca_invoice_number;
  if (!originalInvoiceNumber) {
    console.error(
      `تعذّر إصدار إشعار دائن للفاتورة ${originalInvoiceId}: لا تحمل رقماً ضريبياً ` +
      `(لم تصدر أصلاً). الاسترداد مسجَّل، لكنه يحتاج تسوية يدوية.`
    );
    return null;
  }

  const { rows: settingsRows } = await runner.query(
    `SELECT legal_name AS "legalName", vat_number AS "vatNumber", address FROM tax_settings LIMIT 1`
  );
  const taxSettings = settingsRows[0];
  if (!taxSettings) {
    console.error(`تعذّر إصدار إشعار دائن للفاتورة ${originalInvoiceId}: جدول tax_settings فارغ. تحتاج تسوية يدوية.`);
    return null;
  }

  // النسبة المطبَّقة على الإشعار الدائن هي نسبة **الفاتورة الأصلية**
  // لا النسبة السارية اليوم. تصحيح فاتورة بنسبة مختلفة عن نسبتها
  // ينتج فرقاً ضريبياً لا يقابله شيء.
  const currentSettings = await getBillingSettings(client);
  const { rows: originalStateRows } = await runner.query(
    `SELECT vat_rate, prices_include_vat, currency FROM invoice_state WHERE invoice_id = $1`,
    [originalInvoiceId]
  );
  const original = originalStateRows[0];
  const settings = {
    ...currentSettings,
    vatRate: original?.vat_rate !== null && original?.vat_rate !== undefined
      ? Number(original.vat_rate) : currentSettings.vatRate,
    pricesIncludeVat: original?.prices_include_vat ?? currentSettings.pricesIncludeVat,
    currency: original?.currency || currentSettings.currency,
  };

  const { rows: seqRows } = await runner.query(`SELECT nextval('zatca_credit_note_number_seq') AS n`);
  const year = new Date().getFullYear();
  const creditNoteNumber = `${currentSettings.creditNoteNumberPrefix}-${year}-${String(seqRows[0].n).padStart(6, "0")}`;
  const issuedAt = new Date();

  const { pdfBuffer, qrPayload, subtotalSar, vatSar, totalSar } = await generateCreditNotePdf({
    taxSettings,
    settings,
    creditNote: {
      creditNoteNumber, originalInvoiceNumber, planName,
      totalSar: amountSar, reason, issuedAt, buyerEmail, buyerName,
    },
  });

  const { rows } = await runner.query(
    `INSERT INTO credit_notes
       (original_invoice_id, user_id, zatca_credit_note_number, reason, amount_sar, subtotal_sar, vat_sar,
        zatca_qr_payload, zatca_issued_at, pdf_data, provider_refund_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, zatca_credit_note_number`,
    [originalInvoiceId, userId, creditNoteNumber, reason || null, totalSar, subtotalSar, vatSar,
     qrPayload, issuedAt, pdfBuffer, providerRefundId || null]
  );

  return { creditNoteId: rows[0].id, creditNoteNumber, subtotalSar, vatSar, totalSar };
}
