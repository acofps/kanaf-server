import express from "express";
import { query, withTransaction } from "../db/pool.js";
import { createInvoice } from "./moyasar.js";
import { handleMoyasarWebhook } from "./webhook.js";
import { getBillingSettings } from "../billing/config.js";
import { getUserSubscription, effectiveStatusSql } from "../billing/subscription.js";
import { requireUserAuth, requireVerifiedUser } from "../auth/middleware.js";

export const paymentsRouter = express.Router();

/**
 * أسعار الباقات ومددها ومزاياها تعيش في جدول subscription_plans
 * وتُدار من صفحة الباقات في اللوحة — لا كائن ثابت في الكود.
 */
async function getActivePlan(planKey) {
  const { rows } = await query(
    `SELECT plan_key, name, price_sar, duration_days, features
     FROM subscription_plans WHERE plan_key = $1 AND is_active = true`,
    [planKey]
  );
  return rows[0] || null;
}

const BASE_URL = process.env.APP_BASE_URL || "http://localhost:5173";

/* ============================================================
   الباقات — عام بلا مصادقة
   ============================================================ */

paymentsRouter.get("/plans", async (req, res) => {
  try {
    const settings = await getBillingSettings();
    const { rows } = await query(
      `SELECT plan_key, name, price_sar, duration_days, features
       FROM subscription_plans WHERE is_active = true ORDER BY display_order ASC`
    );
    // العملة والنسبة تُرجَعان مع الباقات حتى لا تضطر الواجهة لكتابة
    // "﷼" أو "شامل ضريبة 15%" في نصوصها — وهو بالضبط نوع القيمة
    // الثابتة التي تنحرف عن الخادم بصمت.
    res.json({
      plans: rows,
      currency: settings.currency,
      vatRate: settings.vatRate,
      pricesIncludeVat: settings.pricesIncludeVat,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   الدفع
   ============================================================ */

/**
 * POST /api/payments/create-invoice  { planId }
 *
 * الهوية تأتي من الرمز عبر requireVerifiedUser، لا من جسم الطلب.
 *
 * ما أُضيف في المرحلة 3: **إعادة استخدام الفاتورة المعلّقة**.
 * كل ضغطة على زر الدفع كانت تنشئ صفاً جديداً وفاتورة جديدة لدى
 * المزوّد. مستخدم متردّد يفتح الصفحة خمس مرات يترك خمس فواتير
 * معلّقة، وكلها روابط دفع صالحة في آن واحد. الأثر ليس تجميلياً:
 * لو دفع اثنتين منها لأي سبب، صار عندنا دفعتان صحيحتان لنفس
 * الاشتراك، ولا شيء في النظام يعتبر ذلك خطأ.
 */
paymentsRouter.post("/create-invoice", requireVerifiedUser, async (req, res) => {
  try {
    const { planId } = req.body || {};
    const userId = req.userId;
    const plan = await getActivePlan(planId);
    if (!plan) return res.status(400).json({ error: "valid_planId_required" });

    const settings = await getBillingSettings();

    // فاتورة معلّقة لنفس الباقة أُنشئت خلال آخر ساعتين ولها رابط دفع
    // صالح: تُعاد كما هي بدل إنشاء أخرى.
    const { rows: reusable } = await query(
      `SELECT id, checkout_url FROM invoices
       WHERE user_id = $1 AND plan_id = $2 AND status = 'pending'
         AND checkout_url IS NOT NULL
         AND amount_sar = $3
         AND created_at > now() - interval '2 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [userId, planId, plan.price_sar]
    );
    if (reusable[0]) {
      return res.status(200).json({
        invoiceId: reusable[0].id,
        checkoutUrl: reusable[0].checkout_url,
        reused: true,
      });
    }

    const invoiceId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO invoices (user_id, plan_id, amount_sar, status) VALUES ($1, $2, $3, 'pending') RETURNING id`,
        [userId, planId, plan.price_sar]
      );
      return rows[0].id;
    });

    const invoice = await createInvoice({
      amountSar: Number(plan.price_sar),
      currency: settings.currency,
      description: `اشتراك كنف+ — ${plan.name}`,
      callbackUrl: `${process.env.SERVER_BASE_URL || "http://localhost:3001"}/api/payments/webhook`,
      successUrl: `${BASE_URL}/subscription/success?invoice=${invoiceId}`,
      backUrl: `${BASE_URL}/subscription/canceled`,
      // شبكة أمان لمطابقة الحدث بفاتورتنا حتى لو غاب invoice_id عن
      // حمولة حدث ما — وقد حدث ذلك فعلاً مع أحداث الاسترداد.
      metadata: { kanaf_invoice_id: invoiceId, kanaf_user_id: userId, kanaf_plan: planId },
    });

    await query(
      `UPDATE invoices SET provider_invoice_id = $1, checkout_url = $2, updated_at = now() WHERE id = $3`,
      [invoice.id, invoice.url, invoiceId]
    );

    res.status(201).json({ invoiceId, checkoutUrl: invoice.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * GET /api/payments/status/:invoiceId
 *
 * صفحتا النجاح والإلغاء تستعلمان هذا لعرض الواجهة الصحيحة. **راحة
 * عرض فقط** — لا يمنح استحقاقاً ولا يفعّل شيئاً. التفعيل يحدث في
 * الـwebhook وحده، لأن رابط إعادة التوجيه يمكن فتحه يدوياً أو
 * إعادة تشغيله دون أن يُدفع ريال واحد.
 */
paymentsRouter.get("/status/:invoiceId", requireUserAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT i.id, i.status, i.amount_sar, i.zatca_invoice_number,
              (i.pdf_data IS NOT NULL) AS has_pdf
       FROM invoices i WHERE i.id = $1 AND i.user_id = $2`,
      [req.params.invoiceId, req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    const settings = await getBillingSettings();
    res.json({ ...rows[0], currency: settings.currency });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   الاشتراك — قسم «اشتراكي» في الملف الشخصي
   ============================================================ */

/** GET /api/payments/subscription — الاشتراك الحالي بحالته الفعلية. */
paymentsRouter.get("/subscription", requireUserAuth, async (req, res) => {
  try {
    const sub = await getUserSubscription(req.userId);
    const settings = await getBillingSettings();
    if (!sub) {
      return res.json({ subscription: null, entitled: false, currency: settings.currency });
    }
    res.json({
      subscription: {
        id: sub.id,
        planId: sub.plan_id,
        planName: sub.plan_name,
        status: sub.status,                     // مشتقّة: active | canceling | past_due | expired | canceled | trialing
        billingCycle: sub.billing_cycle,
        priceSar: sub.plan_price_sar,           // لقطة السعر وقت الشراء
        currentPriceSar: sub.plan_current_price, // السعر المعروض اليوم للتجديد
        currency: sub.currency || settings.currency,
        startedAt: sub.started_at,
        currentPeriodStart: sub.current_period_start,
        currentPeriodEnd: sub.current_period_end,
        renewalDate: sub.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        canceledAt: sub.canceled_at,
        renewalMode: sub.renewal_mode,          // 'manual' — لا خصم تلقائي، التجديد شراء يبدؤه المستخدم
        provider: sub.payment_provider,
        features: sub.features,
      },
      entitled: sub.entitled === true,
      currency: settings.currency,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /api/payments/subscription/cancel  { atPeriodEnd = true, reason }
 *
 * الافتراضي الإلغاء بنهاية المدة، لا الفوري. من دفع مقابل شهر
 * واستغنى في يومه العاشر لا يُنزع منه ما دفع ثمنه — والإلغاء الفوري
 * خيار صريح يطلبه لا سلوك افتراضي يُفاجأ به.
 *
 * ولا يُصرف أي مبلغ هنا إطلاقاً: الإلغاء إيقاف تجديد، والاسترداد
 * مسار مستقل يمر بالمزوّد ويصدر إشعاراً دائناً.
 */
paymentsRouter.post("/subscription/cancel", requireVerifiedUser, async (req, res) => {
  const atPeriodEnd = req.body?.atPeriodEnd !== false;
  const reason = String(req.body?.reason || "").trim().slice(0, 500) || null;

  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, status, current_period_end FROM subscriptions
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [req.userId]
      );
      const sub = rows[0];
      if (!sub) throw Object.assign(new Error("no_subscription"), { status: 404 });
      if (sub.status === "canceled") throw Object.assign(new Error("already_canceled"), { status: 409 });

      if (atPeriodEnd) {
        const { rows: stateRows } = await client.query(
          `INSERT INTO subscription_state (subscription_id, user_id, cancel_at_period_end, cancel_requested_at, cancel_reason)
           VALUES ($1, $2, true, now(), $3)
           ON CONFLICT (subscription_id) DO UPDATE
             SET cancel_at_period_end = true, cancel_requested_at = now(),
                 cancel_reason = EXCLUDED.cancel_reason, updated_at = now()
           RETURNING cancel_at_period_end`,
          [sub.id, req.userId, reason]
        );
        return {
          mode: "at_period_end",
          accessUntil: sub.current_period_end,
          cancelAtPeriodEnd: stateRows[0].cancel_at_period_end,
        };
      }

      await client.query(
        `UPDATE subscriptions SET status = 'canceled', canceled_at = now(), updated_at = now() WHERE id = $1`,
        [sub.id]
      );
      await client.query(
        `INSERT INTO subscription_state (subscription_id, user_id, cancel_at_period_end, cancel_requested_at, cancel_reason)
         VALUES ($1, $2, false, now(), $3)
         ON CONFLICT (subscription_id) DO UPDATE
           SET cancel_requested_at = now(), cancel_reason = EXCLUDED.cancel_reason, updated_at = now()`,
        [sub.id, req.userId, reason]
      );
      return { mode: "immediate", accessUntil: null, cancelAtPeriodEnd: false };
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /api/payments/subscription/reactivate
 * التراجع عن «الإلغاء بنهاية المدة» ما دامت المدة لم تنتهِ بعد.
 * بعد انتهائها لا يوجد ما يُعاد تفعيله — المسار عندها شراء جديد.
 */
paymentsRouter.post("/subscription/reactivate", requireVerifiedUser, async (req, res) => {
  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT s.id, s.status, s.current_period_end, ss.cancel_at_period_end
         FROM subscriptions s LEFT JOIN subscription_state ss ON ss.subscription_id = s.id
         WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 1 FOR UPDATE OF s`,
        [req.userId]
      );
      const sub = rows[0];
      if (!sub) throw Object.assign(new Error("no_subscription"), { status: 404 });
      if (sub.status === "canceled") throw Object.assign(new Error("subscription_already_ended"), { status: 409 });
      if (!sub.current_period_end || new Date(sub.current_period_end) <= new Date()) {
        throw Object.assign(new Error("period_already_ended"), { status: 409 });
      }
      if (!sub.cancel_at_period_end) throw Object.assign(new Error("not_scheduled_for_cancellation"), { status: 409 });

      await client.query(
        `UPDATE subscription_state
         SET cancel_at_period_end = false, cancel_requested_at = NULL, cancel_reason = NULL, updated_at = now()
         WHERE subscription_id = $1`,
        [sub.id]
      );
      return { renewalDate: sub.current_period_end };
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   الفواتير — قسم «فواتيري» في الملف الشخصي

   الفجوة التي يسدّها هذا القسم: الفاتورة الضريبية كانت تُولَّد
   وتُخزَّن كاملة، لكن مسار تحميلها الوحيد كان داخل لوحة الإدارة.
   العميل الذي دفع واستحقّ الفاتورة لم يكن يملك أي طريق لرؤيتها،
   وكان لازماً أن يراسل الدعم ليطلب مستنداً هو صاحبه.
   ============================================================ */

paymentsRouter.get("/invoices", requireUserAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 20));

    const { rows: countRows } = await query(
      `SELECT count(*)::int AS total FROM invoices WHERE user_id = $1 AND status IN ('paid', 'refunded')`,
      [req.userId]
    );

    const { rows } = await query(
      `SELECT i.id, i.zatca_invoice_number AS invoice_number, i.plan_id, i.amount_sar,
              i.subtotal_sar, i.vat_sar, i.status, i.zatca_issued_at, i.created_at,
              (i.pdf_data IS NOT NULL) AS has_pdf,
              COALESCE(st.currency, 'SAR') AS currency, st.vat_rate,
              sp.name AS plan_name
       FROM invoices i
       LEFT JOIN invoice_state st ON st.invoice_id = i.id
       LEFT JOIN subscription_plans sp ON sp.plan_key = i.plan_id
       WHERE i.user_id = $1 AND i.status IN ('paid', 'refunded')
       ORDER BY i.zatca_issued_at DESC NULLS LAST, i.created_at DESC, i.id DESC
       LIMIT $2 OFFSET $3`,
      [req.userId, pageSize, (page - 1) * pageSize]
    );

    const { rows: notes } = await query(
      `SELECT cn.id, cn.zatca_credit_note_number AS credit_note_number, cn.amount_sar,
              cn.reason, cn.zatca_issued_at, i.zatca_invoice_number AS original_invoice_number,
              (cn.pdf_data IS NOT NULL) AS has_pdf
       FROM credit_notes cn JOIN invoices i ON i.id = cn.original_invoice_id
       WHERE cn.user_id = $1 ORDER BY cn.zatca_issued_at DESC LIMIT 50`,
      [req.userId]
    );

    res.json({
      invoices: rows,
      creditNotes: notes,
      page,
      pageSize,
      total: countRows[0].total,
      totalPages: Math.max(1, Math.ceil(countRows[0].total / pageSize)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * GET /api/payments/invoices/:id/pdf — يبثّ الملف المولَّد وقت الدفع
 * نفسه، لا نسخة تُعاد صناعتها الآن. إعادة التوليد ستحمل طابعاً
 * زمنياً مختلفاً عن المضمَّن في رمز QR الأصلي، فتصير الوثيقة ورمزها
 * يقولان تاريخين.
 *
 * مقيَّد بمالك الفاتورة، وبنفس رد 404 لحالتَي «غير موجودة» و«ليست
 * لك» حتى لا يصلح المسار لاستكشاف المعرّفات.
 */
paymentsRouter.get("/invoices/:id/pdf", requireUserAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT pdf_data, zatca_invoice_number FROM invoices
       WHERE id = $1 AND user_id = $2 AND status IN ('paid', 'refunded')`,
      [req.params.id, req.userId]
    );
    const invoice = rows[0];
    if (!invoice || !invoice.pdf_data) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoice.zatca_invoice_number}.pdf"`);
    res.send(invoice.pdf_data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

paymentsRouter.get("/credit-notes/:id/pdf", requireUserAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT pdf_data, zatca_credit_note_number FROM credit_notes WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    const note = rows[0];
    if (!note || !note.pdf_data) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${note.zatca_credit_note_number}.pdf"`);
    res.send(note.pdf_data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   Webhook — المكان الوحيد الذي تتغيّر فيه الحالة المالية.
   المنطق كاملاً في payments/webhook.js.
   ============================================================ */
paymentsRouter.post("/webhook", handleMoyasarWebhook);

export { effectiveStatusSql };
