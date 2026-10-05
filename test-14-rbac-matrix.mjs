import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0001 — مصفوفة الصلاحيات (R15-24).
 *
 *  M) المصفوفة المولّدة من الكود (tools/rbac-matrix.mjs) متسقة: لا صلاحية
 *     مجهولة على مسار، ولا صلاحية بلا مستعمل، ولا مستدعٍ لـrequireRole،
 *     وكل مسار إدارة غير عام محمي بالدخول.
 *  S) الخادم يطابق المصفوفة: لكل مسار GET إداري ولكل دور، 403 إن لم يكن
 *     الدور في rolesAllowed، وغير 403 إن كان فيه.
 *  P) لا طريق غير مباشر إلى النص النفسي الخاص: نزرع نصاً مميزاً في كل
 *     جدول يحمل نصاً نفسياً/خاصاً لمستخدم يملك دفعة وفاتورة، ثم نطلب
 *     كل مسار GET يصل إليه كل دور (مع كل معرّف مزروع) — النص لا يظهر.
 */
requireDedicatedDatabase(import.meta.url);
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

Object.assign(process.env, { PORT: "4642", SKIP_PDF_BOOT_CHECK: "1", ALLOWED_ORIGINS: "http://127.0.0.1:5173",
  SWEEP_MIN_INTERVAL_MS: "999999999", REMINDER_SWEEP_MIN_INTERVAL_MS: "999999999" });

/* مزوّد دفع وهمي — لا طلب يغادر الجهاز */
const realFetch = globalThis.fetch;
const provPayments = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (!href.startsWith("https://api.moyasar.com")) return realFetch(url, opts);
  const json = (s, p) => new Response(JSON.stringify(p), { status: s, headers: { "Content-Type": "application/json" } });
  const m = /\/payments\/([^/?]+)$/.exec(href);
  if (m && provPayments.has(m[1])) return json(200, provPayments.get(m[1]));
  return json(404, { message: "unmocked" });
};
const logs = []; const rl = console.log, re = console.error, rw = console.warn;
console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;

const { collect } = await import("./tools/rbac-matrix.mjs");
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
await new Promise((r) => setTimeout(r, 300));
const B = "http://127.0.0.1:4642";
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);

try {
  const matrix = await collect();
  const c = matrix.checks;
  ok("M1 no route requires a permission missing from the catalog", c.unknownPermissionsOnRoutes.length === 0, JSON.stringify(c.unknownPermissionsOnRoutes));
  ok("M2 every catalog permission is enforced somewhere (route or inline check)", c.permissionsWithoutRouteOrInlineCheck.length === 0, JSON.stringify(c.permissionsWithoutRouteOrInlineCheck));
  ok("M3 legacy rank model unused: zero requireRole callers", c.requireRoleCallers.length === 0, JSON.stringify(c.requireRoleCallers));
  const PUBLIC = new Set(["POST /admin/auth/login", "POST /admin/auth/logout", "POST /admin/auth/refresh", "POST /admin/setup/accept", "GET /admin/setup/validate"]);
  ok("M4 every non-public admin route requires admin sign-in", c.adminRoutesWithoutAuth.every((x) => PUBLIC.has(x)), JSON.stringify(c.adminRoutesWithoutAuth));
  const AUTH_ONLY = new Set(["PATCH /admin/admin-users/:id", "GET /admin/auth/me"]);
  ok("M5 sign-in-only routes are exactly the known ones (each checks permissions inside)", c.adminRoutesAuthOnly.length === AUTH_ONLY.size && c.adminRoutesAuthOnly.every((x) => AUTH_ONLY.has(x)), JSON.stringify(c.adminRoutesAuthOnly));
  const owner = matrix.roles.find((r) => r.role === "owner");
  ok("M6 owner holds every permission (computed, not hand-listed)", owner.count === c.permissionCount, `${owner.count}/${c.permissionCount}`);
  const acc = matrix.permissions.filter((p) => p.roles.accountant).map((p) => p.permission);
  ok("M7 accountant holds no users:* / break_glass:* / audit_log:* permission", !acc.some((p) => /^(users|break_glass|audit_log|admins|content|messages):/.test(p)), JSON.stringify(acc));

  /* ---------- زرع ---------- */
  const SENT = "KANAF_SENTINEL_" + crypto.randomBytes(4).toString("hex");
  const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at) VALUES ('مستخدم مصفوفة',$1,'x',now()) RETURNING id`, [`rbac-${crypto.randomBytes(2).toString("hex")}@kanaf.test`]);
  await query(`INSERT INTO daily_logs (user_id,mood,sleep,energy,note,tags,logged_on) VALUES ($1,3,4,5,$2,ARRAY[$2],current_date)`, [u.id, `${SENT} note`]);
  await query(`INSERT INTO screenings (user_id,kind,total,band_label,answers) VALUES ($1,'phq9',5,'خفيف',$2)`, [u.id, JSON.stringify({ q1: `${SENT} ans` })]);
  await query(`INSERT INTO user_cbt_sessions (user_id,tool_id,payload) VALUES ($1,'thought_record',$2)`, [u.id, JSON.stringify({ text: `${SENT} cbt` })]);
  await query(`INSERT INTO user_notebook_entries (user_id,template_key,answers) VALUES ($1,'t',$2)`, [u.id, JSON.stringify({ a: `${SENT} notebook` })]);
  await query(`INSERT INTO user_plans (user_id,source,summary,focus_areas,specialist_note,check_in) VALUES ($1,'initial',$2,$3,$2,$4)`,
    [u.id, `${SENT} plan`, JSON.stringify([`${SENT} focus`]), JSON.stringify({ c: `${SENT} checkin` })]);
  await query(`INSERT INTO user_safety_plans (user_id,warning_signs,coping_strategies,safe_place) VALUES ($1,$2,$2,$2)`, [u.id, `${SENT} safety`]);
  await query(`INSERT INTO user_support_contacts (user_id,position,name,phone,relationship) VALUES ($1,1,$2,'+966500000001',$3)`, [u.id, `${SENT}c`, `${SENT}r`.slice(0, 60)]);

  /* دفعة وفاتورة لنفس المستخدم — حتى يكون للمسار المالي ما يربطه به */
  const { rows: [inv] } = await query(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, provider_invoice_id) VALUES ($1,'monthly',29,'pending','mo_inv_rbac') RETURNING id`, [u.id]);
  const pid = `mo_pay_rbac_${crypto.randomBytes(2).toString("hex")}`;
  provPayments.set(pid, { id: pid, status: "paid", amount: 2900, refunded: 0, refunded_amount: 0, currency: "SAR" });
  const wh = await realFetch(`${B}/api/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    id: `evt_${pid}`, type: "payment_paid", secret_token: process.env.PAYMENT_WEBHOOK_SECRET,
    data: { id: pid, status: "paid", amount: 2900, currency: "SAR", invoice_id: "mo_inv_rbac", source: { type: "creditcard", company: "mada", number: "XXXX4444" }, metadata: { kanaf_invoice_id: inv.id } } }) });
  const { rows: [pay] } = await query(`SELECT id FROM payments WHERE provider_payment_id = $1`, [pid]);
  const { rows: [ev] } = await query(`SELECT id FROM webhook_events ORDER BY received_at DESC NULLS LAST LIMIT 1`).catch(() => ({ rows: [{}] }));
  ok("P0 seed: sentinel text in 7 private tables + a paid payment for the same user", wh.status === 200 && !!pay, String(wh.status));

  /* ---------- مدراء بكل الأدوار ---------- */
  const roles = matrix.roles.map((r) => r.role);
  const cookieFor = {};
  for (const role of roles) {
    const base = role === "accountant" ? "support" : role;
    const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role,active) VALUES ($1,$2,'x',$3,true) RETURNING id`, [`م ${role}`, `rbac-${role}@kanaf.test`, base]);
    if (role === "accountant") await query(`INSERT INTO admin_role_assignments (admin_user_id, role) VALUES ($1,'accountant')`, [a.id]);
    cookieFor[role] = `kanaf_admin_access=${jwt.sign({ sub: a.id, role: base, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  }

  const ids = [u.id, pay?.id, inv.id, ev?.id].filter(Boolean);
  const fill = (p) => {
    if (!p.includes(":")) return [p];
    if (p.includes(":type/:key")) return [p.replace(":type", "exercise").replace(":key", "x")];
    return ids.map((id) => p.replace(/:id\b/g, id));
  };
  const gets = matrix.routes.filter((r) => r.isAdmin && r.method === "GET" && r.middleware.includes("requireAdminAuth"));
  const mismatches = [], leaks = [], reached = Object.fromEntries(roles.map((r) => [r, 0]));
  for (const role of roles) {
    for (const r of gets) {
      const allowed = r.rolesAllowed.includes(role);
      for (const p of fill(r.path)) {
        const q = `?reason=${encodeURIComponent("فحص مصفوفة الصلاحيات")}&userId=${u.id}&limit=200`;
        const res = await realFetch(B + p + q, { headers: { Cookie: cookieFor[role] } });
        const buf = Buffer.from(await res.arrayBuffer());
        if ((res.status === 403) === allowed) mismatches.push(`${role} ${r.path} → ${res.status} (matrix: ${allowed ? "allowed" : "denied"})`);
        if (res.status < 300) reached[role]++;
        if (buf.toString("utf8").includes(SENT)) leaks.push(`${role} GET ${p} (${res.status})`);
      }
    }
  }
  ok(`S1 server enforces exactly the generated matrix on ${gets.length} admin GET routes × ${roles.length} roles`, mismatches.length === 0, mismatches.slice(0, 6).join(" | "));
  ok("S2 every role actually reached data (sweep is not vacuous)", roles.every((r) => reached[r] > 0), JSON.stringify(reached));
  ok("P1 no role — including finance and owner — reads private psychological text through any admin GET route", leaks.length === 0, leaks.join(" | "));
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 400), false]); }

console.log = rl; console.error = re; console.warn = rw;
let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
if (f) console.log(logs.slice(-15).join("\n"));
await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
