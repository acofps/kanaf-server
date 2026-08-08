import { withTransaction } from "../db/pool.js";
import { isGenuineWebhook, HANDLED_WEBHOOK_EVENTS } from "./moyasar.js";
import { generateAndStoreInvoice } from "../invoicing/generate.js";
import { recordRefund } from "./refund.js";
import { activateOrExtendSubscription, markPastDueIfEntitled } from "../billing/subscription.js";
import { getBillingSettings } from "../billing/config.js";

/* ============================================================
   معالج الـWebhook — المكان الوحيد الذي تتغيّر فيه الحالة المالية

   خمس مشاكل حقيقية في النسخة السابقة، كل واحدة منها كانت تكلّف
   مالاً أو تمنع وصوله:

   1. 🔴 الدفع الناجح بعد الفاشل كان يُتجاهَل.
      الحماية من التكرار كانت: «إذا كانت الفاتورة paid أو failed
      فتجاهل». لكن الفشل ثم إعادة المحاولة على نفس رابط الدفع سيناريو
      عادي جداً — البطاقة تُرفض، فيعيد العميل المحاولة وينجح. الفاتورة
      صارت failed عند المحاولة الأولى، فيُرفض payment_paid التالي
      بوصفه «مكرراً». العميل يُخصم منه ولا يُفعَّل اشتراكه، ولا شيء
      في السجل يقول إن ذلك حدث.
      الإصلاح: مرساة منع التكرار صارت **الدفعة** لا الفاتورة. سؤال
      «هل رأيت هذه الدفعة؟» غير سؤال «هل هذه الفاتورة مدفوعة؟».

   2. 🔴 حدث متأخر كان يقدر يخفض حالة صحيحة.
      payment_failed لمحاولة قديمة يصل بعد payment_paid لمحاولة
      ناجحة (وارد جداً مع إعادة المحاولة عند المزوّد) كان يحوّل
      فاتورة مدفوعة إلى فاشلة. الآن الانتقالات في اتجاه واحد: ما
      دُفع لا يُنزع بحدث أقدم.

   3. 🔴 لا سجل أحداث إطلاقاً.
      حدث فشلت معالجته كان يختفي مع سطر في stdout. لا طريقة لمعرفة
      ماذا وصل، ولا لإعادة تشغيله. الآن كل حدث موثّق مع حمولته
      وعدد محاولاته ونتيجته، وقابل لإعادة التشغيل من اللوحة.

   4. 🔴 الاسترداد الجزئي غير مدعوم أصلاً.
      كان الاسترداد إما كل شيء أو لا شيء، وكان يُلغي الوصول دائماً.

   5. 🔴 الأحداث المسجَّلة لدى المزوّد لا تشمل الاسترداد
      (انظر payments/register_webhook.js) — فمعالج الاسترداد لم يكن
      ليُستدعى في الإنتاج مهما كان صحيحاً.

   ⚠️ ملاحظة أمنية على السجل: الحمولة تُخزَّن بعد نزع secret_token.
   وحدث بتوقيع غير صالح **لا يُكتب في الجدول إطلاقاً** — يُرفض قبل
   أي كتابة. غير ذلك يعني أن أي شخص على الإنترنت يقدر ينفخ جدولاً
   نقرؤه من اللوحة، بمجرد إرسال طلبات لعنوان معروف.
   ============================================================ */

/** ينزع السر من الحمولة قبل تخزينها. جدول السجلات ليس مخزن أسرار. */
function sanitizePayload(body) {
  if (!body || typeof body !== "object") return {};
  const { secret_token, ...rest } = body;
  return rest;
}

/** الهللات → ريالات. Moyasar يتعامل بأصغر وحدة دائماً. */
function halalasToSar(halalas) {
  const n = Number(halalas);
  return Number.isFinite(n) ? Number((n / 100).toFixed(2)) : 0;
}

/**
 * مفتاح منع التكرار.
 *
 * الأفضل دائماً معرّف الحدث نفسه — إعادة تسليم نفس الحدث من المزوّد
 * تحمل نفس المعرّف. وإن غاب (حمولة قديمة أو مزوّد مختلف مستقبلاً)
 * نبني مفتاحاً مركّباً من النوع ومعرّف الكائن وحالته، وهو أضعف
 * قليلاً لكنه يظل يمنع التسليم المكرر الحقيقي.
 */
function buildDedupKey(body) {
  const provider = "moyasar";
  if (body?.id) return `${provider}:evt:${body.id}`;
  const type = body?.type || "unknown";
  const objectId = body?.data?.id || "unknown";
  const objectStatus = body?.data?.status || "";
  const refunded = body?.data?.refunded_amount ?? "";
  return `${provider}:${type}:${objectId}:${objectStatus}:${refunded}`;
}

/**
 * يجد فاتورتنا المقابلة للدفعة، بثلاث طرق مرتّبة بحسب الوثوق:
 *   1. invoice_id من المزوّد ↔ provider_invoice_id عندنا
 *   2. metadata.kanaf_invoice_id الذي نضعه نحن وقت الإنشاء
 *   3. رقم الدفعة نفسه لو كانت الفاتورة قد رُبطت به سابقاً
 *
 * الطريقة الثانية موجودة لأن حمولات بعض الأحداث (الاسترداد مثلاً)
 * لا تحمل invoice_id بالضرورة — وقد كانت النسخة السابقة تعتمد على
 * وجوده وتتجاهل الحدث بصمت حين يغيب.
 */
async function findInvoiceForPayment(client, payment) {
  const providerInvoiceId = payment?.invoice_id;
  if (providerInvoiceId) {
    const { rows } = await client.query(
      `SELECT id, user_id, plan_id, amount_sar, status, zatca_invoice_number
       FROM invoices WHERE provider_invoice_id = $1 FOR UPDATE`,
      [providerInvoiceId]
    );
    if (rows[0]) return rows[0];
  }

  const metaInvoiceId = payment?.metadata?.kanaf_invoice_id;
  if (metaInvoiceId) {
    const { rows } = await client.query(
      `SELECT id, user_id, plan_id, amount_sar, status, zatca_invoice_number
       FROM invoices WHERE id = $1 FOR UPDATE`,
      [metaInvoiceId]
    );
    if (rows[0]) return rows[0];
  }

  if (payment?.id) {
    const { rows } = await client.query(
      `SELECT id, user_id, plan_id, amount_sar, status, zatca_invoice_number
       FROM invoices WHERE provider_payment_id = $1 FOR UPDATE`,
      [payment.id]
    );
    if (rows[0]) return rows[0];
  }

  return null;
}

/**
 * يسجّل صف الدفعة أو يحدّثه.
 *
 * يعيد { payment, alreadyTerminal } — و`alreadyTerminal` هو مرساة
 * منع التكرار الحقيقية: دفعة مسجّلة كـpaid لا تُفعّل اشتراكاً مرة
 * ثانية مهما تكرر الحدث أو تعدّدت مساراته.
 */
async function upsertPayment(client, { invoice, providerPayment, status }) {
  const providerPaymentId = providerPayment.id;
  const amountSar = providerPayment.amount !== undefined
    ? halalasToSar(providerPayment.amount)
    : Number(invoice.amount_sar);

  const { rows: existingRows } = await client.query(
    `SELECT id, status, amount, refunded_amount FROM payments
     WHERE provider = 'moyasar' AND provider_payment_id = $1 FOR UPDATE`,
    [providerPaymentId]
  );
  const existing = existingRows[0];

  // الحالات النهائية لا تُنزع بحدث لاحق. هذا ما يجعل الحدث المتأخر
  // غير المرتّب غير ضار: يُسجَّل ويُتجاهل أثره، لا يقلب حالة صحيحة.
  const TERMINAL = ["paid", "refunded", "partially_refunded"];
  if (existing && TERMINAL.includes(existing.status)) {
    return { payment: existing, alreadyTerminal: true };
  }

  const source = providerPayment.source || {};
  const failureReason =
    status === "failed"
      ? (source.message || providerPayment.description || "رفض من بوابة الدفع")
      : null;

  if (existing) {
    const { rows } = await client.query(
      `UPDATE payments
       SET status = $1, method = $2, card_brand = $3, card_last4 = $4,
           failure_reason = $5, amount = $6,
           captured_at = CASE WHEN $1 = 'paid' THEN now() ELSE captured_at END,
           updated_at = now()
       WHERE id = $7
       RETURNING id, status, amount, refunded_amount`,
      [status, source.type || null, source.company || source.brand || null,
       source.number ? String(source.number).slice(-4) : null,
       failureReason, amountSar, existing.id]
    );
    return { payment: rows[0], alreadyTerminal: false };
  }

  const settings = await getBillingSettings(client);
  const { rows } = await client.query(
    `INSERT INTO payments
       (user_id, invoice_id, provider, provider_payment_id, amount, currency,
        method, card_brand, card_last4, status, failure_reason, captured_at)
     VALUES ($1, $2, 'moyasar', $3, $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $9 = 'paid' THEN now() ELSE NULL END)
     RETURNING id, status, amount, refunded_amount`,
    [
      invoice.user_id, invoice.id, providerPaymentId, amountSar, settings.currency,
      source.type || null, source.company || source.brand || null,
      source.number ? String(source.number).slice(-4) : null,
      status, failureReason,
    ]
  );
  return { payment: rows[0], alreadyTerminal: false };
}

/* ------------------------------------------------------------
   معالجات الأحداث — كل واحد يعمل داخل معاملة واحدة
   ------------------------------------------------------------ */

async function handlePaymentPaid(client, providerPayment) {
  const invoice = await findInvoiceForPayment(client, providerPayment);
  if (!invoice) return { outcome: "unmatched_invoice" };

  const { payment, alreadyTerminal } = await upsertPayment(client, {
    invoice, providerPayment, status: "paid",
  });
  if (alreadyTerminal) return { outcome: "payment_already_recorded", invoiceId: invoice.id };

  // الفاتورة تُرفع إلى paid حتى لو كانت failed — وهذا جوهر الإصلاح:
  // محاولة فاشلة سابقة لا تُغلق الفاتورة أمام محاولة ناجحة لاحقة.
  await client.query(
    `UPDATE invoices SET status = 'paid', provider_payment_id = $1, updated_at = now() WHERE id = $2`,
    [providerPayment.id, invoice.id]
  );

  const { rows: planRows } = await client.query(
    `SELECT plan_key, name, duration_days, price_sar FROM subscription_plans WHERE plan_key = $1`,
    [invoice.plan_id]
  );
  const plan = planRows[0];
  if (!plan) {
    // الدفع مسجَّل والفاتورة مدفوعة — لكن لا يمكن تفعيل اشتراك
    // لباقة محذوفة. لا نُسقط المال، نضع الحالة تحت التسوية اليدوية
    // بنتيجة صريحة تظهر في سجل الأحداث.
    return { outcome: "paid_but_unknown_plan_needs_reconciliation", invoiceId: invoice.id, paymentId: payment.id };
  }

  const settings = await getBillingSettings(client);
  const activation = await activateOrExtendSubscription(client, {
    userId: invoice.user_id,
    planKey: plan.plan_key,
    planName: plan.name,
    durationDays: plan.duration_days,
    priceSar: invoice.amount_sar,
    currency: settings.currency,
    invoiceId: invoice.id,
    paymentId: payment.id,
  });

  // الفاتورة الضريبية تُصدر داخل نفس المعاملة، فلا يُستهلك رقم
  // تسلسلي لدفعة لم تُسجَّل. وفشل توليد المستند لا يُرجّع تفعيل
  // اشتراك دفع العميل ثمنه فعلاً — يُسجَّل للمتابعة اليدوية.
  let invoiceNumber = invoice.zatca_invoice_number || null;
  if (!invoiceNumber) {
    const { rows: userRows } = await client.query(`SELECT name, email FROM users WHERE id = $1`, [invoice.user_id]);
    try {
      const generated = await generateAndStoreInvoice({
        invoiceId: invoice.id,
        userId: invoice.user_id,
        planName: plan.name,
        planKey: plan.plan_key,
        totalSar: invoice.amount_sar,
        buyerEmail: userRows[0]?.email,
        buyerName: userRows[0]?.name,
        billingCycle: activation.planName ? undefined : undefined,
        periodStart: activation.periodStart,
        periodEnd: activation.periodEnd,
      }, client);
      invoiceNumber = generated?.invoiceNumber || null;
    } catch (invoiceErr) {
      console.error(`[webhook] فشل توليد الفاتورة الضريبية للفاتورة ${invoice.id}:`, invoiceErr);
    }
  }

  return {
    outcome: activation.isRenewal ? "renewal_activated" : "subscription_activated",
    invoiceId: invoice.id,
    paymentId: payment.id,
    subscriptionId: activation.subscriptionId,
    invoiceNumber,
  };
}

async function handlePaymentFailed(client, providerPayment) {
  const invoice = await findInvoiceForPayment(client, providerPayment);
  if (!invoice) return { outcome: "unmatched_invoice" };

  const { payment, alreadyTerminal } = await upsertPayment(client, {
    invoice, providerPayment, status: "failed",
  });
  if (alreadyTerminal) {
    // هذه هي الحماية من الأحداث خارج الترتيب: فشل محاولة قديمة يصل
    // بعد نجاح محاولة أحدث. يُسجَّل، ولا يُنقص شيئاً.
    return { outcome: "ignored_out_of_order_after_success", invoiceId: invoice.id };
  }

  // الفاتورة تُعلَّم فاشلة فقط إن كانت ما تزال معلّقة. فاتورة مدفوعة
  // لا تعود فاشلة أبداً.
  await client.query(
    `UPDATE invoices SET status = 'failed', provider_payment_id = $1, updated_at = now()
     WHERE id = $2 AND status = 'pending'`,
    [providerPayment.id, invoice.id]
  );

  // متعثّر السداد ينطبق فقط على من له اشتراك ساري المفعول — أي أن
  // هذه كانت دفعة تجديد. أول دفعة فاشلة لمستخدم جديد لا تنشئ
  // اشتراكاً بلا أساس مالي.
  const pastDueId = await markPastDueIfEntitled(client, invoice.user_id);

  return {
    outcome: pastDueId ? "renewal_failed_marked_past_due" : "payment_failed_no_entitlement_granted",
    invoiceId: invoice.id,
    paymentId: payment.id,
  };
}

async function handlePaymentRefunded(client, providerPayment, eventId) {
  const { rows: paymentRows } = await client.query(
    `SELECT id, user_id, invoice_id, subscription_id, amount, refunded_amount, status
     FROM payments WHERE provider = 'moyasar' AND provider_payment_id = $1 FOR UPDATE`,
    [providerPayment.id]
  );
  const payment = paymentRows[0];
  if (!payment) return { outcome: "unmatched_payment" };

  // المزوّد يرسل **إجمالي** المبلغ المسترد على الدفعة، لا الفرق.
  // الطرح هو ما يجعل هذا المسار صحيحاً مع الاسترداد الجزئي المتعدد
  // وآمناً تماماً أمام التسليم المكرر في آن واحد: الحدث المكرر
  // يعطي فرقاً صفراً فلا يفعل شيئاً.
  const providerTotalRefunded = providerPayment.refunded_amount !== undefined
    ? halalasToSar(providerPayment.refunded_amount)
    : Number(payment.amount);
  const delta = Number((providerTotalRefunded - Number(payment.refunded_amount)).toFixed(2));

  if (delta <= 0) {
    return { outcome: "refund_already_recorded", paymentId: payment.id };
  }

  const result = await recordRefund(client, {
    payment,
    amountSar: delta,
    totalRefundedSar: providerTotalRefunded,
    reason: "استرداد عبر بوابة الدفع",
    initiatedBy: "provider",
    providerRefundId: eventId || null,
  });

  return {
    outcome: result.kind === "full" ? "refunded_full" : "refunded_partial",
    paymentId: payment.id,
    creditNoteNumber: result.creditNoteNumber || null,
    refundedTotal: providerTotalRefunded,
  };
}

async function handlePaymentVoided(client, providerPayment) {
  const invoice = await findInvoiceForPayment(client, providerPayment);
  if (!invoice) return { outcome: "unmatched_invoice" };

  const { payment, alreadyTerminal } = await upsertPayment(client, {
    invoice, providerPayment, status: "voided",
  });
  if (alreadyTerminal) return { outcome: "ignored_out_of_order_after_success", invoiceId: invoice.id };

  await client.query(
    `UPDATE invoices SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'pending'`,
    [invoice.id]
  );
  return { outcome: "payment_voided", invoiceId: invoice.id, paymentId: payment.id };
}

/* ------------------------------------------------------------
   الموزّع
   ------------------------------------------------------------ */

export async function processWebhookEvent(client, { eventType, body }) {
  const providerPayment = body?.data || {};
  switch (eventType) {
    case "payment_paid":     return handlePaymentPaid(client, providerPayment);
    case "payment_failed":   return handlePaymentFailed(client, providerPayment);
    case "payment_refunded": return handlePaymentRefunded(client, providerPayment, body?.id);
    case "payment_voided":   return handlePaymentVoided(client, providerPayment);
    default:
      return { outcome: `unhandled_event_type:${eventType}` };
  }
}

/**
 * نقطة الدخول من Express.
 *
 * عقد الردود مع المزوّد، وهو مقصود بدقة:
 *   • 401 — توقيع غير صالح. لا كتابة، ولا إعادة محاولة مفيدة.
 *   • 200 — استُلم وعولج، أو استُلم وتُجوهل بوعي (نوع غير مدعوم،
 *           فاتورة غير معروفة، تكرار). كلها ليست مشاكل عند المزوّد،
 *           وإرجاع خطأ فيها يستدعي عاصفة إعادة محاولات بلا فائدة.
 *   • 500 — خطأ حقيقي عندنا. **مطلوب** أن يعيد المزوّد المحاولة،
 *           والحدث محفوظ بحالة failed فيُعالَج في المحاولة التالية
 *           بدل أن يُرفض بوصفه مكرراً.
 */
export async function handleMoyasarWebhook(req, res) {
  const body = req.body;

  if (!isGenuineWebhook(body)) {
    console.warn("[webhook] رُفض حدث بتوقيع غير صالح أو مفقود");
    return res.status(401).json({ error: "invalid_webhook" });
  }

  const eventType = String(body?.type || "unknown");
  const dedupKey = buildDedupKey(body);
  const objectId = body?.data?.id || null;

  let eventRow;
  try {
    // xmax = 0 يميّز الإدراج الجديد من التحديث عند التعارض — الطريقة
    // القياسية لمعرفة «هل رأيت هذا الحدث قبل الآن؟» في عبارة واحدة
    // ذرّية، بلا سباق بين قراءة وكتابة.
    const { rows } = await withTransaction(async (client) =>
      client.query(
        `INSERT INTO webhook_events
           (provider, provider_event_id, event_type, dedup_key, object_id,
            signature_valid, status, payload)
         VALUES ('moyasar', $1, $2, $3, $4, true, 'received', $5)
         ON CONFLICT (dedup_key) DO UPDATE SET attempts = webhook_events.attempts + 1
         RETURNING id, status, attempts, (xmax = 0) AS inserted`,
        [body?.id || null, eventType, dedupKey, objectId, JSON.stringify(sanitizePayload(body))]
      )
    );
    eventRow = rows[0];
  } catch (err) {
    console.error("[webhook] تعذّر تسجيل الحدث:", err);
    return res.status(500).json({ error: "internal_error" });
  }

  // تكرار حقيقي: حدث سبق أن عولج أو تُجوهل بوعي. لا يُعاد تنفيذه.
  if (!eventRow.inserted && (eventRow.status === "processed" || eventRow.status === "ignored")) {
    console.log(`[webhook] تسليم مكرر للحدث ${dedupKey} (المحاولة ${eventRow.attempts}) — تُجوهل`);
    return res.status(200).json({ ok: true, duplicate: true });
  }

  if (!HANDLED_WEBHOOK_EVENTS.includes(eventType)) {
    await withTransaction(async (client) =>
      client.query(
        `UPDATE webhook_events SET status = 'ignored', outcome = $1, processed_at = now() WHERE id = $2`,
        [`unhandled_event_type:${eventType}`, eventRow.id]
      )
    );
    return res.status(200).json({ ok: true, ignored: true });
  }

  try {
    const result = await withTransaction((client) => processWebhookEvent(client, { eventType, body }));

    const ignoredOutcomes = [
      "unmatched_invoice", "unmatched_payment", "payment_already_recorded",
      "refund_already_recorded", "ignored_out_of_order_after_success",
    ];
    const finalStatus = ignoredOutcomes.includes(result.outcome) ? "ignored" : "processed";

    await withTransaction(async (client) =>
      client.query(
        `UPDATE webhook_events SET status = $1, outcome = $2, error = NULL, processed_at = now() WHERE id = $3`,
        [finalStatus, JSON.stringify(result), eventRow.id]
      )
    );

    console.log(`[webhook] ${eventType} → ${result.outcome}`);
    return res.status(200).json({ ok: true, outcome: result.outcome });
  } catch (err) {
    console.error(`[webhook] فشلت معالجة ${eventType}:`, err);
    try {
      await withTransaction(async (client) =>
        client.query(
          `UPDATE webhook_events SET status = 'failed', error = $1, processed_at = now() WHERE id = $2`,
          [String(err?.message || err).slice(0, 2000), eventRow.id]
        )
      );
    } catch (logErr) {
      console.error("[webhook] تعذّر تسجيل فشل المعالجة:", logErr);
    }
    // 500 مقصود: نريد إعادة المحاولة من المزوّد. الحدث محفوظ
    // بحالة failed، والمحاولة التالية تُعالَج بدل أن تُرفض كمكررة.
    return res.status(500).json({ error: "internal_error" });
  }
}
