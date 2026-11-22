import { query, pool, withTransaction } from "../db/pool.js";
import { activateOrExtendSubscription, markPastDueIfEntitled } from "./subscription.js";
import { getBillingSettings } from "./config.js";
import { getRenewalProvider } from "./renewal-provider.js";
import { autorenewEnabled, activeCard, cardToken, setRenewalMode } from "./payment-methods.js";
import { issueInvoiceDocument } from "../payments/webhook.js";
import { renderMessage } from "../notifications/messages.js";
import { sendSystemEmail, logSystemMessage } from "../notifications/system-log.js";
import { notifyUser } from "../notifications/service.js";
import { sendPushToUser, isPushConfigured } from "../notifications/push.js";

/* ============================================================
   التجديد التلقائي — KANAF-ORD-0013 §7

   ⚠️ معطَّل ما لم يكن AUTORENEW_ENABLED=1. ولا يُضبط هذا على الإنتاج قبل أن
      يشحن التطبيق نص الموافقة وواجهة الإلغاء (docs/ord-0013/APP_AUTORENEW_SPEC.md)
      وقبل التحقق من الخصم بالرمز على بيئة Moyasar التجريبية (payments/moyasar.js).

   الدورة (لكل اشتراك × نهاية فترة = cycle_key):
     1) إشعار قبل الخصم (§7.3): حين تبقى (مهلة الإشعار + يوم) على نهاية الفترة.
        الإشعار الذي لم يُسلَّم بالبريد لا يُحسب: يُحذف صفّ الدورة ويُعاد في المسح التالي.
        فلا خصم بلا إشعار وصل.
     2) الخصم: قبل نهاية الفترة بيوم، وبعد مرور مهلة الإشعار كاملة على إرساله.
        المبلغ هو المعلَن في الإشعار (amount_sar في الدورة)، لا سعر لحظة الخصم.
     3) نجاح → دفعة + فاتورة مدفوعة + تمديد الاشتراك (الدالة نفسها التي يستعملها
        الـwebhook) ثم الفاتورة الضريبية على تسلسل TNFS-INV نفسه (§7.5).
     4) فشل → محاولة أخرى بعد autorenew_retry_hours، حتى autorenew_max_attempts،
        ثم توقّف: تُسحب الموافقة (system/retries_exhausted) ويُبلَّغ العضو (§7.6).
     5) نتيجة مجهولة (انقطاع أو مهلة) → unknown، بلا إعادة محاولة أبداً: قد يكون
        المال خُصم. يسوّيها الـwebhook إن وصل (البيانات الوصفية تحمل رقم الفاتورة)،
        أو المراجعة من اللوحة.

   🔴 7.4 لا خصم مكرر — ثلاث طبقات:
      • قفل استشاري: مسحان متزامنان → الثاني ينسحب.
      • المطالبة بالدورة تحديث شرطي واحد (noticed|retry → charging): من يفوز به
        وحده يخصم، ولو تجاوز أحدٌ القفل.
      • UNIQUE (cycle_key, attempt_no)، ومعرّف المحاولة given_id لدى المزوّد.
   ============================================================ */

/* النسخة تتغيّر مع كل تغيير في نصّ الموافقة، وإلا صار المحفوظ لا يطابق المعروض.
   2026-11-v1: «…أن يجدّد تنفس اشتراكي…».
   2026-11-v2: «…أن يجدّد تنفس بحرية اشتراكي…» — الاسم الرسمي (ملحق KANAF-ORD-0013 الثاني، القرار 5).
   الموافقات المحفوظة تبقى بنصّها ونسختها كما وافق عليها أصحابها. */
export const CONSENT_VERSION = "2026-11-v2";
const CONSENT_TEMPLATE =
  "أوافق على أن يجدّد تنفس بحرية اشتراكي في «{plan}» تلقائياً عند نهاية كل فترة، بخصم {amount} (سعر الباقة وقت التجديد، ويُذكر في الإشعار) " +
  "من بطاقتي المنتهية بـ{last4}. يصلني إشعار قبل كل خصم بـ{days} أيام على الأقل، وأقدر ألغي التجديد التلقائي في أي وقت من صفحتي الشخصية، " +
  "ويبقى اشتراكي الحالي إلى نهاية فترته.";

export function consentText({ plan, amount, last4, days }) {
  return CONSENT_TEMPLATE.replace("{plan}", plan).replace("{amount}", amount).replace("{last4}", last4 || "••••").replace("{days}", String(days));
}

const money = (n) => `${Number(n).toFixed(2)} ر.س`;
const day = (d) => new Date(d).toISOString().slice(0, 10);
const LOCK = "kanaf_autorenew_sweep";

async function intSetting(key, def, min, max, client) {
  try {
    const { rows } = await (client || { query }).query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    const v = Number(rows[0]?.value);
    return Number.isInteger(v) && v >= min && v <= max ? v : def;
  } catch { return def; }
}
export async function autorenewSettings(client) {
  return {
    noticeDays: await intSetting("autorenew_notice_days", 3, 1, 14, client),
    maxAttempts: await intSetting("autorenew_max_attempts", 3, 1, 5, client),
    retryHours: await intSetting("autorenew_retry_hours", 24, 6, 72, client),
  };
}

/* ---------------- حالة العضو ---------------- */

async function currentSubscription(userId, client) {
  const { rows } = await (client || { query }).query(
    `SELECT s.id, s.plan_id, s.status, s.current_period_end, COALESCE(ss.cancel_at_period_end, false) AS cancel_at_period_end,
            sp.name AS plan_name, sp.price_sar, sp.is_active AS plan_active
       FROM subscriptions s
       LEFT JOIN subscription_state ss ON ss.subscription_id = s.id
       LEFT JOIN subscription_plans sp ON sp.plan_key = s.plan_id
      WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 1`, [userId]);
  return rows[0] || null;
}
const renewable = (s) => s && s.status === "active" && s.current_period_end && new Date(s.current_period_end) > new Date()
  && !s.cancel_at_period_end && s.plan_active && Number(s.price_sar) > 0;

async function activeConsent(userId, client) {
  const { rows } = await (client || { query }).query(
    `SELECT id, subscription_id, payment_method_id, consent_version, consent_text, plan_key, amount_sar, granted_at
       FROM autorenew_consents WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  return rows[0] || null;
}

/** GET /api/billing/autorenew — ما يعرضه التطبيق. */
export async function autorenewStatus(userId) {
  const settings = await autorenewSettings();
  const [card, consent, sub] = await Promise.all([activeCard(userId), activeConsent(userId), currentSubscription(userId)]);
  const nextChargeAt = consent && sub && consent.subscription_id === sub.id && sub.current_period_end
    ? new Date(new Date(sub.current_period_end).getTime() - 86400000).toISOString() : null;
  const offer = autorenewEnabled() && card && !consent && renewable(sub)
    ? { consentVersion: CONSENT_VERSION, planKey: sub.plan_id, amountSar: Number(sub.price_sar),
        text: consentText({ plan: sub.plan_name, amount: money(sub.price_sar), last4: card.last4, days: settings.noticeDays }) }
    : null;
  return {
    available: autorenewEnabled(),
    active: Boolean(consent),
    card: card ? { brand: card.brand, last4: card.last4 } : null,
    consent: consent ? { version: consent.consent_version, text: consent.consent_text, grantedAt: consent.granted_at, planKey: consent.plan_key, amountSar: Number(consent.amount_sar) } : null,
    nextChargeAt,
    subscriptionEndsAt: sub?.current_period_end || null,
    noticeDays: settings.noticeDays,
    offer,
  };
}

/** 7.2: موافقة صريحة بنصّها ونسختها ووقتها. لا تُعطى ضمنياً ولا بأثر رجعي. */
export async function grantConsent(userId, { consentVersion, amountSar }) {
  if (!autorenewEnabled()) return { status: 409, error: "autorenew_unavailable" };
  if (consentVersion !== CONSENT_VERSION) return { status: 409, error: "consent_version_outdated", detail: CONSENT_VERSION };
  const settings = await autorenewSettings();
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('kanaf_autorenew_consent:' || $1))`, [userId]);
    const card = await activeCard(userId, client);
    if (!card) return { status: 409, error: "no_saved_card" };
    const sub = await currentSubscription(userId, client);
    if (!renewable(sub)) return { status: 409, error: "no_renewable_subscription" };
    if (await activeConsent(userId, client)) return { status: 409, error: "already_active" };
    // الشروط التي رآها العضو هي التي تُحفظ: سعر تغيّر بين العرض والموافقة يُرفض بدل أن يُحفظ نصّ لم يره.
    if (Number(amountSar) !== Number(sub.price_sar)) return { status: 409, error: "consent_terms_changed" };
    const text = consentText({ plan: sub.plan_name, amount: money(sub.price_sar), last4: card.last4, days: settings.noticeDays });
    const { rows: [c] } = await client.query(
      `INSERT INTO autorenew_consents (user_id, subscription_id, payment_method_id, consent_version, consent_text, plan_key, amount_sar)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, consent_version, consent_text, granted_at`,
      [userId, sub.id, card.id, CONSENT_VERSION, text, sub.plan_id, sub.price_sar]);
    await setRenewalMode(client, userId, "automatic");
    return { status: 201, consent: c };
  });
}

/**
 * سحب الموافقة (§7.7 العضو، §7.8 الإدارة، §7.6 النظام). متاح دائماً ولو كان المفتاح
 * معطَّلاً — الإلغاء لا يُغلق أبداً. الاشتراك الحالي يبقى إلى نهايته.
 * دورة في منتصف الخصم (charging) لا تُلغى: المزوّد استُدعي، ونتيجتها تُحترم.
 */
export async function revokeConsent(userId, { by, adminId = null, reason = null }, existingClient = null) {
  const run = async (client) => {
    const { rows } = await client.query(
      `UPDATE autorenew_consents SET revoked_at = now(), revoked_by = $2, revoked_by_admin = $3, revoke_reason = $4
        WHERE user_id = $1 AND revoked_at IS NULL
        RETURNING id, consent_version, plan_key, amount_sar, granted_at`, [userId, by, adminId, reason ? String(reason).slice(0, 500) : null]);
    if (!rows[0]) return { revoked: false };
    await client.query(
      `UPDATE renewal_cycles SET status = 'cancelled', updated_at = now(), last_error = $2
        WHERE consent_id = $1 AND status IN ('noticed', 'retry')`, [rows[0].id, `revoked_by_${by}`]);
    await setRenewalMode(client, userId, "manual");
    return { revoked: true, consent: rows[0] };
  };
  return existingClient ? run(existingClient) : withTransaction(run);
}

/* ---------------- الرسائل ---------------- */

async function sendRenewalMessage(key, user, vars, dedupKey) {
  const m = await renderMessage(key, { name: user.name, ...vars });
  const out = { email: false };
  for (const ch of m.channels) {
    try {
      if (ch === "email") {
        const r = await sendSystemEmail(key, user.email, m.subject, m.text, m.extra);
        out.email = !(r && r.dev);
      } else if (ch === "in_app") {
        await notifyUser(user.id, { title: m.subject, body: m.text, kind: key === "renewal_succeeded" ? "success" : "info", source: "billing", dedupKey: `${key}:${dedupKey}` });
        await logSystemMessage({ userId: user.id, kind: key, channel: "in_app", status: "sent" });
      } else if (ch === "push") {
        if (!isPushConfigured()) { await logSystemMessage({ userId: user.id, kind: key, channel: "push", status: "skipped", errorCode: "push_not_configured" }); continue; }
        await sendPushToUser(user.id, { title: m.subject, body: m.text });
        await logSystemMessage({ userId: user.id, kind: key, channel: "push", status: "sent" });
      } else {
        // واتساب والرسائل النصية لرسائل النظام غير مبنيّة — يُسجَّل التخطّي بلا نص.
        await logSystemMessage({ userId: user.id, kind: key, channel: ch, status: "skipped", errorCode: "channel_not_wired_for_system_messages" });
      }
    } catch (err) {
      await logSystemMessage({ userId: user.id, kind: key, channel: ch, status: "failed", errorCode: "send_error" });
      console.error(`[autorenew] تعذّر إرسال ${key} عبر ${ch}:`, err?.code || "error");
    }
  }
  return out;
}

/* ---------------- 1) الإشعار ---------------- */

async function sendDueNotices(settings, log) {
  const { rows } = await query(
    `SELECT c.id AS consent_id, c.user_id, s.id AS subscription_id, s.current_period_end, s.plan_id,
            sp.name AS plan_name, sp.price_sar, pm.card_last4, u.name, u.email
       FROM autorenew_consents c
       JOIN users u ON u.id = c.user_id AND u.deleted_at IS NULL
       JOIN payment_methods pm ON pm.id = c.payment_method_id AND pm.removed_at IS NULL
       JOIN subscriptions s ON s.id = c.subscription_id AND s.status = 'active'
       LEFT JOIN subscription_state ss ON ss.subscription_id = s.id
       JOIN subscription_plans sp ON sp.plan_key = s.plan_id AND sp.is_active = true AND sp.price_sar > 0
      WHERE c.revoked_at IS NULL
        AND COALESCE(ss.cancel_at_period_end, false) = false
        AND s.current_period_end > now()
        AND s.current_period_end <= now() + make_interval(days => $1 + 1)
        AND NOT EXISTS (SELECT 1 FROM renewal_cycles rc WHERE rc.subscription_id = s.id AND rc.period_end = s.current_period_end)
      LIMIT 50`, [settings.noticeDays]);
  let sent = 0;
  for (const r of rows) {
    const cycleKey = `${r.subscription_id}:${new Date(r.current_period_end).toISOString()}`;
    const { rows: claimed } = await query(
      `INSERT INTO renewal_cycles (cycle_key, subscription_id, user_id, consent_id, period_end, plan_key, amount_sar)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (cycle_key) DO NOTHING RETURNING cycle_key`,
      [cycleKey, r.subscription_id, r.user_id, r.consent_id, r.current_period_end, r.plan_id, r.price_sar]);
    if (!claimed[0]) continue;
    const res = await sendRenewalMessage("renewal_notice", { id: r.user_id, name: r.name, email: r.email },
      { plan: r.plan_name, date: day(r.current_period_end), amount: money(r.price_sar), card_last4: r.card_last4 || "••••" }, cycleKey);
    if (!res.email) {
      // لم يصل الإشعار بالبريد (قناته الإلزامية) → لا دورة، فلا خصم. يُعاد في المسح التالي.
      await query(`DELETE FROM renewal_cycles WHERE cycle_key = $1 AND status = 'noticed' AND attempts = 0`, [cycleKey]);
      log(`[autorenew] إشعار لم يُسلَّم — لا خصم قبل تسليمه (${cycleKey.slice(0, 8)}…)`);
      continue;
    }
    sent++;
  }
  return sent;
}

/* ---------------- 2) الخصم ---------------- */

/** المطالبة بالدورة: تحديث شرطي واحد. من لم يفز به لا يخصم. */
async function claimCycle(cycleKey) {
  return withTransaction(async (client) => {
    const { rows: [c] } = await client.query(
      `UPDATE renewal_cycles rc SET status = 'charging', attempts = attempts + 1, updated_at = now()
        WHERE cycle_key = $1 AND status IN ('noticed', 'retry')
          AND (status = 'noticed' OR next_attempt_at <= now())
          AND EXISTS (SELECT 1 FROM autorenew_consents c WHERE c.id = rc.consent_id AND c.revoked_at IS NULL)
        RETURNING *`, [cycleKey]);
    if (!c) return null;
    const { rows: [ctx] } = await client.query(
      `SELECT s.id, s.status, s.current_period_end, COALESCE(ss.cancel_at_period_end, false) AS cancel_at_period_end,
              u.name, u.email, u.deleted_at, c.payment_method_id, pm.provider, pm.card_last4, sp.name AS plan_name, sp.duration_days
         FROM subscriptions s
         LEFT JOIN subscription_state ss ON ss.subscription_id = s.id
         JOIN users u ON u.id = s.user_id
         JOIN autorenew_consents c ON c.id = $2
         LEFT JOIN payment_methods pm ON pm.id = c.payment_method_id AND pm.removed_at IS NULL
         LEFT JOIN subscription_plans sp ON sp.plan_key = $3
        WHERE s.id = $1`, [c.subscription_id, c.consent_id, c.plan_key]);
    const stale = !ctx || ctx.deleted_at || ctx.status === "canceled" || ctx.cancel_at_period_end || !ctx.provider || !ctx.duration_days
      || new Date(ctx.current_period_end).getTime() !== new Date(c.period_end).getTime();
    if (stale) {
      await client.query(`UPDATE renewal_cycles SET status = 'cancelled', last_error = 'subscription_changed', updated_at = now() WHERE cycle_key = $1`, [cycleKey]);
      return null;
    }
    const settings = await getBillingSettings(client);
    const { rows: [inv] } = await client.query(
      `INSERT INTO invoices (user_id, plan_id, amount_sar, status, subscription_id) VALUES ($1, $2, $3, 'pending', $4) RETURNING id`,
      [c.user_id, c.plan_key, c.amount_sar, c.subscription_id]);
    await client.query(`INSERT INTO invoice_payment_expectations (invoice_id, amount_halalas, currency) VALUES ($1, $2, $3)`,
      [inv.id, Math.round(Number(c.amount_sar) * 100), settings.currency]);
    const { rows: [att] } = await client.query(
      `INSERT INTO renewal_attempts (cycle_key, attempt_no, invoice_id, provider) VALUES ($1, $2, $3, $4) RETURNING id`,
      [cycleKey, c.attempts, inv.id, getRenewalProvider().name]);
    await client.query(`UPDATE renewal_cycles SET invoice_id = $2 WHERE cycle_key = $1`, [cycleKey, inv.id]);
    return { cycle: c, ctx, invoiceId: inv.id, attemptId: att.id, currency: settings.currency };
  });
}

async function settleSuccess(job, result) {
  const { cycle, ctx, invoiceId, attemptId } = job;
  const provider = getRenewalProvider().name;
  const out = await withTransaction(async (client) => {
    const { rows: [inv] } = await client.query(`SELECT status FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
    let activation = null;
    if (inv.status !== "paid") {
      const { rows: pay } = await client.query(
        `INSERT INTO payments (user_id, invoice_id, subscription_id, provider, provider_payment_id, amount, currency, method, card_brand, card_last4, status, captured_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'creditcard', $8, $9, 'paid', now())
         ON CONFLICT (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL DO NOTHING RETURNING id`,
        [cycle.user_id, invoiceId, cycle.subscription_id, provider, result.id, cycle.amount_sar, job.currency, result.brand, result.last4 || ctx.card_last4]);
      // صفّ موجود بالرقم نفسه = الـwebhook سجّل الدفعة قبلنا؛ تمديده هو التمديد، لا نمدّد مرتين.
      if (pay[0]) {
        await client.query(`UPDATE invoices SET status = 'paid', provider_payment_id = $1, updated_at = now() WHERE id = $2`, [result.id, invoiceId]);
        activation = await activateOrExtendSubscription(client, {
          userId: cycle.user_id, planKey: cycle.plan_key, planName: ctx.plan_name, durationDays: ctx.duration_days,
          priceSar: cycle.amount_sar, currency: job.currency, invoiceId, paymentId: pay[0].id, provider,
        });
      }
    }
    await client.query(`UPDATE renewal_attempts SET status = 'succeeded', provider_payment_id = $2, finished_at = now() WHERE id = $1`, [attemptId, result.id]);
    await client.query(`UPDATE renewal_cycles SET status = 'succeeded', last_error = NULL, updated_at = now() WHERE cycle_key = $1`, [cycle.cycle_key]);
    return activation;
  });
  const invoiceNumber = await issueInvoiceDocument(invoiceId);
  const { rows: [s] } = await query(`SELECT current_period_end FROM subscriptions WHERE id = $1`, [cycle.subscription_id]);
  await sendRenewalMessage("renewal_succeeded", { id: cycle.user_id, name: ctx.name, email: ctx.email },
    { plan: ctx.plan_name, date: day(s.current_period_end), amount: money(cycle.amount_sar), invoice_number: invoiceNumber || "—" }, cycle.cycle_key);
  return { outcome: out ? "renewed" : "settled_by_webhook", invoiceNumber };
}

async function settleFailure(job, result, settings) {
  const { cycle, ctx, invoiceId, attemptId } = job;
  const provider = getRenewalProvider().name;
  const final = cycle.attempts >= settings.maxAttempts;
  const next = new Date(Date.now() + settings.retryHours * 3600000);
  await withTransaction(async (client) => {
    await client.query(`UPDATE invoices SET status = 'failed', provider_payment_id = COALESCE($1, provider_payment_id), updated_at = now() WHERE id = $2 AND status = 'pending'`, [result.id, invoiceId]);
    if (result.id) {
      await client.query(
        `INSERT INTO payments (user_id, invoice_id, subscription_id, provider, provider_payment_id, amount, currency, method, card_last4, status, failure_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'creditcard', $8, 'failed', $9)
         ON CONFLICT (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL DO NOTHING`,
        [cycle.user_id, invoiceId, cycle.subscription_id, provider, result.id, cycle.amount_sar, job.currency, ctx.card_last4, result.failureCode]);
    }
    await client.query(`UPDATE renewal_attempts SET status = 'failed', provider_payment_id = $2, failure_code = $3, finished_at = now() WHERE id = $1`, [attemptId, result.id, result.failureCode]);
    await client.query(
      `UPDATE renewal_cycles SET status = $2, next_attempt_at = $3, last_error = $4, updated_at = now() WHERE cycle_key = $1`,
      [cycle.cycle_key, final ? "stopped" : "retry", final ? null : next.toISOString(), result.failureCode]);
    await markPastDueIfEntitled(client, cycle.user_id);
    if (final) await revokeConsent(cycle.user_id, { by: "system", reason: "retries_exhausted" }, client);
  });
  const user = { id: cycle.user_id, name: ctx.name, email: ctx.email };
  if (final) await sendRenewalMessage("renewal_stopped", user, { plan: ctx.plan_name }, cycle.cycle_key);
  else await sendRenewalMessage("renewal_failed", user, { plan: ctx.plan_name, card_last4: ctx.card_last4 || "••••", next_attempt: day(next) }, `${cycle.cycle_key}:${cycle.attempts}`);
  return { outcome: final ? "stopped" : "retry_scheduled" };
}

async function markUnknown(job, code) {
  await withTransaction(async (client) => {
    await client.query(`UPDATE renewal_attempts SET status = 'unknown', failure_code = $2, finished_at = now() WHERE id = $1`, [job.attemptId, code]);
    await client.query(`UPDATE renewal_cycles SET status = 'unknown', last_error = $2, updated_at = now() WHERE cycle_key = $1`, [job.cycle.cycle_key, code]);
  });
  return { outcome: "unknown" };
}

export async function chargeCycle(cycleKey, settings) {
  const job = await claimCycle(cycleKey);
  if (!job) return { outcome: "not_claimed" };
  let token;
  try { token = await cardToken(job.ctx.payment_method_id); }
  catch { token = null; }
  if (!token) {
    // لا رمز يُقرأ (مفتاح التشفير غاب؟) — لم يُستدعَ المزوّد، فهذا فشل مؤكد لا مجهول.
    return settleFailure(job, { id: null, failureCode: "card_token_unavailable" }, settings);
  }
  let result;
  try {
    result = await getRenewalProvider().chargeToken({
      token, amountHalalas: Math.round(Number(job.cycle.amount_sar) * 100), currency: job.currency,
      idempotencyKey: job.attemptId, description: `تجديد تلقائي — ${job.ctx.plan_name}`,
      metadata: { kanaf_invoice_id: job.invoiceId, kanaf_renewal_cycle: job.cycle.cycle_key },
    });
  } catch (err) {
    return markUnknown(job, String(err?.code || "provider_unreachable").slice(0, 120));
  }
  if (result.status === "paid") {
    const expected = Math.round(Number(job.cycle.amount_sar) * 100);
    if (result.amountHalalas !== null && result.amountHalalas !== undefined && result.amountHalalas !== expected) return markUnknown(job, "amount_mismatch");
    if (!result.id) return markUnknown(job, "missing_payment_id");
    return settleSuccess(job, result);
  }
  return settleFailure(job, result, settings);
}

/* ---------------- 3) التسوية ---------------- */

/** دورات مجهولة أو عالقة: إن سوّى الـwebhook فاتورتها فهي ناجحة. لا خصم جديد هنا أبداً. */
async function reconcile() {
  await query(
    `UPDATE renewal_cycles SET status = 'unknown', last_error = 'interrupted_while_charging', updated_at = now()
      WHERE status = 'charging' AND updated_at < now() - interval '15 minutes'`);
  const { rowCount } = await query(
    `UPDATE renewal_cycles rc SET status = 'succeeded', last_error = NULL, updated_at = now()
       FROM invoices i WHERE i.id = rc.invoice_id AND rc.status = 'unknown' AND i.status = 'paid'`);
  return rowCount;
}

/* ---------------- المسح ---------------- */

export async function sweepAutoRenewals({ log = () => {} } = {}) {
  if (!autorenewEnabled()) return { skipped: true, reason: "autorenew_disabled" };
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query(`SELECT pg_try_advisory_lock(hashtext('${LOCK}')) AS locked`)).rows[0].locked;
    if (!locked) return { skipped: true, reason: "sweep_already_running" };
    return await runRenewalPass({ log });
  } finally {
    let bad = false;
    if (locked) { try { await client.query(`SELECT pg_advisory_unlock(hashtext('${LOCK}'))`); } catch { bad = true; } }
    client.release(bad);
  }
}

/** تمريرة واحدة بلا القفل — مُصدَّرة ليُثبت الاختبار أن المطالبة وحدها تمنع الخصم المزدوج. */
export async function runRenewalPass({ log = () => {} } = {}) {
  const settings = await autorenewSettings();
  const reconciled = await reconcile();
  const noticed = await sendDueNotices(settings, log);
  const { rows: due } = await query(
    `SELECT rc.cycle_key FROM renewal_cycles rc
      WHERE (rc.status = 'noticed' AND now() >= rc.period_end - interval '1 day' AND now() >= rc.notice_sent_at + make_interval(days => $1))
         OR (rc.status = 'retry' AND rc.next_attempt_at <= now())
      ORDER BY rc.period_end LIMIT 20`, [settings.noticeDays]);
  const results = [];
  for (const d of due) {
    try { results.push({ cycle: d.cycle_key, ...(await chargeCycle(d.cycle_key, settings)) }); }
    catch (err) {
      results.push({ cycle: d.cycle_key, outcome: "error" });
      console.error("[autorenew] خطأ في دورة:", err?.code || err?.message || "error");
    }
  }
  if (noticed || results.length) log(`[autorenew] إشعارات: ${noticed} · خصومات: ${JSON.stringify(results.map((r) => r.outcome))}`);
  return { noticed, reconciled, charged: results.filter((r) => r.outcome === "renewed" || r.outcome === "settled_by_webhook").length, results };
}
