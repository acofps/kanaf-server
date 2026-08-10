/**
 * Phase 2 acceptance tests — admin user operations.
 *
 * Runs the REAL admin router and the REAL auth router against an
 * in-memory Postgres (pg-mem), so the queries under test are the ones
 * that ship. Admin authentication is stubbed at the cookie layer only;
 * requireRole and every SQL statement run unmodified.
 */
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { query } from "./db/pool.js";
import { authRouter } from "./auth/routes.js";

const results = [];
const log = (label, cond, extra = "") => results.push([label, cond, extra]);

// ---- Build an app that mounts the real admin router -----------------
// Admin auth is exercised for real: a genuine JWT signed with
// ADMIN_JWT_SECRET is placed in the same httpOnly cookie the panel
// uses, so requireAdminAuth and requireRole both run unmodified.
// CURRENT_ADMIN = null means "send no cookie at all".
let CURRENT_ADMIN = null;
const { adminRouter } = await import("./admin/routes.js");

function adminCookie() {
  if (!CURRENT_ADMIN) return null;
  const token = jwt.sign(
    { sub: CURRENT_ADMIN.id, role: CURRENT_ADMIN.role, type: "access" },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "15m" }
  );
  return `kanaf_admin_access=${token}`;
}

/* ============================================================
   صف حساب إدارة حقيقي في قاعدة البيانات.

   كان هذا الملف يوقّع رمزاً بمعرّف من crypto.randomUUID() **بلا صف
   مقابل في admin_users** — ويمرّ. أي أن الخادم كان يقبل رمزاً
   لحساب إدارة لا وجود له إطلاقاً: حساب محذوف يظل رمزه صالحاً حتى
   ينتهي.

   أُغلقت الثغرة في المرحلة 5 (requireAdminAuth صار يقرأ الحساب من
   القاعدة في كل طلب)، فصار هذا الملف يحتاج صفاً حقيقياً — وهو ما
   كان يجب أن يكون عليه من البداية.

   والدور يُزامَن قبل كل طلب لأنه لم يعد يُقرأ من حمولة الرمز:
   تغيير CURRENT_ADMIN.role يجب أن يصل إلى القاعدة ليسري.
   ============================================================ */
/* هل نُظّفت بقايا التشغيلات السابقة في هذه الجلسة؟ مرة واحدة تكفي،
   والدالة تُنادى قبل كل طلب إداري. */
let harnessCleared = false;

async function syncAdminRow() {
  /* ------------------------------------------------------------
     ⚠️ ON CONFLICT (id) وحدها لا تكفي.

     المعرّف عشوائي في كل تشغيل (crypto.randomUUID)، والبريد ثابت،
     وعلى admin_users فهرس فرادة على LOWER(email). فالتشغيل الثاني
     يصطدم بصف التشغيل الأول:

       duplicate key value violates unique constraint
       "idx_admin_users_email_lower"

     ووقع ذلك فعلاً على الإنتاج، لأن الملف لم يكن ينظّف حساب
     الاختبار بعده — فكل تشغيل يترك حساب إدارة وهمياً في الجدول
     يظهر في شاشة حسابات الإدارة. (غير قابل للدخول: password_hash
     يساوي 'x' وbcrypt لا يطابقه، لكن وجوده وحده تلويث.)

     فيُحذف أي صف قديم بنفس البريد ومعرّف مختلف، مرة واحدة في
     الجلسة. ولا مفتاح أجنبي من سجلَّي التدقيق إلى admin_users
     (صلاحية REFERENCES عليه غير مؤكَّدة — سابقة الترحيل 003)،
     فالحذف لا يصطدم بقيد.
     ------------------------------------------------------------ */
  if (!harnessCleared) {
    await query(
      `DELETE FROM admin_users WHERE LOWER(email) = 'harness@kanaf.test' AND id <> $1`,
      [CURRENT_ADMIN.id]
    );
    harnessCleared = true;
  }
  await query(
    `INSERT INTO admin_users (id, name, email, password_hash, role, active)
     VALUES ($1, 'حساب اختبار', 'harness@kanaf.test', 'x', $2, true)
     ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, active = true`,
    [CURRENT_ADMIN.id, CURRENT_ADMIN.role]
  );
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use("/admin", adminRouter);
app.use("/api/auth", authRouter);

const server = app.listen(4570);
const B = "http://127.0.0.1:4570";

const req = async (method, path, body) => {
  const headers = { "Content-Type": "application/json" };
  if (path.startsWith("/admin") && CURRENT_ADMIN) await syncAdminRow();
  const c = path.startsWith("/admin") ? adminCookie() : null;
  if (c) headers.Cookie = c;
  const r = await fetch(B + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const get = (p) => req("GET", p);
const post = (p, b) => req("POST", p, b);

const sent = [];
const realLog = console.log;
console.log = (...a) => { const l = a.join(" "); if (l.includes("[dev] Would send")) sent.push(l); };


// ---- Seed real users through the real registration flow -------------
async function makeUser(name, email, password, { verify = true } = {}) {
  await post("/api/auth/register", { name, email, password, confirmedAdult: true, agreedPolicy: true });
  if (!verify) return;
  /* ------------------------------------------------------------
     المسار المفضّل: الكود من سطر التطوير الذي يطبعه mail/send.js
     حين لا يكون SMTP مضبوطاً، فيمرّ التوثيق بمسار
     /api/auth/verify-email الحقيقي كما كُتب أصلاً.

     ⚠️ وهو غير متاح على الإنتاج: SMTP مضبوط هناك فالبريد يُرسل
     فعلاً ولا يُطبع سطر، والكود مجزّأ بـbcrypt في
     email_verification_codes فلا يُسترجع من القاعدة.

     وبلا احتياط كان الملف يرمي عند أول مستخدم ولا يصل إلى فحص
     واحد — أي أن الثلاثة والخمسين فحصاً لا تُشغَّل في البيئة
     الوحيدة المتاحة، وهي التي تغطي قائمة المستخدمين وصفحتها.
     فحص لا يعمل ليس فحصاً.

     والاحتياط **سقالة بذر لا كود تحت الفحص**: ما يقيسه هذا الملف
     هو إدارة المستخدمين في اللوحة، ومسار التسجيل والتوثيق يفحصه
     test-auth.mjs بمواجهته المباشرة.
     ------------------------------------------------------------ */
  const entry = [...sent].reverse().find((m) => m.includes(email.toLowerCase()));
  const code = entry ? /: (\d{6})/.exec(entry)?.[1] : null;
  if (code) {
    await post("/api/auth/verify-email", { email, code });
    return;
  }
  await query(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE LOWER(email) = $1`,
    [email.toLowerCase()]
  );
}

const ADMIN_ID = crypto.randomUUID();

/* ============================================================
   حصر كل عدّ على مستخدمي هذا الملف وحدهم

   ⚠️ كُتب هذا الملف لقاعدة معزولة (pg-mem — انظر رأسه)، فكل فحص
   يعدّ صفوفاً كان يفترض أن الجدول لا يحوي غير خمسته. وعلى قاعدة
   الإنتاج فيها مستخدمون حقيقيون، فسقطت خمسة فحوص وهي تصف الواقع
   بدقة: total = 8 لأن ثمانية أحياء فعلاً.

   والحل ليس تعديل الأرقام — الأرقام تتغيّر مع كل تسجيل جديد.
   الحل حصر مجتمع القياس: كل مستخدمي هذا الملف على نطاق
   example.com، والبحث في اللوحة يطابق البريد. فيصير كل عدّ وصفاً
   لما بذره الملف لا لما في القاعدة.

   والفحص T1 كان يستعمل هذه الحيلة أصلاً (search=EXAMPLE.COM)
   وهو الوحيد من فحوص العدّ الذي نجا.
   ============================================================ */
const SCOPE = "search=" + encodeURIComponent("example.com");

async function run() {
  // A pool of users with staggered creation times so ordering and
  // pagination are actually exercised.
  const PW = "Kanaf-Test-2026-a";
  const people = [
    ["نورة العتيبي", "noura@example.com", true],
    ["فهد القحطاني", "fahad@example.com", true],
    ["سارة الدوسري", "sara@example.com", true],
    ["عبدالله الحربي", "abdullah@example.com", true],
    ["ريم الشمري", "reem@example.com", false],  // stays pending_verification
  ];
  for (const [n, e, v] of people) {
    await makeUser(n, e, PW, { verify: v });
    const daysAgo = people.findIndex((x) => x[1] === e);
    // Compute the timestamp in JS — pg-mem's interval arithmetic is
    // limited, and this is test scaffolding, not code under test.
    const when = new Date(Date.now() - daysAgo * 86400000).toISOString();
    await query(`UPDATE users SET created_at = $1 WHERE LOWER(email) = $2`, [when, e]);
  }

  CURRENT_ADMIN = { id: ADMIN_ID, role: "owner" };

  // ---------- TEST 1 — Search ----------
  let r = await get("/admin/users?search=" + encodeURIComponent("نورة"));
  log("T1 search by Arabic name returns exactly the match",
    r.status === 200 && r.body.total === 1 && r.body.users[0].email === "noura@example.com",
    JSON.stringify(r.body.users?.map((u) => u.email)));

  r = await get("/admin/users?search=fahad@example.com");
  log("T1 search by email", r.body.total === 1 && r.body.users[0].name === "فهد القحطاني");

  r = await get("/admin/users?search=EXAMPLE.COM");
  log("T1 search is case-insensitive across all users", r.body.total === 5, String(r.body.total));

  const someId = r.body.users[0].id;
  r = await get("/admin/users?search=" + someId);
  log("T1 search by UUID returns that user",
    r.body.total === 1 && r.body.users[0].id === someId, JSON.stringify(r.body.total));

  r = await get("/admin/users?search=" + encodeURIComponent("%"));
  log("T1 a bare % is escaped, not treated as a wildcard", r.body.total === 0, String(r.body.total));

  r = await get("/admin/users?search=" + encodeURIComponent("لا-أحد-بهذا-الاسم"));
  log("T1 no match returns empty set with total 0", r.body.total === 0 && r.body.users.length === 0);

  // ---------- TEST 2 — Filter ----------
  r = await get(`/admin/users?status=pending_verification&${SCOPE}`);
  log("T2 filter: pending_verification",
    r.body.total === 1 && r.body.users[0].email === "reem@example.com",
    JSON.stringify(r.body.users?.map((u) => u.email)));

  r = await get(`/admin/users?status=active&${SCOPE}`);
  log("T2 filter: active excludes the unverified one", r.body.total === 4, String(r.body.total));

  r = await get(`/admin/users?status=suspended&${SCOPE}`);
  log("T2 filter: suspended is empty before any suspension", r.body.total === 0, String(r.body.total));

  r = await get(`/admin/users?subscription=none&${SCOPE}`);
  log("T2 filter: no active subscription matches everyone", r.body.total === 5, String(r.body.total));

  // Combined filters must AND together, not replace one another.
  r = await get("/admin/users?status=active&subscription=none&search=" + encodeURIComponent("ال"));
  const combined = r.body.total;
  r = await get("/admin/users?search=" + encodeURIComponent("ال"));
  log("T2 combined filters narrow the result, not widen it",
    combined <= r.body.total && combined > 0, `${combined} <= ${r.body.total}`);

  // ---------- TEST 3 — Pagination ----------
  const seen = new Set();
  let totalReported = null;
  let dupes = 0;
  for (let page = 1; page <= 3; page++) {
    const pr = await get(`/admin/users?pageSize=2&page=${page}&${SCOPE}`);
    totalReported = pr.body.total;
    for (const u of pr.body.users) {
      if (seen.has(u.id)) dupes++;
      seen.add(u.id);
    }
  }
  log("T3 paging through 3 pages of 2 yields no duplicates", dupes === 0, `dupes=${dupes}`);
  log("T3 every record is reached exactly once", seen.size === 5, `seen=${seen.size}`);
  log("T3 total is reported and correct", totalReported === 5, String(totalReported));

  r = await get(`/admin/users?pageSize=2&${SCOPE}`);
  log("T3 totalPages computed correctly", r.body.totalPages === 3, String(r.body.totalPages));

  // The tiebreaker matters: force identical created_at on every row
  // and confirm pagination still doesn't repeat or lose records.
  /* 🔴 كانت هذه العبارة بلا WHERE، فتدهس created_at لكل مستخدم في
     القاعدة — ووقع ذلك فعلاً على الإنتاج في 10 أغسطس 2026: ضاعت
     تواريخ تسجيل المستخدمين الحقيقيين الثلاثة، واستُرجعت تقريباً
     من أقدم أثر لكل واحد (جلسة أو اشتراك أو فاتورة أو يومية).

     القاعدة المستخلَصة: **لا عبارة كتابة في ملف اختبار بلا WHERE
     يحصرها في صفوفه.** */
  await query(`UPDATE users SET created_at = now() WHERE LOWER(email) LIKE '%@example.com'`);
  const seen2 = new Set();
  let dupes2 = 0;
  for (let page = 1; page <= 5; page++) {
    const pr = await get(`/admin/users?pageSize=1&page=${page}&${SCOPE}`);
    for (const u of pr.body.users) {
      if (seen2.has(u.id)) dupes2++;
      seen2.add(u.id);
    }
  }
  log("T3 stable ordering when every created_at is identical",
    dupes2 === 0 && seen2.size === 5, `dupes=${dupes2} seen=${seen2.size}`);

  // Sorting must not break paging either.
  r = await get("/admin/users?sort=name&dir=asc&pageSize=100");
  const names = r.body.users.map((u) => u.name);
  log("T3 sort by name ascending is applied",
    JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b, "ar"))),
    JSON.stringify(names));

  r = await get("/admin/users?sort=DROP TABLE users&dir=asc");
  log("T3 unknown sort column falls back safely, no injection", r.status === 200, String(r.status));

  // ---------- TEST 4 — Admin status action ----------
  const target = (await get("/admin/users?search=fahad@example.com")).body.users[0];

  // Establish a live session first, so revocation is observable.
  const login = await post("/api/auth/login", { email: "fahad@example.com", password: PW });
  const liveRefresh = login.body.refreshToken;
  log("T4 target user can sign in before suspension", login.status === 200, String(login.status));

  r = await post(`/admin/users/${target.id}/suspend`, { reason: "اختبار: بلاغ إساءة استخدام" });
  log("T4 suspend succeeds", r.status === 200 && r.body.account_status === "suspended", JSON.stringify(r.body));
  log("T4 existing sessions were revoked", r.body.sessionsRevoked >= 1, String(r.body.sessionsRevoked));

  const { rows: dbState } = await query(
    `SELECT suspended_at, suspended_reason, suspended_by FROM user_auth_state WHERE user_id = $1`, [target.id]);
  log("T4 DB actually updated", !!dbState[0]?.suspended_at && !!dbState[0]?.suspended_reason,
    JSON.stringify(dbState[0]));
  log("T4 suspending admin recorded", dbState[0]?.suspended_by === ADMIN_ID);

  r = await get(`/admin/users?status=suspended&${SCOPE}`);
  log("T4 user now appears under the suspended filter",
    r.body.total === 1 && r.body.users[0].id === target.id, String(r.body.total));

  // The user app must reflect it — all three doors.
  r = await post("/api/auth/login", { email: "fahad@example.com", password: PW });
  log("T4 user app: login blocked with account_suspended",
    r.status === 403 && r.body.error === "account_suspended", JSON.stringify(r.body));

  r = await post("/api/auth/refresh", { refreshToken: liveRefresh });
  log("T4 user app: refresh blocked too", r.status === 401 || r.status === 403, JSON.stringify(r.body));

  // Audit log
  const { rows: audit } = await query(
    `SELECT action, old_value, new_value, reason, metadata FROM admin_action_log WHERE target_user_id = $1`,
    [target.id]);
  log("T4 audit row written", audit.length === 1 && audit[0].action === "suspend_account", JSON.stringify(audit));
  log("T4 audit captures before and after",
    !!audit[0]?.old_value && !!audit[0]?.new_value, JSON.stringify(audit[0]?.new_value));
  log("T4 audit stores the reason", String(audit[0]?.reason).includes("إساءة"));

  r = await get(`/admin/users/${target.id}/actions`);
  log("T4 action history endpoint returns it", r.status === 200 && r.body.actions.length === 1);

  // Idempotency guard
  r = await post(`/admin/users/${target.id}/suspend`, { reason: "مرة ثانية" });
  log("T4 suspending twice is rejected, not silently repeated",
    r.status === 409 && r.body.error === "already_suspended", JSON.stringify(r.body));

  // Restore
  r = await post(`/admin/users/${target.id}/restore`, { reason: "اختبار: تبيّن أنه بلاغ خاطئ" });
  log("T4 restore succeeds", r.status === 200 && r.body.account_status === "active", JSON.stringify(r.body));

  r = await post("/api/auth/login", { email: "fahad@example.com", password: PW });
  log("T4 user can sign in again after restore", r.status === 200, String(r.status));

  const { rows: audit2 } = await query(
    `SELECT action FROM admin_action_log WHERE target_user_id = $1 ORDER BY created_at`, [target.id]);
  log("T4 restore is audited as its own entry",
    audit2.length === 2 && audit2[1].action === "restore_account", JSON.stringify(audit2.map((a) => a.action)));

  // ---------- TEST 5 — Unauthorized access ----------
  CURRENT_ADMIN = null;
  r = await get("/admin/users");
  log("T5 no admin session -> 401 on list", r.status === 401, String(r.status));
  r = await post(`/admin/users/${target.id}/suspend`, { reason: "محاولة غير مصرح بها" });
  log("T5 no admin session -> 401 on suspend", r.status === 401, String(r.status));

  const { rows: noExtra } = await query(`SELECT count(*)::int n FROM admin_action_log WHERE target_user_id = $1`, [target.id]);
  log("T5 the rejected attempt changed nothing", noExtra[0].n === 2, String(noExtra[0].n));

  // ---------- TEST 6 — Role restriction ----------
  CURRENT_ADMIN = { id: ADMIN_ID, role: "support" };
  r = await get("/admin/users");
  log("T6 support CAN list users", r.status === 200, String(r.status));

  r = await post(`/admin/users/${target.id}/suspend`, { reason: "تجاوز صلاحية" });
  // رمز الخطأ تغيّر في المرحلة 5: الصلاحية صارت بالاسم لا بالرتبة،
  // فالرد يقول أي صلاحية نقصت بدل أي رتبة.
  log("T6 support CANNOT suspend -> 403 insufficient_permission",
    r.status === 403 && r.body.error === "insufficient_permission"
      && r.body.required === "users:suspend", JSON.stringify(r.body));

  r = await get(`/admin/users/${target.id}/actions`);
  log("T6 support CANNOT read the mutation log", r.status === 403, String(r.status));

  const { rows: stillTwo } = await query(`SELECT count(*)::int n FROM admin_action_log WHERE target_user_id = $1`, [target.id]);
  log("T6 blocked action wrote nothing to the DB", stillTwo[0].n === 2, String(stillTwo[0].n));

  CURRENT_ADMIN = { id: ADMIN_ID, role: "content_manager" };
  r = await post(`/admin/users/${target.id}/suspend`, { reason: "تجاوز صلاحية" });
  log("T6 content_manager also blocked", r.status === 403, String(r.status));

  // ---------- TEST 7 — Validation ----------
  CURRENT_ADMIN = { id: ADMIN_ID, role: "admin" };
  r = await post(`/admin/users/${target.id}/suspend`, {});
  log("T7 missing reason rejected", r.status === 400 && r.body.error === "reason_required", JSON.stringify(r.body));

  r = await post(`/admin/users/${target.id}/suspend`, { reason: "   " });
  log("T7 whitespace-only reason rejected", r.status === 400, String(r.status));

  r = await post(`/admin/users/${target.id}/suspend`, { reason: "x".repeat(501) });
  log("T7 over-long reason rejected", r.status === 400 && r.body.error === "reason_too_long", String(r.status));

  // Mass assignment: extra fields must be ignored entirely.
  const beforeName = (await get(`/admin/users/${target.id}`)).body.name;
  r = await post(`/admin/users/${target.id}/suspend`, {
    reason: "اختبار الحقول غير المصرح بها",
    name: "اسم مزروع", email: "attacker@example.com", role: "owner", password_hash: "x",
  });
  const afterDetail = (await get(`/admin/users/${target.id}`)).body;
  log("T7 unpermitted fields ignored — name unchanged", afterDetail.name === beforeName, afterDetail.name);
  log("T7 unpermitted fields ignored — email unchanged", afterDetail.email === "fahad@example.com", afterDetail.email);

  r = await post(`/admin/users/${crypto.randomUUID()}/suspend`, { reason: "مستخدم غير موجود" });
  log("T7 unknown user id -> 404", r.status === 404, String(r.status));

  // ---------- TEST 8 — Persistence across a reload ----------
  // The suspension from the mass-assignment call above is live; a
  // fresh read must still see it, because it lives in the DB.
  const reread = await get(`/admin/users/${target.id}`);
  log("T8 status persists on a fresh read", reread.body.account_status === "suspended", reread.body.account_status);

  const { rows: persisted } = await query(
    `SELECT suspended_at FROM user_auth_state WHERE user_id = $1`, [target.id]);
  log("T8 the source of truth is the database, not the UI", !!persisted[0]?.suspended_at);

  // ---------- Privacy ----------
  const detail = (await get(`/admin/users/${target.id}`)).body;
  const listRow = (await get("/admin/users?search=fahad@example.com")).body.users[0];
  for (const [where, obj] of [["detail", detail], ["list", listRow]]) {
    const leaked = ["password_hash", "pin_hash", "token", "refresh_token", "access_token"]
      .filter((k) => k in obj);
    log(`P1 ${where} payload exposes no credentials`, leaked.length === 0, leaked.join(","));
  }
  log("P1 list omits age_range and gender (not needed to triage)",
    !("age_range" in listRow) && !("gender" in listRow), Object.keys(listRow).join(","));

  /* ------------------------------------------------------------
     التنظيف — لم يكن في هذا الملف تنظيف إطلاقاً.

     فكل تشغيل يترك خمسة مستخدمين وهميين في الجدول، يظهرون في لوحة
     الإدارة ويدخلون في كل عدّاد فيها. ولمّا شُغِّل على الإنتاج
     ظهروا بين المستخدمين الحقيقيين وحُذفوا يدوياً.

     وسجلّا التدقيق أولاً: كلاهما يشير إلى users بمفتاح أجنبي، وحذف
     المستخدم قبلهما يسقط على القيد. وبقية الجداول تتبعه بـCASCADE.
     ------------------------------------------------------------ */
  await query(`DELETE FROM admin_action_log WHERE target_user_id IN (SELECT id FROM users WHERE LOWER(email) LIKE '%@example.com')`);
  await query(`DELETE FROM admin_access_log WHERE target_user_id IN (SELECT id FROM users WHERE LOWER(email) LIKE '%@example.com')`);
  await query(`DELETE FROM users WHERE LOWER(email) LIKE '%@example.com'`);

  /* وحساب الاختبار الإداري وأثره في السجلّين. */
  await query(`DELETE FROM admin_action_log WHERE admin_user_id IN (SELECT id FROM admin_users WHERE LOWER(email) = 'harness@kanaf.test')`);
  await query(`DELETE FROM admin_access_log WHERE admin_user_id IN (SELECT id FROM admin_users WHERE LOWER(email) = 'harness@kanaf.test')`);
  await query(`DELETE FROM admin_users WHERE LOWER(email) = 'harness@kanaf.test'`);

  console.log = realLog;
  let pass = 0, fail = 0;
  for (const [label, cond, extra] of results) {
    if (cond) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${extra ? ` (got: ${extra})` : ""}`); }
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.log = realLog; console.error(e); server.close(); process.exit(1); });
