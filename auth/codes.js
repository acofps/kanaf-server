import crypto from "crypto";
import bcrypt from "bcrypt";
import { query } from "../db/pool.js";

/* ---------------------------------------------------------
   Email verification codes, stored in Postgres.

   Replaces the in-memory Map that index.js used to keep. That Map
   had three failures, all of them silent: every Render redeploy wiped
   all pending codes; a second server instance would never see codes
   issued by the first; and the code sat in plaintext in process
   memory. The table fixes all three and adds the attempt counter the
   Map never had.
--------------------------------------------------------- */

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 5;
const BCRYPT_ROUNDS = 10; // lower than the password cost: this is checked on a hot path and dies in 10 minutes

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function isPlausibleEmail(email) {
  // Deliberately loose. Strict regexes reject valid addresses far more
  // often than they catch invalid ones, and the real proof that an
  // address works is that a code sent to it comes back.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/**
 * SIX digits via crypto.randomInt, not four via Math.random.
 *
 * Math.random is not cryptographically secure — its output is
 * predictable from prior values, so codes were guessable rather than
 * merely brute-forceable. And 4 digits is 10,000 possibilities, which
 * with no attempt limit falls in seconds. 6 digits plus the 5-attempt
 * cap below leaves a 1-in-200,000 chance per issued code.
 */
function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Rate check before sending. Returns { allowed } or
 * { allowed: false, reason, retryAfterSeconds }.
 *
 * This matters beyond abuse prevention: /api/send-code was previously
 * open with only the global 60-per-15-min per-IP limit, which is a
 * usable mail cannon pointed at arbitrary addresses. Every one of
 * those sends comes from mail.kanaf.me, and Gmail attributes the
 * resulting spam complaints to the domain's reputation — a plausible
 * contributor to the junk-folder problem, not just a security issue.
 *
 * Scoped per purpose so a signup cooldown can't block a password
 * reset. Sharing one window would mean someone mid-signup who then
 * needs a reset gets silently refused, and it would make the reset
 * response depend on unrelated signup activity for the same address.
 */
export async function checkSendRate(email, purpose = "signup") {
  const normalized = normalizeEmail(email);

  const { rows } = await query(
    `SELECT
       max(created_at) AS last_sent,
       count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS sent_last_hour
     FROM email_verification_codes
     WHERE LOWER(email) = $1 AND purpose = $2`,
    [normalized, purpose]
  );

  const { last_sent: lastSent, sent_last_hour: sentLastHour } = rows[0];

  if (lastSent) {
    const elapsedSeconds = (Date.now() - new Date(lastSent).getTime()) / 1000;
    if (elapsedSeconds < RESEND_COOLDOWN_SECONDS) {
      return {
        allowed: false,
        reason: "cooldown",
        retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsedSeconds),
      };
    }
  }

  if (sentLastHour >= MAX_SENDS_PER_HOUR) {
    return { allowed: false, reason: "hourly_limit", retryAfterSeconds: 3600 };
  }

  return { allowed: true };
}

/**
 * Issues a code and returns the plaintext for the caller to email.
 * Any earlier live code for the address is consumed first, so only
 * the newest code ever works — otherwise requesting a resend would
 * widen the guessing surface instead of replacing it.
 */
export async function issueCode(email, purpose = "signup") {
  const normalized = normalizeEmail(email);
  const code = generateCode();
  const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

  await query(
    `UPDATE email_verification_codes SET consumed_at = now()
     WHERE LOWER(email) = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [normalized, purpose]
  );

  await query(
    `INSERT INTO email_verification_codes (email, code_hash, purpose, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [normalized, codeHash, purpose, expiresAt.toISOString()]
  );

  return { code, expiresAt, ttlMinutes: CODE_TTL_MINUTES };
}

/**
 * Checks a submitted code. Returns { ok } or { ok: false, reason }
 * where reason is one of: no_code, expired, too_many_attempts,
 * incorrect. A wrong guess increments the counter; hitting the cap
 * kills the code outright so the user must request a new one.
 */
export async function checkCode(email, submittedCode, purpose = "signup") {
  const normalized = normalizeEmail(email);

  if (!submittedCode || !/^\d{4,8}$/.test(String(submittedCode).trim())) {
    return { ok: false, reason: "incorrect" };
  }

  const { rows } = await query(
    `SELECT id, code_hash, attempts, expires_at
     FROM email_verification_codes
     WHERE LOWER(email) = $1 AND purpose = $2 AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [normalized, purpose]
  );

  const entry = rows[0];
  if (!entry) return { ok: false, reason: "no_code" };

  if (new Date(entry.expires_at) < new Date()) {
    await query(`UPDATE email_verification_codes SET consumed_at = now() WHERE id = $1`, [entry.id]);
    return { ok: false, reason: "expired" };
  }

  if (entry.attempts >= MAX_ATTEMPTS) {
    await query(`UPDATE email_verification_codes SET consumed_at = now() WHERE id = $1`, [entry.id]);
    return { ok: false, reason: "too_many_attempts" };
  }

  const matches = await bcrypt.compare(String(submittedCode).trim(), entry.code_hash);

  if (!matches) {
    const { rows: updated } = await query(
      `UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
      [entry.id]
    );
    const attempts = updated[0].attempts;
    if (attempts >= MAX_ATTEMPTS) {
      await query(`UPDATE email_verification_codes SET consumed_at = now() WHERE id = $1`, [entry.id]);
      return { ok: false, reason: "too_many_attempts" };
    }
    return { ok: false, reason: "incorrect", attemptsLeft: MAX_ATTEMPTS - attempts };
  }

  await query(`UPDATE email_verification_codes SET consumed_at = now() WHERE id = $1`, [entry.id]);
  return { ok: true };
}

export const CODE_CONSTANTS = {
  CODE_TTL_MINUTES,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_SECONDS,
  MAX_SENDS_PER_HOUR,
};
