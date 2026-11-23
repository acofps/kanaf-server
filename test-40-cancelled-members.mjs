import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0013 §8 — الأعضاء الملغون: احتفاظ بلا هوية.
 *  U) 🔴 بعد المحو لا يوجد في القاعدة أي حقل يربط السجل المجهول بالحساب المحذوف —
 *     باستعلام مباشر على كل عمود في كل جدول.
 *  E) 🔴 نصوص اليوميات والدفاتر والمقاييس وأدوات العلاج زالت فعلاً، والجوال والصورة والاسم والبريد.
 *  K) ما قرّر المالك إبقاءه باقٍ: الأشهر والمدة والباقة وسبب الإلغاء والخدمات والمكتمل.
 *  I) الفواتير باقية كما صدرت (§8.2)، ولا استرجاع (§8.3)، والمحو للمالك وحده، ومرة واحدة.
 */
requireDedicatedDatabase(import.meta.url);
import crypto from "node:crypto";
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { membersRouter } = await import("./admin/members.js");
for (const k of ["error", "warn"]) console[k] = () => {};

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/admin", membersRouter);
const server = app.listen(4641); const B = "http://127.0.0.1:4641";
let cookie = "";
const as = async (role) => {
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ($1,$2,'x',$3) RETURNING id`, [`cm ${role}`, `cm-${role}-${Math.random()}@kanaf.test`, role]);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: a.id, role, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
};
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ } return { status: r.status, body: json, raw };
};

try {
  /* حساب كامل البيانات */
  const NAME = "سارة المختبرة", EMAIL = "sara-cm@kanaf.test";
  const { rows: [u] } = await query(
    `INSERT INTO users (name, email, password_hash, confirmed_adult, email_verified_at, created_at)
     VALUES ($1, $2, 'x', true, now(), '2026-03-14 09:31:07+03') RETURNING id, created_at`, [NAME, EMAIL]);
  await query(`INSERT INTO user_profile (user_id, country_code, phone_country_code, phone_national) VALUES ($1,'SA','966','598765432')`, [u.id]);
  await query(`INSERT INTO user_avatars (user_id, mime, bytes, byte_size, checksum) VALUES ($1,'image/png',decode(repeat('89504e47',32),'hex'),128,'0123456789abcdef0123456789abcdef')`, [u.id]);
  for (const d of ["2026-04-01", "2026-05-10", "2026-06-02"]) await query(`INSERT INTO daily_logs (user_id, mood, sleep, energy, note, tags, logged_on, created_at) VALUES ($1,3,3,3,'يومية-محفوظة-سرية',ARRAY['وسم-سري'],$2::date,$2::timestamptz)`, [u.id, d]);
  await query(`INSERT INTO user_notebook_entries (user_id, template_key, answers, started_at) VALUES ($1,'gratitude','{"a":"دفتر-سري-جداً"}','2026-04-20')`, [u.id]);
  await query(`INSERT INTO screenings (user_id, kind, total, band_label, answers, created_at) VALUES ($1,'phq9',7,'خفيف','{"q1":"إجابة-مقياس-سرية"}','2026-04-05')`, [u.id]);
  await query(`INSERT INTO user_cbt_sessions (user_id, tool_id, status, payload, started_at) VALUES ($1,'thought_record','completed','{"t":"فكرة-سرية"}','2026-05-01')`, [u.id]);
  await query(`INSERT INTO user_journey_enrollments (user_id, journey_key, status, total_days, started_at) VALUES ($1,'sleep_reset','completed',7,'2026-05-03')`, [u.id]);
  await query(`INSERT INTO subscription_plans (plan_key,name,price_sar,duration_days,features,display_order) VALUES ('monthly','شهرية',29,30,ARRAY['x'],1) ON CONFLICT (plan_key) DO NOTHING`);
  await query(`INSERT INTO subscriptions (user_id, plan_id, status, started_at, current_period_end, canceled_at) VALUES ($1,'monthly','canceled','2026-04-01','2026-05-01','2026-04-20')`, [u.id]);
  const { rows: [inv] } = await query(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, zatca_invoice_number) VALUES ($1,'monthly',29,'paid','TNFS-INV-000777') RETURNING id`, [u.id]);
  /* طلب الحذف كما يكتبه مسار العضو */
  await query(`UPDATE users SET deleted_at = '2026-06-20 18:00:00+03' WHERE id = $1`, [u.id]);
  await query(`INSERT INTO account_deletion_requests (user_id) VALUES ($1)`, [u.id]);

  /* ---------- I) الصلاحية والتأكيد ---------- */
  await as("admin");
  let r = await call("POST", `/admin/users/${u.id}/purge`, { reason: "r", confirm: "PURGE" });
  ok("I1 المدير لا يملك المحو النهائي → 403 (للمالك وحده)", r.status === 403);
  await as("owner");
  r = await call("POST", `/admin/users/${u.id}/purge`, { reason: "طلب العضو" });
  ok("I2 بلا تأكيد صريح → 400", r.status === 400 && r.body.error === "confirmation_required");
  r = await call("POST", `/admin/users/${u.id}/purge`, { reason: "طلب العضو", confirm: "PURGE" });
  ok("I3 المالك يُتمّ المحو → 200", r.status === 200, r.raw);
  r = await call("POST", `/admin/users/${u.id}/purge`, { reason: "مرة ثانية", confirm: "PURGE" });
  const { rows: [{ n: rowsCm }] } = await query(`SELECT count(*)::int n FROM cancelled_members`);
  ok("I4 محو ثانٍ للحساب نفسه → 409، ولا سجل مجهول ثانٍ لشخص واحد", r.status === 409 && rowsCm === 1);

  const { rows: [cm] } = await query(`SELECT * FROM cancelled_members`);
  const anon = cm.id;

  /* ---------- U) 🔴 لا ربط ---------- */
  ok("U1 المعرّف البديل ليس معرّف المستخدم ولا مشتقاً منه (لا md5 ولا sha256 ولا sha1)", anon !== u.id
    && ![crypto.createHash("md5"), crypto.createHash("sha256"), crypto.createHash("sha1")].some((h) => h.update(u.id).digest("hex").startsWith(anon.replace(/-/g, "").slice(0, 12)))
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(anon), anon);
  /* مسح كل عمود في كل جدول بالقيمتين */
  const { rows: cols } = await query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name NOT IN ('kanaf_test_env_marker') AND data_type NOT IN ('bytea')`);
  const holdAnon = [], cmHoldsUser = [];
  for (const c of cols) {
    const t = `"${c.table_name}"`, col = `"${c.column_name}"`;
    const a = await query(`SELECT count(*)::int n FROM ${t} WHERE ${col}::text LIKE $1`, [`%${anon}%`]);
    if (a.rows[0].n > 0) holdAnon.push(`${c.table_name}.${c.column_name}`);
    if (c.table_name === "cancelled_members") {
      const b = await query(`SELECT count(*)::int n FROM ${t} WHERE ${col}::text LIKE $1 OR ${col}::text ILIKE $2 OR ${col}::text LIKE $3`, [`%${u.id}%`, `%${EMAIL}%`, `%${NAME}%`]);
      if (b.rows[0].n > 0) cmHoldsUser.push(c.column_name);
    }
  }
  ok("U2 🔴 المعرّف المجهول لا يظهر في أي عمود من أي جدول غير cancelled_members.id", holdAnon.length === 1 && holdAnon[0] === "cancelled_members.id", holdAnon.join(","));
  ok("U3 🔴 ولا عمود في السجل المجهول يحمل معرّف المستخدم أو بريده أو اسمه", cmHoldsUser.length === 0, cmHoldsUser.join(","));
  const cmText = JSON.stringify(cm);
  ok("U4 لا طابع زمني دقيق في السجل (أشهر فقط) — لا مطابقة بلحظة الانضمام أو الحذف", !/\d{2}:\d{2}/.test(cmText) && !cmText.includes("2026-03-14") && !cmText.includes("2026-06-20") && cm.joined_month === "2026-03", cmText);
  const { rows: [dr] } = await query(`SELECT purge_counts FROM account_deletion_requests WHERE user_id = $1`, [u.id]);
  ok("U5 أثر المحو يذكر الجداول بلا أعداد (الأعداد كانت ستطابق أعداد السجل المجهول)", Array.isArray(dr.purge_counts?.tables) && !JSON.stringify(dr.purge_counts).match(/:\s*\d/), JSON.stringify(dr.purge_counts));

  /* ---------- E) 🔴 المحتوى زال فعلاً ---------- */
  const cnt = async (sql) => (await query(sql, [u.id])).rows[0].n;
  ok("E1 اليوميات والدفاتر والمقاييس وجلسات الأدوات والرحلات: صفر صفوف للحساب",
    (await cnt(`SELECT count(*)::int n FROM daily_logs WHERE user_id=$1`)) === 0 && (await cnt(`SELECT count(*)::int n FROM user_notebook_entries WHERE user_id=$1`)) === 0
    && (await cnt(`SELECT count(*)::int n FROM screenings WHERE user_id=$1`)) === 0 && (await cnt(`SELECT count(*)::int n FROM user_cbt_sessions WHERE user_id=$1`)) === 0
    && (await cnt(`SELECT count(*)::int n FROM user_journey_enrollments WHERE user_id=$1`)) === 0);
  const SECRET_TEXTS = ["يومية-محفوظة-سرية", "وسم-سري", "دفتر-سري-جداً", "إجابة-مقياس-سرية", "فكرة-سرية", "598765432", EMAIL, NAME];
  const leftovers = [];
  for (const c of cols) {
    const res2 = await query(`SELECT count(*)::int n FROM "${c.table_name}" WHERE "${c.column_name}"::text LIKE ANY($1)`, [SECRET_TEXTS.map((x) => `%${x}%`)]);
    if (res2.rows[0].n > 0) leftovers.push(`${c.table_name}.${c.column_name}`);
  }
  ok("E2 🔴 لا نص سري ولا جوال ولا بريد ولا اسم في أي عمود من أي جدول", leftovers.length === 0, leftovers.join(","));
  ok("E3 الصورة والجوال زالا", (await cnt(`SELECT count(*)::int n FROM user_avatars WHERE user_id=$1`)) === 0 && (await cnt(`SELECT count(*)::int n FROM user_profile WHERE user_id=$1`)) === 0);

  /* ---------- K) ما يبقى ---------- */
  ok("K1 يبقى: الأشهر والمدة والباقة ومدة الاشتراك وسبب الإلغاء", cm.joined_month === "2026-03" && cm.cancelled_month === "2026-06" && cm.membership_days === 98
    && cm.plan_key === "monthly" && cm.subscription_days === 19 && cm.cancel_reason === "account_deleted_after_subscription_cancel", cmText);
  ok("K2 يبقى: الخدمات بأعدادها وأشهرها، والأدوات والرحلات المكتملة بمفاتيحها",
    cm.services.daily_logs.count === 3 && cm.services.daily_logs.first_month === "2026-04" && cm.services.daily_logs.last_month === "2026-06"
    && cm.services.notebooks.count === 1 && cm.services.screenings.count === 1 && cm.completed.journeys.sleep_reset === 1 && cm.completed.tools.thought_record === 1, JSON.stringify([cm.services, cm.completed]));

  /* ---------- I) الفواتير والقسم ---------- */
  const { rows: [invAfter] } = await query(`SELECT zatca_invoice_number, user_id FROM invoices WHERE id = $1`, [inv.id]);
  ok("I5 الفاتورة الصادرة باقية برقمها (التزام ضريبي، خارج القسم)", invAfter.zatca_invoice_number === "TNFS-INV-000777");
  await as("admin");
  r = await call("GET", "/admin/cancelled-members");
  ok("I6 قسم «الأعضاء الملغون»: السجل بلا اسم ولا بريد ولا معرّف حساب", r.status === 200 && r.body.total === 1 && !r.raw.includes(u.id) && !r.raw.includes(EMAIL) && !r.raw.includes(NAME));
  ok("I7 لا مسار استرجاع (§8.3)", !/restore|undelete|استرجاع/.test((await import("node:fs")).readFileSync("admin/members.js", "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 300), false); }
finally { server.close(); await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 300)})` : ""}`); } }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
