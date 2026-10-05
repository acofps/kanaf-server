import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0002 B-01 — إعداد الملف الأول عبر مسار الخادم القائم.
 * التطبيق صار يرسل الفئة العمرية والجنس عند إعداد الملف إلى PATCH /api/me/profile
 * (كان يحفظهما في حالة React فقط). هنا ما يضمنه الخادم لهذا المسار:
 * حساب جديد يحفظ ويقرأ، حساب قائم لا تُمس دولته، حقول غير مسموحة لا تُكتب،
 * ولا يُعدَّل حساب آخر.
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const crypto = await import("node:crypto");
const bcrypt = (await import("bcrypt")).default;
const { query, pool } = await import("./db/pool.js");
const { issueAccessToken } = await import("./auth/tokens.js");
const { userDataRouter } = await import("./userdata/routes.js");

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use("/api/me", userDataRouter);
const server = app.listen(4597); const B = "http://127.0.0.1:4597";
async function call(method, path, body, token) {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function mkUser(tag) {
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, confirmed_adult, agreed_policy_at, email_verified_at)
     VALUES ($1, $2, $3, true, now(), now()) RETURNING id, email, name`,
    [`مستخدم ${tag}`, `ps-${tag}-${crypto.randomBytes(3).toString("hex")}@kanaf.test`, await bcrypt.hash("x-" + tag, 4)]);
  return { ...rows[0], token: issueAccessToken({ id: rows[0].id }) };
}

try {
  const N = await mkUser("new"), E = await mkUser("existing");

  /* حساب جديد: إعداد الملف الأول */
  let r = await call("GET", "/api/me/profile", null, N.token);
  ok("P0 a new account starts with no age range, gender or country", r.status === 200 && r.body.profile.ageRange == null && r.body.profile.gender == null && r.body.profile.country == null, JSON.stringify(r.body.profile));
  r = await call("PATCH", "/api/me/profile", { ageRange: "20-30", gender: "female" }, N.token);
  ok("P1 setup values saved through the existing route (200)", r.status === 200 && r.body.profile.ageRange === "20-30" && r.body.profile.gender === "female", JSON.stringify(r.body));
  r = await call("GET", "/api/me/profile", null, N.token);
  ok("P2 read back after a fresh request (what a refresh/re-login sees)", r.body.profile.ageRange === "20-30" && r.body.profile.gender === "female");
  ok("P3 setup does not invent a country", r.body.profile.country == null, String(r.body.profile.country));

  /* حساب قائم بدولة غير السعودية */
  await call("PATCH", "/api/me/profile", { country: "EG" }, E.token);
  r = await call("PATCH", "/api/me/profile", { ageRange: "40-50" }, E.token);
  ok("P4 updating only the age range leaves the saved country (EG) as is", r.status === 200 && r.body.profile.country === "EG" && r.body.profile.ageRange === "40-50", JSON.stringify(r.body.profile));

  /* حقول غير مسموحة */
  const before = (await query(`SELECT name, email FROM users WHERE id = $1`, [N.id])).rows[0];
  r = await call("PATCH", "/api/me/profile", { ageRange: "30-40", email: "hijack@kanaf.test", name: "اسم آخر", id: E.id, userId: E.id, role: "owner" }, N.token);
  const after = (await query(`SELECT name, email FROM users WHERE id = $1`, [N.id])).rows[0];
  ok("P5 fields outside the allow-list (email, name, id, userId, role) are not written", r.status === 200 && after.email === before.email && after.name === before.name);
  r = await call("PATCH", "/api/me/profile", { ageRange: "18-20" }, N.token);
  ok("P6 a value outside the accepted ranges is refused (400 invalid_age_range) — no new categories (D-06)", r.status === 400 && r.body.error === "invalid_age_range");
  r = await call("PATCH", "/api/me/profile", { gender: "other" }, N.token);
  ok("P7 gender outside the accepted values is refused (400 invalid_gender)", r.status === 400 && r.body.error === "invalid_gender");

  /* لا تعديل لحساب آخر */
  const e = (await call("GET", "/api/me/profile", null, E.token)).body.profile;
  ok("P8 the other account is untouched by everything above", e.ageRange === "40-50" && e.country === "EG" && e.gender == null, JSON.stringify(e));
  const n = (await call("GET", "/api/me/profile", null, N.token)).body.profile;
  ok("P9 the refused requests left the last saved values in place", n.ageRange === "30-40" && n.gender === "female");
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
server.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
