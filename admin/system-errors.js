import express from "express";
import { query } from "../db/pool.js";
import { requireAdminAuth, requirePermission, requireUuidParam, logAdminAction, fail } from "./middleware.js";
import { readPaging } from "./filters.js";

/* ============================================================
   سجلّ أخطاء النظام — KANAF-ORD-0013 §11
   للمالك والمدير وحدهما (errors:view). القراءة من system_errors المنقّى
   (ops/error-log.js)، والحذف بسبب يُسجَّل في سجل الإجراءات.
   ============================================================ */
export const systemErrorsRouter = express.Router();

// GET /admin/system-errors?page=&q=
systemErrorsRouter.get("/system-errors", requireAdminAuth, requirePermission("errors:view"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req, { defaultSize: 50, maxSize: 200 });
    const q = String(req.query.q || "").trim().slice(0, 100);
    const params = [];
    let where = "";
    if (q) { params.push(`%${q}%`); where = `WHERE kind ILIKE $1 OR message ILIKE $1 OR location ILIKE $1`; }
    const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM system_errors ${where}`, params);
    params.push(pageSize, offset);
    const { rows } = await query(
      `SELECT id, kind, message, stack, location, http_status, count, first_seen, last_seen
         FROM system_errors ${where} ORDER BY last_seen DESC, id
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.json({ errors: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  } catch (err) { return fail(res, err, "admin/system-errors", req); }
});

// DELETE /admin/system-errors/:id?reason= — إزالة صفّ عولج، بسبب مسجَّل
systemErrorsRouter.delete("/system-errors/:id", requireAdminAuth, requirePermission("errors:view"), requireUuidParam("id"), async (req, res) => {
  const reason = String(req.body?.reason || req.query?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "reason_required" });
  try {
    const { rows } = await query(`DELETE FROM system_errors WHERE id = $1 RETURNING kind, location, count`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    await logAdminAction({ adminUserId: req.admin.id, action: "system_error_cleared", entity: "system_error", entityId: req.params.id, oldValue: rows[0], reason, ipAddress: req.ip });
    res.json({ ok: true });
  } catch (err) { return fail(res, err, "admin/system-errors:delete", req); }
});
