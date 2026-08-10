import crypto from "node:crypto";
import express from "express";
import { query, withTransaction } from "../db/pool.js";
import { requireVerifiedUser } from "../auth/middleware.js";
import { getUserSubscription } from "../billing/subscription.js";
import { assertContentAvailable } from "../content/catalog.js";
import { saveSubscription, removeSubscription, getPublicKey } from "../notifications/push.js";

export const userDataRouter = express.Router();

/* ============================================================
   البيانات التشغيلية للمستخدم — أول مسار كتابة في تاريخ المشروع.

   ------------------------------------------------------------
   ما كان
   ------------------------------------------------------------
   جدولا daily_logs و screenings موجودان في schema.sql منذ اليوم
   الأول، وبُحث آلياً في المستودع كله عن INSERT فيهما فلم يوجد.
   مسار /admin/users/:id/sensitive يقرأ منهما، فصفحة "البيانات
   الحساسة" فارغة أبداً — ليس لأن البيانات محمية، بل لأنها غير
   موجودة.

   وفي التطبيق: اليوميات والفرز والرحلات والدفاتر كلها في حالة
   React، تموت مع تحديث الصفحة.

   ------------------------------------------------------------
   الأثر التجاري المباشر
   ------------------------------------------------------------
   شرط فتح "بوصلة كنف" (ميزة كنف+ المدفوعة) هو
   trackedDays >= 7 || hasScreening، والعدّاد يصفّر مع كل تحديث.
   أي أن ميزة مدفوعة كان يستحيل الوصول إليها. GET /api/me/summary
   أدناه هو المصدر الذي يقرأ منه التطبيق هذين الرقمين الآن — من
   قاعدة البيانات لا من ذاكرة المتصفح.

   ------------------------------------------------------------
   قاعدة ثابتة في كل مسار هنا
   ------------------------------------------------------------
   الهوية من req.userId (من الرمز الموقَّع) ولا من جسم الطلب
   إطلاقاً. لا يوجد في هذا الملف مسار واحد يقبل userId من العميل.
   ============================================================ */

async function hasPlusAccess(userId) {
  const sub = await getUserSubscription(userId);
  return Boolean(sub?.entitled);
}

/**
 * بوابة موحّدة قبل بدء أي محتوى.
 *
 * تفصل خطأين لا يجوز خلطهما:
 *   403 content_not_published  — المسؤول أوقف المحتوى.
 *   402 subscription_required  — المحتوى متاح والمستخدم غير مشترك.
 *
 * خلطهما كان سيُظهر جدار دفع لمحتوى موقوف — فيدفع مستخدم مقابل
 * شيء لن يفتح له.
 */
async function assertCanStart(userId, contentType, contentKey) {
  const { subscriptionTier } = await assertContentAvailable(contentType, contentKey);
  if (subscriptionTier === "plus" && !(await hasPlusAccess(userId))) {
    throw Object.assign(new Error("subscription_required"), { status: 402 });
  }
}

function fail(res, err, where) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`[userdata/${where}]`, err);
  return res.status(500).json({ error: "internal_error" });
}

/* ============================================================
   1) صندوق الإشعارات داخل التطبيق
   ============================================================ */

userDataRouter.get("/notifications", requireVerifiedUser, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const { rows } = await query(
      `SELECT id, title, body, kind, source, read_at, created_at
       FROM user_notifications WHERE user_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [req.userId, limit]
    );
    const { rows: unread } = await query(
      `SELECT count(*)::int AS n FROM user_notifications WHERE user_id = $1 AND read_at IS NULL`,
      [req.userId]
    );
    res.json({ notifications: rows, unreadCount: unread[0].n });
  } catch (err) { fail(res, err, "notifications"); }
});

userDataRouter.post("/notifications/:id/read", requireVerifiedUser, async (req, res) => {
  try {
    // الشرط على user_id ليس زينة: بدونه يقدر أي مستخدم يعلّم إشعار
    // غيره مقروءاً بمعرّفه.
    const { rows } = await query(
      `UPDATE user_notifications SET read_at = COALESCE(read_at, now())
       WHERE id = $1 AND user_id = $2 RETURNING id, read_at`,
      [req.params.id, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) { fail(res, err, "notifications/read"); }
});

userDataRouter.post("/notifications/read-all", requireVerifiedUser, async (req, res) => {
  try {
    const { rowCount } = await query(
      `UPDATE user_notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
      [req.userId]
    );
    res.json({ marked: rowCount });
  } catch (err) { fail(res, err, "notifications/read-all"); }
});

userDataRouter.delete("/notifications/:id", requireVerifiedUser, async (req, res) => {
  try {
    const { rowCount } = await query(
      `DELETE FROM user_notifications WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (err) { fail(res, err, "notifications/delete"); }
});

/* ============================================================
   2) Web Push
   ============================================================ */

userDataRouter.post("/push/subscribe", requireVerifiedUser, async (req, res) => {
  try {
    await saveSubscription(req.userId, req.body?.subscription, req.headers["user-agent"] || null);
    res.status(201).json({ ok: true });
  } catch (err) { fail(res, err, "push/subscribe"); }
});

userDataRouter.post("/push/unsubscribe", requireVerifiedUser, async (req, res) => {
  try {
    await removeSubscription(req.userId, String(req.body?.endpoint || ""));
    res.json({ ok: true });
  } catch (err) { fail(res, err, "push/unsubscribe"); }
});

/* ============================================================
   3) المتابعة اليومية — daily_logs

   القيد UNIQUE (user_id, logged_on) موجود في المخطط منذ البداية
   وهو الحارس الحقيقي ضد الإرسال المزدوج. ON CONFLICT DO UPDATE
   يجعل الإرسال الثاني تعديلاً لا خطأ — المستخدم الذي يصحّح مزاجه
   بعد دقيقتين ما يستاهل رسالة "سجّلت اليوم مسبقاً".

   ⚠️ logged_on يجب أن يصل **تاريخاً مجرداً** بصيغة YYYY-MM-DD،
   وهو اليوم التقويمي المحلي للمستخدم.

   العطب في النسخة الأولى: كان الخادم يمرّر ما يصله عبر
   `new Date(v).toISOString().slice(0,10)`. وRender يعمل بـUTC،
   والرياض +03:00. فمستخدم يسجّل الساعة 1 فجراً يوم 10:

     • لو أرسل طابعاً بإزاحة → يُحفظ يوم 9، وبسبب
       ON CONFLICT (user_id, logged_on) DO UPDATE **يدهس تسجيل
       اليوم السابق**. فقدان بيانات صامت.
     • ولو أرسل "2026-08-10" الصحيح → يُقارَن بيوم الخادم (9)
       فيُرفض بـlogged_on_in_future.

   والعدّاد نفسه هو ما يفتح «بوصلة كنف» المدفوعة.

   الآن: تاريخ مجرد فقط، ومهلة يوم كامل في فحص المستقبل تغطي كل
   المناطق الزمنية (UTC−12 إلى UTC+14) بلا الحاجة لمعرفة إزاحة
   المستخدم.
   ============================================================ */

userDataRouter.post("/logs", requireVerifiedUser, async (req, res) => {
  const { mood, sleep, energy, note, tags, loggedOn } = req.body || {};
  const inRange = (v) => Number.isInteger(v) && v >= 0 && v <= 10;
  if (![mood, sleep, energy].every(inRange)) {
    return res.status(400).json({ error: "mood_sleep_energy_must_be_0_to_10" });
  }

  let dayStr;
  if (loggedOn === undefined || loggedOn === null || loggedOn === "") {
    dayStr = new Date().toISOString().slice(0, 10);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(loggedOn))) {
      return res.status(400).json({
        error: "invalid_logged_on",
        message: "loggedOn لازم يكون تاريخاً محلياً بصيغة YYYY-MM-DD بلا وقت ولا إزاحة.",
      });
    }
    dayStr = String(loggedOn);
    const parsed = new Date(`${dayStr}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dayStr) {
      return res.status(400).json({ error: "invalid_logged_on" });
    }
    // مهلة يوم كامل: أقصى فرق بين أي منطقة زمنية وUTC أقل من ذلك.
    const maxDay = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (dayStr > maxDay) return res.status(400).json({ error: "logged_on_in_future" });
    const minDay = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (dayStr < minDay) return res.status(400).json({ error: "logged_on_too_old" });
  }

  try {
    const { rows } = await query(
      `INSERT INTO daily_logs (user_id, mood, sleep, energy, note, tags, logged_on)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
       ON CONFLICT (user_id, logged_on) DO UPDATE
         SET mood = EXCLUDED.mood, sleep = EXCLUDED.sleep, energy = EXCLUDED.energy,
             note = EXCLUDED.note, tags = EXCLUDED.tags
       RETURNING id, mood, sleep, energy, note, tags, logged_on, created_at`,
      [req.userId, mood, sleep, energy, note || null, Array.isArray(tags) ? tags : [], dayStr]
    );
    res.status(201).json(rows[0]);
  } catch (err) { fail(res, err, "logs"); }
});

userDataRouter.get("/logs", requireVerifiedUser, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 400);
    const { rows } = await query(
      `SELECT id, mood, sleep, energy, note, tags, logged_on, created_at
       FROM daily_logs WHERE user_id = $1 AND logged_on >= (CURRENT_DATE - ($2::int || ' days')::interval)
       ORDER BY logged_on DESC`,
      [req.userId, days]
    );
    res.json({ logs: rows });
  } catch (err) { fail(res, err, "logs/list"); }
});

/* ============================================================
   4) الاستبيانات — screenings

   answers (إجابات البنود) تُحفظ لأن المستخدم يملكها ويراها في
   تطبيقه. لا مسار إداري في هذا المستودع يختار هذا العمود؛ الوصول
   إليه يمر بـbreak-glass بموافق ثانٍ. التفصيل في
   04_PRIVACY_CLASSIFICATION.md.

   ⚠️ لا يُحسب هنا أي مؤشر خطر ولا يُطلق أي مسار أمان — التطبيق
   يتولى ذلك فوراً في الواجهة، ومسار الأمان لا يعتمد على الشبكة
   إطلاقاً. الخادم يسجّل الحدث بلا هوية عبر /api/crisis-signal.
   ============================================================ */

userDataRouter.post("/screenings", requireVerifiedUser, async (req, res) => {
  const { kind, total, bandLabel, answers } = req.body || {};
  if (!["phq9", "gad7", "ptsd5", "rosenberg"].includes(kind)) {
    return res.status(400).json({ error: "invalid_kind" });
  }
  if (!Number.isInteger(total) || !bandLabel) {
    return res.status(400).json({ error: "total_and_band_label_required" });
  }
  try {
    const { rows } = await query(
      `INSERT INTO screenings (user_id, kind, total, band_label, answers)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, kind, total, band_label, created_at`,
      [req.userId, kind, total, bandLabel, JSON.stringify(answers || {})]
    );
    res.status(201).json(rows[0]);
  } catch (err) { fail(res, err, "screenings"); }
});

userDataRouter.get("/screenings", requireVerifiedUser, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, kind, total, band_label, answers, created_at
       FROM screenings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json({ screenings: rows });
  } catch (err) { fail(res, err, "screenings/list"); }
});

/* ============================================================
   5) الرحلات
   ============================================================ */

userDataRouter.post("/journeys", requireVerifiedUser, async (req, res) => {
  const { journeyKey, journeyType = "primary", totalDays, contentVersion = "1.0.0", clientState } = req.body || {};
  if (!journeyKey || !Number.isInteger(totalDays) || totalDays < 1) {
    return res.status(400).json({ error: "journey_key_and_total_days_required" });
  }
  /* 'companion' نوع حقيقي في التطبيق (prepare_to_seek_help و
     benefit_from_your_session). الفحص هنا يطابق قيد قاعدة البيانات
     فيرد 400 واضحاً بدل 500 من انتهاك CHECK. */
  if (!["primary", "overlay", "companion"].includes(journeyType)) {
    return res.status(400).json({ error: "invalid_journey_type" });
  }
  try {
    // البوابة الحقيقية: التحقق على مستوى الخادم. إخفاء البطاقة في
    // الواجهة وحده كان يعني أن من يعرف المفتاح يبدأ رحلة موقوفة
    // بنداء مباشر.
    await assertCanStart(req.userId, journeyType === "overlay" ? "overlay" : "journey", journeyKey);


    const { rows } = await query(
      `INSERT INTO user_journey_enrollments (user_id, journey_key, journey_type, content_version, total_days, client_state)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (user_id, journey_key) DO UPDATE
         SET status = CASE WHEN user_journey_enrollments.status = 'paused' THEN 'active'
                           ELSE user_journey_enrollments.status END,
             client_state = COALESCE($6::jsonb, user_journey_enrollments.client_state),
             updated_at = now()
       RETURNING id, journey_key, status, total_days, started_at, client_state`,
      [req.userId, journeyKey, journeyType, contentVersion, totalDays, JSON.stringify(clientState || {})]
    );
    res.status(201).json(rows[0]);
  } catch (err) { fail(res, err, "journeys"); }
});

userDataRouter.get("/journeys", requireVerifiedUser, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT e.id, e.journey_key, e.journey_type, e.status, e.total_days,
              e.started_at, e.completed_at, e.updated_at, e.client_state,
              COALESCE(json_agg(json_build_object('day', d.day_number, 'status', d.status, 'completedAt', d.completed_at)
                       ORDER BY d.day_number) FILTER (WHERE d.id IS NOT NULL), '[]') AS days
       FROM user_journey_enrollments e
       LEFT JOIN user_journey_day_states d ON d.enrollment_id = e.id
       WHERE e.user_id = $1
       GROUP BY e.id
       ORDER BY e.updated_at DESC`,
      [req.userId]
    );
    res.json({ enrollments: rows });
  } catch (err) { fail(res, err, "journeys/list"); }
});

userDataRouter.post("/journeys/:key/days/:day/complete", requireVerifiedUser, async (req, res) => {
  const dayNumber = parseInt(req.params.day, 10);
  if (!Number.isInteger(dayNumber) || dayNumber < 1) return res.status(400).json({ error: "invalid_day" });
  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, total_days, status FROM user_journey_enrollments
         WHERE user_id = $1 AND journey_key = $2 FOR UPDATE`,
        [req.userId, req.params.key]
      );
      const e = rows[0];
      if (!e) throw Object.assign(new Error("not_enrolled"), { status: 404 });
      if (dayNumber > e.total_days) throw Object.assign(new Error("day_out_of_range"), { status: 400 });

      await client.query(
        `INSERT INTO user_journey_day_states (enrollment_id, day_number, status, completed_at)
         VALUES ($1, $2, 'completed', now())
         ON CONFLICT (enrollment_id, day_number) DO UPDATE
           SET status = 'completed', completed_at = COALESCE(user_journey_day_states.completed_at, now())`,
        [e.id, dayNumber]
      );

      const { rows: done } = await client.query(
        `SELECT count(*)::int AS n FROM user_journey_day_states
         WHERE enrollment_id = $1 AND status = 'completed'`,
        [e.id]
      );
      const completed = done[0].n >= e.total_days;

      await client.query(
        `UPDATE user_journey_enrollments
         SET status = CASE WHEN $2 THEN 'completed' ELSE status END,
             completed_at = CASE WHEN $2 THEN COALESCE(completed_at, now()) ELSE completed_at END,
             updated_at = now()
         WHERE id = $1`,
        [e.id, completed]
      );

      return { completedDays: done[0].n, totalDays: e.total_days, journeyCompleted: completed };
    });
    res.json(result);
  } catch (err) { fail(res, err, "journeys/complete-day"); }
});

/**
 * PUT /api/me/journeys/:key/state  { clientState }
 *
 * يحفظ مسودّات الأيام والهدف الشخصي — ما يكتبه المستخدم داخل
 * الرحلة ولا يُشتق من أعمدة التقدّم. يُنادى عند حفظ المسودة، وهو
 * أكثر نداء تكراراً في هذا الملف، فلا يلمس صفوف الأيام إطلاقاً.
 */
userDataRouter.put("/journeys/:key/state", requireVerifiedUser, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE user_journey_enrollments SET client_state = $3::jsonb, updated_at = now()
       WHERE user_id = $1 AND journey_key = $2
       RETURNING journey_key, updated_at`,
      [req.userId, req.params.key, JSON.stringify(req.body?.clientState || {})]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_enrolled" });
    res.json(rows[0]);
  } catch (err) { fail(res, err, "journeys/state"); }
});

userDataRouter.post("/journeys/:key/status", requireVerifiedUser, async (req, res) => {
  const status = req.body?.status;
  if (!["active", "paused", "abandoned"].includes(status)) return res.status(400).json({ error: "invalid_status" });
  try {
    const { rows } = await query(
      `UPDATE user_journey_enrollments SET status = $3, updated_at = now()
       WHERE user_id = $1 AND journey_key = $2 AND status <> 'completed'
       RETURNING journey_key, status`,
      [req.userId, req.params.key, status]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found_or_completed" });
    res.json(rows[0]);
  } catch (err) { fail(res, err, "journeys/status"); }
});

/* ============================================================
   6) الدفاتر

   ⚠️ answers نص حر يكتبه المستخدم عن حالته النفسية — أخطر عمود في
   القاعدة. لا استعلام إداري في هذا المستودع يختاره.
   ============================================================ */

userDataRouter.post("/notebooks", requireVerifiedUser, async (req, res) => {
  const { templateKey, templateVersion = "1.0.0" } = req.body || {};
  if (!templateKey) return res.status(400).json({ error: "template_key_required" });
  try {
    await assertCanStart(req.userId, "notebook", templateKey);
    const { rows } = await query(
      `INSERT INTO user_notebook_entries (user_id, template_key, template_version)
       VALUES ($1, $2, $3)
       RETURNING id, template_key, status, revision, started_at`,
      [req.userId, templateKey, templateVersion]
    );
    res.status(201).json(rows[0]);
  } catch (err) { fail(res, err, "notebooks"); }
});

userDataRouter.patch("/notebooks/:id", requireVerifiedUser, async (req, res) => {
  const { answers, lastPromptKey, status, helpfulness } = req.body || {};
  if (status !== undefined && !["draft", "completed"].includes(status)) {
    return res.status(400).json({ error: "invalid_status" });
  }
  /* 0..3 مطابقة لـHELPFUL_LABELS في التطبيق. بلا هذا الفحص كانت
     قيمة خارج مدى SMALLINT تصل Postgres فترد 500 internal_error —
     خطأ خادم عن خطأ عميل. */
  if (helpfulness !== undefined && helpfulness !== null) {
    if (!Number.isInteger(helpfulness) || helpfulness < 0 || helpfulness > 3) {
      return res.status(400).json({ error: "invalid_helpfulness" });
    }
  }
  try {
    const { rows } = await query(
      `UPDATE user_notebook_entries
       SET answers        = COALESCE($3::jsonb, answers),
           last_prompt_key = COALESCE($4, last_prompt_key),
           helpfulness    = COALESCE($5, helpfulness),
           -- إكمال دفتر مكتمل مسبقاً يزيد رقم المراجعة ولا يعيده
           -- إلى مسودة — نفس دلالة completeNotebookEntry في التطبيق.
           revision       = CASE WHEN $6 = 'completed' AND status = 'completed'
                                 THEN revision + 1 ELSE revision END,
           status         = COALESCE($6, status),
           completed_at   = CASE WHEN $6 = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END,
           updated_at     = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id, template_key, status, revision, updated_at, completed_at`,
      [
        req.params.id, req.userId,
        answers === undefined ? null : JSON.stringify(answers),
        lastPromptKey ?? null,
        helpfulness ?? null,
        status ?? null,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) { fail(res, err, "notebooks/update"); }
});

userDataRouter.get("/notebooks", requireVerifiedUser, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, template_key, template_version, status, answers, revision,
              helpfulness, last_prompt_key, started_at, completed_at, updated_at
       FROM user_notebook_entries WHERE user_id = $1
       ORDER BY updated_at DESC LIMIT 200`,
      [req.userId]
    );
    res.json({ entries: rows });
  } catch (err) { fail(res, err, "notebooks/list"); }
});

userDataRouter.delete("/notebooks/:id", requireVerifiedUser, async (req, res) => {
  try {
    const { rowCount } = await query(
      `DELETE FROM user_notebook_entries WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (err) { fail(res, err, "notebooks/delete"); }
});

/* ============================================================
   7) جلسات أدوات كنف
   ============================================================ */

userDataRouter.post("/cbt-sessions", requireVerifiedUser, async (req, res) => {
  const { toolId, payload, status = "completed" } = req.body || {};
  if (!toolId) return res.status(400).json({ error: "tool_id_required" });
  if (!["in_progress", "completed", "abandoned"].includes(status)) {
    return res.status(400).json({ error: "invalid_status" });
  }
  try {
    await assertCanStart(req.userId, "cbt_tool", toolId);
    const { rows } = await query(
      `INSERT INTO user_cbt_sessions (user_id, tool_id, status, payload, completed_at)
       VALUES ($1, $2, $3, $4::jsonb, CASE WHEN $3 = 'completed' THEN now() ELSE NULL END)
       RETURNING id, tool_id, status, started_at, completed_at`,
      [req.userId, toolId, status, JSON.stringify(payload || {})]
    );
    res.status(201).json(rows[0]);
  } catch (err) { fail(res, err, "cbt-sessions"); }
});

userDataRouter.get("/cbt-sessions", requireVerifiedUser, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, tool_id, status, payload, started_at, completed_at
       FROM user_cbt_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 200`,
      [req.userId]
    );
    res.json({ sessions: rows });
  } catch (err) { fail(res, err, "cbt-sessions/list"); }
});

/* ============================================================
   8) التفضيلات — وتذكير التسجيل اليومي

   تُكتب في users مباشرة: UPDATE مسموح على الجداول الأصلية (الممنوع
   هو ALTER)، والأعمدة الثلاثة موجودة أصلاً بلا أي كاتب.
   marketing_opt_out قابل للضبط من هنا ومن رابط إلغاء الاشتراك في
   البريد، وكلاهما يكتب في نفس العمود — مصدر حقيقة واحد.

   ------------------------------------------------------------
   ما أُضيف في المرحلة 6: وقت التذكير ومنطقته الزمنية
   ------------------------------------------------------------
   كان زر "تذكير التسجيل اليومي" في التطبيق يقلب حالة React ويعرض
   تحته: «هذا تذكير محلي يعمل بس أثناء فتح الصفحة في هذا العرض
   التجريبي». أي أن العمود users.reminders_on — الموجود منذ
   schema.sql — لم يكن يصله شيء من ذلك الزر إطلاقاً.

   ⚠️ **ومفتاح التشغيل يبقى users.reminders_on وحده.** الجدول
   الجديد user_reminder_prefs يحمل ما لا عمود له فقط: الوقت
   والمنطقة الزمنية وتاريخ آخر إرسال. عمود منطقي ثانٍ هناك كان
   سيصير مصدر الحقيقة الثاني، ولا يُكتشف اختلافه إلا يوم يشتكي
   مستخدم أن التذكير يصله بعد أن أطفأه.

   والمنطقة الزمنية تُطابَق على قائمة المناطق التي يعرفها المحرّك
   قبل الكتابة. اسم منطقة غير موجود يجعل AT TIME ZONE ترمي خطأً
   داخل مسح التذكيرات — وخطأ قاعدة بيانات داخل معاملة يُفسدها
   كاملة، وهو الدرس الذي كلّف المشروع أول دفعة حقيقية.
   ============================================================ */

/** هل يعرف المحرّك هذه المنطقة الزمنية فعلاً؟ */
function isKnownTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    // استثناء متوقَّع لاسم غير معروف — وهذا هو الفحص نفسه، لا ابتلاع خطأ.
    return false;
  }
}

userDataRouter.patch("/preferences", requireVerifiedUser, async (req, res) => {
  const body = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const { remindersOn, darkMode, marketingOptOut, reminderTime, reminderTimezone } = body;
  const bool = (v) => (typeof v === "boolean" ? v : null);

  // "HH:MM" بأربع وعشرين ساعة. أُتحقق قبل الكتابة لأن TIME غير
  // صالح يرمي داخل المعاملة.
  let time = null;
  if (has("reminderTime") && reminderTime !== null) {
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(String(reminderTime))) {
      return res.status(400).json({ error: "invalid_reminder_time", message: "الوقت بصيغة HH:MM بنظام 24 ساعة." });
    }
    time = String(reminderTime);
  }

  let tz = null;
  if (has("reminderTimezone") && reminderTimezone !== null) {
    if (!isKnownTimeZone(String(reminderTimezone))) {
      return res.status(400).json({ error: "invalid_timezone" });
    }
    tz = String(reminderTimezone);
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE users
         SET reminders_on      = COALESCE($2, reminders_on),
             dark_mode         = COALESCE($3, dark_mode),
             marketing_opt_out = COALESCE($4, marketing_opt_out),
             updated_at        = now()
         WHERE id = $1
         RETURNING reminders_on, dark_mode, marketing_opt_out`,
        [req.userId, bool(remindersOn), bool(darkMode), bool(marketingOptOut)]
      );
      if (!rows[0]) throw Object.assign(new Error("not_found"), { status: 404 });

      /* صف الجدولة يُنشأ عند أول تفعيل أو أول ضبط لوقت. من لم يفعّل
         التذكير قط لا يحتاج صفاً — وجدول فيه صف لكل مستخدم بقيم
         افتراضية يكذب على أي إحصاء يقرأه لاحقاً. */
      const needsSchedule = rows[0].reminders_on === true || time !== null || tz !== null;
      let schedule = null;
      if (needsSchedule) {
        const { rows: sched } = await client.query(
          `INSERT INTO user_reminder_prefs (user_id, local_time, timezone, updated_at)
           VALUES ($1, COALESCE($2::time, '20:00'::time), COALESCE($3, 'Asia/Riyadh'), now())
           ON CONFLICT (user_id) DO UPDATE SET
             local_time = COALESCE($2::time, user_reminder_prefs.local_time),
             timezone   = COALESCE($3, user_reminder_prefs.timezone),
             updated_at = now()
           RETURNING local_time, timezone`,
          [req.userId, time, tz]
        );
        schedule = sched[0];
      } else {
        const { rows: sched } = await client.query(
          `SELECT local_time, timezone FROM user_reminder_prefs WHERE user_id = $1`,
          [req.userId]
        );
        schedule = sched[0] || null;
      }

      return { prefs: rows[0], schedule };
    });

    /* الرد يقول الحالة الحقيقية بعد الكتابة، ويُصرّح بحدود التسليم
       بدل أن يوحي بأن التذكير سيصل حتماً. الواجهة تبني عليه رسالتها
       فلا تعِد بما لا يقدر عليه النظام. */
    res.json({
      ...result.prefs,
      reminder: {
        enabled: result.prefs.reminders_on,
        localTime: result.schedule ? String(result.schedule.local_time).slice(0, 5) : null,
        timezone: result.schedule?.timezone || null,
      },
    });
  } catch (err) { fail(res, err, "preferences"); }
});

/* ============================================================
   9) الملف الشخصي — الفئة العمرية والجنس والدولة والجوال

   ------------------------------------------------------------
   لماذا لم يكن يُحفظ شيء
   ------------------------------------------------------------
   وصف المرحلة 6 يقول إن البيانات "تضيع بعد الخروج والدخول".
   والتشخيص من المستودع أدق: أعمدة users.age_range و users.gender
   و users.photo_url موجودة منذ schema.sql الأول، وبُحث في الكود
   كله عن UPDATE يمسّها فلم يوجد ولا واحد. وفي التطبيق تنتهي
   onUpdateUser عند setUser — حالة React لا نداء خادم.

   فالبيانات لم تكن تُفقد؛ **هي لم تُكتب قط.** وهذا هو نفس نمط
   «جداول بلا كاتب» الموصوف في القسم 6 من وثيقة حالة المشروع،
   متكرّراً للمرة الرابعة: قبله contact_messages و daily_logs
   و screenings و crisis_trigger_events.

   ------------------------------------------------------------
   أين يسكن كل حقل — وقرار صريح لا مصادفة
   ------------------------------------------------------------
   age_range · gender  →  users            (العمودان موجودان، UPDATE مسموح)
   country · phone     →  user_profile     (لا عمود لهما، و ALTER ممنوع)

   وهذا يعني كتابة في جدولين، ولذلك المعاملة أدناه. ولا يوجد في
   المشروع بعد هذا المسار أي مكان آخر يكتب هذه الحقول الأربعة.

   ------------------------------------------------------------
   ولماذا لم أضعها كلها في user_profile
   ------------------------------------------------------------
   لأن admin/routes.js يقرأ u.age_range و u.gender من users اليوم
   فعلاً. نسخها إلى جدول جديد كان سيصنع مصدرَي حقيقة في نفس
   اللحظة التي تطلب فيها المرحلة مصدراً واحداً — واللوحة كانت
   ستقرأ النسخة القديمة إلى أن يلاحظ أحد.
   ============================================================ */

/* ------------------------------------------------------------
   قائمة الدول ورموز الاتصال — مصدر واحد يخدم الواجهة والتحقق

   الواجهة لا تحمل قائمتها الخاصة: تقرأ هذه عبر GET /api/countries.
   والسبب ليس تنظيمياً: قائمة في المتصفح وقائمة في الخادم تختلفان
   يوماً ما، فيمرّ من الواجهة رمز يرفضه الخادم — أو أسوأ، يقبله
   الخادم لدولة غير التي اختارها المستخدم.

   ⚠️ **القائمة منتقاة لا شاملة**: دول الخليج والعالم العربي، ثم
   أكثر الوجهات التي يسافر إليها المستخدم السعودي أو يقيم فيها.
   وأقولها صراحةً بدل أن تبدو كاملة: من يسجّل من دولة خارجها لن
   يجد اسمها. التوسيع سطر واحد في هذه المصفوفة — ولا شيء غيره.

   وترتيبها هو ترتيب العرض: السعودية أولاً بنص المرحلة، ثم بقية
   الدول. الترتيب في البيانات لا في الواجهة، فلا ينحرف بينهما.
   ------------------------------------------------------------ */
export const COUNTRIES = [
  { code: "SA", dial: "966", name: "السعودية" },

  { code: "AE", dial: "971", name: "الإمارات" },
  { code: "BH", dial: "973", name: "البحرين" },
  { code: "KW", dial: "965", name: "الكويت" },
  { code: "OM", dial: "968", name: "عُمان" },
  { code: "QA", dial: "974", name: "قطر" },
  { code: "YE", dial: "967", name: "اليمن" },

  { code: "JO", dial: "962", name: "الأردن" },
  { code: "PS", dial: "970", name: "فلسطين" },
  { code: "LB", dial: "961", name: "لبنان" },
  { code: "SY", dial: "963", name: "سوريا" },
  { code: "IQ", dial: "964", name: "العراق" },
  { code: "EG", dial: "20",  name: "مصر" },
  { code: "SD", dial: "249", name: "السودان" },
  { code: "LY", dial: "218", name: "ليبيا" },
  { code: "TN", dial: "216", name: "تونس" },
  { code: "DZ", dial: "213", name: "الجزائر" },
  { code: "MA", dial: "212", name: "المغرب" },
  { code: "MR", dial: "222", name: "موريتانيا" },
  { code: "SO", dial: "252", name: "الصومال" },
  { code: "DJ", dial: "253", name: "جيبوتي" },
  { code: "KM", dial: "269", name: "جزر القمر" },

  { code: "TR", dial: "90",  name: "تركيا" },
  { code: "IR", dial: "98",  name: "إيران" },
  { code: "AF", dial: "93",  name: "أفغانستان" },
  { code: "PK", dial: "92",  name: "باكستان" },
  { code: "IN", dial: "91",  name: "الهند" },
  { code: "BD", dial: "880", name: "بنغلاديش" },
  { code: "LK", dial: "94",  name: "سريلانكا" },
  { code: "NP", dial: "977", name: "نيبال" },
  { code: "PH", dial: "63",  name: "الفلبين" },
  { code: "ID", dial: "62",  name: "إندونيسيا" },
  { code: "MY", dial: "60",  name: "ماليزيا" },
  { code: "SG", dial: "65",  name: "سنغافورة" },
  { code: "TH", dial: "66",  name: "تايلاند" },
  { code: "CN", dial: "86",  name: "الصين" },
  { code: "JP", dial: "81",  name: "اليابان" },
  { code: "KR", dial: "82",  name: "كوريا الجنوبية" },

  { code: "GB", dial: "44",  name: "المملكة المتحدة" },
  { code: "US", dial: "1",   name: "الولايات المتحدة" },
  { code: "CA", dial: "1",   name: "كندا" },
  { code: "FR", dial: "33",  name: "فرنسا" },
  { code: "DE", dial: "49",  name: "ألمانيا" },
  { code: "IT", dial: "39",  name: "إيطاليا" },
  { code: "ES", dial: "34",  name: "إسبانيا" },
  { code: "NL", dial: "31",  name: "هولندا" },
  { code: "SE", dial: "46",  name: "السويد" },
  { code: "CH", dial: "41",  name: "سويسرا" },
  { code: "AU", dial: "61",  name: "أستراليا" },
  { code: "NZ", dial: "64",  name: "نيوزيلندا" },

  { code: "ZA", dial: "27",  name: "جنوب أفريقيا" },
  { code: "NG", dial: "234", name: "نيجيريا" },
  { code: "KE", dial: "254", name: "كينيا" },
  { code: "ET", dial: "251", name: "إثيوبيا" },
  { code: "GH", dial: "233", name: "غانا" },
];

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

/* الفئات العمرية والجنس: نفس القيم التي يرسلها التطبيق حرفياً
   (AGE_RANGES و [male|female]). القائمة البيضاء هنا تمنع استقرار
   قيمة ثالثة في العمود عبر نداء مباشر — والعمودان بلا قيد CHECK
   في المخطط الأصلي، فهذا هو الحارس الوحيد.

   ⚠️ ملاحظة تحريرية لا تُصلَح هنا: الفئات الأربع تبدأ من 20 وتنتهي
   عند 60، فمن عمره 18 أو 19 (والتطبيق يشترط 18+) ومن تجاوز الستين
   بلا خانة. توسيعها قرار منتج لا هندسة، ويكفيه سطر في هذه
   المصفوفة وسطر مقابل في التطبيق. */
const AGE_RANGES = ["20-30", "30-40", "40-50", "50-60"];
const GENDERS = ["male", "female"];

/** يحوّل ما يصل من العميل إلى أرقام لاتينية مجرّدة. */
function normalizeDigits(input) {
  if (input === null || input === undefined) return "";
  const arabicIndic = "٠١٢٣٤٥٦٧٨٩";
  const easternArabic = "۰۱۲۳۴۵۶۷۸۹";
  return String(input)
    .replace(/[٠-٩]/g, (d) => String(arabicIndic.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(easternArabic.indexOf(d)))
    .replace(/\D/g, "");
}

/**
 * صيغة E.164 مشتقّة لا مخزّنة.
 *
 * تخزينها عموداً ثالثاً كان سيصنع ثلاث قيم لرقم واحد، واثنتان منها
 * قابلتان للانحراف عن الثالثة. البناء عند القراءة يجعل الانحراف
 * مستحيلاً بنيوياً.
 */
function toE164(dial, national) {
  if (!dial || !national) return null;
  return `+${dial}${national}`;
}

function profileShape(userRow, profileRow, avatarRow, reminderRow) {
  const dial = profileRow?.phone_country_code || null;
  const national = profileRow?.phone_national || null;
  return {
    name: userRow.name,
    email: userRow.email,
    ageRange: userRow.age_range,
    gender: userRow.gender,
    confirmedAdult: userRow.confirmed_adult,
    country: profileRow?.country_code || null,
    phone: dial ? { dial, national, e164: toE164(dial, national) } : null,
    // بصمة الصورة لا الصورة: الواجهة تبني بها عنوان الطلب فيتغيّر
    // مع كل صورة جديدة، فلا يبقى المتصفح على القديمة بعد التغيير.
    photo: avatarRow ? { exists: true, version: avatarRow.checksum, mime: avatarRow.mime } : { exists: false },
    remindersOn: userRow.reminders_on,
    darkMode: userRow.dark_mode,
    marketingOptOut: userRow.marketing_opt_out,
    reminder: {
      enabled: userRow.reminders_on,
      localTime: reminderRow ? String(reminderRow.local_time).slice(0, 5) : null,
      timezone: reminderRow?.timezone || null,
    },
  };
}

/**
 * GET /api/me/profile
 *
 * القارئ الوحيد للملف الشخصي. و/api/auth/me تبقى كما هي: هويّة
 * الجلسة لا الملف. مسارَا قراءة لنفس الحقول بشكلين مختلفين هو
 * تعريف مصدرَي الحقيقة، ولو بنفس الجدول.
 */
userDataRouter.get("/profile", requireVerifiedUser, async (req, res) => {
  try {
    const [{ rows: users }, { rows: profiles }, { rows: avatars }, { rows: reminders }] = await Promise.all([
      query(
        `SELECT name, email, age_range, gender, confirmed_adult,
                reminders_on, dark_mode, marketing_opt_out
         FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [req.userId]
      ),
      query(`SELECT country_code, phone_country_code, phone_national FROM user_profile WHERE user_id = $1`, [req.userId]),
      // البايتات لا تُقرأ هنا إطلاقاً — بصمة ونوع فقط. قراءة الصورة
      // مع كل فتح للملف الشخصي تحميل بلا سبب.
      query(`SELECT checksum, mime FROM user_avatars WHERE user_id = $1`, [req.userId]),
      query(`SELECT local_time, timezone FROM user_reminder_prefs WHERE user_id = $1`, [req.userId]),
    ]);
    if (!users[0]) return res.status(404).json({ error: "not_found" });
    res.json({ profile: profileShape(users[0], profiles[0], avatars[0], reminders[0]) });
  } catch (err) { fail(res, err, "profile"); }
});

/**
 * PATCH /api/me/profile  { ageRange, gender, country, phone: { dial, national } }
 *
 * ------------------------------------------------------------
 * قائمة بيضاء صريحة — لا إسناد جماعي
 * ------------------------------------------------------------
 * الحقول الأربعة تُقرأ بالاسم واحداً واحداً. الشكل الكسول
 * (`UPDATE users SET ... req.body`) كان سيسمح لأي عميل بكتابة
 * email_verified_at أو password_hash في نفس النداء.
 *
 * والهوية من req.userId وحدها — لا يوجد في هذا الملف مسار واحد
 * يقبل userId من جسم الطلب، وهذا ما يغلق IDOR بنيوياً لا بفحص.
 *
 * ودلالة القيم ثلاثية بقصد:
 *   الحقل غائب  → لا يتغيّر
 *   الحقل null  → يُمسح
 *   له قيمة     → يُضبط بعد التحقق
 * بدون التمييز بين الغائب والفارغ لا يستطيع المستخدم مسح رقمه
 * أبداً — وهو حق أساسي في بيان تعريفي.
 */
userDataRouter.patch("/profile", requireVerifiedUser, async (req, res) => {
  const body = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  try {
    /* -------- التحقق كاملاً قبل أي كتابة --------
       لأن الكتابة في جدولين داخل معاملة، ورفض في منتصفها كان
       سيترك نصف تعديل — أو أسوأ: عبارة فاشلة تُفسد المعاملة
       فيتحوّل COMMIT إلى ROLLBACK صامت. الدرس الذي كلّف المشروع
       أول دفعة حقيقية. */
    let ageRange;
    if (has("ageRange")) {
      ageRange = body.ageRange === null || body.ageRange === "" ? null : String(body.ageRange);
      if (ageRange !== null && !AGE_RANGES.includes(ageRange)) {
        return res.status(400).json({ error: "invalid_age_range", allowed: AGE_RANGES });
      }
    }

    let gender;
    if (has("gender")) {
      gender = body.gender === null || body.gender === "" ? null : String(body.gender);
      if (gender !== null && !GENDERS.includes(gender)) {
        return res.status(400).json({ error: "invalid_gender", allowed: GENDERS });
      }
    }

    let country;
    if (has("country")) {
      country = body.country === null || body.country === "" ? null : String(body.country).toUpperCase();
      if (country !== null && !COUNTRY_BY_CODE.has(country)) {
        return res.status(400).json({ error: "invalid_country" });
      }
    }

    let phoneDial;
    let phoneNational;
    if (has("phone")) {
      const p = body.phone;
      if (p === null) {
        phoneDial = null;
        phoneNational = null;
      } else {
        const dial = normalizeDigits(p?.dial).replace(/^0+/, "");
        const national = normalizeDigits(p?.national).replace(/^0+/, "");

        if (!dial || !national) return res.status(400).json({ error: "phone_incomplete" });
        if (!/^[1-9][0-9]{0,3}$/.test(dial)) return res.status(400).json({ error: "invalid_dial_code" });

        /* السعودية: تسع خانات تبدأ بـ5. مكتوبة كقاعدة خاصة لدولة
           واحدة عمداً — تعميمها على كل الدول (وهو ما تحذّر منه
           المرحلة نصّاً) كان سيرفض أرقاماً صحيحة من نصف العالم. */
        if (dial === "966") {
          if (!/^5[0-9]{8}$/.test(national)) {
            return res.status(400).json({
              error: "invalid_saudi_phone",
              message: "الرقم السعودي تسع خانات ويبدأ بـ5 (مثال: 512345678) بلا الصفر ولا مفتاح الدولة.",
            });
          }
        } else if (national.length < 4 || national.length > 14) {
          return res.status(400).json({ error: "invalid_phone_length" });
        }

        // الحدّ الأقصى لطول E.164 خمس عشرة خانة شاملة رمز الدولة.
        if (dial.length + national.length > 15) {
          return res.status(400).json({ error: "invalid_phone_length" });
        }

        /* رمز الاتصال يجب أن يطابق الدولة المختارة. بدون هذا الفحص
           يستقر في الصف "دولة = مصر ورقم سعودي" — وهو نوع التعارض
           الذي لا يُكتشف إلا يوم يُتصل بالرقم.

           وحين لا تصل الدولة في نفس النداء (المستخدم غيّر رقمه
           وحده)، تُقرأ **الدولة المخزّنة** لا يُتغاضى عن الفحص.
           التغاضي كان سيجعل تحديث الرقم منفرداً ثغرةً في قاعدة
           تسري على تحديثه مع الدولة. */
        let effectiveCountry = country;
        if (effectiveCountry === undefined) {
          const { rows: current } = await query(
            `SELECT country_code FROM user_profile WHERE user_id = $1`,
            [req.userId]
          );
          effectiveCountry = current[0]?.country_code || null;
        }
        const target = effectiveCountry ? COUNTRY_BY_CODE.get(effectiveCountry) : null;
        if (target && target.dial !== dial) {
          return res.status(400).json({ error: "dial_country_mismatch", expected: target.dial });
        }
        if (!target && ![...COUNTRY_BY_CODE.values()].some((c) => c.dial === dial)) {
          return res.status(400).json({ error: "unsupported_dial_code" });
        }

        phoneDial = dial;
        phoneNational = national;
      }
    }

    const touchesUsers = ageRange !== undefined || gender !== undefined;
    const touchesProfile = country !== undefined || phoneDial !== undefined;
    if (!touchesUsers && !touchesProfile) {
      return res.status(400).json({ error: "nothing_to_update" });
    }

    /* -------- الكتابة: جدولان، معاملة واحدة --------
       ولا try/catch داخلها. أي عبارة تفشل ترمي، والمعاملة تُلغى
       كاملة، فلا يستقر نصف ملف شخصي. */
    await withTransaction(async (client) => {
      if (touchesUsers) {
        await client.query(
          `UPDATE users
           SET age_range  = CASE WHEN $2 THEN $3 ELSE age_range END,
               gender     = CASE WHEN $4 THEN $5 ELSE gender END,
               updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL`,
          [req.userId, ageRange !== undefined, ageRange ?? null, gender !== undefined, gender ?? null]
        );
      }

      if (touchesProfile) {
        /* COALESCE لا تصلح هنا: هي تعني "أبقِ القديم لو الجديد
           NULL"، ونحن نحتاج NULL أن يعني "امسح". فالتمييز بعَلَم
           منطقي مستقل عن القيمة. */
        await client.query(
          `INSERT INTO user_profile (user_id, country_code, phone_country_code, phone_national, updated_at)
           VALUES ($1, $3, $5, $6, now())
           ON CONFLICT (user_id) DO UPDATE SET
             country_code       = CASE WHEN $2 THEN $3 ELSE user_profile.country_code END,
             phone_country_code = CASE WHEN $4 THEN $5 ELSE user_profile.phone_country_code END,
             phone_national     = CASE WHEN $4 THEN $6 ELSE user_profile.phone_national END,
             updated_at         = now()`,
          [
            req.userId,
            country !== undefined, country ?? null,
            phoneDial !== undefined, phoneDial ?? null, phoneNational ?? null,
          ]
        );
      }
    });

    /* الرد هو ما في القاعدة بعد الكتابة، لا ما أرسله العميل.
       إعادة صدى المدخلات كانت ستُظهر "حُفظ" لقيمة لم تصل. */
    const [{ rows: users }, { rows: profiles }, { rows: avatars }, { rows: reminders }] = await Promise.all([
      query(
        `SELECT name, email, age_range, gender, confirmed_adult,
                reminders_on, dark_mode, marketing_opt_out
         FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [req.userId]
      ),
      query(`SELECT country_code, phone_country_code, phone_national FROM user_profile WHERE user_id = $1`, [req.userId]),
      query(`SELECT checksum, mime FROM user_avatars WHERE user_id = $1`, [req.userId]),
      query(`SELECT local_time, timezone FROM user_reminder_prefs WHERE user_id = $1`, [req.userId]),
    ]);
    if (!users[0]) return res.status(404).json({ error: "not_found" });
    res.json({ profile: profileShape(users[0], profiles[0], avatars[0], reminders[0]) });
  } catch (err) { fail(res, err, "profile/update"); }
});

/* ============================================================
   10) الصورة الشخصية

   ------------------------------------------------------------
   لماذا في القاعدة لا في ملف على القرص
   ------------------------------------------------------------
   قرص Render مؤقّت يُبنى مع كل نشر ويُمحى معه. صورة تُكتب في مجلد
   تختفي عند أول إعادة نشر — وهو نفس عطل "البيانات تضيع" الذي
   تصلحه هذه المرحلة، مُعاداً في مكان آخر. ولا تخزين كائنات في
   المشروع، وإدخال مزوّد لأجل عشرين كيلوبايت تكلفة دائمة.

   ------------------------------------------------------------
   الأمن: لا يُوثق بالامتداد ولا بما يقوله العميل
   ------------------------------------------------------------
   النوع يُستنتج من **البايتات الافتتاحية** لا من Content-Type ولا
   من اسم الملف. ملف نصّي يحمل امتداد jpg وترويسة صورة هو أقدم
   طريق لرفع محتوى يُنفَّذ لاحقاً، والامتداد أضعف ما يمكن الوثوق به.

   والتقديم بنوع محتوى ثابت من القائمة البيضاء، مع nosniff
   المضبوطة عالمياً في index.js، فلا يعيد المتصفح تفسير البايتات.

   ⚠️ وحدّ الطلبات: مسار القراءة أدناه تحت /api/ الذي حدّه 60 لكل
   ربع ساعة **بمفتاح عنوان Cloudflare المشترك** (المشكلة 12.26).
   صورة تُطلب مرة عند فتح الملف الشخصي لا يجوز أن تأكل حصة يقاسمها
   غرباء — والاستثناء يُضبط في index.js ضمن [ب-2]، وETag أدناه
   يجعل الطلب المتكرر 304 بلا جسم أصلاً.
   ============================================================ */

const AVATAR_MAX_BYTES = 512 * 1024;
const AVATAR_MIN_BYTES = 64;

/**
 * يقرأ النوع والأبعاد من البايتات نفسها.
 * يعيد null لما لا يطابق صورة معروفة — والرفض حينها 415 لا 500.
 */
function readImageMeta(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // PNG: التوقيع ثمانية بايتات، ثم IHDR وفيه العرض والارتفاع.
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
    return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // JPEG: FFD8، ثم مسح المقاطع حتى أحد مقاطع SOF التي تحمل الأبعاد.
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xda || marker === 0xd9) break; // بداية البيانات المضغوطة
      const len = buf.readUInt16BE(i + 2);
      const isSOF =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) {
        return { mime: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
    // صورة JPEG صحيحة الترويسة بلا مقطع SOF مقروء: تُقبل بلا أبعاد.
    return { mime: "image/jpeg", width: null, height: null };
  }

  // WebP: RIFF ... WEBP، والأبعاد بحسب نوع المقطع.
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 " && buf.length >= 30) {
      return { mime: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8X" && buf.length >= 30) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { mime: "image/webp", width: w, height: h };
    }
    // VP8L وغيره: النوع مؤكَّد والأبعاد غير مقروءة هنا.
    return { mime: "image/webp", width: null, height: null };
  }

  return null;
}

/**
 * PUT /api/me/avatar   — الجسم بايتات الصورة الخام
 *
 * express.raw هنا لا express.json: الترميز base64 داخل JSON يكبّر
 * الحمولة الثلث، ويصطدم بحدّ 200 كيلوبايت المضبوط عالمياً. ووجود
 * محلّل خاص بهذا المسار لا يمسّ بقية المسارات — express.json لا
 * يعمل أصلاً على نوع محتوى ليس JSON.
 */
userDataRouter.put(
  "/avatar",
  requireVerifiedUser,
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: AVATAR_MAX_BYTES }),
  async (req, res) => {
    try {
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: "empty_body", message: "أرسل بايتات الصورة مع Content-Type صورة." });
      }
      if (buf.length < AVATAR_MIN_BYTES) return res.status(400).json({ error: "image_too_small" });
      if (buf.length > AVATAR_MAX_BYTES) return res.status(413).json({ error: "image_too_large" });

      const meta = readImageMeta(buf);
      if (!meta) return res.status(415).json({ error: "unsupported_image" });
      if (meta.width && meta.height && (meta.width > 4096 || meta.height > 4096)) {
        return res.status(413).json({ error: "image_dimensions_too_large" });
      }

      /* md5 هنا **بصمة محتوى للتخزين المؤقت لا أداة أمنية**: قيمة
         ETag تتغيّر مع أي تغيّر في البايتات وتكفي لإبطال نسخة
         المتصفح. لا قرار أمني مبني عليها في أي مكان. */
      const checksum = crypto.createHash("md5").update(buf).digest("hex");

      const { rows } = await query(
        `INSERT INTO user_avatars (user_id, mime, bytes, byte_size, width, height, checksum, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (user_id) DO UPDATE SET
           mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, byte_size = EXCLUDED.byte_size,
           width = EXCLUDED.width, height = EXCLUDED.height,
           checksum = EXCLUDED.checksum, updated_at = now()
         RETURNING checksum, mime, byte_size, width, height, updated_at`,
        [req.userId, meta.mime, buf, buf.length, meta.width ?? null, meta.height ?? null, checksum]
      );

      /* users.photo_url لا يُكتب فيه شيء — عمداً وليس نسياناً.
         مؤشر في users وبايتات في user_avatars مصدرا حقيقة، وأولهما
         سيكذب يوم يفشل تحديثه. مكتوب في رأس الترحيل 010. */
      res.json({ photo: { exists: true, version: rows[0].checksum, mime: rows[0].mime } });
    } catch (err) {
      // حدّ express.raw يرمي بهذا الرمز قبل أن يصل الجسم كاملاً.
      if (err?.type === "entity.too.large") return res.status(413).json({ error: "image_too_large" });
      fail(res, err, "avatar/upload");
    }
  }
);

/** GET /api/me/avatar — صورة صاحب الرمز وحده. */
userDataRouter.get("/avatar", requireVerifiedUser, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT mime, bytes, byte_size, checksum FROM user_avatars WHERE user_id = $1`,
      [req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: "no_avatar" });

    const etag = `"${rows[0].checksum}"`;
    // النسخة لم تتغيّر: 304 بلا جسم. هذا ما يجعل عرض الصورة في كل
    // شاشة لا يكلّف نقل بايتاتها في كل مرة.
    if (req.headers["if-none-match"] === etag) {
      res.setHeader("ETag", etag);
      return res.status(304).end();
    }

    res.setHeader("Content-Type", rows[0].mime);
    res.setHeader("Content-Length", rows[0].byte_size);
    res.setHeader("ETag", etag);
    // private: صورة شخصية لا تُخزَّن في وسيط مشترك.
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    res.setHeader("Content-Disposition", "inline");
    res.end(rows[0].bytes);
  } catch (err) { fail(res, err, "avatar/get"); }
});

userDataRouter.delete("/avatar", requireVerifiedUser, async (req, res) => {
  try {
    const { rowCount } = await query(`DELETE FROM user_avatars WHERE user_id = $1`, [req.userId]);
    if (!rowCount) return res.status(404).json({ error: "no_avatar" });
    res.json({ photo: { exists: false } });
  } catch (err) { fail(res, err, "avatar/delete"); }
});

/* ============================================================
   11) الخطة المولَّدة — القراءة

   الكتابة ليست هنا: تقع داخل POST /api/plan نفسه في index.js،
   في نفس النداء الذي يولّد الخطة. مسار كتابة منفصل كان سيسمح
   لعميل بكتابة "خطة" لم يولّدها الخادم — أي محتوى نفسي مصدره
   المتصفح يظهر للمستخدم كأنه ناتج تقييمه.

   والقراءة هنا لأن صاحب البيانات يقرأها كاملة. وهذا الجدول لا
   يقرؤه استعلام إداري إطلاقاً؛ اللوحة تعرف **وجود** خطة بـEXISTS
   ولا ترى حرفاً من محتواها.
   ============================================================ */

userDataRouter.get("/plans", requireVerifiedUser, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, week, source, status, summary, focus_areas, specialist_note,
              check_in, created_at, archived_at
       FROM user_plans WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 60`,
      [req.userId]
    );
    const active = rows.find((r) => r.status === "active") || null;
    res.json({
      active,
      history: rows.filter((r) => r.status === "archived"),
    });
  } catch (err) { fail(res, err, "plans/list"); }
});

/* ============================================================
   12) ملخص التقدّم — مصدر شرط فتح "بوصلة كنف"

   trackedDays يُحسب من الصفوف الفعلية لا من عدّاد في المتصفح. هذا
   هو السطر الذي يفتح ميزة مدفوعة كانت مغلقة على كل مستخدم.
   ============================================================ */

userDataRouter.get("/summary", requireVerifiedUser, async (req, res) => {
  try {
    const [{ rows: logs }, { rows: screens }, { rows: journeys }, { rows: notebooks }, { rows: unread }] =
      await Promise.all([
        query(`SELECT count(*)::int AS tracked_days, max(logged_on) AS last_logged_on FROM daily_logs WHERE user_id = $1`, [req.userId]),
        query(`SELECT count(*)::int AS n, max(created_at) AS last_at FROM screenings WHERE user_id = $1`, [req.userId]),
        query(`SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
                      count(*) FILTER (WHERE status = 'completed')::int AS completed
               FROM user_journey_enrollments WHERE user_id = $1`, [req.userId]),
        query(`SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
                      count(*) FILTER (WHERE status = 'draft')::int AS drafts
               FROM user_notebook_entries WHERE user_id = $1`, [req.userId]),
        query(`SELECT count(*)::int AS n FROM user_notifications WHERE user_id = $1 AND read_at IS NULL`, [req.userId]),
      ]);

    res.json({
      trackedDays: logs[0].tracked_days,
      lastLoggedOn: logs[0].last_logged_on,
      hasScreening: screens[0].n > 0,
      screeningCount: screens[0].n,
      lastScreeningAt: screens[0].last_at,
      journeys: journeys[0],
      notebooks: notebooks[0],
      unreadNotifications: unread[0].n,
      hasPlusAccess: await hasPlusAccess(req.userId),
    });
  } catch (err) { fail(res, err, "summary"); }
});

/* ============================================================
   13) مسارات عامة بلا مصادقة — مفتاح Push وقائمة الدول

   ليس سراً بحكم تصميم المعيار: المتصفح يحتاجه قبل طلب الإذن، وهو
   موجود في كل حمولة موقّعة أصلاً. حجبه خلف تسجيل الدخول كان سيمنع
   طلب الإذن في اللحظة المناسبة بلا أي مكسب أمني.
   ============================================================ */
export const pushPublicKeyRouter = express.Router();

pushPublicKeyRouter.get("/push/public-key", (req, res) => {
  const key = getPublicKey();
  res.json({ publicKey: key, enabled: Boolean(key) });
});

/**
 * GET /api/countries — قائمة الدول ورموز الاتصال.
 *
 * بلا مصادقة لأنها تُقرأ في شاشة الملف الشخصي قبل أي شيء، ولا شيء
 * فيها يخصّ مستخدماً.
 *
 * ولماذا من الخادم أصلاً: القائمة نفسها التي تُبنى منها القائمة
 * المنسدلة هي التي يتحقق بها PATCH /api/me/profile. لو كانت نسخة
 * في المتصفح ونسخة هنا لاختلفتا يوماً، فيختار المستخدم دولة يرفضها
 * الخادم — أو أسوأ، يقبلها برمز اتصال دولة أخرى.
 *
 * والترتيب مقصود ومحفوظ كما هو: السعودية أولاً بنص المرحلة. الترتيب
 * في البيانات لا في الواجهة، فلا ينحرف بينهما.
 */
pushPublicKeyRouter.get("/countries", (req, res) => {
  // بيانات ثابتة لا تتغيّر بين نشرتين: يُسمح بتخزينها يوماً كاملاً
  // فلا تُعاد في كل فتح للشاشة.
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.json({ countries: COUNTRIES, defaultCountry: "SA" });
});
