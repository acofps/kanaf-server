import { verifyAccessToken } from "./tokens.js";
import { query } from "../db/pool.js";

/**
 * Gate for any route that acts on behalf of a signed-in app user.
 * Mirrors admin/middleware.js requireAdminAuth, with two differences:
 * the token arrives in the Authorization header rather than a cookie
 * (see the note in auth/tokens.js on why), and it is verified with
 * USER_JWT_SECRET, so an admin token cannot satisfy it either.
 *
 * On success sets req.userId. Routes must read the user identity from
 * THERE and never from the request body — the whole point of this
 * middleware is that the client stops asserting who it is.
 */
export function requireUserAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "unauthenticated" });
  }

  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.sub;
    return next();
  } catch (err) {
    // Distinguished so the app knows to attempt a silent refresh
    // rather than bouncing the user to the login screen.
    const expired = err?.name === "TokenExpiredError";
    return res.status(401).json({ error: expired ? "token_expired" : "invalid_token" });
  }
}

/**
 * Stricter variant: also confirms the row still exists, isn't
 * soft-deleted, and is email-verified. Costs one query, so it's kept
 * separate from requireUserAuth rather than folded in — use it on
 * anything that spends money, changes account state, or exposes
 * personal data. A 15-minute access token outlives an account
 * deletion by up to 15 minutes otherwise.
 */
export async function requireVerifiedUser(req, res, next) {
  requireUserAuth(req, res, async () => {
    try {
      const { rows } = await query(
        `SELECT id, email, email_verified_at FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [req.userId]
      );
      const user = rows[0];
      if (!user) return res.status(401).json({ error: "account_not_found" });
      if (!user.email_verified_at) return res.status(403).json({ error: "email_not_verified" });
      req.user = user;
      return next();
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "internal_error" });
    }
  });
}
