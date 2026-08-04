import { generateAndStoreCreditNote } from "../invoicing/generate.js";

/**
 * Core refund processing: marks the invoice refunded, revokes the
 * user's active subscription, and issues a real credit note.
 *
 * Callers MUST already hold a row lock on `invoiceRow` (SELECT ...
 * FOR UPDATE) before calling this, inside the same transaction as
 * `client` — this function doesn't acquire the lock itself, since the
 * webhook and the admin action differ in how they first look up the
 * invoice (by provider_payment_id vs. by invoice id directly).
 *
 * Idempotent: if the invoice is already 'refunded', returns
 * { alreadyRefunded: true } and does nothing further — this is what
 * protects against a duplicate webhook delivery AND against an admin
 * accidentally clicking "refund" twice.
 */
export async function processRefund({ invoiceRow, reason, providerRefundId }, client) {
  if (invoiceRow.status === "refunded") {
    return { alreadyRefunded: true, creditNote: null };
  }

  await client.query(`UPDATE invoices SET status = 'refunded', updated_at = now() WHERE id = $1`, [invoiceRow.id]);

  // Revoke access immediately — a refund means the customer no longer
  // paid for the period, unlike a plain cancellation that might run
  // out the current period first.
  await client.query(
    `UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE user_id = $1 AND status = 'active'`,
    [invoiceRow.user_id]
  );

  const { rows: planRows } = await client.query(`SELECT name FROM subscription_plans WHERE plan_key = $1`, [invoiceRow.plan_id]);
  const { rows: userRows } = await client.query(`SELECT email FROM users WHERE id = $1`, [invoiceRow.user_id]);

  let creditNote = null;
  try {
    creditNote = await generateAndStoreCreditNote(
      {
        originalInvoiceId: invoiceRow.id,
        userId: invoiceRow.user_id,
        planName: planRows[0]?.name || invoiceRow.plan_id,
        amountSar: invoiceRow.amount_sar,
        reason: reason || "استرداد",
        buyerEmail: userRows[0]?.email,
        providerRefundId: providerRefundId || null,
      },
      client
    );
  } catch (err) {
    // Same principle as invoice generation: a failed PDF must not
    // roll back the refund/access revocation the customer is
    // legitimately owed — log for manual follow-up.
    console.error(`Credit note generation failed for refunded invoice ${invoiceRow.id}:`, err);
  }

  return { alreadyRefunded: false, creditNote };
}
