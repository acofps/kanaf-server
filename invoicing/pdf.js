import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { shapeBidiLine } from "./bidi.js";
import { buildZatcaQrPayload, splitVatInclusiveAmount } from "./zatca.js";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_PATH = path.join(__dirname, "fonts", "IBMPlexSansArabic-Regular.ttf");

/**
 * Generates a ZATCA Phase-1-compliant Simplified Tax Invoice as a PDF
 * buffer, plus the QR payload used to produce it (callers store both).
 *
 * `taxSettings`: { legalName, vatNumber, address } — the seller's own
 * registered details, managed from the admin panel's Tax Settings page.
 * `invoice`: { invoiceNumber, planName, totalSar, issuedAt, buyerEmail }
 */
export async function generateInvoicePdf({ taxSettings, invoice }) {
  const { subtotal, vat, total } = splitVatInclusiveAmount(invoice.totalSar);
  const issuedAtIso = invoice.issuedAt.toISOString();

  const qrPayload = buildZatcaQrPayload({
    sellerName: taxSettings.legalName,
    vatNumber: taxSettings.vatNumber,
    timestampIso: issuedAtIso,
    invoiceTotal: total,
    vatTotal: vat,
  });
  const qrImageDataUrl = await QRCode.toDataURL(qrPayload, { width: 180, margin: 1 });
  const qrImageBuffer = Buffer.from(qrImageDataUrl.split(",")[1], "base64");

  const pdfBuffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font(FONT_PATH);

    const R = (text, opts = {}) => doc.text(shapeBidiLine(text), { align: "right", ...opts });

    doc.fontSize(18).text(shapeBidiLine("فاتورة ضريبية مبسّطة"), { align: "center" });
    doc.fontSize(10).fillColor("#666").text("Simplified Tax Invoice", { align: "center" });
    doc.fillColor("#000");
    doc.moveDown(1.5);

    // Seller block
    doc.fontSize(11);
    R(taxSettings.legalName);
    R(`الرقم الضريبي: ${taxSettings.vatNumber}`);
    if (taxSettings.address) R(taxSettings.address);
    doc.moveDown();

    // Invoice meta
    R(`رقم الفاتورة: ${invoice.invoiceNumber}`);
    R(`تاريخ الإصدار: ${issuedAtIso.slice(0, 19).replace("T", " ")}`);
    if (invoice.buyerEmail) R(`البريد الإلكتروني: ${invoice.buyerEmail}`);
    doc.moveDown();

    // Line item
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
    doc.moveDown(0.5);
    R(`اشتراك كنف+ — ${invoice.planName}`);
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
    doc.moveDown();

    // Totals
    R(`المبلغ قبل الضريبة: ${subtotal} ريال`);
    R(`ضريبة القيمة المضافة (15%): ${vat} ريال`);
    doc.fontSize(13);
    R(`الإجمالي شامل الضريبة: ${total} ريال`);
    doc.fontSize(11);
    doc.moveDown(1.5);

    // QR code — required for every Simplified Tax Invoice
    const qrX = doc.page.width - 50 - 120;
    doc.image(qrImageBuffer, qrX, doc.y, { width: 120 });
    doc.moveDown(7);

    doc.fontSize(8).fillColor("#888");
    R("هذي فاتورة مبسّطة صادرة إلكترونياً وفق أنظمة هيئة الزكاة والضريبة والجمارك.");

    doc.end();
  });

  return { pdfBuffer, qrPayload, subtotalSar: subtotal, vatSar: vat, totalSar: total };
}

/**
 * Generates a real ZATCA Credit Note (إشعار دائن) — required whenever
 * a previously-issued Simplified Tax Invoice is refunded. Confirmed
 * against ZATCA's own guidance before building this: same QR/TLV
 * structure as the invoice, but the document must reference the
 * original invoice number it corrects (checked, not assumed).
 */
export async function generateCreditNotePdf({ taxSettings, creditNote }) {
  const { subtotal, vat, total } = splitVatInclusiveAmount(creditNote.totalSar);
  const issuedAtIso = creditNote.issuedAt.toISOString();

  const qrPayload = buildZatcaQrPayload({
    sellerName: taxSettings.legalName,
    vatNumber: taxSettings.vatNumber,
    timestampIso: issuedAtIso,
    invoiceTotal: total,
    vatTotal: vat,
  });
  const qrImageDataUrl = await QRCode.toDataURL(qrPayload, { width: 180, margin: 1 });
  const qrImageBuffer = Buffer.from(qrImageDataUrl.split(",")[1], "base64");

  const pdfBuffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font(FONT_PATH);
    const R = (text, opts = {}) => doc.text(shapeBidiLine(text), { align: "right", ...opts });

    doc.fontSize(18).text(shapeBidiLine("إشعار دائن"), { align: "center" });
    doc.fontSize(10).fillColor("#666").text("Credit Note", { align: "center" });
    doc.fillColor("#000");
    doc.moveDown(1.5);

    doc.fontSize(11);
    R(taxSettings.legalName);
    R(`الرقم الضريبي: ${taxSettings.vatNumber}`);
    if (taxSettings.address) R(taxSettings.address);
    doc.moveDown();

    R(`رقم إشعار الدائن: ${creditNote.creditNoteNumber}`);
    R(`تاريخ الإصدار: ${issuedAtIso.slice(0, 19).replace("T", " ")}`);
    // The reference to the original invoice is a required field — a
    // credit note with no traceable original invoice is not valid.
    doc.fillColor("#0a6").font(FONT_PATH);
    R(`مرجع الفاتورة الأصلية: ${creditNote.originalInvoiceNumber}`);
    doc.fillColor("#000");
    if (creditNote.buyerEmail) R(`البريد الإلكتروني: ${creditNote.buyerEmail}`);
    doc.moveDown();

    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
    doc.moveDown(0.5);
    R(`استرداد اشتراك كنف+ — ${creditNote.planName}`);
    if (creditNote.reason) R(`السبب: ${creditNote.reason}`);
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
    doc.moveDown();

    R(`المبلغ قبل الضريبة (مسترد): ${subtotal} ريال`);
    R(`ضريبة القيمة المضافة المستردة (15%): ${vat} ريال`);
    doc.fontSize(13);
    R(`إجمالي المبلغ المسترد: ${total} ريال`);
    doc.fontSize(11);
    doc.moveDown(1.5);

    const qrX = doc.page.width - 50 - 120;
    doc.image(qrImageBuffer, qrX, doc.y, { width: 120 });
    doc.moveDown(7);

    doc.fontSize(8).fillColor("#888");
    R("إشعار دائن إلكتروني صادر وفق أنظمة هيئة الزكاة والضريبة والجمارك، يصحّح الفاتورة المرجعية أعلاه.");

    doc.end();
  });

  return { pdfBuffer, qrPayload, subtotalSar: subtotal, vatSar: vat, totalSar: total };
}
