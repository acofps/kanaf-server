import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0002 B-10 (F-EXTRA-AUDIT-MESSAGES) — تغيير حالة رسالة تواصل يُسجَّل
 * في سجل الإجراءات بالفاعل والحالة قبل/بعد، ولا يُنسخ نص الرسالة ولا اسم المرسل أو بريده.
 * الرسالة fixture اصطناعية في القاعدة المعزولة.
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { adminRouter } = await import("./admin/routes.js");

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/admin", adminRouter);
const server = app.listen(4602); const B = "http://127.0.0.1:4602";
let cookie;
const as = async (role) => {
  // accountant دور ممتد: صف admin_users بالدور الأساسي support + صف تعيين (نفس test-14)
  const base = role === "accountant" ? "support" : role;
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ($1,$2,'x',$3) RETURNING id`, [`b10 ${role}`, `b10-${role}@kanaf.test`, base]);
  if (role === "accountant") await query(`INSERT INTO admin_role_assignments (admin_user_id, role) VALUES ($1,'accountant')`, [a.id]);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: a.id, role: base, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  return a.id;
};
const call = async (method, path, body) => { const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const logs = async (id) => (await query(`SELECT admin_user_id, action, old_value, new_value, reason, metadata FROM admin_action_log WHERE entity = 'contact_message' AND entity_id = $1 ORDER BY created_at`, [id])).rows;

try {
  const SECRET = "نص سري لا يجب أن يُنسخ في السجل";
  const { rows: [m] } = await query(`INSERT INTO contact_messages (name, email, message) VALUES ('مرسل اختبار', 'sender-b10@kanaf.test', $1) RETURNING id`, [SECRET]);
  const sup = await as("support");
  let r = await call("POST", `/admin/messages/${m.id}/status`, { status: "read" });
  let l = await logs(m.id);
  ok("M1 status change unread → read succeeds and writes one audit row by the acting admin", r.status === 200 && l.length === 1 && l[0].admin_user_id === sup && l[0].action === "message_status_changed", JSON.stringify(l));
  ok("M2 the row holds before/after status only", l[0].old_value?.status === "unread" && l[0].new_value?.status === "read" && Object.keys(l[0].old_value).length === 1 && Object.keys(l[0].new_value).length === 1);
  ok("M3 no message text, sender name or e-mail anywhere in the audit row", !JSON.stringify(l[0]).includes(SECRET) && !JSON.stringify(l[0]).includes("sender-b10") && !JSON.stringify(l[0]).includes("مرسل اختبار"));
  r = await call("POST", `/admin/messages/${m.id}/status`, { status: "read" });
  ok("M4 setting the same status again changes nothing and logs nothing", r.status === 200 && (await logs(m.id)).length === 1);
  r = await call("POST", `/admin/messages/${m.id}/status`, { status: "replied" });
  ok("M5 read → replied logged as a second row", r.status === 200 && (await logs(m.id)).length === 2 && (await logs(m.id))[1].old_value.status === "read");
  r = await call("POST", `/admin/messages/${m.id}/status`, { status: "archived" });
  ok("M6 invalid status → 400, no row", r.status === 400 && (await logs(m.id)).length === 2);
  await as("accountant");
  r = await call("POST", `/admin/messages/${m.id}/status`, { status: "unread" });
  ok("M7 a role without messages:update_status → 403, no row", r.status === 403 && (await logs(m.id)).length === 2);
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
server.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
