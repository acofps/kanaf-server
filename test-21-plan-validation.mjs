import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0002 B-09 — تحقق موحد لإنشاء الباقة وتعديلها.
 * PATCH /admin/plans/:id كان يحفظ الاسم الفارغ، ومدة/ترتيب غير رقمي يصل Postgres فيرد 500.
 * الباقات هنا باقات اختبار تُنشأ في القاعدة المعزولة؛ لا تُمس الباقات المزروعة (monthly…).
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { adminRouter } = await import("./admin/routes.js");
const { autoReasonMiddleware } = await import("./admin/auto-reason.js"); // ملحق القرار 1: كما في index.js


const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/admin", autoReasonMiddleware); app.use("/admin", adminRouter);
const server = app.listen(4601); const B = "http://127.0.0.1:4601";
let cookie;
const as = async (role) => {
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ($1,$2,'x',$3) RETURNING id`, [`b09 ${role}`, `b09-${role}@kanaf.test`, role]);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: a.id, role, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
};
async function call(method, path, body) {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const plan = async (id) => (await query(`SELECT name, price_sar, duration_days, features, display_order, updated_at FROM subscription_plans WHERE id = $1`, [id])).rows[0];
const audits = async (key) => +(await query(`SELECT count(*) n FROM admin_action_log WHERE entity = 'plan' AND entity_id = $1`, [key])).rows[0].n;

try {
  await as("owner");
  const seededBefore = (await query(`SELECT plan_key, price_sar, duration_days FROM subscription_plans WHERE plan_key <> 'b09_test' ORDER BY plan_key`)).rows;
  let r = await call("POST", "/admin/plans", { planKey: "b09_test", name: "باقة اختبار", priceSar: 10, durationDays: 30, features: ["أ"], reason: "اختبار B-09" });
  ok("C0 create a test plan (201)", r.status === 201, JSON.stringify(r.body));
  const id = r.body.id; const before = await plan(id); const a0 = await audits("b09_test");

  const bad = [
    ["U1 empty name", { name: "" }, "invalid_name"],
    ["U2 blank name", { name: "   " }, "invalid_name"],
    ["U3 non-numeric duration (was 500)", { durationDays: "abc" }, "invalid_duration"],
    ["U4 zero duration", { durationDays: 0 }, "invalid_duration"],
    ["U5 fractional duration", { durationDays: 2.5 }, "invalid_duration"],
    ["U6 negative price", { priceSar: -1 }, "invalid_price"],
    ["U7 non-numeric display order (was 500)", { displayOrder: "x" }, "invalid_display_order"],
    ["U8 features not a list", { features: "أ، ب" }, "invalid_features"],
    ["U9 nothing to update", {}, "nothing_to_update"],
  ];
  for (const [label, patch, code] of bad) {
    r = await call("PATCH", `/admin/plans/${id}`, { ...patch, reason: "اختبار" });
    ok(`${label} → 400 ${code}`, r.status === 400 && r.body.error === code, `${r.status} ${JSON.stringify(r.body)}`);
  }
  const after = await plan(id);
  ok("U10 every refused request left the plan unchanged (incl. updated_at) and wrote no audit row", JSON.stringify(after) === JSON.stringify(before) && await audits("b09_test") === a0);
  r = await call("POST", "/admin/plans", { planKey: "b09_blank", name: "   ", priceSar: 5, durationDays: 7, reason: "اختبار" });
  ok("C1 create with a blank name is refused the same way (400 invalid_name)", r.status === 400 && r.body.error === "invalid_name");
  r = await call("POST", "/admin/plans", { planKey: "b09_order", name: "ب", priceSar: 5, durationDays: 7, displayOrder: "x", reason: "اختبار" });
  ok("C2 create with a non-numeric order is refused (400, was silently 0)", r.status === 400 && r.body.error === "invalid_display_order");

  r = await call("PATCH", `/admin/plans/${id}`, { name: "  باقة معدلة  ", durationDays: 60, reason: "اختبار B-09" });
  ok("V1 a valid update succeeds (200), name trimmed", r.status === 200 && r.body.name === "باقة معدلة" && r.body.duration_days === 60);
  ok("V2 …with one audit row holding before/after", await audits("b09_test") === a0 + 1);
  r = await call("PATCH", `/admin/plans/${id}`, { name: "باقة بلا سبب مكتوب", reason: "" });
  const { rows: [v3] } = await query(`SELECT reason, old_value, new_value FROM admin_action_log WHERE action = 'plan_updated' ORDER BY created_at DESC LIMIT 1`);
  ok("V3 (ملحق القرار 1) بلا سبب مكتوب → 200، والسجل بسبب تلقائي وقيمتَي قبل وبعد", r.status === 200 && v3?.reason === "تعديل باقة من اللوحة" && v3.old_value?.name === "باقة معدلة" && v3.new_value?.name === "باقة بلا سبب مكتوب", JSON.stringify(v3));

  await as("support");
  r = await call("PATCH", `/admin/plans/${id}`, { name: "دعم", reason: "اختبار" });
  ok("P1 a role without plans:edit is refused (403)", r.status === 403);
  const seededAfter = (await query(`SELECT plan_key, price_sar, duration_days FROM subscription_plans WHERE plan_key NOT LIKE 'b09_%' ORDER BY plan_key`)).rows;
  ok("P2 the seeded plans (real prices/durations) are untouched by this test", JSON.stringify(seededAfter) === JSON.stringify(seededBefore.filter((p) => !p.plan_key.startsWith("b09_"))));
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
server.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
