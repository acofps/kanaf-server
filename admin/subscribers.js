import express from "express";
import { query } from "../db/pool.js";
import { requireAdminAuth, requirePermission, fail } from "./middleware.js";
import { readPaging } from "./filters.js";
import { entitledSql } from "../billing/subscription.js";

/* ============================================================
   الاشتراكات — KANAF-ORD-0013 §6

   قائمة المشتركين فعلياً، بفلترة الباقة ومدة الاشتراك، ومراسلتهم.

   «ساري» (§6.1) — التعريف نفسه الذي يحكم الاستحقاق في التطبيق (entitledSql):
     أحدث اشتراك للعميل حالته active أو trialing أو past_due،
     وتاريخ انتهاء فترته في المستقبل.
   فالملغى الذي لم تنتهِ فترته (canceled) خارجها، والمنتهي خارجها ولو بقيت
   حالته المخزّنة active. ويُعاد هذا النص في كل ردّ لتعرضه الصفحة كما هو.

   «المدة»: duration_days للباقة (30، 180، 365…) — مدة الاشتراك التي يدفع عنها.

   🔴 §6.2: القائمة والمستلمون من بنّاء شرط واحد (subscriberWhere). مسار
   /subscribers/recipients يعيد معرّفات المعروض بفلاتره نفسها، وتُرسل الحملة
   إليها مجمَّدة مع expectedCount — فمن يُعرض هو من يصله، والعدد المؤكَّد هو العدد.
   ============================================================ */

export const subscribersRouter = express.Router();

export const ACTIVE_DEFINITION =
  "ساري = أحدث اشتراك للعميل حالته نشط أو تجريبي أو متأخر الدفع، وفترته لم تنتهِ بعد (تاريخ الانتهاء في المستقبل). الملغى والمنتهي خارجه.";

const LATEST = `
  SELECT DISTINCT ON (user_id) id, user_id, plan_id, status, current_period_end, started_at
  FROM subscriptions ORDER BY user_id, created_at DESC`;

/** شرط واحد للقائمة وللمستلمين معاً. */
function subscriberWhere(q) {
  const params = [];
  const where = ["u.deleted_at IS NULL", entitledSql("s")];
  const plan = String(q.plan || "").trim();
  if (plan) { params.push(plan); where.push(`s.plan_id = $${params.length}`); }
  const dur = parseInt(q.duration, 10);
  if (Number.isInteger(dur) && dur > 0) { params.push(dur); where.push(`sp.duration_days = $${params.length}`); }
  return {
    sql: `FROM users u JOIN (${LATEST}) s ON s.user_id = u.id
          LEFT JOIN subscription_plans sp ON sp.plan_key = s.plan_id
          LEFT JOIN subscription_state ss ON ss.subscription_id = s.id
          WHERE ${where.join(" AND ")}`,
    params,
    filters: { plan: plan || null, duration: Number.isInteger(dur) && dur > 0 ? dur : null },
  };
}

// GET /admin/subscribers?plan=&duration=&page=&pageSize=
subscribersRouter.get("/subscribers", requireAdminAuth, requirePermission("subscriptions:view"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req, { defaultSize: 25, maxSize: 100 });
    const w = subscriberWhere(req.query);
    const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total ${w.sql}`, w.params);
    const p = [...w.params, pageSize, offset];
    const { rows } = await query(
      `SELECT u.id AS user_id, u.name, u.email, s.plan_id, sp.name AS plan_name, sp.duration_days,
              s.status, s.started_at, s.current_period_end, COALESCE(ss.renewal_mode, 'manual') AS renewal_mode
       ${w.sql}
       ORDER BY s.current_period_end ASC, u.id
       LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    const { rows: plans } = await query(`SELECT plan_key, name, duration_days FROM subscription_plans ORDER BY display_order, plan_key`);
    res.json({
      subscribers: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
      filters: w.filters, definition: ACTIVE_DEFINITION,
      options: { plans, durations: [...new Set(plans.map((x) => x.duration_days).filter(Boolean))].sort((a, b) => a - b) },
    });
  } catch (err) { return fail(res, err, "admin/subscribers", req); }
});

/* GET /admin/subscribers/recipients?plan=&duration= — معرّفات المعروض كله بفلاتره (لا الصفحة وحدها).
   تُجمَّد في الحملة مع expectedCount، فيُرفض الإرسال إن تغيّر الجمهور بين العرض والتأكيد. */
subscribersRouter.get("/subscribers/recipients", requireAdminAuth, requirePermission("subscriptions:view"), async (req, res) => {
  try {
    const w = subscriberWhere(req.query);
    const { rows } = await query(`SELECT u.id ${w.sql} ORDER BY u.id`, w.params);
    res.json({ userIds: rows.map((r) => r.id), count: rows.length, filters: w.filters, definition: ACTIVE_DEFINITION });
  } catch (err) { return fail(res, err, "admin/subscribers:recipients", req); }
});
