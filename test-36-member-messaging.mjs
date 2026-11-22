import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0013 §4.4 — مراسلة العضو من ملفه، على آلية الحملات نفسها وسجلّها.
 *  C) توفّر القنوات: المعطّلة تُعرض معطّلة بسببها، وتُرفض في الحملة قبل إنشائها (لا قبول ثم فشل صامت).
 *  S) إرسال فردي: حملة selected_users بمستلم واحد، وصفّ تسليم لكل قناة بحالته الحقيقية.
 *  W) واتساب عبر WhatsApp Cloud API على مزوّد صوري: الرقم من ملف العميل، وفشل المزوّد يُسجَّل failed بسببه.
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
process.env.INTEGRATIONS_ENC_KEY = "b".repeat(64);
const { query, pool } = await import("./db/pool.js");
const { adminNotificationsRouter } = await import("./admin/notifications.js");
const { sentMessagesRouter } = await import("./admin/sent-messages.js");
const { encryptSecret, last4 } = await import("./integrations/crypto.js");

/* مزوّد واتساب صوري — لا طلب يغادر الجهاز */
const wa = []; let waFail = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (href.startsWith("https://graph.facebook.com/")) {
    wa.push({ href, auth: opts.headers?.Authorization, body: JSON.parse(opts.body || "{}") });
    if (waFail) return new Response(JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }), { status: 400 });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.TEST1" }] }), { status: 200 });
  }
  return realFetch(url, opts);
};
for (const k of ["log", "error", "warn"]) { const o = console[k]; console[k] = (...a) => { if (k === "log") o(...a); }; }

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser());
app.use("/admin", adminNotificationsRouter); app.use("/admin", sentMessagesRouter);
const server = app.listen(4636); const B = "http://127.0.0.1:4636";
const { rows: [adm] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('مرسل','msg-admin@kanaf.test','x','admin') RETURNING id`);
const cookie = `kanaf_admin_access=${jwt.sign({ sub: adm.id, role: "admin", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ } return { status: r.status, body: json, raw };
};
const single = (userId, channels, title = "رسالة لك") => call("POST", "/admin/notifications", {
  title, body: "نص الرسالة", audience: "selected_users", audienceFilter: { userIds: [userId] }, channels, sendNow: true,
});
const deliveries = async (campaignId) => (await query(`SELECT channel, status, error_code, provider_message_id FROM notification_deliveries WHERE campaign_id = $1 ORDER BY channel`, [campaignId])).rows;

try {
  const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,confirmed_adult,email_verified_at) VALUES ('عضو','member@kanaf.test','x',true,now()) RETURNING id`);
  await query(`INSERT INTO user_profile (user_id, country_code, phone_country_code, phone_national) VALUES ($1,'SA','966','512345678')`, [u.id]);
  const { rows: [nophone] } = await query(`INSERT INTO users (name,email,password_hash,confirmed_adult,email_verified_at) VALUES ('بلا جوال','nophone@kanaf.test','x',true,now()) RETURNING id`);

  /* ---------- C) التوفّر ---------- */
  let r = await call("GET", "/admin/notifications-channels");
  const ch = r.body.channels || {};
  ok("C1 القنوات الخمس معروضة: داخل التطبيق متاحة، وواتساب والرسائل النصية معطّلتان بسبب صريح",
    r.status === 200 && ch.in_app?.ok && ch.whatsapp?.ok === false && /واتساب غير مضبوط/.test(ch.whatsapp.reason) && ch.sms?.ok === false && /الرسائل النصية غير مضبوط/.test(ch.sms.reason), r.raw);
  ok("C2 البريد والإشعار على الجهاز يعرضان حالتهما (غير مضبوطين في بيئة الاختبار) بسبب", ch.email?.ok === false && ch.email.reason && ch.push?.ok === false && ch.push.reason);
  const before = (await query(`SELECT count(*)::int n FROM notification_campaigns`)).rows[0].n;
  r = await single(u.id, ["in_app", "whatsapp"]);
  const after = (await query(`SELECT count(*)::int n FROM notification_campaigns`)).rows[0].n;
  ok("C3 واتساب بلا اعتماد → 422 channel_unavailable بسببه، ولا حملة أُنشئت (لا قبول ثم فشل)", r.status === 422 && r.body.error === "channel_unavailable" && r.body.detail?.[0]?.channel === "whatsapp" && after === before, r.raw);
  r = await single(u.id, ["sms"]);
  ok("C4 الرسائل النصية → 422 (المزوّد لم يُحدَّد)", r.status === 422 && r.body.detail?.[0]?.channel === "sms");
  r = await single(u.id, ["push"]);
  ok("C5 الإشعار على الجهاز بلا VAPID → 400 push_not_configured (القائم)", r.status === 400 && r.body.error === "push_not_configured");

  /* ضبط اعتماد واتساب كما تحفظه صفحة التكاملات */
  for (const [k, v] of [["access_token", "EAAG-test-token"], ["phone_number_id", "1234567890"]]) {
    const e = encryptSecret(v);
    await query(`INSERT INTO integration_credentials (service, key_name, ciphertext, iv, auth_tag, last4, updated_by) VALUES ('whatsapp',$1,$2,$3,$4,$5,$6)`, [k, e.ciphertext, e.iv, e.authTag, last4(v), adm.id]);
  }
  r = await call("GET", "/admin/notifications-channels");
  ok("C6 بعد ضبط الاعتماد صارت واتساب متاحة", r.body.channels?.whatsapp?.ok === true);
  ok("C7 الرد لا يحمل أي سرّ", !r.raw.includes("EAAG-test-token") && !r.raw.includes("1234567890"));

  /* ---------- S/W) إرسال فردي ---------- */
  r = await single(u.id, ["in_app", "whatsapp", "email"]);
  const cid = r.body.id;
  const d = await deliveries(cid);
  const by = Object.fromEntries(d.map((x) => [x.channel, x]));
  ok("S1 إرسال فردي = حملة selected_users بمستلم واحد", [200, 201, 202].includes(r.status) && r.body.audienceCount === 1, r.raw);
  ok("S2 صفّ تسليم لكل قناة: داخل التطبيق delivered، وواتساب sent برقم رسالة المزوّد", by.in_app?.status === "delivered" && by.whatsapp?.status === "sent" && by.whatsapp.provider_message_id === "wamid.TEST1", JSON.stringify(d));
  ok("S3 البريد بلا SMTP يُسجَّل skipped بسببه (mail_not_configured) لا sent كاذبة", by.email?.status === "skipped" && by.email.error_code === "mail_not_configured");
  ok("W1 طلب واتساب: الرقم من ملف العميل، والرمز في الترويسة، والنص من الحملة",
    wa.length === 1 && wa[0].body.to === "966512345678" && wa[0].auth === "Bearer EAAG-test-token" && /1234567890\/messages$/.test(wa[0].href) && wa[0].body.text.body.includes("نص الرسالة"), JSON.stringify(wa[0]));

  waFail = true;
  r = await single(u.id, ["whatsapp"], "رسالة ثانية");
  const d2 = await deliveries(r.body.id);
  const { rows: [c2] } = await query(`SELECT status FROM notification_campaigns WHERE id = $1`, [r.body.id]);
  ok("W2 رفض المزوّد → failed برمزه ورسالته، والحملة failed لا sent", d2[0]?.status === "failed" && d2[0].error_code === "whatsapp_131047" && c2.status === "failed", JSON.stringify({ d2, c2 }));
  waFail = false;
  r = await single(nophone.id, ["whatsapp"], "لمن لا جوال له");
  const d3 = await deliveries(r.body.id);
  ok("W3 عضو بلا جوال → skipped no_phone (لا طلب للمزوّد)", d3[0]?.status === "skipped" && d3[0].error_code === "no_phone" && wa.length === 2);

  /* الأثر في سجل الإجراءات: الإرسال الفردي حملة مسجّلة كغيرها */
  const { rows: logs } = await query(`SELECT action FROM admin_action_log WHERE metadata->>'campaign_id' = $1 ORDER BY created_at`, [cid]);
  ok("S4 الإرسال الفردي في سجل الإجراءات كأي حملة (إنشاء ثم إرسال)", logs.map((x) => x.action).join(",") === "notification_create,notification_send", JSON.stringify(logs));
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 300), false); }
finally { server.close(); await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; process.stdout.write(`  PASS  ${l}\n`); } else { fail++; process.stdout.write(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 300)})` : ""}\n`); } }
process.stdout.write(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
