import express from "express";
import { query, withTransaction } from "../db/pool.js";
import { requireAdminAuth, requirePermission, requireUuidParam, logAdminAction, fail, httpError } from "./middleware.js";
import { validateProfilePatch, writeProfilePatch, storeAvatar, isKnownTimeZone } from "../userdata/routes.js";
import { normalizeEmail, isPlausibleEmail } from "../auth/codes.js";
import { sendVerificationEmail } from "../auth/routes.js";
import { revokeAllUserSessions } from "../auth/tokens.js";

/* ============================================================
   تعديل ملف العميل من اللوحة — KANAF-ORD-0013 §4.3

   ✓ يُعدَّل: الاسم · البريد · الجوال · الدولة · الفئة العمرية · الجنس ·
     الصورة · تفضيلات التذكير · الباقة وحالة الاشتراك ومدته.
     (حالة الحساب: مساري الإيقاف/الإعادة القائمين في admin/routes.js.)
   ✗ لا مسار هنا — ولا في أي ملف — لما حُجب بقرار D-ADM-01: نص اليومية
     ووسومها، ومحتوى الدفاتر، ومحادثات «سند»، والإجابات التفصيلية للمقاييس.

   قواعد:
   • قواعد التحقق هي قواعد مسار المستخدم نفسها (validateProfilePatch،
     storeAvatar، isKnownTimeZone) — مصدر واحد، لا نسخة للوحة.
   • كل حفظ صفّ واحد في سجل الإجراءات: المحرِّر والوقت والسبب، والقيمة
     قبل وبعد للحقول التي تغيّرت فعلاً. تعديل بلا أثر = عيب.
   • تغيير البريد يمسّ هوية الدخول: يُمسح email_verified_at، وتُلغى
     الجلسات، ويُرسل رمز تحقق إلى البريد الجديد. لا تنتقل حالة «مُفعّل».
   ============================================================ */

export const userEditRouter = express.Router();

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const reasonOf = (req) => String(req.body?.reason || req.query?.reason || "").trim();
const NAME_MAX = 80;
const REMINDER_TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** لقطة الحقول القابلة للتعديل — هي ما يُقارن قبل/بعد. لا حقل محجوب فيها. */
async function snapshot(client, userId, withContact) {
  const { rows } = await client.query(
    `SELECT u.name, u.email, u.email_verified_at IS NOT NULL AS email_verified, u.age_range, u.gender,
            u.reminders_on, u.marketing_opt_out,
            to_char(rp.local_time, 'HH24:MI') AS reminder_time, rp.timezone AS reminder_timezone,
            up.country_code, up.phone_country_code, up.phone_national
       FROM users u
       LEFT JOIN user_reminder_prefs rp ON rp.user_id = u.id
       LEFT JOIN user_profile up ON up.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL`, [userId]);
  const r = rows[0];
  if (!r) return null;
  const snap = {
    name: r.name, email: r.email, emailVerified: r.email_verified, ageRange: r.age_range, gender: r.gender,
    remindersOn: r.reminders_on, marketingOptOut: r.marketing_opt_out,
    reminderTime: r.reminder_time, reminderTimezone: r.reminder_timezone,
  };
  if (withContact) {
    snap.country = r.country_code;
    snap.phone = r.phone_country_code ? `+${r.phone_country_code}${r.phone_national}` : null;
  }
  return snap;
}

function diff(before, after) {
  const oldV = {}, newV = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) { oldV[k] = before[k] ?? null; newV[k] = after[k] ?? null; }
  }
  return { oldV, newV, changed: Object.keys(newV).length > 0 };
}

/* ------------------------------------------------------------
   PATCH /admin/users/:id/profile
   { name?, email?, ageRange?, gender?, country?, phone?: {dial,national}|null,
     remindersOn?, reminderTime?, reminderTimezone?, marketingOptOut?, reason }
   الدلالة كمسار المستخدم: غائب = لا يتغيّر · null = يُمسح · قيمة = تُضبط.
   ------------------------------------------------------------ */
userEditRouter.patch("/users/:id/profile", requireAdminAuth, requirePermission("users:edit"), requireUuidParam("id"), async (req, res) => {
  const body = req.body || {};
  const reason = reasonOf(req);
  if (!reason) return res.status(400).json({ error: "reason_required" });
  const userId = req.params.id;
  const canContact = req.admin.can("users:view_contact");
  if (!canContact && (has(body, "country") || has(body, "phone"))) {
    return res.status(403).json({ error: "forbidden", detail: "users:view_contact" });
  }

  try {
    /* 1) التحقق كاملاً قبل أي كتابة */
    let name;
    if (has(body, "name")) {
      name = String(body.name ?? "").trim();
      if (!name || name.length > NAME_MAX) return res.status(400).json({ error: "invalid_name", max: NAME_MAX });
    }
    let email;
    if (has(body, "email")) {
      email = normalizeEmail(body.email);
      if (!isPlausibleEmail(email)) return res.status(400).json({ error: "invalid_email" });
    }
    const profileBody = {};
    for (const k of ["ageRange", "gender", "country", "phone"]) if (has(body, k)) profileBody[k] = body[k];
    const pv = await validateProfilePatch(profileBody, async () => {
      const { rows } = await query(`SELECT country_code FROM user_profile WHERE user_id = $1`, [userId]);
      return rows[0]?.country_code || null;
    });
    if (pv.error) return res.status(pv.error.status).json(pv.error.body);

    const bool = (k) => {
      if (!has(body, k)) return undefined;
      if (typeof body[k] !== "boolean") throw httpError(400, `invalid_${k}`);
      return body[k];
    };
    const remindersOn = bool("remindersOn");
    const marketingOptOut = bool("marketingOptOut");
    let reminderTime;
    if (has(body, "reminderTime") && body.reminderTime !== null) {
      if (!REMINDER_TIME_RE.test(String(body.reminderTime))) return res.status(400).json({ error: "invalid_reminder_time" });
      reminderTime = String(body.reminderTime);
    }
    let reminderTimezone;
    if (has(body, "reminderTimezone") && body.reminderTimezone !== null) {
      if (!isKnownTimeZone(String(body.reminderTimezone))) return res.status(400).json({ error: "invalid_timezone" });
      reminderTimezone = String(body.reminderTimezone);
    }

    const touches = name !== undefined || email !== undefined || pv.fields.touchesUsers || pv.fields.touchesProfile
      || remindersOn !== undefined || marketingOptOut !== undefined || reminderTime !== undefined || reminderTimezone !== undefined;
    if (!touches) return res.status(400).json({ error: "nothing_to_update" });

    /* 2) الكتابة في معاملة واحدة، واللقطتان من داخلها */
    const result = await withTransaction(async (client) => {
      await client.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      const before = await snapshot(client, userId, canContact);
      if (!before) throw httpError(404, "not_found");

      const emailChanged = email !== undefined && email !== String(before.email || "").toLowerCase();
      if (name !== undefined || emailChanged) {
        await client.query(
          `UPDATE users SET name = COALESCE($2, name),
                  email = CASE WHEN $3 THEN $4 ELSE email END,
                  email_verified_at = CASE WHEN $3 THEN NULL ELSE email_verified_at END,
                  updated_at = now()
            WHERE id = $1`, [userId, name ?? null, emailChanged, email ?? null]);
      }
      await writeProfilePatch(client, userId, pv.fields);
      if (remindersOn !== undefined || marketingOptOut !== undefined) {
        await client.query(
          `UPDATE users SET reminders_on = COALESCE($2, reminders_on), marketing_opt_out = COALESCE($3, marketing_opt_out), updated_at = now() WHERE id = $1`,
          [userId, remindersOn ?? null, marketingOptOut ?? null]);
      }
      if (reminderTime !== undefined || reminderTimezone !== undefined || remindersOn === true) {
        await client.query(
          `INSERT INTO user_reminder_prefs (user_id, local_time, timezone, updated_at)
           VALUES ($1, COALESCE($2::time, '20:00'::time), COALESCE($3, 'Asia/Riyadh'), now())
           ON CONFLICT (user_id) DO UPDATE SET
             local_time = COALESCE($2::time, user_reminder_prefs.local_time),
             timezone   = COALESCE($3, user_reminder_prefs.timezone), updated_at = now()`,
          [userId, reminderTime ?? null, reminderTimezone ?? null]);
      }
      const after = await snapshot(client, userId, canContact);
      return { before, after, emailChanged };
    });

    const d = diff(result.before, result.after);
    if (d.changed) {
      await logAdminAction({
        adminUserId: req.admin.id, targetUserId: userId, action: "user_profile_edit",
        oldValue: d.oldV, newValue: d.newV, reason, ipAddress: req.ip,
      });
    }

    /* 3) بعد الالتزام: تغيير البريد يُنهي الجلسات ويطلب تحقّقاً من البريد الجديد */
    let verification = null;
    if (result.emailChanged) {
      await revokeAllUserSessions(userId).catch((e) => console.error("[admin/user-edit] revoke sessions failed:", e.message));
      try { await sendVerificationEmail(result.after.email, result.after.name); verification = "sent"; }
      catch (e) { console.error("[admin/user-edit] verification email failed:", e.message); verification = "send_failed"; }
    }
    res.json({ ok: true, changed: d.changed ? Object.keys(d.newV) : [], profile: result.after, verification });
  } catch (err) {
    if (err?.code === "23505") return res.status(409).json({ error: "email_taken" });
    if (err?.status) return res.status(err.status).json({ error: err.code || err.message });
    return fail(res, err, "admin/users:profile-edit", req);
  }
});

/* ------------------------------------------------------------
   PUT /admin/users/:id/avatar (بايتات الصورة) · DELETE /admin/users/:id/avatar
   ------------------------------------------------------------ */
userEditRouter.put("/users/:id/avatar", requireAdminAuth, requirePermission("users:edit"), requireUuidParam("id"),
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: 2 * 1024 * 1024 }),
  (err, req, res, next) => (err?.type === "entity.too.large" ? res.status(413).json({ error: "image_too_large" }) : next(err)),
  async (req, res) => {
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: "reason_required" });
    try {
      const { rows: u } = await query(`SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
      if (!u[0]) return res.status(404).json({ error: "not_found" });
      const { rows: old } = await query(`SELECT checksum FROM user_avatars WHERE user_id = $1`, [req.params.id]);
      const r = await storeAvatar(req.params.id, req.body);
      if (r.error) return res.status(r.error.status).json(r.error.body);
      await logAdminAction({
        adminUserId: req.admin.id, targetUserId: req.params.id, action: "user_avatar_set",
        oldValue: { photo: old[0]?.checksum || null }, newValue: { photo: r.row.checksum }, reason, ipAddress: req.ip,
      });
      res.json({ photo: { exists: true, version: r.row.checksum, mime: r.row.mime } });
    } catch (err) { return fail(res, err, "admin/users:avatar-set", req); }
  });

userEditRouter.delete("/users/:id/avatar", requireAdminAuth, requirePermission("users:edit"), requireUuidParam("id"), async (req, res) => {
  const reason = reasonOf(req);
  if (!reason) return res.status(400).json({ error: "reason_required" });
  try {
    const { rows } = await query(`DELETE FROM user_avatars WHERE user_id = $1 RETURNING checksum`, [req.params.id]);
    if (rows[0]) {
      await logAdminAction({
        adminUserId: req.admin.id, targetUserId: req.params.id, action: "user_avatar_delete",
        oldValue: { photo: rows[0].checksum }, newValue: { photo: null }, reason, ipAddress: req.ip,
      });
    }
    res.json({ ok: true, deleted: rows.length });
  } catch (err) { return fail(res, err, "admin/users:avatar-delete", req); }
});

/* ------------------------------------------------------------
   PATCH /admin/users/:id/subscription  { planId?, periodEnd?, status?, reason }

   الباقة وحالة الاشتراك ومدته — يدوياً، بلا حركة مال: لا فاتورة ولا
   استرداد ولا خصم. يُعدَّل أحدث اشتراك، وإن لم يوجد فـ«منح يدوي»
   (payment_provider = 'manual') يشترط باقة وتاريخ انتهاء.
   status: active | canceled وحدهما — trialing/past_due حالات يضعها
   مسار الدفع لا الإنسان.
   ------------------------------------------------------------ */
userEditRouter.patch("/users/:id/subscription", requireAdminAuth, requirePermission("subscriptions:edit"), requireUuidParam("id"), async (req, res) => {
  const body = req.body || {};
  const reason = reasonOf(req);
  if (!reason) return res.status(400).json({ error: "reason_required" });
  const userId = req.params.id;
  try {
    let planId;
    if (has(body, "planId")) {
      planId = String(body.planId || "");
      const { rows } = await query(`SELECT 1 FROM subscription_plans WHERE plan_key = $1`, [planId]);
      if (!rows[0]) return res.status(400).json({ error: "unknown_plan" });
    }
    let periodEnd;
    if (has(body, "periodEnd")) {
      const t = Date.parse(String(body.periodEnd || ""));
      if (!Number.isFinite(t)) return res.status(400).json({ error: "invalid_period_end" });
      periodEnd = new Date(t).toISOString();
    }
    let status;
    if (has(body, "status")) {
      status = String(body.status || "");
      if (!["active", "canceled"].includes(status)) return res.status(400).json({ error: "invalid_status", allowed: ["active", "canceled"] });
    }
    if (planId === undefined && periodEnd === undefined && status === undefined) return res.status(400).json({ error: "nothing_to_update" });

    const out = await withTransaction(async (client) => {
      const { rows: u } = await client.query(`SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [userId]);
      if (!u[0]) throw httpError(404, "not_found");
      const { rows: subs } = await client.query(
        `SELECT id, plan_id, status, current_period_end, payment_provider FROM subscriptions
          WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [userId]);
      const cur = subs[0];
      if (!cur) {
        if (!planId || !periodEnd) throw httpError(400, "grant_requires_plan_and_period_end");
        const { rows } = await client.query(
          `INSERT INTO subscriptions (user_id, plan_id, status, started_at, current_period_end, payment_provider)
           VALUES ($1, $2, $3, now(), $4, 'manual') RETURNING id, plan_id, status, current_period_end`,
          [userId, planId, status || "active", periodEnd]);
        return { before: null, after: rows[0], created: true };
      }
      const { rows } = await client.query(
        `UPDATE subscriptions SET plan_id = COALESCE($2, plan_id),
                current_period_end = COALESCE($3::timestamptz, current_period_end),
                status = COALESCE($4, status),
                canceled_at = CASE WHEN $4 = 'canceled' AND status <> 'canceled' THEN now()
                                   WHEN $4 = 'active' THEN NULL ELSE canceled_at END,
                updated_at = now()
          WHERE id = $1 RETURNING id, plan_id, status, current_period_end`,
        [cur.id, planId ?? null, periodEnd ?? null, status ?? null]);
      return { before: { plan_id: cur.plan_id, status: cur.status, current_period_end: cur.current_period_end }, after: rows[0], created: false };
    });

    const pick = (r) => (r ? { planId: r.plan_id, status: r.status, periodEnd: r.current_period_end ? new Date(r.current_period_end).toISOString() : null } : null);
    await logAdminAction({
      adminUserId: req.admin.id, targetUserId: userId, action: out.created ? "manual_subscription_grant" : "manual_subscription_edit",
      entity: "subscription", entityId: out.after.id,
      oldValue: pick(out.before), newValue: pick(out.after), reason, ipAddress: req.ip,
    });
    res.json({ ok: true, created: out.created, subscription: pick(out.after) });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.code || err.message });
    return fail(res, err, "admin/users:subscription-edit", req);
  }
});
