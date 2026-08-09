import { effectiveStatusSql } from "../billing/subscription.js";

/* ============================================================
   بنّاؤو شروط القوائم المالية — مشتركون بين الشاشة والتصدير.

   ------------------------------------------------------------
   لماذا في ملف مستقل
   ------------------------------------------------------------
   المرحلة 5 §8 تطلب من التقارير أن تحترم «الفلاتر الحالية». وأسهل
   طريق لكسر ذلك أن يبني ملف CSV شرطه بنفسه: يبدأ مطابقاً للشاشة،
   ثم يُضاف فلتر إلى الشاشة ولا يُضاف إليه، فيخرج ملف يقول غير ما
   يقوله المسؤول الذي صدّره — وهو يظنه نفس الشيء.

   وهذا ليس افتراضاً في هذا المشروع تحديداً: شرط النشر في المرحلة 4
   وُحِّد في PUBLISHED_SQL لهذا السبب بالذات، والوثيقة التي وصفت
   استعلاماً إدارياً وصفاً لم يعد صحيحاً كلّفت تسريب نص اليومية.

   فالشاشة والتصدير ينادِيان نفس الدالة. لا يمكن أن يختلفا لأنه لا
   يوجد نسختان.

   ------------------------------------------------------------
   شكل الرد
   ------------------------------------------------------------
   كل بنّاء يعيد:
     fromAndJoins  نص FROM/JOIN/WHERE جاهز للدمج
     params        مصفوفة المعاملات حتى الآن
     next(v)       يدفع معاملاً جديداً ويعيد اسمه ($7 مثلاً) —
                   يحتاجه المنادي لـLIMIT/OFFSET
     orderBy       عمود الترتيب وجهته، من قائمة بيضاء
     filters       ما طُبِّق فعلاً — يُعاد للواجهة ويُكتب في رأس CSV

   ⚠️ عمود الترتيب يُدمج في نص الاستعلام، وهو آمن **فقط** لأن قيمته
   تأتي من بحث مفتاح في قائمة بيضاء لا من الطلب. لا تُضِف فرعاً
   يمرّر req.query مباشرة.

   ------------------------------------------------------------
   ملاحظة على التوزيع
   ------------------------------------------------------------
   بنّاءا قائمة المستخدمين وسجل التدقيق يعيشان في admin/routes.js
   ويُصدَّران من هناك (buildUserListFilter و buildAuditFilter). لم
   يُنقلا إلى هنا لأن نقلهما يعني تعديل ملف ثالث بلا مكسب: لا
   ازدواج في الحالتين، والتصدير يستوردهما من موضعهما. الاتساق
   الشكلي لا يستحق رفعة إضافية.
   ============================================================ */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** تهريب محارف ILIKE الخاصة — بدونه يصير `%` بحثاً عن كل شيء. */
export function likeTerm(search) {
  return `%${search.replace(/[%_\\]/g, "\\$&")}%`;
}

/** ترقيم موحّد: حد أقصى صارم حتى لا يستنزف طلبٌ واحد الذاكرة. */
export function readPaging(req, { defaultSize = 25, maxSize = 100 } = {}) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(req.query.pageSize, 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function orderFrom(map, sortKey, dirRaw, fallback) {
  const col = map[String(sortKey || "")] || fallback;
  const dir = String(dirRaw || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  return { col, dir };
}

/* ------------------------------------------------------------
   الاشتراكات
   ------------------------------------------------------------ */
export const SUBSCRIPTION_SORT = {
  created_at: "s.created_at",
  period_end: "s.current_period_end",
  started_at: "s.started_at",
  price: "ss.plan_price_sar",
  user: "u.name",
};

export function buildSubscriptionFilter(q) {
  const search = String(q.search || "").trim();
  const status = String(q.status || "all");
  const planId = String(q.plan || "all");
  const cycle = String(q.cycle || "all");
  const provider = String(q.provider || "all");
  const from = String(q.from || "").trim();
  const to = String(q.to || "").trim();

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

  return {
    fromAndJoins, params, next: p, statusExpr,
    orderBy: orderFrom(SUBSCRIPTION_SORT, q.sort, q.dir, "s.created_at"),
    filters: { search, status, plan: planId, cycle, provider, from, to },
  };
}

/* ------------------------------------------------------------
   المدفوعات
   ------------------------------------------------------------ */
export const PAYMENT_SORT = {
  created_at: "p.created_at",
  captured_at: "p.captured_at",
  amount: "p.amount",
  user: "u.name",
};

export function buildPaymentFilter(q) {
  const search = String(q.search || "").trim();
  const status = String(q.status || "all");
  const method = String(q.method || "all");
  const provider = String(q.provider || "all");
  const from = String(q.from || "").trim();
  const to = String(q.to || "").trim();

  const where = [];
  const params = [];
  const p = (v) => `$${params.push(v)}`;

  if (search) {
    if (UUID_RE.test(search)) {
      where.push(`(p.id = ${p(search)} OR p.user_id = ${p(search)} OR p.invoice_id = ${p(search)})`);
    } else {
      const t = likeTerm(search);
      // رقم المعاملة يُبحث عنه كنص كامل أيضاً — وهو أول ما يُلصق
      // في مربع البحث عند مطابقة كشف حساب المزوّد.
      where.push(`(u.name ILIKE ${p(t)} OR u.email ILIKE ${p(t)} OR p.provider_payment_id ILIKE ${p(t)})`);
    }
  }
  if (status !== "all") where.push(`p.status = ${p(status)}`);
  if (method !== "all") where.push(`p.method = ${p(method)}`);
  if (provider !== "all") where.push(`p.provider = ${p(provider)}`);
  if (from) where.push(`p.created_at >= ${p(from)}`);
  if (to) where.push(`p.created_at < (${p(to)}::date + interval '1 day')`);

  const fromAndJoins = `
    FROM payments p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN invoices i ON i.id = p.invoice_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;

  return {
    fromAndJoins, params, next: p,
    orderBy: orderFrom(PAYMENT_SORT, q.sort, q.dir, "p.created_at"),
    filters: { search, status, method, provider, from, to },
  };
}

/* ------------------------------------------------------------
   الفواتير
   ------------------------------------------------------------ */
export const INVOICE_SORT = {
  created_at: "i.created_at",
  issued_at: "i.zatca_issued_at",
  amount: "i.amount_sar",
  number: "i.zatca_invoice_number",
  user: "u.name",
};

export function buildInvoiceFilter(q) {
  const search = String(q.search || "").trim();
  const status = String(q.status || "all");
  const planId = String(q.plan || "all");
  const from = String(q.from || "").trim();
  const to = String(q.to || "").trim();

  const where = [];
  const params = [];
  const p = (v) => `$${params.push(v)}`;

  if (search) {
    if (UUID_RE.test(search)) {
      where.push(`(i.id = ${p(search)} OR i.user_id = ${p(search)})`);
    } else {
      const t = likeTerm(search);
      where.push(`(u.name ILIKE ${p(t)} OR u.email ILIKE ${p(t)} OR i.zatca_invoice_number ILIKE ${p(t)})`);
    }
  }
  if (status !== "all") where.push(`i.status = ${p(status)}`);
  if (planId !== "all") where.push(`i.plan_id = ${p(planId)}`);
  if (from) where.push(`i.created_at >= ${p(from)}`);
  if (to) where.push(`i.created_at < (${p(to)}::date + interval '1 day')`);

  const fromAndJoins = `
    FROM invoices i
    JOIN users u ON u.id = i.user_id
    LEFT JOIN invoice_state st ON st.invoice_id = i.id
    LEFT JOIN subscription_plans sp ON sp.plan_key = i.plan_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;

  return {
    fromAndJoins, params, next: p, hasWhere: where.length > 0,
    orderBy: orderFrom(INVOICE_SORT, q.sort, q.dir, "i.created_at"),
    filters: { search, status, plan: planId, from, to },
  };
}

/* ------------------------------------------------------------
   الاستردادات

   لا فلاتر على الشاشة اليوم — والبنّاء موجود مع ذلك ليكون للتصدير
   والشاشة نفس المدخل يوم يُضاف أول فلتر، فلا يُضاف في مكان واحد.
   ------------------------------------------------------------ */
export function buildRefundFilter(q) {
  const status = String(q.status || "all");
  const from = String(q.from || "").trim();
  const to = String(q.to || "").trim();

  const where = [];
  const params = [];
  const p = (v) => `$${params.push(v)}`;

  if (status !== "all") where.push(`r.status = ${p(status)}`);
  if (from) where.push(`r.created_at >= ${p(from)}`);
  if (to) where.push(`r.created_at < (${p(to)}::date + interval '1 day')`);

  const fromAndJoins = `
    FROM refunds r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN credit_notes cn ON cn.id = r.credit_note_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;

  return {
    fromAndJoins, params, next: p,
    orderBy: { col: "r.created_at", dir: "DESC" },
    filters: { status, from, to },
  };
}
