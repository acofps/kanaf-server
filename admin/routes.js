import express from "express";
import rateLimit from "express-rate-limit";
import { query, withTransaction } from "../db/pool.js";
import { verifyAdminCredentials, issueAccessToken, issueRefreshToken, verifyToken, touchLastLogin, setAuthCookies, clearAuthCookies, hashPassword } from "./auth.js";
import { requireAdminAuth, requireRole, requireReasonAndLog, logSensitiveAccess, logAdminAction } from "./middleware.js";
import { generateAndStoreInvoice } from "../invoicing/generate.js";
import { executeRefund } from "../payments/refund.js";
import { sendBroadcast } from "../notifications/broadcast.js";
import { billingRouter } from "./billing.js";
import { entitledSql } from "../billing/subscription.js";

export const adminRouter = express.Router();

/* ============================================================
   الصفحات المالية للمرحلة 3 — اشتراكات، مدفوعات، فواتير، إشعارات
   دائنة، مؤشرات، سجل أحداث الدفع، وتقرير تكامل البيانات.

   في ملف منفصل (admin/billing.js) لا لأن هذا الملف طويل فحسب، بل
   لأن المسارات المالية لها قواعد مختلفة: كلها مشروطة بسبب مكتوب،
   وكلها تُسجَّل في admin_action_log، وأي تعديل عليها يُراجع كتغيير
   مالي لا كتغيير واجهة.

   المسارات القديمة أدناه (/admin/invoices و/admin/credit-notes)
   محفوظة كما هي عن قصد: حزمة لوحة الإدارة المبنية داخل المستودع
   تناديها، ومصدرها غير موجود على GitHub (القسم 12.8 من وثيقة
   الحالة) فلا يمكن إعادة بنائها الآن. حذفها كان سيكسر صفحات تعمل.
   ============================================================ */
adminRouter.use("/billing", billingRouter);

// Login attempts are the highest-value target for brute-forcing —
// much tighter limit than the general /api/ limiter in index.js.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

/* ============================================================
   AUTH — tokens live only in httpOnly cookies now, never in a JSON
   response body or anywhere client-side JS can read them. See
   admin/auth.js setAuthCookies()/clearAuthCookies() for the cookie
   attributes (httpOnly, secure in production, sameSite=strict).
   ============================================================ */

// POST /admin/auth/login  { email, password }
adminRouter.post("/auth/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "email_and_password_required" });

    const admin = await verifyAdminCredentials(email, password);
    if (!admin) {
      // Same generic error whether the email is unknown or the
      // password is wrong — never confirm which admin emails exist.
      return res.status(401).json({ error: "invalid_credentials" });
    }

    await touchLastLogin(admin.id);
    setAuthCookies(res, { accessToken: issueAccessToken(admin), refreshToken: issueRefreshToken(admin) });
    // The response body carries identity/role for the UI to render
    // (name, role) — never the tokens themselves.
    res.json({ admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /admin/auth/refresh — reads the refresh token from its own
// cookie (never from the request body — a JSON body can be read by
// any JS on the page, which is exactly what httpOnly cookies avoid).
adminRouter.post("/auth/refresh", loginLimiter, async (req, res) => {
  try {
    const refreshToken = req.cookies?.kanaf_admin_refresh;
    if (!refreshToken) return res.status(401).json({ error: "no_refresh_cookie" });

    const payload = verifyToken(refreshToken);
    if (payload.type !== "refresh") return res.status(401).json({ error: "wrong_token_type" });

    const { rows } = await query(`SELECT id, name, email, role, active FROM admin_users WHERE id = $1`, [payload.sub]);
    const admin = rows[0];
    if (!admin || !admin.active) return res.status(401).json({ error: "account_inactive" });

    setAuthCookies(res, { accessToken: issueAccessToken(admin) });
    res.json({ ok: true });
  } catch (err) {
    res.status(401).json({ error: "invalid_or_expired_refresh_token" });
  }
});

// POST /admin/auth/logout — clears both cookies server-side. A
// frontend "log out" button that only deleted a JS-visible token
// would be pointless now that the tokens aren't JS-visible at all.
adminRouter.post("/auth/logout", (req, res) => {
  clearAuthCookies(res);
  res.json({ ok: true });
});

// GET /admin/auth/me — lets the frontend restore "who am I logged in
// as" on page load without ever reading the cookie itself (it can't).
adminRouter.get("/auth/me", requireAdminAuth, async (req, res) => {
  try {
    const { rows } = await query(`SELECT id, name, email, role FROM admin_users WHERE id = $1`, [req.admin.id]);
    if (!rows[0]) return res.status(401).json({ error: "account_not_found" });
    res.json({ admin: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   ADMIN USER MANAGEMENT — the gap this session set out to close:
   creating a new staff account used to require SSH access to run
   db/seed_first_admin.js. Owner-only, since this manages who can
   manage everything else.
   ============================================================ */

const VALID_ROLES = ["support", "content_manager", "admin", "owner"];

adminRouter.get("/admin-users", requireAdminAuth, requireRole("owner"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role, active, created_at, last_login_at FROM admin_users ORDER BY created_at ASC`
    );
    res.json({ adminUsers: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /admin/admin-users  { name, email, password, role }
adminRouter.post("/admin-users", requireAdminAuth, requireRole("owner"), async (req, res) => {
  try {
    const { name, email, password, role } = req.body || {};
    if (!name?.trim() || !email?.trim() || !password || !role) {
      return res.status(400).json({ error: "name_email_password_role_required" });
    }
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: "invalid_role" });
    if (password.length < 15) {
      // Same NIST SP 800-63B floor enforced by db/seed_first_admin.js —
      // enforced here too now that account creation doesn't require
      // that script anymore.
      return res.status(400).json({ error: "password_must_be_at_least_15_chars" });
    }

    const passwordHash = await hashPassword(password);
    const { rows } = await query(
      `INSERT INTO admin_users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, active, created_at`,
      [name.trim(), email.trim().toLowerCase(), passwordHash, role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "email_already_exists" });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// PATCH /admin/admin-users/:id  { role?, active? }
adminRouter.patch("/admin-users/:id", requireAdminAuth, requireRole("owner"), async (req, res) => {
  try {
    const { role, active } = req.body || {};
    if (role !== undefined && !VALID_ROLES.includes(role)) return res.status(400).json({ error: "invalid_role" });

    const result = await withTransaction(async (client) => {
      const { rows: targetRows } = await client.query(`SELECT id, role, active FROM admin_users WHERE id = $1 FOR UPDATE`, [req.params.id]);
      const target = targetRows[0];
      if (!target) throw Object.assign(new Error("not_found"), { status: 404 });

      // Prevent the last active owner from being demoted or
      // deactivated — by themselves or anyone else — which would
      // permanently lock every admin out of the highest-privilege
      // actions (approving break-glass, editing tax settings, managing
      // other admins) with no way back in short of direct DB access.
      const wouldLoseOwnerStatus = target.role === "owner" && ((role !== undefined && role !== "owner") || active === false);
      if (wouldLoseOwnerStatus) {
        const { rows: ownerCountRows } = await client.query(
          `SELECT count(*)::int AS n FROM admin_users WHERE role = 'owner' AND active = true AND id != $1`,
          [target.id]
        );
        if (ownerCountRows[0].n === 0) {
          throw Object.assign(new Error("cannot_remove_last_owner"), { status: 409 });
        }
      }

      const { rows } = await client.query(
        `UPDATE admin_users SET role = COALESCE($1, role), active = COALESCE($2, active) WHERE id = $3
         RETURNING id, name, email, role, active`,
        [role, active, req.params.id]
      );
      return rows[0];
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   DASHBOARD — aggregate stats only, no per-user detail here
   ============================================================ */

// GET /admin/overview
adminRouter.get("/overview", requireAdminAuth, requireRole("support"), async (req, res) => {
  try {
    const [{ rows: userCount }, { rows: activeSubs }, { rows: unreadMessages }, { rows: crisisEvents }, { rows: money }] = await Promise.all([
      query(`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL`),
      /* --------------------------------------------------------
         كان هذا العدّاد: WHERE status = 'active' — حرفياً.

         وهو خطأ صامت ومتراكم: انتهاء الاشتراك لا يُكتب في العمود
         (لا cron في المشروع، القسم 12.9)، فاشتراك انتهت مدته من
         ستة أشهر يبقى status = 'active' إلى الأبد. الرقم المعروض
         في الصفحة الرئيسية كان مجموع كل من اشترك يوماً ما، لا عدد
         المشتركين الفعليين، والفارق يتسع كل شهر.

         الآن يُقاس بشرط الاستحقاق الموحّد، وعلى **أحدث** اشتراك
         لكل مستخدم حتى لا يُحتسب من ألغى ثم عاد أكثر من مرة.
         -------------------------------------------------------- */
      query(
        `SELECT count(*)::int AS n FROM (
           SELECT DISTINCT ON (user_id) id, user_id, status, current_period_end
           FROM subscriptions ORDER BY user_id, created_at DESC
         ) s WHERE ${entitledSql("s")}`
      ),
      query(`SELECT count(*)::int AS n FROM contact_messages WHERE status = 'unread'`),
      // Categorical/aggregate only — never joined to a specific user here.
      query(`SELECT trigger_source, count(*)::int AS n FROM crisis_trigger_events
             WHERE occurred_at > now() - interval '30 days' GROUP BY trigger_source`),
      query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('paid','refunded','partially_refunded')), 0) AS gross,
                COALESCE(SUM(refunded_amount), 0) AS refunded,
                count(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM payments WHERE COALESCE(captured_at, created_at) > now() - interval '30 days'`
      ),
    ]);
    res.json({
      totalUsers: userCount[0].n,
      activeSubscriptions: activeSubs[0].n,
      unreadMessages: unreadMessages[0].n,
      crisisEventsLast30Days: crisisEvents, // [{ trigger_source, n }, ...]
      last30Days: {
        grossRevenue: Number(Number(money[0].gross).toFixed(2)),
        refunds: Number(Number(money[0].refunded).toFixed(2)),
        netRevenue: Number((Number(money[0].gross) - Number(money[0].refunded)).toFixed(2)),
        failedPayments: money[0].failed,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   USERS — list shows only non-sensitive fields by default;
   sensitive fields require a logged reason (least-privilege, per
   the engineering audit's mane 4).
   ============================================================ */

// GET /admin/users?search=&page=
/* ------------------------------------------------------------
   Account status is DERIVED, never stored — see
   003_admin_user_operations.sql for why. This CASE is the single
   definition of it and is reused by the list and the detail route,
   so the two can't disagree.
   ------------------------------------------------------------ */
const ACCOUNT_STATUS_SQL = `
  CASE
    WHEN u.deleted_at IS NOT NULL     THEN 'deleted'
    WHEN s.suspended_at IS NOT NULL   THEN 'suspended'
    WHEN u.email_verified_at IS NULL  THEN 'pending_verification'
    ELSE 'active'
  END`;

// Whitelist. The sort column is interpolated into the query text —
// which is safe ONLY because the value can never come from the
// request directly, just a key lookup here. Never add a branch that
// passes req.query through.
const USER_SORT_COLUMNS = {
  created_at: "u.created_at",
  name: "u.name",
  email: "u.email",
  last_login: "s.last_login_at",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /admin/users?search=&page=&pageSize=&status=&subscription=&from=&to=&sort=&dir=
adminRouter.get("/users", requireAdminAuth, requireRole("support"), async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const offset = (page - 1) * pageSize;

    const status = String(req.query.status || "all");
    const subscription = String(req.query.subscription || "all");
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    const sortCol = USER_SORT_COLUMNS[String(req.query.sort || "created_at")] || "u.created_at";
    const dir = String(req.query.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

    const where = [];
    const params = [];
    const p = (v) => `$${params.push(v)}`;

    // Deleted accounts are hidden unless explicitly asked for. They
    // still exist (soft delete) and an owner may need to see them.
    if (status === "deleted") {
      where.push(`u.deleted_at IS NOT NULL`);
    } else {
      where.push(`u.deleted_at IS NULL`);
      if (status === "active") {
        where.push(`s.suspended_at IS NULL AND u.email_verified_at IS NOT NULL`);
      } else if (status === "suspended") {
        where.push(`s.suspended_at IS NOT NULL`);
      } else if (status === "pending_verification") {
        where.push(`u.email_verified_at IS NULL AND s.suspended_at IS NULL`);
      }
    }

    if (search) {
      // An exact id match is a different question from a name search,
      // so treat it as one: pasting a UUID should return that user,
      // not zero rows because the id isn't in name or email.
      if (UUID_RE.test(search)) {
        where.push(`u.id = ${p(search)}`);
      } else {
        const term = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
        where.push(`(u.name ILIKE ${p(term)} OR u.email ILIKE ${p(term)})`);
      }
    }

    if (subscription === "active") {
      where.push(`sub.status = 'active'`);
    } else if (subscription === "none") {
      where.push(`(sub.status IS NULL OR sub.status <> 'active')`);
    }

    if (from) where.push(`u.created_at >= ${p(from)}`);
    // Inclusive end-of-day: a date-only `to` would otherwise silently
    // exclude everyone who registered on that day.
    if (to) where.push(`u.created_at < (${p(to)}::date + interval '1 day')`);

    const filterSql = where.join(" AND ");

    /* --------------------------------------------------------
       Latest subscription per user, resolved in ONE pass with
       DISTINCT ON instead of the previous correlated subquery in
       the SELECT list — that ran an extra query for every row
       returned, an N+1 hidden inside a single statement.

       LATERAL ... LIMIT 1 would be marginally better at large
       scale, because it does an index lookup per returned row
       instead of ranking every subscription. It is not used here
       for one honest reason: the test harness (pg-mem) does not
       implement LATERAL, and shipping a query no test can execute
       is worse than the difference. With `subscriptions` in the
       low thousands the cost is not measurable. Revisit if that
       table passes ~100k rows, and add an index on
       (user_id, created_at DESC) at the same time.
       -------------------------------------------------------- */
    const latestSubscription = `
      LEFT JOIN (
        SELECT DISTINCT ON (user_id) user_id, status, plan_id, current_period_end
        FROM subscriptions
        ORDER BY user_id, created_at DESC
      ) sub ON sub.user_id = u.id`;

    const fromAndJoins = `
      FROM users u
      LEFT JOIN user_auth_state s ON s.user_id = u.id
      ${latestSubscription}
      WHERE ${filterSql}`;

    // Counted with the identical filter set, so the total can never
    // describe a different population than the rows shown.
    const { rows: countRows } = await query(
      `SELECT count(*)::int AS total ${fromAndJoins}`,
      params
    );
    const total = countRows[0].total;

    const limitParam = p(pageSize);
    const offsetParam = p(offset);

    const { rows: users } = await query(
      `SELECT u.id, u.name, u.email, u.created_at, u.email_verified_at,
              s.last_login_at, s.suspended_at,
              ${ACCOUNT_STATUS_SQL} AS account_status,
              sub.status AS subscription_status,
              sub.plan_id AS subscription_plan
       ${fromAndJoins}
       -- u.id is the tiebreaker, and it is not optional: without it,
       -- rows sharing a created_at can reorder between requests, so
       -- page 2 may repeat or skip records from page 1.
       ORDER BY ${sortCol} ${dir} NULLS LAST, u.id DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params
    );

    res.json({
      users,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      filters: { search, status, subscription, from, to, sort: req.query.sort || "created_at", dir: dir.toLowerCase() },
    });
  } catch (err) {
    console.error("[admin/users] list failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /admin/users/:id — non-sensitive profile fields, no logging needed (name/email/dates aren't the sensitive part)
adminRouter.get("/users/:id", requireAdminAuth, requireRole("support"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.age_range, u.gender, u.confirmed_adult,
              u.created_at, u.updated_at, u.email_verified_at, u.deleted_at,
              s.last_login_at, s.suspended_at, s.suspended_reason,
              COALESCE(s.failed_login_count, 0) AS failed_login_count,
              s.locked_until,
              ${ACCOUNT_STATUS_SQL} AS account_status,
              sub.status AS subscription_status,
              sub.plan_id AS subscription_plan,
              sub.current_period_end AS subscription_renews_at
       FROM users u
       LEFT JOIN user_auth_state s ON s.user_id = u.id
       LEFT JOIN (
         SELECT DISTINCT ON (user_id) user_id, status, plan_id, current_period_end
         FROM subscriptions ORDER BY user_id, created_at DESC
       ) sub ON sub.user_id = u.id
       WHERE u.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found" });

    // Deliberately absent from this payload: password_hash, pin_hash,
    // and every session token. They have no operational use in the
    // admin panel, and a field that is never sent can never leak.
    res.json(rows[0]);
  } catch (err) {
    console.error("[admin/users] detail failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   ACCOUNT STATUS ACTIONS

   Suspension is enforced in three places, and all three are needed
   for it to mean anything:
     1. here — the state is written
     2. auth/routes.js login — a suspended account can't sign in
     3. auth/middleware.js requireVerifiedUser — existing access stops

   Step 3 is why sessions are revoked below. Without that, a
   suspended user keeps a valid 15-minute access token and stays
   signed in until it expires — a suspension that doesn't suspend.
   ============================================================ */

// POST /admin/users/:id/suspend  { reason }
adminRouter.post("/users/:id/suspend", requireAdminAuth, requireRole("admin"), async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) {
    return res.status(400).json({ error: "reason_required", message: "لازم تكتب سبب التعليق." });
  }
  if (reason.length > 500) {
    return res.status(400).json({ error: "reason_too_long", maxLength: 500 });
  }

  try {
    const { rows: existing } = await query(
      `SELECT u.id, u.deleted_at, s.suspended_at
       FROM users u LEFT JOIN user_auth_state s ON s.user_id = u.id
       WHERE u.id = $1`,
      [req.params.id]
    );
    const user = existing[0];
    if (!user) return res.status(404).json({ error: "not_found" });
    if (user.deleted_at) return res.status(409).json({ error: "account_deleted" });
    if (user.suspended_at) return res.status(409).json({ error: "already_suspended" });

    await query(
      `INSERT INTO user_auth_state (user_id, suspended_at, suspended_reason, suspended_by)
       VALUES ($1, now(), $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET suspended_at = now(), suspended_reason = EXCLUDED.suspended_reason,
             suspended_by = EXCLUDED.suspended_by, updated_at = now()`,
      [req.params.id, reason, req.admin.id]
    );

    // Immediate effect, not "on next login".
    const { rowCount: revoked } = await query(
      `UPDATE user_sessions SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [req.params.id]
    );

    // Logged only after the write succeeded — the log must never
    // claim a change that didn't land.
    await logAdminAction({
      adminUserId: req.admin.id,
      targetUserId: req.params.id,
      action: "suspend_account",
      oldValue: { account_status: "active" },
      newValue: { account_status: "suspended" },
      reason,
      metadata: { sessions_revoked: revoked },
      ipAddress: req.ip,
    });

    res.json({ ok: true, account_status: "suspended", sessionsRevoked: revoked });
  } catch (err) {
    console.error("[admin/users] suspend failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /admin/users/:id/restore  { reason }
adminRouter.post("/users/:id/restore", requireAdminAuth, requireRole("admin"), async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) {
    return res.status(400).json({ error: "reason_required", message: "لازم تكتب سبب رفع التعليق." });
  }
  if (reason.length > 500) {
    return res.status(400).json({ error: "reason_too_long", maxLength: 500 });
  }

  try {
    const { rows: existing } = await query(
      `SELECT u.id, u.deleted_at, u.email_verified_at, s.suspended_at, s.suspended_reason
       FROM users u LEFT JOIN user_auth_state s ON s.user_id = u.id
       WHERE u.id = $1`,
      [req.params.id]
    );
    const user = existing[0];
    if (!user) return res.status(404).json({ error: "not_found" });
    if (user.deleted_at) return res.status(409).json({ error: "account_deleted" });
    if (!user.suspended_at) return res.status(409).json({ error: "not_suspended" });

    await query(
      `UPDATE user_auth_state
       SET suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL,
           failed_login_count = 0, locked_until = NULL, updated_at = now()
       WHERE user_id = $1`,
      [req.params.id]
    );

    const newStatus = user.email_verified_at ? "active" : "pending_verification";

    await logAdminAction({
      adminUserId: req.admin.id,
      targetUserId: req.params.id,
      action: "restore_account",
      oldValue: { account_status: "suspended", suspended_reason: user.suspended_reason },
      newValue: { account_status: newStatus },
      reason,
      ipAddress: req.ip,
    });

    res.json({ ok: true, account_status: newStatus });
  } catch (err) {
    console.error("[admin/users] restore failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /admin/users/:id/actions — the mutation history for one user.
adminRouter.get("/users/:id/actions", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, admin_user_id, action, old_value, new_value, reason, metadata, created_at
       FROM admin_action_log
       WHERE target_user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.params.id]
    );
    res.json({ actions: rows });
  } catch (err) {
    console.error("[admin/users] action log failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /admin/users/:id/sensitive?reason=...
// Returns daily logs, screening results, and free-text content —
// gated behind requireReasonAndLog, which writes the immutable audit
// entry BEFORE this handler runs.
adminRouter.get(
  "/users/:id/sensitive",
  requireAdminAuth,
  requireRole("admin"), // support staff cannot reach this at all — least privilege by default
  requireReasonAndLog("view_sensitive_data"),
  async (req, res) => {
    try {
      const userId = req.params.id;
      const [{ rows: logs }, { rows: screenings }] = await Promise.all([
        query(`SELECT mood, sleep, energy, note, tags, logged_on FROM daily_logs WHERE user_id = $1 ORDER BY logged_on DESC LIMIT 30`, [userId]),
        query(`SELECT kind, total, band_label, created_at FROM screenings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [userId]),
        // Note: screenings.answers (item-level) deliberately NOT selected
        // here — aggregate score + band is enough for support purposes.
        // A break-glass request is required to see raw item answers.
      ]);
      res.json({ logs, screenings });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

// POST /admin/users/:id/subscription/cancel  { reason, atPeriodEnd? }
//
// الافتراضي إلغاء فوري (سلوك هذا المسار منذ البداية، ولا يُغيَّر
// بلا طلب)، و atPeriodEnd: true يحوّله إلى إلغاء بنهاية المدة.
//
// لا يلمس فاتورة ولا يصدر إشعاراً دائناً — لا مال يتحرك هنا.
// لـ"العميل يبي فلوسه" استخدم /admin/billing/payments/:id/refund.
//
// أُصلح فيه عطبان: كان يتجاهل canceled_at تماماً (فالاشتراك يُلغى
// ولا يُعرف متى، ومؤشر "الملغاة في الفترة" يستحيل حسابه)، وكان
// يشترط status = 'active' حرفياً فلا يقدر على إلغاء اشتراك متعثّر
// السداد — وهو أكثر ما يُطلب إلغاؤه فعلاً.
adminRouter.post(
  "/users/:id/subscription/cancel",
  requireAdminAuth,
  requireRole("admin"),
  requireReasonAndLog("manual_subscription_cancel"),
  async (req, res) => {
    const atPeriodEnd = req.body?.atPeriodEnd === true;
    const reason = String(req.body?.reason || req.query?.reason || "").trim();

    try {
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT id, status, current_period_end FROM subscriptions
           WHERE user_id = $1 AND status IN ('active', 'trialing', 'past_due')
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [req.params.id]
        );
        const sub = rows[0];
        if (!sub) throw Object.assign(new Error("no_active_subscription"), { status: 404 });

        if (atPeriodEnd) {
          await client.query(
            `INSERT INTO subscription_state (subscription_id, user_id, cancel_at_period_end, cancel_requested_at, cancel_reason)
             VALUES ($1, $2, true, now(), $3)
             ON CONFLICT (subscription_id) DO UPDATE
               SET cancel_at_period_end = true, cancel_requested_at = now(),
                   cancel_reason = EXCLUDED.cancel_reason, updated_at = now()`,
            [sub.id, req.params.id, reason || null]
          );
          return { subscriptionId: sub.id, mode: "at_period_end", accessUntil: sub.current_period_end, previousStatus: sub.status };
        }

        await client.query(
          `UPDATE subscriptions SET status = 'canceled', canceled_at = now(), updated_at = now() WHERE id = $1`,
          [sub.id]
        );
        return { subscriptionId: sub.id, mode: "immediate", accessUntil: null, previousStatus: sub.status };
      });

      await logAdminAction({
        adminUserId: req.admin.id,
        targetUserId: req.params.id,
        action: "manual_subscription_cancel",
        oldValue: { status: result.previousStatus },
        newValue: { mode: result.mode, status: result.mode === "immediate" ? "canceled" : "canceling" },
        reason: reason || "—",
        metadata: { subscription_id: result.subscriptionId },
        ipAddress: req.ip,
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

// POST /admin/users/:id/subscription/refund  { reason, amountSar? }
//
// ⚠️ هذا المسار كان أخطر ما في الطبقة المالية كلها.
//
// كان يعلّم الفاتورة "مستردة"، ويلغي الاشتراك، ويصدر إشعاراً دائناً
// حقيقياً بختم ZATCA — **دون أن ينادي Moyasar إطلاقاً**. النتيجة أن
// الدفاتر والوثيقة الضريبية تقولان إن المبلغ رُدّ، والمال لم يغادر
// الحساب. وثيقة نظامية صحيحة الشكل تصف واقعة لم تحدث، وموظف الدعم
// يرى "تم" فيغلق التذكرة، والعميل ينتظر مالاً لن يصل.
//
// الآن يمر بـexecuteRefund: نداء حقيقي للمزوّد أولاً، ولا يُسجَّل
// شيء ولا يصدر إشعار إلا بعد نجاحه. ويدعم الاسترداد الجزئي عبر
// amountSar. ويعمل على **الدفعة** لا على الفاتورة، لأن الفاتورة قد
// تحمل أكثر من محاولة دفع وواحدة فقط منها هي المحصَّلة فعلاً.
adminRouter.post(
  "/users/:id/subscription/refund",
  requireAdminAuth,
  requireRole("admin"),
  requireReasonAndLog("manual_subscription_refund"),
  async (req, res) => {
    const reason = String(req.body?.reason || req.query?.reason || "").trim();
    try {
      const { rows } = await query(
        `SELECT id, amount, refunded_amount, status FROM payments
         WHERE user_id = $1 AND status IN ('paid', 'partially_refunded')
         ORDER BY captured_at DESC NULLS LAST, created_at DESC LIMIT 1`,
        [req.params.id]
      );
      const payment = rows[0];
      if (!payment) return res.status(404).json({ error: "no_refundable_payment_found" });

      const result = await executeRefund({
        paymentId: payment.id,
        amountSar: req.body?.amountSar === undefined || req.body?.amountSar === null || req.body?.amountSar === ""
          ? undefined : Number(req.body.amountSar),
        reason,
        adminUserId: req.admin.id,
      });
      if (result.alreadyRecorded) return res.status(409).json({ error: "already_refunded" });

      await logAdminAction({
        adminUserId: req.admin.id,
        targetUserId: req.params.id,
        action: "manual_subscription_refund",
        oldValue: { payment_status: payment.status, refunded_amount: Number(payment.refunded_amount) },
        newValue: { kind: result.kind, refunded_amount: result.totalRefunded, credit_note: result.creditNoteNumber },
        reason: reason || "—",
        metadata: { payment_id: payment.id },
        ipAddress: req.ip,
      });

      res.json({ ok: true, kind: result.kind, amount: result.amount, creditNoteNumber: result.creditNoteNumber || null });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, detail: err.detail });
      console.error(err);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

/* ============================================================
   BREAK-GLASS — emergency access to raw sensitive data (e.g. item-
   level screening answers), requiring a second approver who is
   never the same admin as the requester (enforced by a DB CHECK
   constraint too, see schema.sql).
   ============================================================ */

// POST /admin/break-glass/request  { targetUserId, reason }
adminRouter.post("/break-glass/request", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { targetUserId, reason } = req.body || {};
    if (!reason || !reason.trim()) return res.status(400).json({ error: "reason_required" });

    const { rows } = await query(
      `INSERT INTO break_glass_requests (requested_by, target_user_id, reason)
       VALUES ($1, $2, $3) RETURNING id, status, created_at`,
      [req.admin.id, targetUserId || null, reason.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /admin/break-glass/pending — owners/admins review the queue
adminRouter.get("/break-glass/pending", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT bg.id, bg.reason, bg.created_at, bg.target_user_id,
              au.name AS requested_by_name, au.email AS requested_by_email
       FROM break_glass_requests bg
       JOIN admin_users au ON au.id = bg.requested_by
       WHERE bg.status = 'pending'
       ORDER BY bg.created_at ASC`
    );
    res.json({ requests: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /admin/break-glass/:id/approve  { hoursValid }
adminRouter.post("/break-glass/:id/approve", requireAdminAuth, requireRole("owner"), async (req, res) => {
  try {
    const hoursValid = Math.min(Math.max(parseInt(req.body?.hoursValid, 10) || 4, 1), 24);
    const { rows } = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(`SELECT requested_by, status FROM break_glass_requests WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!existing[0]) throw Object.assign(new Error("not_found"), { status: 404 });
      if (existing[0].status !== "pending") throw Object.assign(new Error("already_resolved"), { status: 409 });
      if (existing[0].requested_by === req.admin.id) throw Object.assign(new Error("cannot_self_approve"), { status: 403 });

      return client.query(
        `UPDATE break_glass_requests
         SET status = 'approved', approved_by = $1, approved_at = now(), expires_at = now() + ($2 || ' hours')::interval
         WHERE id = $3 RETURNING id, status, expires_at`,
        [req.admin.id, hoursValid, req.params.id]
      );
    });
    res.json(rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

/* ============================================================
   CONTENT REVIEW — the real, server-side counterpart to
   clinical_review_status on journeys/notebooks/CBT tools/overlays.
   ============================================================ */

// GET /admin/content?type=journey
adminRouter.get("/content", requireAdminAuth, requireRole("content_manager"), async (req, res) => {
  try {
    const type = req.query.type;
    const { rows } = await query(
      `SELECT id, content_type, content_key, content_version, clinical_review_status,
              reviewer_admin_id, reviewed_at, launch_enabled, updated_at
       FROM content_items
       WHERE ($1::text IS NULL OR content_type = $1)
       ORDER BY updated_at DESC`,
      [type || null]
    );
    res.json({ content: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /admin/content/:id/review  { status: 'approved'|'rejected', notes }
// Only 'admin' role and above can approve — matches the requirement
// that content_manager can prepare/flag content but not self-approve
// what ships to real users.
adminRouter.post("/content/:id/review", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { status, notes } = req.body || {};
    if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "invalid_status" });

    const { rows } = await query(
      `UPDATE content_items
       SET clinical_review_status = $1, reviewer_admin_id = $2, reviewed_at = now(), review_notes = $3,
           launch_enabled = CASE WHEN $1 = 'approved' THEN launch_enabled ELSE false END,
           updated_at = now()
       WHERE id = $4
       RETURNING id, content_type, content_key, clinical_review_status, launch_enabled`,
      [status, req.admin.id, notes || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /admin/content/:id/toggle-launch  { enabled }
// The real kill switch — separate action from clinical approval, so
// an owner can pull a live piece of content instantly without
// re-running the whole review process to bring it back.
adminRouter.post("/content/:id/toggle-launch", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { enabled } = req.body || {};
    const { rows } = await query(
      `UPDATE content_items SET launch_enabled = $1, updated_at = now()
       WHERE id = $2 AND clinical_review_status = 'approved'
       RETURNING id, content_key, launch_enabled`,
      [!!enabled, req.params.id]
    );
    if (!rows[0]) return res.status(409).json({ error: "cannot_enable_unapproved_content" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   ACCESS LOG — read-only view for owners; no update/delete route
   exists anywhere in this file (see schema.sql design note #2).
   ============================================================ */

// GET /admin/access-log?targetUserId=
adminRouter.get("/access-log", requireAdminAuth, requireRole("owner"), async (req, res) => {
  try {
    const targetUserId = req.query.targetUserId || null;
    const { rows } = await query(
      `SELECT al.id, al.action, al.reason, al.created_at, al.ip_address,
              au.name AS admin_name, au.email AS admin_email, al.target_user_id
       FROM admin_access_log al
       JOIN admin_users au ON au.id = al.admin_user_id
       WHERE ($1::uuid IS NULL OR al.target_user_id = $1)
       ORDER BY al.created_at DESC
       LIMIT 200`,
      [targetUserId]
    );
    res.json({ entries: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   SUBSCRIPTION PLANS — the real source of truth for pricing.
   payments/routes.js reads from this same table, so an edit here
   actually changes what a user is charged. Gated at 'admin' role
   (not just content_manager) because this directly affects money,
   not just content.
   ============================================================ */

// GET /admin/plans — lists ALL plans including inactive ones, so the
// admin can see and reactivate something they turned off earlier.
adminRouter.get("/plans", requireAdminAuth, requireRole("support"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, plan_key, name, price_sar, duration_days, features, is_active, display_order, updated_at
       FROM subscription_plans ORDER BY display_order ASC, created_at ASC`
    );
    res.json({ plans: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /admin/plans  { planKey, name, priceSar, durationDays, features, displayOrder }
adminRouter.post("/plans", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { planKey, name, priceSar, durationDays, features, displayOrder } = req.body || {};
    if (!planKey || !name || priceSar === undefined || !durationDays) {
      return res.status(400).json({ error: "planKey_name_priceSar_durationDays_required" });
    }
    if (!/^[a-z0-9_]+$/.test(planKey)) {
      // plan_key ends up in invoices/subscriptions and eventually in
      // Moyasar's payment description string — keep it to a safe,
      // predictable character set, not free-form text.
      return res.status(400).json({ error: "planKey_must_be_lowercase_letters_numbers_underscores_only" });
    }
    const { rows } = await query(
      `INSERT INTO subscription_plans (plan_key, name, price_sar, duration_days, features, display_order, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, plan_key, name, price_sar, duration_days, features, is_active, display_order`,
      [planKey, name, priceSar, durationDays, features || [], displayOrder || 0, req.admin.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "plan_key_already_exists" });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// PATCH /admin/plans/:id  { name?, priceSar?, durationDays?, features?, displayOrder? }
// Deliberately cannot change planKey once created — invoices/subscriptions
// already created against the old key would otherwise point nowhere.
adminRouter.patch("/plans/:id", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { name, priceSar, durationDays, features, displayOrder } = req.body || {};
    const { rows } = await query(
      `UPDATE subscription_plans SET
         name = COALESCE($1, name),
         price_sar = COALESCE($2, price_sar),
         duration_days = COALESCE($3, duration_days),
         features = COALESCE($4, features),
         display_order = COALESCE($5, display_order),
         updated_by = $6,
         updated_at = now()
       WHERE id = $7
       RETURNING id, plan_key, name, price_sar, duration_days, features, is_active, display_order`,
      [name, priceSar, durationDays, features, displayOrder, req.admin.id, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /admin/plans/:id/toggle-active  { active }
// Deactivating hides a plan from new purchases (payments/routes.js
// filters on is_active) but never touches existing subscribers —
// same "never punish someone already subscribed" principle as the
// content kill switch.
adminRouter.post("/plans/:id/toggle-active", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { active } = req.body || {};
    const { rows } = await query(
      `UPDATE subscription_plans SET is_active = $1, updated_by = $2, updated_at = now() WHERE id = $3
       RETURNING id, plan_key, is_active`,
      [!!active, req.admin.id, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   TAX SETTINGS — the seller identity embedded in every ZATCA
   invoice. Gated at 'owner' (stricter than plans) because an error
   here corrupts every invoice generated afterward.
   ============================================================ */

adminRouter.get("/tax-settings", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await query(`SELECT legal_name, vat_number, address, updated_at FROM tax_settings LIMIT 1`);
    res.json({ settings: rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// PUT /admin/tax-settings  { legalName, vatNumber, address }
// Upsert into the single-row table (see schema.sql singleton constraint).
adminRouter.put("/tax-settings", requireAdminAuth, requireRole("owner"), async (req, res) => {
  try {
    const { legalName, vatNumber, address } = req.body || {};
    if (!legalName?.trim() || !vatNumber?.trim()) {
      return res.status(400).json({ error: "legalName_and_vatNumber_required" });
    }
    if (!/^\d{15}$/.test(vatNumber.trim())) {
      // Saudi VAT registration numbers are always 15 digits.
      return res.status(400).json({ error: "vatNumber_must_be_15_digits" });
    }
    const { rows } = await query(
      `INSERT INTO tax_settings (singleton, legal_name, vat_number, address, updated_by, updated_at)
       VALUES (true, $1, $2, $3, $4, now())
       ON CONFLICT (singleton) DO UPDATE SET
         legal_name = EXCLUDED.legal_name, vat_number = EXCLUDED.vat_number,
         address = EXCLUDED.address, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING legal_name, vat_number, address, updated_at`,
      [legalName.trim(), vatNumber.trim(), address?.trim() || null, req.admin.id]
    );
    res.json({ settings: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   INVOICES — real ZATCA Simplified Tax Invoices generated
   automatically on payment. Read-only here by design: an invoice is
   a legal record once issued, never editable from this API.
   ============================================================ */

adminRouter.get("/invoices", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = 25;
    const { rows } = await query(
      `SELECT i.id, i.zatca_invoice_number, i.plan_id, i.amount_sar, i.subtotal_sar, i.vat_sar,
              i.status, i.zatca_issued_at, i.created_at, u.email AS user_email, u.name AS user_name
       FROM invoices i
       JOIN users u ON u.id = i.user_id
       WHERE i.status = 'paid'
       ORDER BY i.zatca_issued_at DESC NULLS FIRST, i.created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, (page - 1) * pageSize]
    );
    /* --------------------------------------------------------
       needsAttention كان يُحسب على **الصفحة المعروضة وحدها**:
       rows.filter(...). فيقول صفراً بينما الصفحة الثالثة فيها خمس
       فواتير مدفوعة بلا رقم ضريبي. عدّاد تحذير يقول "لا شيء" وهو
       لا يعرف أسوأ من غيابه.
       الآن يُحسب على كامل المجموعة، ومعه الإجمالي وعدد الصفحات
       اللذان كانا ناقصين أصلاً.
       -------------------------------------------------------- */
    const [{ rows: totalRows }, { rows: attentionRows }] = await Promise.all([
      query(`SELECT count(*)::int AS n FROM invoices WHERE status = 'paid'`),
      query(`SELECT count(*)::int AS n FROM invoices WHERE status = 'paid' AND zatca_invoice_number IS NULL`),
    ]);
    const total = totalRows[0].n;
    res.json({
      invoices: rows, page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      needsAttention: attentionRows[0].n,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /admin/invoices/:id/regenerate — for the real failure mode
// found during testing: a payment can succeed (subscription activated)
// while the invoice PDF/number generation fails separately (e.g. tax
// settings were briefly misconfigured). This lets an admin retry
// document generation for that specific paid invoice without needing
// direct database access.
adminRouter.post("/invoices/:id/regenerate", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await withTransaction(async (client) => {
      // Lock the row first — same fix as the webhook handler's
      // duplicate-delivery bug, applied here too since two admins (or
      // one admin double-clicking) could otherwise both pass the
      // "no invoice number yet" check before either write lands.
      const { rows } = await client.query(
        `SELECT i.id, i.user_id, i.plan_id, i.amount_sar, i.zatca_invoice_number, u.email AS user_email
         FROM invoices i JOIN users u ON u.id = i.user_id
         WHERE i.id = $1 AND i.status = 'paid' FOR UPDATE OF i`,
        [req.params.id]
      );
      const invoice = rows[0];
      if (!invoice) return { httpStatus: 404, body: { error: "not_found_or_not_paid" } };
      if (invoice.zatca_invoice_number) return { httpStatus: 409, body: { error: "already_has_invoice_number" } };

      const { rows: planRows } = await client.query(`SELECT name FROM subscription_plans WHERE plan_key = $1`, [invoice.plan_id]);
      if (!planRows[0]) return { httpStatus: 422, body: { error: "unknown_plan_cannot_regenerate" } };

      const generated = await generateAndStoreInvoice(
        { invoiceId: invoice.id, userId: invoice.user_id, planName: planRows[0].name, totalSar: invoice.amount_sar, buyerEmail: invoice.user_email },
        client
      );
      if (!generated) return { httpStatus: 422, body: { error: "tax_settings_not_configured" } };
      return { httpStatus: 200, body: generated };
    });
    res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /admin/invoices/:id/pdf — streams the exact PDF generated at
// payment time (never regenerated on demand, so a reprint always
// matches what was originally issued — the QR timestamp must never
// drift from what's on the stored document).
adminRouter.get("/invoices/:id/pdf", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await query(`SELECT pdf_data, zatca_invoice_number FROM invoices WHERE id = $1 AND status = 'paid'`, [req.params.id]);
    const invoice = rows[0];
    if (!invoice || !invoice.pdf_data) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoice.zatca_invoice_number}.pdf"`);
    res.send(invoice.pdf_data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   CREDIT NOTES — issued automatically on refund. Read-only, same
   principle as invoices: a legal document, never editable here.
   ============================================================ */

adminRouter.get("/credit-notes", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT cn.id, cn.zatca_credit_note_number, cn.amount_sar, cn.reason, cn.zatca_issued_at,
              i.zatca_invoice_number AS original_invoice_number, u.email AS user_email, u.name AS user_name
       FROM credit_notes cn
       JOIN invoices i ON i.id = cn.original_invoice_id
       JOIN users u ON u.id = cn.user_id
       ORDER BY cn.zatca_issued_at DESC
       LIMIT 100`
    );
    res.json({ creditNotes: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

adminRouter.get("/credit-notes/:id/pdf", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await query(`SELECT pdf_data, zatca_credit_note_number FROM credit_notes WHERE id = $1`, [req.params.id]);
    const note = rows[0];
    if (!note || !note.pdf_data) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${note.zatca_credit_note_number}.pdf"`);
    res.send(note.pdf_data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   CONTACT MESSAGES
   ============================================================ */

adminRouter.get("/messages", requireAdminAuth, requireRole("support"), async (req, res) => {
  try {
    const { rows } = await query(`SELECT id, name, email, message, status, created_at FROM contact_messages ORDER BY created_at DESC LIMIT 100`);
    res.json({ messages: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

adminRouter.post("/messages/:id/status", requireAdminAuth, requireRole("support"), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!["unread", "read", "replied"].includes(status)) return res.status(400).json({ error: "invalid_status" });
    const { rows } = await query(`UPDATE contact_messages SET status = $1 WHERE id = $2 RETURNING id, status`, [status, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   BULK BROADCAST EMAIL — real delivery via Resend's batch endpoint,
   NOT connected to the consumer app's in-app notification bell (that
   bell is local-only client state with no backend sync yet). Gated
   at 'admin' — sending mass email to real users is a real action
   worth restricting past the 'support' tier.
   ============================================================ */

/* ------------------------------------------------------------
   الجمهور يُحدَّد بشرط الاستحقاق الموحّد نفسه، لا بـ status = 'active'.

   العطب الذي كان: رسالة موجّهة "للمشتركين" كانت تصل كل من اشترك
   يوماً ما، بما فيهم من انتهى اشتراكه من سنة. والأسوأ أن جمهور
   "المجاني" كان يستثنيهم — فمن انتهى اشتراكه لا يصله عرض التجديد
   ولا رسالة المشتركين. أي أن الفئة الأولى بالاستهداف تجارياً كانت
   الوحيدة التي لا تصلها رسالة إطلاقاً.
   ------------------------------------------------------------ */
const LATEST_SUB = `
  SELECT DISTINCT ON (user_id) id, user_id, status, current_period_end
  FROM subscriptions ORDER BY user_id, created_at DESC`;

const AUDIENCE_QUERIES = {
  all: `SELECT id AS "userId", email FROM users WHERE deleted_at IS NULL AND marketing_opt_out = false`,
  active_subscribers: `
    SELECT u.id AS "userId", u.email FROM users u
    JOIN (${LATEST_SUB}) s ON s.user_id = u.id
    WHERE u.deleted_at IS NULL AND u.marketing_opt_out = false AND ${entitledSql("s")}`,
  trial_or_free: `
    SELECT u.id AS "userId", u.email FROM users u
    LEFT JOIN (${LATEST_SUB}) s ON s.user_id = u.id
    WHERE u.deleted_at IS NULL AND u.marketing_opt_out = false
      AND (s.id IS NULL OR NOT ${entitledSql("s")})`,
};

// GET /admin/broadcasts/audience-count?audience=all
// Lets the admin UI show "هذا سيصل لـ 214 مستخدم" BEFORE they commit
// to sending — sending mass email is hard to undo once it's out.
adminRouter.get("/broadcasts/audience-count", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const audience = req.query.audience;
    if (!AUDIENCE_QUERIES[audience]) return res.status(400).json({ error: "invalid_audience" });
    const { rows } = await query(`SELECT count(*)::int AS n FROM (${AUDIENCE_QUERIES[audience]}) sub`);
    res.json({ count: rows[0].n });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /admin/broadcasts — send history
adminRouter.get("/broadcasts", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.id, b.subject, b.audience, b.recipient_count, b.failed_count, b.created_at, au.name AS sent_by_name
       FROM broadcast_notifications b LEFT JOIN admin_users au ON au.id = b.sent_by
       ORDER BY b.created_at DESC LIMIT 50`
    );
    res.json({ broadcasts: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /admin/broadcasts  { subject, message, audience }
adminRouter.post("/broadcasts", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { subject, message, audience } = req.body || {};
    if (!subject?.trim() || !message?.trim() || !AUDIENCE_QUERIES[audience]) {
      return res.status(400).json({ error: "subject_message_and_valid_audience_required" });
    }

    const { rows: recipientRows } = await query(AUDIENCE_QUERIES[audience]);
    const recipients = recipientRows; // [{ userId, email }] — see notifications/broadcast.js

    if (recipients.length === 0) {
      return res.status(422).json({ error: "no_recipients_in_audience" });
    }

    const { sent, failed, errors } = await sendBroadcast({ recipients, subject: subject.trim(), plainTextMessage: message.trim() });

    const { rows } = await query(
      `INSERT INTO broadcast_notifications (subject, message, audience, recipient_count, failed_count, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [subject.trim(), message.trim(), audience, sent, failed, req.admin.id]
    );

    res.status(201).json({ id: rows[0].id, sent, failed, totalRecipients: recipients.length, errors: errors.slice(0, 3) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
