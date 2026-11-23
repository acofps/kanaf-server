import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0013 §5 — حسابات الإدارة: الإضافة المباشرة ومنح الصفحات.
 *  G) 🔴 التأشير لا يوسّع صلاحية دور (§5.2) — من الخادم لا من الواجهة:
 *     محاسب مؤشَّر له «المستخدمون» لا يصل إلى البيانات النفسية ولا يعلّق حساباً ولا يتصفّح المستخدمين.
 *  N) التضييق يعمل: مدير مؤشَّر له «المستخدمون» وحدها يصل إليها ولا يصل إلى المالية.
 *  D) الإضافة المباشرة: المهام → دوران قائمان، لا owner، كلمة مرور بقاعدة واحدة، جوال، سجل بلا كلمة مرور.
 *  M) كل صلاحية في السجل لها صفحة — صلاحية بلا صفحة تصير مخفية عن كل حساب مضيَّق.
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { adminAccountsRouter } = await import("./admin/accounts.js");
const { adminRouter } = await import("./admin/routes.js");
const { PERMISSION_CATALOG, PERMISSION_PAGES, PAGE_KEYS } = await import("./admin/permissions.js");
const { ADMIN_MIN_PASSWORD_LENGTH } = await import("./admin/password-rule.js");
const fs = await import("node:fs");
for (const k of ["error", "warn"]) console[k] = () => {};

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser());
app.use("/admin", adminAccountsRouter); app.use("/admin", adminRouter);
const server = app.listen(4638); const B = "http://127.0.0.1:4638";
let cookie = "";
const login = (id, role) => { cookie = `kanaf_admin_access=${jwt.sign({ sub: id, role, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`; };
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ } return { status: r.status, body: json, raw };
};
const PW = "x".repeat(ADMIN_MIN_PASSWORD_LENGTH);

try {
  /* ---------- M) اكتمال الخريطة ---------- */
  const unmapped = Object.keys(PERMISSION_CATALOG).filter((p) => !(PERMISSION_PAGES[p] || []).length);
  const badPages = Object.values(PERMISSION_PAGES).flat().filter((pg) => !PAGE_KEYS.includes(pg));
  ok("M1 كل صلاحية في السجل لها صفحة، وكل صفحة مذكورة معروفة", unmapped.length === 0 && badPages.length === 0, unmapped.concat(badPages).join(","));

  const { rows: [owner] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('المالك','o-acc@kanaf.test','x','owner') RETURNING id`);
  const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,confirmed_adult,email_verified_at) VALUES ('عميل','c-acc@kanaf.test','x',true,now()) RETURNING id`);
  await query(`INSERT INTO daily_logs (user_id, mood, sleep, energy, note, logged_on) VALUES ($1, 2, 2, 2, 'نص-نفسي-سري', CURRENT_DATE)`, [u.id]);

  /* ---------- D) الإضافة المباشرة ---------- */
  login(owner.id, "owner");
  let r = await call("POST", "/admin/admin-users/direct", { name: "م", email: "short@kanaf.test", password: "x".repeat(ADMIN_MIN_PASSWORD_LENGTH - 1), duties: ["finance"], reason: "r" });
  ok(`D1 كلمة مرور أقل من ${ADMIN_MIN_PASSWORD_LENGTH} → 400 (القاعدة الواحدة)`, r.status === 400 && r.body.error === "password_too_short");
  r = await call("POST", "/admin/admin-users/direct", { name: "م", email: "o2@kanaf.test", password: PW, duties: ["owner"], reason: "r" });
  ok("D2 لا دور owner من الإضافة المباشرة (المهام لا تخرج عن مهمتين)", r.status === 400 && r.body.error === "invalid_duties");
  r = await call("POST", "/admin/admin-users/direct", { name: "م", email: "p@kanaf.test", password: PW, duties: ["finance"], pages: ["users", "no-such-page"], reason: "r" });
  ok("D3 صفحة غير معروفة → 400", r.status === 400 && r.body.error === "invalid_pages");
  r = await call("POST", "/admin/admin-users/direct", { name: "موظف مالي", email: "fin@kanaf.test", phone: "+966 512 345 678", password: PW, duties: ["finance"], pages: ["users"], reason: "تعيين موظف مالية" });
  ok("D4 مهام مالية → accountant، فعّال فوراً، بالجوال والصفحات", r.status === 201 && r.body.adminUser.role === "accountant" && r.body.adminUser.active === true && r.body.adminUser.phone === "+966512345678" && JSON.stringify(r.body.adminUser.pageGrants) === '["users"]', r.raw);
  const accId = r.body.adminUser.id;
  const { rows: [aud] } = await query(`SELECT new_value::text AS v FROM admin_action_log WHERE action = 'admin_account_created_direct' AND entity_id = $1`, [accId]);
  ok("D5 الإنشاء في سجل الإجراءات، وبلا كلمة المرور", aud && !aud.v.includes(PW) && aud.v.includes("accountant"));
  r = await call("POST", "/admin/admin-users/direct", { name: "مدير", email: "adm@kanaf.test", password: PW, duties: ["admin", "finance"], pages: ["users"], reason: "تعيين" });
  ok("D6 المهمتان معاً → admin (صلاحياته تشمل المحاسب)", r.status === 201 && r.body.adminUser.role === "admin");
  const admId = r.body.adminUser.id;
  r = await call("POST", "/admin/admin-users/direct", { name: "مكرر", email: "FIN@kanaf.test", password: PW, duties: ["finance"], reason: "r" });
  ok("D7 بريد مستعمل → 409", r.status === 409);
  r = await call("GET", "/admin/admin-users");
  ok("D8 «دعوة حساب» القائمة باقية بجانب الإضافة، والقائمة تعيد صفحات اللوحة للتأشير", r.status === 200 && Array.isArray(r.body.pages) && r.body.pages.length === PAGE_KEYS.length);
  const accRow = (await query(`SELECT password_hash FROM admin_users WHERE id = $1`, [accId])).rows[0];
  ok("D9 كلمة المرور مخزَّنة bcrypt لا نصاً", /^\$2[aby]\$/.test(accRow.password_hash) && !accRow.password_hash.includes(PW));

  /* ---------- G) 🔴 التأشير لا يوسّع ---------- */
  login(accId, "support");
  r = await call("GET", "/admin/auth/me");
  ok("G1 /auth/me للمحاسب المؤشَّر له «المستخدمون»: لا users:view ولا view_sensitive ولا suspend", r.status === 200
    && !r.body.admin.permissions.includes("users:view") && !r.body.admin.permissions.includes("users:view_sensitive") && !r.body.admin.permissions.includes("users:suspend"), JSON.stringify(r.body.admin?.permissions));
  r = await call("GET", `/admin/users/${u.id}/sensitive?reason=${encodeURIComponent("فضول")}`);
  ok("G2 البيانات النفسية → 403 من الخادم", r.status === 403 && !r.raw.includes("نص-نفسي-سري"));
  r = await call("POST", `/admin/users/${u.id}/suspend`, { reason: "اختبار" });
  ok("G3 تعليق حساب → 403 من الخادم", r.status === 403);
  const { rows: [st] } = await query(`SELECT suspended_at FROM user_auth_state WHERE user_id = $1`, [u.id]);
  ok("G4 والحساب لم يُعلَّق فعلاً", !st || st.suspended_at === null);
  r = await call("GET", "/admin/users");
  ok("G5 ولا يتصفّح قائمة المستخدمين — الدور لا يملكها، والتأشير لا يمنحها", r.status === 403);
  r = await call("GET", "/admin/billing/payments");
  ok("G6 والتضييق يسري عليه أيضاً: المالية خارج صفحاته → 403 رغم أن دوره يملكها", r.status === 403);

  /* ---------- N) التضييق يعمل في الاتجاه الصحيح ---------- */
  login(admId, "admin");
  r = await call("GET", "/admin/users");
  ok("N1 مدير مؤشَّر له «المستخدمون»: القائمة 200", r.status === 200);
  r = await call("GET", "/admin/billing/payments");
  ok("N2 وصفحة المالية خارج صفحاته → 403 رغم أن دوره يملكها", r.status === 403);
  const { adminNotificationsRouter } = await import("./admin/notifications.js");
  const app2 = express(); app2.use(express.json()); app2.use(cookieParser()); app2.use("/admin", adminNotificationsRouter);
  const s2 = app2.listen(4639);
  const camp = await fetch("http://127.0.0.1:4639/admin/notifications", { headers: { Cookie: cookie } });
  s2.close();
  ok("N4 ولا يقرأ قائمة الحملات: صلاحية القائمة لصفحتها وحدها (تسرّب وجده هذا الاختبار وأُغلق)", camp.status === 403, String(camp.status));
  r = await call("GET", "/admin/auth/me");
  ok("N3 /auth/me يعيد الصلاحيات المضيَّقة لترسم اللوحة قائمتها", r.body.admin.pageGrants?.[0] === "users" && r.body.admin.permissions.includes("users:view") && !r.body.admin.permissions.includes("payments:view"));

  /* ---------- تعديل الصفحات ---------- */
  login(owner.id, "owner");
  r = await call("PATCH", `/admin/admin-users/${admId}/pages`, { pages: null, reason: "رفع التضييق" });
  login(admId, "admin");
  const r2 = await call("GET", "/admin/billing/payments");
  ok("P1 إزالة التضييق (null) تعيد ما يسمح به الدور، والأثر مسجَّل", r.status === 200 && r2.status === 200
    && (await query(`SELECT count(*)::int n FROM admin_action_log WHERE action='admin_account_pages_changed' AND entity_id=$1`, [admId])).rows[0].n === 1);
  login(accId, "support");
  r = await call("PATCH", `/admin/admin-users/${admId}/pages`, { pages: ["users"], reason: "r" });
  ok("P2 من لا يملك admins:change_role لا يعدّل الصفحات", r.status === 403);

  /* ---------- القاعدة الواحدة ---------- */
  const srcs = ["admin/accounts.js", "index.js", "db/seed_first_admin.js"].map((f) => fs.readFileSync(f, "utf8"));
  ok("W1 «15 حرفاً» في موضع واحد: لا رقم 15 حرفياً في الثلاثة، وكلها تستورد password-rule.js",
    srcs.every((s) => !/length\s*<\s*15\b|MIN_PASSWORD_LENGTH\s*=\s*15/.test(s) && s.includes("password-rule.js")));
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 300), false); }
finally { server.close(); await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 300)})` : ""}`); } }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
