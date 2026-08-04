import { query } from "../db/pool.js";
import { generateInvoicePdf, generateCreditNotePdf } from "./pdf.js";

/**
 * Generates and persists the ZATCA-compliant invoice for a just-paid
 * invoice row. Call this AFTER the invoice's status is already 'paid'
 * in the same transaction as the payment webhook — this function does
 * its own read of tax_settings and plan name, then one UPDATE with
 * everything (PDF bytes, QR payload, sequence number) together.
 *
 * Returns null (and logs loudly) instead of throwing if tax_settings
 * hasn't been configured yet — a missing seller VAT number must never
 * silently produce an invalid "invoice" with blank/fake tax fields.
 */
export async function generateAndStoreInvoice({ invoiceId, userId, planName, totalSar, buyerEmail }, client) {
  const runner = client || { query };

  const { rows: settingsRows } = await runner.query(
    `SELECT legal_name AS "legalName", vat_number AS "vatNumber", address FROM tax_settings LIMIT 1`
  );
  const taxSettings = settingsRows[0];
  if (!taxSettings) {
    console.error(
      `Cannot generate ZATCA invoice for paid invoice ${invoiceId}: tax_settings is empty. ` +
      `Set your VAT registration details from the admin panel's Tax Settings page FIRST — ` +
      `this payment is still recorded as paid, but no compliant invoice was produced. Needs manual reconciliation.`
    );
    return null;
  }

  const { rows: seqRows } = await runner.query(`SELECT nextval('zatca_invoice_number_seq') AS n`);
  const seqNumber = seqRows[0].n;
  const year = new Date().getFullYear();
  const invoiceNumber = `INV-${year}-${String(seqNumber).padStart(6, "0")}`;
  const issuedAt = new Date();

  const { pdfBuffer, qrPayload, subtotalSar, vatSar, totalSar: totalFormatted } = await generateInvoicePdf({
    taxSettings,
    invoice: { invoiceNumber, planName, totalSar, issuedAt, buyerEmail },
  });

  await runner.query(
    `UPDATE invoices SET
       zatca_invoice_number = $1, subtotal_sar = $2, vat_sar = $3,
       zatca_qr_payload = $4, zatca_issued_at = $5, pdf_data = $6, updated_at = now()
     WHERE id = $7`,
    [invoiceNumber, subtotalSar, vatSar, qrPayload, issuedAt, pdfBuffer, invoiceId]
  );

  return { invoiceNumber, subtotalSar, vatSar, totalSar: totalFormatted };
}

/**
 * Generates and persists a real ZATCA Credit Note for a refund.
 * `originalInvoiceId` must point to an invoice that already has a
 * zatca_invoice_number — refusing to issue a credit note against an
 * invoice that was never legally issued in the first place would
 * produce a document referencing nothing real.
 */
export async function generateAndStoreCreditNote({ originalInvoiceId, userId, planName, amountSar, reason, buyerEmail, providerRefundId }, client) {
  const runner = client || { query };

  const { rows: invRows } = await runner.query(
    `SELECT zatca_invoice_number FROM invoices WHERE id = $1`,
    [originalInvoiceId]
  );
  const originalInvoiceNumber = invRows[0]?.zatca_invoice_number;
  if (!originalInvoiceNumber) {
    console.error(
      `Cannot issue a credit note for invoice ${originalInvoiceId}: it has no zatca_invoice_number ` +
      `(was never successfully issued). This refund is still recorded, but needs manual reconciliation.`
    );
    return null;
  }

  const { rows: settingsRows } = await runner.query(
    `SELECT legal_name AS "legalName", vat_number AS "vatNumber", address FROM tax_settings LIMIT 1`
  );
  const taxSettings = settingsRows[0];
  if (!taxSettings) {
    console.error(`Cannot issue credit note for invoice ${originalInvoiceId}: tax_settings is empty. Needs manual reconciliation.`);
    return null;
  }

  const { rows: seqRows } = await runner.query(`SELECT nextval('zatca_credit_note_number_seq') AS n`);
  const year = new Date().getFullYear();
  const creditNoteNumber = `CN-${year}-${String(seqRows[0].n).padStart(6, "0")}`;
  const issuedAt = new Date();

  const { pdfBuffer, qrPayload, subtotalSar, vatSar, totalSar } = await generateCreditNotePdf({
    taxSettings,
    creditNote: { creditNoteNumber, originalInvoiceNumber, planName, totalSar: amountSar, reason, issuedAt, buyerEmail },
  });

  const { rows } = await runner.query(
    `INSERT INTO credit_notes
       (original_invoice_id, user_id, zatca_credit_note_number, reason, amount_sar, subtotal_sar, vat_sar,
        zatca_qr_payload, zatca_issued_at, pdf_data, provider_refund_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, zatca_credit_note_number`,
    [originalInvoiceId, userId, creditNoteNumber, reason || null, totalSar, subtotalSar, vatSar, qrPayload, issuedAt, pdfBuffer, providerRefundId || null]
  );

  return { creditNoteId: rows[0].id, creditNoteNumber, subtotalSar, vatSar, totalSar };
}
