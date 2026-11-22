import express from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { query, withTransaction } from "../db/pool.js";
import { hashPassword } from "./auth.js";
import {
  requireAdminAuth, requirePermission, requireUuidParam,
  logAdminAction, fail, httpError,
} from "./middleware.js";
import { ROLES, ROLE_LABEL, isValidRole, baseRoleFor, needsAssignmentRow, PANEL_PAGES, PAGE_KEYS, isValidPageList } from "./permissions.js";
import { adminPasswordError } from "./password-rule.js";
import { sendEmail } from "../mail/send.js";
import { ADMIN_MIN_PASSWORD_LENGTH as MIN_PASSWORD_LENGTH } from "./password-rule.js"; // ORD-0013 §5.4: موضع واحد
import { serviceEmailExtra } from "../notifications/email-template.js";

export const adminAccountsRouter = express.Router();

/* ============================================================
   حسابات الإدارة — البند 3 من المرحلة 5

   ------------------------------------------------------------
   ما الذي تغيّر، ولماذا
   ------------------------------------------------------------
   كان إنشاء الحساب:

     POST /admin/admin-users { name, email, password, role }

   أي أن المالك يختار كلمة مرور الشخص الآخر ويوصلها له بقناة خارج
   النظام. ثلاث نتائج تتبع ذلك حتماً:

     • السرّ يمرّ بقناة لا يملكها النظام ولا يقدر يمحوها.
     • المالك يعرف كلمة مرور من تُوقَّع أفعاله باسمه في سجل
       التدقيق — فتوقيعه لم يعد يخصّه وحده.
     • وتفضيل المشروع صريح: الأسرار لا تُعرض في المحادثة.

   والأخطر أن **إنشاء الحساب وتغيير دوره وتعطيله لم يكن يُسجَّل
   إطلاقاً**. لا logAdminAction ولا سبب مكتوب. ترقية حساب إلى مالك
   — أخطر فعل ممكن في النظام كله — كانت تمرّ بلا أثر واحد.

   الآن: دعوة برمز لمرة واحدة، وكل فعل مسجَّل بسبب مكتوب.
   ============================================================ */

const INVITE_TTL_HOURS = 48;
const RESET_TTL_HOURS = 2;

/* حدّ ضيّق على المسارات العامة: الرمز 32 بايتاً لا يُخمَّن، لكن
   حدّاً على التجربة يمنع استخدام المسار كقناة إغراق. */
const setupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

/* ------------------------------------------------------------
   كلمة مرور لا يعرفها أحد.

   admin_users.password_hash عمود NOT NULL، والجدول يملكه postgres
   فلا يمكن جعله NULLable. فالحساب المدعوّ يحمل بصمة قيمة عشوائية
   تُولَّد وتُنسى في نفس السطر — لا أحد يعرفها، ولا شيء يقارن بها.
   نفس حيلة DUMMY_HASH في auth/tokens.js، لغرض معكوس.
   ------------------------------------------------------------ */
async function unusablePasswordHash() {
  return hashPassword(crypto.randomBytes(32).toString("hex"));
}

/**
 * ينشئ رمزاً لمرة واحدة ويعيد نصّه الصريح **مرة واحدة فقط**.
 * المخزَّن بصمته sha256، فتسريب قاعدة البيانات لا يعطي رمزاً صالحاً.
 */
async function issueSetupToken(client, { adminUserId, purpose, createdBy = null, ip = null }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const hours = purpose === "invite" ? INVITE_TTL_HOURS : RESET_TTL_HOURS;

  /* أي رمز سابق حيّ لنفس الحساب يُبطَل. بدون هذا يبقى رمز دعوة
     أُعيد إرساله ثلاث مرات = ثلاثة مفاتيح صالحة للباب نفسه، وإبطال
     أحدها لا يعني شيئاً. */
  await client.query(
    `UPDATE admin_setup_tokens SET used_at = now()
     WHERE admin_user_id = $1 AND used_at IS NULL`,
    [adminUserId]
  );

  await client.query(
    `INSERT INTO admin_setup_tokens (admin_user_id, purpose, token_hash, expires_at, created_by, requested_ip)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5, $6)`,
    [adminUserId, purpose, sha256(token), String(hours), createdBy, ip]
  );

  return { token, expiresInHours: hours };
}

/* SERVER_BASE_URL مضبوط على Render، وغيابه هنا ليس تفصيلاً: الرابط
   يصير نسبياً فيخرج في بريد لا يقدر أحد يفتحه منه. يُصرَّح به في
   السجل بدل أن يُكتشف من شكوى مدعوّ. */
let warnedMissingBase = false;
function setupUrl(token) {
  const base = (process.env.SERVER_BASE_URL || "").replace(/\/+$/, "");
  if (!base && !warnedMissingBase) {
    warnedMissingBase = true;
    console.error("[admin/accounts] ⚠️ SERVER_BASE_URL غير مضبوط — رابط الدعوة سيخرج نسبياً وغير قابل للفتح من البريد.");
  }
  return `${base}/?setup=${token}`;
}

function inviteEmailBody(name, url, hours, roleLabel) {
  return `مرحباً ${name}،

أُنشئ لك حساب في لوحة إدارة تنفس بصلاحية «${roleLabel}».

لتفعيل حسابك واختيار كلمة مرورك، افتح الرابط التالي:

${url}

الرابط صالح ${hours} ساعة ولمرة واحدة. لو انتهى، اطلب من المالك إعادة إرسال الدعوة.

إذا ما كنت تتوقع هذه الرسالة، تجاهلها — الحساب لا يعمل قبل فتح الرابط.

فريق تنفس`;
}

function resetEmailBody(name, url, hours) {
  return `مرحباً ${name}،

وصلنا طلب لإعادة ضبط كلمة مرور حسابك في لوحة إدارة تنفس.

${url}

الرابط صالح ${hours} ساعة ولمرة واحدة.

إذا ما طلبت هذا، تجاهل الرسالة — كلمة مرورك الحالية ما زالت تعمل، ويُستحسن تخبر المالك.

فريق تنفس`;
}

/* ------------------------------------------------------------
   كتابة الدور — في مكانين لا مكان واحد

   admin_users.role لا يقبل إلا الأربعة القديمة (قيد CHECK على
   جدول يملكه postgres). فالدور الجديد يسكن admin_role_assignments،
   والدور الفعلي COALESCE بينهما.

   والسطر الحاسم هو حذف صف الإسناد عند العودة إلى دور قديم: بدونه
   يبقى COALESCE يقرأ الإسناد القديم، فتغيير محاسب إلى `support`
   **لا يفعل شيئاً** ويظل محاسباً. عطب صامت تماماً — الواجهة تقول
   support والصلاحية محاسب.
   ------------------------------------------------------------ */
async function writeRole(client, { adminUserId, role, assignedBy, note }) {
  await client.query(`UPDATE admin_users SET role = $2 WHERE id = $1`, [adminUserId, baseRoleFor(role)]);

  if (needsAssignmentRow(role)) {
    await client.query(
      `INSERT INTO admin_role_assignments (admin_user_id, role, assigned_by, assigned_at, note)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (admin_user_id) DO UPDATE
         SET role = EXCLUDED.role, assigned_by = EXCLUDED.assigned_by,
             assigned_at = now(), note = EXCLUDED.note`,
      [adminUserId, role, assignedBy, note || null]
    );
  } else {
    await client.query(`DELETE FROM admin_role_assignments WHERE admin_user_id = $1`, [adminUserId]);
  }
}

/* حالة الحساب مشتقّة لا مخزّنة — نفس مبدأ حالة المستخدم في
   الترحيل 003. عمود «حالة» ثالث كان سيتناقض مع active ومع وجود
   دعوة سارية. */
const ACCOUNT_STATE_SQL = `
  CASE
    WHEN au.active THEN 'active'
    WHEN EXISTS (
      SELECT 1 FROM admin_setup_tokens t
       WHERE t.admin_user_id = au.id AND t.purpose = 'invite'
         AND t.used_at IS NULL AND t.expires_at > now()
    ) THEN 'invited'
    WHEN EXISTS (
      SELECT 1 FROM admin_setup_tokens t
       WHERE t.admin_user_id = au.id AND t.purpose = 'invite' AND t.used_at IS NULL
    ) THEN 'invite_expired'
    ELSE 'deactivated'
  END`;

/* ============================================================
   القراءة
   ============================================================ */

// GET /admin/admin-users
adminAccountsRouter.get(
  "/admin-users",
  requireAdminAuth,
  requirePermission("admins:view"),
  async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT au.id, au.name, au.email,
                COALESCE(ra.role, au.role) AS role,
                au.role AS base_role,
                ra.role AS assigned_role,
                ra.assigned_at, ra.assigned_by,
                au.active, au.created_at, au.last_login_at, au.phone, au.page_grants,
                ${ACCOUNT_STATE_SQL} AS account_state
           FROM admin_users au
           LEFT JOIN admin_role_assignments ra ON ra.admin_user_id = au.id
          ORDER BY au.created_at ASC`
      );
      res.json({ adminUsers: rows, roles: ROLES, roleLabels: ROLE_LABEL, pages: PANEL_PAGES });
    } catch (err) { fail(res, err, "admin/accounts:list", req); }
  }
);

/* ============================================================
   الدعوة
   ============================================================ */

// POST /admin/admin-users  { name, email, role, reason }
adminAccountsRouter.post(
  "/admin-users",
  requireAdminAuth,
  requirePermission("admins:invite"),
  async (req, res) => {
    const { name, email, role } = req.body || {};
    const reason = String(req.body?.reason || "").trim();

    try {
      if (!name?.trim() || !email?.trim() || !role) {
        throw httpError(400, "name_email_role_required");
      }
      if (!reason) throw httpError(400, "reason_required");
      if (!isValidRole(role)) throw httpError(400, "invalid_role");

      /* حارس «السوبر أدمن» الصريح المطلوب في §3.
         عملياً owner وحده يملك admins:invite اليوم، فهذا الفحص
         زائد — واليوم فقط. أول مرة تُمنح فيها صلاحية دعوة لدور
         آخر، يصير هذا السطر هو الفرق بين ترقية محكومة وبوابة
         تصعيد. الحارس يُكتب قبل الحاجة إليه لا بعدها. */
      if (role === "owner" && req.admin.role !== "owner") {
        throw httpError(403, "only_owner_can_create_owner");
      }

      // لا يُكشف وجود البريد قبل الإنشاء ولا بعده — يُترك للقيد
      // الفريد ليردّ 409 موحّداً.
      const cleanEmail = email.trim().toLowerCase();

      const created = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO admin_users (name, email, password_hash, role, active)
           VALUES ($1, $2, $3, $4, false)
           RETURNING id, name, email, created_at`,
          [name.trim(), cleanEmail, await unusablePasswordHash(), baseRoleFor(role)]
        );
        const admin = rows[0];

        await writeRole(client, {
          adminUserId: admin.id, role, assignedBy: req.admin.id, note: reason,
        });

        const { token, expiresInHours } = await issueSetupToken(client, {
          adminUserId: admin.id, purpose: "invite", createdBy: req.admin.id, ip: req.ip,
        });

        return { admin, token, expiresInHours };
      });

      await logAdminAction({
        adminUserId: req.admin.id,
        action: "admin_account_invited",
        entity: "admin_user", entityId: created.admin.id,
        oldValue: null,
        newValue: { name: created.admin.name, email: created.admin.email, role },
        reason,
        metadata: { invite_expires_in_hours: created.expiresInHours },
        ipAddress: req.ip,
      });

      const url = setupUrl(created.token);
      let emailed = false;
      let emailError = null;
      try {
        const subject = "دعوة إلى لوحة إدارة تنفس";
        const text = inviteEmailBody(created.admin.name, url, created.expiresInHours, ROLE_LABEL[role] || role);
        await sendEmail(created.admin.email, subject, text, await serviceEmailExtra(subject, text));
        emailed = true;
      } catch (err) {
        /* ليس فشلاً صامتاً ولا فشلاً للطلب: الحساب أُنشئ فعلاً
           والرمز صالح. يُبلَّغ بصراحة ويُعاد الرابط للمالك ليسلّمه
           بيده — رابط لمرة واحدة ينتهي خلال ساعات، لا كلمة مرور
           دائمة. وهذا أضعف بكثير مما كان يحدث قبل هذه المرحلة. */
        emailError = err.message;
        console.error("[admin/accounts] تعذّر إرسال الدعوة:", err.message);
      }

      res.status(201).json({
        adminUser: { id: created.admin.id, name: created.admin.name, email: created.admin.email, role, active: false, account_state: "invited" },
        emailed,
        emailError,
        // الرابط لا كلمة المرور. يُعرض للمالك مرة واحدة، ولا يُخزَّن
        // في أي سجل — logAdminAction أعلاه لا يحمله.
        setupUrl: url,
        expiresInHours: created.expiresInHours,
      });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "email_already_exists" });
      fail(res, err, "admin/accounts:invite", req);
    }
  }
);

/* ============================================================
   الإضافة المباشرة — KANAF-ORD-0013 §5 (بجانب الدعوة، لا بدلها: المالك يختار)

   POST /admin/admin-users/direct
     { name, email, phone?, password, duties: ["admin"|"finance"], pages?: [...], reason }

   • «المهام» دوران قائمان لا مفهوم ثالث (§5.1): إدارية → admin، مالية → accountant.
     والاثنتان معاً → admin (صلاحياته تشمل صلاحيات المحاسب كلها).
     ⚠️ accountant يقرأ الدفاتر ولا يحرّك مالاً: لا استرداد ولا تعديل فاتورة.
   • pages: منح الصفحات — تضييق فوق الدور (§5.2). غيابها = بلا تضييق.
   • لا دور owner من هنا بحال (§5.6): المهام لا تخرج عن admin/accountant.
   • الرقم السري من قاعدة واحدة (password-rule.js، §5.4). لا يُسجَّل ولا يُعاد.
   • الحساب فعّال فوراً — المالك اختار كلمة مروره، وهذا ما طلبه بدل الدعوة.
   ============================================================ */
const DUTY_ROLE = { admin: "admin", finance: "accountant" };
const E164 = /^\+[1-9][0-9]{7,14}$/;

adminAccountsRouter.post("/admin-users/direct", requireAdminAuth, requirePermission("admins:invite"), async (req, res) => {
  const b = req.body || {};
  const reason = String(b.reason || "").trim();
  try {
    const name = String(b.name || "").trim();
    const email = String(b.email || "").trim().toLowerCase();
    if (!name || !email) throw httpError(400, "name_email_required");
    if (!reason) throw httpError(400, "reason_required");
    const pwErr = adminPasswordError(b.password);
    if (pwErr) throw httpError(400, pwErr, `الحد الأدنى ${MIN_PASSWORD_LENGTH} حرفاً.`);
    const duties = Array.isArray(b.duties) ? [...new Set(b.duties)] : [];
    if (!duties.length || duties.some((d) => !DUTY_ROLE[d])) throw httpError(400, "invalid_duties");
    const role = duties.includes("admin") ? "admin" : "accountant";
    let phone = null;
    if (b.phone !== undefined && b.phone !== null && String(b.phone).trim()) {
      phone = String(b.phone).replace(/[\s-]/g, "");
      if (!E164.test(phone)) throw httpError(400, "invalid_phone");
    }
    let pages = null;
    if (b.pages !== undefined && b.pages !== null) {
      if (!isValidPageList(b.pages)) throw httpError(400, "invalid_pages", PAGE_KEYS.join(","));
      pages = [...new Set(b.pages)];
    }

    const created = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO admin_users (name, email, password_hash, role, active, phone, page_grants)
         VALUES ($1, $2, $3, $4, true, $5, $6) RETURNING id, name, email, phone, page_grants, created_at`,
        [name, email, await hashPassword(b.password), baseRoleFor(role), phone, pages]);
      await writeRole(client, { adminUserId: rows[0].id, role, assignedBy: req.admin.id, note: reason });
      return rows[0];
    });

    await logAdminAction({
      adminUserId: req.admin.id, action: "admin_account_created_direct",
      entity: "admin_user", entityId: created.id, oldValue: null,
      newValue: { name: created.name, email: created.email, phone: created.phone, role, duties, pages }, // لا كلمة مرور
      reason, ipAddress: req.ip,
    });
    res.status(201).json({ adminUser: { id: created.id, name: created.name, email: created.email, phone: created.phone, role, pageGrants: pages, active: true, account_state: "active" } });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "email_already_exists" });
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.detail ? { detail: err.detail } : {}) });
    fail(res, err, "admin/accounts:direct", req);
  }
});

/* PATCH /admin/admin-users/:id/pages  { pages: [...] | null, phone?, reason }
   تعديل منح الصفحات (null = إزالة التضييق) والجوال. تضييق لا توسيع: لا يمسّ الدور. */
adminAccountsRouter.patch("/admin-users/:id/pages", requireAdminAuth, requirePermission("admins:change_role"), requireUuidParam("id"), async (req, res) => {
  const b = req.body || {};
  const reason = String(b.reason || "").trim();
  try {
    if (!reason) throw httpError(400, "reason_required");
    if (!("pages" in b) && !("phone" in b)) throw httpError(400, "nothing_to_change");
    let pages;
    if ("pages" in b) {
      if (b.pages !== null && !isValidPageList(b.pages)) throw httpError(400, "invalid_pages", PAGE_KEYS.join(","));
      pages = b.pages === null ? null : [...new Set(b.pages)];
    }
    let phone;
    if ("phone" in b) {
      phone = b.phone ? String(b.phone).replace(/[\s-]/g, "") : null;
      if (phone && !E164.test(phone)) throw httpError(400, "invalid_phone");
    }
    if (req.params.id === req.admin.id && pages !== undefined) throw httpError(409, "cannot_change_own_pages");
    const { rows: [before] } = await query(`SELECT page_grants, phone FROM admin_users WHERE id = $1`, [req.params.id]);
    if (!before) throw httpError(404, "not_found");
    const { rows: [after] } = await query(
      `UPDATE admin_users SET page_grants = CASE WHEN $2 THEN $3::text[] ELSE page_grants END,
              phone = CASE WHEN $4 THEN $5 ELSE phone END
        WHERE id = $1 RETURNING page_grants, phone`,
      [req.params.id, pages !== undefined, pages ?? null, phone !== undefined, phone ?? null]);
    await logAdminAction({
      adminUserId: req.admin.id, action: "admin_account_pages_changed", entity: "admin_user", entityId: req.params.id,
      oldValue: { pages: before.page_grants, phone: before.phone }, newValue: { pages: after.page_grants, phone: after.phone }, reason, ipAddress: req.ip,
    });
    res.json({ ok: true, pageGrants: after.page_grants, phone: after.phone });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.detail ? { detail: err.detail } : {}) });
    fail(res, err, "admin/accounts:pages", req);
  }
});

// POST /admin/admin-users/:id/resend-invite  { reason }
adminAccountsRouter.post(
  "/admin-users/:id/resend-invite",
  requireAdminAuth,
  requirePermission("admins:invite"),
  requireUuidParam("id"),
  async (req, res) => {
    const reason = String(req.body?.reason || "").trim() || "إعادة إرسال دعوة";
    try {
      const { rows } = await query(`SELECT id, name, email, active FROM admin_users WHERE id = $1`, [req.params.id]);
      const admin = rows[0];
      if (!admin) throw httpError(404, "not_found");
      if (admin.active) throw httpError(409, "account_already_active");

      const issued = await withTransaction((client) =>
        issueSetupToken(client, { adminUserId: admin.id, purpose: "invite", createdBy: req.admin.id, ip: req.ip })
      );

      await logAdminAction({
        adminUserId: req.admin.id, action: "admin_invite_resent",
        entity: "admin_user", entityId: admin.id,
        reason, ipAddress: req.ip,
      });

      const url = setupUrl(issued.token);
      let emailed = false, emailError = null;
      try {
        const text = inviteEmailBody(admin.name, url, issued.expiresInHours, "");
        await sendEmail(admin.email, "دعوة إلى لوحة إدارة تنفس", text, await serviceEmailExtra("دعوة إلى لوحة إدارة تنفس", text));
        emailed = true;
      } catch (err) { emailError = err.message; console.error("[admin/accounts] تعذّر إعادة الإرسال:", err.message); }

      res.json({ ok: true, emailed, emailError, setupUrl: url, expiresInHours: issued.expiresInHours });
    } catch (err) { fail(res, err, "admin/accounts:resend", req); }
  }
);

// POST /admin/admin-users/:id/reset-password  { reason }
adminAccountsRouter.post(
  "/admin-users/:id/reset-password",
  requireAdminAuth,
  requirePermission("admins:invite"),
  requireUuidParam("id"),
  async (req, res) => {
    const reason = String(req.body?.reason || "").trim();
    try {
      if (!reason) throw httpError(400, "reason_required");

      const { rows } = await query(`SELECT id, name, email, active FROM admin_users WHERE id = $1`, [req.params.id]);
      const admin = rows[0];
      if (!admin) throw httpError(404, "not_found");

      const issued = await withTransaction((client) =>
        issueSetupToken(client, { adminUserId: admin.id, purpose: "password_reset", createdBy: req.admin.id, ip: req.ip })
      );

      await logAdminAction({
        adminUserId: req.admin.id, action: "admin_password_reset_issued",
        entity: "admin_user", entityId: admin.id,
        reason, ipAddress: req.ip,
      });

      const url = setupUrl(issued.token);
      let emailed = false, emailError = null;
      try {
        const text = resetEmailBody(admin.name, url, issued.expiresInHours);
        await sendEmail(admin.email, "إعادة ضبط كلمة مرور لوحة تنفس", text, await serviceEmailExtra("إعادة ضبط كلمة مرور لوحة تنفس", text));
        emailed = true;
      } catch (err) { emailError = err.message; console.error("[admin/accounts] تعذّر إرسال الاستعادة:", err.message); }

      res.json({ ok: true, emailed, emailError, setupUrl: url, expiresInHours: issued.expiresInHours });
    } catch (err) { fail(res, err, "admin/accounts:reset", req); }
  }
);

/* ============================================================
   تغيير الدور والتفعيل
   ============================================================ */

// PATCH /admin/admin-users/:id  { role?, active?, reason }
adminAccountsRouter.patch(
  "/admin-users/:id",
  requireAdminAuth,
  requireUuidParam("id"),
  async (req, res) => {
    const { role, active } = req.body || {};
    const reason = String(req.body?.reason || "").trim();

    try {
      if (role === undefined && active === undefined) throw httpError(400, "nothing_to_change");
      if (!reason) throw httpError(400, "reason_required");

      /* الصلاحية تعتمد على الحقل المرسل لا على المسار — نفس نمط
         تغيير طبقة المحتوى في المرحلة 4. */
      if (role !== undefined && !req.admin.can("admins:change_role")) {
        throw httpError(403, "insufficient_permission", "admins:change_role");
      }
      if (active !== undefined && !req.admin.can("admins:deactivate")) {
        throw httpError(403, "insufficient_permission", "admins:deactivate");
      }
      if (role !== undefined && !isValidRole(role)) throw httpError(400, "invalid_role");
      if (role === "owner" && req.admin.role !== "owner") throw httpError(403, "only_owner_can_create_owner");

      /* لا يغيّر المرء دور نفسه ولا يعطّل نفسه.

         ليس أدباً تنظيمياً: مسؤول يخفض دوره بالخطأ يقفل نفسه خارج
         الصلاحية التي يحتاجها ليعيدها، ومسؤول يعطّل نفسه يخرج من
         الجلسة فوراً الآن بعد أن صارت الحالة تُقرأ من القاعدة في
         كل طلب. والحارس القديم «آخر مالك» لا يمنع أياً منهما ما
         دام هناك مالك ثانٍ. */
      if (req.params.id === req.admin.id) {
        if (role !== undefined) throw httpError(409, "cannot_change_own_role");
        if (active === false) throw httpError(409, "cannot_deactivate_self");
      }

      const result = await withTransaction(async (client) => {
        const { rows: targetRows } = await client.query(
          `SELECT au.id, au.name, au.email, au.active, COALESCE(ra.role, au.role) AS role
             FROM admin_users au
             LEFT JOIN admin_role_assignments ra ON ra.admin_user_id = au.id
            WHERE au.id = $1 FOR UPDATE OF au`,
          [req.params.id]
        );
        const target = targetRows[0];
        if (!target) throw httpError(404, "not_found");

        /* آخر مالك فعّال لا يُخفَض ولا يُعطَّل — وإلا قُفلت أعلى
           صلاحية في النظام على الجميع بلا طريق عودة إلا الوصول
           المباشر لقاعدة البيانات.

           ⚠️ وأقولها كما هي: هذا الحارس **غير قابل للوصول اليوم**.
           الفاعل لازم يملك admins:change_role، ولا يملكها إلا مالك
           فعّال، ووجوده يعني أن الهدف ليس آخر مالك — وحالة «الهدف
           هو الفاعل نفسه» يقطعها الحارس أعلاه قبل الوصول إلى هنا.

           فلماذا يبقى؟ لأنه يصير قابلاً للوصول في اللحظة التي
           تُمنح فيها admins:change_role لدور غير المالك — سطر واحد
           في المصفوفة. عندها يكون الفرق بين ترقية محكومة وقفل
           النظام على نفسه. حارس يُكتب قبل الحاجة لا بعدها.

           ولا يُكتب له عنوان اختبار يَعِد بفحصه: اختبار المرحلة
           يفحص ما هو قابل للوصول ويقول ذلك صراحة. */
        const losesOwner =
          target.role === "owner" && ((role !== undefined && role !== "owner") || active === false);
        if (losesOwner) {
          const { rows: others } = await client.query(
            `SELECT count(*)::int AS n
               FROM admin_users au
               LEFT JOIN admin_role_assignments ra ON ra.admin_user_id = au.id
              WHERE COALESCE(ra.role, au.role) = 'owner' AND au.active = true AND au.id <> $1`,
            [target.id]
          );
          if (others[0].n === 0) throw httpError(409, "cannot_remove_last_owner");
        }

        if (role !== undefined) {
          await writeRole(client, { adminUserId: target.id, role, assignedBy: req.admin.id, note: reason });
        }
        if (active !== undefined) {
          await client.query(`UPDATE admin_users SET active = $2 WHERE id = $1`, [target.id, !!active]);
        }

        const { rows: after } = await client.query(
          `SELECT au.id, au.name, au.email, au.active, COALESCE(ra.role, au.role) AS role
             FROM admin_users au
             LEFT JOIN admin_role_assignments ra ON ra.admin_user_id = au.id
            WHERE au.id = $1`,
          [target.id]
        );
        return { before: target, after: after[0] };
      });

      /* حدثان منفصلان لا حدث واحد: «غيّر الدور» و«عطّل الحساب»
         سؤالان مختلفان يُفلتَر عليهما في السجل بشكل مختلف. */
      if (role !== undefined && result.before.role !== result.after.role) {
        await logAdminAction({
          adminUserId: req.admin.id, action: "admin_role_changed",
          entity: "admin_user", entityId: result.after.id,
          oldValue: { role: result.before.role }, newValue: { role: result.after.role },
          reason, metadata: { target_email: result.after.email }, ipAddress: req.ip,
        });
      }
      if (active !== undefined && result.before.active !== result.after.active) {
        await logAdminAction({
          adminUserId: req.admin.id,
          action: result.after.active ? "admin_account_activated" : "admin_account_deactivated",
          entity: "admin_user", entityId: result.after.id,
          oldValue: { active: result.before.active }, newValue: { active: result.after.active },
          reason, metadata: { target_email: result.after.email }, ipAddress: req.ip,
        });
      }

      res.json(result.after);
    } catch (err) { fail(res, err, "admin/accounts:patch", req); }
  }
);

/* ============================================================
   المساران العامّان — قبول الدعوة وضبط كلمة المرور

   بلا مصادقة بالضرورة: المدعوّ لا حساب يدخل به بعد، ومن نسي كلمة
   مروره لا يقدر يثبت هويته إلا بالرمز.

   الرمز وحده هو الإثبات، ولذلك:
     • 32 بايتاً عشوائية — لا يُخمَّن.
     • بصمته المخزَّنة فقط — تسريب القاعدة لا يعطي رمزاً صالحاً.
     • لمرة واحدة وبمدة قصيرة.
     • وردّ موحّد لكل صور الفشل: منتهٍ، أو مستخدَم، أو غير موجود
       كلها "invalid_or_expired_token". التمييز بينها يخبر من يجرّب
       أي الرموز كانت صالحة يوماً.
   ============================================================ */

// GET /admin/setup/validate?token=...
adminAccountsRouter.get("/setup/validate", setupLimiter, async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (!token) return res.status(400).json({ error: "token_required" });

    const { rows } = await query(
      `SELECT t.purpose, au.name, au.email
         FROM admin_setup_tokens t
         JOIN admin_users au ON au.id = t.admin_user_id
        WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
      [sha256(token)]
    );
    if (!rows[0]) return res.status(400).json({ error: "invalid_or_expired_token" });

    // الاسم والبريد يُعرضان ليعرف الفاتح أنه على الحساب الصحيح.
    // لا دور ولا صلاحيات: من يملك الرمز لا يحتاج معرفتها بعد.
    res.json({ valid: true, purpose: rows[0].purpose, name: rows[0].name, email: rows[0].email });
  } catch (err) { fail(res, err, "admin/accounts:validate", req); }
});

// POST /admin/setup/accept  { token, password }
adminAccountsRouter.post("/setup/accept", setupLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  try {
    if (!token || !password) throw httpError(400, "token_and_password_required");
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      throw httpError(400, "password_too_short", `الحد الأدنى ${MIN_PASSWORD_LENGTH} حرفاً.`);
    }
    /* الحد الأعلى ليس تجميلاً: bcrypt يقصّ عند 72 بايتاً **بصمت**،
       والحرف العربي بايتان في UTF-8 — فكلمة مرور عربية طويلة كانت
       ستُقبل ويُهمل آخرها بلا إشعار. نفس الحارس في auth/routes.js. */
    if (Buffer.byteLength(String(password), "utf8") > 72) {
      throw httpError(400, "password_too_long", "الحد الأعلى 72 بايتاً (الحرف العربي بايتان).");
    }

    const passwordHash = await hashPassword(String(password));

    const result = await withTransaction(async (client) => {
      /* القفل على صف الرمز يجعل «لمرة واحدة» صحيحاً تحت التزامن:
         بدونه يقدر طلبان بنفس الرمز أن يمرّا معاً من فحص used_at
         قبل أن يكتب أحدهما. */
      const { rows } = await client.query(
        `SELECT id, admin_user_id, purpose FROM admin_setup_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [sha256(token)]
      );
      const row = rows[0];
      if (!row) throw httpError(400, "invalid_or_expired_token");

      await client.query(`UPDATE admin_setup_tokens SET used_at = now() WHERE id = $1`, [row.id]);

      /* الدعوة تفعّل الحساب؛ الاستعادة لا تفعّله.
         حساب عُطِّل عمداً يجب ألا يعود بطلب استعادة — وإلا صار
         التعطيل قابلاً للنقض ممّن عُطِّل. */
      if (row.purpose === "invite") {
        await client.query(
          `UPDATE admin_users SET password_hash = $2, active = true WHERE id = $1`,
          [row.admin_user_id, passwordHash]
        );
      } else {
        await client.query(
          `UPDATE admin_users SET password_hash = $2 WHERE id = $1`,
          [row.admin_user_id, passwordHash]
        );
      }

      const { rows: who } = await client.query(
        `SELECT id, name, email, active FROM admin_users WHERE id = $1`, [row.admin_user_id]
      );
      return { purpose: row.purpose, admin: who[0] };
    });

    /* يُسجَّل باسم صاحب الحساب نفسه: هو الفاعل هنا، لا من دعاه.
       والسبب نصّ ثابت لأن الفعل لا يحتمل تفسيراً آخر. */
    await logAdminAction({
      adminUserId: result.admin.id,
      action: result.purpose === "invite" ? "admin_invite_accepted" : "admin_password_reset_completed",
      entity: "admin_user", entityId: result.admin.id,
      reason: result.purpose === "invite" ? "قبول الدعوة وضبط كلمة المرور" : "إعادة ضبط كلمة المرور بالرمز",
      ipAddress: req.ip,
    }).catch((err) => console.error("[admin/accounts] تعذّر تسجيل القبول:", err.message));

    res.json({
      ok: true,
      purpose: result.purpose,
      // لا جلسة تُفتح هنا عمداً: القبول يثبت ملكية البريد، وتسجيل
      // الدخول يثبت معرفة كلمة المرور. خطوتان لا واحدة.
      next: "login",
      email: result.admin.email,
    });
  } catch (err) { fail(res, err, "admin/accounts:accept", req); }
});

/* ------------------------------------------------------------
   ⚠️ لا يوجد مسار حذف لحساب إدارة، وهذا قرار لا نسيان.

   admin_access_log.admin_user_id و break_glass_requests.requested_by
   لهما مفتاح أجنبي إلى admin_users. فحذف حساب يعني إمّا فشل الحذف
   بقيد المفتاح، أو — لو أُضيف ON DELETE — سجل تدقيق يشير إلى فاعل
   لم يعد له اسم.

   التعطيل يفعل ما يُراد فعلاً: يقفل الدخول فوراً، ويبقي التوقيع
   على ما وقّعه. سجل تدقيق يفقد أسماء فاعليه ليس سجل تدقيق.
   ------------------------------------------------------------ */
