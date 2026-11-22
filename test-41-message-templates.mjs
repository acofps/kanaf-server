import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0013 §9 — محتوى الإشعارات وقوالبها.
 *  G) 🔴 حفظ نص تحقق بلا موضع الرمز يُرفض، وموضع مجهول يُرفض — ولا شيء يُحفظ.
 *  T) 🔴 ربط إشعار بقالب ثانٍ: البريد الذي يخرج فعلاً (SMTP) مبنيّ عليه — نصّه ولونه وتذييله.
 *  D) الافتراضي محفوظ: بلا تعديل يخرج النص السابق حرفاً، والقالب الافتراضي لا يُحذف.
 *  C) القنوات: المسموحة وحدها، والإلزامية لا تُطفأ، والمعطّلة لا تُفعَّل.
 *  A) كل تعديل في سجل الإجراءات بالقيمتين، والتعديل للمالك، والمعاينة لا تحفظ، والتجربة لبريد المحرِّر.
 *  S) 9.3: سجل رسائل النظام بلا عمود نص.
 */
requireDedicatedDatabase(import.meta.url);
import { startSmtpSink, mimeParts } from "./test-support/smtp-sink.mjs";
const sink = await startSmtpSink();
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { messageCatalogRouter } = await import("./admin/message-catalog.js");
const { authRouter } = await import("./auth/routes.js");
for (const k of ["error", "warn"]) console[k] = () => {};

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser());
app.use("/admin", messageCatalogRouter); app.use("/api/auth", authRouter);
const server = app.listen(4642); const B = "http://127.0.0.1:4642";
let cookie = "", editorEmail = "";
const as = async (role) => {
  editorEmail = `mt-${role}-${Math.random().toString(36).slice(2, 8)}@kanaf.test`;
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ($1,$2,'x',$3) RETURNING id`, [`mt ${role}`, editorEmail, role]);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: a.id, role, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  return a.id;
};
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ } return { status: r.status, body: json, raw };
};
const lastMail = () => { const m = sink.inbox[sink.inbox.length - 1]; const p = mimeParts(m.data); return { to: m.to.join(","), html: p.find((x) => x.type === "text/html")?.text || "", text: p.find((x) => x.type === "text/plain")?.text || "", raw: m.data }; };

try {
  /* ---------- D) الافتراضي ---------- */
  await as("admin");
  let r = await call("GET", "/admin/message-catalog");
  const ver = (r.body.messages || []).find((m) => m.key === "email_verification");
  ok("D1 الجرد يعرض رسائل النظام بأنواعها، والمدير يراها", r.status === 200 && r.body.messages.length >= 10 && ver && ver.required.includes("code") && r.body.templates.some((t) => t.is_default));
  r = await call("PUT", "/admin/message-catalog/email_verification", { body: "x {{code}}", reason: "r" });
  ok("A1 المدير لا يعدّل نصاً يصل إلى المستخدم (app_settings:edit للمالك) → 403", r.status === 403);

  const ownerId = await as("owner");
  await fetch(`${B}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "قبل", email: "before-mt@example.com", password: "Tanfs-Template-2026-a", confirmedAdult: true, agreedPolicy: true }) });
  await sink.waitMail(1);
  const before = lastMail();
  ok("D2 بلا تعديل: رسالة التحقق بالنص السابق حرفاً (أهلاً … كود تأكيد بريدك في تنفس: ######)", /أهلاً قبل،/.test(before.text) && /كود تأكيد بريدك في تنفس: \d{6}/.test(before.text) && /tanfs\.net/.test(before.text) && /color:#735890/.test(before.html), before.text.slice(0, 120));

  /* ---------- G) 🔴 العناصر الإلزامية ---------- */
  r = await call("PUT", "/admin/message-catalog/email_verification", { body: "أهلاً {{name}}، أهلاً بك في تنفس.", reason: "تجربة" });
  const saved = (await query(`SELECT count(*)::int n FROM message_definitions WHERE key = 'email_verification'`)).rows[0].n;
  ok("G1 🔴 نص تحقق بلا موضع الرمز → 400 required_placeholder_missing، ولا شيء محفوظ", r.status === 400 && r.body.error === "required_placeholder_missing" && r.body.detail?.[0] === "{{code}}" && saved === 0, r.raw);
  r = await call("PUT", "/admin/message-catalog/email_verification", { body: "{{code}} وكلمة مرورك {{password}}", reason: "r" });
  ok("G2 موضع مجهول ({{password}}) → 400 unknown_placeholder", r.status === 400 && r.body.error === "unknown_placeholder" && r.body.detail?.includes("password"));
  r = await call("PUT", "/admin/message-catalog/admin_invite", { body: "مرحباً {{name}}", reason: "r" });
  ok("G3 دعوة الإدارة بلا {{url}} → 400 (رابط الدعوة إلزامي)", r.status === 400 && r.body.detail?.[0] === "{{url}}");

  /* ---------- T) 🔴 قالب ثانٍ ---------- */
  r = await call("POST", "/admin/message-templates", { name: "قالب رمضان", accent: "#402F53", footerNote: "رمضان كريم من فريق تنفس", showStoreLinks: false, reason: "موسم رمضان" });
  const tid = r.body.template?.id;
  ok("T1 إنشاء قالب ثانٍ وتسميته", r.status === 201 && tid);
  r = await call("POST", "/admin/message-templates", { name: "قالب رمضان", reason: "r" });
  ok("T1b اسم قالب مكرر → 409", r.status === 409);
  r = await call("POST", "/admin/message-templates", { name: "لون خارج اللوحة", accent: "#FF0000", reason: "r" });
  ok("T1c لون خارج اللوحة المقيسة → 400", r.status === 400 && r.body.error === "invalid_accent");
  r = await call("PUT", "/admin/message-catalog/email_verification", {
    subject: "رمزك في تنفس", body: "يا {{name}}، رمزك هو {{code}} وصالح {{minutes}} دقائق.", templateId: tid, reason: "نص أوضح",
  });
  ok("T2 حفظ نص التحقق مع الرمز وربطه بالقالب الثاني → 200", r.status === 200 && r.body.message.templateId === tid, r.raw);
  await fetch(`${B}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "بعد", email: "after-mt@example.com", password: "Tanfs-Template-2026-a", confirmedAdult: true, agreedPolicy: true }) });
  await sink.waitMail(2);
  const after = lastMail();
  ok("T3 🔴 البريد المرسَل فعلاً بالنص الجديد والرمز مستبدَل", /يا بعد، رمزك هو \d{6} وصالح \d+ دقائق\./.test(after.text) && /Subject: =\?UTF-8|رمزك في تنفس/.test(after.raw), after.text.slice(0, 120));
  ok("T4 🔴 والمبنيّ على القالب الثاني: لونه وتذييله، وبلا روابط المتجرين", /color:#402F53/.test(after.html) && after.html.includes("رمضان كريم من فريق تنفس") && !/color:#735890;">/.test(after.html.split("<h1")[1]?.slice(0, 80) || ""), after.html.slice(after.html.indexOf("<h1"), after.html.indexOf("<h1") + 120));
  ok("T5 والقالب الافتراضي لم يتغيّر لرسالة أخرى (استعادة كلمة المرور)", (await (async () => {
    const { renderMessage } = await import("./notifications/messages.js");
    const m = await renderMessage("password_reset", { name: "س", code: "111111", minutes: 10 });
    return /color:#735890/.test(m.extra.html) && !m.extra.html.includes("رمضان كريم");
  })()));

  /* ---------- A) الأثر ---------- */
  const { rows: [aud] } = await query(`SELECT admin_user_id, old_value, new_value, reason FROM admin_action_log WHERE action = 'message_definition_edit' ORDER BY created_at DESC LIMIT 1`);
  ok("A2 التعديل في سجل الإجراءات بالقيمتين (النص والقالب قبل وبعد) وباسم المحرِّر", aud && aud.admin_user_id === ownerId && aud.old_value.body.includes("كود تأكيد بريدك") && aud.new_value.body.includes("رمزك هو") && aud.old_value.templateId === null && aud.new_value.templateId === tid);
  r = await call("POST", "/admin/message-catalog/email_verification/preview", { body: "معاينة {{code}}" });
  const still = (await query(`SELECT body FROM message_definitions WHERE key = 'email_verification'`)).rows[0].body;
  ok("A3 المعاينة تعيد الرسالة بقيم نموذجية ولا تحفظ", r.status === 200 && r.body.text === "معاينة 482913" && r.body.html.includes("<h1") && still.includes("رمزك هو"));
  const n0 = sink.inbox.length;
  r = await call("POST", "/admin/message-catalog/email_verification/test-send", {});
  await sink.waitMail(n0 + 1);
  ok("A4 الإرسال التجريبي إلى بريد المحرِّر وحده", r.status === 200 && sink.inbox.length === n0 + 1 && lastMail().to.includes(editorEmail));

  /* ---------- C) القنوات ---------- */
  r = await call("PUT", "/admin/message-catalog/email_verification", { channels: ["whatsapp", "email"], reason: "r" });
  ok("C1 قناة غير مسموحة لرسالة التحقق → 400", r.status === 400 && r.body.error === "channel_not_allowed");
  r = await call("PUT", "/admin/message-catalog/daily_reminder", { channels: ["push"], reason: "r" });
  ok("C2 إطفاء قناة إلزامية (داخل التطبيق للتذكير) → 400", r.status === 400 && r.body.error === "required_channel_missing");
  r = await call("PUT", "/admin/message-catalog/renewal_notice", { channels: ["email", "whatsapp"], reason: "r" });
  ok("C3 قناة معطّلة (واتساب بلا اعتماد) لا تُفعَّل → 422 بسببها", r.status === 422 && r.body.error === "channel_unavailable");
  r = await call("PUT", "/admin/message-catalog/daily_reminder", { channels: ["in_app"], reason: "إيقاف إشعار الجهاز" });
  ok("C4 إطفاء قناة اختيارية (إشعار الجهاز للتذكير) → 200", r.status === 200 && JSON.stringify(r.body.message.channels) === '["in_app"]');

  /* ---------- D) الحذف ---------- */
  const { rows: [def] } = await query(`SELECT id FROM message_templates WHERE is_default`);
  r = await call("DELETE", `/admin/message-templates/${def.id}?reason=r`);
  ok("D3 القالب الافتراضي لا يُحذف → 409", r.status === 409 && r.body.error === "cannot_delete_default_template");
  r = await call("DELETE", `/admin/message-templates/${tid}?reason=${encodeURIComponent("انتهى الموسم")}`);
  const { rows: [linked] } = await query(`SELECT template_id FROM message_definitions WHERE key = 'email_verification'`);
  ok("D4 حذف القالب الثاني يعيد الرسائل المربوطة إلى الافتراضي (لا رسالة بلا قالب)", r.status === 200 && linked.template_id === null);

  /* ---------- S) 9.3 ---------- */
  const { rows: cols } = await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'system_message_log'`);
  ok("S1 سجل رسائل النظام بلا عمود نص أو عنوان أو جسم", !cols.some((c) => /text|body|subject|title|message|content/.test(c.column_name)), cols.map((c) => c.column_name).join(","));
  const { rows: logged } = await query(`SELECT * FROM system_message_log`);
  ok("S2 ولا رمز تحقق في أي صف منه", !JSON.stringify(logged).match(/\b\d{6}\b/));
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 300), false); }
finally { server.close(); sink.close(); await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 300)})` : ""}`); } }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
