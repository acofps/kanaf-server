import { query } from "../db/pool.js";
import { splitVatInclusiveAmount } from "../invoicing/zatca.js";
import { getBillingSettings } from "./config.js";

/* ============================================================
   أكواد الخصم — التحقق وحده، بلا ربط بالدفع (KANAF-ORD-0008 §6.3)

   🔴 لا شيء في payments/ أو invoicing/ يستورد هذا الملف. الكود يُفحص
   (صلاحية، مدة، حد استعمال، باقة) ويُعرض أثره معاينةً فقط. ربطه بالفاتورة
   والضريبة وبوابة الدفع أمر مستقل بأدلته المالية:
     • الأسعار شاملة الضريبة، فالخصم يغيّر الوعاء والضريبة معاً؛
     • ويجب أن يظهر في الفاتورة بنداً ظاهراً لا مبلغاً مخفّضاً بصمت؛
     • والمبلغ المرسَل إلى البوابة يساوي ما بعد الخصم.

   قرار محدَّد (§6.2): لا خصم يبلغ 100% ولا مبلغ يساوي السعر أو يتجاوزه —
   الأول ممنوع بقيد الجدول، والثاني يرفضه الفحص هنا.
   ============================================================ */

export const normalizeCode = (c) => String(c || "").trim().toUpperCase();

/** يفحص مدخلات الإنشاء. يعيد { value } أو يرمي خطأً بحالة 400. */
export function validateDiscountInput(b) {
  const bad = (code) => { throw Object.assign(new Error(code), { status: 400 }); };
  const code = normalizeCode(b.code);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) bad("invalid_code_format");
  if (!["percent", "amount"].includes(b.kind)) bad("invalid_kind");
  const value = Number(b.value);
  if (!Number.isFinite(value) || value <= 0) bad("invalid_value");
  if (b.kind === "percent" && value >= 100) bad("percent_must_be_below_100");
  if (Math.round(value * 100) !== value * 100) bad("value_max_two_decimals");
  const from = b.validFrom ? new Date(b.validFrom) : null;
  const until = b.validUntil ? new Date(b.validUntil) : null;
  if ((from && Number.isNaN(from.getTime())) || (until && Number.isNaN(until.getTime()))) bad("invalid_date");
  if (from && until && until <= from) bad("valid_until_before_from");
  const max = b.maxRedemptions === undefined || b.maxRedemptions === null || b.maxRedemptions === "" ? null : Number(b.maxRedemptions);
  if (max !== null && (!Number.isInteger(max) || max <= 0)) bad("invalid_max_redemptions");
  const plans = Array.isArray(b.planKeys) && b.planKeys.length ? [...new Set(b.planKeys.map(String))] : null;
  return {
    code, kind: b.kind, value, validFrom: from ? from.toISOString() : null, validUntil: until ? until.toISOString() : null,
    maxRedemptions: max, planKeys: plans, note: b.note ? String(b.note).trim().slice(0, 300) : null,
  };
}

/**
 * يفحص كوداً لباقة. لا يكتب شيئاً ولا يحجز استعمالاً.
 * يعيد { valid, reason, code, preview } — preview معاينة حسابية فقط.
 */
export async function checkDiscountCode(rawCode, planKey, now = new Date()) {
  const code = normalizeCode(rawCode);
  const { rows: [d] } = await query(
    `SELECT dc.*, (SELECT count(*)::int FROM discount_code_redemptions r WHERE r.discount_code_id = dc.id) AS used
     FROM discount_codes dc WHERE dc.code = $1`, [code]);
  if (!d) return { valid: false, reason: "not_found" };
  if (!d.is_active) return { valid: false, reason: "inactive" };
  if (d.valid_from && now < d.valid_from) return { valid: false, reason: "not_started" };
  if (d.valid_until && now > d.valid_until) return { valid: false, reason: "expired" };
  if (d.max_redemptions !== null && d.used >= d.max_redemptions) return { valid: false, reason: "limit_reached" };
  const { rows: [plan] } = await query(`SELECT plan_key, name, price_sar FROM subscription_plans WHERE plan_key = $1`, [String(planKey || "")]);
  if (!plan) return { valid: false, reason: "plan_not_found" };
  if (d.plan_keys && !d.plan_keys.includes(plan.plan_key)) return { valid: false, reason: "plan_not_eligible" };

  const price = Number(plan.price_sar);
  const off = d.kind === "percent" ? Math.round(price * Number(d.value)) / 100 : Number(d.value);
  if (off >= price) return { valid: false, reason: "discount_reaches_price" };
  const final = Math.round((price - off) * 100) / 100;
  const { vatRate } = await getBillingSettings();
  return {
    valid: true, reason: null, code,
    preview: {
      note: "معاينة حسابية فقط — الكود غير مربوط بالدفع ولا بالفاتورة بعد.",
      plan: plan.plan_key, priceSar: price, discountSar: Math.round(off * 100) / 100, finalSar: final,
      vatSplitBefore: splitVatInclusiveAmount(price, vatRate), vatSplitAfter: splitVatInclusiveAmount(final, vatRate),
      used: d.used, maxRedemptions: d.max_redemptions,
    },
  };
}
