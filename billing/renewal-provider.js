import { createTokenPayment } from "../payments/moyasar.js";

/* ============================================================
   مزوّد الخصم بالرمز — KANAF-ORD-0013 §7

   واجهة واحدة يراها محرّك التجديد:
     chargeToken({ token, amountHalalas, currency, idempotencyKey, description, metadata })
       → { status: 'paid' | 'failed', id, amountHalalas, currency, brand, last4, failureCode }
       أو يرمي = النتيجة مجهولة (انقطاع، مهلة، رد غير مفهوم) — والمحرّك لا يعيد
       المحاولة على نتيجة مجهولة أبداً: قد يكون المال خُصم.

   الاختبارات تحقن مزوّداً وهمياً بـsetRenewalProviderForTests. الإنتاج يستعمل
   Moyasar، والمحرّك كله خلف AUTORENEW_ENABLED.
   ============================================================ */

function normalizeMoyasar(p) {
  const src = p?.source || {};
  const status = p?.status === "paid" ? "paid" : (p?.status === "failed" ? "failed" : null);
  // initiated = يحتاج العميل (3-D Secure): لا يكتمل في خصم بلا حضوره — فشل صريح لا انتظار.
  if (!status && p?.status === "initiated") return { status: "failed", id: p?.id || null, failureCode: "requires_customer_action" };
  if (!status) throw Object.assign(new Error("provider_status_unrecognized"), { code: "provider_status_unrecognized" });
  return {
    status, id: p?.id || null,
    amountHalalas: Number.isInteger(p?.amount) ? p.amount : null,
    currency: p?.currency || null,
    brand: src.company || src.brand || null,
    last4: src.number ? String(src.number).slice(-4) : null,
    failureCode: status === "failed" ? String(src.message || src.response_code || "declined").slice(0, 120) : null,
  };
}

const moyasarRenewalProvider = {
  name: "moyasar",
  async chargeToken({ token, amountHalalas, currency, idempotencyKey, description, metadata }) {
    const p = await createTokenPayment({ token, amountHalalas, currency, givenId: idempotencyKey, description, metadata });
    return normalizeMoyasar(p);
  },
};

let override = null;
export function setRenewalProviderForTests(p) { override = p; }
export function getRenewalProvider() { return override || moyasarRenewalProvider; }
export { normalizeMoyasar };
