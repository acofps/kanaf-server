import webpush from "web-push";
import { query } from "../db/pool.js";

/* ============================================================
   Web Push — إشعار يصل الجهاز والتطبيق مغلق.

   ------------------------------------------------------------
   لماذا Web Push ولا مزوّد إشعارات
   ------------------------------------------------------------
   التطبيق PWA بـService Worker مسجَّل أصلاً (vite-plugin-pwa).
   Web Push معيار في المتصفح: الخادم يوقّع الرسالة بمفتاح VAPID
   ويسلّمها إلى endpoint يملكه متصفح المستخدم مباشرة. لا مزوّد
   ولا اشتراك شهري ولا SDK ولا بنية جديدة — مكتبة توقيع واحدة.

   البديل (Firebase Cloud Messaging وأمثاله) كان سيضيف تبعية
   خارجية وحساباً وأسراراً جديدة مقابل نفس النتيجة على الويب.

   ------------------------------------------------------------
   المفتاحان
   ------------------------------------------------------------
   VAPID_PUBLIC_KEY  — يُرسل للمتصفح، ليس سراً.
   VAPID_PRIVATE_KEY — سر. على Render فقط.
   VAPID_SUBJECT     — mailto: أو https:// لصاحب الخدمة (يطلبه المعيار).

   للتوليد مرة واحدة:
     node -e "console.log(require('web-push').generateVAPIDKeys())"

   بلا مفتاحين لا تُرسل هذه الوحدة شيئاً، ولا تدّعي أنها أرسلت:
   isPushConfigured() تُفحص عند إنشاء الحملة فتُرفض قناة push
   برسالة صريحة، بدل أن تُقبل الحملة ثم تفشل بصمت. هذا الدرس جاء
   من عطب البث القديم الذي كان يعيد { id: "dev-mock" } ويُحسب نجاحاً.
   ============================================================ */

let configured = null;

export function isPushConfigured() {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || `mailto:${process.env.EMAIL_FROM || "support@kanaf.me"}`,
    pub,
    priv
  );
  configured = true;
  return true;
}

export function getPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

/**
 * تسجيل اشتراك جهاز. المفتاح الفريد هو endpoint نفسه، فإعادة
 * التسجيل من نفس المتصفح تحدّث الصف بدل أن تنشئ ثانياً — وإلا
 * وصل المستخدم إشعاران عن كل حدث بعد كل إعادة تحميل.
 *
 * disabled_at = NULL في التحديث: إعادة منح الإذن بعد تعطيل تلقائي
 * تعيد تفعيل الاشتراك.
 */
export async function saveSubscription(userId, subscription, userAgent = null) {
  const { endpoint, keys } = subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw Object.assign(new Error("invalid_subscription"), { status: 400 });
  }
  /* ⚠️ الشرط الأخير يمنع الاستيلاء على اشتراك جهاز.

     بدونه: `DO UPDATE SET user_id = EXCLUDED.user_id` يعني أن أي
     مستخدم يرسل endpoint يخص جهاز مستخدم آخر يستولي على الصف —
     فتتوقف إشعارات الأول، **وتصل إشعارات الثاني إلى جهاز الأول**.
     أثبتته المراجعة عملياً بحسابين.

     الآن التحديث مشروط بأن الصف يخص صاحبه. لو كان لمستخدم آخر،
     لا يُحدَّث شيء، ونحذف الصف اليتيم ثم نعيد الإدراج: المتصفح
     يعطي endpoint جديداً عند كل تثبيت، فالتصادم الحقيقي الوحيد
     هو جهاز انتقل بين حسابين. */
  const { rowCount } = await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent, failure_count = 0, disabled_at = NULL
     WHERE push_subscriptions.user_id = EXCLUDED.user_id`,
    [userId, endpoint, keys.p256dh, keys.auth, userAgent]
  );

  if (rowCount === 0) {
    await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (endpoint) DO NOTHING`,
      [userId, endpoint, keys.p256dh, keys.auth, userAgent]
    );
  }
}

export async function removeSubscription(userId, endpoint) {
  await query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
}

/**
 * إرسال إلى كل أجهزة مستخدم واحد.
 *
 * القيمة المعادة تصف الواقع لا النية: أُرسل إلى كم جهاز، وفشل كم،
 * وما رمز الخطأ الأول. مسجّل التسليم يكتبها كما هي.
 *
 * 404 و410 من endpoint تعني أن الاشتراك مات نهائياً (أُزيل التطبيق
 * أو سُحب الإذن). يُعطَّل فوراً — إعادة المحاولة عليه إلى الأبد
 * تُراكم فشلاً كاذباً في التقارير وتستهلك وقت الطلب.
 */
export async function sendPushToUser(userId, { title, body, url = "/" }) {
  if (!isPushConfigured()) {
    return { ok: false, sent: 0, failed: 0, errorCode: "push_not_configured", errorDetail: "VAPID keys are not set" };
  }

  const { rows: subs } = await query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions
     WHERE user_id = $1 AND disabled_at IS NULL`,
    [userId]
  );
  if (subs.length === 0) {
    return { ok: false, sent: 0, failed: 0, errorCode: "no_push_subscription", errorDetail: "المستخدم ما فعّل الإشعارات على أي جهاز" };
  }

  const payload = JSON.stringify({ title, body, url });
  let sent = 0, failed = 0, errorCode = null, errorDetail = null;

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 * 24 }
      );
      sent++;
      await query(`UPDATE push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = $1`, [s.id]);
    } catch (err) {
      failed++;
      const status = err?.statusCode || 0;
      errorCode = errorCode || `push_${status || "error"}`;
      errorDetail = errorDetail || String(err?.body || err?.message || err).slice(0, 500);

      if (status === 404 || status === 410) {
        await query(`UPDATE push_subscriptions SET disabled_at = now() WHERE id = $1`, [s.id]);
      } else {
        await query(`UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1`, [s.id]);
      }
    }
  }

  return { ok: sent > 0, sent, failed, errorCode: sent > 0 ? null : errorCode, errorDetail: sent > 0 ? null : errorDetail };
}
