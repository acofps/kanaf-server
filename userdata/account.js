import express from "express";
import { query, withTransaction } from "../db/pool.js";
import { requireVerifiedUser } from "../auth/middleware.js";
import { comparePassword } from "../auth/tokens.js";

/* ============================================================
   الحساب الشخصي: خطة الأمان، دائرة الدعم، طلب الحذف، تصدير البيانات
   KANAF-ORD-0001: R15-01 · R15-02 · R15-03

   القواعد الثابتة هنا (نفس userdata/routes.js):
   • الهوية من req.userId (الرمز الموقَّع) لا من جسم الطلب.
   • نصوص خطة الأمان ودائرة الدعم محتوى نفسي خاص: لا يقرؤها أي مسار
     إداري، ولا تُكتب في السجل (الطول والسبب فقط عند الفشل).
   • «تم» لا تُقال قبل COMMIT.
   ============================================================ */
export const userAccountRouter = express.Router();

function fail(res, err, where) {
  if (err.status) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  console.error(`[account/${where}]`, err.code || "", err.message);
  return res.status(500).json({ error: "internal_error" });
}
const httpError = (status, message, extra) => Object.assign(new Error(message), { status, extra });

/* ---------- محدِّد بسيط في الذاكرة لكل مستخدم ----------
   للعمليات الحساسة التي تقبل كلمة مرور (الحذف والتصدير): رمز وصول
   مسروق لا يصلح لتخمين كلمة المرور بلا حد. حدّه الصادق: نسخة خادم
   واحدة (كبقية المحدِّدات في المشروع). */
const attempts = new Map();
function takeAttempt(key, max, windowMs) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { attempts.set(key, list); return false; }
  list.push(now); attempts.set(key, list);
  return true;
}

async function verifyPasswordOf(userId, password) {
  if (typeof password !== "string" || !password) throw httpError(400, "password_required");
  const { rows } = await query(`SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  const ok = await comparePassword(password, rows[0]?.password_hash || null);
  if (!ok) throw httpError(401, "invalid_password");
}

/* ============================================================
   1) خطة الأمان — R15-01
   ============================================================ */
const PLAN_FIELDS = { warningSigns: "warning_signs", copingStrategies: "coping_strategies", safePlace: "safe_place" };
const PLAN_MAX = 2000;

function planOut(row) {
  if (!row) return null;
  return {
    warningSigns: row.warning_signs, copingStrategies: row.coping_strategies, safePlace: row.safe_place,
    version: row.version, updatedAt: row.updated_at,
  };
}
function contactOut(c) {
  return { id: c.id, name: c.name, phone: c.phone, relationship: c.relationship, position: c.position };
}

userAccountRouter.get("/safety-plan", requireVerifiedUser, async (req, res) => {
  try {
    const [{ rows: p }, { rows: c }] = await Promise.all([
      query(`SELECT * FROM user_safety_plans WHERE user_id = $1`, [req.userId]),
      query(`SELECT id, name, phone, relationship, position FROM user_support_contacts WHERE user_id = $1 ORDER BY position`, [req.userId]),
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({ plan: planOut(p[0]), contacts: c.map(contactOut) });
  } catch (err) { fail(res, err, "safety-plan/get"); }
});

userAccountRouter.put("/safety-plan", requireVerifiedUser, async (req, res) => {
  try {
    const body = req.body || {};
    const vals = {};
    for (const [k, col] of Object.entries(PLAN_FIELDS)) {
      const v = body[k] ?? "";
      if (typeof v !== "string") throw httpError(400, "invalid_field", { field: k });
      const t = v.trim();
      if (t.length > PLAN_MAX) throw httpError(400, "field_too_long", { field: k, max: PLAN_MAX });
      vals[col] = t;
    }
    const baseVersion = body.baseVersion == null ? null : Number(body.baseVersion);
    if (baseVersion !== null && !Number.isInteger(baseVersion)) throw httpError(400, "invalid_base_version");

    const saved = await withTransaction(async (client) => {
      const { rows: cur } = await client.query(`SELECT version FROM user_safety_plans WHERE user_id = $1 FOR UPDATE`, [req.userId]);
      if (cur[0] && baseVersion !== null && baseVersion !== cur[0].version) {
        throw httpError(409, "safety_plan_changed_elsewhere", { currentVersion: cur[0].version });
      }
      const { rows } = await client.query(
        `INSERT INTO user_safety_plans (user_id, warning_signs, coping_strategies, safe_place)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           warning_signs = EXCLUDED.warning_signs, coping_strategies = EXCLUDED.coping_strategies,
           safe_place = EXCLUDED.safe_place, version = user_safety_plans.version + 1, updated_at = now()
         RETURNING *`,
        [req.userId, vals.warning_signs, vals.coping_strategies, vals.safe_place]
      );
      return rows[0];
    });
    res.json({ plan: planOut(saved) });
  } catch (err) { fail(res, err, "safety-plan/put"); }
});

userAccountRouter.delete("/safety-plan", requireVerifiedUser, async (req, res) => {
  try {
    const { rowCount } = await query(`DELETE FROM user_safety_plans WHERE user_id = $1`, [req.userId]);
    res.json({ ok: true, deleted: rowCount });
  } catch (err) { fail(res, err, "safety-plan/delete"); }
});

/* ============================================================
   2) دائرة الدعم — R15-01 (شخصان كحد أقصى، مفروض في القاعدة)
   ============================================================ */
function normalizePhone(v) {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\s\-().]/g, "").replace(/^00/, "+");
  return /^\+?[0-9]{5,15}$/.test(s) ? s : null;
}

userAccountRouter.post("/support-contacts", requireVerifiedUser, async (req, res) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const relationship = typeof req.body?.relationship === "string" ? req.body.relationship.trim() : "";
    const phone = normalizePhone(req.body?.phone);
    if (!name || name.length > 80) throw httpError(400, "invalid_name");
    if (!phone) throw httpError(400, "invalid_phone");
    if (relationship.length > 60) throw httpError(400, "relationship_too_long");

    const row = await withTransaction(async (client) => {
      // قفل صف المستخدم يسلسل الإضافات المتزامنة لنفس الحساب، فلا
      // يتسابق طلبان على position واحدة ثم يفشل أحدهما بخطأ غامض.
      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [req.userId]);
      const { rows: used } = await client.query(`SELECT position FROM user_support_contacts WHERE user_id = $1`, [req.userId]);
      const free = [1, 2].find((p) => !used.some((u) => u.position === p));
      if (!free) throw httpError(409, "support_circle_full", { max: 2 });
      const { rows } = await client.query(
        `INSERT INTO user_support_contacts (user_id, position, name, phone, relationship)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, name, phone, relationship, position`,
        [req.userId, free, name, phone, relationship]
      );
      return rows[0];
    });
    res.status(201).json({ contact: contactOut(row) });
  } catch (err) { fail(res, err, "support-contacts/post"); }
});

userAccountRouter.delete("/support-contacts/:id", requireVerifiedUser, async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw httpError(404, "not_found");
    // شرط الملكية داخل العبارة نفسها: معرّف شخص في دائرة مستخدم آخر
    // يعطي نفس 404 — لا يُعرف منه أنه موجود.
    const { rowCount } = await query(`DELETE FROM user_support_contacts WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    if (!rowCount) throw httpError(404, "not_found");
    res.json({ ok: true });
  } catch (err) { fail(res, err, "support-contacts/delete"); }
});

/* ============================================================
   3) طلب حذف الحساب — R15-02

   ما يحدث فعلاً عند الطلب (فوراً، في معاملة واحدة):
     • users.deleted_at = now()  ← كل مسارات الدخول والتجديد و
       requireVerifiedUser ترفض الحساب من هذه اللحظة.
     • إبطال كل جلسات التجديد (كل الأجهزة).
     • حذف اشتراكات Push، وإيقاف التذكير، ووسم رفض الرسائل التسويقية.
     • قيد في account_deletion_requests.
   ما لا يحدث هنا: الحذف النهائي للبيانات. ذلك في purgeDeletedAccount
   أدناه، ولا يُشغَّل تلقائياً حتى يعتمد المالك سياسة الحذف والاحتفاظ
   (D-01). ولا يُسترد أي مبلغ ولا تُمسّ الفواتير.
   رمز الوصول القائم (15 دقيقة) يُرفض أيضاً لأن requireVerifiedUser
   وجدار /api/chat و /api/plan يقرأون deleted_at في كل طلب.
   ============================================================ */
userAccountRouter.post("/account/delete", requireVerifiedUser, async (req, res) => {
  try {
    if (!takeAttempt(`del:${req.userId}`, 5, 15 * 60 * 1000)) throw httpError(429, "too_many_attempts");
    if (req.body?.confirm !== "DELETE") throw httpError(400, "confirmation_required");
    await verifyPasswordOf(req.userId, req.body?.password);

    const result = await withTransaction(async (client) => {
      const { rows: u } = await client.query(
        `UPDATE users SET deleted_at = now(), reminders_on = false, marketing_opt_out = true, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [req.userId]);
      if (!u[0]) return { already: true };
      const s = await client.query(`UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [req.userId]);
      const p = await client.query(`DELETE FROM push_subscriptions WHERE user_id = $1`, [req.userId]);
      await client.query(
        `INSERT INTO account_deletion_requests (user_id, sessions_revoked, push_removed) VALUES ($1, $2, $3)`,
        [req.userId, s.rowCount, p.rowCount]);
      return { sessionsRevoked: s.rowCount, pushRemoved: p.rowCount };
    });
    res.json({ ok: true, status: "deactivated", ...result });
  } catch (err) { fail(res, err, "account/delete"); }
});

/**
 * الحذف النهائي لبيانات حساب طُلب حذفه. **لا يُستدعى من أي مسار ولا
 * مجدول** — مكتوب ومختبَر على القاعدة المعزولة، وتفعيله على الإنتاج
 * ينتظر سياسة الحذف والاحتفاظ (D-01): أي البيانات تُحذف، وبعد كم يوماً،
 * وما يبقى من السجلات المالية وكيف تُخفى هويته.
 *
 * ما يفعله: يحذف البيانات النفسية والشخصية ويخفي هوية صف users دون
 * حذفه (حذفه يمحو الفواتير بالتتابع — انظر الترحيل 011). ما يبقى:
 * invoices/payments/credit_notes/refunds/subscriptions والسجلات
 * الإدارية، مرتبطة بمعرّف بلا اسم ولا بريد.
 */
export async function purgeDeletedAccount(userId, { policy } = {}) {
  if (!policy || typeof policy !== "string") throw new Error("purge_policy_required");
  return withTransaction(async (client) => {
    const { rows: u } = await client.query(`SELECT id, email, deleted_at FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    if (!u[0]) throw new Error("user_not_found");
    if (!u[0].deleted_at) throw new Error("account_not_deactivated");
    const counts = {};
    const del = async (label, sql, params = [userId]) => { counts[label] = (await client.query(sql, params)).rowCount; };
    await del("daily_logs", `DELETE FROM daily_logs WHERE user_id = $1`);
    await del("screenings", `DELETE FROM screenings WHERE user_id = $1`);
    await del("user_notebook_entries", `DELETE FROM user_notebook_entries WHERE user_id = $1`);
    await del("user_cbt_sessions", `DELETE FROM user_cbt_sessions WHERE user_id = $1`);
    await del("user_journey_enrollments", `DELETE FROM user_journey_enrollments WHERE user_id = $1`);
    await del("user_plans", `DELETE FROM user_plans WHERE user_id = $1`);
    await del("user_safety_plans", `DELETE FROM user_safety_plans WHERE user_id = $1`);
    await del("user_support_contacts", `DELETE FROM user_support_contacts WHERE user_id = $1`);
    await del("user_avatars", `DELETE FROM user_avatars WHERE user_id = $1`);
    await del("user_profile", `DELETE FROM user_profile WHERE user_id = $1`);
    await del("user_reminder_prefs", `DELETE FROM user_reminder_prefs WHERE user_id = $1`);
    await del("user_notifications", `DELETE FROM user_notifications WHERE user_id = $1`);
    await del("push_subscriptions", `DELETE FROM push_subscriptions WHERE user_id = $1`);
    await del("user_sessions", `DELETE FROM user_sessions WHERE user_id = $1`);
    await del("email_verification_codes", `DELETE FROM email_verification_codes WHERE LOWER(email) = LOWER($1)`, [u[0].email]);
    await client.query(
      `UPDATE users SET name = 'حساب محذوف', email = $2, password_hash = '!deleted', photo_url = NULL,
         age_range = NULL, gender = NULL, pin_hash = NULL, reminders_on = false, marketing_opt_out = true, updated_at = now()
       WHERE id = $1`, [userId, `deleted+${userId}@deleted.invalid`]);
    await client.query(
      `UPDATE account_deletion_requests SET status = 'purged', purged_at = now(), purge_policy = $2, purge_counts = $3
       WHERE user_id = $1 AND status = 'deactivated'`, [userId, policy, JSON.stringify(counts)]);
    return counts;
  });
}

/* ============================================================
   4) تصدير بيانات المستخدم لنفسه — R15-03

   POST لا GET: يطلب كلمة المرور (حزمة فيها كل النصوص النفسية لا
   يكفيها رمز وصول قد يكون مسروقاً)، ولا يُخزَّن الملف في أي مكان —
   يُبنى في الذاكرة ويُرسل مرة واحدة بلا تخزين مؤقت.
   مستثنى عمداً: تجزئات كلمة المرور والـPIN والرموز، وسجلات الإدارة
   الداخلية، وملفات PDF للفواتير (تُنزَّل من صفحة الفواتير).
   ============================================================ */
export const EXPORT_SECTIONS = [
  ["profile", `SELECT u.name, u.email, u.age_range, u.gender, u.confirmed_adult, u.agreed_policy_at, u.email_verified_at,
                      u.reminders_on, u.marketing_opt_out, u.dark_mode, u.created_at,
                      p.country_code, p.phone_country_code, p.phone_national
               FROM users u LEFT JOIN user_profile p ON p.user_id = u.id WHERE u.id = $1`],
  ["reminder", `SELECT local_time, timezone, last_sent_on FROM user_reminder_prefs WHERE user_id = $1`],
  ["daily_logs", `SELECT logged_on, mood, sleep, energy, tags, note, created_at FROM daily_logs WHERE user_id = $1 ORDER BY logged_on`],
  ["screenings", `SELECT kind, total, band_label, answers, created_at FROM screenings WHERE user_id = $1 ORDER BY created_at`],
  ["journeys", `SELECT e.journey_key, e.journey_type, e.status, e.total_days, e.started_at, e.completed_at, e.client_state,
                       COALESCE((SELECT json_agg(json_build_object('day', d.day_number, 'status', d.status, 'completed_at', d.completed_at) ORDER BY d.day_number)
                                 FROM user_journey_day_states d WHERE d.enrollment_id = e.id), '[]') AS days
                FROM user_journey_enrollments e WHERE e.user_id = $1 ORDER BY e.started_at`],
  ["notebooks", `SELECT template_key, status, answers, helpfulness, started_at, completed_at FROM user_notebook_entries WHERE user_id = $1 ORDER BY started_at`],
  ["cbt_sessions", `SELECT tool_id, status, payload, started_at, completed_at FROM user_cbt_sessions WHERE user_id = $1 ORDER BY started_at`],
  ["weekly_plans", `SELECT week, source, status, summary, focus_areas, specialist_note, check_in, created_at, archived_at FROM user_plans WHERE user_id = $1 ORDER BY created_at`],
  ["safety_plan", `SELECT warning_signs, coping_strategies, safe_place, updated_at FROM user_safety_plans WHERE user_id = $1`],
  ["support_contacts", `SELECT name, phone, relationship FROM user_support_contacts WHERE user_id = $1 ORDER BY position`],
  ["notifications", `SELECT title, body, kind, read_at, created_at FROM user_notifications WHERE user_id = $1 ORDER BY created_at`],
  ["subscriptions", `SELECT plan_id, status, started_at, current_period_end, canceled_at, created_at FROM subscriptions WHERE user_id = $1 ORDER BY created_at`],
  ["invoices", `SELECT zatca_invoice_number AS invoice_number, plan_id, amount_sar, status, created_at FROM invoices WHERE user_id = $1 ORDER BY created_at`],
  ["payments", `SELECT amount, currency, status, method, card_brand, card_last4, refunded_amount, created_at FROM payments WHERE user_id = $1 ORDER BY created_at`],
  ["devices", `SELECT user_agent, created_at, last_used_at, expires_at, revoked_at FROM user_sessions WHERE user_id = $1 ORDER BY created_at`],
];

export async function buildUserExport(userId) {
  const out = { format: "kanaf-user-export", version: 1, generatedAt: new Date().toISOString(), sections: {} };
  for (const [name, sql] of EXPORT_SECTIONS) out.sections[name] = (await query(sql, [userId])).rows;
  const { rows: av } = await query(`SELECT mime, encode(bytes, 'base64') AS b64, updated_at FROM user_avatars WHERE user_id = $1`, [userId]);
  out.sections.avatar = av[0] ? { mime: av[0].mime, dataBase64: av[0].b64, updatedAt: av[0].updated_at } : null;
  return out;
}

userAccountRouter.post("/export", requireVerifiedUser, async (req, res) => {
  try {
    if (!takeAttempt(`exp:${req.userId}`, 5, 60 * 60 * 1000)) throw httpError(429, "too_many_attempts");
    await verifyPasswordOf(req.userId, req.body?.password);
    const data = await buildUserExport(req.userId);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="kanaf-my-data-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(data);
  } catch (err) { fail(res, err, "export"); }
});
