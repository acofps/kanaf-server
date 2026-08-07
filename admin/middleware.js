import { verifyToken } from "./auth.js";
import { query } from "../db/pool.js";

// Ordered weakest to strongest — used by requireRole() to allow any
// role at or above the one specified, not just an exact match.
const ROLE_RANK = { support: 1, content_manager: 2, admin: 3, owner: 4 };

/**
 * Verifies the httpOnly `kanaf_admin_access` cookie holds a valid,
 * unexpired admin ACCESS token (not a refresh token — those can only
 * be used at POST /admin/auth/refresh). Attaches req.admin = { id, role }.
 *
 * Deliberately NOT reading an Authorization header anymore — the token
 * lives only in an httpOnly cookie the frontend's JS can never read,
 * which is the actual point of this change (removes the XSS-exposure
 * gap noted in marsa-admin/README.md).
 */
export function requireAdminAuth(req, res, next) {
  const token = req.cookies?.kanaf_admin_access;
  if (!token) return res.status(401).json({ error: "missing_token" });

  try {
    const payload = verifyToken(token);
    if (payload.type !== "access") return res.status(401).json({ error: "wrong_token_type" });
    req.admin = { id: payload.sub, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: "invalid_or_expired_token" });
  }
}

/**
 * Use after requireAdminAuth. Rejects unless req.admin.role is at
 * least `minRole` on the ROLE_RANK scale.
 *   router.get("/stats", requireAdminAuth, requireRole("admin"), handler)
 */
export function requireRole(minRole) {
  const minRank = ROLE_RANK[minRole];
  return (req, res, next) => {
    const rank = ROLE_RANK[req.admin?.role];
    if (!rank || rank < minRank) {
      return res.status(403).json({ error: "insufficient_role", required: minRole });
    }
    next();
  };
}

/**
 * Writes one row to admin_access_log. Call this from inside a route
 * handler BEFORE returning sensitive data — never after, so a crash
 * can't let data out without a matching log entry.
 *
 * There is deliberately no corresponding "updateAccessLog" or
 * "deleteAccessLog" function anywhere in this codebase — the log is
 * insert-only by design (see schema.sql design note #2).
 */
export async function logSensitiveAccess({ adminUserId, targetUserId = null, action, reason, ipAddress = null }) {
  if (!reason || !reason.trim()) {
    throw new Error("logSensitiveAccess: a non-empty reason is required");
  }
  await query(
    `INSERT INTO admin_access_log (admin_user_id, target_user_id, action, reason, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [adminUserId, targetUserId, action, reason.trim(), ipAddress]
  );
}

/**
 * Writes one row to admin_action_log — the MUTATION log, as opposed
 * to logSensitiveAccess above which records reads.
 *
 * Call this AFTER the database change succeeds, inside the same
 * try block, so a failed update never leaves a log entry claiming it
 * happened. That is the opposite of the read logger's ordering, and
 * deliberately so: for reads the risk is data escaping unlogged, for
 * writes the risk is the log claiming a change that was rolled back.
 *
 * `oldValue`/`newValue` are stored as JSONB. Never put password
 * hashes, tokens, PINs, or journal content in them — the log is
 * readable by owners and is not the place for secrets.
 */
export async function logAdminAction({
  adminUserId, targetUserId = null, action, oldValue = null,
  newValue = null, reason, metadata = null, ipAddress = null,
}) {
  if (!reason || !String(reason).trim()) {
    throw new Error("logAdminAction: a non-empty reason is required");
  }
  await query(
    `INSERT INTO admin_action_log
       (admin_user_id, target_user_id, action, old_value, new_value, reason, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      adminUserId, targetUserId, action,
      oldValue === null ? null : JSON.stringify(oldValue),
      newValue === null ? null : JSON.stringify(newValue),
      String(reason).trim(),
      metadata === null ? null : JSON.stringify(metadata),
      ipAddress,
    ]
  );
}

/**
 * Express middleware factory: requires a non-empty `reason` field in
 * the request body, and logs the access automatically once the route
 * handler calls next(). Use on any route that returns raw sensitive
 * data (daily_logs.note, screenings.answers, etc).
 *
 *   router.get("/users/:id/sensitive", requireAdminAuth,
 *     requireReasonAndLog("view_sensitive_data"), handler)
 */
export function requireReasonAndLog(action) {
  return async (req, res, next) => {
    const reason = req.body?.reason || req.query?.reason;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: "reason_required", message: "لازم تكتب سبب قبل ما تشوف بيانات حساسة." });
    }
    try {
      await logSensitiveAccess({
        adminUserId: req.admin.id,
        targetUserId: req.params.userId || req.params.id || null,
        action,
        reason: String(reason),
        ipAddress: req.ip,
      });
      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "audit_log_failed" });
    }
  };
}
