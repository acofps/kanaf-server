/**
 * اختبارات قبول المرحلة 4 — المحتوى والإشعارات والبيانات التشغيلية.
 *
 * تشغّل الموجّهات الحقيقية على قاعدة بيانات حقيقية (DATABASE_URL)،
 * بلا أي محاكاة لطبقة البيانات. المصادقة الإدارية تُختبر فعلياً:
 * رمز JWT حقيقي في نفس الكوكي الذي تستخدمه اللوحة، فتمر
 * requireAdminAuth و requireRole بلا تعديل.
 *
 *   node test-content-notifications.mjs
 *
 * ⚠️ يكتب صفوفاً حقيقية ثم ينظّفها. لا تشغّله على قاعدة إنتاج فيها
 * بيانات مستخدمين تهمّك قبل قراءة قسم التنظيف في آخر الملف.
 */
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { query } from "./db/pool.js";
import { issueAccessToken } from "./auth/tokens.js";
import { userDataRouter, pushPublicKeyRouter } from "./userdata/routes.js";
import { contentRouter } from "./content/routes.js";
import { adminContentRouter } from "./admin/content.js";
import { adminNotificationsRouter } from "./admin/notifications.js";
import { adminRouter } from "./admin/routes.js";
import { sweepDueCampaigns } from "./notifications/scheduler.js";

const results = [];
const log = (label, cond, extra = "") => results.push([label, !!cond, extra]);

/* ---------------------------------------------------------
   تركيب التطبيق — نفس ترتيب index.js
--------------------------------------------------------- */
let CURRENT_ADMIN = null;
let CURRENT_USER_TOKEN = null;

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());
app.use("/api/content", contentRouter);
app.use("/api", pushPublicKeyRouter);
app.use("/api/me", userDataRouter);
app.use("/admin", adminContentRouter);
app.use("/admin", adminNotificationsRouter);
app.use("/admin", adminRouter);

const server = app.listen(4581);
const B = "http://127.0.0.1:4581";

function adminCookie() {
  if (!CURRENT_ADMIN) return null;
  const token = jwt.sign(
    { sub: CURRENT_ADMIN.id, role: CURRENT_ADMIN.role, type: "access" },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "15m" }
  );
  return `kanaf_admin_access=${token}`;
}

async function req(method, path, body, { asUser = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (path.startsWith("/admin")) {
    const c = adminCookie();
    if (c) headers.Cookie = c;
  }
  const token = asUser === null ? CURRENT_USER_TOKEN : asUser;
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(B + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const get = (p, o) => req("GET", p, null, o);
const post = (p, b, o) => req("POST", p, b, o);
const patch = (p, b, o) => req("PATCH", p, b, o);

// رمز حقيقي عبر نفس المُصدِر الذي يستخدمه /api/auth/login — فتمر
// كل فحوص requireVerifiedUser (النوع، الجمهور، وجود الصف، توثيق
// البريد، الإيقاف) بلا تعديل.
function userToken(userId) {
  return issueAccessToken({ id: userId });
}

/* ---------------------------------------------------------
   بيانات الاختبار
--------------------------------------------------------- */
const TAG = `p4test_${crypto.randomBytes(4).toString("hex")}`;
const created = { users: [], admins: [], campaigns: [] };

async function makeAdmin(role) {
  const { rows } = await query(
    `INSERT INTO admin_users (name, email, password_hash, role)
     VALUES ($1, $2, 'x', $3) RETURNING id, role`,
    [`${TAG}-${role}`, `${TAG}.${role}@example.com`, role]
  );
  created.admins.push(rows[0].id);
  return rows[0];
}

async function makeUser(suffix, { verified = true } = {}) {
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'x', $3) RETURNING id, email`,
    [`${TAG}-${suffix}`, `${TAG}.${suffix}@example.com`, verified ? new Date() : null]
  );
  created.users.push(rows[0].id);
  return rows[0];
}

async function contentRow(type, key) {
  const { rows } = await query(
    `SELECT id, clinical_review_status, launch_enabled FROM content_items
     WHERE content_type = $1 AND content_key = $2`,
    [type, key]
  );
  return rows[0];
}

/* ============================================================
   التشغيل
   ============================================================ */
const owner = await makeAdmin("owner");
const adminUser = await makeAdmin("admin");
const contentManager = await makeAdmin("content_manager");

const alice = await makeUser("alice");
const bob = await makeUser("bob");

const JOURNEY = "reactivate_your_day";     // مجانية
const PLUS_JOURNEY = "break_the_thought_loop"; // كنف+
const NOTEBOOK = "need_right_now";

// الحالة الابتدائية بعد الترحيل 007: مسودة.
await query(
  `UPDATE content_items SET clinical_review_status = 'review_required', launch_enabled = false
   WHERE content_key = ANY($1::text[])`,
  [[JOURNEY, PLUS_JOURNEY, NOTEBOOK]]
);
await query(
  `UPDATE content_presentation SET publish_at = NULL, unpublish_at = NULL
   WHERE content_key = ANY($1::text[])`,
  [[JOURNEY, PLUS_JOURNEY, NOTEBOOK]]
);

/* ------------------------------------------------------------
   1) المسودة لا تظهر للمستخدم
   ------------------------------------------------------------ */
{
  const r = await get("/api/content/catalog");
  const journeys = r.body?.types?.journey || {};
  log("1. المسودة لا تظهر في كتالوج المستخدم", r.status === 200 && !journeys[JOURNEY]);
}

/* ------------------------------------------------------------
   2) بدء محتوى غير منشور مرفوض على الخادم، لا بإخفاء زر
   ------------------------------------------------------------ */
{
  CURRENT_USER_TOKEN = userToken(alice.id);
  const r = await post("/api/me/journeys", { journeyKey: JOURNEY, totalDays: 7 });
  log("2. بدء رحلة غير منشورة مرفوض من الخادم (403)", r.status === 403 && r.body.error === "content_not_published", `status=${r.status}`);
}

/* ------------------------------------------------------------
   3) content_manager لا يقدر يعتمد محتوى
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = contentManager;
  const item = await contentRow("journey", JOURNEY);
  const r = await post(`/admin/content/${item.id}/review`, { status: "approved" });
  log("3. content_manager ممنوع من الاعتماد السريري (403)", r.status === 403, `status=${r.status}`);
}

/* ------------------------------------------------------------
   4) الاعتماد وحده لا ينشر — مفتاح الإطلاق مستقل
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const item = await contentRow("journey", JOURNEY);
  const r = await post(`/admin/content/${item.id}/review`, { status: "approved", notes: "اختبار" });
  const cat = await get("/api/content/catalog");
  log("4. الاعتماد بلا إطلاق لا ينشر المحتوى", r.status === 200 && !(cat.body?.types?.journey || {})[JOURNEY]);
}

/* ------------------------------------------------------------
   5) النشر يظهر المحتوى للمستخدم
   ------------------------------------------------------------ */
{
  const item = await contentRow("journey", JOURNEY);
  const r = await post(`/admin/content/${item.id}/toggle-launch`, { enabled: true, reason: "اختبار نشر" });
  const cat = await get("/api/content/catalog");
  const entry = (cat.body?.types?.journey || {})[JOURNEY];
  log("5. النشر يُظهر المحتوى للمستخدم فوراً", r.status === 200 && !!entry && entry.enabled === true);
}

/* ------------------------------------------------------------
   6) بعد النشر يقدر المستخدم يبدأ فعلاً
   ------------------------------------------------------------ */
{
  CURRENT_USER_TOKEN = userToken(alice.id);
  const r = await post("/api/me/journeys", { journeyKey: JOURNEY, totalDays: 7 });
  log("6. المستخدم يقدر يبدأ الرحلة المنشورة", r.status === 201 && r.body.journey_key === JOURNEY, `status=${r.status}`);
}

/* ------------------------------------------------------------
   7) تعديل محتوى منشور ينعكس على القراءة التالية
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const newTitle = `عنوان محدَّث ${TAG}`;
  const r = await patch(`/admin/content/journey/${JOURNEY}/presentation`, { title: newTitle, reason: "اختبار تعديل" });
  const cat = await get("/api/content/catalog");
  log("7. تعديل محتوى منشور يظهر للمستخدم فوراً",
    r.status === 200 && (cat.body?.types?.journey || {})[JOURNEY]?.title === newTitle);
}

/* ------------------------------------------------------------
   8) تغيير الطبقة قرار مالي — content_manager ممنوع
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = contentManager;
  const r = await patch(`/admin/content/journey/${JOURNEY}/presentation`, { subscriptionTier: "free", reason: "محاولة" });
  log("8. تغيير الطبقة يحتاج admin (403 لـcontent_manager)", r.status === 403 && r.body.error === "tier_change_requires_admin");
}

/* ------------------------------------------------------------
   9) جدار الدفع: محتوى كنف+ لمستخدم غير مشترك = 402 لا 403
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const item = await contentRow("journey", PLUS_JOURNEY);
  await post(`/admin/content/${item.id}/review`, { status: "approved", notes: "اختبار" });
  await post(`/admin/content/${item.id}/toggle-launch`, { enabled: true, reason: "اختبار" });

  CURRENT_USER_TOKEN = userToken(bob.id);
  const r = await post("/api/me/journeys", { journeyKey: PLUS_JOURNEY, totalDays: 7 });
  log("9. محتوى كنف+ لغير المشترك يرد 402 (لا 403)", r.status === 402 && r.body.error === "subscription_required", `status=${r.status}`);
}

/* ------------------------------------------------------------
   10) إيقاف النشر يعمل — من الكتالوج ومن البدء معاً
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const item = await contentRow("journey", PLUS_JOURNEY);
  await post(`/admin/content/${item.id}/toggle-launch`, { enabled: false, reason: "اختبار إيقاف" });
  const cat = await get("/api/content/catalog");
  CURRENT_USER_TOKEN = userToken(alice.id);
  const start = await post("/api/me/journeys", { journeyKey: PLUS_JOURNEY, totalDays: 7 });
  log("10. الإيقاف يخفي المحتوى ويمنع بدأه",
    !(cat.body?.types?.journey || {})[PLUS_JOURNEY] && start.status === 403);
}

/* ------------------------------------------------------------
   11) الجدولة: publish_at في المستقبل يخفي، وفي الماضي يُظهر
        بلا أي وظيفة خلفية
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const future = new Date(Date.now() + 3600_000).toISOString();
  await post(`/admin/content/journey/${JOURNEY}/schedule`, { publishAt: future, reason: "اختبار جدولة" });
  const hidden = await get("/api/content/catalog");

  const past = new Date(Date.now() - 3600_000).toISOString();
  await post(`/admin/content/journey/${JOURNEY}/schedule`, { publishAt: past, reason: "اختبار جدولة" });
  const shown = await get("/api/content/catalog");

  log("11. المحتوى المجدول يظهر في وقته بالضبط ولا قبله",
    !(hidden.body?.types?.journey || {})[JOURNEY] && !!(shown.body?.types?.journey || {})[JOURNEY]);
}

/* ------------------------------------------------------------
   12) unpublish_at ينهي العرض تلقائياً
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  await post(`/admin/content/journey/${JOURNEY}/schedule`, {
    publishAt: new Date(Date.now() - 7200_000).toISOString(),
    unpublishAt: new Date(Date.now() - 60_000).toISOString(),
    reason: "اختبار انتهاء",
  });
  const cat = await get("/api/content/catalog");
  log("12. انتهاء وقت العرض يخفي المحتوى تلقائياً", !(cat.body?.types?.journey || {})[JOURNEY]);
  await post(`/admin/content/journey/${JOURNEY}/schedule`, { publishAt: null, unpublishAt: null, reason: "إعادة" });
}

/* ------------------------------------------------------------
   13) سجل نسخ المحتوى يكتب كل تغيير
   ------------------------------------------------------------ */
{
  const { rows } = await query(
    `SELECT change_kind FROM content_versions WHERE content_key = $1 ORDER BY created_at`,
    [JOURNEY]
  );
  const kinds = new Set(rows.map((r) => r.change_kind));
  log("13. سجل النسخ يحوي review و publish و schedule",
    kinds.has("review") && kinds.has("publish") && kinds.has("schedule"), [...kinds].join(","));
}

/* ------------------------------------------------------------
   14) سجل التدقيق الإداري يكتب أحداث المحتوى
   ------------------------------------------------------------ */
{
  const { rows } = await query(
    `SELECT action FROM admin_action_log WHERE admin_user_id = $1 ORDER BY created_at`,
    [adminUser.id]
  );
  const actions = new Set(rows.map((r) => r.action));
  log("14. admin_action_log يسجّل النشر والإيقاف والجدولة",
    actions.has("content_publish") && actions.has("content_unpublish") && actions.has("content_schedule"));
}

/* ============================================================
   الإشعارات
   ============================================================ */

/* ------------------------------------------------------------
   15) إشعار لمستخدم محدد يصل له وحده
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const r = await post("/admin/notifications", {
    title: `موجّه ${TAG}`, body: "رسالة لمستخدم واحد",
    audience: "selected_users", audienceFilter: { userIds: [alice.id] },
    channels: ["in_app"], sendNow: true,
  });
  created.campaigns.push(r.body.id);

  CURRENT_USER_TOKEN = userToken(alice.id);
  const aliceInbox = await get("/api/me/notifications");
  CURRENT_USER_TOKEN = userToken(bob.id);
  const bobInbox = await get("/api/me/notifications");

  const inAlice = (aliceInbox.body.notifications || []).some((n) => n.title === `موجّه ${TAG}`);
  const inBob = (bobInbox.body.notifications || []).some((n) => n.title === `موجّه ${TAG}`);
  log("15. الإشعار الموجّه يصل المستهدف وحده", r.status === 201 && inAlice && !inBob);
}

/* ------------------------------------------------------------
   16) حالة التسليم حقيقية — صف لكل مستلم بقناته
   ------------------------------------------------------------ */
{
  const campaignId = created.campaigns[0];
  const d = await get(`/admin/notifications/${campaignId}/deliveries`);
  const rows = d.body.deliveries || [];
  log("16. صف تسليم حقيقي لكل مستلم بحالة delivered",
    rows.length === 1 && rows[0].channel === "in_app" && rows[0].status === "delivered",
    JSON.stringify(rows.map((r) => `${r.channel}:${r.status}`)));
}

/* ------------------------------------------------------------
   17) البريد المقنّع — شاشة التسليم لا تسرّب قائمة عناوين
   ------------------------------------------------------------ */
{
  const d = await get(`/admin/notifications/${created.campaigns[0]}/deliveries`);
  const masked = (d.body.deliveries || [])[0]?.user_email_masked || "";
  log("17. البريد يُعرض مقنّعاً في شاشة التسليم", masked.includes("***") && !masked.includes(alice.email), masked);
}

/* ------------------------------------------------------------
   18) منع التكرار: إعادة الإرسال لا تنتج إشعاراً ثانياً
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  await post(`/admin/notifications/${created.campaigns[0]}/send`, { reason: "إعادة" });
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM user_notifications WHERE user_id = $1 AND campaign_id = $2`,
    [alice.id, created.campaigns[0]]
  );
  const { rows: dRows } = await query(
    `SELECT count(*)::int AS n FROM notification_deliveries WHERE campaign_id = $1`,
    [created.campaigns[0]]
  );
  log("18. إعادة الإرسال لا تكرّر الإشعار ولا صف التسليم", rows[0].n === 1 && dRows[0].n === 1, `notif=${rows[0].n} deliv=${dRows[0].n}`);
}

/* ------------------------------------------------------------
   19) الفشل الحقيقي يظهر فشلاً — لا نجاح كاذب

   قناة push بلا مفاتيح VAPID تُرفض عند الإنشاء أصلاً (الدرس
   المستخلص من عطب dev-mock). هنا نتأكد أن الرفض يحدث في أبكر
   نقطة، لا بعد "إرسال" وهمي.
   ------------------------------------------------------------ */
{
  const hadKeys = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  CURRENT_ADMIN = adminUser;
  const r = await post("/admin/notifications", {
    title: `push ${TAG}`, body: "اختبار",
    audience: "selected_users", audienceFilter: { userIds: [alice.id] },
    channels: ["push"], sendNow: true,
  });
  if (hadKeys) {
    // بمفاتيح مضبوطة: تُقبل الحملة، والمستخدم بلا اشتراك جهاز
    // فتُسجَّل skipped لا sent.
    const d = await get(`/admin/notifications/${r.body.id}/deliveries`);
    const st = (d.body.deliveries || [])[0]?.status;
    log("19. push بلا اشتراك جهاز يُسجَّل skipped لا sent", st === "skipped", `status=${st}`);
    created.campaigns.push(r.body.id);
  } else {
    log("19. push بلا مفاتيح VAPID يُرفض عند الإنشاء لا بعد إرسال وهمي",
      r.status === 400 && r.body.error === "push_not_configured", `status=${r.status}`);
  }
}

/* ------------------------------------------------------------
   20) جمهور فارغ يُرفض بدل حملة "ناجحة" بلا أثر
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const r = await post("/admin/notifications", {
    title: `فارغ ${TAG}`, body: "x",
    audience: "selected_users", audienceFilter: { userIds: [crypto.randomUUID()] },
    channels: ["in_app"], sendNow: true,
  });
  log("20. الجمهور الفارغ يُرفض (422)", r.status === 422 && r.body.error === "no_recipients_in_audience", `status=${r.status}`);
}

/* ------------------------------------------------------------
   21) الإشعار المجدول لا يُرسل قبل وقته
   ------------------------------------------------------------ */
let scheduledId = null;
{
  CURRENT_ADMIN = adminUser;
  const r = await post("/admin/notifications", {
    title: `مجدول ${TAG}`, body: "رسالة مجدولة",
    audience: "selected_users", audienceFilter: { userIds: [bob.id] },
    channels: ["in_app"],
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  scheduledId = r.body.id;
  created.campaigns.push(scheduledId);

  await sweepDueCampaigns();
  const { rows } = await query(`SELECT status FROM notification_campaigns WHERE id = $1`, [scheduledId]);
  const { rows: n } = await query(`SELECT count(*)::int AS n FROM user_notifications WHERE campaign_id = $1`, [scheduledId]);
  log("21. المجدول يبقى scheduled ولا يصل قبل وقته", rows[0].status === "scheduled" && n[0].n === 0, rows[0].status);
}

/* ------------------------------------------------------------
   22) وحين يحين وقته، المسح ينفّذه فعلاً
   ------------------------------------------------------------ */
{
  await query(`UPDATE notification_campaigns SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [scheduledId]);
  await sweepDueCampaigns();
  const { rows } = await query(`SELECT status, sent_count FROM notification_campaigns WHERE id = $1`, [scheduledId]);
  CURRENT_USER_TOKEN = userToken(bob.id);
  const inbox = await get("/api/me/notifications");
  const arrived = (inbox.body.notifications || []).some((x) => x.title === `مجدول ${TAG}`);
  log("22. المجدول يُنفَّذ عند استحقاقه ويصل الجمهور الصحيح",
    rows[0].status === "sent" && rows[0].sent_count === 1 && arrived, `status=${rows[0].status}`);
}

/* ------------------------------------------------------------
   23) لا يمكن إلغاء حملة بعد تنفيذها
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const r = await post(`/admin/notifications/${scheduledId}/cancel`, { reason: "متأخر" });
  log("23. إلغاء حملة منفَّذة مرفوض (409)", r.status === 409, `status=${r.status}`);
}

/* ------------------------------------------------------------
   24) عزل بيانات المستخدمين: لا أحد يعلّم إشعار غيره مقروءاً
   ------------------------------------------------------------ */
{
  const { rows } = await query(`SELECT id FROM user_notifications WHERE user_id = $1 LIMIT 1`, [alice.id]);
  CURRENT_USER_TOKEN = userToken(bob.id);
  const r = await post(`/api/me/notifications/${rows[0].id}/read`);
  log("24. مستخدم لا يقدر يلمس إشعار مستخدم ثاني (404)", r.status === 404, `status=${r.status}`);
}

/* ============================================================
   البيانات التشغيلية والخصوصية
   ============================================================ */

/* ------------------------------------------------------------
   25) اليوميات تُحفظ فعلاً، والإرسال المكرر تعديل لا خطأ
   ------------------------------------------------------------ */
{
  CURRENT_USER_TOKEN = userToken(alice.id);
  const today = new Date().toISOString().slice(0, 10);
  const a = await post("/api/me/logs", { mood: 6, sleep: 5, energy: 4, note: "أول تسجيل", loggedOn: today });
  const b = await post("/api/me/logs", { mood: 8, sleep: 7, energy: 6, note: "تصحيح", loggedOn: today });
  const { rows } = await query(`SELECT count(*)::int AS n, max(mood) AS mood FROM daily_logs WHERE user_id = $1`, [alice.id]);
  log("25. اليومية تُحفظ وصف واحد لكل يوم مع تحديث القيمة",
    a.status === 201 && b.status === 201 && rows[0].n === 1 && rows[0].mood === 8);
}

/* ------------------------------------------------------------
   26) شرط بوصلة كنف يُحسب من قاعدة البيانات
   ------------------------------------------------------------ */
{
  CURRENT_USER_TOKEN = userToken(alice.id);
  await post("/api/me/screenings", { kind: "phq9", total: 9, bandLabel: "خفيف", answers: { q1: 1 } });
  const s = await get("/api/me/summary");
  log("26. summary يعيد trackedDays و hasScreening من القاعدة",
    s.body.trackedDays === 1 && s.body.hasScreening === true, JSON.stringify({ d: s.body.trackedDays, h: s.body.hasScreening }));
}

/* ------------------------------------------------------------
   27) تقدّم الرحلة يُحفظ ويكتمل عند اليوم الأخير
   ------------------------------------------------------------ */
{
  CURRENT_USER_TOKEN = userToken(alice.id);
  let last = null;
  for (let d = 1; d <= 7; d++) last = await post(`/api/me/journeys/${JOURNEY}/days/${d}/complete`);
  const listed = await get("/api/me/journeys");
  const e = (listed.body.enrollments || []).find((x) => x.journey_key === JOURNEY);
  log("27. إكمال كل الأيام ينهي الرحلة ويُحفظ التقدّم",
    last.body.journeyCompleted === true && e?.status === "completed" && e.days.length === 7);
}

/* ------------------------------------------------------------
   28) نص الدفتر يُحفظ للمستخدم — ولا يظهر في أي مسار إداري

   هذا أهم اختبار خصوصية في المرحلة: نص حر عن الحالة النفسية.
   ------------------------------------------------------------ */
{
  CURRENT_USER_TOKEN = userToken(alice.id);
  const item = await contentRow("notebook", NOTEBOOK);
  CURRENT_ADMIN = adminUser;
  await post(`/admin/content/${item.id}/review`, { status: "approved", notes: "اختبار" });
  await post(`/admin/content/${item.id}/toggle-launch`, { enabled: true, reason: "اختبار" });

  CURRENT_USER_TOKEN = userToken(alice.id);
  const secret = `نص-خاص-جداً-${TAG}`;
  const c = await post("/api/me/notebooks", { templateKey: NOTEBOOK });
  await patch(`/api/me/notebooks/${c.body.id}`, { answers: { current_state: secret }, status: "completed" });

  const mine = await get("/api/me/notebooks");
  const userSees = JSON.stringify(mine.body).includes(secret);

  CURRENT_ADMIN = adminUser;
  const adminView = await get(`/admin/users/${alice.id}/sensitive?reason=اختبار خصوصية المرحلة 4`);
  const adminSees = JSON.stringify(adminView.body).includes(secret);

  log("28. نص الدفتر يظهر لصاحبه ولا يظهر في المسار الإداري الحساس",
    userSees && !adminSees, `user=${userSees} admin=${adminSees}`);
}

/* ------------------------------------------------------------
   29) الوصول للبيانات الحساسة يشترط سبباً ويُسجَّل
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const noReason = await get(`/admin/users/${alice.id}/sensitive`);
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM admin_access_log
     WHERE admin_user_id = $1 AND target_user_id = $2 AND action = 'view_sensitive_data'`,
    [adminUser.id, alice.id]
  );
  log("29. قراءة البيانات الحساسة بلا سبب مرفوضة، والمسموحة مسجَّلة",
    noReason.status === 400 && rows[0].n >= 1);
}

/* ------------------------------------------------------------
   30) support لا يصل البيانات الحساسة إطلاقاً
   ------------------------------------------------------------ */
{
  const support = await makeAdmin("support");
  CURRENT_ADMIN = support;
  const r = await get(`/admin/users/${alice.id}/sensitive?reason=محاولة`);
  log("30. صلاحية support لا تصل البيانات الحساسة (403)", r.status === 403, `status=${r.status}`);
}

/* ------------------------------------------------------------
   31) عدّاد أحداث الخطر يُكتب فعلاً — كان صفراً أبداً
   ------------------------------------------------------------ */
{
  const before = (await query(`SELECT count(*)::int AS n FROM crisis_trigger_events`)).rows[0].n;
  await query(`INSERT INTO crisis_trigger_events (trigger_source) VALUES ('phq9_item9')`);
  const after = (await query(`SELECT count(*)::int AS n FROM crisis_trigger_events`)).rows[0].n;
  const { rows: cols } = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'crisis_trigger_events'`
  );
  const names = cols.map((c) => c.column_name);
  log("31. جدول أحداث الخطر قابل للكتابة وبلا أي عمود يربطه بمستخدم",
    after === before + 1 && !names.includes("user_id") && !names.includes("ip_address"), names.join(","));
}

/* ------------------------------------------------------------
   32) البحث والترقيم من طرف الخادم
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = contentManager;
  const page1 = await get("/admin/content?type=notebook&limit=10&offset=0");
  const page2 = await get("/admin/content?type=notebook&limit=10&offset=10");
  const ids1 = new Set((page1.body.items || []).map((i) => i.content_key));
  const overlap = (page2.body.items || []).filter((i) => ids1.has(i.content_key));
  log("32. الترقيم من الخادم بلا تكرار بين الصفحات",
    page1.body.items.length === 10 && overlap.length === 0 && page1.body.total >= 29, `total=${page1.body.total}`);
}

{
  CURRENT_ADMIN = contentManager;
  const r = await get("/admin/content?search=need_right_now");
  log("33. البحث بالمفتاح يعمل من الخادم", r.body.total === 1 && r.body.items[0].content_key === NOTEBOOK);
}

/* ------------------------------------------------------------
   34) الكتالوج لا يسرّب المحتوى غير المنشور ولا سبب إخفائه
   ------------------------------------------------------------ */
{
  const cat = await get("/api/content/catalog");
  const raw = JSON.stringify(cat.body);
  log("34. الكتالوج العام لا يسرّب حالة المراجعة ولا تواريخ الجدولة",
    !raw.includes("review_required") && !raw.includes("publish_at") && !raw.includes("hidden_reason"));
}

/* ============================================================
   اختبارات انحدار — كل واحد منها يمنع عطباً وُجد في المراجعة
   الصارمة بعد بناء المرحلة، لا افتراضاً.
   ============================================================ */

/* ------------------------------------------------------------
   35) تطابق الطبقات مع نموذج التسعير

   أول بذر للترحيل استُخرج بتعبير نمطي يشترط ورود
   subscription_tier في أول السطر، فسقط 45 عنصراً إلى 'free'.
   ولأن الخادم يتقدّم على القيمة المضمّنة في التطبيق، كان ذلك
   سيجعل كل التراكبات و25 دفتراً و12 رحلة **مجانية على الإنتاج**.
   ------------------------------------------------------------ */
{
  const { rows } = await query(
    `SELECT content_type, subscription_tier, count(*)::int AS n
     FROM content_presentation GROUP BY 1,2`
  );
  const m = {};
  rows.forEach((r) => { m[`${r.content_type}:${r.subscription_tier}`] = r.n; });

  const { rows: freeJ } = await query(
    `SELECT content_key FROM content_presentation
     WHERE content_type = 'journey' AND subscription_tier = 'free' ORDER BY content_key`
  );
  const { rows: freeN } = await query(
    `SELECT content_key FROM content_presentation
     WHERE content_type = 'notebook' AND subscription_tier = 'free' ORDER BY content_key`
  );

  const ok =
    m["journey:free"] === 1 && m["journey:plus"] === 17 &&
    m["overlay:plus"] === 8 && !m["overlay:free"] &&
    m["notebook:free"] === 4 && m["notebook:plus"] === 25 &&
    m["cbt_tool:free"] === 3 && m["cbt_tool:plus"] === 1 &&
    m["library_article:free"] === 5 &&
    freeJ[0]?.content_key === "reactivate_your_day" &&
    freeN.map((r) => r.content_key).join(",") ===
      "difficult_decision,need_right_now,realistic_gratitude,understand_emotion";

  log("35. الطبقات مطابقة لنموذج التسعير (رحلة مجانية واحدة و4 دفاتر)", ok, JSON.stringify(m));
}

/* ------------------------------------------------------------
   36) النشر الجماعي لا يعكس رفضاً سريرياً ولا يمحو ملاحظته
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const item = await contentRow("journey", PLUS_JOURNEY);
  await post(`/admin/content/${item.id}/review`, { status: "rejected", notes: "غير آمن سريرياً" });

  CURRENT_ADMIN = owner;
  await post("/admin/content/bulk-publish", { type: "journey", reason: "اختبار نشر جماعي" });

  const { rows } = await query(
    `SELECT clinical_review_status, launch_enabled, review_notes FROM content_items
     WHERE content_type = 'journey' AND content_key = $1`,
    [PLUS_JOURNEY]
  );
  log("36. النشر الجماعي لا يُحيي محتوى مرفوضاً سريرياً ولا يمحو ملاحظته",
    rows[0].clinical_review_status === "rejected" && rows[0].launch_enabled === false &&
    rows[0].review_notes === "غير آمن سريرياً",
    JSON.stringify(rows[0]));
}

/* ------------------------------------------------------------
   37) النشر الجماعي يرفض العمل بلا نطاق صريح
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = owner;
  const r = await post("/admin/content/bulk-publish", { reason: "بلا نطاق" });
  const r2 = await post("/admin/content/bulk-publish", { reason: "بنطاق صريح", all: true });
  log("37. النشر الجماعي يشترط نطاقاً صريحاً (400) ويقبل all: true",
    r.status === 400 && r.body.error === "scope_required" && r2.status === 200,
    `${r.status}/${r2.status}`);
}

/* ------------------------------------------------------------
   38) حملة عالقة في sending تُسترجَع، والفاشلة يُعاد إرسالها

   كان دخول dispatchCampaign محصوراً بـdraft/scheduled، فأي
   انقطاع (وRender يرسل SIGTERM عند كل نشر) يترك الحملة عالقة
   بلا مخرج: لا إرسال ولا إلغاء.
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const r = await post("/admin/notifications", {
    title: `عالقة ${TAG}`, body: "اختبار استرجاع",
    audience: "selected_users", audienceFilter: { userIds: [bob.id] },
    channels: ["in_app"],
  });
  const id = r.body.id;
  created.campaigns.push(id);

  // محاكاة انقطاع: sending منذ 20 دقيقة وصف تسليم عالق
  await query(
    `UPDATE notification_campaigns SET status = 'sending', started_at = now() - interval '20 minutes' WHERE id = $1`,
    [id]
  );
  await query(
    `INSERT INTO notification_deliveries (campaign_id, user_id, channel, status)
     VALUES ($1, $2, 'in_app', 'processing')`,
    [id, bob.id]
  );

  const again = await post(`/admin/notifications/${id}/send`, { reason: "استرجاع" });
  const { rows } = await query(`SELECT status, sent_count FROM notification_campaigns WHERE id = $1`, [id]);
  log("38. الحملة العالقة في sending تُسترجَع وتكتمل",
    !again.body.skipped && rows[0].status === "sent" && rows[0].sent_count === 1,
    JSON.stringify({ skipped: again.body.skipped, status: rows[0].status }));
}

/* ------------------------------------------------------------
   39) مسارات التوافق /admin/broadcasts تنشئ حملة حقيقية

   حزمة لوحة الإدارة المنشورة تنادي هذه المسارات الثلاثة. حذفها
   كان يعني أن إصلاح البث الوهمي ينتهي بتعطيل البث كلياً (404).
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const count = await get("/admin/broadcasts/audience-count?audience=all");
  const send = await post("/admin/broadcasts", {
    subject: `بث ${TAG}`, message: "رسالة بث", audience: "all",
  });
  const list = await get("/admin/broadcasts");

  const { rows: deliveries } = await query(
    `SELECT channel, status FROM notification_deliveries WHERE campaign_id = $1 ORDER BY channel`,
    [send.body.id]
  );
  if (send.body.id) created.campaigns.push(send.body.id);

  const inApp = deliveries.filter((d) => d.channel === "in_app" && d.status === "delivered").length;
  log("39. مسارات التوافق تعمل وتنشئ حملة حقيقية بصفوف تسليم",
    count.status === 200 && typeof count.body.count === "number" &&
    send.status === 201 && typeof send.body.totalRecipients === "number" &&
    Array.isArray(list.body.broadcasts) && list.body.broadcasts.some((b) => b.subject === `بث ${TAG}`) &&
    inApp >= 1,
    JSON.stringify({ c: count.status, s: send.status, inApp }));
}

/* ------------------------------------------------------------
   40) GET /admin/content يحافظ على المفتاح الذي تقرأه اللوحة
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = contentManager;
  const r = await get("/admin/content?type=journey");
  log("40. رد المحتوى يحمل items و content معاً (توافق اللوحة المنشورة)",
    Array.isArray(r.body.items) && Array.isArray(r.body.content) &&
    r.body.content.length === r.body.items.length && r.body.content.length > 0);
}

/* ------------------------------------------------------------
   41) بصمة الكتالوج تتغيّر حين يتغيّر محتواه

   كانت البصمة `عدد:مجموع أطوال المفاتيح` — لا تتحرك حين يتغيّر
   عنوان أو طبقة. أي أن تحويل محتوى إلى كنف+ لا يصل جهازاً
   مثبَّتاً أبداً، لأن الخادم يرد 304 على بصمته القديمة.
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const item = await contentRow("journey", JOURNEY);
  await post(`/admin/content/${item.id}/review`, { status: "approved", notes: "اختبار" });
  await post(`/admin/content/${item.id}/toggle-launch`, { enabled: true, reason: "اختبار" });

  const before = await get("/api/content/catalog");
  await patch(`/admin/content/journey/${JOURNEY}/presentation`, { subscriptionTier: "plus", reason: "اختبار بصمة" });
  const after = await get("/api/content/catalog");

  log("41. تغيير الطبقة يغيّر بصمة الكتالوج (فلا يُخدَم 304 قديم)",
    before.body.revision !== after.body.revision &&
    after.body.types.journey[JOURNEY].subscription_tier === "plus",
    `${before.body.revision} → ${after.body.revision}`);

  await patch(`/admin/content/journey/${JOURNEY}/presentation`, { subscriptionTier: "free", reason: "إعادة" });
}

/* ------------------------------------------------------------
   42) اليومية بالتاريخ المحلي — ولا تدهس يوماً سابقاً

   الخادم يعمل بـUTC والمستخدم بالرياض. النسخة الأولى كانت تمرّر
   ما يصلها عبر toISOString، فتسجيل الواحدة فجراً يُنسب لليوم
   السابق ويدهسه عبر ON CONFLICT.
   ------------------------------------------------------------ */
{
  CURRENT_USER_TOKEN = userToken(bob.id);
  const stamped = await post("/api/me/logs", { mood: 5, sleep: 5, energy: 5, loggedOn: "2026-08-10T01:00:00+03:00" });

  const d1 = "2026-08-09", d2 = "2026-08-10";
  await post("/api/me/logs", { mood: 3, sleep: 3, energy: 3, loggedOn: d1 });
  await post("/api/me/logs", { mood: 9, sleep: 9, energy: 9, loggedOn: d2 });
  const { rows } = await query(
    `SELECT logged_on::text AS d, mood FROM daily_logs WHERE user_id = $1 ORDER BY logged_on`, [bob.id]
  );

  log("42. الطابع الزمني مرفوض، ويومان محليان متتاليان لا يدهس أحدهما الآخر",
    stamped.status === 400 && stamped.body.error === "invalid_logged_on" &&
    rows.length === 2 && rows[0].d === d1 && rows[0].mood === 3 && rows[1].d === d2 && rows[1].mood === 9,
    JSON.stringify({ st: stamped.status, rows }));
}

/* ------------------------------------------------------------
   43) قيم خارج المدى ترد 400 لا 500
   ------------------------------------------------------------ */
{
  CURRENT_USER_TOKEN = userToken(alice.id);
  const { rows } = await query(`SELECT id FROM user_notebook_entries WHERE user_id = $1 LIMIT 1`, [alice.id]);
  const h = rows[0]
    ? await patch(`/api/me/notebooks/${rows[0].id}`, { helpfulness: 40000 })
    : { status: 400, body: { error: "invalid_helpfulness" } };
  const j = await post("/api/me/journeys", { journeyKey: JOURNEY, journeyType: "bogus", totalDays: 7 });
  CURRENT_ADMIN = adminUser;
  const u = await get("/admin/notifications/not-a-uuid/deliveries");

  log("43. helpfulness ونوع الرحلة والمعرّف غير الصالح كلها 400/404 لا 500",
    h.status === 400 && j.status === 400 && j.body.error === "invalid_journey_type" && u.status === 404,
    `${h.status}/${j.status}/${u.status}`);
}

/* ------------------------------------------------------------
   44) نوع الرحلة companion مقبول — رحلتان في التطبيق تحملانه
   ------------------------------------------------------------ */
{
  CURRENT_ADMIN = adminUser;
  const item = await contentRow("journey", "prepare_to_seek_help");
  await post(`/admin/content/${item.id}/review`, { status: "approved", notes: "اختبار" });
  await post(`/admin/content/${item.id}/toggle-launch`, { enabled: true, reason: "اختبار" });
  await query(`UPDATE content_presentation SET subscription_tier = 'free' WHERE content_key = 'prepare_to_seek_help'`);

  CURRENT_USER_TOKEN = userToken(alice.id);
  const r = await post("/api/me/journeys", { journeyKey: "prepare_to_seek_help", journeyType: "companion", totalDays: 5 });
  log("44. نوع الرحلة companion مقبول في الخادم وقاعدة البيانات", r.status === 201, `status=${r.status}`);
}

/* ------------------------------------------------------------
   45) اشتراك Push لا يُستولى عليه من حساب آخر
   ------------------------------------------------------------ */
{
  const sub = { endpoint: `https://push.example.com/${TAG}`, keys: { p256dh: "aaa", auth: "bbb" } };
  CURRENT_USER_TOKEN = userToken(alice.id);
  await post("/api/me/push/subscribe", { subscription: sub });
  const { rows: first } = await query(`SELECT user_id FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);

  CURRENT_USER_TOKEN = userToken(bob.id);
  await post("/api/me/push/subscribe", { subscription: sub });
  const { rows: after } = await query(`SELECT user_id, count(*) OVER () AS n FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);

  log("45. تسجيل نفس الجهاز بحساب ثانٍ لا يترك الأول مالكاً ولا يكرّر الصف",
    first[0]?.user_id === alice.id && after.length === 1 && after[0].user_id === bob.id,
    JSON.stringify({ first: first[0]?.user_id === alice.id, owner: after[0]?.user_id === bob.id }));
}

/* ------------------------------------------------------------
   46) عنصر محتوى بلا صف عرض يظهر للمسؤول ولا يظهر للمستخدم

   بـINNER JOIN كان يختفي من الكتالوجين معاً — فلا يمكن حتى
   تشخيصه من اللوحة.
   ------------------------------------------------------------ */
{
  await query(
    `INSERT INTO content_items (content_type, content_key, content_version, clinical_review_status, launch_enabled)
     VALUES ('journey', $1, '1.0.0', 'approved', true)
     ON CONFLICT DO NOTHING`,
    [`orphan_${TAG}`]
  );
  CURRENT_ADMIN = contentManager;
  const adminView = await get(`/admin/content?search=orphan_${TAG}`);
  const userView = await get("/api/content/catalog");
  const item = (adminView.body.items || [])[0];

  log("46. عنصر بلا صف عرض يظهر للمسؤول موسوماً ولا يظهر للمستخدم",
    !!item && item.missing_presentation === true && item.is_live === false &&
    !(userView.body.types.journey || {})[`orphan_${TAG}`],
    JSON.stringify({ found: !!item, missing: item?.missing_presentation, live: item?.is_live }));

  await query(`DELETE FROM content_items WHERE content_key = $1`, [`orphan_${TAG}`]);
}

/* ============================================================
   النتيجة
   ============================================================ */
const pass = results.filter((r) => r[1]).length;
console.log("\n=== اختبارات المرحلة 4 — المحتوى والإشعارات والبيانات التشغيلية ===\n");
for (const [label, ok, extra] of results) {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra && !ok ? `  (${extra})` : ""}`);
}
console.log(`\n${pass}/${results.length} نجحت\n`);

/* ------------------------------------------------------------
   التنظيف — يحذف ما أنشأه هذا الملف وحده، بالوسم TAG.

   الحذف بـuser_id يجرّ معه اليوميات والفرز والرحلات والدفاتر
   والإشعارات عبر ON DELETE CASCADE. المحتوى يُعاد إلى حالة مسودة
   كما بذره الترحيل 007.
   ------------------------------------------------------------ */
await query(`DELETE FROM notification_campaigns WHERE title LIKE $1`, [`%${TAG}%`]);
await query(`DELETE FROM push_subscriptions WHERE endpoint LIKE $1`, [`%${TAG}%`]);
await query(`DELETE FROM content_items WHERE content_key LIKE 'orphan_%'`);

// سجلا التدقيق أولاً: كلاهما يشير إلى users بمفتاح أجنبي، وحذف
// المستخدم قبلهما يسقط على القيد.
await query(`DELETE FROM admin_action_log WHERE admin_user_id = ANY($1::uuid[]) OR target_user_id = ANY($2::uuid[])`, [created.admins, created.users]);
await query(`DELETE FROM admin_access_log WHERE admin_user_id = ANY($1::uuid[]) OR target_user_id = ANY($2::uuid[])`, [created.admins, created.users]);
await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [created.users]);
await query(`DELETE FROM content_versions WHERE changed_by = ANY($1::uuid[])`, [created.admins]);

/* إعادة المحتوى كله إلى حالة الترحيل **قبل** حذف حسابات الاختبار.

   اختبار 37 يشغّل نشراً جماعياً بـall: true، فيمس الأربعة والستين
   عنصراً. وreviewer_admin_id مفتاح أجنبي إلى admin_users، فحذف
   المراجع قبل تفريغ الحقل يسقط على القيد — نفس ترتيب الاعتماد
   المتبادل الذي فرض حذف سجلي التدقيق قبل المستخدمين أعلاه. */
await query(
  `UPDATE content_items SET clinical_review_status = 'review_required', launch_enabled = false,
          reviewer_admin_id = NULL, reviewed_at = NULL, review_notes = NULL`
);
await query(`DELETE FROM admin_users WHERE id = ANY($1::uuid[])`, [created.admins]);

// وإعادة العرض إلى ما بذره الترحيل (اختبارات 41 و44 تغيّر الطبقة).
await query(
  `UPDATE content_presentation SET title = 'استعادة النشاط', publish_at = NULL, unpublish_at = NULL,
          subscription_tier = 'free', updated_by = NULL, scheduled_by = NULL
   WHERE content_type = 'journey' AND content_key = $1`,
  [JOURNEY]
);
await query(
  `UPDATE content_presentation SET subscription_tier = 'plus', updated_by = NULL, scheduled_by = NULL
   WHERE content_type = 'journey' AND content_key IN ($1, 'prepare_to_seek_help')`,
  [PLUS_JOURNEY]
);

server.close();
process.exit(pass === results.length ? 0 : 1);
