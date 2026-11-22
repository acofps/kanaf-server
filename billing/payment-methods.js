import { query, withTransaction } from "../db/pool.js";
import { encryptSecret, decryptSecret, encryptionConfigured } from "../integrations/crypto.js";

/* ============================================================
   البطاقة المحفوظة — رمز المزوّد وحده (KANAF-ORD-0013 §7.1)

   لا رقم بطاقة ولا تاريخ انتهاء ولا CVV في أي مكان: المزوّد يحفظ البطاقة
   ويعطينا رمزاً (token) نخزّنه مشفّراً، ومعه العلامة وآخر أربعة أرقام للعرض.
   فكّ التشفير يجري في الخادم لحظة الخصم وحدها، ولا يُعاد الرمز في أي رد.
   ============================================================ */

export const autorenewEnabled = () => process.env.AUTORENEW_ENABLED === "1";

/** البطاقة الفعّالة للعرض: { id, brand, last4, created_at } أو null. */
export async function activeCard(userId, client) {
  const runner = client || { query };
  const { rows } = await runner.query(
    `SELECT id, card_brand AS brand, card_last4 AS last4, created_at FROM payment_methods WHERE user_id = $1 AND removed_at IS NULL`, [userId]);
  return rows[0] || null;
}

/** الرمز نفسه — للخصم وحده. */
export async function cardToken(paymentMethodId) {
  const { rows } = await query(
    `SELECT token_ciphertext AS ciphertext, token_iv AS iv, token_auth_tag AS auth_tag FROM payment_methods WHERE id = $1 AND removed_at IS NULL`,
    [paymentMethodId]);
  if (!rows[0]) return null;
  return decryptSecret(rows[0]);
}

/**
 * يحفظ بطاقة جديدة ويُخرج السابقة. استبدال البطاقة يُلغي موافقة التجديد القائمة
 * (revoked_by = system، card_replaced): الموافقة أُعطيت بنصّ يذكر البطاقة السابقة،
 * فلا تنتقل إلى بطاقة لم يوافق عليها العضو بنصّ. التطبيق يعرض الموافقة من جديد.
 */
export async function saveCard(userId, { provider, token, brand, last4 }) {
  if (!token || typeof token !== "string" || token.length > 300) return { saved: false, reason: "invalid_token" };
  if (!encryptionConfigured()) return { saved: false, reason: "encryption_not_configured" };
  const sealed = encryptSecret(token);
  return withTransaction(async (client) => {
    await client.query(`UPDATE payment_methods SET removed_at = now() WHERE user_id = $1 AND removed_at IS NULL`, [userId]);
    const revoked = await client.query(
      `UPDATE autorenew_consents SET revoked_at = now(), revoked_by = 'system', revoke_reason = 'card_replaced'
        WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, [userId]);
    if (revoked.rowCount) await setRenewalMode(client, userId, "manual");
    const { rows } = await client.query(
      `INSERT INTO payment_methods (user_id, provider, token_ciphertext, token_iv, token_auth_tag, card_brand, card_last4)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [userId, provider, sealed.ciphertext, sealed.iv, sealed.authTag,
       brand ? String(brand).slice(0, 20) : null, /^\d{4}$/.test(String(last4 || "")) ? String(last4) : null]);
    return { saved: true, id: rows[0].id, consentRevoked: revoked.rowCount > 0 };
  });
}

export async function setRenewalMode(client, userId, mode) {
  await client.query(
    `UPDATE subscription_state SET renewal_mode = $2, updated_at = now()
      WHERE subscription_id = (SELECT id FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
    [userId, mode]);
}

/**
 * بعد دفعة ناجحة مثبَّتة (خارج معاملة المال، ولا يرمي أبداً): إن حمل المزوّد رمزاً
 * للبطاقة — وذلك لا يحدث إلا إذا طلب التطبيق حفظها — يُحفظ. خلف المفتاح نفسه.
 */
export async function captureCardAfterPayment(invoiceId, providerPayment, provider = "moyasar") {
  try {
    if (!autorenewEnabled()) return { saved: false, reason: "autorenew_disabled" };
    const token = providerPayment?.source?.token;
    if (!token) return { saved: false, reason: "no_token" };
    const { rows } = await query(`SELECT user_id FROM invoices WHERE id = $1 AND status = 'paid'`, [invoiceId]);
    if (!rows[0]) return { saved: false, reason: "invoice_not_paid" };
    const src = providerPayment.source;
    return await saveCard(rows[0].user_id, {
      provider, token, brand: src.company || src.brand || null, last4: src.number ? String(src.number).slice(-4) : null,
    });
  } catch (err) {
    console.error("[autorenew] تعذّر حفظ البطاقة بعد الدفع (الدفعة سليمة):", err?.code || err?.message || "error");
    return { saved: false, reason: "error" };
  }
}
