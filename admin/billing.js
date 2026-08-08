import express from "express";
import { query, withTransaction } from "../db/pool.js";
import { requireAdminAuth, requireRole, requireReasonAndLog, logAdminAction } from "./middleware.js";
import { getBillingSettings } from "../billing/config.js";
import { effectiveStatusSql, entitledSql } from "../billing/subscription.js";
import { executeRefund, issueCreditNoteDocument } from "../payments/refund.js";
import { processWebhookEvent, issueInvoiceDocument } from "../payments/webhook.js";
import { fetchPayment } from "../payments/moyasar.js";

export const billingRouter = express.Router();

/* ============================================================
   صفحات الإدارة المالية

   قبل هذه المرحلة كانت اللوحة تعرض:
     • الفواتير — المدفوعة فقط، بلا إجمالي ولا فلاتر ولا ترتيب،
       وبعدّاد «يحتاج انتباه» محسوب على الصفحة المعروضة وحدها فيقول
       صفراً بينما الصفحة التالية مليئة.
     • الإشعارات الدائنة — قائمة بلا ترقيم بحد 100.
     • الاشتراكات — لا شيء. لا مسار ولا صفحة.
     • المدفوعات — لا شيء، ولا كان ممكناً بناؤها: لم يكن هناك كيان
       دفعة أصلاً (انظر ترحيل 004).
     • المؤشرات المالية — لا شيء عدا عدّاد اشتراكات فعّالة يقرأ
       status = 'active' حرفياً، فيعدّ اشتراكات انتهت مدتها منذ شهور.
   ============================================================ */

/* ---------- أدوات مشتركة ---------- */

/** صاحب الدفعة — يُستخدم هدفاً لسجل التدقيق في المسارات المالية. */
async function paymentOwner(req) {
  const { rows } = await query(`SELECT user_id FROM payments WHERE id = $1`, [req.params.id]);
  return rows[0]?.user_id || null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ترقيم موحّد: حد أقصى صارم حتى لا يستنزف طلبٌ واحد الذاكرة. */
function readPaging(req, { defaultSize = 25, maxSize = 100 } = {}) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(req.query.pageSize, 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** تهريب محارف ILIKE الخاصة — بدونه يصير `%` بحثاً عن كل شيء. */
function likeTerm(search) {
  return `%${search.replace(/[%_\\]/g, "\\$&")}%`;
}

/**
 * حدود نطاق التاريخ بالمنطقة الزمنية المحاسبية لا بمنطقة الخادم.
 *
 * الخادم على Render يعمل بتوقيت UTC. «إيراد اليوم» محسوباً بـUTC
 * يبدأ الساعة 3 فجراً بتوقيت الرياض وينتهي 3 فجر اليوم التالي — أي
 * أن مبيعات ثلاث ساعات تُنسب دائماً لليوم الخطأ. المنطقة تأتي من
 * billing_settings.reporting_timezone.
 */
function dateBoundsSql(fromParam, toParam, tzParam) {
  return {
    fromExpr: `(${fromParam}::date)::timestamp AT TIME ZONE ${tzParam}`,
    // نهاية اليوم شاملة: `to` بتاريخ فقط كانت ستستبعد كل ذلك اليوم.
    toExpr: `((${toParam}::date + 1))::timestamp AT TIME ZONE ${tzParam}`,
  };
}

function defaultRange(req) {
  const to = String(req.query.to || "").trim() || new Date().toISOString().slice(0, 10);
  const from = String(req.query.from || "").trim() ||
    new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

/* ============================================================
   1) الاشتراكات
   ============================================================ */

const SUBSCRIPTION_SORT = {
  created_at: "s.created_at",
  period_end: "s.current_period_end",
  started_at: "s.started_at",
  price: "ss.plan_price_sar",
  user: "u.name",
};

// GET /admin/billing/subscriptions
billingRouter.get("/subscriptions", requireAdminAuth, requireRole("support"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req);
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "all");
    const planId = String(req.query.plan || "all");
    const cycle = String(req.query.cycle || "all");
    const provider = String(req.query.provider || "all");
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    const sortCol = SUBSCRIPTION_SORT[String(req.query.sort || "created_at")] || "s.created_at";
    const dir = String(req.query.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

    const where = [];
    const params = [];
    const p = (v) => `$${params.push(v)}`;

    if (search) {
      if (UUID_RE.test(search)) {
        where.push(`(s.id = ${p(search)} OR s.user_id = ${p(search)})`);
      } else {
        const t = likeTerm(search);
        where.push(`(u.name ILIKE ${p(t)} OR u.email ILIKE ${p(t)})`);
      }
    }
    if (planId !== "all") where.push(`s.plan_id = ${p(planId)}`);
    if (cycle !== "all") where.push(`ss.billing_cycle = ${p(cycle)}`);
    if (provider !== "all") where.push(`s.payment_provider = ${p(provider)}`);
    if (from) where.push(`s.created_at >= ${p(from)}`);
    if (to) where.push(`s.created_at < (${p(to)}::date + interval '1 day')`);

    // الفلترة على الحالة تجري على **الحالة الفعلية** لا المخزّنة —
    // وإلا لأعاد فلتر «فعّال» اشتراكات منتهية، وهو بالضبط ما كانت
    // تفعله بطاقة المؤشرات في الصفحة الرئيسية.
    const statusExpr = effectiveStatusSql("s", "ss");
    if (status !== "all") where.push(`(${statusExpr}) = ${p(status)}`);

    const fromAndJoins = `
      FROM subscriptions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN subscription_state ss ON ss.subscription_id = s.id
      LEFT JOIN subscription_plans sp ON sp.plan_key = s.plan_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;

    const { rows: countRows } = await query(`SELECT count(*)::int AS total ${fromAndJoins}`, params);
    const total = countRows[0].total;

    const limitP = p(pageSize);
    const offsetP = p(offset);

    const { rows } = await query(
      `SELECT s.id, s.user_id, u.name AS user_name, u.email AS user_email,
              s.plan_id, sp.name AS plan_name, s.status AS stored_status,
              ${statusExpr} AS status,
              ${entitledSql("s")} AS entitled,
              s.started_at, ss.current_period_start, s.current_period_end,
              s.current_period_end AS renewal_date,
              s.canceled_at, ss.cancel_at_period_end, ss.cancel_requested_at,
              ss.billing_cycle, ss.billing_period_days, ss.plan_price_sar,
              COALESCE(ss.currency, 'SAR') AS currency,
              s.payment_provider AS provider, ss.provider_subscription_id,
              ss.last_invoice_id, ss.last_payment_id, ss.renewal_mode,
              s.created_at
       ${fromAndJoins}
       -- s.id فاصل تعادل إجباري: صفّان بنفس اللحظة يتبادلان الترتيب
       -- بين طلبين، فتتكرر سجلات وتضيع أخرى بين الصفحات.
       ORDER BY ${sortCol} ${dir} NULLS LAST, s.id DESC
       LIMIT ${limitP} OFFSET ${offsetP}`,
      params
    );

    res.json({
      subscriptions: rows, page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      filters: { search, status, plan: planId, cycle, provider, from, to, sort: req.query.sort || "created_at", dir: dir.toLowerCase() },
    });
  } catch (err) {
    console.error("[admin/billing] subscriptions failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   2) المدفوعات
   ============================================================ */

const PAYMENT_SORT = {
  created_at: "p.created_at",
  captured_at: "p.captured_at",
  amount: "p.amount",
  user: "u.name",
};

// GET /admin/billing/payments
billingRouter.get("/payments", requireAdminAuth, requireRole("support"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req);
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "all");
    const method = String(req.query.method || "all");
    const provider = String(req.query.provider || "all");
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    const sortCol = PAYMENT_SORT[String(req.query.sort || "created_at")] || "p.created_at";
    const dir = String(req.query.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

    const where = [];
    const params = [];
    const pp = (v) => `$${params.push(v)}`;

    if (search) {
      if (UUID_RE.test(search)) {
        where.push(`(p.id = ${pp(search)} OR p.user_id = ${pp(search)} OR p.invoice_id = ${pp(search)})`);
      } else {
        const t = likeTerm(search);
        // رقم المعاملة يُبحث عنه كنص كامل أيضاً — وهو أول ما يُلصق
        // في مربع البحث عند مطابقة كشف حساب المزوّد.
        where.push(`(u.name ILIKE ${pp(t)} OR u.email ILIKE ${pp(t)} OR p.provider_payment_id ILIKE ${pp(t)})`);
      }
    }
    if (status !== "all") where.push(`p.status = ${pp(status)}`);
    if (method !== "all") where.push(`p.method = ${pp(method)}`);
    if (provider !== "all") where.push(`p.provider = ${pp(provider)}`);
    if (from) where.push(`p.created_at >= ${pp(from)}`);
    if (to) where.push(`p.created_at < (${pp(to)}::date + interval '1 day')`);

    const fromAndJoins = `
      FROM payments p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN invoices i ON i.id = p.invoice_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;

    const { rows: countRows } = await query(`SELECT count(*)::int AS total ${fromAndJoins}`, params);
    const total = countRows[0].total;

    const { rows: sumRows } = await query(
      `SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('paid','refunded','partially_refunded')), 0) AS gross,
              COALESCE(SUM(p.refunded_amount), 0) AS refunded
       ${fromAndJoins}`,
      params
    );

    const limitP = pp(pageSize);
    const offsetP = pp(offset);

    const { rows } = await query(
      `SELECT p.id, p.user_id, u.name AS user_name, u.email AS user_email,
              p.invoice_id, i.zatca_invoice_number AS invoice_number, i.status AS invoice_status,
              p.subscription_id, p.amount, p.currency, p.method, p.card_brand, p.card_last4,
              p.provider, p.provider_payment_id AS transaction_id, p.status,
              p.failure_reason, p.refunded_amount, p.captured_at, p.created_at
       ${fromAndJoins}
       ORDER BY ${sortCol} ${dir} NULLS LAST, p.id DESC
       LIMIT ${limitP} OFFSET ${offsetP}`,
      params
    );

    res.json({
      payments: rows, page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      totals: {
        gross: Number(sumRows[0].gross),
        refunded: Number(sumRows[0].refunded),
        net: Number((Number(sumRows[0].gross) - Number(sumRows[0].refunded)).toFixed(2)),
      },
      filters: { search, status, method, provider, from, to, sort: req.query.sort || "created_at", dir: dir.toLowerCase() },
    });
  } catch (err) {
    console.error("[admin/billing] payments failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   3) الفواتير — كل الحالات، لا المدفوعة فقط
   ============================================================ */

const INVOICE_SORT = {
  created_at: "i.created_at",
  issued_at: "i.zatca_issued_at",
  amount: "i.amount_sar",
  user: "u.name",
};

billingRouter.get("/invoices", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req);
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "all");
    const planId = String(req.query.plan || "all");
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    const sortCol = INVOICE_SORT[String(req.query.sort || "created_at")] || "i.created_at";
    const dir = String(req.query.dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

    const where = [];
    const params = [];
    const pp = (v) => `$${params.push(v)}`;

    if (search) {
      if (UUID_RE.test(search)) {
        where.push(`(i.id = ${pp(search)} OR i.user_id = ${pp(search)})`);
      } else {
        const t = likeTerm(search);
        where.push(`(u.name ILIKE ${pp(t)} OR u.email ILIKE ${pp(t)} OR i.zatca_invoice_number ILIKE ${pp(t)})`);
      }
    }
    if (status !== "all") where.push(`i.status = ${pp(status)}`);
    if (planId !== "all") where.push(`i.plan_id = ${pp(planId)}`);
    if (from) where.push(`i.created_at >= ${pp(from)}`);
    if (to) where.push(`i.created_at < (${pp(to)}::date + interval '1 day')`);

    const fromAndJoins = `
      FROM invoices i
      JOIN users u ON u.id = i.user_id
      LEFT JOIN invoice_state st ON st.invoice_id = i.id
      LEFT JOIN subscription_plans sp ON sp.plan_key = i.plan_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;

    const { rows: countRows } = await query(`SELECT count(*)::int AS total ${fromAndJoins}`, params);
    const total = countRows[0].total;

    // «يحتاج انتباه» يُحسب على كامل المجموعة لا على الصفحة المعروضة.
    // كان محسوباً على الصفحة، فيقول صفراً بينما الصفحة الثالثة فيها
    // خمس فواتير مدفوعة بلا رقم ضريبي.
    const { rows: attentionRows } = await query(
      `SELECT count(*)::int AS n ${fromAndJoins} ${where.length ? "AND" : "WHERE"} i.status = 'paid' AND i.zatca_invoice_number IS NULL`,
      params
    );

    const limitP = pp(pageSize);
    const offsetP = pp(offset);

    const { rows } = await query(
      `SELECT i.id, i.zatca_invoice_number AS invoice_number, i.user_id,
              u.name AS user_name, u.email AS user_email,
              i.subscription_id, i.plan_id, sp.name AS plan_name,
              i.amount_sar, i.subtotal_sar, i.vat_sar,
              COALESCE(st.discount_sar, 0) AS discount_sar,
              COALESCE(st.currency, 'SAR') AS currency, st.vat_rate,
              st.seller_legal_name, st.seller_vat_number, st.buyer_name, st.buyer_email,
              st.line_items, st.period_start, st.period_end,
              i.status AS payment_status, i.provider_invoice_id, i.provider_payment_id,
              i.zatca_issued_at, i.created_at,
              (i.pdf_data IS NOT NULL) AS has_pdf
       ${fromAndJoins}
       ORDER BY ${sortCol} ${dir} NULLS LAST, i.id DESC
       LIMIT ${limitP} OFFSET ${offsetP}`,
      params
    );

    res.json({
      invoices: rows, page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      needsAttention: attentionRows[0].n,
      filters: { search, status, plan: planId, from, to, sort: req.query.sort || "created_at", dir: dir.toLowerCase() },
    });
  } catch (err) {
    console.error("[admin/billing] invoices failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   4) الإشعارات الدائنة
   ============================================================ */

billingRouter.get("/credit-notes", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req);
    const search = String(req.query.search || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    const where = [];
    const params = [];
    const pp = (v) => `$${params.push(v)}`;

    if (search) {
      if (UUID_RE.test(search)) {
        where.push(`(cn.id = ${pp(search)} OR cn.user_id = ${pp(search)})`);
      } else {
        const t = likeTerm(search);
        where.push(`(u.name ILIKE ${pp(t)} OR u.email ILIKE ${pp(t)} OR cn.zatca_credit_note_number ILIKE ${pp(t)})`);
      }
    }
    if (from) where.push(`cn.zatca_issued_at >= ${pp(from)}`);
    if (to) where.push(`cn.zatca_issued_at < (${pp(to)}::date + interval '1 day')`);

    const fromAndJoins = `
      FROM credit_notes cn
      JOIN invoices i ON i.id = cn.original_invoice_id
      JOIN users u ON u.id = cn.user_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;

    const { rows: countRows } = await query(`SELECT count(*)::int AS total ${fromAndJoins}`, params);
    const total = countRows[0].total;

    const limitP = pp(pageSize);
    const offsetP = pp(offset);

    const { rows } = await query(
      `SELECT cn.id, cn.zatca_credit_note_number AS credit_note_number,
              cn.amount_sar, cn.subtotal_sar, cn.vat_sar, cn.reason, cn.zatca_issued_at,
              cn.provider_refund_id, i.zatca_invoice_number AS original_invoice_number,
              i.id AS original_invoice_id, cn.user_id, u.email AS user_email, u.name AS user_name,
              (cn.pdf_data IS NOT NULL) AS has_pdf
       ${fromAndJoins}
       ORDER BY cn.zatca_issued_at DESC NULLS LAST, cn.id DESC
       LIMIT ${limitP} OFFSET ${offsetP}`,
      params
    );

    res.json({
      creditNotes: rows, page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    console.error("[admin/billing] credit notes failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   5) الاسترداد — عبر المزوّد فعلاً، كامل أو جزئي
   ============================================================ */

/**
 * POST /admin/billing/payments/:id/refund  { amountSar?, reason }
 *
 * تركُ amountSar فارغاً = استرداد كامل المتبقّي.
 *
 * كل شيء هنا يمر بـexecuteRefund، وهي نفسها المنطق الذي يستخدمه
 * مسار الـwebhook للتثبيت — فلا يمكن أن يختلف أثر استرداد بدأ من
 * اللوحة عن أثر استرداد بدأ من لوحة المزوّد.
 */
billingRouter.post(
  "/payments/:id/refund",
  requireAdminAuth,
  requireRole("admin"),
  // الهدف مستخدم صاحب الدفعة، لا معرّف المسار — معرّف المسار هنا
  // معرّف دفعة، وكتابته في عمود يشير إلى users تُفشل السجل والعملية.
  requireReasonAndLog("payment_refund", { resolveTargetUserId: paymentOwner }),
  async (req, res) => {
    const reason = String(req.body?.reason || "").trim();
    const amountSar = req.body?.amountSar;

    try {
      const { rows: before } = await query(
        `SELECT id, user_id, amount, refunded_amount, status FROM payments WHERE id = $1`,
        [req.params.id]
      );
      if (!before[0]) return res.status(404).json({ error: "payment_not_found" });

      const result = await executeRefund({
        paymentId: req.params.id,
        amountSar: amountSar === undefined || amountSar === null || amountSar === "" ? undefined : Number(amountSar),
        reason,
        adminUserId: req.admin.id,
      });

      if (result.alreadyRecorded) return res.status(409).json({ error: "refund_already_recorded" });

      // يُسجَّل بعد نجاح التغيير لا قبله — السجل يجب ألا يدّعي أبداً
      // تغييراً لم يحدث.
      await logAdminAction({
        adminUserId: req.admin.id,
        targetUserId: before[0].user_id,
        action: "payment_refund",
        oldValue: { status: before[0].status, refunded_amount: Number(before[0].refunded_amount) },
        newValue: { kind: result.kind, refunded_amount: result.totalRefunded, credit_note: result.creditNoteNumber },
        reason,
        metadata: { payment_id: req.params.id, amount: result.amount },
        ipAddress: req.ip,
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.status) {
        return res.status(err.status).json({ error: err.message, detail: err.detail, available: err.available });
      }
      console.error("[admin/billing] refund failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

/** GET /admin/billing/refunds — سجل الاستردادات، بما فيها الفاشلة. */
billingRouter.get("/refunds", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req);
    const { rows: countRows } = await query(`SELECT count(*)::int AS total FROM refunds`);
    const { rows } = await query(
      `SELECT r.id, r.user_id, u.email AS user_email, u.name AS user_name,
              r.payment_id, r.invoice_id, r.credit_note_id, cn.zatca_credit_note_number AS credit_note_number,
              r.amount, r.currency, r.kind, r.provider, r.provider_refund_id,
              r.status, r.reason, r.initiated_by, r.admin_user_id, r.error, r.created_at
       FROM refunds r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN credit_notes cn ON cn.id = r.credit_note_id
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );
    res.json({
      refunds: rows, page, pageSize, total: countRows[0].total,
      totalPages: Math.max(1, Math.ceil(countRows[0].total / pageSize)),
    });
  } catch (err) {
    console.error("[admin/billing] refunds list failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   6) مؤشرات الأداء المالية

   كل مؤشر له تعريف مكتوب يرجع مع الرد نفسه — لا رقم بلا تعريف،
   ولا قيمة ثابتة في أي مكان.
   ============================================================ */

billingRouter.get("/kpis", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const settings = await getBillingSettings();
    const { from, to } = defaultRange(req);
    const tz = settings.reportingTimezone;
    const { fromExpr, toExpr } = dateBoundsSql("$1", "$2", "$3");
    const rangeParams = [from, to, tz];

    const entitled = entitledSql("s");

    const [
      { rows: subsNow },
      { rows: cycles },
      { rows: canceled },
      { rows: pay },
      { rows: refundAgg },
      { rows: newSubs },
    ] = await Promise.all([
      // الاشتراكات الفعّالة **الآن** — لقطة لحظية لا تتأثر بنطاق
      // التاريخ، لأن «كم مشترك عندي» سؤال عن اللحظة لا عن الفترة.
      // ويُقاس على أحدث اشتراك لكل مستخدم، فلا يُحتسب من ألغى ثم عاد
      // مرتين.
      query(
        `SELECT count(*)::int AS n FROM (
           SELECT DISTINCT ON (s.user_id) s.id, s.status, s.current_period_end
           FROM subscriptions s ORDER BY s.user_id, s.created_at DESC
         ) s WHERE ${entitled}`
      ),
      query(
        `SELECT COALESCE(ss.billing_cycle, 'unknown') AS cycle, count(*)::int AS n
         FROM (
           SELECT DISTINCT ON (s.user_id) s.id, s.status, s.current_period_end
           FROM subscriptions s ORDER BY s.user_id, s.created_at DESC
         ) s
         LEFT JOIN subscription_state ss ON ss.subscription_id = s.id
         WHERE ${entitled}
         GROUP BY 1`
      ),
      query(
        `SELECT
           count(*) FILTER (WHERE s.canceled_at >= ${fromExpr} AND s.canceled_at < ${toExpr})::int AS canceled_in_range,
           count(*) FILTER (WHERE ss.cancel_at_period_end = true AND s.status <> 'canceled')::int AS scheduled_to_cancel
         FROM subscriptions s LEFT JOIN subscription_state ss ON ss.subscription_id = s.id`,
        rangeParams
      ),
      query(
        `SELECT
           count(*) FILTER (WHERE p.status IN ('paid','refunded','partially_refunded'))::int AS successful_payments,
           count(*) FILTER (WHERE p.status = 'failed')::int AS failed_payments,
           count(*)::int AS total_payment_attempts,
           COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('paid','refunded','partially_refunded')), 0) AS gross_revenue,
           COALESCE(SUM(p.refunded_amount) FILTER (WHERE p.status IN ('refunded','partially_refunded')), 0) AS refunded_from_these
         FROM payments p
         WHERE COALESCE(p.captured_at, p.created_at) >= ${fromExpr}
           AND COALESCE(p.captured_at, p.created_at) < ${toExpr}`,
        rangeParams
      ),
      query(
        `SELECT count(*)::int AS refund_count, COALESCE(SUM(r.amount), 0) AS refund_total
         FROM refunds r
         WHERE r.status = 'succeeded' AND r.created_at >= ${fromExpr} AND r.created_at < ${toExpr}`,
        rangeParams
      ),
      query(
        `SELECT count(*)::int AS n FROM subscriptions s
         WHERE s.started_at >= ${fromExpr} AND s.started_at < ${toExpr}`,
        rangeParams
      ),
    ]);

    const gross = Number(pay[0].gross_revenue);
    const refundedInRange = Number(refundAgg[0].refund_total);
    const attempts = Number(pay[0].total_payment_attempts);

    const byCycle = Object.fromEntries(cycles.map((r) => [r.cycle, r.n]));

    res.json({
      range: { from, to, timezone: tz },
      currency: settings.currency,
      kpis: {
        activeSubscriptions: subsNow[0].n,
        monthlySubscriptions: byCycle.monthly || 0,
        semiannualSubscriptions: byCycle.semiannual || 0,
        annualSubscriptions: byCycle.annual || 0,
        newSubscriptionsInRange: newSubs[0].n,
        canceledInRange: canceled[0].canceled_in_range,
        scheduledToCancel: canceled[0].scheduled_to_cancel,
        grossRevenue: Number(gross.toFixed(2)),
        refunds: Number(refundedInRange.toFixed(2)),
        netRevenue: Number((gross - refundedInRange).toFixed(2)),
        successfulPayments: pay[0].successful_payments,
        failedPayments: pay[0].failed_payments,
        paymentAttempts: attempts,
        paymentSuccessRate: attempts > 0
          ? Number(((pay[0].successful_payments / attempts) * 100).toFixed(1))
          : null,
        refundCount: refundAgg[0].refund_count,
      },
      // التعريف يرافق الرقم دائماً. رقم مالي بلا تعريف يُقرأ بطريقة
      // مختلفة من كل من ينظر إليه.
      definitions: {
        activeSubscriptions:
          "لقطة لحظية: عدد المستخدمين الذين أحدثُ اشتراك لهم حالته المخزّنة active أو trialing أو past_due، ونهاية فترته المدفوعة في المستقبل. لا يتأثر بنطاق التاريخ.",
        monthlySubscriptions: "من activeSubscriptions، من دورة فوترته monthly (مدة الباقة ≤ 31 يوماً).",
        semiannualSubscriptions: "من activeSubscriptions، مدة الباقة بين 32 و186 يوماً.",
        annualSubscriptions: "من activeSubscriptions، مدة الباقة بين 187 و366 يوماً.",
        newSubscriptionsInRange: "اشتراكات بدأت (started_at) داخل النطاق.",
        canceledInRange: "اشتراكات تحمل canceled_at داخل النطاق — الإلغاء الفوري أو الناتج عن استرداد كامل.",
        scheduledToCancel: "اشتراكات سارية طُلب إلغاؤها بنهاية المدة ولم تنتهِ بعد. ليست ملغاة، لكنها لن تُجدَّد.",
        grossRevenue:
          "مجموع مبالغ الدفعات التي حُصّلت داخل النطاق (paid أو refunded أو partially_refunded)، بتاريخ التحصيل لا تاريخ إنشاء الفاتورة. شامل الضريبة.",
        refunds: "مجموع الاستردادات الناجحة التي وقعت داخل النطاق — بتاريخ وقوع الاسترداد، لا تاريخ الدفعة الأصلية.",
        netRevenue: "grossRevenue ناقص refunds. قد يكون سالباً في نطاق تكثر فيه استردادات لدفعات أقدم، وهذا صحيح لا خطأ.",
        failedPayments: "محاولات دفع حالتها failed داخل النطاق. المحاولة الفاشلة ثم الناجحة تُحسب في الاثنين لأنهما معاملتان حقيقيتان.",
        paymentSuccessRate: "successfulPayments ÷ paymentAttempts × 100، وnull حين لا توجد محاولات.",
        timezone: `كل الحدود الزمنية محسوبة بـ${tz} من billing_settings — لا بتوقيت الخادم (UTC على Render).`,
        currency: `عملة واحدة (${settings.currency}) من الإعداد المركزي؛ لا تحويل عملات في النظام، فالمبالغ تُجمع مباشرة.`,
      },
    });
  } catch (err) {
    console.error("[admin/billing] kpis failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   7) سجل أحداث الـwebhook — الرؤية وإعادة التشغيل
   ============================================================ */

billingRouter.get("/webhook-events", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const { page, pageSize, offset } = readPaging(req);
    const status = String(req.query.status || "all");
    const type = String(req.query.type || "all");

    const where = [];
    const params = [];
    const pp = (v) => `$${params.push(v)}`;
    if (status !== "all") where.push(`status = ${pp(status)}`);
    if (type !== "all") where.push(`event_type = ${pp(type)}`);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { rows: countRows } = await query(`SELECT count(*)::int AS total FROM webhook_events ${whereSql}`, params);
    const limitP = pp(pageSize);
    const offsetP = pp(offset);

    const { rows } = await query(
      `SELECT id, provider, provider_event_id, event_type, object_id, dedup_key,
              signature_valid, status, outcome, error, attempts, received_at, processed_at
       FROM webhook_events ${whereSql}
       ORDER BY received_at DESC, id DESC
       LIMIT ${limitP} OFFSET ${offsetP}`,
      params
    );

    const { rows: summary } = await query(
      `SELECT status, count(*)::int AS n FROM webhook_events GROUP BY status`
    );

    res.json({
      events: rows, page, pageSize, total: countRows[0].total,
      totalPages: Math.max(1, Math.ceil(countRows[0].total / pageSize)),
      summary: Object.fromEntries(summary.map((r) => [r.status, r.n])),
    });
  } catch (err) {
    console.error("[admin/billing] webhook events failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/** الحمولة الكاملة لحدث واحد — للتشخيص. السر منزوع منها عند التخزين. */
billingRouter.get("/webhook-events/:id", requireAdminAuth, requireRole("owner"), async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM webhook_events WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json({ event: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * POST /admin/billing/webhook-events/:id/replay  { reason }
 *
 * التعافي من الفشل: حدث فشلت معالجته لخطأ عابر (انقطاع قاعدة بيانات،
 * إعداد ضريبي ناقص وقتها) يُعاد تشغيله بحمولته المحفوظة بعد إصلاح
 * السبب — بدل انتظار إعادة محاولة من المزوّد قد تكون نافذتها انتهت.
 *
 * مقصور على الأحداث الفاشلة أو المستلمة. الحدث المعالَج لا يُعاد
 * تشغيله أبداً: كل الحماية من التكرار تفترض أن ذلك لا يحدث.
 */
billingRouter.post(
  "/webhook-events/:id/replay",
  requireAdminAuth,
  requireRole("owner"),
  // حدث webhook لا يخص مستخدماً بعينه بالضرورة — لا هدف.
  requireReasonAndLog("webhook_replay", { resolveTargetUserId: () => null }),
  async (req, res) => {
    try {
      const { rows } = await query(`SELECT id, event_type, payload, status FROM webhook_events WHERE id = $1`, [req.params.id]);
      const event = rows[0];
      if (!event) return res.status(404).json({ error: "not_found" });

      /* ------------------------------------------------------
         إعادة تشغيل حدث "processed" مسموحة عن قصد.

         كان الشرط يرفضها، بافتراض أن المعالَج معالَج فعلاً. وسقط
         هذا الافتراض على الإنتاج: حدث سُجّل processed بينما معاملته
         تراجعت بصمت (خطأ صلاحية على تسلسل الأرقام أجهض المعاملة،
         و COMMIT بعده نفّذ ROLLBACK) — فلم يبقَ ما يُعاد تشغيله ولا
         طريق لاستعادته.

         وإعادة التشغيل آمنة أصلاً: الحماية الحقيقية من التكرار على
         مستوى **الدفعة** لا الحدث. فلو كانت الدفعة مسجَّلة تعود
         النتيجة payment_already_recorded بلا أثر، ولو لم تكن مسجَّلة
         فهذا بالضبط ما نريد إصلاحه.
         ------------------------------------------------------ */
      const result = await withTransaction((client) =>
        processWebhookEvent(client, { eventType: event.event_type, body: event.payload })
      );

      if (result.needsInvoiceDocument) {
        result.invoiceNumber = await issueInvoiceDocument(result.invoiceId);
        delete result.needsInvoiceDocument;
      }
      if (result.needsCreditNote) {
        result.creditNoteNumber = await issueCreditNoteDocument(result.refundId);
        delete result.needsCreditNote;
      }

      await query(
        `UPDATE webhook_events SET status = 'processed', outcome = $1, error = NULL,
                attempts = attempts + 1, processed_at = now() WHERE id = $2`,
        [JSON.stringify({ ...result, replayed_by: req.admin.id }), event.id]
      );

      await logAdminAction({
        adminUserId: req.admin.id, action: "webhook_replay",
        oldValue: { status: event.status }, newValue: { status: "processed", outcome: result.outcome },
        reason: String(req.body?.reason || req.query?.reason), metadata: { event_id: event.id }, ipAddress: req.ip,
      });

      res.json({ ok: true, outcome: result.outcome });
    } catch (err) {
      await query(`UPDATE webhook_events SET status = 'failed', error = $1, attempts = attempts + 1 WHERE id = $2`,
        [String(err?.message || err).slice(0, 2000), req.params.id]).catch(() => {});
      console.error("[admin/billing] replay failed:", err);
      res.status(500).json({ error: "replay_failed", detail: String(err?.message || err) });
    }
  }
);

/**
 * POST /admin/billing/payments/:id/reconcile  { reason }
 * يسأل المزوّد عن حالة الدفعة الحقيقية ويطبّقها.
 * للحالة التي لا يصل فيها webhook إطلاقاً — عنوان خاطئ، انقطاع
 * طويل، أو حدث غير مسجَّل لدى المزوّد.
 */
billingRouter.post(
  "/payments/:id/reconcile",
  requireAdminAuth,
  requireRole("admin"),
  requireReasonAndLog("payment_reconcile", { resolveTargetUserId: paymentOwner }),
  async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, provider_payment_id, status FROM payments WHERE id = $1`, [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: "payment_not_found" });
      if (!rows[0].provider_payment_id) return res.status(409).json({ error: "no_provider_payment_id" });

      const providerPayment = await fetchPayment(rows[0].provider_payment_id);
      const map = { paid: "payment_paid", failed: "payment_failed", refunded: "payment_refunded", voided: "payment_voided" };
      const eventType = map[providerPayment?.status];
      if (!eventType) {
        return res.status(422).json({ error: "provider_status_not_actionable", providerStatus: providerPayment?.status });
      }

      const result = await withTransaction((client) =>
        processWebhookEvent(client, { eventType, body: { id: null, type: eventType, data: providerPayment } })
      );

      if (result.needsInvoiceDocument) {
        result.invoiceNumber = await issueInvoiceDocument(result.invoiceId);
        delete result.needsInvoiceDocument;
      }
      if (result.needsCreditNote) {
        result.creditNoteNumber = await issueCreditNoteDocument(result.refundId);
        delete result.needsCreditNote;
      }

      await logAdminAction({
        adminUserId: req.admin.id, action: "payment_reconcile",
        oldValue: { status: rows[0].status }, newValue: { providerStatus: providerPayment.status, outcome: result.outcome },
        reason: String(req.body?.reason || req.query?.reason), metadata: { payment_id: req.params.id }, ipAddress: req.ip,
      });

      res.json({ ok: true, providerStatus: providerPayment.status, outcome: result.outcome });
    } catch (err) {
      console.error("[admin/billing] reconcile failed:", err);
      res.status(500).json({ error: "reconcile_failed", detail: String(err?.message || err) });
    }
  }
);

/* ============================================================
   8) تقرير تكامل البيانات

   كل فحص هنا يقابل حالة مالية غير منطقية مطلوب منعها. الفحص لا
   يمنع بذاته — المنع في القيود والمعاملات — لكنه يكشف ما تسرّب قبل
   وجودها، وما قد يتسرّب من مسار لم يخطر على البال.
   ============================================================ */

billingRouter.get("/integrity", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const [
      { rows: subsNoPayment },
      { rows: paidInvoiceFailedPayment },
      { rows: dupTxn },
      { rows: dupInvoiceNumber },
      { rows: orphanInvoices },
      { rows: overRefunded },
      { rows: refundsNoCreditNote },
      { rows: paidNoZatca },
      { rows: orphanPayments },
    ] = await Promise.all([
      // اشتراك فعّال بلا أي دفعة ناجحة، وسعره أكبر من صفر.
      query(
        `SELECT s.id, s.user_id, s.plan_id, s.current_period_end
         FROM (SELECT DISTINCT ON (user_id) * FROM subscriptions ORDER BY user_id, created_at DESC) s
         WHERE ${entitledSql("s")}
           AND NOT EXISTS (
             SELECT 1 FROM payments p
             WHERE p.user_id = s.user_id AND p.status IN ('paid','partially_refunded')
           )
         LIMIT 100`
      ),
      // فاتورة مدفوعة ودفعتها فاشلة — تناقض صريح.
      query(
        `SELECT i.id AS invoice_id, i.zatca_invoice_number, p.id AS payment_id, p.status AS payment_status
         FROM invoices i JOIN payments p ON p.invoice_id = i.id
         WHERE i.status = 'paid' AND p.status = 'failed'
           AND NOT EXISTS (SELECT 1 FROM payments p2 WHERE p2.invoice_id = i.id AND p2.status IN ('paid','refunded','partially_refunded'))
         LIMIT 100`
      ),
      // أرقام معاملات مكررة. الفهرس الفريد على payments يمنعها من
      // الآن، لكن invoices لا يمكن فهرسته (قيد الملكية) فيبقى الفحص.
      query(
        `SELECT provider_payment_id, count(*)::int AS n FROM invoices
         WHERE provider_payment_id IS NOT NULL
         GROUP BY 1 HAVING count(*) > 1 LIMIT 100`
      ),
      query(
        `SELECT zatca_invoice_number, count(*)::int AS n FROM invoices
         WHERE zatca_invoice_number IS NOT NULL
         GROUP BY 1 HAVING count(*) > 1 LIMIT 100`
      ),
      // فاتورة مدفوعة لا تشير إلى اشتراك — يتيمة من جهة الاشتراك.
      query(
        `SELECT id, user_id, plan_id, amount_sar, created_at FROM invoices
         WHERE status IN ('paid','refunded') AND subscription_id IS NULL LIMIT 100`
      ),
      query(
        `SELECT id, user_id, amount, refunded_amount FROM payments
         WHERE refunded_amount > amount LIMIT 100`
      ),
      query(
        `SELECT r.id, r.payment_id, r.amount, r.created_at FROM refunds r
         WHERE r.status = 'succeeded' AND r.credit_note_id IS NULL LIMIT 100`
      ),
      query(
        `SELECT id, user_id, amount_sar, created_at FROM invoices
         WHERE status = 'paid' AND zatca_invoice_number IS NULL LIMIT 100`
      ),
      // دفعة تشير إلى فاتورة غير موجودة — الرابط منطقي بلا قيد
      // مرجعي (انظر رأس الترحيل 004)، فهذا هو ما يعوّض عنه.
      query(
        `SELECT p.id, p.invoice_id FROM payments p
         WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = p.invoice_id) LIMIT 100`
      ),
    ]);

    const checks = [
      { key: "active_subscription_without_successful_payment", severity: "high",
        description: "اشتراك ساري المفعول بلا أي دفعة ناجحة على الحساب.",
        count: subsNoPayment.length, samples: subsNoPayment },
      { key: "paid_invoice_with_failed_payment_only", severity: "high",
        description: "فاتورة معلّمة مدفوعة وكل دفعاتها فاشلة.",
        count: paidInvoiceFailedPayment.length, samples: paidInvoiceFailedPayment },
      { key: "duplicate_transaction_ids", severity: "high",
        description: "رقم معاملة واحد لدى المزوّد مرتبط بأكثر من فاتورة.",
        count: dupTxn.length, samples: dupTxn },
      { key: "duplicate_invoice_numbers", severity: "critical",
        description: "رقم فاتورة ضريبية مكرر. يمنعه قيد فريد، ووجوده هنا يعني تلاعباً مباشراً بالقاعدة.",
        count: dupInvoiceNumber.length, samples: dupInvoiceNumber },
      { key: "orphan_paid_invoices", severity: "medium",
        description: "فاتورة مدفوعة غير مرتبطة بأي اشتراك.",
        count: orphanInvoices.length, samples: orphanInvoices },
      { key: "refund_exceeds_captured", severity: "critical",
        description: "مبلغ مسترد أكبر من المحصَّل. يمنعه قيد CHECK على الجدول.",
        count: overRefunded.length, samples: overRefunded },
      { key: "succeeded_refund_without_credit_note", severity: "medium",
        description: "استرداد نجح دون إصدار إشعار دائن — يحتاج تسوية يدوية.",
        count: refundsNoCreditNote.length, samples: refundsNoCreditNote },
      { key: "paid_invoice_without_tax_number", severity: "high",
        description: "فاتورة مدفوعة بلا رقم ضريبي. أعد التوليد من صفحة الفواتير بعد ضبط الإعدادات الضريبية.",
        count: paidNoZatca.length, samples: paidNoZatca },
      { key: "payment_pointing_to_missing_invoice", severity: "high",
        description: "دفعة تشير إلى فاتورة غير موجودة.",
        count: orphanPayments.length, samples: orphanPayments },
    ];

    const totalIssues = checks.reduce((sum, c) => sum + c.count, 0);
    res.json({ ok: totalIssues === 0, totalIssues, checkedAt: new Date().toISOString(), checks });
  } catch (err) {
    console.error("[admin/billing] integrity failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ============================================================
   9) الإعداد المالي المركزي
   ============================================================ */

billingRouter.get("/settings", requireAdminAuth, requireRole("admin"), async (req, res) => {
  try {
    const settings = await getBillingSettings();
    const { rows } = await query(`SELECT updated_at, updated_by FROM billing_settings LIMIT 1`);
    res.json({ settings: { ...settings, updatedAt: rows[0]?.updated_at || null } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/**
 * PUT /admin/billing/settings  { vatRate?, pricesIncludeVat?, currency?, reportingTimezone?, reason }
 *
 * محصور بـowner ومشروط بسبب مكتوب: تغيير النسبة يغيّر كل فاتورة
 * تصدر بعده. الفواتير الصادرة لا تتأثر — نسبتها مجمّدة في
 * invoice_state وقت إصدارها.
 */
billingRouter.put(
  "/settings",
  requireAdminAuth,
  requireRole("owner"),
  // إعداد عام للنظام كله — لا مستخدم هدفاً له.
  requireReasonAndLog("update_billing_settings", { resolveTargetUserId: () => null }),
  async (req, res) => {
    try {
      const { vatRate, pricesIncludeVat, currency, reportingTimezone,
              invoiceNumberPrefix, creditNoteNumberPrefix } = req.body || {};

      if (vatRate !== undefined) {
        const r = Number(vatRate);
        if (!Number.isFinite(r) || r < 0 || r >= 1) {
          return res.status(400).json({
            error: "vat_rate_must_be_between_0_and_1",
            message: "النسبة تُكتب ككسر عشري: 0.15 لخمسة عشر بالمئة، لا 15.",
          });
        }
      }
      if (currency !== undefined && !/^[A-Z]{3}$/.test(String(currency))) {
        return res.status(400).json({ error: "currency_must_be_3_letter_code" });
      }
      if (reportingTimezone !== undefined) {
        // تحقق حقيقي من صلاحية المنطقة بدل قبول أي نص: منطقة خاطئة
        // تكسر كل استعلامات المؤشرات لاحقاً بخطأ غامض.
        try { new Intl.DateTimeFormat("en", { timeZone: String(reportingTimezone) }); }
        catch { return res.status(400).json({ error: "invalid_timezone" }); }
      }

      const before = await getBillingSettings();

      const { rows } = await query(
        `UPDATE billing_settings SET
           vat_rate = COALESCE($1, vat_rate),
           prices_include_vat = COALESCE($2, prices_include_vat),
           currency = COALESCE($3, currency),
           reporting_timezone = COALESCE($4, reporting_timezone),
           invoice_number_prefix = COALESCE($5, invoice_number_prefix),
           credit_note_number_prefix = COALESCE($6, credit_note_number_prefix),
           updated_by = $7, updated_at = now()
         WHERE singleton = true
         RETURNING vat_rate, prices_include_vat, currency, reporting_timezone,
                   invoice_number_prefix, credit_note_number_prefix, updated_at`,
        [
          vatRate === undefined ? null : Number(vatRate),
          pricesIncludeVat === undefined ? null : !!pricesIncludeVat,
          currency === undefined ? null : String(currency),
          reportingTimezone === undefined ? null : String(reportingTimezone),
          invoiceNumberPrefix === undefined ? null : String(invoiceNumberPrefix),
          creditNoteNumberPrefix === undefined ? null : String(creditNoteNumberPrefix),
          req.admin.id,
        ]
      );
      if (!rows[0]) return res.status(404).json({ error: "settings_row_missing_run_migration_004" });

      await logAdminAction({
        adminUserId: req.admin.id, action: "update_billing_settings",
        oldValue: { vatRate: before.vatRate, currency: before.currency, pricesIncludeVat: before.pricesIncludeVat, reportingTimezone: before.reportingTimezone },
        newValue: {
          vatRate: Number(rows[0].vat_rate), currency: rows[0].currency,
          pricesIncludeVat: rows[0].prices_include_vat, reportingTimezone: rows[0].reporting_timezone,
        },
        reason: String(req.body?.reason || req.query?.reason), ipAddress: req.ip,
      });

      res.json({ settings: rows[0] });
    } catch (err) {
      console.error("[admin/billing] settings update failed:", err);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

/* ============================================================
   10) User 360 — كل ما يخص مستخدماً واحداً مالياً في نداء واحد
   ============================================================ */

billingRouter.get("/users/:id/billing", requireAdminAuth, requireRole("support"), async (req, res) => {
  try {
    const userId = req.params.id;
    const settings = await getBillingSettings();

    const [{ rows: subs }, { rows: pays }, { rows: invs }, { rows: notes }, { rows: refs }] = await Promise.all([
      query(
        `SELECT s.id, s.plan_id, sp.name AS plan_name, s.status AS stored_status,
                ${effectiveStatusSql("s", "ss")} AS status,
                ${entitledSql("s")} AS entitled,
                s.started_at, ss.current_period_start, s.current_period_end,
                s.canceled_at, ss.cancel_at_period_end, ss.billing_cycle,
                ss.plan_price_sar, COALESCE(ss.currency, 'SAR') AS currency,
                s.payment_provider AS provider, ss.renewal_mode, s.created_at
         FROM subscriptions s
         LEFT JOIN subscription_state ss ON ss.subscription_id = s.id
         LEFT JOIN subscription_plans sp ON sp.plan_key = s.plan_id
         WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
        [userId]
      ),
      query(
        `SELECT p.id, p.invoice_id, p.subscription_id, p.amount, p.currency, p.method,
                p.card_brand, p.card_last4, p.provider, p.provider_payment_id AS transaction_id,
                p.status, p.failure_reason, p.refunded_amount, p.captured_at, p.created_at
         FROM payments p WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT 100`,
        [userId]
      ),
      query(
        `SELECT i.id, i.zatca_invoice_number AS invoice_number, i.subscription_id, i.plan_id,
                i.amount_sar, i.subtotal_sar, i.vat_sar, i.status, i.zatca_issued_at, i.created_at,
                COALESCE(st.currency, 'SAR') AS currency, st.vat_rate,
                (i.pdf_data IS NOT NULL) AS has_pdf
         FROM invoices i LEFT JOIN invoice_state st ON st.invoice_id = i.id
         WHERE i.user_id = $1 ORDER BY i.created_at DESC LIMIT 100`,
        [userId]
      ),
      query(
        `SELECT cn.id, cn.zatca_credit_note_number AS credit_note_number, cn.amount_sar,
                cn.reason, cn.zatca_issued_at, i.zatca_invoice_number AS original_invoice_number
         FROM credit_notes cn JOIN invoices i ON i.id = cn.original_invoice_id
         WHERE cn.user_id = $1 ORDER BY cn.zatca_issued_at DESC LIMIT 50`,
        [userId]
      ),
      query(
        `SELECT id, payment_id, amount, kind, status, reason, initiated_by, created_at
         FROM refunds WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [userId]
      ),
    ]);

    const lifetimeGross = pays
      .filter((p) => ["paid", "refunded", "partially_refunded"].includes(p.status))
      .reduce((s, p) => s + Number(p.amount), 0);
    const lifetimeRefunded = pays.reduce((s, p) => s + Number(p.refunded_amount || 0), 0);

    res.json({
      userId,
      currency: settings.currency,
      currentSubscription: subs[0] || null,
      subscriptions: subs,
      payments: pays,
      invoices: invs,
      creditNotes: notes,
      refunds: refs,
      totals: {
        lifetimeGross: Number(lifetimeGross.toFixed(2)),
        lifetimeRefunded: Number(lifetimeRefunded.toFixed(2)),
        lifetimeNet: Number((lifetimeGross - lifetimeRefunded).toFixed(2)),
      },
    });
  } catch (err) {
    console.error("[admin/billing] user 360 failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});
