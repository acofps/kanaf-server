import { query, pool } from "./db/pool.js";
const EMAIL = process.argv[2];
const q = async (s, p) => (await query(s, p)).rows;
const show = (t, r) => { console.log("\n===== " + t + " ====="); console.log(r.length ? JSON.stringify(r, null, 1) : "(لا شيء)"); };
try {
  const u = await q(`SELECT id, email, name, created_at FROM users WHERE lower(email)=lower($1)`, [EMAIL]);
  show("USER", u);
  if (u[0]) {
    const id = u[0].id;
    show("INVOICES", await q(
      `SELECT id, status, plan_id, amount_sar, zatca_invoice_number,
              (pdf_data IS NOT NULL) AS has_pdf, zatca_issued_at, created_at
         FROM invoices WHERE user_id=$1 ORDER BY created_at DESC`, [id]));
    show("PAYMENTS", await q(
      `SELECT id, status, amount, method, card_brand, provider_payment_id, captured_at
         FROM payments WHERE user_id=$1 ORDER BY created_at DESC`, [id]));
    show("SUBSCRIPTIONS", await q(
      `SELECT id, plan_id, status, current_period_end FROM subscriptions WHERE user_id=$1`, [id]));
    show("INVOICE_STATE", await q(
      `SELECT invoice_id, seller_legal_name, vat_rate FROM invoice_state WHERE user_id=$1`, [id]));
  }
  show("WEBHOOK_EVENTS (آخر 5)", await q(
    `SELECT event_type, status, outcome, error, attempts, received_at
       FROM webhook_events ORDER BY received_at DESC LIMIT 5`));
  show("BILLING_SETTINGS", await q(
    `SELECT invoice_number_prefix, document_number_token, seller_email, seller_phone, seller_display_suffix
       FROM billing_settings LIMIT 1`));
  show("TAX_SETTINGS", await q(`SELECT legal_name, vat_number, address FROM tax_settings LIMIT 1`));
  show("SEQ", await q(`SELECT last_value, is_called FROM kanaf_invoice_number_seq`));
  show("MIGRATIONS", await q(`SELECT filename, applied_at FROM schema_migrations ORDER BY filename`));
} catch (e) {
  console.error("DIAG ERROR:", e.message);
} finally {
  await pool.end();
}
