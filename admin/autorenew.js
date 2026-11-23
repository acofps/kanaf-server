import express from "express";
import { query, withTransaction } from "../db/pool.js";
import { requireAdminAuth, requirePermission, requireUuidParam, logAdminAction, fail } from "./middleware.js";
import { revokeConsent, autorenewSettings } from "../billing/autorenew.js";
import { autorenewEnabled } from "../billing/payment-methods.js";

/* ============================================================
   التجديد التلقائي في اللوحة — KANAF-ORD-0013 §7.8
   العرض: subscriptions:view. الإيقاف (بسبب، يُسجَّل بالقيمتين): subscriptions:edit.
   البطاقة تُعرض بعلامتها وآخر أربعة أرقامها وحدهما — الرمز لا يخرج من الخادم.
   ============================================================ */
export const adminAutorenewRouter = express.Router();

async function userAutorenew(userId) {
  const { rows: consents } = await query(
    `SELECT c.id, c.consent_version, c.consent_text, c.plan_key, c.amount_sar, c.granted_at, c.revoked_at, c.revoked_by, c.revoke_reason,
            au.name AS revoked_by_admin_name
       FROM autorenew_consents c LEFT JOIN admin_users au ON au.id = c.revoked_by_admin
      WHERE c.user_id = $1 ORDER BY c.granted_at DESC LIMIT 10`, [userId]);
  const { rows: cards } = await query(
    `SELECT card_brand AS brand, card_last4 AS last4, created_at, removed_at FROM payment_methods WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`, [userId]);
  const { rows: cycles } = await query(
    `SELECT rc.cycle_key, rc.period_end, rc.plan_key, rc.amount_sar, rc.status, rc.attempts, rc.notice_sent_at, rc.next_attempt_at, rc.last_error,
            i.zatca_invoice_number AS invoice_number,
            COALESCE((SELECT json_agg(json_build_object('no', a.attempt_no, 'status', a.status, 'code', a.failure_code, 'at', a.started_at) ORDER BY a.attempt_no)
                        FROM renewal_attempts a WHERE a.cycle_key = rc.cycle_key), '[]') AS attempts_log
       FROM renewal_cycles rc LEFT JOIN invoices i ON i.id = rc.invoice_id
      WHERE rc.user_id = $1 ORDER BY rc.created_at DESC LIMIT 12`, [userId]);
  return { enabled: autorenewEnabled(), active: consents.find((c) => !c.revoked_at) || null, consents, cards, cycles };
}

adminAutorenewRouter.get("/users/:id/autorenew", requireAdminAuth, requirePermission("subscriptions:view"), requireUuidParam("id"), async (req, res) => {
  try { res.json(await userAutorenew(req.params.id)); }
  catch (err) { return fail(res, err, "admin/autorenew:user", req); }
});

adminAutorenewRouter.post("/users/:id/autorenew/disable", requireAdminAuth, requirePermission("subscriptions:edit"), requireUuidParam("id"), async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "reason_required" });
  try {
    const r = await withTransaction((client) => revokeConsent(req.params.id, { by: "admin", adminId: req.admin.id, reason }, client));
    if (!r.revoked) return res.status(409).json({ error: "autorenew_not_active" });
    await logAdminAction({
      adminUserId: req.admin.id, action: "autorenew_disable", entity: "user", entityId: req.params.id, targetUserId: req.params.id,
      oldValue: { autorenew: "active", consent_version: r.consent.consent_version, plan_key: r.consent.plan_key, granted_at: r.consent.granted_at },
      newValue: { autorenew: "disabled_by_admin" }, reason, ipAddress: req.ip,
    });
    res.json({ ok: true });
  } catch (err) { return fail(res, err, "admin/autorenew:disable", req); }
});

// GET /admin/autorenew?status=&page= — الدورات عبر كل الأعضاء (المتعثّرة والمجهولة أولاً لمن يراجع)
adminAutorenewRouter.get("/autorenew", requireAdminAuth, requirePermission("subscriptions:view"), async (req, res) => {
  const STATUSES = ["noticed", "charging", "retry", "succeeded", "stopped", "cancelled", "unknown"];
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1), size = 50;
  try {
    const where = status ? `WHERE rc.status = $1` : `WHERE ($1::text IS NULL)`;
    const { rows: [{ n }] } = await query(`SELECT count(*)::int n FROM renewal_cycles rc ${where}`, [status]);
    const { rows } = await query(
      `SELECT rc.cycle_key, rc.user_id, u.name AS user_name, u.deleted_at IS NOT NULL AS user_deleted, rc.plan_key, rc.amount_sar, rc.period_end,
              rc.status, rc.attempts, rc.next_attempt_at, rc.last_error, rc.updated_at, i.zatca_invoice_number AS invoice_number
         FROM renewal_cycles rc JOIN users u ON u.id = rc.user_id LEFT JOIN invoices i ON i.id = rc.invoice_id
         ${where}
        ORDER BY (rc.status IN ('unknown', 'stopped', 'retry')) DESC, rc.updated_at DESC LIMIT ${size} OFFSET $2`, [status, (page - 1) * size]);
    const { rows: [counts] } = await query(
      `SELECT (SELECT count(*)::int FROM autorenew_consents WHERE revoked_at IS NULL) AS active_consents,
              (SELECT count(*)::int FROM renewal_cycles WHERE status = 'unknown') AS unknown_cycles`);
    res.json({ enabled: autorenewEnabled(), settings: await autorenewSettings(), counts, cycles: rows, total: n, page, totalPages: Math.max(1, Math.ceil(n / size)) });
  } catch (err) { return fail(res, err, "admin/autorenew:list", req); }
});
