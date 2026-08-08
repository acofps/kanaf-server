import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { query } from "../db/pool.js";

/* ---------------------------------------------------------
   A SEPARATE secret from ADMIN_JWT_SECRET — deliberately, and this
   is not optional. jwt.verify() authenticates a token by its signing
   secret alone. If both layers signed with the same secret, an
   ordinary app user's token would be a structurally valid admin
   token, and requireAdminAuth would accept it. The `aud` claim below
   is a second, independent guard on the same failure.
--------------------------------------------------------- */
const JWT_SECRET = process.env.USER_JWT_SECRET;
const ACCESS_EXPIRES_IN = process.env.USER_JWT_EXPIRES_IN || "15m";
const REFRESH_DAYS = Number(process.env.USER_REFRESH_EXPIRES_DAYS || 30);
const AUDIENCE = "kanaf-consumer";

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error(
    "FATAL: USER_JWT_SECRET is missing or too short (need 32+ chars). " +
    "Generate one: openssl rand -hex 32 — and set it as its own env var. " +
    "It must NOT be the same value as ADMIN_JWT_SECRET."
  );
  process.exit(1);
}

if (JWT_SECRET === process.env.ADMIN_JWT_SECRET) {
  console.error(
    "FATAL: USER_JWT_SECRET is identical to ADMIN_JWT_SECRET. Any signed-in " +
    "app user would hold a token that passes admin verification. Generate a " +
    "second, independent secret."
  );
  process.exit(1);
}

const BCRYPT_ROUNDS = 12;

/* ---------------------------------------------------------
   Password rules.

   The 72-BYTE ceiling is the important one and it is not cosmetic:
   bcrypt truncates its input at 72 bytes and does so SILENTLY. In
   UTF-8 an Arabic letter is 2 bytes, so a 40-character Arabic
   passphrase is ~80 bytes — meaning two different passwords sharing
   their first 72 bytes would both unlock the account, with no error
   anywhere. Measured in bytes, never in characters.
--------------------------------------------------------- */
const MIN_PASSWORD_CHARS = 8;
const MAX_PASSWORD_BYTES = 72;

/* ---------------------------------------------------------
   ثمانية أحرف فأكثر، وبلا أي قاعدة تركيب: لا حرف كبير ولا رمز ولا
   رقم إجباري. المستخدم يكتب ما يريد.

   هذا اختيار مقصود لا تساهل. قواعد التركيب تدفع الناس إلى أنماط
   متوقعة مثل "Password1!" — أقصر فعلياً وأسهل تخميناً من عبارة
   طويلة بسيطة، وتزيد نسيان كلمة المرور بلا مقابل أمني حقيقي. وهذا
   ما توصي به NIST SP 800-63B صراحةً: الطول وقائمة المنع، لا
   التركيب.
--------------------------------------------------------- */
const OBVIOUS_PASSWORDS = new Set([
  "password", "12345678", "123456789", "1234567890", "qwertyui", "qwerty123",
  "11111111", "00000000", "iloveyou", "password1", "abc12345", "1q2w3e4r",
  "qwertyuiop", "letmein1", "welcome1", "sunshine", "princess", "football",
  "trustno1", "iloveyou1", "kanaf123", "12345678a", "a12345678",
]);

export function validatePassword(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length < MIN_PASSWORD_CHARS) {
    return { ok: false, error: "password_too_short", minChars: MIN_PASSWORD_CHARS };
  }
  if (Buffer.byteLength(plaintext, "utf8") > MAX_PASSWORD_BYTES) {
    return { ok: false, error: "password_too_long", maxBytes: MAX_PASSWORD_BYTES };
  }
  if (OBVIOUS_PASSWORDS.has(plaintext.toLowerCase())) {
    return { ok: false, error: "password_too_common" };
  }
  if (new Set(plaintext).size === 1) {
    return { ok: false, error: "password_too_common" };
  }
  return { ok: true };
}

export async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

/**
 * A bcrypt hash of a value nobody knows, computed once at boot.
 * comparePassword() runs against this when the account doesn't exist,
 * so a request for an unknown email takes the same ~250ms as one for
 * a known email with a wrong password. Without it, response latency
 * alone tells an attacker which addresses have accounts — which, for
 * a mental-health app, leaks something more sensitive than a login.
 */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), BCRYPT_ROUNDS);

export async function comparePassword(plaintext, storedHash) {
  if (!storedHash) {
    await bcrypt.compare(plaintext || "", DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(plaintext || "", storedHash);
}

/* ---------------------------------------------------------
   Access token — short-lived JWT, sent as:
     Authorization: Bearer <token>

   Header rather than cookie because the app (app.kanaf.me) and this
   API (kanaf-server.onrender.com) are different sites. SameSite=Strict
   cookies are never sent cross-site — the exact failure that broke the
   admin panel copy on cPanel. SameSite=None would technically work but
   is now blocked outright by Safari's tracking prevention and is being
   phased out in Chrome. A Bearer header sidesteps all of it, and CSRF
   with it: a cross-site form post can't set an Authorization header.
--------------------------------------------------------- */
export function issueAccessToken(user) {
  return jwt.sign(
    { sub: user.id, type: "access", aud: AUDIENCE },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES_IN }
  );
}

export function verifyAccessToken(token) {
  // Throws on invalid/expired — callers must try/catch.
  const payload = jwt.verify(token, JWT_SECRET, { audience: AUDIENCE });
  if (payload.type !== "access") throw new Error("wrong_token_type");
  return payload;
}

/* ---------------------------------------------------------
   Refresh token — opaque random string, NOT a JWT.

   Stored server-side as a SHA-256 hash so that logout is a real
   server-side revocation rather than a request that the client
   please forget something. The plaintext is returned to the caller
   exactly once and is never recoverable from the database.
--------------------------------------------------------- */
function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueRefreshToken(userId, { userAgent = null, ipAddress = null } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO user_sessions (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hashRefreshToken(token), userAgent?.slice(0, 300) || null, ipAddress, expiresAt.toISOString()]
  );
  return token;
}

/**
 * Validates a refresh token and rotates it: the presented token is
 * revoked and a fresh one issued. Rotation means a stolen refresh
 * token is usable at most once, and the theft becomes detectable —
 * the legitimate client's next refresh fails against an already
 * revoked row.
 */
export async function rotateRefreshToken(token, context = {}) {
  if (!token || typeof token !== "string") return null;

  const { rows } = await query(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.deleted_at
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashRefreshToken(token)]
  );
  const session = rows[0];
  if (!session) return null;
  if (session.revoked_at) return null;
  if (session.deleted_at) return null;
  if (new Date(session.expires_at) < new Date()) return null;

  await query(`UPDATE user_sessions SET revoked_at = now(), last_used_at = now() WHERE id = $1`, [session.id]);
  const fresh = await issueRefreshToken(session.user_id, context);
  return { userId: session.user_id, refreshToken: fresh };
}

export async function revokeRefreshToken(token) {
  if (!token || typeof token !== "string") return;
  await query(
    `UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashRefreshToken(token)]
  );
}

/** Ends every session for a user — used after a password change. */
export async function revokeAllUserSessions(userId) {
  await query(
    `UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

export const ACCESS_TOKEN_TTL = ACCESS_EXPIRES_IN;
