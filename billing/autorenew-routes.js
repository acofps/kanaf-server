import express from "express";
import { query, withTransaction } from "../db/pool.js";
import { requireVerifiedUser } from "../auth/middleware.js";
import { autorenewStatus, grantConsent, revokeConsent } from "./autorenew.js";

/* ============================================================
   واجهة العضو للتجديد التلقائي — KANAF-ORD-0013 §7.2 و§7.7
   العقد موثَّق في docs/ord-0013/APP_AUTORENEW_SPEC.md (§4) — أي تغيير هنا يغيّره.

   GET    /api/billing/autorenew           الحالة + عرض الموافقة إن كان العضو مؤهَّلاً
   POST   /api/billing/autorenew/consent   { consentVersion, amountSar }  → 201
   POST   /api/billing/autorenew/cancel    → 200 دائماً (ولو لم يكن مفعَّلاً، ولو كان المفتاح معطَّلاً)
   DELETE /api/billing/autorenew/card      إزالة البطاقة المحفوظة (يلغي التجديد معها)
   ============================================================ */
export const autorenewRouter = express.Router();

autorenewRouter.get("/", requireVerifiedUser, async (req, res) => {
  try { res.json(await autorenewStatus(req.userId)); }
  catch (err) { console.error("[autorenew] status:", err?.code || "error"); res.status(500).json({ error: "internal_error" }); }
});

autorenewRouter.post("/consent", requireVerifiedUser, async (req, res) => {
  const { consentVersion, amountSar } = req.body || {};
  if (typeof consentVersion !== "string" || amountSar === undefined) return res.status(400).json({ error: "consent_fields_required" });
  try {
    const r = await grantConsent(req.userId, { consentVersion, amountSar: Number(amountSar) });
    if (r.error) return res.status(r.status).json({ error: r.error, ...(r.detail ? { detail: r.detail } : {}) });
    res.status(201).json({ ok: true, consent: { version: r.consent.consent_version, text: r.consent.consent_text, grantedAt: r.consent.granted_at } });
  } catch (err) { console.error("[autorenew] consent:", err?.code || "error"); res.status(500).json({ error: "internal_error" }); }
});

autorenewRouter.post("/cancel", requireVerifiedUser, async (req, res) => {
  try {
    const r = await revokeConsent(req.userId, { by: "member", reason: "cancelled_in_app" });
    const { rows } = await query(`SELECT current_period_end FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [req.userId]);
    res.json({ ok: true, wasActive: r.revoked, subscriptionEndsAt: rows[0]?.current_period_end || null });
  } catch (err) { console.error("[autorenew] cancel:", err?.code || "error"); res.status(500).json({ error: "internal_error" }); }
});

autorenewRouter.delete("/card", requireVerifiedUser, async (req, res) => {
  try {
    const out = await withTransaction(async (client) => {
      const r = await revokeConsent(req.userId, { by: "member", reason: "card_removed" }, client);
      const { rowCount } = await client.query(`UPDATE payment_methods SET removed_at = now() WHERE user_id = $1 AND removed_at IS NULL`, [req.userId]);
      return { cardRemoved: rowCount > 0, autorenewCancelled: r.revoked };
    });
    res.json({ ok: true, ...out });
  } catch (err) { console.error("[autorenew] card:", err?.code || "error"); res.status(500).json({ error: "internal_error" }); }
});
