import crypto from "crypto";

function getSecret() {
  // Reuses ADMIN_JWT_SECRET as a fallback only to avoid requiring yet
  // another env var for a small app — for a larger deployment, set a
  // dedicated UNSUBSCRIBE_SECRET instead so rotating one doesn't
  // invalidate the other.
  const secret = process.env.UNSUBSCRIBE_SECRET || process.env.ADMIN_JWT_SECRET;
  if (!secret) throw new Error("UNSUBSCRIBE_SECRET or ADMIN_JWT_SECRET must be set to generate unsubscribe links");
  return secret;
}

export function generateUnsubscribeToken(userId) {
  const sig = crypto.createHmac("sha256", getSecret()).update(userId).digest("hex");
  return `${userId}.${sig}`;
}

/**
 * Returns the userId if the token is genuine, or null if it's
 * missing, malformed, or tampered with. Constant-time comparison so
 * response timing doesn't leak how much of the signature matched.
 */
export function verifyUnsubscribeToken(token) {
  const [userId, sig] = String(token || "").split(".");
  if (!userId || !sig) return null;

  const expected = crypto.createHmac("sha256", getSecret()).update(userId).digest("hex");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  return userId;
}
