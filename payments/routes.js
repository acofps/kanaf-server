import express from "express";
import { query, withTransaction } from "../db/pool.js";
import { createInvoice, fetchInvoice, isGenuineWebhook } from "./moyasar.js";
import { generateAndStoreInvoice } from "../invoicing/generate.js";
import { processRefund } from "./refund.js";
import { requireUserAuth, requireVerifiedUser } from "../auth/middleware.js";

export const paymentsRouter = express.Router();

// Plan pricing/duration/features now live in the subscription_plans
// table (managed from the admin panel's Plans page) — NOT a hardcoded
// object anymore. This also resolves the "two independent sources of
// pricing" gap flagged in payments/README.md: the consumer app should
// call GET /api/payments/plans below instead of hardcoding its own
// `plans` array.
async function getActivePlan(planKey) {
  const { rows } = await query(
    `SELECT plan_key, name, price_sar, duration_days, features FROM subscription_plans WHERE plan_key = $1 AND is_active = true`,
    [planKey]
  );
  return rows[0] || null;
}

const BASE_URL = process.env.APP_BASE_URL || "http://localhost:5173";

/**
 * GET /api/payments/plans — public, unauthenticated. The consumer
 * app calls this to render pricing/features instead of hardcoding
 * its own list, so an admin editing a price on the Plans page takes
 * effect immediately everywhere, not just at checkout.
 */
paymentsRouter.get("/plans", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT plan_key, name, price_sar, duration_days, features
       FROM subscription_plans WHERE is_active = true ORDER BY display_order ASC`
    );
    res.json({ plans: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /api/payments/create-invoice  { planId }
 *
 * The gap this comment used to describe is now closed. userId came
 * from the request body, unverified, which meant anyone could bill
 * against any account id they cared to type. It now comes from
 * req.userId, set by requireVerifiedUser after validating the Bearer
 * token — the client no longer asserts who it is.
 *
 * requireVerifiedUser (not the lighter requireUserAuth) because this
 * route spends money: it re-checks that the account still exists,
 * isn't soft-deleted, and has a verified address, rather than
 * trusting a JWT that may be up to 15 minutes stale.
 */
paymentsRouter.post("/create-invoice", requireVerifiedUser, async (req, res) => {
  try {
    const { planId } = req.body || {};
    const userId = req.userId;
    const plan = await getActivePlan(planId);
    if (!plan) return res.status(400).json({ error: "valid_planId_required" });

    const invoiceId = await withTransaction(async (client) => {
      // Create our own pending row first so we have something to
      // reconcile against even if the Moyasar call fails partway.
      const { rows } = await client.query(
        `INSERT INTO invoices (user_id, plan_id, amount_sar, status) VALUES ($1, $2, $3, 'pending') RETURNING id`,
        [userId, planId, plan.price_sar]
      );
      return rows[0].id;
    });

    const invoice = await createInvoice({
      amountSar: Number(plan.price_sar),
      description: `اشتراك كنف+ — ${plan.name}`,
      callbackUrl: `${process.env.SERVER_BASE_URL || "http://localhost:3001"}/api/payments/webhook`,
      successUrl: `${BASE_URL}/subscription/success?invoice=${invoiceId}`,
      backUrl: `${BASE_URL}/subscription/canceled`,
    });

    await query(
      `UPDATE invoices SET provider_invoice_id = $1, checkout_url = $2, updated_at = now() WHERE id = $3`,
      [invoice.id, invoice.url, invoiceId]
    );

    res.status(201).json({ invoiceId, checkoutUrl: invoice.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * GET /api/payments/status/:invoiceId — the success/canceled redirect
 * pages poll this to show the right UI. This is a UX convenience
 * only — it must NEVER be the thing that marks a subscription active.
 * That happens exclusively in the webhook handler below, because a
 * browser redirect can be replayed or hit manually by a user without
 * ever actually paying.
 */
paymentsRouter.get("/status/:invoiceId", requireUserAuth, async (req, res) => {
  try {
    // Scoped to the owner now that ownership is knowable. Previously
    // any invoice's status and amount were readable by id alone —
    // survivable only because the ids are unguessable UUIDs, which is
    // obscurity rather than access control. Same 404 for "no such
    // invoice" and "not yours", so this can't be used to probe which
    // ids exist.
    const { rows } = await query(
      `SELECT id, status, amount_sar FROM invoices WHERE id = $1 AND user_id = $2`,
      [req.params.invoiceId, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /api/payments/webhook — the ONLY place a subscription actually
 * gets activated. Verifies isGenuineWebhook() (the real secret_token
 * check, not HMAC — see moyasar.js) before touching anything.
 */
paymentsRouter.post("/webhook", async (req, res) => {
  const body = req.body;

  if (!isGenuineWebhook(body)) {
    // Do not leak *why* it failed (wrong secret vs missing field) —
    // just reject. Logging the attempt server-side is fine.
    console.warn("Rejected webhook with invalid or missing secret_token");
    return res.status(401).json({ error: "invalid_webhook" });
  }

  try {
    const payment = body.data;
    const eventType = body.type;

    if (eventType === "payment_paid" || eventType === "payment_failed") {
      // The payment object doesn't directly carry our invoice UUID —
      // Moyasar payments made against an invoice reference it via
      // invoice_id (their invoice id, which we stored as
      // provider_invoice_id on our side).
      const providerInvoiceId = payment.invoice_id;
      if (!providerInvoiceId) {
        console.warn(`Webhook ${eventType} had no invoice_id — ignoring (not an invoice-based payment)`);
        return res.status(200).json({ ok: true }); // still 2xx — not a Moyasar-side problem, don't trigger their retry loop
      }

      const newStatus = eventType === "payment_paid" ? "paid" : "failed";

      await withTransaction(async (client) => {
        // Lock the row and check its CURRENT status BEFORE touching
        // anything. Payment providers (Moyasar included) use at-least-
        // once webhook delivery — the same event can genuinely arrive
        // twice. Without this check, a duplicate "payment_paid" would
        // extend the subscription period a second time (real money
        // given away for free) and silently issue a second legal
        // invoice number, orphaning the first — both confirmed by
        // testing before this fix existed.
        const { rows: lockedRows } = await client.query(
          `SELECT id, user_id, plan_id, amount_sar, status FROM invoices WHERE provider_invoice_id = $1 FOR UPDATE`,
          [providerInvoiceId]
        );
        const existingInvoice = lockedRows[0];
        if (!existingInvoice) {
          console.warn(`Webhook referenced unknown provider_invoice_id ${providerInvoiceId}`);
          return;
        }
        if (existingInvoice.status === "paid" || existingInvoice.status === "failed") {
          console.log(`Webhook for invoice ${existingInvoice.id} already processed (status=${existingInvoice.status}) — ignoring duplicate delivery, event id ${payment.id}`);
          return;
        }

        const { rows } = await client.query(
          `UPDATE invoices SET status = $1, provider_payment_id = $2, updated_at = now()
           WHERE provider_invoice_id = $3 RETURNING id, user_id, plan_id, amount_sar`,
          [newStatus, payment.id, providerInvoiceId]
        );
        const invoiceRow = rows[0];

        if (newStatus === "paid") {
          const { rows: planRows } = await client.query(
            `SELECT name, duration_days FROM subscription_plans WHERE plan_key = $1`,
            [invoiceRow.plan_id]
          );
          const plan = planRows[0];
          if (!plan) {
            console.error(`Paid invoice ${invoiceRow.id} references unknown plan_id ${invoiceRow.plan_id} — cannot activate subscription automatically, needs manual reconciliation`);
            return;
          }

          // One active subscription per user. If they already have
          // one, a renewal/upgrade EXTENDS from the later of "now" or
          // their current period end (so paying early doesn't lose
          // remaining paid time) rather than always resetting to
          // "today + plan length".
          const { rows: existing } = await client.query(
            `SELECT id, current_period_end FROM subscriptions WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
            [invoiceRow.user_id]
          );
          const baseDate = existing[0]?.current_period_end && new Date(existing[0].current_period_end) > new Date()
            ? new Date(existing[0].current_period_end)
            : new Date();
          const periodEnd = new Date(baseDate.getTime() + plan.duration_days * 24 * 60 * 60 * 1000);

          if (existing[0]) {
            await client.query(
              `UPDATE subscriptions SET plan_id = $1, current_period_end = $2, payment_provider = 'moyasar', updated_at = now() WHERE id = $3`,
              [invoiceRow.plan_id, periodEnd.toISOString(), existing[0].id]
            );
          } else {
            await client.query(
              `INSERT INTO subscriptions (user_id, plan_id, status, started_at, current_period_end, payment_provider)
               VALUES ($1, $2, 'active', now(), $3, 'moyasar')`,
              [invoiceRow.user_id, invoiceRow.plan_id, periodEnd.toISOString()]
            );
          }

          // Real ZATCA Simplified Tax Invoice — generated here, inside
          // the same transaction as the payment confirmation, so an
          // invoice number is never allocated for a payment that then
          // fails to record for some other reason.
          const { rows: userRows } = await client.query(`SELECT email FROM users WHERE id = $1`, [invoiceRow.user_id]);
          try {
            await generateAndStoreInvoice(
              {
                invoiceId: invoiceRow.id,
                userId: invoiceRow.user_id,
                planName: plan.name,
                totalSar: invoiceRow.amount_sar,
                buyerEmail: userRows[0]?.email,
              },
              client
            );
          } catch (invoiceErr) {
            // A failed PDF/QR generation must NOT roll back the
            // subscription activation the customer already paid for —
            // log loudly for manual follow-up instead of throwing.
            console.error(`Invoice document generation failed for paid invoice ${invoiceRow.id}:`, invoiceErr);
          }
        }
      });
    } else if (eventType === "payment_refunded") {
      // Real handling for the gap found during review: without this,
      // a refunded customer kept active access forever and no legal
      // credit note was ever issued.
      const providerPaymentId = payment.id;
      if (!providerPaymentId) {
        console.warn("payment_refunded webhook had no payment id — ignoring");
        return res.status(200).json({ ok: true });
      }

      await withTransaction(async (client) => {
        // Match on the payment id we stored when the invoice was
        // originally marked paid — more reliable for a refund event
        // than assuming invoice_id is present on this payload shape.
        const { rows: lockedRows } = await client.query(
          `SELECT id, user_id, plan_id, amount_sar, status FROM invoices WHERE provider_payment_id = $1 FOR UPDATE`,
          [providerPaymentId]
        );
        const invoiceRow = lockedRows[0];
        if (!invoiceRow) {
          console.warn(`Refund webhook referenced unknown provider_payment_id ${providerPaymentId}`);
          return;
        }

        const result = await processRefund({ invoiceRow, reason: "استرداد عبر بوابة الدفع", providerRefundId: payment.id }, client);
        if (result.alreadyRefunded) {
          console.log(`Invoice ${invoiceRow.id} already marked refunded — ignoring duplicate refund webhook`);
        }
      });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    // Still return 200 here is tempting to avoid Moyasar's retry
    // storm, but a genuine server error should be retried — so 500 is
    // correct; Moyasar will retry per their documented backoff.
    res.status(500).json({ error: "internal_error" });
  }
});
