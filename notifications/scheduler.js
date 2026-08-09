import { query, pool } from "../db/pool.js";
import { dispatchCampaign } from "./service.js";

/* ============================================================
   الجدولة — بلا Cron ولا Queue ولا Background Job.

   ------------------------------------------------------------
   ماذا اكتُشف أولاً (البند 7 يطلب الاكتشاف قبل البناء)
   ------------------------------------------------------------
   لا جدولة في المنتج ولا في الكود: البث الجماعي يرسل فوراً عند
   الضغط، وتذكيرات التطبيق (قرب انتهاء التجربة) تُحسب في المتصفح
   عند فتح التطبيق — أي أنها ليست جدولة، بل عرض شرطي.

   الجدولة أُضيفت هنا لأن المرحلة تطلبها للإشعارات الإدارية، وبُنيت
   بأخف شكل ممكن يبقى صادقاً.

   ------------------------------------------------------------
   الآلية: مسح المستحقّ عند مرور الطلبات
   ------------------------------------------------------------
   وسيطة خفيفة تعمل مع حركة المرور الطبيعية للخادم، بخنق زمني
   (افتراضياً 60 ثانية)، ولا تُبطئ أي طلب لأنها لا تُنتظر.

   لماذا يكفي عملياً: تطبيق المستخدم يستدعي /api/notifications
   بانتظام أثناء الاستخدام، فالخادم لا يبقى بلا حركة طويلاً.

   ⚠️ الحد الصادق: لو لم يصل الخادم أي طلب إطلاقاً، لا يُرسل شيء
   في وقته. الحملة تبقى 'scheduled' ويظهر تأخرها في اللوحة —
   **ولا تُعلَّم "أُرسلت" أبداً**. هذا هو المهم: التأخر ظاهر،
   والكذب مستحيل.

   إن احتاج المنتج دقة توقيت لاحقاً، أبسط ترقية هي Render Cron Job
   ينادي POST /admin/notifications/sweep بـSETUP_TOKEN. الكود هنا
   لا يتغيّر — نفس الدالة، محفّز آخر.

   ------------------------------------------------------------
   المنطقة الزمنية
   ------------------------------------------------------------
   scheduled_at من نوع TIMESTAMPTZ، أي لحظة مطلقة على خط الزمن.
   الواجهة ترسل ISO 8601 بإزاحة صريحة (+03:00 للرياض)، والمقارنة
   تتم بـnow() في UTC. لا تُخزَّن أوقات محلية بلا إزاحة إطلاقاً —
   خادم Render يعمل بـUTC وجهاز المسؤول بتوقيت الرياض، وتخزين
   "09:00" بلا إزاحة كان سيرسل الساعة 12 ظهراً.
   ============================================================ */

const SWEEP_MIN_INTERVAL_MS = Number(process.env.SWEEP_MIN_INTERVAL_MS || 60_000);
let lastSweepAt = 0;
let sweepInFlight = false;

/**
 * ينفّذ كل حملة حان وقتها. آمن للاستدعاء المتزامن: قفل استشاري
 * واحد يجعل النداء الثاني ينسحب فوراً بدل الانتظار.
 */
export async function sweepDueCampaigns({ log = () => {} } = {}) {
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query(
      `SELECT pg_try_advisory_lock(hashtext('kanaf_notification_sweep')) AS locked`
    );
    locked = rows[0].locked;
    if (!locked) return { skipped: true, reason: "sweep_already_running" };

    const { rows: due } = await query(
      `SELECT id, title, scheduled_at FROM notification_campaigns
       WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= now()
       ORDER BY scheduled_at
       LIMIT 20`
    );

    const results = [];
    for (const c of due) {
      try {
        const r = await dispatchCampaign(c.id, { trigger: "scheduler" });
        results.push({ id: c.id, title: c.title, ...r });
        log(`[scheduler] أُرسلت الحملة المجدولة "${c.title}" — ${JSON.stringify(r)}`);
      } catch (err) {
        // خطأ حملة واحدة لا يوقف البقية. الحملة تبقى في حالتها
        // ويظهر خطؤها في last_error، فتُعاد المحاولة في المسح التالي.
        results.push({ id: c.id, title: c.title, error: String(err.message || err) });
        console.error(`[scheduler] فشلت الحملة ${c.id}:`, err);
      }
    }

    // حد أعلى للدفعة (20) — سجّل ما تُرك بدل ابتلاعه بصمت.
    if (due.length === 20) {
      log(`[scheduler] بلغت الدفعة حدّها (20 حملة). الباقي يُنفَّذ في المسح التالي.`);
    }

    return { swept: results.length, results, batchCapped: due.length === 20 };
  } finally {
    let unlockFailed = false;
    if (locked) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext('kanaf_notification_sweep'))`);
      } catch (err) {
        // كان await الإطلاق قبل client.release() في نفس finally، فلو
        // رمى (انقطاع اتصال أثناء مسح طويل) لا يُنفَّذ release أبداً
        // ويتسرّب عميل من مجمّع بعشرة. عشر مرات = تجمّد كامل، لأن
        // pool.connect بلا connectionTimeoutMillis ينتظر بلا نهاية.
        unlockFailed = true;
        console.error("[scheduler] تعذّر إطلاق قفل المسح — سيُتلف الاتصال:", err.message);
      }
    }
    client.release(unlockFailed);
  }
}

/**
 * وسيطة Express: تُطلق المسح على هامش الطلبات ولا تنتظره.
 *
 * next() يُنادى فوراً وقبل أي عمل — طلب المستخدم لا يدفع ثمن
 * الجدولة، ولا يفشل لو فشل المسح.
 */
export function sweepMiddleware(req, res, next) {
  next();

  const now = Date.now();
  if (sweepInFlight || now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = now;
  sweepInFlight = true;

  sweepDueCampaigns()
    .catch((err) => console.error("[scheduler] فشل المسح:", err))
    .finally(() => { sweepInFlight = false; });
}

/**
 * حالة الجدولة للوحة — يجيب على "هل هناك مجدول متأخر؟" بلا تخمين.
 * overdue_minutes هو الفرق الحقيقي بين الوقت المحدد والآن.
 */
export async function schedulerStatus() {
  const { rows } = await query(
    `SELECT id, title, scheduled_at, status,
            GREATEST(0, EXTRACT(EPOCH FROM (now() - scheduled_at)) / 60)::int AS overdue_minutes
     FROM notification_campaigns
     WHERE status = 'scheduled'
     ORDER BY scheduled_at
     LIMIT 50`
  );
  return {
    pending: rows,
    overdue: rows.filter((r) => r.overdue_minutes > 0).length,
    lastSweepAt: lastSweepAt ? new Date(lastSweepAt).toISOString() : null,
    minIntervalMs: SWEEP_MIN_INTERVAL_MS,
  };
}
