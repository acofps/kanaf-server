import express from "express";
import { query } from "../db/pool.js";
import { requireAdminAuth, requirePermission, logAdminAction, fail } from "./middleware.js";
import { INTEGRATIONS, isKnownField } from "../integrations/catalog.js";
import { encryptionConfigured, encryptSecret, decryptSecret, last4 } from "../integrations/crypto.js";
import { expectedUnavailable } from "../ops/http-errors.js";

/* ============================================================
   التكاملات — صفحة اعتمادات لا تكامل (KANAF-ORD-0008 §7)

   🔴 القواعد:
   • للمالك وحده (integrations:manage — في مصفوفة المالك فقط).
   • لا مسار يعيد سرّاً، كاملاً أو جزئياً، غير آخر أربعة محارف.
   • القيمة مشفَّرة عند التخزين؛ بلا INTEGRATIONS_ENC_KEY يُرفض الحفظ (503).
   • كل كتابة وكل فحص اتصال بسبب مكتوب في سجل الإجراءات — بلا القيمة.
   • لا يُطبع مفتاح في سجل الخادم ولو عند الخطأ: الأخطاء رموز وحالات HTTP.
   • فحص الاتصال قراءة واحدة بمسار موثَّق؛ ولا نداء تشغيلي من الدفع أو الفوترة.
   ============================================================ */

export const integrationsRouter = express.Router();
const PERM = "integrations:manage";
const reasonOf = (req) => String(req.body?.reason || "").trim();
const ENUMS = { "mailgun.region": ["us", "eu"], "tamara.environment": ["sandbox", "production"] };

// GET /admin/integrations — الحالة المقنَّعة فقط
integrationsRouter.get("/integrations", requireAdminAuth, requirePermission(PERM), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT ic.service, ic.key_name, ic.last4, ic.updated_at, a.name AS updated_by_name
       FROM integration_credentials ic LEFT JOIN admin_users a ON a.id = ic.updated_by`);
    const stored = new Map(rows.map((r) => [`${r.service}.${r.key_name}`, r]));
    res.json({
      encryptionConfigured: encryptionConfigured(),
      services: Object.entries(INTEGRATIONS).map(([service, d]) => ({
        service, label: d.label, testAvailable: Boolean(d.test),
        fields: Object.entries(d.fields).map(([key, label]) => {
          const s = stored.get(`${service}.${key}`);
          return { key, label, configured: Boolean(s), masked: s ? `••••${s.last4}` : null,
                   updatedAt: s?.updated_at || null, updatedBy: s?.updated_by_name || null };
        }),
      })),
    });
  } catch (err) { return fail(res, err, "admin/integrations:list", req); }
});

// PUT /admin/integrations/:service/:key  { value, reason }
integrationsRouter.put("/integrations/:service/:key", requireAdminAuth, requirePermission(PERM), async (req, res) => {
  try {
    const { service, key } = req.params;
    if (!isKnownField(service, key)) return res.status(404).json({ error: "unknown_field" });
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: "reason_required" });
    const value = typeof req.body?.value === "string" ? req.body.value.trim() : "";
    if (!value || value.length > 1000) return res.status(400).json({ error: "invalid_value" });
    const allowed = ENUMS[`${service}.${key}`];
    if (allowed && !allowed.includes(value)) return res.status(400).json({ error: "invalid_value", allowed });
    if (!encryptionConfigured()) return expectedUnavailable(res, 503, { error: "encryption_not_configured", message: "ضع INTEGRATIONS_ENC_KEY في بيئة الخادم أولاً." });
    const { ciphertext, iv, authTag } = encryptSecret(value);
    const { rows: [old] } = await query(`SELECT 1 FROM integration_credentials WHERE service = $1 AND key_name = $2`, [service, key]);
    await query(
      `INSERT INTO integration_credentials (service, key_name, ciphertext, iv, auth_tag, last4, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (service, key_name) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag,
             last4 = EXCLUDED.last4, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [service, key, ciphertext, iv, authTag, last4(value), req.admin.id]);
    // لا القيمة ولا آخر أربعة في السجل — يكفي «ضُبط/استُبدل».
    await logAdminAction({ adminUserId: req.admin.id, action: old ? "integration_credential_replace" : "integration_credential_set",
      entity: "integration_credential", entityId: `${service}.${key}`, reason, ipAddress: req.ip });
    res.json({ ok: true, masked: `••••${last4(value)}` });
  } catch (err) { return fail(res, err, "admin/integrations:set", req); }
});

// DELETE /admin/integrations/:service/:key  { reason }
integrationsRouter.delete("/integrations/:service/:key", requireAdminAuth, requirePermission(PERM), async (req, res) => {
  try {
    const { service, key } = req.params;
    if (!isKnownField(service, key)) return res.status(404).json({ error: "unknown_field" });
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: "reason_required" });
    const { rowCount } = await query(`DELETE FROM integration_credentials WHERE service = $1 AND key_name = $2`, [service, key]);
    if (!rowCount) return res.status(404).json({ error: "not_configured" });
    await logAdminAction({ adminUserId: req.admin.id, action: "integration_credential_delete",
      entity: "integration_credential", entityId: `${service}.${key}`, reason, ipAddress: req.ip });
    res.json({ ok: true });
  } catch (err) { return fail(res, err, "admin/integrations:delete", req); }
});

/* ---- فحص الاتصال: قراءة واحدة، مهلة 10 ثوانٍ، ولا يعود إلا الحالة ---- */
async function loadValues(service) {
  const { rows } = await query(`SELECT key_name, ciphertext, iv, auth_tag FROM integration_credentials WHERE service = $1`, [service]);
  return Object.fromEntries(rows.map((r) => [r.key_name, decryptSecret(r)]));
}
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const TESTS = {
  async mailgun_domain(v) {
    if (!v.api_key || !v.domain) return { ok: false, error: "missing_fields", need: ["api_key", "domain"] };
    const host = v.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
    return http(`${host}/v3/domains/${encodeURIComponent(v.domain)}`, { Authorization: basic("api", v.api_key) });
  },
  async whatsapp_phone_number(v) {
    if (!v.access_token || !v.phone_number_id) return { ok: false, error: "missing_fields", need: ["access_token", "phone_number_id"] };
    return http(`https://graph.facebook.com/v19.0/${encodeURIComponent(v.phone_number_id)}?fields=id`, { Authorization: `Bearer ${v.access_token}` });
  },
  async moyasar_payments(v) {
    if (!v.secret_key) return { ok: false, error: "missing_fields", need: ["secret_key"] };
    return http("https://api.moyasar.com/v1/payments?page=1", { Authorization: basic(v.secret_key, "") });
  },
};
async function http(url, headers) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    await r.body?.cancel?.(); // لا يُقرأ الجسم ولا يُعاد — قد يحمل بيانات
    return { ok: r.ok, httpStatus: r.status };
  } catch (e) {
    return { ok: false, error: e?.name === "TimeoutError" ? "timeout" : "network_error" };
  }
}

// POST /admin/integrations/:service/test  { reason }
integrationsRouter.post("/integrations/:service/test", requireAdminAuth, requirePermission(PERM), async (req, res) => {
  try {
    const def = INTEGRATIONS[req.params.service];
    if (!def) return res.status(404).json({ error: "unknown_service" });
    const reason = reasonOf(req);
    if (!reason) return res.status(400).json({ error: "reason_required" });
    if (!def.test) return expectedUnavailable(res, 501, { error: "test_not_available", message: "لا فحص اتصال لهذه الخدمة قبل اعتماد توثيق مزوّدها." });
    if (!encryptionConfigured()) return expectedUnavailable(res, 503, { error: "encryption_not_configured" });
    const result = await TESTS[def.test](await loadValues(req.params.service));
    await logAdminAction({ adminUserId: req.admin.id, action: "integration_connection_test",
      entity: "integration_credential", entityId: req.params.service, newValue: result, reason, ipAddress: req.ip });
    res.json(result);
  } catch (err) { return fail(res, err, "admin/integrations:test", req); }
});
