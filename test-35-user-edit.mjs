import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0013 §4.3 — تعديل ملف العميل من اللوحة.
 *  E) كل حقل مسموح يُعدَّل، وكل حفظ يظهر في سجل الإجراءات بالقيمة قبل وبعد.
 *  P) الصلاحيات من الخادم: users:edit · users:view_contact للجوال والدولة · subscriptions:edit.
 *  M) تغيير البريد: يُمسح التفعيل، وتُلغى الجلسات، ويصدر رمز للبريد الجديد. لا ينتقل «مُفعّل».
 *  V) قواعد التحقق نفسها التي في مسار المستخدم (رقم سعودي، دولة/رمز).
 *  H) 🔴 D-ADM-01: نص اليومية ووسومها، والدفاتر، والإجابات التفصيلية لا تخرج في أي ردّ للوحة.
 */
requireDedicatedDatabase(import.meta.url);
import fs from "node:fs";
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { userEditRouter } = await import("./admin/user-edit.js");
const { adminRouter } = await import("./admin/routes.js");
const { autoReasonMiddleware } = await import("./admin/auto-reason.js"); // ملحق القرار 1: كما في index.js


const printed = [];
for (const k of ["log", "error", "warn"]) { const o = console[k]; console[k] = (...a) => { printed.push(a.map(String).join(" ")); if (k === "log") o(...a); }; }

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser());
app.use("/admin", autoReasonMiddleware); app.use("/admin", userEditRouter); app.use("/admin", adminRouter);
const server = app.listen(4635); const B = "http://127.0.0.1:4635";
let cookie = "";
const as = async (role) => {
  const base = role === "accountant" ? "support" : role;
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ($1,$2,'x',$3) RETURNING id`, [`ue ${role}`, `ue-${role}-${Math.random()}@kanaf.test`, base]);
  if (role === "accountant") await query(`INSERT INTO admin_role_assignments (admin_user_id, role) VALUES ($1,'accountant')`, [a.id]);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: a.id, role: base, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  return a.id;
};
const call = async (method, p, body, headers = {}) => {
  const isBuf = Buffer.isBuffer(body);
  const r = await fetch(B + p, { method, headers: { "Content-Type": isBuf ? "image/png" : "application/json", Cookie: cookie, ...headers }, body: body ? (isBuf ? body : JSON.stringify(body)) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ } return { status: r.status, body: json, raw };
};
const lastAudit = async (userId, action) => (await query(
  `SELECT old_value, new_value, reason, admin_user_id FROM admin_action_log WHERE target_user_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1`, [userId, action])).rows[0];

try {
  await query(`INSERT INTO subscription_plans (plan_key, name, price_sar, duration_days, features, display_order)
               VALUES ('monthly','الباقة الشهرية',29,30,ARRAY['x'],1), ('annual','السنوية',290,365,ARRAY['x'],2) ON CONFLICT (plan_key) DO NOTHING`);
  const { rows: [u] } = await query(
    `INSERT INTO users (name, email, password_hash, confirmed_adult, email_verified_at, age_range, gender)
     VALUES ('عميل التعديل', 'edit-me@kanaf.test', 'x', true, now(), '20-30', 'male') RETURNING id`);
  const { rows: [other] } = await query(`INSERT INTO users (name, email, password_hash, confirmed_adult) VALUES ('آخر', 'taken@kanaf.test', 'x', true) RETURNING id`);
  /* محتوى محجوب (D-ADM-01) بعلامات فريدة */
  await query(`INSERT INTO daily_logs (user_id, mood, sleep, energy, note, tags, logged_on) VALUES ($1, 3, 3, 3, 'سرّ-يومية-7f3a', ARRAY['وسم-سري-91'], CURRENT_DATE)`, [u.id]);
  await query(`INSERT INTO user_notebook_entries (user_id, template_key, answers) VALUES ($1, 'tpl', '{"a":"دفتر-سري-55"}')`, [u.id]);
  await query(`INSERT INTO screenings (user_id, kind, total, band_label, answers) VALUES ($1, 'gad7', 9, 'خفيف', '{"q1":"إجابة-سرية-33"}')`, [u.id]);
  const responses = [];

  /* ---------------- P) الصلاحيات ---------------- */
  await as("support");
  let r = await call("PATCH", `/admin/users/${u.id}/profile`, { name: "x", reason: "r" });
  ok("P1 الدعم بلا users:edit → 403 من الخادم", r.status === 403);
  await as("accountant");
  r = await call("PATCH", `/admin/users/${u.id}/subscription`, { planId: "monthly", periodEnd: "2027-01-01", reason: "r" });
  ok("P2 المحاسب بلا subscriptions:edit → 403", r.status === 403);

  const adminId = await as("admin");
  const nameBefore = (await query(`SELECT name FROM users WHERE id = $1`, [u.id])).rows[0].name;
  r = await call("PATCH", `/admin/users/${u.id}/profile`, { name: "اسم بلا سبب مكتوب" });
  const { rows: [p3] } = await query(`SELECT reason, old_value, new_value, ip_address FROM admin_action_log WHERE action = 'user_profile_edit' AND target_user_id = $1 ORDER BY created_at DESC LIMIT 1`, [u.id]);
  ok("P3 (ملحق القرار 1) بلا سبب مكتوب → 200، والسجل بسبب تلقائي وقبل/بعد وIP", r.status === 200 && p3?.reason === "تعديل ملف العميل من اللوحة" && p3.old_value?.name === nameBefore && p3.new_value?.name === "اسم بلا سبب مكتوب" && Boolean(p3.ip_address), JSON.stringify(p3));
  await call("PATCH", `/admin/users/${u.id}/profile`, { name: nameBefore, reason: "إرجاع الاسم للاختبار" });
  r = await call("PATCH", `/admin/users/${u.id}/profile`, { phone: { dial: "966", national: "512345678" }, reason: "r" });
  ok("P4 المدير بلا users:view_contact لا يعدّل الجوال → 403", r.status === 403);

  /* ---------------- E) التعديل والأثر ---------------- */
  r = await call("PATCH", `/admin/users/${u.id}/profile`, {
    name: "اسم جديد", ageRange: "30-40", gender: "female", remindersOn: true, reminderTime: "21:15",
    reminderTimezone: "Asia/Dubai", marketingOptOut: true, reason: "طلب العميل عبر الدعم",
  });
  responses.push(r.raw);
  ok("E1 تعديل الاسم والفئة والجنس والتذكير ومنع التسويق → 200", r.status === 200 && r.body.profile.name === "اسم جديد" && r.body.profile.ageRange === "30-40"
    && r.body.profile.gender === "female" && r.body.profile.reminderTime === "21:15" && r.body.profile.reminderTimezone === "Asia/Dubai" && r.body.profile.marketingOptOut === true, r.raw);
  let a = await lastAudit(u.id, "user_profile_edit");
  ok("E2 صفّ في سجل الإجراءات: المحرِّر والسبب، والقيمة قبل وبعد لكل حقل تغيّر",
    a && a.admin_user_id === adminId && a.reason === "طلب العميل عبر الدعم"
    && a.old_value.name === "عميل التعديل" && a.new_value.name === "اسم جديد"
    && a.old_value.ageRange === "20-30" && a.new_value.ageRange === "30-40"
    && a.old_value.gender === "male" && a.new_value.gender === "female"
    && a.new_value.reminderTime === "21:15" && a.new_value.marketingOptOut === true && !("email" in a.new_value), JSON.stringify(a));
  const countEdits = async () => (await query(`SELECT count(*)::int n FROM admin_action_log WHERE target_user_id = $1 AND action = 'user_profile_edit'`, [u.id])).rows[0].n;
  const n0 = await countEdits();
  r = await call("PATCH", `/admin/users/${u.id}/profile`, { name: "اسم جديد", reason: "لا تغيير" });
  const n = await countEdits();
  ok("E3 حفظ بلا تغيير فعلي لا يكتب أثراً كاذباً", r.status === 200 && r.body.changed.length === 0 && n === n0, `${n0}→${n}`);

  /* ---------------- V) قواعد مسار المستخدم نفسها ---------------- */
  const ownerId = await as("owner");
  r = await call("PATCH", `/admin/users/${u.id}/profile`, { country: "SA", phone: { dial: "966", national: "412345678" }, reason: "r" });
  ok("V1 رقم سعودي لا يبدأ بـ5 → 400 بنفس رمز مسار المستخدم", r.status === 400 && r.body.error === "invalid_saudi_phone", r.raw);
  r = await call("PATCH", `/admin/users/${u.id}/profile`, { country: "EG", phone: { dial: "966", national: "512345678" }, reason: "r" });
  ok("V2 رمز اتصال لا يطابق الدولة → 400 dial_country_mismatch", r.status === 400 && r.body.error === "dial_country_mismatch");
  r = await call("PATCH", `/admin/users/${u.id}/profile`, { ageRange: "99-100", reason: "r" });
  ok("V3 فئة عمرية خارج القائمة → 400", r.status === 400 && r.body.error === "invalid_age_range");
  r = await call("PATCH", `/admin/users/${u.id}/profile`, { country: "SA", phone: { dial: "966", national: "512345678" }, reason: "تحديث الجوال" });
  a = await lastAudit(u.id, "user_profile_edit");
  ok("E4 المالك يعدّل الدولة والجوال، والأثر بالقيمتين", r.status === 200 && a.old_value.phone === null && a.new_value.phone === "+966512345678" && a.new_value.country === "SA", JSON.stringify(a));

  /* ---------------- M) تغيير البريد ---------------- */
  await query(`INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1, 'h-' || gen_random_uuid(), now() + interval '1 day')`, [u.id]);
  r = await call("PATCH", `/admin/users/${u.id}/profile`, { email: "taken@kanaf.test", reason: "r" });
  ok("M1 بريد مستعمل لحساب آخر → 409", r.status === 409 && r.body.error === "email_taken", r.raw);
  r = await call("PATCH", `/admin/users/${u.id}/profile`, { email: "New-Address@Kanaf.test", reason: "تصحيح بريد العميل" });
  const { rows: [after] } = await query(`SELECT email, email_verified_at FROM users WHERE id = $1`, [u.id]);
  const { rows: [sess] } = await query(`SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS live FROM user_sessions WHERE user_id = $1`, [u.id]);
  const { rows: [code] } = await query(`SELECT count(*)::int n FROM email_verification_codes WHERE lower(email) = 'new-address@kanaf.test'`);
  ok("M2 البريد الجديد محفوظاً بحروف صغيرة، والتفعيل ممسوح (لا ينتقل «مُفعّل»)", r.status === 200 && after.email === "new-address@kanaf.test" && after.email_verified_at === null, r.raw);
  ok("M3 الجلسات أُلغيت، ورمز تحقق صدر للبريد الجديد", sess.live === 0 && code.n === 1 && r.body.verification !== null, JSON.stringify({ sess, code, v: r.body.verification }));
  a = await lastAudit(u.id, "user_profile_edit");
  ok("M4 الأثر يحمل البريد والتفعيل قبل وبعد", a.old_value.email === "edit-me@kanaf.test" && a.new_value.email === "new-address@kanaf.test" && a.old_value.emailVerified === true && a.new_value.emailVerified === false);

  /* ---------------- الصورة ---------------- */
  const png = fs.readFileSync("docs/ord-0012/app-kit/icons/icon-192.png");
  r = await call("PUT", `/admin/users/${u.id}/avatar?reason=${encodeURIComponent("صورة من العميل")}`, png);
  a = await lastAudit(u.id, "user_avatar_set");
  ok("E5 رفع صورة → 200، والأثر بالبصمتين", r.status === 200 && r.body.photo.exists && a && a.old_value.photo === null && a.new_value.photo === r.body.photo.version, r.raw);
  r = await call("PUT", `/admin/users/${u.id}/avatar?reason=r`, Buffer.from("not an image at all, just text bytes padding padding padding padding"));
  ok("E6 بايتات ليست صورة → 415 كقاعدة مسار المستخدم", r.status === 415);
  r = await call("DELETE", `/admin/users/${u.id}/avatar?reason=${encodeURIComponent("طلب حذف")}`);
  a = await lastAudit(u.id, "user_avatar_delete");
  ok("E7 حذف الصورة → 200 والأثر", r.status === 200 && r.body.deleted === 1 && a.new_value.photo === null);

  /* ---------------- الاشتراك ---------------- */
  r = await call("PATCH", `/admin/users/${u.id}/subscription`, { planId: "monthly", reason: "r" });
  ok("S1 منح بلا تاريخ انتهاء → 400", r.status === 400 && r.body.error === "grant_requires_plan_and_period_end");
  r = await call("PATCH", `/admin/users/${u.id}/subscription`, { planId: "monthly", periodEnd: "2027-01-01T00:00:00Z", reason: "تعويض عن عطل" });
  a = await lastAudit(u.id, "manual_subscription_grant");
  ok("S2 منح يدوي → 200، والأثر قبل=لا شيء وبعد=الباقة والمدة", r.status === 200 && r.body.created && a.old_value === null && a.new_value.planId === "monthly" && a.new_value.periodEnd.startsWith("2027-01-01"));
  r = await call("PATCH", `/admin/users/${u.id}/subscription`, { planId: "annual", periodEnd: "2027-06-01T00:00:00Z", reason: "ترقية" });
  a = await lastAudit(u.id, "manual_subscription_edit");
  ok("S3 تعديل الباقة والمدة → الأثر بالقيمتين", r.status === 200 && a.old_value.planId === "monthly" && a.new_value.planId === "annual" && a.new_value.periodEnd.startsWith("2027-06-01"));
  r = await call("PATCH", `/admin/users/${u.id}/subscription`, { status: "canceled", reason: "طلب العميل" });
  const { rows: [sub] } = await query(`SELECT status, canceled_at FROM subscriptions WHERE user_id = $1`, [u.id]);
  ok("S4 الحالة canceled تضبط canceled_at", r.status === 200 && sub.status === "canceled" && sub.canceled_at !== null);
  r = await call("PATCH", `/admin/users/${u.id}/subscription`, { status: "past_due", reason: "r" });
  ok("S5 حالة يضعها الدفع لا الإنسان (past_due) → 400", r.status === 400 && r.body.error === "invalid_status");
  r = await call("PATCH", `/admin/users/${u.id}/subscription`, { planId: "no-such", reason: "r" });
  ok("S6 باقة غير موجودة → 400", r.status === 400 && r.body.error === "unknown_plan");

  /* ---------------- H) D-ADM-01 ---------------- */
  for (const p of [`/admin/users/${u.id}`, `/admin/users/${u.id}/actions`]) responses.push((await call("GET", p)).raw);
  responses.push((await call("GET", `/admin/users/${u.id}/sensitive?reason=${encodeURIComponent("مراجعة")}`)).raw);
  const all = responses.join("\n") + JSON.stringify((await query(`SELECT old_value, new_value FROM admin_action_log WHERE target_user_id = $1`, [u.id])).rows);
  ok("H1 نص اليومية ووسومها لا يخرجان في أي ردّ للوحة ولا في سجل الإجراءات", !all.includes("سرّ-يومية-7f3a") && !all.includes("وسم-سري-91"));
  ok("H2 محتوى الدفاتر والإجابات التفصيلية للمقاييس لا يخرجان", !all.includes("دفتر-سري-55") && !all.includes("إجابة-سرية-33"));
  const src = fs.readFileSync("admin/user-edit.js", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok("H3 مسار التعديل لا يذكر جداول المحتوى المحجوب أصلاً", !/daily_logs|user_notebook_entries|screenings|note\b|answers/.test(src));
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 300), false); }
finally { server.close(); await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 300)})` : ""}`); } }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
