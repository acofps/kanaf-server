import { query } from "../db/pool.js";

/* ============================================================
   دورة حياة الاشتراك — التعريف الواحد للحالة الفعلية

   لماذا الحالة مشتقّة لا مخزّنة:

   عمود subscriptions.status محكوم بقيد CHECK يسمح بأربع قيم فقط
   ('trialing','active','past_due','canceled')، وتوسيعه يتطلب
   ALTER TABLE — ممنوع بقيد ملكية الجداول (انظر رأس الترحيل 004).
   فلا يمكن تخزين 'expired' أصلاً.

   وهذا في الحقيقة أفضل، لا مجرد التفاف على قيد: انتهاء الاشتراك
   ليس حدثاً يحتاج من يوقظه في منتصف الليل، بل نتيجة مقارنة تاريخ.
   لو خُزّنت الحالة لاحتاجت وظيفة دورية تحدّثها، والمشروع بلا Cron
   ولا Queue — ومعنى ذلك أن اشتراكاً منتهياً كان سيبقى معروضاً
   "فعّالاً" إلى أن يمرّ حدث دفع أو تدخّل إداري. هذه بالضبط الفجوة
   الموثّقة في القسم 12.9 من وثيقة حالة المشروع.

   نفس النمط المعتمد في المرحلة 2 لحالة الحساب (ACCOUNT_STATUS_SQL).
   ============================================================ */

/**
 * الحالة الفعلية للاشتراك، معرّفة مرة واحدة ومستخدمة في كل استعلام.
 * `s` هو اسم الجدول subscriptions و`ss` هو subscription_state.
 *
 * ترتيب الفروع مقصود: الإلغاء الصريح يسبق كل شيء، وانتهاء المدة
 * يسبق past_due — لأن اشتراكاً متعثّر السداد وانتهت مدته هو منتهٍ،
 * لا متعثّر.
 */
export function effectiveStatusSql(s = "s", ss = "ss") {
  return `CASE
    WHEN ${s}.status = 'canceled'                                              THEN 'canceled'
    WHEN ${s}.current_period_end IS NOT NULL
     AND ${s}.current_period_end <= now()                                      THEN 'expired'
    WHEN ${s}.status = 'past_due'                                              THEN 'past_due'
    WHEN ${s}.status = 'trialing'                                              THEN 'trialing'
    WHEN COALESCE(${ss}.cancel_at_period_end, false) = true                    THEN 'canceling'
    ELSE 'active'
  END`;
}

/**
 * شرط الاستحقاق: هل يملك هذا الصف وصولاً مدفوعاً الآن؟
 *
 * ملاحظة على past_due: يبقى مستحقاً ما دامت الفترة المدفوعة لم
 * تنتهِ. هذا ليس تساهلاً — المستخدم دفع مقابل هذه الفترة فعلاً،
 * وفشل دفعة التجديد لا يلغي ما سبق أن دُفع. وحين تنتهي الفترة يسقط
 * الاستحقاق تلقائياً بنفس الشرط.
 *
 * و'canceling' (إلغاء بنهاية المدة) مستحق أيضاً حتى تنتهي المدة —
 * وهذا معنى الإلغاء بنهاية المدة بالضبط.
 */
export function entitledSql(s = "s") {
  return `(${s}.status IN ('active', 'trialing', 'past_due')
           AND ${s}.current_period_end IS NOT NULL
           AND ${s}.current_period_end > now())`;
}

/**
 * أحدث اشتراك لكل مستخدم في تمريرة واحدة.
 *
 * DISTINCT ON بدل LATERAL ... LIMIT 1 للسبب نفسه الموثّق في
 * admin/routes.js: بيئة الاختبار لا تدعم LATERAL، وشحن استعلام لا
 * يختبره أحد أسوأ من الفرق. عتبة المراجعة ~100 ألف اشتراك.
 */
export const LATEST_SUBSCRIPTION_JOIN = `
  LEFT JOIN (
    SELECT DISTINCT ON (user_id)
           id, user_id, plan_id, status, started_at, current_period_end,
           canceled_at, payment_provider, created_at
    FROM subscriptions
    ORDER BY user_id, created_at DESC
  ) s ON s.user_id = u.id
  LEFT JOIN subscription_state ss ON ss.subscription_id = s.id`;

/** دورة الفوترة مشتقّة من مدة الباقة، لا من اسمها. */
export function deriveBillingCycle(durationDays) {
  const d = Number(durationDays);
  if (!Number.isFinite(d) || d <= 0) return null;
  if (d <= 31) return "monthly";
  if (d <= 186) return "semiannual";
  if (d <= 366) return "annual";
  return "custom";
}

/**
 * تفعيل اشتراك أو تمديده بعد دفعة ناجحة مؤكَّدة.
 *
 * يُستدعى **حصراً** من داخل معالج الـwebhook وداخل معاملة واحدة مع
 * تحديث الفاتورة والدفعة. لا يُستدعى أبداً من مسار واجهة أو من
 * صفحة نجاح إعادة التوجيه — إعادة التوجيه دليل على أن المتصفح رجع،
 * لا على أن المال وصل.
 *
 * قاعدة التمديد: الأساس هو الأبعد بين "الآن" و"نهاية الفترة
 * الحالية"، فمن جدّد مبكراً لا يخسر ما تبقّى له من مدة مدفوعة.
 *
 * الترقية والتخفيض (upgrade/downgrade): شراء باقة مختلفة أثناء
 * سريان اشتراك يبدّل الباقة فوراً ويمدّد المدة بمدة الباقة الجديدة.
 * **لا توجد تسوية تناسبية (proration)** — لا في الكود ولا لدى
 * المزوّد بهذا التكامل، وابتكارها هنا قرار تجاري لا هندسي. موثّق
 * صراحةً بدل أن يُفترض.
 */
export async function activateOrExtendSubscription(client, {
  userId, planKey, planName, durationDays, priceSar, currency = "SAR",
  invoiceId, paymentId, provider = "moyasar",
}) {
  // قفل الصف قبل القراءة: دفعتان متزامنتان لنفس المستخدم (نقرة
  // مزدوجة على زر الدفع، أو webhook يصل مرتين من مسارين) كانتا
  // ستقرآن نفس نهاية الفترة وتمدّدان منها كلتاهما.
  const { rows: existingRows } = await client.query(
    `SELECT id, status, plan_id, started_at, current_period_end
     FROM subscriptions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`,
    [userId]
  );
  const existing = existingRows[0];

  const now = new Date();
  const stillEntitled =
    existing &&
    existing.status !== "canceled" &&
    existing.current_period_end &&
    new Date(existing.current_period_end) > now;

  const periodStart = stillEntitled ? new Date(existing.current_period_end) : now;
  const periodEnd = new Date(periodStart.getTime() + Number(durationDays) * 86400000);

  let subscriptionId;
  let previous = null;

  if (existing && existing.status !== "canceled") {
    previous = { status: existing.status, plan_id: existing.plan_id, current_period_end: existing.current_period_end };
    const { rows } = await client.query(
      `UPDATE subscriptions
       SET plan_id = $1, status = 'active', current_period_end = $2,
           canceled_at = NULL, payment_provider = $3, updated_at = now()
       WHERE id = $4
       RETURNING id`,
      [planKey, periodEnd.toISOString(), provider, existing.id]
    );
    subscriptionId = rows[0].id;
  } else {
    // اشتراك ملغى سابقاً لا يُعاد إحياؤه في مكانه: صف جديد يحفظ
    // تاريخ الإلغاء السابق كما هو بدل أن يمحوه — التقارير المالية
    // تحتاج أن ترى أن هذا المستخدم ألغى ثم عاد.
    const { rows } = await client.query(
      `INSERT INTO subscriptions (user_id, plan_id, status, started_at, current_period_end, payment_provider)
       VALUES ($1, $2, 'active', $3, $4, $5)
       RETURNING id`,
      [userId, planKey, now.toISOString(), periodEnd.toISOString(), provider]
    );
    subscriptionId = rows[0].id;
  }

  await client.query(
    `INSERT INTO subscription_state
       (subscription_id, user_id, billing_cycle, billing_period_days, plan_price_sar, currency,
        current_period_start, cancel_at_period_end, cancel_requested_at, cancel_reason,
        provider, last_invoice_id, last_payment_id, renewal_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, NULL, NULL, $8, $9, $10, 'manual')
     ON CONFLICT (subscription_id) DO UPDATE SET
       billing_cycle        = EXCLUDED.billing_cycle,
       billing_period_days  = EXCLUDED.billing_period_days,
       plan_price_sar       = EXCLUDED.plan_price_sar,
       currency             = EXCLUDED.currency,
       current_period_start = EXCLUDED.current_period_start,
       -- دفعة جديدة ناجحة تُلغي طلب "الإلغاء بنهاية المدة": من دفع
       -- للتجديد فقد تراجع عن الإلغاء بفعله لا بنيّته.
       cancel_at_period_end = false,
       cancel_requested_at  = NULL,
       cancel_reason        = NULL,
       provider             = EXCLUDED.provider,
       last_invoice_id      = EXCLUDED.last_invoice_id,
       last_payment_id      = EXCLUDED.last_payment_id,
       updated_at           = now()`,
    [
      subscriptionId, userId, deriveBillingCycle(durationDays), durationDays,
      priceSar, currency, periodStart.toISOString(), provider, invoiceId, paymentId,
    ]
  );

  // ربط الفاتورة باشتراكها — العمود موجود في المخطط الأصلي ولم يكن
  // يُكتب فيه شيء، ولهذا كانت كل فاتورة يتيمة من جهة الاشتراك.
  if (invoiceId) {
    await client.query(`UPDATE invoices SET subscription_id = $1, updated_at = now() WHERE id = $2`, [subscriptionId, invoiceId]);
    await client.query(`UPDATE payments SET subscription_id = $1, updated_at = now() WHERE invoice_id = $2`, [subscriptionId, invoiceId]);
  }

  return {
    subscriptionId,
    previous,
    periodStart,
    periodEnd,
    isRenewal: Boolean(stillEntitled),
    planName,
  };
}

/**
 * تعليم الاشتراك متعثّر السداد بعد فشل دفعة تجديد.
 *
 * شرط مهم: يُطبَّق فقط على اشتراك ما زال ضمن فترته المدفوعة. فشل
 * أول دفعة لمستخدم لا اشتراك له لا ينشئ اشتراكاً متعثّراً — وهذا
 * ما يمنع "اشتراك بلا أساس مالي صحيح" الذي يحذّر منه بند تكامل
 * البيانات.
 */
export async function markPastDueIfEntitled(client, userId) {
  const { rows } = await client.query(
    `UPDATE subscriptions
     SET status = 'past_due', updated_at = now()
     WHERE id = (
       SELECT id FROM subscriptions
       WHERE user_id = $1 AND status = 'active'
         AND current_period_end IS NOT NULL AND current_period_end > now()
       ORDER BY created_at DESC LIMIT 1
     )
     RETURNING id`,
    [userId]
  );
  return rows[0]?.id || null;
}

/** الاشتراك الحالي لمستخدم واحد، بحالته الفعلية وبيانات باقته. */
export async function getUserSubscription(userId, client) {
  const runner = client || { query };
  const { rows } = await runner.query(
    `SELECT s.id, s.plan_id, s.status AS stored_status, s.started_at,
            s.current_period_end, s.canceled_at, s.payment_provider,
            ss.billing_cycle, ss.billing_period_days, ss.plan_price_sar, ss.currency,
            ss.current_period_start, ss.cancel_at_period_end, ss.cancel_requested_at,
            ss.renewal_mode, ss.last_invoice_id, ss.last_payment_id,
            sp.name AS plan_name, sp.price_sar AS plan_current_price, sp.features,
            ${effectiveStatusSql("s", "ss")} AS status,
            ${entitledSql("s")} AS entitled
     FROM subscriptions s
     LEFT JOIN subscription_state ss ON ss.subscription_id = s.id
     LEFT JOIN subscription_plans sp ON sp.plan_key = s.plan_id
     WHERE s.user_id = $1
     ORDER BY s.created_at DESC
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}
