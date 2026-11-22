import express from "express";
import { query } from "../db/pool.js";
import { requireAdminAuth, requirePermission, requireUuidParam, logAdminAction, fail } from "./middleware.js";
import { readPaging } from "./filters.js";
import { purgeDeletedAccount } from "../userdata/account.js";

/* ============================================================
   الأعضاء الملغون — KANAF-ORD-0013 §8 (قرار المالك 2026-11-22: الاحتفاظ بلا هوية)

   GET  /admin/cancelled-members   السجلات المجهولة — بلا اسم ولا رابط ملف ولا تصدير (§8.4)
   POST /admin/users/:id/purge     إتمام الحذف النهائي لحساب طلب صاحبه حذفه — للمالك وحده

   ⚠️ §8.5: الحذف اليوم على مرحلتين. طلب العضو يعطّل حسابه فوراً، والمحو النهائي
   (purgeDeletedAccount) لم يكن يُستدعى من أي مسار ولا مجدول، في انتظار سياسة
   الاحتفاظ (D-01). لا مهلة تلقائية هنا، ولم أُنشئ واحدة: المحو بيد المالك من ملف
   الحساب المعطّل، وهو الذي يكتب السجل المجهول. الجدولة قرار للمالك.
   ============================================================ */
export const membersRouter = express.Router();
const POLICY = "anonymized-retention (owner decision 2026-11-22, KANAF-ORD-0013 §8)";

membersRouter.get("/cancelled-members", requireAdminAuth, requirePermission("members:view_cancelled"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req, { defaultSize: 50, maxSize: 200 });
    const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM cancelled_members`);
    const { rows } = await query(
      `SELECT id, joined_month, cancelled_month, membership_days, plan_key, subscription_days, cancel_reason, services, completed
         FROM cancelled_members ORDER BY cancelled_month DESC, id LIMIT $1 OFFSET $2`, [pageSize, offset]);
    // عدد الحسابات المعطّلة بانتظار المحو — رقم فقط، بلا هوية (هذا القسم لا يُربط بشخص).
    const { rows: [{ pending }] } = await query(`SELECT count(*)::int AS pending FROM account_deletion_requests WHERE status = 'deactivated'`);
    res.json({ members: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), pendingPurge: pending });
  } catch (err) { return fail(res, err, "admin/cancelled-members", req); }
});

membersRouter.post("/users/:id/purge", requireAdminAuth, requirePermission("members:purge"), requireUuidParam("id"), async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "reason_required" });
  if (req.body?.confirm !== "PURGE") return res.status(400).json({ error: "confirmation_required" });
  try {
    await purgeDeletedAccount(req.params.id, { policy: POLICY });
    // الأثر يذكر الحساب (كفعل إداري على مستخدم) ولا يذكر السجل المجهول ولا ما فيه.
    await logAdminAction({ adminUserId: req.admin.id, targetUserId: req.params.id, action: "member_purged", newValue: { policy: POLICY }, reason, ipAddress: req.ip });
    res.json({ ok: true });
  } catch (err) {
    if (err.message === "account_not_deactivated") return res.status(409).json({ error: "account_not_deactivated" });
    if (err.message === "no_open_deletion_request") return res.status(409).json({ error: "no_open_deletion_request" });
    if (err.message === "user_not_found") return res.status(404).json({ error: "not_found" });
    return fail(res, err, "admin/users:purge", req);
  }
});
