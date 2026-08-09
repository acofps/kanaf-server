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
   8) التفضيلات

   تُكتب في users مباشرة: UPDATE مسموح على الجداول الأصلية (الممنوع
   هو ALTER)، والأعمدة الثلاثة موجودة أصلاً بلا أي كاتب.
   marketing_opt_out قابل للضبط من هنا ومن رابط إلغاء الاشتراك في
   البريد، وكلاهما يكتب في نفس العمود — مصدر حقيقة واحد.
   ============================================================ */

userDataRouter.patch("/preferences", requireVerifiedUser, async (req, res) => {
  const { remindersOn, darkMode, marketingOptOut } = req.body || {};
  const bool = (v) => (typeof v === "boolean" ? v : null);
  try {
    const { rows } = await query(
      `UPDATE users
       SET reminders_on      = COALESCE($2, reminders_on),
           dark_mode         = COALESCE($3, dark_mode),
           marketing_opt_out = COALESCE($4, marketing_opt_out),
           updated_at        = now()
       WHERE id = $1
       RETURNING reminders_on, dark_mode, marketing_opt_out`,
      [req.userId, bool(remindersOn), bool(darkMode), bool(marketingOptOut)]
    );
    res.json(rows[0]);
  } catch (err) { fail(res, err, "preferences"); }
});

/* ============================================================
   9) ملخص التقدّم — مصدر شرط فتح "بوصلة كنف"

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
   10) مفتاح Push العام — بلا مصادقة عمداً.

   ليس سراً بحكم تصميم المعيار: المتصفح يحتاجه قبل طلب الإذن، وهو
   موجود في كل حمولة موقّعة أصلاً. حجبه خلف تسجيل الدخول كان سيمنع
   طلب الإذن في اللحظة المناسبة بلا أي مكسب أمني.
   ============================================================ */
export const pushPublicKeyRouter = express.Router();
pushPublicKeyRouter.get("/push/public-key", (req, res) => {
  const key = getPublicKey();
  res.json({ publicKey: key, enabled: Boolean(key) });
});
