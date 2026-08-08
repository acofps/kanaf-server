import { withTransaction } from "../db/pool.js";
import { refundPayment } from "./moyasar.js";
import { generateAndStoreCreditNote } from "../invoicing/generate.js";
import { getBillingSettings } from "../billing/config.js";

/* ============================================================
   الاسترداد — كامل وجزئي، منفَّذ لدى المزوّد فعلاً

   ما كان قبل هذا الملف:
   مسار الاسترداد الإداري كان يعلّم الفاتورة `refunded`، يلغي
   الاشتراك، ويصدر إشعاراً دائناً — **دون أن ينادي Moyasar إطلاقاً**.
   أي أن الدفاتر والفاتورة القانونية تقولان إن المبلغ رُدّ، والمال لم
   يتحرك. هذا أخطر من عطل ظاهر: يُنتج وثيقة ضريبية صحيحة الشكل تصف
   واقعة لم تحدث.

   ولم يكن الاسترداد الجزئي مدعوماً أصلاً — لا في الكود ولا في
   المخطط.

   ============================================================
   لماذا نداء المزوّد خارج المعاملة، على مرحلتين
   ============================================================
   نداء شبكة داخل معاملة يبقي قفل الصف مفتوحاً طوال زمن الشبكة،
   وانقطاع الاتصال بعد تنفيذ الاسترداد لدى المزوّد يُرجِّع المعاملة
   عندنا — فيخرج المال ولا يبقى له أثر. لذلك ثلاث خطوات:

     1. معاملة قصيرة: قفل الدفعة، التحقق من المتاح، وحجز المبلغ
        بصف استرداد بحالة pending.
     2. نداء المزوّد خارج أي معاملة.
     3. معاملة ثانية: تثبيت النتيجة، أو تحرير الحجز عند الفشل.

   الحجز في الخطوة 1 هو ما يمنع نقرتين متزامنتين من استرداد المبلغ
   مرتين: المتاح = المبلغ − المسترد فعلاً − المحجوز المعلّق.
   ============================================================ */

/** يحسب المتاح للاسترداد على دفعة، مع احتساب الحجوزات المعلّقة. */
async function lockAndComputeAvailable(client, paymentId) {
  const { rows } = await client.query(
    `SELECT p.id, p.user_id, p.invoice_id, p.subscription_id, p.amount,
            p.refunded_amount, p.status, p.currency, p.provider, p.provider_payment_id,
            COALESCE((SELECT SUM(r.amount) FROM refunds r
                      WHERE r.payment_id = p.id AND r.status = 'pending'), 0) AS pending_amount
     FROM payments p WHERE p.id = $1 FOR UPDATE`,
    [paymentId]
  );
  const payment = rows[0];
  if (!payment) return null;
  const available = Number(
    (Number(payment.amount) - Number(payment.refunded_amount) - Number(payment.pending_amount)).toFixed(2)
  );
  return { payment, available };
}

/**
 * يثبّت أثر استرداد نجح لدى المزوّد: يحدّث الدفعة، ويصدر إشعاراً
 * دائناً بمبلغ هذا الاسترداد وحده، ويحدّث الفاتورة والاشتراك حسب
 * ما إذا كان الاسترداد كاملاً.
 *
 * يُستدعى من مسارين: بعد استرداد إداري نجح، ومن معالج الـwebhook حين
 * يتم الاسترداد من لوحة المزوّد مباشرة. المسار واحد فلا يمكن أن
 * يختلف السلوك بينهما.
 *
 * `totalRefundedSar` هو الإجمالي المسترد على الدفعة بعد هذه العملية.
 * تمريره صراحةً — لا حسابه هنا — لأن المزوّد هو مصدر الحقيقة في
 * مسار الـwebhook.
 */
export async function recordRefund(client, {
  payment, amountSar, totalRefundedSar, reason, initiatedBy = "admin",
  providerRefundId = null, adminUserId = null, refundId = null,
}) {
  const amount = Number(Number(amountSar).toFixed(2));
  const totalRefunded = Number(Number(totalRefundedSar ?? amount).toFixed(2));
  const paymentAmount = Number(payment.amount);

  if (amount <= 0) throw Object.assign(new Error("refund_amount_must_be_positive"), { status: 400 });
  if (totalRefunded > paymentAmount + 0.001) {
    // خط الدفاع الأول في الكود؛ الثاني قيد CHECK على الجدول نفسه.
    throw Object.assign(new Error("refund_exceeds_captured_amount"), { status: 409 });
  }

  const isFull = Math.abs(totalRefunded - paymentAmount) < 0.005;
  const settings = await getBillingSettings(client);

  let refundRowId = refundId;
  if (refundRowId) {
    const { rowCount } = await client.query(
      `UPDATE refunds SET status = 'succeeded', provider_refund_id = COALESCE($1, provider_refund_id),
              kind = $2, updated_at = now()
       WHERE id = $3 AND status = 'pending'`,
      [providerRefundId, isFull ? "full" : "partial", refundRowId]
    );
    if (rowCount === 0) return { alreadyRecorded: true, kind: isFull ? "full" : "partial", creditNoteNumber: null };
  } else {
    // مسار الـwebhook: لا حجز سابق. القيد الفريد على
    // (provider, provider_refund_id) يجعل الحدث المكرر لا ينتج صفاً
    // ثانياً حتى لو تجاوز كل الفحوص التي قبله.
    const { rows } = await client.query(
      `INSERT INTO refunds
         (user_id, payment_id, invoice_id, amount, currency, kind, provider,
          provider_refund_id, status, reason, initiated_by, admin_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'succeeded', $9, $10, $11)
       ON CONFLICT (provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        payment.user_id, payment.id, payment.invoice_id, amount, settings.currency,
        isFull ? "full" : "partial", payment.provider || "moyasar", providerRefundId,
        reason || null, initiatedBy, adminUserId,
      ]
    );
    if (!rows[0]) return { alreadyRecorded: true, kind: isFull ? "full" : "partial", creditNoteNumber: null };
    refundRowId = rows[0].id;
  }

  await client.query(
    `UPDATE payments
     SET refunded_amount = $1,
         status = CASE WHEN $2 THEN 'refunded' ELSE 'partially_refunded' END,
         updated_at = now()
     WHERE id = $3`,
    [totalRefunded, isFull, payment.id]
  );

  /* --------------------------------------------------------
     الفاتورة والاشتراك.

     الاسترداد الجزئي **لا** يحوّل الفاتورة إلى refunded ولا يلغي
     الوصول. سببان: قيد CHECK على invoices.status لا يعرف حالة
     «مستردة جزئياً» أصلاً وتوسيعه ممنوع بقيد الملكية؛ والأهم أن
     رد جزء من المبلغ لا يعني أن الخدمة لم تُقدَّم. الإشعار الدائن
     هو ما يوثّق الجزء المردود، وهو الوثيقة الصحيحة لذلك نظاماً.

     الاسترداد الكامل يلغي الوصول فوراً — بخلاف الإلغاء العادي الذي
     قد يُترك ليكمل مدته المدفوعة. من استرد ماله لم يعد دافعاً.
     -------------------------------------------------------- */
  if (isFull) {
    await client.query(`UPDATE invoices SET status = 'refunded', updated_at = now() WHERE id = $1`, [payment.invoice_id]);
    await client.query(
      `UPDATE subscriptions SET status = 'canceled', canceled_at = now(), updated_at = now()
       WHERE user_id = $1 AND status IN ('active', 'past_due', 'trialing')`,
      [payment.user_id]
    );
  }

  // الإشعار الدائن بمبلغ هذا الاسترداد وحده — استردادان جزئيان
  // ينتجان إشعارين، وهذا هو الصحيح: كل إشعار يصحّح مبلغاً محدداً.
  let creditNote = null;
  try {
    const { rows: invRows } = await client.query(
      `SELECT plan_id FROM invoices WHERE id = $1`, [payment.invoice_id]
    );
    const { rows: planRows } = await client.query(
      `SELECT name FROM subscription_plans WHERE plan_key = $1`, [invRows[0]?.plan_id]
    );
    const { rows: userRows } = await client.query(`SELECT name, email FROM users WHERE id = $1`, [payment.user_id]);

    creditNote = await generateAndStoreCreditNote({
      originalInvoiceId: payment.invoice_id,
      userId: payment.user_id,
      planName: planRows[0]?.name || invRows[0]?.plan_id || "اشتراك",
      amountSar: amount,
      reason: reason || "استرداد",
      buyerEmail: userRows[0]?.email,
      buyerName: userRows[0]?.name,
      providerRefundId,
    }, client);

    if (creditNote?.creditNoteId) {
      await client.query(`UPDATE refunds SET credit_note_id = $1, updated_at = now() WHERE id = $2`,
        [creditNote.creditNoteId, refundRowId]);
    }
  } catch (err) {
    // مستند فاشل لا يُرجِّع استرداداً استحقّه العميل فعلاً — يُسجَّل
    // للتسوية اليدوية، ويظهر في تقرير التكامل كاسترداد بلا إشعار.
    console.error(`[refund] فشل إصدار الإشعار الدائن للاسترداد ${refundRowId}:`, err);
  }

  return {
    alreadyRecorded: false,
    refundId: refundRowId,
    kind: isFull ? "full" : "partial",
    amount,
    totalRefunded,
    creditNoteId: creditNote?.creditNoteId || null,
    creditNoteNumber: creditNote?.creditNoteNumber || null,
  };
}

/**
 * الاسترداد الإداري الكامل: تحقق → حجز → نداء المزوّد → تثبيت.
 *
 * `amountSar` اختياري — تركه فارغاً يعني استرداد كامل المتبقّي.
 */
export async function executeRefund({ paymentId, amountSar, reason, adminUserId }) {
  /* 1) حجز داخل معاملة قصيرة */
  const reservation = await withTransaction(async (client) => {
    const found = await lockAndComputeAvailable(client, paymentId);
    if (!found) throw Object.assign(new Error("payment_not_found"), { status: 404 });
    const { payment, available } = found;

    if (payment.status === "failed" || payment.status === "voided" || payment.status === "pending") {
      throw Object.assign(new Error("payment_not_captured"), { status: 409 });
    }
    if (available <= 0) {
      throw Object.assign(new Error("already_fully_refunded"), { status: 409 });
    }

    const requested = amountSar === undefined || amountSar === null
      ? available
      : Number(Number(amountSar).toFixed(2));

    if (!Number.isFinite(requested) || requested <= 0) {
      throw Object.assign(new Error("refund_amount_must_be_positive"), { status: 400 });
    }
    if (requested > available + 0.001) {
      throw Object.assign(new Error("refund_exceeds_available_amount"), { status: 409, available });
    }

    const settings = await getBillingSettings(client);
    const isFull = Math.abs(requested - available) < 0.005 &&
                   Math.abs(Number(payment.refunded_amount)) < 0.005;

    const { rows } = await client.query(
      `INSERT INTO refunds
         (user_id, payment_id, invoice_id, amount, currency, kind, provider,
          status, reason, initiated_by, admin_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, 'admin', $9)
       RETURNING id`,
      [
        payment.user_id, payment.id, payment.invoice_id, requested, settings.currency,
        isFull ? "full" : "partial", payment.provider || "moyasar", reason || null, adminUserId,
      ]
    );

    return { payment, requested, available, refundId: rows[0].id };
  });

  /* 2) نداء المزوّد — خارج المعاملة */
  let providerResponse;
  try {
    const fullRemaining = Math.abs(reservation.requested - reservation.available) < 0.005;
    providerResponse = await refundPayment(
      reservation.payment.provider_payment_id,
      // استرداد كامل المتبقّي يُرسل بلا مبلغ — سلوك المزوّد
      // الافتراضي، ويتجنّب فروق التقريب على الهللة الأخيرة.
      fullRemaining ? undefined : reservation.requested
    );
  } catch (err) {
    await withTransaction((client) =>
      client.query(
        `UPDATE refunds SET status = 'failed', error = $1, updated_at = now() WHERE id = $2`,
        [String(err?.message || err).slice(0, 2000), reservation.refundId]
      )
    );
    throw Object.assign(new Error("provider_refund_failed"), {
      status: 502,
      detail: String(err?.message || err),
    });
  }

  /* 3) تثبيت النتيجة */
  return withTransaction(async (client) => {
    const found = await lockAndComputeAvailable(client, paymentId);
    const payment = found.payment;

    // إجمالي المسترد كما يراه المزوّد هو المرجع؛ وإن لم يرجعه نجمع
    // ما لدينا مع المبلغ المطلوب.
    const providerTotal = providerResponse?.refunded_amount !== undefined
      ? Number((Number(providerResponse.refunded_amount) / 100).toFixed(2))
      : Number((Number(payment.refunded_amount) + reservation.requested).toFixed(2));

    return recordRefund(client, {
      payment,
      amountSar: reservation.requested,
      totalRefundedSar: providerTotal,
      reason,
      initiatedBy: "admin",
      providerRefundId: providerResponse?.id ? `${providerResponse.id}:${providerTotal}` : null,
      adminUserId,
      refundId: reservation.refundId,
    });
  });
}
