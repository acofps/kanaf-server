/**
 * اختبارات قبول المرحلة 6 — الملف الشخصي والصورة والخطة والتذكير
 * ومزامنة اللوحة.
 *
 * تشغّل الموجّهات الحقيقية على قاعدة بيانات حقيقية (DATABASE_URL)،
 * بلا أي محاكاة لطبقة البيانات، وبرموز مصادقة حقيقية من نفس
 * المُصدِرين اللذين يستعملهما التطبيق واللوحة.
 *
 *   node test-06-profile-flows.mjs
 *
 * ⚠️ ثلاثة تحذيرات قبل التشغيل:
 *
 * 1. يكتب صفوفاً حقيقية ثم ينظّفها بالوسم TAG (انظر آخر الملف).
 *
 * 2. يغيّر قيم app_settings مؤقتاً (رقم واتساب والحسابين) **ويعيدها
 *    كما كانت** في التنظيف. لو انقطع التشغيل في المنتصف فراجع
 *    صفحة الإعدادات في اللوحة.
 *
 * 3. 🔴 يشغّل مسح التذكيرات الحقيقي. المسح لا يرسل إلا لمن استحقّ
 *    فعلاً بإعداداته هو، أي أنه مكافئ تماماً لمسح دوري عادي —
 *    لكن قُلها كما هي: **مستخدم حقيقي حان وقت تذكيره قد يصله
 *    تذكيره أثناء هذا الاختبار.** وهو تذكيره الذي طلبه، ولا شيء
 *    غيره يُرسَل.
 *
 * ------------------------------------------------------------
 * ما لا يفحصه هذا الملف — يُقال هنا لا في آخر التقرير
 * ------------------------------------------------------------
 * • **نداء POST /api/plan نفسه غير مختبَر آلياً.** المسار معرَّف
 *   داخل index.js مباشرة لا في موجّه مستقل، فاستيراده يعني تشغيل
 *   الخادم كاملاً بفحص إقلاع المتصفّح؛ وتنفيذه يعني نداء مزوّد
 *   حقيقي بتكلفة ورد غير حتمي.
 *   فالمفحوص هنا هو **كل ما تحته**: قيود قاعدة البيانات التي
 *   تجعل الخطة الفارغة مستحيلة، وحارس الخطة الواحدة، ومسار
 *   القراءة، ومنع الوصول لخطة غيرك. والنداء نفسه يُختبر يدوياً
 *   على الإنتاج ويُكتب ناتجه كما هو.
 *
 * • **وصول إشعار Push إلى جهاز** — لا يُثبَت إلا بجهاز. المفحوص
 *   هنا أن صف الصندوق يُكتب مرة واحدة وأن اليوم يُعلَّم.
 */
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import zlib from "zlib";
import { query } from "./db/pool.js";
import { issueAccessToken } from "./auth/tokens.js";
import { userDataRouter, pushPublicKeyRouter } from "./userdata/routes.js";
import { adminRouter } from "./admin/routes.js";
import { adminSettingsRouter } from "./admin/settings.js";
import { sweepDailyReminders } from "./notifications/reminders.js";

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
app.use("/api", pushPublicKeyRouter);
app.use("/api/me", userDataRouter);
app.use("/admin", adminSettingsRouter);
app.use("/admin", adminRouter);

const server = app.listen(4586);
const B = "http://127.0.0.1:4586";

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
const patch = (p, b, o) => req("PATCH", p, b, o);
const put = (p, b, o) => req("PUT", p, b, o);
const del = (p, o) => req("DELETE", p, null, o);

/** رفع بايتات خام — الصورة لا تمرّ بـJSON. */
async function putRaw(path, buf, contentType, token = CURRENT_USER_TOKEN, extraHeaders = {}) {
  const headers = { "Content-Type": contentType, ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(B + path, { method: "PUT", headers, body: buf });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function getBinary(path, { asUser = null, ifNoneMatch = null } = {}) {
  const headers = {};
  if (path.startsWith("/admin")) {
    const c = adminCookie();
    if (c) headers.Cookie = c;
  }
  const token = asUser === null ? CURRENT_USER_TOKEN : asUser;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
  const r = await fetch(B + path, { headers });
  const buf = r.status === 200 ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
  return { status: r.status, etag: r.headers.get("etag"), type: r.headers.get("content-type"), buf };
}

function userToken(userId) {
  return issueAccessToken({ id: userId });
}

/* ---------------------------------------------------------
   صورة PNG حقيقية تُبنى هنا.

   ولا تُستورَد من ملف: الاختبار يجب أن يفحص أن الخادم يقرأ
   **البايتات**، وصورة مبنية بايتاً بايتاً تجعل الفحص عن الشيء
   نفسه لا عن ملف قد يُستبدل يوماً.
--------------------------------------------------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(width, height, padBytes = 0) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;   // عمق البت
  ihdrData[9] = 2;   // RGB
  const raw = Buffer.alloc(height * (1 + width * 3)); // أصفار = صورة سوداء
  const idat = zlib.deflateSync(raw);
  const chunks = [sig, pngChunk("IHDR", ihdrData), pngChunk("IDAT", idat)];
  if (padBytes > 0) {
    chunks.push(pngChunk("tEXt", Buffer.concat([Buffer.from("pad\0", "ascii"), Buffer.alloc(padBytes, 0x61)])));
  }
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

/* ---------------------------------------------------------
   بيانات الاختبار
--------------------------------------------------------- */
const TAG = `p6test_${crypto.randomBytes(4).toString("hex")}`;
const created = { users: [], admins: [] };

async function makeAdmin(role) {
  const { rows } = await query(
    `INSERT INTO admin_users (name, email, password_hash, role)
     VALUES ($1, $2, 'x', $3) RETURNING id, role`,
    [`${TAG}-${role}`, `${TAG}.${role}@example.com`, role]
  );
  created.admins.push(rows[0].id);
  return rows[0];
}

async function makeUser(suffix) {
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, email_verified_at)
     VALUES ($1, $2, 'x', now()) RETURNING id, email`,
    [`${TAG}-${suffix}`, `${TAG}.${suffix}@example.com`]
  );
  created.users.push(rows[0].id);
  return rows[0];
}

/* حفظ قيم الإعدادات الأصلية قبل المساس بها — هذه قيم إنتاج. */
const settingKeys = ["whatsapp_enabled", "whatsapp_number", "social_x_handle", "daily_reminder_time"];
const { rows: originalSettings } = await query(
  `SELECT key, value, updated_by FROM app_settings WHERE key = ANY($1::text[])`,
  [settingKeys]
);

/* ============================================================
   التشغيل
   ============================================================ */
const owner = await makeAdmin("owner");
const adminAcct = await makeAdmin("admin");
const support = await makeAdmin("support");

const alice = await makeUser("alice");
const bob = await makeUser("bob");
CURRENT_USER_TOKEN = userToken(alice.id);

/* ============================================================
   1) قائمة الدول
   ============================================================ */
{
  const r = await get("/api/countries");
  log("1-أ قائمة الدول تُقدَّم بلا مصادقة", r.status === 200, String(r.status));
  log("1-ب السعودية أول عنصر في القائمة", r.body.countries?.[0]?.code === "SA", r.body.countries?.[0]?.code);
  log("1-ج رمز اتصال السعودية 966", r.body.countries?.[0]?.dial === "966", r.body.countries?.[0]?.dial);
  log("1-د الدولة الافتراضية SA", r.body.defaultCountry === "SA", r.body.defaultCountry);
}

/* ============================================================
   2) الجوال السعودي — التحقق في الخادم لا في الواجهة
   ============================================================ */
{
  let r = await patch("/api/me/profile", { country: "SA", phone: { dial: "966", national: "51234567" } });
  log("2-أ ثمانية أرقام مرفوضة للسعودية", r.status === 400 && r.body.error === "invalid_saudi_phone", `${r.status} ${r.body.error}`);

  r = await patch("/api/me/profile", { country: "SA", phone: { dial: "966", national: "5123456789" } });
  log("2-ب عشرة أرقام مرفوضة للسعودية", r.status === 400 && r.body.error === "invalid_saudi_phone", `${r.status} ${r.body.error}`);

  r = await patch("/api/me/profile", { country: "SA", phone: { dial: "966", national: "412345678" } });
  log("2-ج تسعة أرقام لا تبدأ بـ5 مرفوضة", r.status === 400 && r.body.error === "invalid_saudi_phone", `${r.status} ${r.body.error}`);

  r = await patch("/api/me/profile", { country: "SA", phone: { dial: "966", national: "abcdefghi" } });
  log("2-د الأحرف مرفوضة (تُطبَّع فتصير فارغة)", r.status === 400, `${r.status} ${r.body.error}`);

  r = await patch("/api/me/profile", { country: "SA", phone: { dial: "966", national: "512345678" } });
  log("2-هـ تسعة أرقام تبدأ بـ5 مقبولة", r.status === 200, `${r.status} ${r.body.error || ""}`);

  const { rows } = await query(
    `SELECT country_code, phone_country_code, phone_national FROM user_profile WHERE user_id = $1`,
    [alice.id]
  );
  log("2-و الرقم مكتوب في قاعدة البيانات فعلاً",
    rows[0]?.phone_country_code === "966" && rows[0]?.phone_national === "512345678",
    JSON.stringify(rows[0] || null));

  r = await get("/api/me/profile");
  log("2-ز القراءة تعيد E.164 مشتقّاً", r.body.profile?.phone?.e164 === "+966512345678", r.body.profile?.phone?.e164);

  // الأرقام العربية-الهندية: يكتبها المستخدم من لوحة مفاتيح عربية.
  r = await patch("/api/me/profile", { phone: { dial: "٩٦٦", national: "٥٥٥٥٥٥٥٥٥" } });
  log("2-ح الأرقام العربية-الهندية تُطبَّع وتُقبل", r.status === 200 && r.body.profile?.phone?.national === "555555555",
    `${r.status} ${r.body.profile?.phone?.national}`);

  r = await patch("/api/me/profile", { country: "EG", phone: { dial: "966", national: "512345678" } });
  log("2-ط رمز اتصال لا يطابق الدولة مرفوض", r.status === 400 && r.body.error === "dial_country_mismatch", `${r.status} ${r.body.error}`);

  r = await patch("/api/me/profile", { country: "ZZ" });
  log("2-ي دولة غير مدعومة مرفوضة", r.status === 400 && r.body.error === "invalid_country", `${r.status} ${r.body.error}`);

  // إعادة الحالة إلى رقم سعودي صالح لبقية الاختبارات.
  await patch("/api/me/profile", { country: "SA", phone: { dial: "966", national: "512345678" } });
}

/* ============================================================
   3) الدولة والفئة العمرية والجنس — والاستمرار بعد "دخول جديد"
   ============================================================ */
{
  let r = await patch("/api/me/profile", { ageRange: "99-100" });
  log("3-أ فئة عمرية خارج القائمة مرفوضة", r.status === 400 && r.body.error === "invalid_age_range", `${r.status} ${r.body.error}`);

  r = await patch("/api/me/profile", { gender: "other" });
  log("3-ب قيمة جنس خارج القائمة مرفوضة", r.status === 400 && r.body.error === "invalid_gender", `${r.status} ${r.body.error}`);

  r = await patch("/api/me/profile", { ageRange: "30-40", gender: "female" });
  log("3-ج الفئة العمرية والجنس يُحفظان", r.status === 200, `${r.status} ${r.body.error || ""}`);

  const { rows } = await query(`SELECT age_range, gender FROM users WHERE id = $1`, [alice.id]);
  log("3-د مكتوبان في users لا في جدول موازٍ",
    rows[0]?.age_range === "30-40" && rows[0]?.gender === "female", JSON.stringify(rows[0]));

  /* "خروج ودخول": رمز جديد تماماً بلا أي حالة سابقة. لو كانت
     القيم في ذاكرة العملية أو في رد مخزَّن لظهر ذلك هنا. */
  const freshToken = userToken(alice.id);
  r = await get("/api/me/profile", { asUser: freshToken });
  const p = r.body.profile;
  log("3-هـ القيم كلها باقية برمز جلسة جديد",
    p?.ageRange === "30-40" && p?.gender === "female" && p?.country === "SA" && p?.phone?.national === "512345678",
    JSON.stringify({ a: p?.ageRange, g: p?.gender, c: p?.country, ph: p?.phone?.national }));

  r = await patch("/api/me/profile", { ageRange: "40-50", country: "AE", phone: { dial: "971", national: "501234567" } });
  const after = await get("/api/me/profile", { asUser: userToken(alice.id) });
  log("3-و التعديل يظهر بقيمه الجديدة بعد دخول جديد",
    after.body.profile?.ageRange === "40-50" && after.body.profile?.country === "AE",
    JSON.stringify({ a: after.body.profile?.ageRange, c: after.body.profile?.country }));

  r = await patch("/api/me/profile", { phone: null });
  log("3-ز إرسال null يمسح الرقم", r.status === 200 && r.body.profile?.phone === null, `${r.status} ${JSON.stringify(r.body.profile?.phone)}`);

  r = await patch("/api/me/profile", {});
  log("3-ح جسم بلا أي حقل يُرفض بدل أن يبدو ناجحاً", r.status === 400 && r.body.error === "nothing_to_update", `${r.status} ${r.body.error}`);

  /* الإسناد الجماعي: حقول ليست في القائمة البيضاء تُتجاهل تماماً.
     العنوان يقول "تُتجاهل" لا "تُرفض" — والسلوك المفحوص أن البريد
     وحالة التوثيق لا يتغيّران. */
  const before = await query(`SELECT email, email_verified_at FROM users WHERE id = $1`, [alice.id]);
  await patch("/api/me/profile", { ageRange: "30-40", email: "attacker@example.com", email_verified_at: null, id: bob.id });
  const afterMass = await query(`SELECT email, email_verified_at FROM users WHERE id = $1`, [alice.id]);
  log("3-ط حقول خارج القائمة البيضاء لا تُكتب (بريد وتوثيق)",
    afterMass.rows[0].email === before.rows[0].email && afterMass.rows[0].email_verified_at !== null,
    afterMass.rows[0].email);

  // إعادة السعودية لبقية الاختبارات.
  await patch("/api/me/profile", { country: "SA", phone: { dial: "966", national: "512345678" } });
}

/* ============================================================
   4) الصورة الشخصية
   ============================================================ */
let avatarEtag = null;
{
  const png = makePng(16, 16);
  let r = await putRaw("/api/me/avatar", png, "image/png");
  log("4-أ صورة PNG صالحة تُقبل", r.status === 200 && r.body.photo?.exists === true, `${r.status} ${r.body.error || ""}`);

  const { rows } = await query(`SELECT mime, byte_size, width, height, octet_length(bytes) AS real_size FROM user_avatars WHERE user_id = $1`, [alice.id]);
  log("4-ب البايتات مخزّنة والحجم المسجَّل يطابقها",
    rows[0] && Number(rows[0].byte_size) === Number(rows[0].real_size), JSON.stringify(rows[0] || null));
  log("4-ج الأبعاد مقروءة من البايتات لا من العميل",
    rows[0]?.width === 16 && rows[0]?.height === 16, `${rows[0]?.width}x${rows[0]?.height}`);

  /* ملف نصّي يعلن عن نفسه صورة. هذا هو الفحص الذي يفرّق بين
     الثقة بالامتداد والثقة بالمحتوى. */
  const fake = Buffer.from("<?php system($_GET['c']); ?>".padEnd(200, " "), "utf8");
  r = await putRaw("/api/me/avatar", fake, "image/png");
  log("4-د محتوى ليس صورة يُرفض رغم إعلانه image/png", r.status === 415, `${r.status} ${r.body.error || ""}`);

  const huge = makePng(8, 8, 600 * 1024);
  r = await putRaw("/api/me/avatar", huge, "image/png");
  log("4-هـ حجم فوق الحد يُرفض", r.status === 413, `${r.status} ${r.body.error || ""}`);

  r = await putRaw("/api/me/avatar", Buffer.from("hello"), "text/plain");
  log("4-و نوع محتوى خارج القائمة البيضاء لا يُقبل", r.status === 400 || r.status === 415, String(r.status));

  const g = await getBinary("/api/me/avatar");
  avatarEtag = g.etag;
  log("4-ز القراءة تعيد نفس البايتات ونوعها",
    g.status === 200 && g.type === "image/png" && g.buf.equals(png), `${g.status} ${g.type} ${g.buf.length}/${png.length}`);

  const g304 = await getBinary("/api/me/avatar", { ifNoneMatch: avatarEtag });
  log("4-ح النسخة نفسها تُردّ 304 بلا جسم", g304.status === 304, String(g304.status));

  const gBob = await getBinary("/api/me/avatar", { asUser: userToken(bob.id) });
  log("4-ط مستخدم آخر لا يرى صورة غيره على مساره", gBob.status === 404, String(gBob.status));
}

/* ============================================================
   5) الخطة — القيود ومسار القراءة

   ⚠️ العنوان يقول ما يفحصه: نداء POST /api/plan نفسه ليس هنا
   (السبب في رأس الملف). المفحوص ما تحته.
   ============================================================ */
{
  await query(
    `INSERT INTO user_plans (user_id, week, source, status, summary, focus_areas)
     VALUES ($1, 1, 'initial', 'active', 'ملخص اختبار', '[{"title":"أ","goal":"ب","small_step":"ج"}]'::jsonb)`,
    [alice.id]
  );

  let duplicateRejected = false;
  try {
    await query(
      `INSERT INTO user_plans (user_id, week, source, status, summary, focus_areas)
       VALUES ($1, 2, 'weekly_checkin', 'active', 'خطة ثانية', '[{"title":"أ","goal":"ب","small_step":"ج"}]'::jsonb)`,
      [alice.id]
    );
  } catch (err) {
    duplicateRejected = err.code === "23505";
  }
  log("5-أ خطة نشطة ثانية مستحيلة على مستوى القاعدة", duplicateRejected, "");

  let emptyRejected = false;
  try {
    await query(
      `INSERT INTO user_plans (user_id, week, source, status, summary, focus_areas)
       VALUES ($1, 1, 'initial', 'active', 'رد بلا مجالات', '[]'::jsonb)`,
      [bob.id]
    );
  } catch (err) {
    emptyRejected = err.code === "23514"; // انتهاك CHECK
  }
  log("5-ب خطة بلا مجالات تركيز مرفوضة (وهذا ما يمنع كتابة رد الأزمة خطةً)", emptyRejected, "");

  let r = await get("/api/me/plans");
  log("5-ج صاحب الخطة يقرؤها كاملة", r.status === 200 && r.body.active?.summary === "ملخص اختبار", `${r.status}`);

  r = await get("/api/me/plans", { asUser: userToken(bob.id) });
  log("5-د مستخدم آخر لا يرى خطة غيره", r.status === 200 && r.body.active === null, JSON.stringify(r.body.active));
}

/* ============================================================
   6) التذكير اليومي — التفضيل والجدولة والمسح
   ============================================================ */
{
  let r = await patch("/api/me/preferences", { reminderTime: "25:00" });
  log("6-أ وقت غير صالح مرفوض", r.status === 400 && r.body.error === "invalid_reminder_time", `${r.status} ${r.body.error}`);

  r = await patch("/api/me/preferences", { reminderTimezone: "Mars/Olympus" });
  log("6-ب منطقة زمنية غير معروفة مرفوضة", r.status === 400 && r.body.error === "invalid_timezone", `${r.status} ${r.body.error}`);

  r = await patch("/api/me/preferences", { remindersOn: true, reminderTime: "20:00", reminderTimezone: "Asia/Riyadh" });
  log("6-ج التفعيل يُحفظ ويعيد الجدولة", r.status === 200 && r.body.reminders_on === true && r.body.reminder?.localTime === "20:00",
    JSON.stringify(r.body.reminder));

  const { rows: uRows } = await query(`SELECT reminders_on FROM users WHERE id = $1`, [alice.id]);
  log("6-د مفتاح التشغيل مكتوب في users.reminders_on", uRows[0].reminders_on === true, String(uRows[0].reminders_on));

  const { rows: pRows } = await query(`SELECT local_time, timezone FROM user_reminder_prefs WHERE user_id = $1`, [alice.id]);
  log("6-هـ صف الجدولة أُنشئ بالوقت والمنطقة", !!pRows[0] && pRows[0].timezone === "Asia/Riyadh", JSON.stringify(pRows[0] || null));

  const fresh = await get("/api/me/profile", { asUser: userToken(alice.id) });
  log("6-و التفضيل باقٍ برمز جلسة جديد", fresh.body.profile?.reminder?.enabled === true, JSON.stringify(fresh.body.profile?.reminder));

  /* استحقاق حقيقي: نضع وقت أليس قبل نصف ساعة بتوقيت UTC ونشغّل
     المسح الحقيقي. */
  await query(
    `UPDATE user_reminder_prefs
     SET timezone = 'UTC',
         local_time = ((now() AT TIME ZONE 'UTC') - interval '30 minutes')::time,
         last_sent_on = NULL
     WHERE user_id = $1`,
    [alice.id]
  );
  await query(`DELETE FROM daily_logs WHERE user_id = $1`, [alice.id]);

  await sweepDailyReminders();
  const { rows: n1 } = await query(
    `SELECT count(*)::int AS n FROM user_notifications WHERE user_id = $1 AND dedup_key LIKE 'daily_checkin:%'`,
    [alice.id]
  );
  log("6-ز المسح يكتب تذكيراً واحداً في صندوق المستحقّ", n1[0].n === 1, String(n1[0].n));

  const { rows: sent } = await query(`SELECT last_sent_on FROM user_reminder_prefs WHERE user_id = $1`, [alice.id]);
  log("6-ح اليوم يُعلَّم بعد الإرسال", sent[0].last_sent_on !== null, String(sent[0].last_sent_on));

  await sweepDailyReminders();
  const { rows: n2 } = await query(
    `SELECT count(*)::int AS n FROM user_notifications WHERE user_id = $1 AND dedup_key LIKE 'daily_checkin:%'`,
    [alice.id]
  );
  log("6-ط مسح ثانٍ لا يكرّر التذكير", n2[0].n === 1, String(n2[0].n));

  /* من سجّل يومه لا يُذكَّر: نُعيد استحقاق بوب، ونسجّل له يومية. */
  await query(`UPDATE users SET reminders_on = true WHERE id = $1`, [bob.id]);
  await query(
    `INSERT INTO user_reminder_prefs (user_id, local_time, timezone, last_sent_on)
     VALUES ($1, ((now() AT TIME ZONE 'UTC') - interval '30 minutes')::time, 'UTC', NULL)
     ON CONFLICT (user_id) DO UPDATE SET local_time = EXCLUDED.local_time, timezone = 'UTC', last_sent_on = NULL`,
    [bob.id]
  );
  await query(
    `INSERT INTO daily_logs (user_id, mood, sleep, energy, logged_on)
     VALUES ($1, 5, 5, 5, (now() AT TIME ZONE 'UTC')::date)
     ON CONFLICT (user_id, logged_on) DO NOTHING`,
    [bob.id]
  );
  await sweepDailyReminders();
  const { rows: n3 } = await query(
    `SELECT count(*)::int AS n FROM user_notifications WHERE user_id = $1 AND dedup_key LIKE 'daily_checkin:%'`,
    [bob.id]
  );
  log("6-ي من سجّل يومه لا يصله تذكير به", n3[0].n === 0, String(n3[0].n));

  r = await patch("/api/me/preferences", { remindersOn: false });
  const off = await get("/api/me/profile", { asUser: userToken(alice.id) });
  log("6-ك الإطفاء يبقى مطفأً بعد دخول جديد", off.body.profile?.reminder?.enabled === false, String(off.body.profile?.reminder?.enabled));
}

/* ============================================================
   7) مزامنة اللوحة — نفس مصدر الحقيقة
   ============================================================ */
{
  CURRENT_ADMIN = owner;
  let r = await get(`/admin/users/${alice.id}`);
  log("7-أ المالك يرى رقم الجوال", r.body.phone === "+966512345678", String(r.body.phone));
  log("7-ب المالك يرى الدولة", r.body.country === "SA", String(r.body.country));
  log("7-ج اللوحة ترى الفئة العمرية والجنس المحفوظين",
    r.body.age_range === "40-50" && r.body.gender === "female", `${r.body.age_range} / ${r.body.gender}`);
  log("7-د وجود الصورة معلَن في صفحة المستخدم", r.body.has_photo === true, String(r.body.has_photo));
  log("7-هـ وجود خطة معلَن بلا أي محتوى منها",
    r.body.has_active_plan === true && !("summary" in r.body) && !("focus_areas" in r.body),
    JSON.stringify({ has: r.body.has_active_plan, keys: Object.keys(r.body).filter((k) => k.includes("summary") || k.includes("focus")) }));
  log("7-و حالة التذكير ظاهرة للإدارة", "reminder_local_time" in r.body, JSON.stringify(r.body.reminder_local_time));

  const g = await getBinary(`/admin/users/${alice.id}/avatar`);
  log("7-ز صورة المستخدم تُعرض في اللوحة من نفس المصدر", g.status === 200 && g.type === "image/png", `${g.status} ${g.type}`);

  CURRENT_ADMIN = adminAcct;
  r = await get(`/admin/users/${alice.id}`);
  log("7-ح المدير يفتح صفحة المستخدم", r.status === 200, String(r.status));
  log("7-ط المدير لا يرى الجوال — الحقل غائب لا فارغ", !("phone" in r.body), JSON.stringify(r.body.phone ?? "absent"));

  CURRENT_ADMIN = support;
  r = await get(`/admin/users/${alice.id}`);
  log("7-ي الدعم لا يرى الجوال", r.status === 200 && !("phone" in r.body), `${r.status}`);
}

/* ============================================================
   8) حالة الاشتراك — الفعلية لا المخزّنة
   ============================================================ */
{
  await query(
    `INSERT INTO subscriptions (user_id, plan_id, status, started_at, current_period_end)
     VALUES ($1, 'monthly', 'active', now() - interval '60 days', now() - interval '30 days')`,
    [bob.id]
  );

  CURRENT_ADMIN = owner;
  let r = await get(`/admin/users/${bob.id}`);
  log("8-أ اشتراك انتهت مدته يظهر منتهياً لا نشطاً", r.body.subscription_status === "expired", String(r.body.subscription_status));
  log("8-ب والعمود المخزّن يبقى معروضاً للتشخيص", r.body.subscription_stored_status === "active", String(r.body.subscription_stored_status));

  r = await get(`/admin/users?search=${encodeURIComponent(TAG + "-bob")}&subscription=active`);
  log("8-ج فلتر «مشترك نشط» لا يعدّ المنتهي", r.body.total === 0, String(r.body.total));

  r = await get(`/admin/users?search=${encodeURIComponent(TAG + "-bob")}&subscription=none`);
  log("8-د فلتر «بلا اشتراك» يشمله", r.body.total === 1, String(r.body.total));

  r = await get(`/admin/users?search=${encodeURIComponent(TAG + "-alice")}&subscription=none`);
  log("8-هـ ومن لا اشتراك له أصلاً يظهر في «بلا اشتراك»", r.body.total === 1, String(r.body.total));

  r = await get(`/admin/users?search=${encodeURIComponent(TAG + "-alice")}`);
  log("8-و القائمة تعلن وجود الصورة", r.body.users?.[0]?.has_photo === true, String(r.body.users?.[0]?.has_photo));
}

/* ============================================================
   9) إعدادات واتساب — الصلاحية والتحقق والتطبيع
   ============================================================ */
{
  CURRENT_ADMIN = null;
  let r = await put("/admin/app-settings/whatsapp_enabled", { value: true, reason: "اختبار" });
  log("9-أ بلا جلسة إدارة: مرفوض", r.status === 401 || r.status === 403, String(r.status));

  CURRENT_ADMIN = adminAcct;
  r = await put("/admin/app-settings/whatsapp_enabled", { value: true, reason: "اختبار" });
  log("9-ب المدير لا يملك تعديل إعدادات التشغيل", r.status === 403, String(r.status));

  CURRENT_ADMIN = owner;
  r = await put("/admin/app-settings/whatsapp_number", { value: "+966 55 123 4567", reason: "اختبار المرحلة 6" });
  log("9-ج الرقم يُطبَّع إلى أرقام مجرّدة عند الحفظ", r.status === 200 && r.body.setting?.value === "966551234567",
    `${r.status} ${JSON.stringify(r.body.setting?.value)}`);

  r = await put("/admin/app-settings/whatsapp_number", { value: "12345", reason: "اختبار" });
  log("9-د رقم قصير مرفوض", r.status === 400 && r.body.error === "invalid_whatsapp_number", `${r.status} ${r.body.error}`);

  r = await put("/admin/app-settings/whatsapp_number", { value: null, reason: "اختبار المسح" });
  log("9-هـ null يمسح الرقم", r.status === 200 && r.body.setting?.value === null, `${r.status} ${JSON.stringify(r.body.setting?.value)}`);

  r = await put("/admin/app-settings/social_x_handle", { value: "x.com/evil", reason: "اختبار" });
  log("9-و معرّف حساب يحوي محارف رابط مرفوض", r.status === 400 && r.body.error === "invalid_handle", `${r.status} ${r.body.error}`);

  r = await put("/admin/app-settings/social_x_handle", { value: "KANAFme", reason: "اختبار" });
  log("9-ز المعرّف يُطبَّع بـ@ واحدة", r.status === 200 && r.body.setting?.value === "@KANAFme", JSON.stringify(r.body.setting?.value));

  r = await put("/admin/app-settings/daily_reminder_time", { value: "8 مساءً", reason: "اختبار" });
  log("9-ح وقت بصيغة غير HH:MM مرفوض", r.status === 400 && r.body.error === "invalid_time_format", `${r.status} ${r.body.error}`);

  r = await put("/admin/app-settings/made_up_key", { value: "x", reason: "اختبار" });
  log("9-ط مفتاح غير مسجَّل مرفوض", r.status === 404, String(r.status));
}

/* ============================================================
   النتيجة
   ============================================================ */
const pass = results.filter((r) => r[1]).length;
console.log("\n=== اختبارات المرحلة 6 — الملف الشخصي والصورة والخطة والتذكير والمزامنة ===\n");
for (const [label, ok, extra] of results) {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra && !ok ? `  (${extra})` : ""}`);
}
console.log(`\n${pass}/${results.length} نجحت\n`);

/* ------------------------------------------------------------
   التنظيف

   حذف المستخدم يجرّ معه user_profile و user_avatars و user_plans
   و user_reminder_prefs و daily_logs و user_notifications
   و subscriptions عبر ON DELETE CASCADE. وسجلا التدقيق أولاً
   لأنهما يشيران إلى الحسابين بمفتاح أجنبي.

   وإعدادات app_settings تُعاد إلى قيمها الأصلية المحفوظة في أول
   الملف — هذه قيم إنتاج، وتركها على قيم اختبار كان سيغيّر ما
   يراه المستخدم.
   ------------------------------------------------------------ */
for (const s of originalSettings) {
  await query(
    `UPDATE app_settings SET value = $2::jsonb, updated_by = $3, updated_at = now() WHERE key = $1`,
    [s.key, JSON.stringify(s.value), s.updated_by]
  );
}

await query(`DELETE FROM subscription_state WHERE user_id = ANY($1::uuid[])`, [created.users]);
await query(`DELETE FROM admin_action_log WHERE admin_user_id = ANY($1::uuid[]) OR target_user_id = ANY($2::uuid[])`, [created.admins, created.users]);
await query(`DELETE FROM admin_access_log WHERE admin_user_id = ANY($1::uuid[]) OR target_user_id = ANY($2::uuid[])`, [created.admins, created.users]);
await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [created.users]);
await query(`DELETE FROM admin_users WHERE id = ANY($1::uuid[])`, [created.admins]);

server.close();
process.exit(pass === results.length ? 0 : 1);
