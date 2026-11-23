import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0013 §6 — قسم «الاشتراكات».
 *  L) القائمة: الساري وحده (بتعريف entitledSql)، والفلترة بالباقة والمدة، والتعريف يُعاد نصّاً.
 *  B) 🔴 الإرسال الجماعي: المستلمون هم المعروضون بالفلتر لا كل المشتركين، والعدد المعروض قبل
 *     الإرسال = عدد من وصلتهم، وتغيّر الجمهور بين العرض والإرسال يُرفض (409) لا يُرسل لعدد آخر.
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { subscribersRouter } = await import("./admin/subscribers.js");
const { adminNotificationsRouter } = await import("./admin/notifications.js");
for (const k of ["error", "warn"]) console[k] = () => {};

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser());
app.use("/admin", subscribersRouter); app.use("/admin", adminNotificationsRouter);
const server = app.listen(4637); const B = "http://127.0.0.1:4637";
let cookie = "";
const as = async (role) => {
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ($1,$2,'x',$3) RETURNING id`, [`sb ${role}`, `sb-${role}-${Math.random()}@kanaf.test`, role]);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: a.id, role, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
};
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ } return { status: r.status, body: json, raw };
};

try {
  await query(`INSERT INTO subscription_plans (plan_key, name, price_sar, duration_days, features, display_order) VALUES
     ('monthly','شهرية',29,30,ARRAY['x'],1), ('semi','نصف سنوية',150,180,ARRAY['x'],2), ('annual','سنوية',290,365,ARRAY['x'],3) ON CONFLICT (plan_key) DO NOTHING`);
  const mk = async (name, plan, status, endSql) => {
    const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,confirmed_adult,email_verified_at) VALUES ($1,$2,'x',true,now()) RETURNING id`, [name, `${name}-${Math.random()}@kanaf.test`]);
    if (plan) await query(`INSERT INTO subscriptions (user_id, plan_id, status, started_at, current_period_end) VALUES ($1,$2,$3,now() - interval '1 day', ${endSql})`, [u.id, plan, status]);
    return u.id;
  };
  const m1 = await mk("شهري1", "monthly", "active", "now() + interval '20 days'");
  const m2 = await mk("شهري2", "monthly", "active", "now() + interval '5 days'");
  const a1 = await mk("سنوي1", "annual", "active", "now() + interval '200 days'");
  const s1 = await mk("نصفي1", "semi", "past_due", "now() + interval '3 days'");
  const expired = await mk("منتهي", "monthly", "active", "now() - interval '1 day'");
  const canceled = await mk("ملغى", "monthly", "canceled", "now() + interval '10 days'");
  const none = await mk("بلا اشتراك", null);

  await as("support");
  let r = await call("GET", "/admin/subscribers");
  ok("L0 الدعم يملك subscriptions:view فيرى القائمة", r.status === 200);
  await as("content_manager");
  r = await call("GET", "/admin/subscribers");
  ok("L0b مدير المحتوى بلا subscriptions:view → 403", r.status === 403);

  await as("admin");
  r = await call("GET", "/admin/subscribers?pageSize=100");
  const ids = new Set((r.body.subscribers || []).map((x) => x.user_id));
  ok("L1 الساري وحده: الأربعة (ومنهم متأخر الدفع)، لا المنتهي ولا الملغى ولا بلا اشتراك",
    r.status === 200 && r.body.total === 4 && [m1, m2, a1, s1].every((x) => ids.has(x)) && ![expired, canceled, none].some((x) => ids.has(x)), JSON.stringify([...ids]));
  ok("L2 تعريف «ساري» يُعاد نصّاً لتعرضه الصفحة", /ساري = أحدث اشتراك/.test(r.body.definition || ""));
  ok("L3 الصف يحمل الاسم والبريد ونوع الباقة ومدتها", r.body.subscribers.every((x) => x.name && x.email && x.plan_name && x.duration_days));
  r = await call("GET", "/admin/subscribers?plan=monthly");
  ok("L4 فلتر الباقة: الشهريان الساريان فقط", r.body.total === 2 && r.body.subscribers.every((x) => x.plan_id === "monthly"));
  r = await call("GET", "/admin/subscribers?duration=365");
  ok("L5 فلتر المدة 365: السنوي وحده", r.body.total === 1 && r.body.subscribers[0].user_id === a1);
  const dbDur = (await query(`SELECT DISTINCT duration_days d FROM subscription_plans ORDER BY 1`)).rows.map((x) => x.d);
  ok("L6 خيارات الفلترة من الباقات نفسها", JSON.stringify(r.body.options.durations) === JSON.stringify(dbDur), JSON.stringify([r.body.options.durations, dbDur]));

  /* ---------- B) الإرسال الجماعي بالفلتر ---------- */
  const rec = await call("GET", "/admin/subscribers/recipients?plan=monthly");
  ok("B1 المستلمون = المعروض بالفلتر (2) لا كل المشتركين (4)", rec.body.count === 2 && new Set(rec.body.userIds).size === 2 && rec.body.userIds.includes(m1) && rec.body.userIds.includes(m2));
  const shownCount = rec.body.count;
  r = await call("POST", "/admin/notifications", { title: "تذكير المشتركين الشهريين", body: "نص", audience: "selected_users",
    audienceFilter: { userIds: rec.body.userIds }, channels: ["in_app"], sendNow: true, expectedCount: shownCount });
  const { rows: delivered } = await query(`SELECT user_id FROM notification_deliveries WHERE campaign_id = $1 AND status = 'delivered'`, [r.body.id]);
  ok("B2 العدد المعروض قبل الإرسال = عدد من وصلتهم", [200, 201, 202].includes(r.status) && r.body.audienceCount === shownCount && delivered.length === shownCount, `${r.status} ${delivered.length}/${shownCount}`);
  ok("B3 من وصلتهم هم المعروضون أنفسهم، ولا أحد غيرهم (لا السنوي ولا نصف السنوي)",
    delivered.every((d) => [m1, m2].includes(d.user_id)) && !delivered.some((d) => [a1, s1, expired, canceled, none].includes(d.user_id)));

  /* تغيّر الجمهور بين العرض والإرسال: حُذف أحد المعروضين */
  const rec2 = await call("GET", "/admin/subscribers/recipients?plan=monthly");
  await query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [m2]);
  const before = (await query(`SELECT count(*)::int n FROM notification_campaigns`)).rows[0].n;
  r = await call("POST", "/admin/notifications", { title: "ثانية", body: "نص", audience: "selected_users",
    audienceFilter: { userIds: rec2.body.userIds }, channels: ["in_app"], sendNow: true, expectedCount: rec2.body.count });
  const after = (await query(`SELECT count(*)::int n FROM notification_campaigns`)).rows[0].n;
  ok("B4 تغيّر العدد بين العرض والتأكيد → 409 بالعدد الجديد، ولا حملة ولا إرسال لعدد غير المؤكَّد",
    r.status === 409 && r.body.error === "audience_count_changed" && r.body.count === 1 && r.body.expected === 2 && after === before, r.raw);
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 300), false); }
finally { server.close(); await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 300)})` : ""}`); } }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
