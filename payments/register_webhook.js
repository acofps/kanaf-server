// Run ONCE per environment (test key, then again with the live key
// once you switch over) — this registers your server's webhook URL
// with Moyasar so they know where to send payment_paid/payment_failed
// notifications.
//
//   node payments/register_webhook.js https://yourdomain.com/api/payments/webhook
//
// PAYMENT_SECRET_KEY and PAYMENT_WEBHOOK_SECRET must already be set
// in .env — this script reuses PAYMENT_WEBHOOK_SECRET as the
// shared_secret Moyasar will embed in every webhook body, which is
// exactly what payments/moyasar.js:isGenuineWebhook() checks against.
import "dotenv/config";
import { createWebhook } from "./moyasar.js";

const url = process.argv[2];
if (!url || !url.startsWith("https://")) {
  console.error("Usage: node payments/register_webhook.js https://yourdomain.com/api/payments/webhook");
  console.error("The URL must be HTTPS — Moyasar will not deliver webhooks to a plain http:// endpoint in live mode.");
  process.exit(1);
}
if (!process.env.PAYMENT_WEBHOOK_SECRET) {
  console.error("Set PAYMENT_WEBHOOK_SECRET in .env first — generate one with: openssl rand -hex 24");
  process.exit(1);
}

const webhook = await createWebhook({
  url,
  sharedSecret: process.env.PAYMENT_WEBHOOK_SECRET,
  events: ["payment_paid", "payment_failed"],
});

console.log("Webhook registered:", webhook);
console.log("\nDouble-check this in the Moyasar dashboard under Developers → Webhooks.");
