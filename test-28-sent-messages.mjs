import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0008 §3 و§12.3 — الرسائل المرسلة.
 *
 *  🔴 C) أهم فحص في الأمر: كود التحقق وكود الاستعادة **لا يُخزَّنان ولا
 *     يُعادان**. نولّد أكواداً حقيقية عبر مسارات التسجيل والاستعادة،
 *     نلتقطها من مخرج البريد التجريبي، ثم نبحث عن كل كود في **كل عمود
 *     نصي في كل جدول** من القاعدة، وفي رد المسار الإداري كاملاً.
 *  L) سجل رسائل النظام: صف لكل رسالة، بلا أي عمود نص.
 *  V) الرد: المستلم مقنَّع، ونص الحملة والتذكير ظاهر، ورسائل النظام بلا نص.
 *  P) الصلاحية من الخادم (403)، والسبب إلزامي (400)، والقراءة تُسجَّل في سجل الوصول.
 *  G) الترقيم والحالة الفارغة والمرشّحات.
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { authRouter } = await import("./auth/routes.js");
const { sentMessagesRouter } = await import("./admin/sent-messages.js");

/* البريد التجريبي يطبع الرسالة كاملة على stdout — نلتقطه لنعرف الأكواد. */
const mail = [];
const realLog = console.log;
console.log = (...a) => { const s = a.join(" "); if (s.startsWith("[dev] Would send email")) mail.push(s); else realLog(...a); };

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser());
app.use("/api/auth", authRouter); app.use("/admin", sentMessagesRouter);
const server = app.listen(4628); const B = "http://127.0.0.1:4628";
let cookie = "";
const as = async (role) => {
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ($1,$2,'x',$3) RETURNING id`, [`sm ${role}`, `sm-${role}-${Date.now()}@kanaf.test`, role]);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: a.id, role, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  return a.id;
};
const call = async (method, path, body) => {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: json, raw: text };
};
const codesIn = (s) => [...s.matchAll(/(?<![0-9])(\d{6})(?![0-9])/g)].map((m) => m[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const EMAIL = `sm-user-${Date.now()}@example.com`;
  /* ---- رسائل حقيقية: تسجيل (كود) + إعادة إرسال (كود) + استعادة (كود) ---- */
  let r = await call("POST", "/api/auth/register", { name: "مستخدم الرسائل", email: EMAIL, password: "Tanaffus-Test-2026-a", confirmedAdult: true, agreedPolicy: true });
  ok("setup register 201", r.status === 201, JSON.stringify(r.body));
  await query(`UPDATE email_verification_codes SET created_at = created_at - interval '10 minutes'`); // تجاوز مهلة إعادة الإرسال
  r = await call("POST", "/api/auth/resend-code", { email: EMAIL });
  await query(`UPDATE users SET email_verified_at = now() WHERE LOWER(email) = LOWER($1)`, [EMAIL]);
  r = await call("POST", "/api/auth/forgot-password", { email: EMAIL });
  for (let i = 0; i < 40 && mail.length < 3; i++) await sleep(50); // الاستعادة ترد قبل الإرسال
  const CODES = [...new Set(mail.flatMap(codesIn))];
  ok("setup ثلاث رسائل نظام خرجت وثلاثة أكواد مختلفة التُقطت", mail.length === 3 && CODES.length === 3, `mail=${mail.length} codes=${CODES.join(",")}`);

  /* ---- L) السجل ---- */
  const { rows: cols } = await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'system_message_log' ORDER BY ordinal_position`);
  const colNames = cols.map((c) => c.column_name).join(",");
  ok("L1 الجدول بلا أي عمود نص أو عنوان أو رمز (بنيوياً)", colNames === "id,user_id,kind,channel,status,error_code,created_at", colNames);
  const { rows: logRows } = await query(`SELECT s.kind, s.channel, s.status, s.error_code FROM system_message_log s JOIN users u ON u.id = s.user_id WHERE LOWER(u.email) = LOWER($1) ORDER BY s.created_at`, [EMAIL]);
  ok("L2 صف لكل رسالة: تحقق ×2 واستعادة ×1، بريد، skipped (لا SMTP في الاختبار)",
    logRows.length === 3 && logRows.filter((x) => x.kind === "email_verification").length === 2 && logRows.filter((x) => x.kind === "password_reset").length === 1
      && logRows.every((x) => x.channel === "email" && x.status === "skipped" && x.error_code === "mail_not_configured"), JSON.stringify(logRows));

  /* ---- 🔴 C1) لا كود في أي عمود نصي في أي جدول ---- */
  const { rows: textCols } = await query(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.data_type IN ('text', 'character varying', 'character', 'jsonb', 'json', 'ARRAY')`);
  const hits = [];
  for (const { table_name: tb, column_name: col } of textCols) {
    for (const code of CODES) {
      const { rows } = await query(`SELECT count(*)::int AS n FROM "${tb}" WHERE "${col}"::text ~ $1`, [`(^|[^0-9A-Za-z])${code}([^0-9A-Za-z]|$)`]);
      if (rows[0].n) hits.push(`${tb}.${col}=${code}`);
    }
  }
  ok(`C1 🔴 لا كود تحقق أو استعادة مخزَّن نصاً في أي عمود من ${textCols.length} عموداً نصياً`, hits.length === 0 && textCols.length > 50, hits.join(" "));

  /* ---- بيانات للعرض: حملة بتسليمين + إشعار نظام (تذكير) في الصندوق ---- */
  const { rows: [u] } = await query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [EMAIL]);
  const owner = await as("owner");
  const { rows: [camp] } = await query(`INSERT INTO notification_campaigns (title, body, audience, channels, status, created_by) VALUES ('عرض اختبار', 'نص حملة ظاهر للمالك', 'all', ARRAY['in_app','email'], 'sent', $1) RETURNING id`, [owner]);
  await query(`INSERT INTO notification_deliveries (campaign_id, user_id, channel, status) VALUES ($1,$2,'in_app','delivered')`, [camp.id, u.id]);
  await query(`INSERT INTO notification_deliveries (campaign_id, user_id, channel, status, error_code, error_detail) VALUES ($1,$2,'email','failed','smtp','550 mailbox ${EMAIL} unavailable')`, [camp.id, u.id]);
  await query(`INSERT INTO user_notifications (user_id, title, body, source, dedup_key) VALUES ($1, 'وقت التسجيل اليومي', 'نص التذكير الثابت', 'system', 'daily_checkin:2026-11-18')`, [u.id]);

  /* ---- P) الصلاحية والسبب وسجل الوصول ---- */
  await as("support");
  r = await call("GET", "/admin/sent-messages?reason=x");
  ok("P1 دور بلا notifications:view_sent → 403 من الخادم", r.status === 403, String(r.status));
  await as("owner");
  r = await call("GET", "/admin/sent-messages");
  ok("P2 بلا سبب → 400 reason_required", r.status === 400 && r.body.error === "reason_required", String(r.status));
  const before = (await query(`SELECT count(*)::int AS n FROM admin_access_log WHERE action = 'view_sent_messages'`)).rows[0].n;
  r = await call("GET", "/admin/sent-messages?reason=" + encodeURIComponent("مراجعة تسليم"));
  const after = (await query(`SELECT count(*)::int AS n FROM admin_access_log WHERE action = 'view_sent_messages'`)).rows[0].n;
  ok("P3 بسبب → 200، وصف في سجل الوصول بالسبب", r.status === 200 && after === before + 1, `${r.status} ${before}->${after}`);

  /* ---- 🔴 C2) لا كود في رد المسار الإداري ---- */
  const leaked = CODES.filter((c) => r.raw.includes(c));
  ok("C2 🔴 الرد الإداري الكامل لا يحمل أي كود", leaked.length === 0, leaked.join(","));

  /* ---- V) شكل الرد ---- */
  const msgs = r.body.messages || [];
  const sys = msgs.filter((m) => m.source === "system");
  ok("V1 رسائل النظام: نص وعنوان null، وbodyWithheld، ونص ثابت", sys.length === 3 && sys.every((m) => m.body === null && m.title === null && m.bodyWithheld === true && /لا يُخزَّن/.test(m.withheldNote)), JSON.stringify(sys[0]));
  ok("V2 لا بريد كامل في الرد — مقنَّع a***@domain", !r.raw.includes(EMAIL) && msgs.every((m) => /^.\*\*\*@/.test(m.recipient.emailMasked)), msgs[0]?.recipient?.emailMasked);
  const campRows = msgs.filter((m) => m.source === "campaign");
  ok("V3 الحملة: نصها ظاهر، والحالة الحقيقية لكل قناة", campRows.length === 2 && campRows.every((m) => m.body === "نص حملة ظاهر للمالك")
    && campRows.some((m) => m.channel === "in_app" && m.status === "delivered") && campRows.some((m) => m.channel === "email" && m.status === "failed"));
  const failed = campRows.find((m) => m.status === "failed");
  ok("V4 سبب الفشل يُعاد مقنّعاً حتى لو حمل عنواناً", failed && failed.errorDetail.includes("***@") && !failed.errorDetail.includes(EMAIL), failed?.errorDetail);
  const inbox = msgs.filter((m) => m.source === "inbox");
  ok("V5 التذكير اليومي في الصندوق: نوعه daily_reminder ونصه ظاهر", inbox.length === 1 && inbox[0].kind === "daily_reminder" && inbox[0].body === "نص التذكير الثابت");

  /* ---- G) ترقيم ومرشّحات وحالة فارغة ---- */
  const total = r.body.total;
  const p1 = await call("GET", "/admin/sent-messages?reason=x&pageSize=2&page=1");
  const p2 = await call("GET", "/admin/sent-messages?reason=x&pageSize=2&page=2");
  ok("G1 الترقيم: صفحتان مختلفتان، والإجمالي ثابت", total === 6 && p1.body.messages.length === 2 && p2.body.messages.length === 2
    && p1.body.messages[0].id !== p2.body.messages[0].id && p1.body.totalPages === 3, `total=${total}`);
  const f = await call("GET", "/admin/sent-messages?reason=x&source=system&channel=email");
  ok("G2 مرشّح المصدر والقناة", f.body.total === 3 && f.body.messages.every((m) => m.source === "system"));
  const empty = await call("GET", "/admin/sent-messages?reason=x&status=queued");
  ok("G3 حالة فارغة: 200 وقائمة فارغة وصفحة واحدة", empty.status === 200 && empty.body.total === 0 && empty.body.messages.length === 0 && empty.body.totalPages === 1);
  const bad = await call("GET", "/admin/sent-messages?reason=x&status=hacked");
  ok("G4 قيمة مرشّح مجهولة → 400", bad.status === 400);
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

console.log = realLog;
let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
server.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
