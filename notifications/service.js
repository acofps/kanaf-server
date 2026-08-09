import { query, withTransaction } from "../db/pool.js";
import { entitledSql } from "../billing/subscription.js";
import { sendEmail } from "../mail/send.js";
import { generateUnsubscribeToken } from "./unsubscribe.js";
import { sendPushToUser, isPushConfigured } from "./push.js";

/* ============================================================
   طبقة تسليم الإشعارات — ثلاث قنوات، وحالة حقيقية لكل مستلم.

   ------------------------------------------------------------
   ما كان قبل هذا الملف
   ------------------------------------------------------------
   دالة sendBroadcast واحدة ترسل بريداً عبر Resend وتعيد عدّادين.
   وحين يغيب RESEND_API_KEY (وهو غائب على Render) كانت ترد
   { id: "dev-mock" } ويُحسب **نجاحاً**، فيُخزَّن صف يقول
   "وصلت 214 مستخدماً" ولا رسالة واحدة غادرت. لا صف لكل مستلم، ولا
   سبب فشل، ولا طريقة للإجابة على "هل وصلت فلاناً؟".

   ------------------------------------------------------------
   المبدأ الحاكم
   ------------------------------------------------------------
   لا حالة تُكتب قبل حدوثها. تسلسل كل مستلم:

     queued → processing → (sent | delivered | failed | skipped)

   وزر "إرسال" في اللوحة لا يغيّر حالة الحملة بذاته إطلاقاً —
   الحالة تُشتق من صفوف التسليم بعد انتهاء التنفيذ الحقيقي.

   ------------------------------------------------------------
   لماذا in_app = delivered والبريد = sent
   ------------------------------------------------------------
   الإشعار داخل التطبيق يكتمل تسليمه بكتابة الصف: الصندوق عندنا،
   ونعرف يقيناً أنه صار في متناول المستخدم. أما SMTP فيقول "قبلت
   الرسالة" لا "وصلت الصندوق" — بينهما مرشّحات ورفض مؤجل وjunk.
   تسمية قبول SMTP بـ"delivered" هي بالضبط الكذبة التي أُصلحت هنا.
   وpush كذلك: قبول endpoint لا يعني ظهور الإشعار على الشاشة.
   ============================================================ */

const LATEST_SUB = `
  SELECT DISTINCT ON (user_id) id, user_id, status, current_period_end
  FROM subscriptions ORDER BY user_id, created_at DESC`;

/* ------------------------------------------------------------
   الجمهور.

   ملاحظة مقصودة: لا استعلام منها يستثني marketing_opt_out.
   الاستثناء يحدث لاحقاً **على مستوى قناة البريد وحدها**، ويُسجَّل
   صف skipped بسببه. الفرق عملي: من ألغى اشتراكه في البريد
   التسويقي لم يلغِ إشعارات التطبيق، وإسقاطه من الجمهور كله كان
   يعني حرمانه من كل إشعار — وكان أيضاً يخفي عدد المستثنين فلا
   يعرف المسؤول لماذا وصلت 180 من 214.
   ------------------------------------------------------------ */
export const AUDIENCE_SQL = {
  all: `SELECT u.id AS user_id, u.email, u.marketing_opt_out FROM users u WHERE u.deleted_at IS NULL`,

  active_subscribers: `
    SELECT u.id AS user_id, u.email, u.marketing_opt_out FROM users u
    JOIN (${LATEST_SUB}) s ON s.user_id = u.id
    WHERE u.deleted_at IS NULL AND ${entitledSql("s")}`,

  trial_or_free: `
    SELECT u.id AS user_id, u.email, u.marketing_opt_out FROM users u
    LEFT JOIN (${LATEST_SUB}) s ON s.user_id = u.id
    WHERE u.deleted_at IS NULL AND (s.id IS NULL OR NOT ${entitledSql("s")})`,

  // جمهور مختار بالاسم — يستخدم = ANY لا IN مبنية بالنص، فلا مجال
  // لحقن قائمة معرّفات.
  selected_users: `
    SELECT u.id AS user_id, u.email, u.marketing_opt_out FROM users u
    WHERE u.deleted_at IS NULL AND u.id = ANY($1::uuid[])`,

  // حالة الحساب مشتقّة لا مخزّنة — نفس التعريف المستخدم في قائمة
  // المستخدمين، فلا يظهر جمهور هنا يخالف ما تعرضه تلك الصفحة.
  account_status: `
    SELECT u.id AS user_id, u.email, u.marketing_opt_out FROM users u
    LEFT JOIN user_auth_state st ON st.user_id = u.id
    WHERE u.deleted_at IS NULL
      AND CASE
            WHEN st.suspended_at IS NOT NULL THEN 'suspended'
            WHEN u.email_verified_at IS NULL THEN 'pending_verification'
            ELSE 'active'
          END = $1`,
};

export const VALID_CHANNELS = ["in_app", "email", "push"];

function audienceParams(audience, filter = {}) {
  if (audience === "selected_users") {
    const ids = Array.isArray(filter.userIds) ? filter.userIds : [];
    if (ids.length === 0) throw Object.assign(new Error("selected_users_requires_user_ids"), { status: 400 });
    return [ids];
  }
  if (audience === "account_status") {
    const s = filter.status;
    if (!["active", "suspended", "pending_verification"].includes(s)) {
      throw Object.assign(new Error("invalid_account_status"), { status: 400 });
    }
    return [s];
  }
  return [];
}

export async function resolveAudience(audience, filter = {}) {
  const sql = AUDIENCE_SQL[audience];
  if (!sql) throw Object.assign(new Error("invalid_audience"), { status: 400 });
  const { rows } = await query(sql, audienceParams(audience, filter));
  return rows;
}

export async function countAudience(audience, filter = {}) {
  const sql = AUDIENCE_SQL[audience];
  if (!sql) throw Object.assign(new Error("invalid_audience"), { status: 400 });
  const { rows } = await query(`SELECT count(*)::int AS n FROM (${sql}) a`, audienceParams(audience, filter));
  return rows[0].n;
}

/* ------------------------------------------------------------
   قفل استشاري على مستوى الحملة.

   السيناريو الذي يمنعه: مسؤولان يضغطان "إرسال" في نفس الثانية، أو
   مسح مستحقّ يعمل بينما إرسال يدوي جارٍ. القفل الاستشاري في
   Postgres يعيد false فوراً بدل الانتظار، فالنداء الثاني ينسحب
   بلا ضرر ولا مهلة.

   القيد الفريد (campaign_id, user_id, channel) هو المرساة الثانية:
   حتى لو سقط القفل لأي سبب، الصف الثاني يستحيل أن يُدرَج. مرساتان
   لا واحدة — نفس نمط منع التكرار في طبقة الدفع.
   ------------------------------------------------------------ */
async function withCampaignLock(campaignId, fn) {
  const { pool } = await import("../db/pool.js");
  const client = await pool.connect();
  let locked = false;
  let unlockFailed = false;
  try {
    const { rows } = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1), hashtext('kanaf_campaign')) AS locked`,
      [campaignId]
    );
    locked = rows[0].locked;
    if (!locked) return { skipped: true, reason: "already_dispatching" };
    return await fn();
  } finally {
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1), hashtext('kanaf_campaign'))`, [campaignId]);
      } catch (err) {
        // انقطاع الاتصال أثناء الإطلاق. اتصال يعود إلى المجمّع وهو
        // ما زال حاملاً قفلاً على مستوى الجلسة يعني أن هذه الحملة
        // تُقفل إلى الأبد. release(true) يتلف الاتصال بدل إعادته،
        // فتُطلق Postgres قفله تلقائياً عند انتهاء الجلسة.
        unlockFailed = true;
        console.error("[notifications] تعذّر إطلاق قفل الحملة — سيُتلف الاتصال:", err.message);
      }
    }
    // release لم يكن يُنفَّذ أصلاً لو رمى الإطلاق: كان داخل finally
    // خارجي يسبقه await قد يرمي، فيتسرّب عميل من مجمّع بعشرة فقط.
    client.release(unlockFailed);
  }
}

/* ------------------------------------------------------------
   تنفيذ حملة.

   الترتيب مقصود بدقة:
     1. معاملة قصيرة تحجز الحملة (draft/scheduled → sending) وتنشئ
        صفوف التسليم queued. لا نداء خارجي داخلها إطلاقاً.
     2. الإرسال الفعلي **خارج أي معاملة**.
     3. تحديث الحالة النهائية.

   السبب مكتوب بالدم في هذا المشروع: نداء بطيء أو فاشل داخل معاملة
   يُبقيها مفتوحة، وأي خطأ قاعدة بيانات داخلها يُفسدها كاملة
   فيتحوّل COMMIT إلى ROLLBACK صامت — وهو ما أضاع أول دفعة حقيقية.
   الطبقة المالية أُعيد تشكيلها لهذا السبب، وهذه الطبقة تُولد به.
   ------------------------------------------------------------ */
export async function dispatchCampaign(campaignId, { trigger = "manual" } = {}) {
  return withCampaignLock(campaignId, async () => {
    // 1) الحجز
    const claim = await withTransaction(async (client) => {
      const { rows } = await client.query(
        // started_at ضروري لحساب الحملة العالقة — إغفاله يجعل
        // isStaleSending دائماً false فلا تُسترجَع حملة أبداً.
        `SELECT id, title, body, audience, audience_filter, channels, status, scheduled_at, started_at
         FROM notification_campaigns WHERE id = $1 FOR UPDATE`,
        [campaignId]
      );
      const c = rows[0];
      if (!c) throw Object.assign(new Error("campaign_not_found"), { status: 404 });

      /* --------------------------------------------------------
         الحالات التي يجوز الانطلاق منها.

         ⚠️ النسخة الأولى قبلت draft و scheduled فقط، فكانت أي
         حملة تُقاطَع في منتصف الإرسال تعلق في 'sending' إلى الأبد:
         لا /send يقبلها ولا /cancel. وRender يرسل SIGTERM عند كل
         نشر، فالسيناريو ليس نظرياً. والأسوأ أن التعليق في
         admin/notifications.js كان يعد بإعادة محاولة الفاشلة —
         وهو وعد لم يكن له تنفيذ.

         الآن:
           draft | scheduled                 → انطلاق عادي
           failed | partially_failed         → إعادة محاولة الفاشلة وحدها
           sending وقد مضى عليها 15 دقيقة    → استرجاع بعد انقطاع

         القيد الفريد (campaign_id, user_id, channel) هو ما يجعل
         هذا آمناً: الناجح لا يُعاد إرساله مهما تكرر النداء.
         -------------------------------------------------------- */
      const STALE_SENDING_MS = 15 * 60 * 1000;
      const isStaleSending =
        c.status === "sending" &&
        c.started_at &&
        Date.now() - new Date(c.started_at).getTime() > STALE_SENDING_MS;

      const canDispatch =
        ["draft", "scheduled", "failed", "partially_failed"].includes(c.status) || isStaleSending;

      if (!canDispatch) return { alreadyHandled: true, status: c.status };

      // صفوف علقت في processing من محاولة مقطوعة: تُعلَّم فاشلة
      // قبل البدء، فلا تبقى حالة وسيطة تُحسب لا نجاحاً ولا فشلاً.
      await client.query(
        `UPDATE notification_deliveries
         SET status = 'failed', error_code = COALESCE(error_code, 'interrupted'),
             error_detail = COALESCE(error_detail, 'انقطع التنفيذ قبل اكتمال هذه المحاولة'),
             updated_at = now()
         WHERE campaign_id = $1 AND status = 'processing'`,
        [campaignId]
      );

      await client.query(
        `UPDATE notification_campaigns
         SET status = 'sending', started_at = COALESCE(started_at, now()),
             finished_at = NULL, last_error = NULL, updated_at = now()
         WHERE id = $1`,
        [campaignId]
      );
      return { campaign: c };
    });

    if (claim.alreadyHandled) return { skipped: true, reason: `status_${claim.status}` };

    const campaign = claim.campaign;
    const channels = (campaign.channels || []).filter((c) => VALID_CHANNELS.includes(c));

    let recipients;
    try {
      recipients = await resolveAudience(campaign.audience, campaign.audience_filter || {});
    } catch (err) {
      await failCampaign(campaignId, `audience_resolution_failed: ${err.message}`);
      throw err;
    }

    // صفوف التسليم queued — ON CONFLICT DO NOTHING يجعل إعادة
    // التشغيل آمنة: ما أُنشئ سابقاً لا يُنشأ ثانية.
    for (const r of recipients) {
      for (const channel of channels) {
        await query(
          `INSERT INTO notification_deliveries (campaign_id, user_id, channel)
           VALUES ($1, $2, $3) ON CONFLICT (campaign_id, user_id, channel) DO NOTHING`,
          [campaignId, r.user_id, channel]
        );
      }
    }

    await query(
      `UPDATE notification_campaigns SET recipient_count = $2, updated_at = now() WHERE id = $1`,
      [campaignId, recipients.length]
    );

    // 2) الإرسال — خارج أي معاملة
    const byUser = new Map(recipients.map((r) => [r.user_id, r]));
    const { rows: pending } = await query(
      `SELECT id, user_id, channel FROM notification_deliveries
       WHERE campaign_id = $1 AND status IN ('queued', 'failed')
       ORDER BY created_at`,
      [campaignId]
    );

    for (const d of pending) {
      const user = byUser.get(d.user_id);
      if (!user) continue;
      await deliverOne(d, user, campaign);
    }

    // 3) الحالة النهائية — مشتقّة من الصفوف، لا من نية المرسل
    const summary = await finalizeCampaign(campaignId);
    return { ...summary, trigger };
  });
}

async function deliverOne(delivery, user, campaign) {
  await query(
    `UPDATE notification_deliveries
     SET status = 'processing', attempts = attempts + 1, last_attempt_at = now(), updated_at = now()
     WHERE id = $1`,
    [delivery.id]
  );

  let result;
  try {
    if (delivery.channel === "in_app") {
      result = await deliverInApp(delivery, campaign);
    } else if (delivery.channel === "email") {
      result = await deliverEmail(delivery, user, campaign);
    } else if (delivery.channel === "push") {
      result = await deliverPush(delivery, campaign);
    } else {
      result = { status: "failed", errorCode: "unknown_channel", errorDetail: delivery.channel };
    }
  } catch (err) {
    result = {
      status: "failed",
      errorCode: err?.code || "exception",
      errorDetail: String(err?.message || err).slice(0, 500),
    };
  }

  await query(
    `UPDATE notification_deliveries
     SET status = $2, provider_message_id = $3, error_code = $4, error_detail = $5, updated_at = now()
     WHERE id = $1`,
    [delivery.id, result.status, result.providerMessageId || null, result.errorCode || null, result.errorDetail || null]
  );
}

async function deliverInApp(delivery, campaign) {
  const { rows } = await query(
    `INSERT INTO user_notifications (user_id, title, body, kind, source, campaign_id, dedup_key)
     VALUES ($1, $2, $3, 'info', 'campaign', $4, $5)
     ON CONFLICT (user_id, dedup_key) DO NOTHING
     RETURNING id`,
    [delivery.user_id, campaign.title, campaign.body, campaign.id, `campaign:${campaign.id}`]
  );
  // صف موجود مسبقاً = وصل سابقاً. delivered لا failed — إعادة
  // التشغيل يجب ألا تحوّل نجاحاً قديماً إلى فشل جديد.
  return { status: "delivered", providerMessageId: rows[0]?.id || null };
}

async function deliverEmail(delivery, user, campaign) {
  if (user.marketing_opt_out) {
    return { status: "skipped", errorCode: "marketing_opt_out", errorDetail: "المستخدم ألغى اشتراكه في الرسائل التسويقية" };
  }
  const baseUrl = process.env.SERVER_BASE_URL || "http://localhost:3001";
  const token = generateUnsubscribeToken(delivery.user_id);
  const unsubscribeUrl = `${baseUrl}/api/unsubscribe?token=${encodeURIComponent(token)}`;

  // sendEmail يرمي في الإنتاج حين يغيب إعداد SMTP — وهذا مقصود:
  // الخطأ يظهر هنا كـfailed حقيقي بسبب واضح، بدل نجاح كاذب.
  const result = await sendEmail(user.email, campaign.title, `${campaign.body}\n\nلإلغاء الاشتراك: ${unsubscribeUrl}`, {
    html: wrapAsHtml(campaign.title, campaign.body, unsubscribeUrl),
  });

  /* ⚠️ خارج NODE_ENV=production لا يرمي sendEmail — يطبع سطراً في
     الطرفية ويعيد { delivered: false, dev: true }. تجاهل هذه القيمة
     كان يسجّل "sent" بلا إرسال: نفس عطب { id: "dev-mock" } الذي
     أُنشئ هذا الملف لقتله، عائداً من باب آخر. ويكفي أن يُنسى
     NODE_ENV على Render ليصير حياً. */
  if (result && result.dev) {
    return { status: "skipped", errorCode: "mail_not_configured", errorDetail: "إعداد SMTP غائب — لم تُرسل رسالة" };
  }
  // sent لا delivered: SMTP قبِل الرسالة، ولا نعرف مصيرها بعدها.
  return { status: "sent" };
}

async function deliverPush(delivery, campaign) {
  const r = await sendPushToUser(delivery.user_id, { title: campaign.title, body: campaign.body });
  if (r.ok) return { status: "sent" };
  // لا اشتراك على أي جهاز ليس فشلاً في الإرسال — المستخدم لم يمنح
  // الإذن أصلاً. skipped يبقي عدّاد الفشل صادقاً.
  if (r.errorCode === "no_push_subscription") {
    return { status: "skipped", errorCode: r.errorCode, errorDetail: r.errorDetail };
  }
  return { status: "failed", errorCode: r.errorCode, errorDetail: r.errorDetail };
}

async function finalizeCampaign(campaignId) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE status IN ('sent', 'delivered'))::int   AS ok,
       -- processing و queued يُحسبان فشلاً: صف لم يبلغ حالة نهائية
       -- بعد انتهاء التنفيذ يعني أن شيئاً انقطع. حسابه محايداً كان
       -- سيسمح بحملة تُعلَّم "sent" وفيها صفوف معلّقة.
       count(*) FILTER (WHERE status IN ('failed', 'processing', 'queued'))::int AS failed,
       count(*) FILTER (WHERE status = 'skipped')::int               AS skipped,
       count(*)::int                                                  AS total
     FROM notification_deliveries WHERE campaign_id = $1`,
    [campaignId]
  );
  const s = rows[0];

  // "sent" فقط حين لا فشل. أي فشل واحد يغيّر الاسم — لأن مسؤولاً
  // يقرأ "تم الإرسال" لن يفتح التفاصيل ليكتشف أن 30 لم تصل.
  let status = "sent";
  if (s.total === 0) status = "failed";
  else if (s.failed > 0 && s.ok === 0) status = "failed";
  else if (s.failed > 0) status = "partially_failed";

  await query(
    `UPDATE notification_campaigns
     SET status = $2, sent_count = $3, failed_count = $4, finished_at = now(), updated_at = now()
     WHERE id = $1`,
    [campaignId, status, s.ok, s.failed]
  );

  return { status, sent: s.ok, failed: s.failed, skipped: s.skipped, total: s.total };
}

async function failCampaign(campaignId, reason) {
  await query(
    `UPDATE notification_campaigns
     SET status = 'failed', last_error = $2, finished_at = now(), updated_at = now()
     WHERE id = $1`,
    [campaignId, String(reason).slice(0, 500)]
  );
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wrapAsHtml(subject, plainTextMessage, unsubscribeUrl) {
  const escaped = escapeHtml(plainTextMessage).replace(/\n/g, "<br>");
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<body style="font-family: Arial, sans-serif; direction: rtl; text-align: right; background: #f4f6f6; padding: 24px;">
  <div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; border: 1px solid #e0e6e6;">
    <h2 style="color: #0D5C6B; margin-top: 0;">${escapeHtml(subject)}</h2>
    <p style="color: #333; line-height: 1.8; font-size: 14px;">${escaped}</p>
  </div>
  <p style="text-align: center; font-size: 11px; color: #999; margin-top: 16px;">
    <a href="${unsubscribeUrl}" style="color: #999;">إلغاء الاشتراك من هذي الرسائل</a>
  </p>
</body></html>`;
}

/* ------------------------------------------------------------
   إشعار نظامي لمستخدم واحد — داخل التطبيق فقط.

   يستخدمه الخادم للأحداث التي كان التطبيق يخترعها محلياً: قرب
   انتهاء التجربة، قرب انتهاء الاشتراك، جاهزية بوصلة الأسبوع.
   dedupKey يجعل النداء المتكرر بلا أثر مهما تكرر.

   لا يمر بالحملات لأنه ليس حملة: لا جمهور ولا قناة متعددة ولا
   سجل إداري — وحشره في notification_campaigns كان سينتج آلاف
   الحملات ذات المستلم الواحد.
   ------------------------------------------------------------ */
/* ⚠️ لا مستدعي لهذه الدالة في المستودع حتى الآن.

   موجودة لأن الجدول والقيد الفريد يدعمانها، والحاجة إليها قائمة
   (تذكير قرب انتهاء التجربة أو الاشتراك، جاهزية بوصلة الأسبوع) —
   لكن هذه التذكيرات لا تزال تُولَّد في المتصفح. تُذكر هنا صراحةً
   بدل تركها تبدو ميزة مبنيّة: القاعدة الثابتة في هذا المشروع أن
   ما يبدو مبنياً وليس موصولاً أخطر من الناقص الظاهر. */
export async function notifyUser(userId, { title, body, kind = "info", source = "system", dedupKey = null }) {
  const { rows } = await query(
    `INSERT INTO user_notifications (user_id, title, body, kind, source, dedup_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, dedup_key) DO NOTHING
     RETURNING id, created_at`,
    [userId, title, body, kind, source, dedupKey]
  );
  return rows[0] || null;
}

export { isPushConfigured };
