import express from "express";
import { query } from "../db/pool.js";
import { requireAdminAuth, requirePermission, requireUuidParam, logAdminAction } from "./middleware.js";
import {
  countAudience, dispatchCampaign, VALID_CHANNELS, isPushConfigured,
} from "../notifications/service.js";
import { sweepDueCampaigns, schedulerStatus } from "../notifications/scheduler.js";

export const adminNotificationsRouter = express.Router();

/* حارس معرّف UUID من admin/middleware.js — كان معرَّفاً هنا وفي
   admin/content.js بنسختين متطابقتين. نسخة واحدة الآن. */

/* ============================================================
   إدارة الإشعارات.

   ------------------------------------------------------------
   ما استُبدل
   ------------------------------------------------------------
   ثلاثة مسارات /admin/broadcasts كانت ترسل بريداً عبر Resend
   وتخزّن عدّادين. وحين يغيب RESEND_API_KEY — وهو غائب على Render —
   كان الرد { id: "dev-mock" } يُحسب نجاحاً: تأكيد بعدد المستلمين،
   وصف "ناجح" في السجل، وصفر رسائل غادرت.

   السطر الجوهري في هذا الملف: زر الإرسال لا يكتب حالة. الحالة
   تُشتق بعد التنفيذ من صفوف notification_deliveries — صف لكل
   (مستلم، قناة) بسببه الحقيقي عند الفشل.

   ------------------------------------------------------------
   لماذا لا يوجد DELETE لحملة أُرسلت
   ------------------------------------------------------------
   لأن الحذف يمحو الدليل لا الفعل. الرسائل غادرت، وسجل من استلمها
   جزء من قدرة الدعم على الإجابة. الإلغاء ممكن قبل التنفيذ فقط.
   ============================================================ */

/* ------------------------------------------------------------
   GET /admin/notifications/audience-count?audience=&status=&userIds=
   عدد حقيقي من قاعدة البيانات قبل أي التزام — البث صعب التراجع.
   ------------------------------------------------------------ */
adminNotificationsRouter.get(
  "/notifications/audience-count",
  requireAdminAuth, requirePermission("notifications:view"),
  async (req, res) => {
    try {
      const filter = {};
      if (req.query.status) filter.status = req.query.status;
      if (req.query.userIds) filter.userIds = String(req.query.userIds).split(",").map((s) => s.trim()).filter(Boolean);
      const count = await countAudience(req.query.audience, filter);
      res.json({ count });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error("[admin/notifications] audience count failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

/* ------------------------------------------------------------
   GET /admin/notifications — قائمة الحملات مع بحث وفلترة وترقيم.
   ------------------------------------------------------------ */
adminNotificationsRouter.get("/notifications", requireAdminAuth, requirePermission("notifications:view"), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where = [];
    const params = [];
    if (req.query.status) { params.push(req.query.status); where.push(`c.status = $${params.length}`); }
    if (req.query.audience) { params.push(req.query.audience); where.push(`c.audience = $${params.length}`); }
    if (req.query.channel) { params.push(req.query.channel); where.push(`$${params.length} = ANY(c.channels)`); }
    if ((req.query.search || "").trim()) {
      params.push(`%${req.query.search.trim()}%`);
      where.push(`(c.title ILIKE $${params.length} OR c.body ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    params.push(limit, offset);
    const { rows } = await query(
      `SELECT c.id, c.title, c.audience, c.channels, c.status, c.scheduled_at,
              c.started_at, c.finished_at, c.recipient_count, c.sent_count, c.failed_count,
              c.last_error, c.created_at, au.name AS created_by_name
       FROM notification_campaigns c
       LEFT JOIN admin_users au ON au.id = c.created_by
       ${whereSql}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const { rows: countRows } = await query(
      `SELECT count(*)::int AS total FROM notification_campaigns c ${whereSql}`,
      params.slice(0, params.length - 2)
    );

    res.json({ campaigns: rows, total: countRows[0].total, limit, offset });
  } catch (err) {
    console.error("[admin/notifications] list failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ------------------------------------------------------------
   GET /admin/notifications/:id/deliveries?status=

   الشاشة التي كانت مستحيلة قبل هذه المرحلة: من استلم، بأي قناة،
   وبأي سبب فشل. البريد يُعرض مقنّعاً — صفحة تشخيص تسليم لا تحتاج
   قائمة عناوين كاملة قابلة للنسخ.
   ------------------------------------------------------------ */
adminNotificationsRouter.get(
  "/notifications/:id/deliveries",
  requireAdminAuth, requirePermission("notifications:view"), requireUuidParam("id"),
  async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      const params = [req.params.id];
      let statusFilter = "";
      if (req.query.status) { params.push(req.query.status); statusFilter = ` AND d.status = $${params.length}`; }
      if (req.query.channel) { params.push(req.query.channel); statusFilter += ` AND d.channel = $${params.length}`; }

      params.push(limit, offset);
      const { rows } = await query(
        `SELECT d.id, d.user_id, d.channel, d.status, d.attempts,
                d.error_code, d.error_detail, d.last_attempt_at,
                u.name AS user_name,
                regexp_replace(u.email, '(^.).*(@.*$)', '\\1***\\2') AS user_email_masked
         FROM notification_deliveries d
         JOIN users u ON u.id = d.user_id
         WHERE d.campaign_id = $1 ${statusFilter}
         ORDER BY d.status, d.created_at, d.id
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      const { rows: summary } = await query(
        `SELECT channel, status, count(*)::int AS n
         FROM notification_deliveries WHERE campaign_id = $1
         GROUP BY channel, status ORDER BY channel, status`,
        [req.params.id]
      );

      res.json({ deliveries: rows, summary, limit, offset });
    } catch (err) {
      console.error("[admin/notifications] deliveries failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

/* ------------------------------------------------------------
   POST /admin/notifications  { title, body, audience, audienceFilter,
                                channels, scheduledAt, sendNow }

   القنوات تُفحص عند الإنشاء لا عند الإرسال. اختيار push على خادم
   بلا مفاتيح VAPID يُرفض هنا برسالة صريحة — بدل قبول الحملة ثم
   فشلها لاحقاً بصمت. هذا هو الدرس المستخلص من عطب البث القديم
   مطبَّقاً في أبكر نقطة ممكنة.
   ------------------------------------------------------------ */
adminNotificationsRouter.post("/notifications", requireAdminAuth, requirePermission("notifications:create"), async (req, res) => {
  const { title, body, audience, audienceFilter, channels, scheduledAt, sendNow } = req.body || {};

  if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: "title_and_body_required" });

  const chans = Array.isArray(channels) && channels.length ? channels : ["in_app"];
  const invalid = chans.filter((c) => !VALID_CHANNELS.includes(c));
  if (invalid.length) return res.status(400).json({ error: "invalid_channel", detail: invalid });

  if (chans.includes("push") && !isPushConfigured()) {
    return res.status(400).json({
      error: "push_not_configured",
      message: "قناة Push تحتاج VAPID_PUBLIC_KEY و VAPID_PRIVATE_KEY على الخادم. اختر قناة ثانية أو اضبط المفتاحين.",
    });
  }

  let scheduled = null;
  if (scheduledAt) {
    const d = new Date(scheduledAt);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: "invalid_scheduled_at" });
    if (d.getTime() < Date.now() - 60_000) return res.status(400).json({ error: "scheduled_at_in_past" });
    scheduled = d.toISOString();
  }

  try {
    // العدد يُحسب قبل الإنشاء ليُرفض جمهور فارغ — إرسال إلى صفر
    // مستلم يعني غالباً فلتراً خاطئاً، وتمريره ينتج حملة "ناجحة"
    // بلا أثر يربك من يقرأ السجل لاحقاً.
    const count = await countAudience(audience, audienceFilter || {});
    if (count === 0) return res.status(422).json({ error: "no_recipients_in_audience" });

    const status = scheduled ? "scheduled" : "draft";
    const { rows } = await query(
      `INSERT INTO notification_campaigns
         (title, body, audience, audience_filter, channels, status, scheduled_at, recipient_count, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6, $7, $8, $9)
       RETURNING id, status, scheduled_at, created_at`,
      [
        title.trim(), body.trim(), audience, JSON.stringify(audienceFilter || {}),
        chans, status, scheduled, count, req.admin.id,
      ]
    );
    const campaign = rows[0];

    await logAdminAction({
      adminUserId: req.admin.id,
      action: scheduled ? "notification_schedule" : "notification_create",
      newValue: { title: title.trim(), audience, channels: chans, scheduled_at: scheduled, recipient_count: count },
      reason: "إنشاء إشعار",
      metadata: { campaign_id: campaign.id },
      ipAddress: req.ip,
    });

    if (sendNow === true && !scheduled) {
      const result = await dispatchCampaign(campaign.id, { trigger: "manual" });
      await logAdminAction({
        adminUserId: req.admin.id,
        action: "notification_send",
        newValue: result,
        reason: "إرسال فوري",
        metadata: { campaign_id: campaign.id },
        ipAddress: req.ip,
      });
      return res.status(201).json({ ...campaign, dispatch: result, audienceCount: count });
    }

    res.status(201).json({ ...campaign, audienceCount: count });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[admin/notifications] create failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ------------------------------------------------------------
   POST /admin/notifications/:id/send — إرسال مسودة أو إعادة محاولة.

   إعادة الاستدعاء آمنة: صفوف التسليم الناجحة محمية بالقيد الفريد
   فلا تتكرر، والفاشلة وحدها يُعاد محاولتها.
   ------------------------------------------------------------ */
adminNotificationsRouter.post("/notifications/:id/send", requireAdminAuth, requirePermission("notifications:send"), requireUuidParam("id"), async (req, res) => {
  try {
    const result = await dispatchCampaign(req.params.id, { trigger: "manual" });
    await logAdminAction({
      adminUserId: req.admin.id,
      action: "notification_send",
      newValue: result,
      reason: String(req.body?.reason || "إرسال إشعار"),
      metadata: { campaign_id: req.params.id },
      ipAddress: req.ip,
    });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[admin/notifications] send failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ------------------------------------------------------------
   POST /admin/notifications/:id/cancel — قبل التنفيذ فقط.
   ------------------------------------------------------------ */
adminNotificationsRouter.post("/notifications/:id/cancel", requireAdminAuth, requirePermission("notifications:cancel"), requireUuidParam("id"), async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE notification_campaigns SET status = 'canceled', updated_at = now()
       WHERE id = $1 AND status IN ('draft', 'scheduled')
       RETURNING id, status`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(409).json({ error: "cannot_cancel_after_dispatch" });

    await logAdminAction({
      adminUserId: req.admin.id,
      action: "notification_cancel",
      newValue: { status: "canceled" },
      reason: String(req.body?.reason || "إلغاء إشعار مجدول"),
      metadata: { campaign_id: req.params.id },
      ipAddress: req.ip,
    });
    res.json(rows[0]);
  } catch (err) {
    console.error("[admin/notifications] cancel failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ------------------------------------------------------------
   حالة الجدولة + تشغيل المسح يدوياً.

   المسح يعمل تلقائياً على هامش حركة الخادم (scheduler.js)؛ هذان
   المساران للتشخيص ولإجبار التنفيذ عند الحاجة.
   ------------------------------------------------------------ */
adminNotificationsRouter.get("/notifications-scheduler/status", requireAdminAuth, requirePermission("notifications:view"), async (req, res) => {
  try {
    res.json(await schedulerStatus());
  } catch (err) {
    console.error("[admin/notifications] scheduler status failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

adminNotificationsRouter.post("/notifications-scheduler/sweep", requireAdminAuth, requirePermission("notifications:sweep"), async (req, res) => {
  try {
    res.json(await sweepDueCampaigns({ log: console.log }));
  } catch (err) {
    console.error("[admin/notifications] sweep failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});


/* ============================================================
   مسارات التوافق — /admin/broadcasts

   ------------------------------------------------------------
   لماذا عادت بعد حذفها
   ------------------------------------------------------------
   حزمة لوحة الإدارة المنشورة داخل هذا المستودع (admin-ui/assets)
   مبنيّة، **ومصدرها غير موجود على GitHub**، فلا يمكن إعادة بنائها
   من هنا. وهي تنادي ثلاثة مسارات بالضبط:

       GET  /admin/broadcasts
       GET  /admin/broadcasts/audience-count?audience=
       POST /admin/broadcasts { subject, message, audience }

   حذفها في النسخة الأولى من هذه المرحلة كان يعني أن صفحة
   «الإشعارات» في اللوحة الحيّة ترد 404 عند كل استخدام — أي أن
   إصلاح البث الوهمي كان سينتهي بتعطيل البث كلياً.

   ------------------------------------------------------------
   ما هذه المسارات ليست
   ------------------------------------------------------------
   ليست عودة للكود القديم. لا يوجد Resend ولا mock ولا مسار إرسال
   ثانٍ. هي **محوّلات رقيقة فوق نفس نظام الحملات**: كل بث ينشئ
   حملة حقيقية في notification_campaigns، وتُكتب له صفوف تسليم في
   notification_deliveries، ويظهر في نفس الشاشات.

   القناتان `in_app` و`email` معاً: البث القديم كان بريداً فقط،
   وإضافة صندوق التطبيق تجعله يصل حتى لمن لا يفتح بريده — وهي
   الفجوة التي وصفها notifications/README.md القديم بنفسه.

   شكل الرد مطابق للقديم حرفياً (`broadcasts` · `count` ·
   `sent`/`failed`/`totalRecipients`) لأن اللوحة تقرأ هذه الأسماء.
   تُحذف هذه الكتلة كاملةً يوم تُبنى اللوحة على /admin/notifications.
   ============================================================ */

adminNotificationsRouter.get("/broadcasts/audience-count", requireAdminAuth, requirePermission("notifications:view"), async (req, res) => {
  try {
    const count = await countAudience(req.query.audience, {});
    res.json({ count });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[admin/broadcasts] audience count failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

adminNotificationsRouter.get("/broadcasts", requireAdminAuth, requirePermission("notifications:view"), async (req, res) => {
  try {
    /* التاريخ يُقرأ من الحملات لا من broadcast_notifications.

       الجدول القديم يبقى بسجلاته السابقة ولا يُكتب فيه بعد الآن،
       فقراءته كانت ستُظهر تاريخاً متجمّداً عند آخر بث قديم بينما
       البث الجديد لا يظهر. الاسمان `subject` و`recipient_count`
       محفوظان لأن اللوحة تقرأهما. */
    const { rows } = await query(
      `SELECT c.id, c.title AS subject, c.audience,
              c.recipient_count, c.sent_count, c.failed_count,
              c.status, c.created_at, au.name AS sent_by_name
       FROM notification_campaigns c
       LEFT JOIN admin_users au ON au.id = c.created_by
       WHERE c.audience IN ('all', 'active_subscribers', 'trial_or_free')
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT 50`
    );
    res.json({ broadcasts: rows });
  } catch (err) {
    console.error("[admin/broadcasts] list failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

adminNotificationsRouter.post("/broadcasts", requireAdminAuth, requirePermission("notifications:create"), async (req, res) => {
  const { subject, message, audience } = req.body || {};
  if (!subject?.trim() || !message?.trim()) {
    return res.status(400).json({ error: "subject_message_and_valid_audience_required" });
  }

  try {
    const count = await countAudience(audience, {});
    if (count === 0) return res.status(422).json({ error: "no_recipients_in_audience" });

    const { rows } = await query(
      `INSERT INTO notification_campaigns
         (title, body, audience, audience_filter, channels, status, recipient_count, created_by)
       VALUES ($1, $2, $3, '{}'::jsonb, ARRAY['in_app','email']::text[], 'draft', $4, $5)
       RETURNING id`,
      [subject.trim(), message.trim(), audience, count, req.admin.id]
    );
    const campaignId = rows[0].id;

    await logAdminAction({
      adminUserId: req.admin.id,
      action: "notification_create",
      newValue: { title: subject.trim(), audience, channels: ["in_app", "email"], recipient_count: count },
      reason: "بث جماعي (المسار المتوافق)",
      metadata: { campaign_id: campaignId, legacy_route: true },
      ipAddress: req.ip,
    });

    const result = await dispatchCampaign(campaignId, { trigger: "legacy_broadcast" });

    await logAdminAction({
      adminUserId: req.admin.id,
      action: "notification_send",
      newValue: result,
      reason: "بث جماعي (المسار المتوافق)",
      metadata: { campaign_id: campaignId, legacy_route: true },
      ipAddress: req.ip,
    });

    res.status(201).json({
      id: campaignId,
      sent: result.sent ?? 0,
      failed: result.failed ?? 0,
      totalRecipients: count,
      // اللوحة القديمة تعرض errors[0] لو وُجد. الحالة الحقيقية
      // للحملة تُقرأ من الشاشة الجديدة أو من قاعدة البيانات.
      errors: result.status === "sent" ? [] : [`حالة الحملة: ${result.status}`],
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[admin/broadcasts] send failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});
