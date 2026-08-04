// Bulk broadcast email via Resend's batch endpoint. Verified against
// Resend's own docs before writing this — two facts that matter here:
//
// 1. Resend enforces 2 requests/second across ALL endpoints. A naive
//    loop calling the single-send endpoint once per recipient hits
//    this almost immediately for any real audience size.
// 2. Resend has a real batch endpoint (POST /emails/batch) that
//    accepts up to 100 distinct messages per call — each with its own
//    `to` array, so recipients never see each other's addresses (this
//    is NOT a "CC everyone" pattern).
//
// This module chunks the audience into batches of 100 and spaces
// batch calls out to stay safely under the rate limit.
import { generateUnsubscribeToken } from "./unsubscribe.js";

const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";
const BATCH_SIZE = 100;
const DELAY_BETWEEN_BATCHES_MS = 600; // 2 req/sec limit → >500ms apart; padded for safety

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wraps a plain-text broadcast message in a minimal RTL HTML shell,
 * with a real, working unsubscribe link — the gap a strict review
 * found: bulk marketing email with no opt-out mechanism at all.
 * `unsubscribeUrl` is per-recipient (carries their own signed token),
 * so this function is called once per recipient, not once per batch.
 */
function wrapAsHtml(subject, plainTextMessage, unsubscribeUrl) {
  const escaped = escapeHtml(plainTextMessage).replace(/\n/g, "<br>");
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<body style="font-family: Arial, sans-serif; direction: rtl; text-align: right; background: #f4f6f6; padding: 24px;">
  <div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; border: 1px solid #e0e6e6;">
    <h2 style="color: #0D5C6B; margin-top: 0;">${escapeHtml(subject)}</h2>
    <p style="color: #333; line-height: 1.8; font-size: 14px;">${escaped}</p>
  </div>
  <p style="text-align: center; font-size: 11px; color: #999; margin-top: 16px;">
    <a href="${unsubscribeUrl}" style="color: #999;">إلغاء الاشتراك من هذي الرسائل</a>
  </p>
</body>
</html>`;
}

async function sendBatch(messages) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[dev] Would batch-send ${messages.length} emails (no RESEND_API_KEY set)`);
    return messages.map(() => ({ id: "dev-mock" }));
  }

  const res = await fetch(RESEND_BATCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      messages.map((m) => ({
        from: process.env.EMAIL_FROM || "Kanaf <noreply@example.com>",
        to: [m.to],
        subject: m.subject,
        html: m.html,
      }))
    ),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`Resend batch send failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }
  const { data } = await res.json();
  return data;
}

/**
 * Sends `subject`/`plainTextMessage` to every recipient, each with
 * their OWN unsubscribe link. `recipients` is now [{ email, userId }],
 * not plain email strings — userId is required to sign a real
 * unsubscribe token per person, not a shared/guessable one.
 *
 * Chunked and rate-limited; never throws for individual batch
 * failures, so one bad chunk doesn't abort the rest of a large
 * broadcast — failures are collected and returned instead.
 */
export async function sendBroadcast({ recipients, subject, plainTextMessage }) {
  const baseUrl = process.env.SERVER_BASE_URL || "http://localhost:3001";
  let sent = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const chunk = recipients.slice(i, i + BATCH_SIZE);
    try {
      const messages = chunk.map((r) => {
        const token = generateUnsubscribeToken(r.userId);
        const unsubscribeUrl = `${baseUrl}/api/unsubscribe?token=${encodeURIComponent(token)}`;
        return { to: r.email, subject, html: wrapAsHtml(subject, plainTextMessage, unsubscribeUrl) };
      });
      const data = await sendBatch(messages);
      sent += data.length;
    } catch (err) {
      failed += chunk.length;
      errors.push(err.message);
      console.error(`Broadcast batch [${i}-${i + chunk.length}] failed:`, err);
    }
    if (i + BATCH_SIZE < recipients.length) await sleep(DELAY_BETWEEN_BATCHES_MS);
  }

  return { sent, failed, errors };
}
