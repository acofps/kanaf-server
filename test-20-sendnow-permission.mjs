import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0002 B-08 — صلاحية الإرسال عند sendNow (والجدولة).
 * كان POST /admin/notifications مع sendNow يرسل بصلاحية notifications:create وحدها.
 * لا دور حالياً يملك create بلا send، فالحالة تُصنع **داخل عملية الاختبار فقط**:
 * تُزال notifications:send من مجموعة دور admin في الذاكرة ثم تُعاد — لا تعديل
 * لملف الأدوار ولا لأي حساب أو قاعدة إنتاج. القناة in_app فقط (لا بريد ولا Push).
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { adminNotificationsRouter } = await import("./admin/notifications.js");
const { ROLE_PERMISSIONS } = await import("./admin/permissions.js");

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/admin", adminNotificationsRouter);
const server = app.listen(4600); const B = "http://127.0.0.1:4600";
let cookie;
async function call(method, path, body) {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const count = async (sql, p) => +(await query(sql, p)).rows[0].n;
const SEND = "notifications:send";

try {
  const { rows: [adm] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('مسؤول اختبار','b08-admin@kanaf.test','x','admin') RETURNING id`);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: adm.id, role: "admin", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at) VALUES ('مستلم','b08-user@kanaf.test','x',now()) RETURNING id`);
  const camp = (extra) => ({ title: "حملة اختبار", body: "نص", audience: "selected_users", audienceFilter: { userIds: [u.id] }, channels: ["in_app"], ...extra });

  /* ضابط: الدور كما هو (create + send) — السلوك القائم لا يتغير */
  let r = await call("POST", "/admin/notifications", camp({ sendNow: true }));
  ok("N0 control: a role holding create+send still sends immediately (201, 1 sent)", r.status === 201 && r.body.dispatch?.sent === 1, JSON.stringify(r.body).slice(0, 160));

  const campaignsBefore = await count(`SELECT count(*) n FROM notification_campaigns`);
  const inboxBefore = await count(`SELECT count(*) n FROM user_notifications WHERE user_id = $1`, [u.id]);
  const auditBefore = await count(`SELECT count(*) n FROM admin_action_log WHERE action = 'notification_send'`);

  ROLE_PERMISSIONS.admin.delete(SEND); // داخل هذه العملية فقط
  try {
    r = await call("POST", "/admin/notifications", camp({ sendNow: true }));
    ok("P1 create-without-send + sendNow → 403 insufficient_permission (required: notifications:send)", r.status === 403 && r.body.required === SEND, JSON.stringify(r.body));
    ok("P2 …nothing created and nothing delivered (no hidden partial success)", await count(`SELECT count(*) n FROM notification_campaigns`) === campaignsBefore
      && await count(`SELECT count(*) n FROM user_notifications WHERE user_id = $1`, [u.id]) === inboxBefore
      && await count(`SELECT count(*) n FROM admin_action_log WHERE action = 'notification_send'`) === auditBefore);
    r = await call("POST", "/admin/notifications", camp({ scheduledAt: new Date(Date.now() + 3600_000).toISOString() }));
    ok("P3 scheduling (a deferred send) is also refused without send (403), nothing created", r.status === 403 && await count(`SELECT count(*) n FROM notification_campaigns`) === campaignsBefore);
    r = await call("POST", "/admin/notifications", camp({}));
    ok("P4 a plain draft still needs only create (201, status draft, nothing delivered)", r.status === 201 && r.body.status === "draft"
      && await count(`SELECT count(*) n FROM user_notifications WHERE user_id = $1`, [u.id]) === inboxBefore, JSON.stringify(r.body).slice(0, 120));
    const draftId = r.body.id;
    r = await call("POST", `/admin/notifications/${draftId}/send`);
    ok("P5 sending that draft through the send route is refused too (403)", r.status === 403);
  } finally { ROLE_PERMISSIONS.admin.add(SEND); }
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
server.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
