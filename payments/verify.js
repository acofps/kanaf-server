/* ============================================================
   التحقق المالي لحدث الدفع — موضع واحد يحكم المنافذ الثلاثة
   (webhook، replay من اللوحة، reconcile ومراجعة المعلّق) — KANAF-ORD-0003 N-02

   كان handlePaymentPaid يقبل حدث «مدفوع» بأي مبلغ وعملة وحالة: صف الدفعة يسجّل مبلغ الحدث،
   والاستحقاق والوثيقة الضريبية يُبنيان على مبلغ الفاتورة المحلية — فاختلاف صامت بين المال
   المسجَّل وما مُنح ووُثّق. التحقق هنا يمنع عدم المطابقة؛ لا يغيّر سعراً ولا وثيقة ليساير حدثاً.

   ما يُفحص (بأصغر وحدة نقدية، بدقة):
   - معرّف الدفعة موجود؛ ونوع الحدث يطابق حالة البيانات (العقد في الكود: payment_paid↔paid،
     payment_failed↔failed، payment_voided↔voided — نفس خريطة reconcile؛ docs.moyasar.com محجوب
     من بيئة التنفيذ، فالتحقق الحي من العقد يتبع D-05).
   - هوية الفاتورة: ثلاث طرق ربط (invoice_id لدى المزوّد، metadata.kanaf_invoice_id، معرّف الدفعة)
     تُحل كلها؛ إن أشارت إلى فاتورتين مختلفتين ← تعارض، لا اختيار صامت للأول. metadata قرينة ربط
     لا تفويض بنقل دفعة.
   - صف دفعة قائم بمعرّف المزوّد يجب أن يخص الفاتورة نفسها ومالكها؛ لا يُغيَّر invoice_id ولا user_id.
   - حالة الفاتورة: pending/failed قابلة للدفع؛ paid بنفس الدفعة = تكرار صحيح (قد يلزمه استكمال
     الوثيقة فقط)؛ paid بدفعة أخرى = دفعة ثانية تُعزل للمطابقة؛ refunded = لا تُدفع.
   - المبلغ: عدد صحيح موجب بالهللة، مساوٍ للمتوقع. مفقود/غير صالح/سالب/كسري ← رفض (لا يتحول إلى
     صفر ولا إلى مبلغ الفاتورة).
   - العملة: ثلاثة أحرف كبيرة، مساوية للمتوقع. مفقودة أو مختلفة ← رفض.
   - المتوقع: invoice_payment_expectations (يُكتب مع الفاتورة)؛ وللفواتير الأقدم بلا صف (legacy):
     المبلغ = invoices.amount_sar المحفوظ وقت الإنشاء، والعملة = الإعداد الحالي فقط إن لم يُسجَّل
     في admin_action_log أي تغيير للعملة بعد إنشاء الفاتورة؛ وإلا يُعلَّق الحدث (لا تخمين).
   - تحقق المزوّد (اختياري، خلف KANAF_PAYMENT_PROVIDER_VERIFY، معطّل افتراضياً — D-05): بيانات
     المزوّد المقروءة خارج المعاملة تُطابَق هنا تحت القفل؛ اختلافها عن الحمولة رفض.
   ============================================================ */

export const HOLD_REASONS = Object.freeze({
  missing_payment_id: "معرّف الدفعة غائب في الحدث",
  status_mismatch: "نوع الحدث لا يطابق حالة الدفعة في بياناته",
  invoice_identity_conflict: "معرّفات الفاتورة في الحدث تشير إلى فاتورتين مختلفتين",
  payment_invoice_conflict: "الدفعة مسجّلة لفاتورة أو مستخدم آخر",
  second_payment_for_paid_invoice: "دفعة ثانية لفاتورة مسدَّدة بدفعة أخرى — تُعزل للمطابقة",
  invoice_not_payable: "الفاتورة في حالة لا تقبل دفعاً (مستردة)",
  amount_missing: "المبلغ غائب في الحدث",
  amount_invalid: "المبلغ غير صالح (ليس عدداً صحيحاً موجباً بالهللة)",
  amount_mismatch: "المبلغ الوارد لا يطابق المتوقع للفاتورة",
  currency_missing: "العملة غائبة في الحدث",
  currency_invalid: "العملة ليست رمزاً من ثلاثة أحرف",
  currency_mismatch: "العملة الواردة لا تطابق المتوقعة للفاتورة",
  legacy_currency_unverifiable: "فاتورة قديمة بلا عملة محفوظة، وتغيّرت العملة في الإعدادات بعد إنشائها",
  provider_disagrees: "بيانات المزوّد لا تطابق الحمولة أو المتوقع",
  provider_unverified: "تعذّر التحقق من المزوّد (مهلة أو خطأ) — يحتاج محاولة لاحقة",
  refund_amount_missing: "إجمالي المسترد غائب في حدث الاسترداد",
  refund_amount_invalid: "إجمالي المسترد غير صالح أو أكبر من مبلغ الدفعة",
  refund_currency_mismatch: "عملة حدث الاسترداد لا تطابق عملة الدفعة",
});

const EXPECTED_STATUS = { payment_paid: "paid", payment_failed: "failed", payment_voided: "voided" };
const isHalalas = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;
const sarToHalalas = (v) => Math.round(Number(v) * 100);

/** حمولة الحدث المختصرة الآمنة للعرض والسجل (لا بيانات بطاقة). */
export function receivedSummary(data) {
  return {
    payment_id: data?.id ?? null,
    status: data?.status ?? null,
    amount: data?.amount ?? null,
    currency: data?.currency ?? null,
    provider_invoice_id: data?.invoice_id ?? null,
    metadata_invoice_id: data?.metadata?.kanaf_invoice_id ?? null,
  };
}

const hold = (reason, extra = {}) => ({ ok: false, hold: true, reason, ...extra });

/** الفاتورة المقابلة بطرق الربط الثلاث، كلها، تحت قفل. */
async function resolveInvoice(client, data) {
  const found = new Map();
  const pick = async (sql, v) => {
    if (!v) return;
    const { rows } = await client.query(sql, [v]);
    for (const r of rows) found.set(r.id, r);
  };
  const cols = "id, user_id, plan_id, amount_sar, status, provider_payment_id, zatca_invoice_number, created_at";
  await pick(`SELECT ${cols} FROM invoices WHERE provider_invoice_id = $1 FOR UPDATE`, data?.invoice_id);
  const meta = data?.metadata?.kanaf_invoice_id;
  if (meta && /^[0-9a-f-]{36}$/i.test(String(meta))) await pick(`SELECT ${cols} FROM invoices WHERE id = $1 FOR UPDATE`, meta);
  await pick(`SELECT ${cols} FROM invoices WHERE provider_payment_id = $1 FOR UPDATE`, data?.id);
  return [...found.values()];
}

/** المتوقع للفاتورة: الصف المحفوظ، أو قاعدة legacy الموثقة أعلاه. */
export async function expectationFor(client, invoice, currentCurrency) {
  const { rows } = await client.query(
    `SELECT amount_halalas, currency FROM invoice_payment_expectations WHERE invoice_id = $1`, [invoice.id]);
  if (rows[0]) return { amount: Number(rows[0].amount_halalas), currency: rows[0].currency, basis: "recorded_at_invoice_creation" };
  const { rows: changes } = await client.query(
    `SELECT 1 FROM admin_action_log
      WHERE action = 'update_billing_settings' AND created_at > $1
        AND (old_value->>'currency') IS DISTINCT FROM (new_value->>'currency')
      LIMIT 1`, [invoice.created_at]);
  if (changes[0]) return { amount: sarToHalalas(invoice.amount_sar), currency: null, basis: "legacy_currency_changed_since_invoice" };
  return { amount: sarToHalalas(invoice.amount_sar), currency: currentCurrency, basis: "legacy_invoice_amount_and_unchanged_currency" };
}

/**
 * يفحص حدث payment_paid / payment_failed / payment_voided تحت قفل الفاتورة والدفعة.
 * يعيد { ok:true, invoice, expected, existingPayment } أو { ok:false, hold:true, reason, … }
 * أو { ok:false, unmatched:true } أو { ok:false, duplicate:true, invoice } (الدفعة نفسها مسجّلة).
 * `provider` (اختياري): بيانات المزوّد المقروءة خارج المعاملة عند تفعيل التحقق منه.
 */
export async function verifyPaymentEvent(client, { eventType, data, currency, provider }) {
  const received = receivedSummary(data);
  if (!data?.id) return hold("missing_payment_id", { received });
  const wantStatus = EXPECTED_STATUS[eventType];
  if (wantStatus && data.status !== wantStatus) return hold("status_mismatch", { received, expected: { status: wantStatus } });

  const candidates = await resolveInvoice(client, data);
  if (candidates.length === 0) return { ok: false, unmatched: true, received };
  if (candidates.length > 1) return hold("invoice_identity_conflict", { received, expected: { invoice_ids: candidates.map((c) => c.id) } });
  const invoice = candidates[0];

  const { rows: pay } = await client.query(
    `SELECT id, invoice_id, user_id, status, amount, currency FROM payments
      WHERE provider = 'moyasar' AND provider_payment_id = $1 FOR UPDATE`, [data.id]);
  const existingPayment = pay[0] || null;
  if (existingPayment && (existingPayment.invoice_id !== invoice.id || existingPayment.user_id !== invoice.user_id)) {
    return hold("payment_invoice_conflict", { received, invoice, expected: { invoice_id: existingPayment.invoice_id } });
  }

  if (eventType !== "payment_paid") return { ok: true, invoice, existingPayment, received };

  /* --- payment_paid فقط: حالة الفاتورة والمبلغ والعملة --- */
  if (invoice.status === "paid") {
    if (invoice.provider_payment_id && invoice.provider_payment_id !== data.id) {
      return hold("second_payment_for_paid_invoice", { received, invoice, expected: { paid_by_payment_id: invoice.provider_payment_id } });
    }
    return { ok: false, duplicate: true, invoice, existingPayment, received };
  }
  if (invoice.status === "refunded") return hold("invoice_not_payable", { received, invoice, expected: { invoice_status: invoice.status } });

  const expected = await expectationFor(client, invoice, currency);
  const exp = { amount: expected.amount, currency: expected.currency, basis: expected.basis };
  if (data.amount === undefined || data.amount === null) return hold("amount_missing", { received, invoice, expected: exp });
  if (!isHalalas(data.amount)) return hold("amount_invalid", { received, invoice, expected: exp });
  if (data.currency === undefined || data.currency === null || data.currency === "") return hold("currency_missing", { received, invoice, expected: exp });
  if (typeof data.currency !== "string" || !/^[A-Z]{3}$/.test(data.currency)) return hold("currency_invalid", { received, invoice, expected: exp });
  if (!expected.currency) return hold("legacy_currency_unverifiable", { received, invoice, expected: exp });
  if (data.amount !== expected.amount) return hold("amount_mismatch", { received, invoice, expected: exp });
  if (data.currency !== expected.currency) return hold("currency_mismatch", { received, invoice, expected: exp });

  if (provider) {
    const p = receivedSummary(provider);
    const agrees = provider.id === data.id && provider.status === "paid" && provider.amount === expected.amount && provider.currency === expected.currency;
    if (!agrees) return hold("provider_disagrees", { received, invoice, expected: { ...exp, provider: p } });
  }
  return { ok: true, invoice, existingPayment, expected: exp, received };
}

/**
 * إجمالي المسترد كما يرسله المزوّد في كائن الدفعة — مصدر واحد لكل القارئين (KANAF-ORD-0004 COR-02):
 * حدث payment_refunded، ومفتاح منع تكرار الحدث، ورد الاسترداد الإداري (refund.js)، والمطابقة.
 *   - الحقل الموثق لدى المزوّد: `refunded` (عدد صحيح بالهللة، ≤ مبلغ الدفعة) — وثائق ميسّر العامة كما
 *     قرأها المستشار بخلاصة (ORD-0004 أ-5)؛ التأكيد على حمولة حية يتبع D-05.
 *   - `refunded_amount`: الاسم الذي قرأه هذا الكود منذ baseline بلا مصدر موثق في المستودع. يُقبل اسماً
 *     بديلاً **وحده** (لا يُكسر تكامل قائم لو كان المزوّد يرسله فعلاً)، ويُتحقق منه بالقواعد نفسها.
 *   - الحقلان معاً بقيمتين مختلفتين ← تعارض (لا اختيار صامت). الحقلان غائبان ← غياب (لا قيمة مفقودة
 *     تتحول إلى مبلغ). القيمة غير عدد صحيح غير سالب ← غير صالحة.
 * يعيد { ok:true, halalas, field } أو { ok:false, reason, fields }.
 */
export function providerRefundedTotal(data) {
  const has = (v) => v !== undefined && v !== null;
  const a = data?.refunded, b = data?.refunded_amount;
  const fields = { refunded: has(a) ? a : null, refunded_amount: has(b) ? b : null };
  if (!has(a) && !has(b)) return { ok: false, reason: "refund_amount_missing", fields };
  if (has(a) && has(b) && a !== b) return { ok: false, reason: "refund_total_conflict", fields };
  const v = has(a) ? a : b;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return { ok: false, reason: "refund_amount_invalid", fields };
  return { ok: true, halalas: v, field: has(a) ? "refunded" : "refunded_amount", fields };
}

/** حدث الاسترداد: المبلغ الإجمالي المسترد والعملة مقابل صف الدفعة القائم. */
export function verifyRefundEvent(payment, data) {
  const received = receivedSummary(data);
  const t = providerRefundedTotal(data);
  Object.assign(received, t.fields);
  if (!t.ok) return hold(t.reason, { received });
  const cap = sarToHalalas(payment.amount);
  if (t.halalas > cap) return hold("refund_amount_invalid", { received, expected: { max_refund: cap } });
  if (data.currency !== undefined && data.currency !== null && payment.currency && data.currency !== payment.currency) {
    return hold("refund_currency_mismatch", { received, expected: { currency: payment.currency } });
  }
  return { ok: true, received, totalHalalas: t.halalas };
}

/** يسجّل حدثاً معلّقاً (صف واحد مفتوح لكل دفعة/نوع/سبب؛ التكرار يزيد العدّاد). */
export async function recordHold(client, { kind = "mismatch", reason, source, eventType, webhookEventId = null, data, invoice = null, expected = null, received = null }) {
  const { rows } = await client.query(
    `INSERT INTO payment_event_holds
       (kind, reason, source, event_type, webhook_event_id, provider_payment_id, invoice_id, expected, received)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
     ON CONFLICT (COALESCE(provider_payment_id, ''), event_type, reason) WHERE status = 'open'
       DO UPDATE SET seen_count = payment_event_holds.seen_count + 1, updated_at = now(),
                     webhook_event_id = COALESCE(EXCLUDED.webhook_event_id, payment_event_holds.webhook_event_id)
     RETURNING id`,
    [kind, reason, source, eventType, webhookEventId, data?.id || null, invoice?.id || null,
      JSON.stringify(expected), JSON.stringify(received || receivedSummary(data))]
  );
  return rows[0].id;
}

/** إغلاق المعلّقات المفتوحة لدفعة بعد قبولها عبر أي منفذ. */
export async function resolveHoldsFor(client, providerPaymentId, resolution, eventType = null) {
  if (!providerPaymentId) return 0;
  /* eventType: لحدث الاسترداد تُحل حجوزات payment_refunded وحدها (COR-02) — قبول استرداد لا يقبل حدث دفع محجوزاً */
  const { rowCount } = await client.query(
    `UPDATE payment_event_holds SET status = 'resolved', resolution = $2::jsonb, resolved_at = now(), updated_at = now()
      WHERE provider_payment_id = $1 AND status = 'open' AND ($3::text IS NULL OR event_type = $3)`,
    [providerPaymentId, JSON.stringify(resolution), eventType]);
  return rowCount;
}

/* ---------- تحقق المزوّد (خلف مفتاح، معطّل افتراضياً) ---------- */
export function providerVerifyEnabled() { return process.env.KANAF_PAYMENT_PROVIDER_VERIFY === "1"; }

/**
 * يقرأ الدفعة من المزوّد خارج أي معاملة (لا قفل أثناء الاتصال الخارجي)، بمهلة ومحاولتين.
 * يعيد { ok:true, data } أو { ok:false, error }. لا يسقط إلى الثقة بالحمولة.
 */
export async function fetchProviderPayment(fetchPayment, paymentId, { attempts = 2, backoffMs = 500 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try { return { ok: true, data: await fetchPayment(paymentId) }; }
    catch (e) { last = e; if (i + 1 < attempts) await new Promise((r) => setTimeout(r, backoffMs * (i + 1))); }
  }
  return { ok: false, error: String(last?.name === "TimeoutError" ? "timeout" : last?.status || last?.message || last).slice(0, 200) };
}
