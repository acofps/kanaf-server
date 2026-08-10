import { query, pool } from "../db/pool.js";
import { notifyUser } from "./service.js";
import { sendPushToUser, isPushConfigured } from "./push.js";

/* ============================================================
   تذكير التسجيل اليومي — البند 6 من المرحلة 6

   ------------------------------------------------------------
   ما كان: زر يقول عن نفسه إنه تجريبي
   ------------------------------------------------------------
   في الصفحة الشخصية زر «تذكير التسجيل اليومي»، وتحته حين يُفعَّل:

     «ملاحظة: هذا تذكير محلي يعمل بس أثناء فتح الصفحة في هذا
      العرض التجريبي.»

   والحقيقة أدق من الملاحظة: الزر كان يقلب حالة React ولا شيء
   غير ذلك. وعمود users.reminders_on موجود في المخطط منذ اليوم
   الأول ولم يكن يصله من ذلك الزر شيء إطلاقاً — نفس نمط «جداول
   بلا كاتب».

   ------------------------------------------------------------
   ما تطلبه المرحلة، وما يقدر عليه النظام فعلاً
   ------------------------------------------------------------
   البند يقول صراحةً: «إذا لم توجد آلية قادرة فعلاً على تنفيذ
   التذكير، لا تزيّف الوظيفة… ولا تقل للمستخدم إن التذكير يعمل
   إذا كان النظام لا يستطيع إرساله».

   فاكتشفت أولاً ما هو موجود بدل أن أبني موازياً:

     ✅ Web Push كامل — notifications/push.js، ومفتاحا VAPID
        مضبوطان على Render، و/api/push/public-key يرد enabled:true،
        وجدول push_subscriptions، وملف push-sw.js في التطبيق.
     ✅ صندوق إشعارات داخل التطبيق — user_notifications، وله
        دالة notifyUser جاهزة **بلا مستدعٍ واحد** حتى هذه اللحظة.
        هذا أول مستدعٍ لها في تاريخ المشروع.
     ✅ محفّز دوري — sweepMiddleware يمرّ مع حركة الطلبات.
     ❌ لا Cron ولا Queue ولا Background Worker.

   فالمبني هنا يستعمل الثلاثة الموجودة ولا ينشئ رابعاً.

   ------------------------------------------------------------
   ⚠️ الحدّ الصادق — يُقال هنا ويُقال في الواجهة
   ------------------------------------------------------------
   المسح يمرّ **مع حركة الطلبات لا بمؤقّت**. فلو لم يصل الخادم أي
   طلب من أي مستخدم لساعات، لا يخرج تذكير في وقته بالضبط. وهذا
   مقبول عملياً (التطبيق يزامن بياناته باستمرار أثناء الاستخدام)
   وغير مقبول أن يُوصف بغير حقيقته.

   والترقية خطوة واحدة بلا تغيير سطر هنا: Render Cron Job ينادي
   مسار المسح بـSETUP_TOKEN كل ربع ساعة. نفس الدالة، محفّز آخر.

   وحدّ ثانٍ أصدق: **وصول إشعار Push إلى جهاز حقيقي لم يُتحقَّق
   منه بعد على الإنتاج** — بند مفتوح منذ المرحلة 4. ولذلك صندوق
   الإشعارات داخل التطبيق هو قناة التسليم الأولى هنا، والـPush
   إضافة فوقه لا بديل عنه. لو فشل الـPush يبقى التذكير موجوداً
   يراه المستخدم عند فتح التطبيق، ولا يُسجَّل نجاح لم يقع.

   ------------------------------------------------------------
   لا معاملة في هذا الملف إطلاقاً — وهذا مقصود
   ------------------------------------------------------------
   كل عبارة هنا مستقلة، والمعالجة لكل مستخدم على حدة داخل
   try/catch. والسبب أن القاعدة المطلقة في هذا المشروع تمنع التقاط
   خطأ قاعدة بيانات **داخل** معاملة والمتابعة (الدرس الذي كلّف
   المشروع أول دفعة حقيقية). ومن يريد أن يتابع بعد فشل مستخدم
   واحد لا يفتح معاملة أصلاً.

   ونداء المزوّد (Web Push) خارج أي معاملة كذلك — نفس الشكل
   المطبَّق على الاسترداد في المرحلة 3.
   ============================================================ */

/* حد الدفعة الواحدة. المسح يمرّ مراراً، فما يُترك يُلتقط في
   المسحة التالية — والمهم أن يُسجَّل أنه تُرك بدل أن يبتلع بصمت. */
const REMINDER_BATCH_LIMIT = 200;

/* نافذة الإرسال: ثلاث ساعات من الوقت المختار.

   بدونها كان يمكن أن يصل تذكير الساعة الثامنة مساءً عند الثالثة
   فجراً لو لم تمرّ على الخادم حركة بينهما. والتذكير الذي يوقظ
   صاحبه ليسجّل مزاجه يفسد ما جاء لأجله.

   ومن فاتته النافذة لا يُرسَل له شيء ذلك اليوم — لا تُؤجَّل إلى
   الغد ولا تُجمَع. */
const REMINDER_WINDOW_SECONDS = 3 * 60 * 60;

const REMINDER_TITLE = "وقت تسجيل يومك";
const REMINDER_BODY = "دقيقة وحدة بس: سجّل مزاجك ونومك وطاقتك، وخلّ بوصلتك تقرأ أسبوعك صح.";

/**
 * من يستحق تذكيراً الآن؟
 *
 * الشروط كلها في استعلام واحد بدل ترشيح في جافاسكربت: القاعدة
 * تعرف الوقت المحلي لكل مستخدم، وسحب كل المفعّلين إلى الذاكرة
 * لترشيحهم كان يكبر مع عدد المستخدمين بلا سبب.
 *
 * ⚠️ AT TIME ZONE ترمي على اسم منطقة غير معروف. ولذلك تُطابَق
 * المنطقة على ما يعرفه المحرّك قبل الكتابة في PATCH
 * /api/me/preferences، ويحرس شكلَها قيدٌ في الترحيل 010. ولو
 * استقرت قيمة فاسدة رغم ذلك، فهذا الاستعلام **خارج أي معاملة**،
 * فيفشل المسح وحده ويُسجَّل، ولا يُفسد شيئاً آخر.
 */
async function findDueUsers(limit) {
  const { rows } = await query(
    `SELECT u.id AS user_id,
            p.timezone,
            to_char(p.local_time, 'HH24:MI')                    AS local_time,
            ((now() AT TIME ZONE p.timezone)::date)             AS local_date
       FROM users u
       JOIN user_reminder_prefs p ON p.user_id = u.id
       LEFT JOIN user_auth_state s ON s.user_id = u.id
      WHERE u.reminders_on = true
        AND u.deleted_at IS NULL
        -- حساب لم يُفعَّل بريده لم يبدأ استخدام التطبيق أصلاً.
        AND u.email_verified_at IS NOT NULL
        -- حساب معلَّق لا تصله رسائل خدمة.
        AND s.suspended_at IS NULL

        /* مرساة عدم التكرار الأولى: تاريخ اليوم **المحلي** للمستخدم.
           IS DISTINCT FROM لا <> — المقارنة مع NULL بـ<> تعطي NULL
           فيسقط الشرط، أي أن أول تذكير لكل مستخدم كان لن يُرسل. */
        AND p.last_sent_on IS DISTINCT FROM ((now() AT TIME ZONE p.timezone)::date)

        /* داخل النافذة: من الوقت المختار وحتى ثلاث ساعات بعده.
           الحساب بالثواني مع باقي القسمة على اليوم كاملاً حتى
           يعمل عبر منتصف الليل — من اختار 23:00 يُذكَّر 00:30
           بلا أن يُعامَل كأن الفارق سالب ثلاث وعشرون ساعة. */
        AND (
              (EXTRACT(EPOCH FROM ((now() AT TIME ZONE p.timezone)::time - p.local_time))::bigint + 86400)
              % 86400
            ) <= $1

        /* ومن سجّل يومه فعلاً لا يُذكَّر به. التذكير أداة لا
           إشعار دوري، وإرساله لمن أنجزه يجعله ضجيجاً يُطفأ. */
        AND NOT EXISTS (
              SELECT 1 FROM daily_logs dl
               WHERE dl.user_id = u.id
                 AND dl.logged_on = ((now() AT TIME ZONE p.timezone)::date)
            )
      ORDER BY p.last_sent_on NULLS FIRST, u.id
      LIMIT $2`,
    [REMINDER_WINDOW_SECONDS, limit]
  );
  return rows;
}

/**
 * يرسل تذكير مستخدم واحد ويعلّم يومه.
 *
 * الترتيب مقصود: صندوق الإشعارات أولاً (وهو التسليم المضمون)،
 * ثم تعليم اليوم، ثم Push (وهو الإضافة غير المضمونة).
 *
 * ولو مات الخادم بين الأول والثاني، يمنع القيد الفريد
 * UNIQUE (user_id, dedup_key) صفاً مكرراً في المسحة التالية —
 * مرساة عدم التكرار الثانية.
 */
async function remindOne(row) {
  const dedupKey = `daily_checkin:${row.local_date instanceof Date
    ? row.local_date.toISOString().slice(0, 10)
    : String(row.local_date).slice(0, 10)}`;

  const created = await notifyUser(row.user_id, {
    title: REMINDER_TITLE,
    body: REMINDER_BODY,
    kind: "info",
    source: "system",
    dedupKey,
  });

  // علّم اليوم في كل الأحوال: لو كان الصف موجوداً مسبقاً فالتذكير
  // خرج فعلاً في مسحة سابقة، وترك last_sent_on فارغاً كان سيجعل
  // كل مسحة تعيد المحاولة بلا نهاية.
  await query(
    `UPDATE user_reminder_prefs SET last_sent_on = $2::date, updated_at = now() WHERE user_id = $1`,
    [row.user_id, dedupKey.slice("daily_checkin:".length)]
  );

  if (!created) return { userId: row.user_id, status: "already_sent" };

  /* Push إضافة فوق الصندوق لا بديل عنه. فشله ليس فشل التذكير،
     ولا يُسجَّل نجاحاً كذلك — ما يُعاد هنا هو ما وقع بالضبط.

     وهذا هو الفرق الذي أُصلح في المرحلة 4 بين sent و delivered:
     قبول القناة ليس وصولاً، وتسميته وصولاً هي الكذبة نفسها. */
  if (!isPushConfigured()) {
    return { userId: row.user_id, status: "inbox_only", pushReason: "push_not_configured" };
  }
  const push = await sendPushToUser(row.user_id, {
    title: REMINDER_TITLE,
    body: REMINDER_BODY,
    url: "/",
  });
  return push.ok
    ? { userId: row.user_id, status: "inbox_and_push", pushed: push.sent }
    : { userId: row.user_id, status: "inbox_only", pushReason: push.errorCode };
}

/**
 * مسح التذكيرات المستحقّة.
 *
 * آمن للاستدعاء المتزامن: قفل استشاري واحد يجعل النداء الثاني
 * ينسحب فوراً بدل أن ينتظر — نفس نمط sweepDueCampaigns، وبمفتاح
 * مختلف حتى لا يحجب أحدهما الآخر.
 */
export async function sweepDailyReminders({ log = () => {} } = {}) {
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query(
      `SELECT pg_try_advisory_lock(hashtext('kanaf_daily_reminder_sweep')) AS locked`
    );
    locked = rows[0].locked;
    if (!locked) return { skipped: true, reason: "reminder_sweep_already_running" };

    const due = await findDueUsers(REMINDER_BATCH_LIMIT);
    if (due.length === 0) return { swept: 0, inboxAndPush: 0, inboxOnly: 0, alreadySent: 0, failed: 0 };

    let inboxAndPush = 0, inboxOnly = 0, alreadySent = 0, failed = 0;

    for (const row of due) {
      try {
        const r = await remindOne(row);
        if (r.status === "inbox_and_push") inboxAndPush++;
        else if (r.status === "inbox_only") inboxOnly++;
        else alreadySent++;
      } catch (err) {
        /* فشل مستخدم واحد لا يوقف البقية. ولا معاملة مفتوحة هنا
           فلا شيء يُفسد بالتقاط الخطأ — وهذا هو سبب غياب المعاملة
           من هذا الملف كله. */
        failed++;
        console.error(`[reminders] فشل تذكير مستخدم:`, err?.message || err);
      }
    }

    if (due.length === REMINDER_BATCH_LIMIT) {
      log(`[reminders] بلغت الدفعة حدّها (${REMINDER_BATCH_LIMIT}). الباقي يُنفَّذ في المسح التالي.`);
    }
    if (inboxAndPush || inboxOnly || failed) {
      log(`[reminders] تذكير يومي — صندوق+Push: ${inboxAndPush} · صندوق فقط: ${inboxOnly} · متكرر: ${alreadySent} · فشل: ${failed}`);
    }

    return { swept: due.length, inboxAndPush, inboxOnly, alreadySent, failed, batchCapped: due.length === REMINDER_BATCH_LIMIT };
  } finally {
    if (locked) {
      await client.query(`SELECT pg_advisory_unlock(hashtext('kanaf_daily_reminder_sweep'))`).catch(() => {});
    }
    client.release();
  }
}
