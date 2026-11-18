import express from "express";
import { query } from "../db/pool.js";
import { requireAdminAuth, requirePermission, requireUuidParam, logAdminAction, fail } from "./middleware.js";
import { readPaging } from "./filters.js";
import { validateDiscountInput, checkDiscountCode } from "../billing/discounts.js";

/* ============================================================
   أكواد الخصم — KANAF-ORD-0008 §6 (الجدول والصفحة والتحقق فقط)

   🔴 غير مربوطة بمسار الدفع ولا بالفاتورة. لا مسار للمستخدم يقبل كوداً،
   ولا شيء في payments/ يقرأ هذه الجداول. «فحص كود» هنا معاينة للمسؤول.
   كل كتابة بسبب مكتوب في سجل الإجراءات.
   ============================================================ */

export const discountsRouter = express.Router();

const reasonOf = (req) => String(req.body?.reason || "").trim();

// GET /admin/discount-codes
discountsRouter.get("/discount-codes", requireAdminAuth, requirePermission("discounts:view"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req, { defaultSize: 25, maxSize: 100 });
    const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM discount_codes`);
    const { rows } = await query(
      `SELECT dc.id, dc.code, dc.kind, dc.value, dc.valid_from, dc.valid_until, dc.max_redemptions, dc.plan_keys,
              dc.is_active, dc.note, dc.created_at,
              (SELECT count(*)::int FROM discount_code_redemptions r WHERE r.discount_code_id = dc.id) AS used,
              a.name AS created_by_name
       FROM discount_codes dc LEFT JOIN admin_users a ON a.id = dc.created_by
       ORDER BY dc.created_at DESC, dc.id LIMIT $1 OFFSET $2`, [pageSize, offset]);
    res.json({
      codes: rows.map((r) => ({ ...r, value: Number(r.value) })),
      linkedToPayments: false,
      page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) { return fail(res, err, "admin/discount-codes:list", req); }
});

// GET /admin/discount-codes/:id/redemptions — «من استعمله» (فارغ حتى أمر الربط)
discountsRouter.get("/discount-codes/:id/redemptions", requireAdminAuth, requirePermission("discounts:view"), requireUuidParam("id"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT r.id, r.redeemed_at, r.invoice_id, u.name AS user_name,
              regexp_replace(u.email, '(^.).*(@.*$)', '\\1***\\2') AS user_email_masked
       FROM discount_code_redemptions r JOIN users u ON u.id = r.user_id
       WHERE r.discount_code_id = $1 ORDER BY r.redeemed_at DESC LIMIT 200`, [req.params.id]);
    res.json({ redemptions: rows });
  } catch (err) { return fail(res, err, "admin/discount-codes:redemptions", req); }
});

// POST /admin/discount-codes  { code, kind, value, validFrom, validUntil, maxRedemptions, planKeys, note, reason }
discountsRouter.post("/discount-codes", requireAdminAuth, requirePermission("discounts:edit"), async (req, res) => {
  try {
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: "reason_required" });
    let v;
    try { v = validateDiscountInput(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (v.planKeys) {
      const { rows } = await query(`SELECT plan_key FROM subscription_plans WHERE plan_key = ANY($1::text[])`, [v.planKeys]);
      if (rows.length !== v.planKeys.length) return res.status(400).json({ error: "unknown_plan" });
    }
    let row;
    try {
      ({ rows: [row] } = await query(
        `INSERT INTO discount_codes (code, kind, value, valid_from, valid_until, max_redemptions, plan_keys, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, code`,
        [v.code, v.kind, v.value, v.validFrom, v.validUntil, v.maxRedemptions, v.planKeys, v.note, req.admin.id]));
    } catch (e) {
      if (e.code === "23505") return res.status(409).json({ error: "code_exists" });
      throw e;
    }
    await logAdminAction({ adminUserId: req.admin.id, action: "discount_code_create", entity: "discount_code", entityId: row.id,
      newValue: v, reason, ipAddress: req.ip });
    res.status(201).json({ id: row.id, code: row.code });
  } catch (err) { return fail(res, err, "admin/discount-codes:create", req); }
});

// POST /admin/discount-codes/:id/active  { active, reason }
discountsRouter.post("/discount-codes/:id/active", requireAdminAuth, requirePermission("discounts:edit"), requireUuidParam("id"), async (req, res) => {
  try {
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: "reason_required" });
    if (typeof req.body?.active !== "boolean") return res.status(400).json({ error: "active_must_be_boolean" });
    const { rows: [old] } = await query(`SELECT is_active FROM discount_codes WHERE id = $1`, [req.params.id]);
    if (!old) return res.status(404).json({ error: "not_found" });
    await query(`UPDATE discount_codes SET is_active = $2, updated_at = now() WHERE id = $1`, [req.params.id, req.body.active]);
    await logAdminAction({ adminUserId: req.admin.id, action: "discount_code_toggle", entity: "discount_code", entityId: req.params.id,
      oldValue: { is_active: old.is_active }, newValue: { is_active: req.body.active }, reason, ipAddress: req.ip });
    res.json({ ok: true });
  } catch (err) { return fail(res, err, "admin/discount-codes:toggle", req); }
});

// POST /admin/discount-codes/check  { code, planKey } — معاينة، لا تكتب ولا تحجز
discountsRouter.post("/discount-codes/check", requireAdminAuth, requirePermission("discounts:view"), async (req, res) => {
  try {
    res.json(await checkDiscountCode(req.body?.code, req.body?.planKey));
  } catch (err) { return fail(res, err, "admin/discount-codes:check", req); }
});
