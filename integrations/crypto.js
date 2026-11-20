import crypto from "node:crypto";

/* ============================================================
   تشفير اعتمادات التكاملات عند التخزين — KANAF-ORD-0008 §7.3

   AES-256-GCM، والمفتاح من متغيّر البيئة INTEGRATIONS_ENC_KEY
   (32 بايتاً: 64 محرفاً ست عشرياً أو base64). بلا المفتاح لا تخزين
   إطلاقاً — لا رجوع إلى نص صريح. ولا يُطبع مفتاح ولا قيمة في أي رسالة.

   توليد مفتاح:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ⚠️ فقدان المفتاح = فقدان كل الاعتمادات المحفوظة (تُعاد كتابتها).
   ============================================================ */

function key() {
  const raw = process.env.INTEGRATIONS_ENC_KEY || "";
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
  else if (raw) { try { const b = Buffer.from(raw, "base64"); if (b.length === 32) buf = b; } catch { /* */ } }
  return buf;
}

export const encryptionConfigured = () => key() !== null;

export function encryptSecret(plain) {
  const k = key();
  if (!k) throw Object.assign(new Error("encryption_not_configured"), { status: 503 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ciphertext = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return { ciphertext, iv, authTag: c.getAuthTag() };
}

/** للاستعمال داخل الخادم وحده (فحص الاتصال). لا يُعاد ناتجه إلى أي رد. */
export function decryptSecret({ ciphertext, iv, auth_tag: authTag }) {
  const k = key();
  if (!k) throw Object.assign(new Error("encryption_not_configured"), { status: 503 });
  const d = crypto.createDecipheriv("aes-256-gcm", k, iv);
  d.setAuthTag(authTag);
  return Buffer.concat([d.update(ciphertext), d.final()]).toString("utf8");
}

export const last4 = (s) => { const v = String(s); return v.length <= 4 ? "••••" : v.slice(-4); };
