import express from "express";
import rateLimit from "express-rate-limit";
import { query, withTransaction } from "../db/pool.js";
import {
  verifyAdminCredentials, issueAccessToken, issueRefreshToken, verifyToken,
  touchLastLogin, setAuthCookies, clearAuthCookies,
} from "./auth.js";
import {
  requireAdminAuth, requirePermission, requireReasonAndLog, requireUuidParam,
  logAdminAction, loadEffectiveAdmin, fail, httpError,
} from "./middleware.js";
import { permissionsFor, ROLE_LABEL } from "./permissions.js";
import { generateAndStoreInvoice } from "../invoicing/generate.js";
import { executeRefund } from "../payments/refund.js";
import { billingRouter } from "./billing.js";
import { entitledSql } from "../billing/subscription.js";
import { getBillingSettings } from "../billing/config.js";

export const adminRouter = express.Router();

/* ============================================================
   الصفحات المالية للمرحلة 3 — في admin/billing.js.

   في ملف منفصل لا لأن هذا الملف طويل فحسب، بل لأن المسارات المالية
   لها قواعد مختلفة: كلها مشروطة بسبب مكتوب، وكلها تُسجَّل في
   admin_action_log، وأي تعديل عليها يُراجع كتغيير مالي لا كتغيير
   واجهة.
   ============================================================ */
adminRouter.use("/billing", billingRouter);

/* ============================================================
   ⚠️ حسابات الإدارة انتقلت إلى admin/accounts.js

   كانت هنا ثلاثة مسارات (GET/POST /admin-users و PATCH
   /admin-users/:id). انتقلت لأنها صارت دورة حياة كاملة — دعوة
   برمز، وقبول، واستعادة كلمة مرور — لا ثلاثة استعلامات.

   وحُذفت من هنا ولم تُترك بجانب البديل: مساران بنفس العنوان في
   ملفين يعني أن من يعدّل الخطأ منهما لا يرى أثراً، وهو نمط العطب
   المتكرر في هذا المشروع. مسار واحد فقط لكل عنوان.

   🔴 index.js لازم يركّب adminAccountsRouter قبل adminRouter.
   ============================================================ */

/* ------------------------------------------------------------
   حدّ محاولات الدخول.

   بالعنوان لا بالحساب — وهذا حدّ معروف لا يُدَّعى غيره: مهاجم
   يوزّع محاولاته على عناوين كثيرة لا يصطدم به. القفل لكل حساب
   يحتاج عمود محاولات على admin_users، وهو جدول يملكه postgres فلا
   يقبل ALTER؛ وجدول جانبي لهذا وحده تكلفة لا تقابلها فائدة اليوم:
   حسابات الإدارة كلها بحد أدنى 15 حرفاً، وعشر محاولات كل ربع ساعة
   لكل عنوان تجعل التخمين المتصل غير عملي أصلاً.

   موثّق في 05_ADMIN_SECURITY_AUDIT.md كقيد معروف لا كثغرة مجهولة.
   ------------------------------------------------------------ */
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

/* ------------------------------------------------------------
   ⚠️ محدِّد منفصل للتجديد — إصلاح لعطب كشفه اختبار متصفّح آلي.

   كان /auth/refresh يشارك loginLimiter نفسه (10 كل ربع ساعة لكل
   عنوان). والتجديد ليس فعلاً يقوم به المسؤول: تناديه اللوحة
   تلقائياً عند كل 401 — أي عند كل إقلاع بلا جلسة، وعند كل انتهاء
   لرمز عمره خمس عشرة دقيقة.

   فالحصيلة أن الاستعمال العادي يستهلك ميزانية **الدخول**: خمسة
   حسابات تفتح اللوحة تستنفد الحد، فيُردّ السادس بـ429 عند تسجيل
   دخول شرعي. ومكتب فيه ثلاثة مسؤولين خلف عنوان واحد كان سيقفل
   بعضه بعضاً كل ربع ساعة بلا سبب ظاهر.

   ظهر حرفياً في الاختبار: خمسة أدوار تسجّل دخولها بالتتابع،
   فالخامس يصل إلى شاشة بيضاء بلا أقسام.

   التجديد يبقى محدوداً — لكن بحدّ يناسب ما هو: عملية خلفية متكررة
   لا محاولة تخمين. والرمز نفسه موقَّع ومحدود المدة، فالإغراق به لا
   يعطي شيئاً.
   ------------------------------------------------------------ */
const refreshLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

/** الشكل الذي تراه اللوحة عن نفسها — الدور وصلاحياته معاً.
    اللوحة لا تحمل مصفوفة صلاحيات خاصة بها؛ ترسم مما يصلها هنا. */
function selfPayload(admin) {
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    roleLabel: ROLE_LABEL[admin.role] || admin.role,
    permissions: permissionsFor(admin.role),
  };
}

/* ============================================================
   المصادقة — الرموز في كوكي httpOnly فقط، ولا تظهر في جسم رد أبداً.
   ============================================================ */

// POST /admin/auth/login  { email, password }
adminRouter.post("/auth/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "email_and_password_required" });

    const credentials = await verifyAdminCredentials(email, password);
    if (!credentials) {
      // ردّ واحد سواء كان البريد مجهولاً أو كلمة المرور خاطئة —
      // لا يُؤكَّد أي بريد إدارة موجود لمن يجرّب.
      return res.status(401).json({ error: "invalid_credentials" });
    }

    /* الدور الفعلي من القاعدة لا من صف admin_users وحده: حساب
       المحاسب أساسه support هناك، ودوره الحقيقي في
       admin_role_assignments. بدون هذا السطر يدخل المحاسب ويرى
       لوحة موظف دعم. */
    const admin = await loadEffectiveAdmin(credentials.id);
    if (!admin || !admin.active) return res.status(401).json({ error: "invalid_credentials" });

    await touchLastLogin(admin.id);
    setAuthCookies(res, { accessToken: issueAccessToken(admin), refreshToken: issueRefreshToken(admin) });
    res.json({ admin: selfPayload(admin) });
  } catch (err) { fail(res, err, "admin/auth:login", req); }
});

// POST /admin/auth/refresh — يقرأ رمز التجديد من كوكيه الخاص، لا من
// جسم الطلب: جسم JSON تقرأه أي JS في الصفحة، وهو بالضبط ما تتجنبه
// كوكي httpOnly.
adminRouter.post("/auth/refresh", refreshLimiter, async (req, res) => {
  try {
    const refreshToken = req.cookies?.kanaf_admin_refresh;
    if (!refreshToken) return res.status(401).json({ error: "no_refresh_cookie" });

    const payload = verifyToken(refreshToken);
    if (payload.type !== "refresh") return res.status(401).json({ error: "wrong_token_type" });

    const admin = await loadEffectiveAdmin(payload.sub);
    if (!admin || !admin.active) return res.status(401).json({ error: "account_inactive" });

    setAuthCookies(res, { accessToken: issueAccessToken(admin) });
    // الدور قد يكون تغيّر منذ الدخول — يُعاد مع كل تجديد فتصحّح
    // اللوحة قائمتها بلا انتظار إعادة تحميل.
    res.json({ ok: true, admin: selfPayload(admin) });
  } catch {
    res.status(401).json({ error: "invalid_or_expired_refresh_token" });
  }
});

// POST /admin/auth/logout
adminRouter.post("/auth/logout", (req, res) => {
  clearAuthCookies(res);
  res.json({ ok: true });
});

// GET /admin/auth/me — تستعيد اللوحة هويتها وصلاحياتها بلا أن تقرأ
// الكوكي (لا تستطيع أصلاً).
adminRouter.get("/auth/me", requireAdminAuth, (req, res) => {
  res.json({ admin: selfPayload(req.admin) });
});

/* ============================================================
   النظرة العامة — أرقام مجمّعة فقط، بلا تفصيل عن أي مستخدم بعينه
   ============================================================ */

adminRouter.get("/overview", requireAdminAuth, requirePermission("overview:view"), async (req, res) => {
  try {
    const settings = await getBillingSettings();
    const tz = settings.reportingTimezone;

    /* ------------------------------------------------------------
       حدود «آخر 30 يوماً» بالمنطقة الزمنية المحاسبية لا بمنطقة
       الخادم.

       كانت `now() - interval '30 days'` — أي بتوقيت UTC، والخادم
       على Render يعمل بـUTC. فـ«اليوم» يبدأ الثالثة فجراً بتوقيت
       الرياض، ومبيعات ثلاث ساعات تُنسب دائماً لليوم الخطأ.

       والأسوأ أن /admin/billing/kpis كان يحسبها بالمنطقة الصحيحة
       بالفعل. فالصفحة الرئيسية وصفحة المؤشرات كانتا تعطيان رقمين
       مختلفين لنفس السؤال، ولا شيء يقول أيهما الصحيح.
       ------------------------------------------------------------ */
    const rangeStart = `(((now() AT TIME ZONE $1)::date - 29)::timestamp AT TIME ZONE $1)`;

    const wantsRevenue = req.admin.can("overview:view_revenue");

    const tasks = [
      query(`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL`),
      /* --------------------------------------------------------
         كان هذا العدّاد: WHERE status = 'active' — حرفياً.

         وهو خطأ صامت ومتراكم: انتهاء الاشتراك لا يُكتب في العمود
         (لا cron في المشروع)، فاشتراك انتهت مدته من ستة أشهر يبقى
         status = 'active' إلى الأبد. الرقم المعروض كان مجموع كل من
         اشترك يوماً ما، لا عدد المشتركين الفعليين، والفارق يتسع كل
         شهر.

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
      // تصنيفي ومجمَّع فقط — لا يُربط بمستخدم بعينه هنا ولا في أي
      // مكان: الجدول نفسه بلا عمود هوية.
      query(
        `SELECT trigger_source, count(*)::int AS n FROM crisis_trigger_events
          WHERE occurred_at >= ${rangeStart} GROUP BY trigger_source`,
        [tz]
      ),
    ];

    /* الكتلة المالية لا تُستعلَم أصلاً لمن لا يملك صلاحيتها.

       ليس إخفاءً في الواجهة: الاستعلام لا يُشغَّل، والرقم لا يعبر
       الشبكة، ولا يستقر في ذاكرة متصفح، ولا يظهر في أي وسيط. وهذا
       هو الدرس المكتوب بثمن في هذا المشروع — daily_logs.note كان
       يعبر الشبكة سنة كاملة لأن الشاشة لم تكن تعرضه. */
    if (wantsRevenue) {
      tasks.push(query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE status IN ('paid','refunded','partially_refunded')), 0) AS gross,
                COALESCE(SUM(refunded_amount), 0) AS refunded,
                count(*) FILTER (WHERE status = 'failed')::int AS failed
           FROM payments
          WHERE COALESCE(captured_at, created_at) >= ${rangeStart}`,
        [tz]
      ));
    }

    const [userCount, activeSubs, unreadMessages, crisisEvents, money] = await Promise.all(tasks);

    const body = {
      totalUsers: userCount.rows[0].n,
      activeSubscriptions: activeSubs.rows[0].n,
      unreadMessages: unreadMessages.rows[0].n,
      crisisEventsLast30Days: crisisEvents.rows,
      range: { days: 30, timezone: tz },
    };

    if (wantsRevenue) {
      const m = money.rows[0];
      body.last30Days = {
        grossRevenue: Number(Number(m.gross).toFixed(2)),
        refunds: Number(Number(m.refunded).toFixed(2)),
        netRevenue: Number((Number(m.gross) - Number(m.refunded)).toFixed(2)),
        failedPayments: m.failed,
        currency: settings.currency,
      };
    }

    res.json(body);
  } catch (err) { fail(res, err, "admin/overview", req); }
});

/* ============================================================
   المستخدمون — القائمة لا تحمل إلا الحقول غير الحساسة؛ والحساسة
   خلف سبب مكتوب يُسجَّل قبل أن تُقرأ.
   ============================================================ */

/* حالة الحساب مشتقّة لا مخزّنة — انظر 003_admin_user_operations.sql.
   هذا التعريف الوحيد لها، تستعمله القائمة والتفصيل معاً فلا
   يختلفان. */
const ACCOUNT_STATUS_SQL = `
  CASE
    WHEN u.deleted_at IS NOT NULL     THEN 'deleted'
    WHEN s.suspended_at IS NOT NULL   THEN 'suspended'
    WHEN u.email_verified_at IS NULL  THEN 'pending_verification'
    ELSE 'active'
  END`;

// قائمة بيضاء. عمود الترتيب يُدمج في نص الاستعلام — وهو آمن **فقط**
// لأن القيمة لا تأتي من الطلب مباشرة بل من بحث مفتاح هنا. لا تُضِف
// فرعاً يمرّر req.query.
const USER_SORT_COLUMNS = {
  created_at: "u.created_at",
  name: "u.name",
  email: "u.email",
  last_login: "s.last_login_at",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* بنّاء شرط قائمة المستخدمين — مستخرَج في دالة لأن التصدير
   (admin/exports.js) يستعمله حرفياً. تصدير يبني شرطه بنفسه يعني
   ملفاً يقول غير ما تقوله الشاشة، وهو أسوأ من غياب التصدير. */
export function buildUserListFilter(reqQuery) {
  const search = String(reqQuery.search || "").trim();
  const status = String(reqQuery.status || "all");
  const subscription = String(reqQuery.subscription || "all");
  const from = String(reqQuery.from || "").trim();
  const to = String(reqQuery.to || "").trim();

  const where = [];
  const params = [];
  const p = (v) => `$${params.push(v)}`;

  // المحذوفة مخفية إلا إذا طُلبت صراحة. ما زالت موجودة (حذف ناعم)
  // وقد يحتاج المالك رؤيتها.
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
    // مطابقة معرّف سؤال مختلف عن البحث بالاسم، فتُعامل كذلك: لصق
    // UUID يجب أن يعيد ذلك المستخدم، لا صفر صفوف لأن المعرّف ليس
    // في الاسم أو البريد.
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
  // نهاية اليوم شاملة: `to` بتاريخ فقط كانت ستستبعد كل من سجّل ذلك
  // اليوم بصمت.
  if (to) where.push(`u.created_at < (${p(to)}::date + interval '1 day')`);

  /* --------------------------------------------------------
     أحدث اشتراك لكل مستخدم في مرور واحد بـDISTINCT ON بدل
     استعلام فرعي مرتبط داخل قائمة SELECT — ذاك كان يشغّل
     استعلاماً إضافياً لكل صف يُعاد، أي N+1 مخبّأ داخل عبارة
     واحدة.

     LATERAL ... LIMIT 1 أفضل قليلاً على نطاق كبير. لا يُستعمل
     لسبب واحد صريح: نطاق subscriptions اليوم بالآلاف والفرق غير
     قابل للقياس. يُعاد النظر إذا تجاوز الجدول ~100 ألف صف —
     ولا يمكن إضافة فهرس عليه أصلاً لأنه من الجداول التي يملكها
     postgres.
     -------------------------------------------------------- */
  const fromAndJoins = `
    FROM users u
    LEFT JOIN user_auth_state s ON s.user_id = u.id
    LEFT JOIN (
      SELECT DISTINCT ON (user_id) user_id, status, plan_id, current_period_end
      FROM subscriptions
      ORDER BY user_id, created_at DESC
    ) sub ON sub.user_id = u.id
    WHERE ${where.join(" AND ")}`;

  return { fromAndJoins, params, next: (v) => `$${params.push(v)}`, filters: { search, status, subscription, from, to } };
}

// GET /admin/users?search=&page=&pageSize=&status=&subscription=&from=&to=&sort=&dir=
adminRouter.get("/users", requireAdminAuth, requirePermission("users:view"), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
    const offset = (page - 1) * pageSize;

    const sortCol = USER_SORT_COLUMNS[String(req.query.sort || "created_at")] || "u.created_at";
    const dir = String(req.query.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

    const { fromAndJoins, params, next, filters } = buildUserListFilter(req.query);

    // يُعدّ بنفس مجموعة الشروط بالضبط، فلا يمكن للإجمالي أن يصف
    // مجتمعاً غير المعروض.
    const { rows: countRows } = await query(`SELECT count(*)::int AS total ${fromAndJoins}`, params);
    const total = countRows[0].total;

    const limitParam = next(pageSize);
    const offsetParam = next(offset);

    const { rows: users } = await query(
      `SELECT u.id, u.name, u.email, u.created_at, u.email_verified_at,
              s.last_login_at, s.suspended_at,
              ${ACCOUNT_STATUS_SQL} AS account_status,
              sub.status AS subscription_status,
              sub.plan_id AS subscription_plan
       ${fromAndJoins}
       -- u.id هو كاسر التعادل، وليس اختيارياً: بدونه تتبدّل مواضع
       -- الصفوف المتساوية في created_at بين طلبين، فتتكرر سجلات في
       -- الصفحة الثانية وتُفقد أخرى من الأولى.
       ORDER BY ${sortCol} ${dir} NULLS LAST, u.id DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params
    );

    res.json({
      users, page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      filters: { ...filters, sort: req.query.sort || "created_at", dir: dir.toLowerCase() },
    });
  } catch (err) { fail(res, err, "admin/users:list", req); }
});

// GET /admin/users/:id — حقول الملف غير الحساسة. لا تسجيل: الاسم
// والبريد والتواريخ ليست الجزء الحساس.
adminRouter.get(
  "/users/:id",
  requireAdminAuth, requirePermission("users:view"), requireUuidParam("id"),
  async (req, res) => {
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

      // غائب عن هذه الحمولة عمداً: password_hash و pin_hash وكل رمز
      // جلسة. لا استعمال تشغيلياً لها في اللوحة، والحقل الذي لا
      // يُرسَل لا يمكن أن يتسرّب.
      res.json(rows[0]);
    } catch (err) { fail(res, err, "admin/users:detail", req); }
  }
);

/* ============================================================
   إجراءات حالة الحساب

   التعليق يُفرَض في ثلاثة مواضع، وثلاثتها لازمة ليعني شيئاً:
     1. هنا — تُكتب الحالة
     2. auth/routes.js login — الحساب المعلَّق لا يدخل
     3. auth/middleware.js requireVerifiedUser — الوصول القائم يتوقف

   الثالث هو سبب إبطال الجلسات أدناه. بدونه يبقى المعلَّق حاملاً رمز
   وصول صالحاً خمس عشرة دقيقة — تعليق لا يعلّق.
   ============================================================ */

// POST /admin/users/:id/suspend  { reason }
adminRouter.post(
  "/users/:id/suspend",
  requireAdminAuth, requirePermission("users:suspend"), requireUuidParam("id"),
  async (req, res) => {
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "reason_required", message: "لازم تكتب سبب التعليق." });
    if (reason.length > 500) return res.status(400).json({ error: "reason_too_long", maxLength: 500 });

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

      // أثر فوري، لا «عند الدخول القادم».
      const { rowCount: revoked } = await query(
        `UPDATE user_sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [req.params.id]
      );

      // يُسجَّل بعد نجاح الكتابة — السجل يجب ألا يدّعي تغييراً لم يقع.
      await logAdminAction({
        adminUserId: req.admin.id, targetUserId: req.params.id,
        action: "suspend_account", entity: "user", entityId: req.params.id,
        oldValue: { account_status: "active" }, newValue: { account_status: "suspended" },
        reason, metadata: { sessions_revoked: revoked }, ipAddress: req.ip,
      });

      res.json({ ok: true, account_status: "suspended", sessionsRevoked: revoked });
    } catch (err) { fail(res, err, "admin/users:suspend", req); }
  }
);

// POST /admin/users/:id/restore  { reason }
adminRouter.post(
  "/users/:id/restore",
  requireAdminAuth, requirePermission("users:suspend"), requireUuidParam("id"),
  async (req, res) => {
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "reason_required", message: "لازم تكتب سبب رفع التعليق." });
    if (reason.length > 500) return res.status(400).json({ error: "reason_too_long", maxLength: 500 });

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
        adminUserId: req.admin.id, targetUserId: req.params.id,
        action: "restore_account", entity: "user", entityId: req.params.id,
        oldValue: { account_status: "suspended", suspended_reason: user.suspended_reason },
        newValue: { account_status: newStatus },
        reason, ipAddress: req.ip,
      });

      res.json({ ok: true, account_status: newStatus });
    } catch (err) { fail(res, err, "admin/users:restore", req); }
  }
);

// GET /admin/users/:id/actions — تاريخ التغييرات على مستخدم واحد.
adminRouter.get(
  "/users/:id/actions",
  requireAdminAuth, requirePermission("users:view_actions"), requireUuidParam("id"),
  async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT al.id, al.admin_user_id, au.name AS admin_name, al.action,
                al.entity, al.entity_id, al.old_value, al.new_value,
                al.reason, al.metadata, al.created_at
           FROM admin_action_log al
           LEFT JOIN admin_users au ON au.id = al.admin_user_id
          WHERE al.target_user_id = $1
          ORDER BY al.created_at DESC
          LIMIT 100`,
        [req.params.id]
      );
      res.json({ actions: rows });
    } catch (err) { fail(res, err, "admin/users:actions", req); }
  }
);

/* GET /admin/users/:id/sensitive?reason=...

   يعيد **درجات** اليوميات ونتائج الفرز، خلف requireReasonAndLog التي
   تكتب صف التدقيق قبل تشغيل هذا المعالج.

   `daily_logs.note` كان مُنتقى هنا حتى ضُبط في المراجعة. هو وصف
   المستخدم الحرّ لحالته النفسية — أخصّ حقل في هذه القاعدة، مصنَّف
   D في 04_PRIVACY_CLASSIFICATION.md («لا يُعرض إطلاقاً»)، والوثيقة
   نفسها كانت تقول إن لا استعلام إداري يختاره. كانت مصيبة في السياسة
   ومخطئة في وصف الكود.

   واللوحة لم تكن تعرضه — وهذا بالضبط سبب بقائه: الحقل الذي لا
   تعرضه أي شاشة يظل يعبر الشبكة، ويستقر في ذاكرة المتصفح، ويظهر في
   أي ملف HAR أو سجل وسيط بينهما. الإخفاء في الواجهة ليس منعاً.

   و`tags` ذهب معه: التصنيف يسمح بالدرجات لأن «هل ما زال يستخدم
   التطبيق؟» يُجاب بالأرقام؛ أما الوسوم فكلمات يكتبها المستخدم بنفسه
   وتسرّب ما يسرّبه النص، أقصر فقط. */
adminRouter.get(
  "/users/:id/sensitive",
  requireAdminAuth,
  requirePermission("users:view_sensitive"),
  requireUuidParam("id"),
  requireReasonAndLog("view_sensitive_data"),
  async (req, res) => {
    try {
      const userId = req.params.id;
      const [{ rows: logs }, { rows: screenings }] = await Promise.all([
        query(`SELECT mood, sleep, energy, logged_on FROM daily_logs WHERE user_id = $1 ORDER BY logged_on DESC LIMIT 30`, [userId]),
        query(`SELECT kind, total, band_label, created_at FROM screenings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [userId]),
        // ملاحظة: screenings.answers (على مستوى البند) غير منتقاة هنا
        // عمداً — الدرجة والنطاق يكفيان لغرض الدعم. رؤية الإجابات
        // الخام تحتاج طلب وصول طارئ.
      ]);
      res.json({ logs, screenings });
    } catch (err) { fail(res, err, "admin/users:sensitive", req); }
  }
);

/* POST /admin/users/:id/subscription/cancel  { reason, atPeriodEnd? }

   الافتراضي إلغاء فوري، و atPeriodEnd: true يحوّله إلى إلغاء بنهاية
   المدة. لا يلمس فاتورة ولا يصدر إشعاراً دائناً — لا مال يتحرك هنا.
   لـ«العميل يبي فلوسه» استخدم /admin/billing/payments/:id/refund.

   أُصلح فيه عطبان: كان يتجاهل canceled_at تماماً (فالاشتراك يُلغى
   ولا يُعرف متى، ومؤشر «الملغاة في الفترة» يستحيل حسابه)، وكان
   يشترط status = 'active' حرفياً فلا يقدر على إلغاء اشتراك متعثّر
   السداد — وهو أكثر ما يُطلب إلغاؤه فعلاً. */
adminRouter.post(
  "/users/:id/subscription/cancel",
  requireAdminAuth,
  requirePermission("subscriptions:cancel"),
  requireUuidParam("id"),
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
        if (!sub) throw httpError(404, "no_active_subscription");

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
        adminUserId: req.admin.id, targetUserId: req.params.id,
        action: "manual_subscription_cancel",
        entity: "subscription", entityId: result.subscriptionId,
        oldValue: { status: result.previousStatus },
        newValue: { mode: result.mode, status: result.mode === "immediate" ? "canceled" : "canceling" },
        reason: reason || "—", metadata: { user_id: req.params.id }, ipAddress: req.ip,
      });

      res.json({ ok: true, ...result });
    } catch (err) { fail(res, err, "admin/users:cancel-subscription", req); }
  }
);

/* POST /admin/users/:id/subscription/refund  { reason, amountSar? }

   ⚠️ هذا المسار كان أخطر ما في الطبقة المالية كلها.

   كان يعلّم الفاتورة «مستردة»، ويلغي الاشتراك، ويصدر إشعاراً دائناً
   حقيقياً بختم ZATCA — **دون أن ينادي Moyasar إطلاقاً**. النتيجة أن
   الدفاتر والوثيقة الضريبية تقولان إن المبلغ رُدّ، والمال لم يغادر
   الحساب. وثيقة نظامية صحيحة الشكل تصف واقعة لم تحدث، وموظف الدعم
   يرى «تم» فيغلق التذكرة، والعميل ينتظر مالاً لن يصل.

   الآن يمر بـexecuteRefund: نداء حقيقي للمزوّد أولاً، ولا يُسجَّل شيء
   ولا يصدر إشعار إلا بعد نجاحه. ويعمل على **الدفعة** لا على الفاتورة،
   لأن الفاتورة قد تحمل أكثر من محاولة دفع وواحدة فقط هي المحصَّلة. */
adminRouter.post(
  "/users/:id/subscription/refund",
  requireAdminAuth,
  requirePermission("payments:refund"),
  requireUuidParam("id"),
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
        adminUserId: req.admin.id, targetUserId: req.params.id,
        action: "manual_subscription_refund",
        entity: "payment", entityId: payment.id,
        oldValue: { payment_status: payment.status, refunded_amount: Number(payment.refunded_amount) },
        newValue: { kind: result.kind, refunded_amount: result.totalRefunded, credit_note: result.creditNoteNumber },
        reason: reason || "—", metadata: { user_id: req.params.id }, ipAddress: req.ip,
      });

      res.json({ ok: true, kind: result.kind, amount: result.amount, creditNoteNumber: result.creditNoteNumber || null });
    } catch (err) { fail(res, err, "admin/users:refund", req); }
  }
);

/* ============================================================
   الوصول الطارئ — وصول استثنائي للبيانات الخام (إجابات الفرز على
   مستوى البند مثلاً)، بمعتمِد ثانٍ لا يكون هو الطالب أبداً (يفرضه
   قيد CHECK في قاعدة البيانات أيضاً).
   ============================================================ */

adminRouter.post("/break-glass/request", requireAdminAuth, requirePermission("break_glass:request"), async (req, res) => {
  try {
    const { targetUserId, reason } = req.body || {};
    if (!reason || !reason.trim()) return res.status(400).json({ error: "reason_required" });
    if (targetUserId && !UUID_RE.test(String(targetUserId))) return res.status(400).json({ error: "invalid_target_user" });

    const { rows } = await query(
      `INSERT INTO break_glass_requests (requested_by, target_user_id, reason)
       VALUES ($1, $2, $3) RETURNING id, status, created_at`,
      [req.admin.id, targetUserId || null, reason.trim()]
    );

    await logAdminAction({
      adminUserId: req.admin.id, targetUserId: targetUserId || null,
      action: "break_glass_requested", entity: "break_glass", entityId: rows[0].id,
      newValue: { status: "pending" }, reason: reason.trim(), ipAddress: req.ip,
    });

    res.status(201).json(rows[0]);
  } catch (err) { fail(res, err, "admin/break-glass:request", req); }
});

adminRouter.get("/break-glass/pending", requireAdminAuth, requirePermission("break_glass:view"), async (req, res) => {
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
  } catch (err) { fail(res, err, "admin/break-glass:pending", req); }
});

adminRouter.post(
  "/break-glass/:id/approve",
  requireAdminAuth, requirePermission("break_glass:approve"), requireUuidParam("id"),
  async (req, res) => {
    try {
      const hoursValid = Math.min(Math.max(parseInt(req.body?.hoursValid, 10) || 4, 1), 24);
      const approved = await withTransaction(async (client) => {
        const { rows: existing } = await client.query(
          `SELECT requested_by, status, target_user_id FROM break_glass_requests WHERE id = $1 FOR UPDATE`,
          [req.params.id]
        );
        if (!existing[0]) throw httpError(404, "not_found");
        if (existing[0].status !== "pending") throw httpError(409, "already_resolved");
        if (existing[0].requested_by === req.admin.id) throw httpError(403, "cannot_self_approve");

        const { rows } = await client.query(
          `UPDATE break_glass_requests
              SET status = 'approved', approved_by = $1, approved_at = now(),
                  expires_at = now() + ($2 || ' hours')::interval
            WHERE id = $3 RETURNING id, status, expires_at`,
          [req.admin.id, hoursValid, req.params.id]
        );
        return { row: rows[0], targetUserId: existing[0].target_user_id, requestedBy: existing[0].requested_by };
      });

      await logAdminAction({
        adminUserId: req.admin.id, targetUserId: approved.targetUserId,
        action: "break_glass_approved", entity: "break_glass", entityId: approved.row.id,
        oldValue: { status: "pending" },
        newValue: { status: "approved", expires_at: approved.row.expires_at },
        reason: `اعتماد وصول طارئ لمدة ${hoursValid} ساعة`,
        metadata: { requested_by: approved.requestedBy }, ipAddress: req.ip,
      });

      res.json(approved.row);
    } catch (err) { fail(res, err, "admin/break-glass:approve", req); }
  }
);

/* ============================================================
   سجلا التدقيق

   اثنان لا واحد، وهذا تصميم لا التفاف:
     • admin_access_log يجيب «من **قرأ** بيانات حساسة، ولماذا».
     • admin_action_log يجيب «من **غيّر** حالة، من أي قيمة إلى أي
       قيمة».

   خلطهما في جدول واحد كان يجعل الاستعلام عن أيهما أصعب، ويفرض
   أعمدة قبل/بعد فارغة على كل صف قراءة.

   لا مسار تحديث ولا حذف لأيهما في المستودع كله.
   ============================================================ */

function readPaging(req, { defaultSize = 50, maxSize = 200 } = {}) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(req.query.pageSize, 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/* بنّاء شرط سجل الإجراءات — يشاركه التصدير حرفياً، للسبب نفسه:
   ملف يقول غير ما تقوله الشاشة أسوأ من غياب الملف. */
export function buildAuditFilter(reqQuery) {
  const where = [];
  const params = [];
  const p = (v) => `$${params.push(v)}`;

  const action = String(reqQuery.action || "").trim();
  const entity = String(reqQuery.entity || "").trim();
  const entityId = String(reqQuery.entityId || "").trim();
  const adminUserId = String(reqQuery.adminUserId || "").trim();
  const from = String(reqQuery.from || "").trim();
  const to = String(reqQuery.to || "").trim();

  if (action) where.push(`al.action = ${p(action)}`);
  if (entity) where.push(`al.entity = ${p(entity)}`);
  if (entityId) where.push(`al.entity_id = ${p(entityId)}`);
  if (adminUserId && UUID_RE.test(adminUserId)) where.push(`al.admin_user_id = ${p(adminUserId)}`);
  if (from) where.push(`al.created_at >= ${p(from)}::date`);
  if (to) where.push(`al.created_at < (${p(to)}::date + interval '1 day')`);

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
    next: (v) => `$${params.push(v)}`,
    filters: { action, entity, entityId, adminUserId, from, to },
  };
}

// GET /admin/access-log — سجل القراءات (كان بلا ترقيم وبحد 200 ثابت)
adminRouter.get("/access-log", requireAdminAuth, requirePermission("audit_log:view_reads"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req);
    const targetUserId = UUID_RE.test(String(req.query.targetUserId || "")) ? req.query.targetUserId : null;

    const [{ rows: countRows }, { rows }] = await Promise.all([
      query(`SELECT count(*)::int AS n FROM admin_access_log al WHERE ($1::uuid IS NULL OR al.target_user_id = $1)`, [targetUserId]),
      query(
        `SELECT al.id, al.action, al.reason, al.created_at, al.ip_address, al.target_user_id,
                au.name AS admin_name, au.email AS admin_email
           FROM admin_access_log al
           JOIN admin_users au ON au.id = al.admin_user_id
          WHERE ($1::uuid IS NULL OR al.target_user_id = $1)
          ORDER BY al.created_at DESC
          LIMIT $2 OFFSET $3`,
        [targetUserId, pageSize, offset]
      ),
    ]);

    const total = countRows[0].n;
    res.json({ entries: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  } catch (err) { fail(res, err, "admin/access-log", req); }
});

/* GET /admin/audit-log — سجل الإجراءات. مسار جديد في المرحلة 5.

   الجدول موجود منذ الترحيل 003 ويُكتب فيه بانتظام، ولم يكن له
   قارئ واحد في اللوحة إلا عبر /users/:id/actions — أي أن كل فعل لا
   يخصّ مستخدماً بعينه (تعديل سعر، تغيير ضريبة، ترقية مسؤول) كان
   يُسجَّل ولا يُقرأ أبداً. سجل لا يُقرأ ليس سجلاً. */
adminRouter.get("/audit-log", requireAdminAuth, requirePermission("audit_log:view_actions"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req);
    const { whereSql, params, next } = buildAuditFilter(req.query);

    const { rows: countRows } = await query(`SELECT count(*)::int AS n FROM admin_action_log al ${whereSql}`, params);
    const total = countRows[0].n;

    const limitP = next(pageSize);
    const offsetP = next(offset);
    const { rows } = await query(
      `SELECT al.id, al.created_at, al.action, al.entity, al.entity_id,
              al.target_user_id, al.old_value, al.new_value, al.reason,
              al.metadata, al.ip_address,
              au.name AS admin_name, au.email AS admin_email
         FROM admin_action_log al
         LEFT JOIN admin_users au ON au.id = al.admin_user_id
         ${whereSql}
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT ${limitP} OFFSET ${offsetP}`,
      params
    );

    // القيم المتاحة للفلترة تأتي من البيانات نفسها، فلا تُكتب قائمة
    // أفعال في الواجهة تتقادم مع كل فعل جديد.
    const { rows: actions } = await query(
      `SELECT DISTINCT action FROM admin_action_log ORDER BY action`
    );
    const { rows: entities } = await query(
      `SELECT DISTINCT entity FROM admin_action_log WHERE entity IS NOT NULL ORDER BY entity`
    );

    res.json({
      entries: rows, page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      facets: { actions: actions.map((r) => r.action), entities: entities.map((r) => r.entity) },
    });
  } catch (err) { fail(res, err, "admin/audit-log", req); }
});

/* ============================================================
   الباقات — مصدر الحقيقة الحقيقي للأسعار.

   payments/routes.js يقرأ من نفس الجدول، فتعديل هنا يغيّر فعلاً ما
   يُخصم من العميل. ولذلك صار كل تعديل مسجَّلاً بقيمته السابقة
   واللاحقة وسبب مكتوب — لم يكن شيء من ذلك موجوداً: تغيير سعر باقة
   كان يكتب updated_by فقط، فلا يُعرف السعر القديم ولا لماذا تغيّر.
   ============================================================ */

adminRouter.get("/plans", requireAdminAuth, requirePermission("plans:view"), async (req, res) => {
  try {
    // تعرض كل الباقات بما فيها المعطَّلة، ليقدر المسؤول يرى ويعيد
    // تفعيل ما أطفأه سابقاً.
    const { rows } = await query(
      `SELECT id, plan_key, name, price_sar, duration_days, features, is_active, display_order, updated_at
         FROM subscription_plans ORDER BY display_order ASC, created_at ASC`
    );
    res.json({ plans: rows });
  } catch (err) { fail(res, err, "admin/plans:list", req); }
});

// POST /admin/plans  { planKey, name, priceSar, durationDays, features, displayOrder, reason }
adminRouter.post("/plans", requireAdminAuth, requirePermission("plans:edit"), async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  try {
    const { planKey, name, priceSar, durationDays, features, displayOrder } = req.body || {};
    if (!planKey || !name || priceSar === undefined || !durationDays) {
      throw httpError(400, "planKey_name_priceSar_durationDays_required");
    }
    if (!reason) throw httpError(400, "reason_required");
    if (!/^[a-z0-9_]+$/.test(planKey)) {
      // plan_key ينتهي في الفواتير والاشتراكات ثم في وصف الدفع لدى
      // Moyasar — يُحصر في مجموعة محارف آمنة متوقَّعة، لا نص حرّ.
      throw httpError(400, "planKey_must_be_lowercase_letters_numbers_underscores_only");
    }
    const price = Number(priceSar);
    if (!Number.isFinite(price) || price < 0) throw httpError(400, "invalid_price");
    const days = Number(durationDays);
    if (!Number.isInteger(days) || days <= 0) throw httpError(400, "invalid_duration");

    const { rows } = await query(
      `INSERT INTO subscription_plans (plan_key, name, price_sar, duration_days, features, display_order, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, plan_key, name, price_sar, duration_days, features, is_active, display_order`,
      [planKey, name, price, days, features || [], displayOrder || 0, req.admin.id]
    );

    await logAdminAction({
      adminUserId: req.admin.id, action: "plan_created",
      entity: "plan", entityId: rows[0].plan_key,
      oldValue: null,
      newValue: { name: rows[0].name, price_sar: rows[0].price_sar, duration_days: rows[0].duration_days },
      reason, ipAddress: req.ip,
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "plan_key_already_exists" });
    fail(res, err, "admin/plans:create", req);
  }
});

/* PATCH /admin/plans/:id  { name?, priceSar?, durationDays?, features?, displayOrder?, reason }

   لا يمكن تغيير planKey بعد الإنشاء عمداً: الفواتير والاشتراكات
   المنشأة على المفتاح القديم كانت ستشير إلى لا شيء. */
adminRouter.patch(
  "/plans/:id",
  requireAdminAuth, requirePermission("plans:edit"), requireUuidParam("id"),
  async (req, res) => {
    const reason = String(req.body?.reason || "").trim();
    try {
      if (!reason) throw httpError(400, "reason_required");
      const { name, priceSar, durationDays, features, displayOrder } = req.body || {};
      if (priceSar !== undefined && (!Number.isFinite(Number(priceSar)) || Number(priceSar) < 0)) {
        throw httpError(400, "invalid_price");
      }

      /* القيمة القديمة تُقرأ داخل نفس المعاملة وتحت قفل الصف.
         قراءتها في استعلام منفصل قبل التحديث تجعل السجل يقول قيمة
         قد يكون غيرها كُتب بينهما — سجل تدقيق يصف تغييراً لم يقع
         بهذا الشكل. */
      const result = await withTransaction(async (client) => {
        const { rows: before } = await client.query(
          `SELECT plan_key, name, price_sar, duration_days, display_order
             FROM subscription_plans WHERE id = $1 FOR UPDATE`,
          [req.params.id]
        );
        if (!before[0]) throw httpError(404, "not_found");

        const { rows } = await client.query(
          `UPDATE subscription_plans SET
             name = COALESCE($1, name),
             price_sar = COALESCE($2, price_sar),
             duration_days = COALESCE($3, duration_days),
             features = COALESCE($4, features),
             display_order = COALESCE($5, display_order),
             updated_by = $6, updated_at = now()
           WHERE id = $7
           RETURNING id, plan_key, name, price_sar, duration_days, features, is_active, display_order`,
          [
            name ?? null,
            priceSar === undefined ? null : Number(priceSar),
            durationDays === undefined ? null : Number(durationDays),
            features ?? null,
            displayOrder === undefined ? null : Number(displayOrder),
            req.admin.id, req.params.id,
          ]
        );
        return { before: before[0], after: rows[0] };
      });

      const priceChanged = Number(result.before.price_sar) !== Number(result.after.price_sar);
      await logAdminAction({
        adminUserId: req.admin.id,
        action: priceChanged ? "plan_price_changed" : "plan_updated",
        entity: "plan", entityId: result.after.plan_key,
        oldValue: {
          name: result.before.name, price_sar: result.before.price_sar,
          duration_days: result.before.duration_days, display_order: result.before.display_order,
        },
        newValue: {
          name: result.after.name, price_sar: result.after.price_sar,
          duration_days: result.after.duration_days, display_order: result.after.display_order,
        },
        reason, ipAddress: req.ip,
      });

      res.json(result.after);
    } catch (err) { fail(res, err, "admin/plans:update", req); }
  }
);

/* POST /admin/plans/:id/toggle-active  { active, reason }

   التعطيل يخفي الباقة عن الشراء الجديد (payments/routes.js يفلتر
   على is_active) ولا يمسّ المشتركين الحاليين إطلاقاً — نفس مبدأ
   «لا يُعاقَب من اشترك أصلاً» في مفتاح إطلاق المحتوى. */
adminRouter.post(
  "/plans/:id/toggle-active",
  requireAdminAuth, requirePermission("plans:edit"), requireUuidParam("id"),
  async (req, res) => {
    const reason = String(req.body?.reason || "").trim();
    try {
      if (!reason) throw httpError(400, "reason_required");
      const { active } = req.body || {};
      if (typeof active !== "boolean") throw httpError(400, "active_must_be_boolean");

      const result = await withTransaction(async (client) => {
        const { rows: before } = await client.query(
          `SELECT plan_key, is_active FROM subscription_plans WHERE id = $1 FOR UPDATE`, [req.params.id]
        );
        if (!before[0]) throw httpError(404, "not_found");
        const { rows } = await client.query(
          `UPDATE subscription_plans SET is_active = $1, updated_by = $2, updated_at = now()
            WHERE id = $3 RETURNING id, plan_key, is_active`,
          [active, req.admin.id, req.params.id]
        );
        return { before: before[0], after: rows[0] };
      });

      await logAdminAction({
        adminUserId: req.admin.id,
        action: result.after.is_active ? "plan_activated" : "plan_deactivated",
        entity: "plan", entityId: result.after.plan_key,
        oldValue: { is_active: result.before.is_active },
        newValue: { is_active: result.after.is_active },
        reason, ipAddress: req.ip,
      });

      res.json(result.after);
    } catch (err) { fail(res, err, "admin/plans:toggle", req); }
  }
);

/* ============================================================
   البيانات الضريبية — هوية البائع المطبوعة في كل فاتورة ZATCA.

   محصورة بالمالك لأن خطأً هنا يفسد كل فاتورة تصدر بعده. ولم تكن
   تُسجَّل: تغيير الاسم النظامي أو الرقم الضريبي — وكلاهما يدخل
   حرفياً في رمز QR — كان يمر بلا أثر وبلا سبب.
   ============================================================ */

adminRouter.get("/tax-settings", requireAdminAuth, requirePermission("tax_settings:view"), async (req, res) => {
  try {
    const { rows } = await query(`SELECT legal_name, vat_number, address, updated_at FROM tax_settings LIMIT 1`);
    res.json({ settings: rows[0] || null });
  } catch (err) { fail(res, err, "admin/tax-settings:get", req); }
});

// PUT /admin/tax-settings  { legalName, vatNumber, address, reason }
adminRouter.put(
  "/tax-settings",
  requireAdminAuth,
  requirePermission("tax_settings:edit"),
  // إعداد عام للنظام كله — لا مستخدم هدفاً له.
  requireReasonAndLog("update_tax_settings", { resolveTargetUserId: () => null }),
  async (req, res) => {
    const reason = String(req.body?.reason || req.query?.reason || "").trim();
    try {
      const { legalName, vatNumber, address } = req.body || {};
      if (!legalName?.trim() || !vatNumber?.trim()) throw httpError(400, "legalName_and_vatNumber_required");
      // الرقم الضريبي السعودي خمسة عشر رقماً دائماً.
      if (!/^\d{15}$/.test(vatNumber.trim())) throw httpError(400, "vatNumber_must_be_15_digits");

      const result = await withTransaction(async (client) => {
        const { rows: before } = await client.query(
          `SELECT legal_name, vat_number, address FROM tax_settings LIMIT 1`
        );
        const { rows } = await client.query(
          `INSERT INTO tax_settings (singleton, legal_name, vat_number, address, updated_by, updated_at)
           VALUES (true, $1, $2, $3, $4, now())
           ON CONFLICT (singleton) DO UPDATE SET
             legal_name = EXCLUDED.legal_name, vat_number = EXCLUDED.vat_number,
             address = EXCLUDED.address, updated_by = EXCLUDED.updated_by, updated_at = now()
           RETURNING legal_name, vat_number, address, updated_at`,
          [legalName.trim(), vatNumber.trim(), address?.trim() || null, req.admin.id]
        );
        return { before: before[0] || null, after: rows[0] };
      });

      await logAdminAction({
        adminUserId: req.admin.id, action: "tax_settings_updated",
        entity: "tax_settings", entityId: "singleton",
        oldValue: result.before, newValue: result.after,
        reason, ipAddress: req.ip,
      });

      res.json({ settings: result.after });
    } catch (err) { fail(res, err, "admin/tax-settings:put", req); }
  }
);

/* ============================================================
   الفواتير — وثائق ضريبية مبسّطة تصدر تلقائياً عند الدفع.
   للقراءة فقط هنا بحكم التصميم: الفاتورة سجل نظامي بعد إصدارها،
   ولا تُعدَّل من هذه الواجهة أبداً.
   ============================================================ */

adminRouter.get("/invoices", requireAdminAuth, requirePermission("invoices:view"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req, { defaultSize: 25, maxSize: 100 });
    const { rows } = await query(
      `SELECT i.id, i.zatca_invoice_number, i.plan_id, i.amount_sar, i.subtotal_sar, i.vat_sar,
              i.status, i.zatca_issued_at, i.created_at, u.email AS user_email, u.name AS user_name
         FROM invoices i
         JOIN users u ON u.id = i.user_id
        WHERE i.status = 'paid'
        ORDER BY i.zatca_issued_at DESC NULLS FIRST, i.created_at DESC
        LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );

    /* --------------------------------------------------------
       needsAttention كان يُحسب على **الصفحة المعروضة وحدها**:
       rows.filter(...). فيقول صفراً بينما الصفحة الثالثة فيها خمس
       فواتير مدفوعة بلا رقم ضريبي. عدّاد تحذير يقول «لا شيء» وهو
       لا يعرف أسوأ من غيابه.
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
  } catch (err) { fail(res, err, "admin/invoices:list", req); }
});

/* POST /admin/invoices/:id/regenerate — لحالة الفشل الحقيقية التي
   ظهرت في الاختبار: الدفعة تنجح (ويُفعَّل الاشتراك) بينما يفشل
   توليد رقم الفاتورة وملفها في معاملة منفصلة (لأن الإعداد الضريبي
   كان مضبوطاً خطأً لحظتها مثلاً). هذا يعيد المحاولة لتلك الفاتورة
   بعينها بلا حاجة لوصول مباشر لقاعدة البيانات. */
adminRouter.post(
  "/invoices/:id/regenerate",
  requireAdminAuth, requirePermission("invoices:regenerate"), requireUuidParam("id"),
  async (req, res) => {
    const reason = String(req.body?.reason || "").trim() || "إعادة إصدار وثيقة فاتورة مدفوعة بلا رقم ضريبي";
    try {
      const result = await withTransaction(async (client) => {
        // يُقفل الصف أولاً — نفس إصلاح تكرار تسليم الـwebhook،
        // مطبَّقاً هنا لأن مسؤولين اثنين (أو واحداً يضغط مرتين) قد
        // يمرّان معاً من فحص «لا رقم فاتورة بعد» قبل أن تصل كتابة
        // أيّهما.
        const { rows } = await client.query(
          // اسم العميل وفترة الخدمة يُقرآن هنا أيضاً: الفاتورة
          // المعاد إصدارها وثيقة كاملة لا نسخة منقوصة، وغياب اسم
          // المشتري عنها عيب نظامي لا تفصيل تجميلي.
          `SELECT i.id, i.user_id, i.plan_id, i.amount_sar, i.zatca_invoice_number,
                  u.email AS user_email, u.name AS user_name,
                  ss.current_period_start, s.current_period_end, ss.billing_cycle
             FROM invoices i
             JOIN users u ON u.id = i.user_id
             LEFT JOIN subscriptions s ON s.id = i.subscription_id
             LEFT JOIN subscription_state ss ON ss.subscription_id = s.id
            WHERE i.id = $1 AND i.status = 'paid' FOR UPDATE OF i`,
          [req.params.id]
        );
        const invoice = rows[0];
        if (!invoice) return { httpStatus: 404, body: { error: "not_found_or_not_paid" } };
        if (invoice.zatca_invoice_number) return { httpStatus: 409, body: { error: "already_has_invoice_number" } };

        const { rows: planRows } = await client.query(
          `SELECT plan_key, name FROM subscription_plans WHERE plan_key = $1`, [invoice.plan_id]
        );
        if (!planRows[0]) return { httpStatus: 422, body: { error: "unknown_plan_cannot_regenerate" } };

        const generated = await generateAndStoreInvoice(
          {
            invoiceId: invoice.id, userId: invoice.user_id,
            planName: planRows[0].name, planKey: planRows[0].plan_key,
            totalSar: invoice.amount_sar,
            buyerEmail: invoice.user_email, buyerName: invoice.user_name,
            billingCycle: invoice.billing_cycle,
            periodStart: invoice.current_period_start,
            periodEnd: invoice.current_period_end,
          },
          client
        );
        if (!generated) return { httpStatus: 422, body: { error: "tax_settings_not_configured" } };
        return { httpStatus: 200, body: generated, userId: invoice.user_id };
      });

      if (result.httpStatus === 200) {
        await logAdminAction({
          adminUserId: req.admin.id, targetUserId: result.userId,
          action: "invoice_document_regenerated",
          entity: "invoice", entityId: req.params.id,
          newValue: { zatca_invoice_number: result.body?.zatcaInvoiceNumber || result.body?.invoiceNumber || null },
          reason, ipAddress: req.ip,
        });
      }
      res.status(result.httpStatus).json(result.body);
    } catch (err) { fail(res, err, "admin/invoices:regenerate", req); }
  }
);

/* GET /admin/invoices/:id/pdf — يبثّ الملف المولَّد وقت الدفع
   بالضبط (لا يُعاد توليده عند الطلب أبداً)، فإعادة الطباعة تطابق ما
   صدر أصلاً — الطابع الزمني في QR يجب ألا ينحرف عن الوثيقة
   المخزَّنة. */
adminRouter.get(
  "/invoices/:id/pdf",
  requireAdminAuth, requirePermission("invoices:view"), requireUuidParam("id"),
  async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT pdf_data, zatca_invoice_number FROM invoices WHERE id = $1 AND status = 'paid'`, [req.params.id]
      );
      const invoice = rows[0];
      if (!invoice || !invoice.pdf_data) return res.status(404).json({ error: "not_found" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${invoice.zatca_invoice_number}.pdf"`);
      res.send(invoice.pdf_data);
    } catch (err) { fail(res, err, "admin/invoices:pdf", req); }
  }
);

/* ============================================================
   الإشعارات الدائنة — تصدر تلقائياً عند الاسترداد. للقراءة فقط،
   بنفس مبدأ الفواتير: وثيقة نظامية لا تُعدَّل من هنا.
   ============================================================ */

adminRouter.get("/credit-notes", requireAdminAuth, requirePermission("credit_notes:view"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req, { defaultSize: 25, maxSize: 100 });
    const [{ rows: countRows }, { rows }] = await Promise.all([
      query(`SELECT count(*)::int AS n FROM credit_notes`),
      query(
        `SELECT cn.id, cn.zatca_credit_note_number, cn.amount_sar, cn.reason, cn.zatca_issued_at,
                i.zatca_invoice_number AS original_invoice_number, u.email AS user_email, u.name AS user_name
           FROM credit_notes cn
           JOIN invoices i ON i.id = cn.original_invoice_id
           JOIN users u ON u.id = cn.user_id
          ORDER BY cn.zatca_issued_at DESC
          LIMIT $1 OFFSET $2`,
        [pageSize, offset]
      ),
    ]);
    const total = countRows[0].n;
    res.json({ creditNotes: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  } catch (err) { fail(res, err, "admin/credit-notes:list", req); }
});

adminRouter.get(
  "/credit-notes/:id/pdf",
  requireAdminAuth, requirePermission("credit_notes:view"), requireUuidParam("id"),
  async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT pdf_data, zatca_credit_note_number FROM credit_notes WHERE id = $1`, [req.params.id]
      );
      const note = rows[0];
      if (!note || !note.pdf_data) return res.status(404).json({ error: "not_found" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${note.zatca_credit_note_number}.pdf"`);
      res.send(note.pdf_data);
    } catch (err) { fail(res, err, "admin/credit-notes:pdf", req); }
  }
);

/* ============================================================
   رسائل التواصل
   ============================================================ */

adminRouter.get("/messages", requireAdminAuth, requirePermission("messages:view"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req, { defaultSize: 50, maxSize: 100 });
    const status = ["unread", "read", "replied"].includes(String(req.query.status)) ? String(req.query.status) : null;

    const [{ rows: countRows }, { rows }] = await Promise.all([
      query(`SELECT count(*)::int AS n FROM contact_messages WHERE ($1::text IS NULL OR status = $1)`, [status]),
      query(
        `SELECT id, name, email, message, status, created_at FROM contact_messages
          WHERE ($1::text IS NULL OR status = $1)
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [status, pageSize, offset]
      ),
    ]);
    const total = countRows[0].n;
    res.json({ messages: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), filters: { status } });
  } catch (err) { fail(res, err, "admin/messages:list", req); }
});

adminRouter.post(
  "/messages/:id/status",
  requireAdminAuth, requirePermission("messages:update_status"), requireUuidParam("id"),
  async (req, res) => {
    try {
      const { status } = req.body || {};
      if (!["unread", "read", "replied"].includes(status)) return res.status(400).json({ error: "invalid_status" });
      const { rows } = await query(
        `UPDATE contact_messages SET status = $1 WHERE id = $2 RETURNING id, status`, [status, req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: "not_found" });
      res.json(rows[0]);
    } catch (err) { fail(res, err, "admin/messages:status", req); }
  }
);

/* ============================================================
   البث الجماعي — في admin/notifications.js

   كانت هنا ثلاثة مسارات /admin/broadcasts ترسل عبر Resend وتخزّن
   عدّادين. وحين يغيب RESEND_API_KEY — وهو غائب على Render — كانت
   طبقة الإرسال تعيد { id: "dev-mock" } وتُحسب نجاحاً: تأكيد بعدد
   المستلمين، وصف «ناجح» في السجل، وصفر رسائل غادرت.
   ============================================================ */
