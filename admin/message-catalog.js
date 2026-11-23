import express from "express";
import { query } from "../db/pool.js";
import { requireAdminAuth, requirePermission, requireUuidParam, logAdminAction, fail } from "./middleware.js";
import { MESSAGES, validateMessageText, effectiveDefinition, renderMessage } from "../notifications/messages.js";
import { channelAvailability } from "../notifications/channels.js";
import { sendEmail } from "../mail/send.js";

/* ============================================================
   محتوى الإشعارات وقوالبها — KANAF-ORD-0013 §9

   العرض: app_settings:view (المالك والمدير). التعديل: app_settings:edit (المالك
   وحده) — نص يصل إلى المستخدم النهائي، والمصفوفة تحصر تعديل ما يراه المستخدم
   في المالك (admin/permissions.js).

   كل تعديل نصّ أو قالب صفّ في سجل الإجراءات بالقيمة قبل وبعد (§9.4).
   المعاينة لا تحفظ ولا ترسل. والإرسال التجريبي إلى بريد المحرِّر وحده (§9.6).
   ============================================================ */
export const messageCatalogRouter = express.Router();
const reasonOf = (req) => String(req.body?.reason || req.query?.reason || "").trim();
const ACCENTS = ["#735890", "#594372", "#402F53", "#1C1626"];

async function templates() {
  return (await query(`SELECT id, name, accent, footer_note, show_store_links, show_social_links, is_default, updated_at FROM message_templates ORDER BY is_default DESC, name`)).rows;
}

messageCatalogRouter.get("/message-catalog", requireAdminAuth, requirePermission("app_settings:view"), async (req, res) => {
  try {
    const availability = await channelAvailability();
    const messages = [];
    for (const [key, def] of Object.entries(MESSAGES)) {
      const eff = await effectiveDefinition(key);
      messages.push({
        key, label: def.label, audience: def.audience,
        subject: eff.subject, body: eff.body, templateId: eff.templateId, channels: eff.channels, customized: eff.customized,
        defaults: { subject: def.subject, body: def.body, channels: def.defaults },
        vars: def.vars, required: def.must, allowedChannels: def.allowed, requiredChannels: def.required,
      });
    }
    res.json({ messages, templates: await templates(), availability, accents: ACCENTS });
  } catch (err) { return fail(res, err, "admin/message-catalog", req); }
});

/* التحقق المشترك بين الحفظ والمعاينة والإرسال التجريبي */
async function checkBody(key, b) {
  const def = MESSAGES[key];
  if (!def) return { status: 404, body: { error: "unknown_message" } };
  const subject = b.subject === undefined ? undefined : String(b.subject || "").trim();
  const body = b.body === undefined ? undefined : String(b.body || "");
  const eff = await effectiveDefinition(key);
  const v = validateMessageText(key, subject ?? eff.subject, body ?? eff.body);
  if (v) return { status: 400, body: v };
  if (subject !== undefined && (!subject || subject.length > 200)) return { status: 400, body: { error: "invalid_subject" } };
  if (body !== undefined && (!body.trim() || body.length > 5000)) return { status: 400, body: { error: "invalid_body" } };
  let templateId;
  if (b.templateId !== undefined) {
    templateId = b.templateId || null;
    if (templateId && !(await query(`SELECT 1 FROM message_templates WHERE id = $1`, [templateId])).rows[0]) return { status: 400, body: { error: "unknown_template" } };
  }
  let channels;
  if (b.channels !== undefined) {
    if (!Array.isArray(b.channels) || !b.channels.length) return { status: 400, body: { error: "channels_required" } };
    channels = [...new Set(b.channels)];
    const notAllowed = channels.filter((c) => !def.allowed.includes(c));
    if (notAllowed.length) return { status: 400, body: { error: "channel_not_allowed", detail: notAllowed } };
    const missingReq = def.required.filter((c) => !channels.includes(c));
    if (missingReq.length) return { status: 400, body: { error: "required_channel_missing", detail: missingReq } };
    const av = await channelAvailability();
    const off = channels.filter((c) => !av[c]?.ok && !def.required.includes(c));
    if (off.length) return { status: 422, body: { error: "channel_unavailable", detail: off.map((c) => ({ channel: c, reason: av[c]?.reason })) } };
  }
  return { ok: true, subject, body, templateId, channels, eff };
}

// PUT /admin/message-catalog/:key  { subject?, body?, templateId?, channels?, reason }
messageCatalogRouter.put("/message-catalog/:key", requireAdminAuth, requirePermission("app_settings:edit"), async (req, res) => {
  const reason = reasonOf(req);
  if (!reason) return res.status(400).json({ error: "reason_required" });
  try {
    const c = await checkBody(req.params.key, req.body || {});
    if (!c.ok) return res.status(c.status).json(c.body);
    const before = { subject: c.eff.subject, body: c.eff.body, templateId: c.eff.templateId, channels: c.eff.channels };
    const { rows: [row] } = await query(
      `INSERT INTO message_definitions (key, subject, body, template_id, channels, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (key) DO UPDATE SET
         subject = COALESCE($2, message_definitions.subject), body = COALESCE($3, message_definitions.body),
         template_id = CASE WHEN $7 THEN $4 ELSE message_definitions.template_id END,
         channels = COALESCE($5, message_definitions.channels), updated_at = now(), updated_by = $6
       RETURNING key`,
      [req.params.key, c.subject ?? null, c.body ?? null, c.templateId ?? null, c.channels ?? null, req.admin.id, c.templateId !== undefined]);
    const after = await effectiveDefinition(row.key);
    const pick = (x) => ({ subject: x.subject, body: x.body, templateId: x.templateId, channels: x.channels });
    await logAdminAction({ adminUserId: req.admin.id, action: "message_definition_edit", entity: "message_definition", entityId: row.key, oldValue: before, newValue: pick(after), reason, ipAddress: req.ip });
    res.json({ ok: true, message: pick(after) });
  } catch (err) { return fail(res, err, "admin/message-catalog:put", req); }
});

// DELETE /admin/message-catalog/:key?reason= — العودة إلى النص الافتراضي
messageCatalogRouter.delete("/message-catalog/:key", requireAdminAuth, requirePermission("app_settings:edit"), async (req, res) => {
  const reason = reasonOf(req);
  if (!reason) return res.status(400).json({ error: "reason_required" });
  if (!MESSAGES[req.params.key]) return res.status(404).json({ error: "unknown_message" });
  try {
    const before = await effectiveDefinition(req.params.key);
    await query(`DELETE FROM message_definitions WHERE key = $1`, [req.params.key]);
    await logAdminAction({ adminUserId: req.admin.id, action: "message_definition_reset", entity: "message_definition", entityId: req.params.key,
      oldValue: { subject: before.subject, body: before.body, templateId: before.templateId, channels: before.channels }, newValue: { default: true }, reason, ipAddress: req.ip });
    res.json({ ok: true });
  } catch (err) { return fail(res, err, "admin/message-catalog:reset", req); }
});

// POST /admin/message-catalog/:key/preview  { subject?, body?, templateId? } — بقيم نموذجية، بلا حفظ ولا إرسال
messageCatalogRouter.post("/message-catalog/:key/preview", requireAdminAuth, requirePermission("app_settings:view"), async (req, res) => {
  try {
    const c = await checkBody(req.params.key, { ...(req.body || {}), channels: undefined });
    if (!c.ok) return res.status(c.status).json(c.body);
    const m = await renderMessage(req.params.key, MESSAGES[req.params.key].sample, {
      ...(c.subject !== undefined ? { subject: c.subject } : {}), ...(c.body !== undefined ? { body: c.body } : {}),
      ...(c.templateId !== undefined ? { templateId: c.templateId } : {}),
    });
    res.json({ subject: m.subject, text: m.text, html: m.extra.html });
  } catch (err) { return fail(res, err, "admin/message-catalog:preview", req); }
});

// POST /admin/message-catalog/:key/test-send  — إلى بريد المحرِّر وحده، بقيم نموذجية
messageCatalogRouter.post("/message-catalog/:key/test-send", requireAdminAuth, requirePermission("app_settings:edit"), async (req, res) => {
  try {
    const c = await checkBody(req.params.key, { ...(req.body || {}), channels: undefined });
    if (!c.ok) return res.status(c.status).json(c.body);
    const m = await renderMessage(req.params.key, MESSAGES[req.params.key].sample, {
      ...(c.subject !== undefined ? { subject: c.subject } : {}), ...(c.body !== undefined ? { body: c.body } : {}),
      ...(c.templateId !== undefined ? { templateId: c.templateId } : {}),
    });
    const r = await sendEmail(req.admin.email, `[تجربة] ${m.subject}`, m.text, m.extra);
    await logAdminAction({ adminUserId: req.admin.id, action: "message_test_sent", entity: "message_definition", entityId: req.params.key, newValue: { to: "editor" }, reason: "إرسال تجريبي إلى بريد المحرِّر", ipAddress: req.ip });
    res.json({ ok: true, to: req.admin.email, delivered: !(r && r.dev), note: r && r.dev ? "البريد غير مضبوط على هذا الخادم — لم تُرسل." : null });
  } catch (err) { return fail(res, err, "admin/message-catalog:test", req); }
});

/* ---------------- القوالب ---------------- */
function templateInput(b, partial) {
  const out = {};
  if (!partial || b.name !== undefined) { out.name = String(b.name || "").trim(); if (!out.name || out.name.length > 60) return { error: "invalid_name" }; }
  if (b.accent !== undefined) { if (!ACCENTS.includes(b.accent)) return { error: "invalid_accent", detail: ACCENTS }; out.accent = b.accent; }
  if (b.footerNote !== undefined) { out.footer_note = String(b.footerNote || ""); if (out.footer_note.length > 300) return { error: "footer_note_too_long" }; }
  if (b.showStoreLinks !== undefined) out.show_store_links = b.showStoreLinks === true;
  if (b.showSocialLinks !== undefined) out.show_social_links = b.showSocialLinks === true;
  return { values: out };
}

messageCatalogRouter.get("/message-templates", requireAdminAuth, requirePermission("app_settings:view"), async (req, res) => {
  try { res.json({ templates: await templates(), accents: ACCENTS }); }
  catch (err) { return fail(res, err, "admin/message-templates", req); }
});

messageCatalogRouter.post("/message-templates", requireAdminAuth, requirePermission("app_settings:edit"), async (req, res) => {
  const reason = reasonOf(req);
  if (!reason) return res.status(400).json({ error: "reason_required" });
  try {
    const t = templateInput(req.body || {}, false);
    if (t.error) return res.status(400).json(t);
    const v = { accent: "#735890", footer_note: "", show_store_links: true, show_social_links: true, ...t.values };
    const { rows: [row] } = await query(
      `INSERT INTO message_templates (name, accent, footer_note, show_store_links, show_social_links, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [v.name, v.accent, v.footer_note, v.show_store_links, v.show_social_links, req.admin.id]);
    await logAdminAction({ adminUserId: req.admin.id, action: "message_template_create", entity: "message_template", entityId: row.id, oldValue: null, newValue: v, reason, ipAddress: req.ip });
    res.status(201).json({ template: row });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "template_name_exists" });
    return fail(res, err, "admin/message-templates:create", req);
  }
});

messageCatalogRouter.put("/message-templates/:id", requireAdminAuth, requirePermission("app_settings:edit"), requireUuidParam("id"), async (req, res) => {
  const reason = reasonOf(req);
  if (!reason) return res.status(400).json({ error: "reason_required" });
  try {
    const t = templateInput(req.body || {}, true);
    if (t.error) return res.status(400).json(t);
    const { rows: [before] } = await query(`SELECT name, accent, footer_note, show_store_links, show_social_links FROM message_templates WHERE id = $1`, [req.params.id]);
    if (!before) return res.status(404).json({ error: "not_found" });
    const v = { ...before, ...t.values };
    const { rows: [after] } = await query(
      `UPDATE message_templates SET name=$2, accent=$3, footer_note=$4, show_store_links=$5, show_social_links=$6, updated_at=now(), updated_by=$7
        WHERE id=$1 RETURNING name, accent, footer_note, show_store_links, show_social_links`,
      [req.params.id, v.name, v.accent, v.footer_note, v.show_store_links, v.show_social_links, req.admin.id]);
    await logAdminAction({ adminUserId: req.admin.id, action: "message_template_edit", entity: "message_template", entityId: req.params.id, oldValue: before, newValue: after, reason, ipAddress: req.ip });
    res.json({ template: { id: req.params.id, ...after } });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "template_name_exists" });
    return fail(res, err, "admin/message-templates:edit", req);
  }
});

messageCatalogRouter.delete("/message-templates/:id", requireAdminAuth, requirePermission("app_settings:edit"), requireUuidParam("id"), async (req, res) => {
  const reason = reasonOf(req);
  if (!reason) return res.status(400).json({ error: "reason_required" });
  try {
    const { rows: [t] } = await query(`SELECT name, is_default FROM message_templates WHERE id = $1`, [req.params.id]);
    if (!t) return res.status(404).json({ error: "not_found" });
    if (t.is_default) return res.status(409).json({ error: "cannot_delete_default_template" });
    // الرسائل المربوطة به تعود إلى الافتراضي (ON DELETE SET NULL) — لا رسالة بلا قالب.
    await query(`DELETE FROM message_templates WHERE id = $1`, [req.params.id]);
    await logAdminAction({ adminUserId: req.admin.id, action: "message_template_delete", entity: "message_template", entityId: req.params.id, oldValue: t, reason, ipAddress: req.ip });
    res.json({ ok: true });
  } catch (err) { return fail(res, err, "admin/message-templates:delete", req); }
});
