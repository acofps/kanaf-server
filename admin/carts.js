import express from "express";
import { query } from "../db/pool.js";
import { requireAdminAuth, requirePermission, fail } from "./middleware.js";
import { readPaging } from "./filters.js";
import { ABANDONED_AFTER_MINUTES, abandonedWhere, purchasedLaterSql } from "../billing/abandoned.js";

/* ============================================================
   السلات المتروكة — KANAF-ORD-0008 §4

   من البيانات القائمة فقط: العميل (مقنَّع) · الباقة · المبلغ · وقت
   الإنشاء · كم مضى · هل اشترى لاحقاً بفاتورة أخرى (فلا يُطارَد).
   التعريف كله في billing/abandoned.js، وهو نفسه تعريف فئة الجمهور
   abandoned_carts — صفحة واحدة وجمهور واحد لا تعريفان يفترقان.

   ✗ لا «هل فتح صفحة الدفع»: لا يُسجَّل، ولا يُنشأ تتبّعه هنا.
   الاستهداف: من صفحة الإشعارات بفئة «أصحاب سلات متروكة» — نفس مسار
   التسليم ونفس احترام منع التسويق ونفس السجل.
   ============================================================ */

export const cartsRouter = express.Router();

// GET /admin/abandoned-carts?hidePurchased=1&page=&pageSize=
cartsRouter.get("/abandoned-carts", requireAdminAuth, requirePermission("carts:view"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req, { defaultSize: 25, maxSize: 100 });
    const hidePurchased = req.query.hidePurchased === "1";
    const where = `u.deleted_at IS NULL AND ${abandonedWhere("i")}${hidePurchased ? ` AND NOT ${purchasedLaterSql("i")}` : ""}`;
    const { rows: [summary] } = await query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ${purchasedLaterSql("i")})::int AS purchased_later,
              COALESCE(SUM(i.amount_sar) FILTER (WHERE NOT ${purchasedLaterSql("i")}), 0)::numeric(12,2) AS open_value_sar,
              count(DISTINCT i.user_id) FILTER (WHERE NOT ${purchasedLaterSql("i")})::int AS open_customers
       FROM invoices i JOIN users u ON u.id = i.user_id WHERE ${where}`
    );
    const { rows } = await query(
      `SELECT i.id, i.plan_id, i.amount_sar, i.created_at,
              floor(extract(epoch FROM now() - i.created_at) / 60)::int AS minutes_since,
              ${purchasedLaterSql("i")} AS purchased_later,
              sp.name AS plan_name, u.name AS user_name,
              regexp_replace(u.email, '(^.).*(@.*$)', '\\1***\\2') AS user_email_masked,
              u.marketing_opt_out
       FROM invoices i JOIN users u ON u.id = i.user_id
       LEFT JOIN subscription_plans sp ON sp.plan_key = i.plan_id
       WHERE ${where}
       ORDER BY i.created_at DESC, i.id
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );
    res.json({
      afterMinutes: ABANDONED_AFTER_MINUTES,
      summary: {
        total: summary.total, purchasedLater: summary.purchased_later,
        openCustomers: summary.open_customers, openValueSar: Number(summary.open_value_sar),
      },
      carts: rows.map((r) => ({
        invoiceId: r.id, planKey: r.plan_id, planName: r.plan_name, amountSar: Number(r.amount_sar),
        createdAt: r.created_at, minutesSince: r.minutes_since, purchasedLater: r.purchased_later,
        customer: { name: r.user_name, emailMasked: r.user_email_masked }, marketingOptOut: r.marketing_opt_out,
      })),
      page, pageSize, total: summary.total, totalPages: Math.max(1, Math.ceil(summary.total / pageSize)),
    });
  } catch (err) {
    return fail(res, err, "admin/abandoned-carts", req);
  }
});
