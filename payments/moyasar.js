// Moyasar integration. Verified against Moyasar's own current docs
// before writing this (docs.moyasar.com) rather than assumed —
// two details that are easy to get wrong from memory/generic
// payment-gateway patterns:
//
// 1. Auth is HTTP Basic with the secret key as the username and an
//    EMPTY password (`-u sk_xxx:`) — not a Bearer token.
// 2. Webhook verification is NOT an HMAC signature header. Moyasar
//    embeds a `secret_token` field directly in the webhook's JSON
//    body, which you compare against the `shared_secret` you set
//    when registering the webhook. A generic "compute HMAC-SHA256 of
//    the raw body" implementation (the default assumption for most
//    payment gateways) would NOT work here and would silently accept
//    forged webhooks if built that way.

const MOYASAR_API_BASE = "https://api.moyasar.com/v1";

function authHeader() {
  const key = process.env.PAYMENT_SECRET_KEY;
  if (!key) throw new Error("PAYMENT_SECRET_KEY is not set");
  // HTTP Basic auth: "secret_key:" (empty password), base64-encoded.
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

async function moyasarRequest(path, { method = "GET", body } = {}) {
  const res = await fetch(`${MOYASAR_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || `Moyasar request failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

/**
 * Creates a hosted-checkout invoice. The `url` in the response is
 * where you redirect the payer — Moyasar hosts the actual card form,
 * so this app never sees a card number, which keeps it out of
 * PCI-DSS scope entirely (the alternative — embedding Moyasar's card
 * widget yourself — still avoids raw PAN handling but is more surface
 * area to get right; the hosted page is the simpler, safer default
 * for a first integration).
 *
 * amountSar: a plain number of Saudi Riyals (e.g. 29.00) — this
 * function does the halala conversion (SAR × 100) so callers never
 * have to remember Moyasar wants the smallest currency unit.
 */
export async function createInvoice({ amountSar, description, callbackUrl, successUrl, backUrl, expiresAt }) {
  const amountHalalas = Math.round(amountSar * 100);
  return moyasarRequest("/invoices", {
    method: "POST",
    body: {
      amount: amountHalalas,
      currency: "SAR",
      description,
      callback_url: callbackUrl,
      success_url: successUrl,
      back_url: backUrl,
      ...(expiresAt ? { expired_at: expiresAt } : {}),
    },
  });
}

export async function fetchInvoice(invoiceId) {
  return moyasarRequest(`/invoices/${invoiceId}`);
}

/**
 * Registers a real Moyasar webhook against your account. Run this
 * ONCE per environment (test/live), not on every server start — see
 * payments/README.md for the one-time setup command. Exported here
 * so the setup script can reuse the same authenticated request logic.
 */
export async function createWebhook({ url, sharedSecret, events }) {
  return moyasarRequest("/webhooks", {
    method: "POST",
    body: { http_method: "post", url, shared_secret: sharedSecret, events },
  });
}

/**
 * Verifies an incoming webhook is genuinely from Moyasar. Per their
 * actual mechanism, this is a direct comparison of the `secret_token`
 * field embedded in the webhook body against the shared secret you
 * configured — NOT a cryptographic signature. Still use a
 * constant-time comparison to avoid leaking timing information about
 * how much of the secret matched, same discipline as if it were HMAC.
 */
export function isGenuineWebhook(webhookBody) {
  const expected = process.env.PAYMENT_WEBHOOK_SECRET || "";
  const received = webhookBody?.secret_token || "";
  if (!expected || !received) return false;
  return timingSafeEqualStrings(expected, received);
}

function timingSafeEqualStrings(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
