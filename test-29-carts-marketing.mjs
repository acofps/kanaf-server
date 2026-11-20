import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0008 §4 و§5 و§12.4 — السلات المتروكة وجمهور التسويق.
 *
 *  A) السلة المتروكة مشتقّة: فاتورة pending أقدم من 20 دقيقة. من اشترى لاحقاً
 *     يُعلَّم ويُخفى بطلب، والأحدث من 20 دقيقة لا يظهر. العميل مقنَّع.
 *  P) الصلاحية من الخادم، والحالة الفارغة، والترقيم.
 *  M) 🔴 §12.4: من أوقف التسويق لا يصله شيء تسويقي من أي قناة، ويُسجَّل
 *     skipped لا failed — وحملة غير تسويقية تبقى على سلوكها القائم.
 *  I) فئة «لم يدخل منذ مدة» مشتقّة من الدخول والجلسات، وحدودها تُفحص.
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { cartsRouter } = await import("./admin/carts.js");
const { adminNotificationsRouter } = await import("./admin/notifications.js");

const realLog = console.log; console.log = (...a) => { if (!String(a[0]).startsWith("[dev] Would send email")) realLog(...a); };
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/admin", cartsRouter); app.use("/admin", adminNotificationsRouter);
const server = app.listen(4629); const B = "http://127.0.0.1:4629";
let cookie = "";
const as = async (role) => {
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ($1,$2,'x',$3) RETURNING id`, [`cm ${role}`, `cm-${role}-${Math.random()}@kanaf.test`, role]);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: a.id, role, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  return a.id;
};
const call = async (method, path, body) => {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ } return { status: r.status, body: json, raw };
};
const mkUser = async (tag, { optOut = false } = {}) => (await query(
  `INSERT INTO users (name, email, password_hash, confirmed_adult, agreed_policy_at, email_verified_at, marketing_opt_out)
   VALUES ($1, $2, 'x', true, now(), now(), $3) RETURNING id`, [`عميل ${tag}`, `cart-${tag}@example.com`, optOut])).rows[0].id;
const inv = (u, status, minutesAgo) => query(
  `INSERT INTO invoices (user_id, plan_id, amount_sar, status, created_at) VALUES ($1, 'monthly', 29.00, $2, now() - make_interval(mins => $3)) RETURNING id`, [u, status, minutesAgo]);

try {
  await as("owner");
  /* ---- P0) حالة فارغة قبل أي بيانات ---- */
  let r = await call("GET", "/admin/abandoned-carts");
  ok("P0 حالة فارغة: 200، صفر، صفحة واحدة", r.status === 200 && r.body.total === 0 && r.body.carts.length === 0 && r.body.totalPages === 1, r.raw.slice(0, 200));

  const A = await mkUser("a");                      // متروكة، لم يشترِ
  const Bu = await mkUser("b");                     // متروكة ثم اشترى
  const Cu = await mkUser("c");                     // معلّقة حديثة (5 دقائق) — ليست متروكة
  const D = await mkUser("d", { optOut: true });    // متروكة، وأوقف التسويق
  await inv(A, "pending", 30); await inv(Bu, "pending", 90); await inv(Bu, "paid", 60); await inv(Cu, "pending", 5); await inv(D, "pending", 45);

  /* ---- A) الصفحة ---- */
  r = await call("GET", "/admin/abandoned-carts");
  const names = r.body.carts.map((c) => c.customer.name).sort().join(",");
  ok("A1 ثلاث سلات متروكة (a، b، d) — الحديثة c لا تظهر", r.body.total === 3 && names === "عميل a,عميل b,عميل d", names);
  ok("A2 من اشترى لاحقاً معلَّم", r.body.carts.find((c) => c.customer.name === "عميل b")?.purchasedLater === true
    && r.body.carts.filter((c) => c.purchasedLater).length === 1);
  ok("A3 العميل مقنَّع ولا بريد كامل في الرد", !r.raw.includes("cart-a@example.com") && r.body.carts.every((c) => /^.\*\*\*@/.test(c.customer.emailMasked)));
  ok("A4 الملخص: عميلان مفتوحان بقيمة 58، ومشترٍ لاحق واحد", r.body.summary.openCustomers === 2 && r.body.summary.openValueSar === 58 && r.body.summary.purchasedLater === 1, JSON.stringify(r.body.summary));
  r = await call("GET", "/admin/abandoned-carts?hidePurchased=1");
  ok("A5 إخفاء من اشترى → a وd فقط", r.body.total === 2 && r.body.carts.every((c) => !c.purchasedLater));
  const p1 = await call("GET", "/admin/abandoned-carts?pageSize=2&page=1"), p2 = await call("GET", "/admin/abandoned-carts?pageSize=2&page=2");
  ok("P1 الترقيم: 2 ثم 1، وصفحتان", p1.body.carts.length === 2 && p2.body.carts.length === 1 && p1.body.totalPages === 2);
  await as("support");
  r = await call("GET", "/admin/abandoned-carts");
  ok("P2 دور بلا carts:view → 403 من الخادم", r.status === 403, String(r.status));
  await as("owner");

  /* ---- M) جمهور السلات والعدّ ---- */
  r = await call("GET", "/admin/notifications/audience-count?audience=abandoned_carts");
  ok("M1 جمهور السلات = من لم يشترِ (a، d)، ومنهم 1 أوقف التسويق", r.body.count === 2 && r.body.marketing === true && r.body.optedOut === 1, JSON.stringify(r.body));

  r = await call("POST", "/admin/notifications", { title: "أكمل اشتراكك", body: "نص تسويقي للسلات", audience: "abandoned_carts", channels: ["in_app", "email"], sendNow: true });
  ok("M2 حملة السلات أُنشئت وأُرسلت", r.status === 201, `${r.status} ${r.raw.slice(0, 160)}`);
  const cid = r.body.id;
  const { rows: [camp] } = await query(`SELECT audience_filter FROM notification_campaigns WHERE id = $1`, [cid]);
  ok("M3 علامة التسويق فُرضت في الخادم ولو لم يرسلها العميل", camp.audience_filter.marketing === true, JSON.stringify(camp.audience_filter));
  const del = async (c, u) => (await query(`SELECT channel, status, error_code FROM notification_deliveries WHERE campaign_id = $1 AND user_id = $2 ORDER BY channel`, [c, u])).rows;
  const dRows = await del(cid, D);
  ok("M4 🔴 من أوقف التسويق: كل قنواته skipped بسبب marketing_opt_out — ولا failed", dRows.length === 2 && dRows.every((x) => x.status === "skipped" && x.error_code === "marketing_opt_out"), JSON.stringify(dRows));
  const inbox = (await query(`SELECT count(*)::int AS n FROM user_notifications WHERE user_id = $1 AND campaign_id = $2`, [D, cid])).rows[0].n;
  ok("M5 🔴 ولم يصله شيء في صندوق التطبيق", inbox === 0);
  const aRows = await del(cid, A);
  ok("M6 من لم يوقفه يصله داخل التطبيق (delivered)", aRows.find((x) => x.channel === "in_app")?.status === "delivered", JSON.stringify(aRows));

  /* حملة غير تسويقية: السلوك القائم كما هو (المنع على البريد وحده) */
  r = await call("POST", "/admin/notifications", { title: "تنبيه خدمة", body: "نص غير تسويقي", audience: "selected_users", audienceFilter: { userIds: [D] }, channels: ["in_app", "email"], sendNow: true });
  const svc = await del(r.body.id, D);
  ok("M7 حملة غير تسويقية: داخل التطبيق يصل، والبريد skipped — السلوك القائم بلا تغيير",
    svc.find((x) => x.channel === "in_app")?.status === "delivered" && svc.find((x) => x.channel === "email")?.error_code === "marketing_opt_out", JSON.stringify(svc));
  /* وحملة على أي فئة بعلامة تسويق صريحة */
  r = await call("POST", "/admin/notifications", { title: "عرض", body: "تسويق صريح", audience: "selected_users", audienceFilter: { userIds: [D], marketing: true }, channels: ["in_app"], sendNow: true });
  const mk = await del(r.body.id, D);
  ok("M8 علامة تسويق صريحة على فئة عادية: داخل التطبيق skipped أيضاً", mk.length === 1 && mk[0].status === "skipped" && mk[0].error_code === "marketing_opt_out", JSON.stringify(mk));

  /* ---- I) لم يدخل منذ مدة ---- */
  const old = await mkUser("old"); const fresh = await mkUser("fresh");
  await query(`UPDATE users SET created_at = now() - interval '90 days' WHERE id IN ($1, $2)`, [old, fresh]);
  await query(`INSERT INTO user_auth_state (user_id, last_login_at) VALUES ($1, now() - interval '40 days'), ($2, now() - interval '2 days')`, [old, fresh]);
  await query(`UPDATE users SET created_at = now() WHERE id NOT IN ($1, $2)`, [old, fresh]);
  r = await call("GET", "/admin/notifications/audience-count?audience=inactive&days=30");
  ok("I1 من لم يدخل منذ 30 يوماً = واحد فقط (دخل قبل 40 يوماً)", r.body.count === 1 && r.body.marketing === true, JSON.stringify(r.body));
  r = await call("GET", "/admin/notifications/audience-count?audience=inactive&days=3");
  ok("I2 أقل من 7 أيام مرفوض 400", r.status === 400, String(r.status));
  await query(`INSERT INTO user_sessions (user_id, token_hash, expires_at, last_used_at) VALUES ($1, 'h-' || gen_random_uuid(), now() + interval '30 days', now() - interval '1 day')`, [old]);
  r = await call("GET", "/admin/notifications/audience-count?audience=inactive&days=30");
  ok("I3 استعمال جلسة حديث يُخرجه من الفئة — النشاط مشتق من الجلسات أيضاً", r.status === 422 || r.body.count === 0, JSON.stringify(r.body));
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

console.log = realLog;
let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
server.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
