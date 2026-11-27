import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0022 القسم ب — «واجهة الموقع» والنقطتان العامتان.
 *
 * الخادم الكامل (index.js) على قاعدة معزولة، فيُختبر هنا ما يمرّ به
 * الطلب فعلاً: CORS العام وتنحّيه عن /api/public، والمحدِّد العام
 * وتخطّيه، ومحدِّد النقطتين، ومصادقة اللوحة والسبب التلقائي.
 *
 *  K) ب-1 المفاتيح وتسامح القراءة: قبل أي مفتاح، وفارغة، ومملوءة
 *  V) ب-2 التحقق: javascript: وdata: وhttp: وأطول من 300 وبريد غير صالح…
 *  P) ب-3 النقطتان: النوع، والتخزين، وCORS، و405، ولا بيانات مستخدم ولا سرّ
 *  T) ب-1 النصّان: نصّ لا ملف، و60000، والوقت يضبطه الخادم وحده
 *  A) ب-4 اللوحة: RBAC، والسجل، والسبب التلقائي، وعدم المسّ بمفتاح قائم
 *  F) ب-3 503 سريع عند عطل القاعدة
 *  L) ب-3 حدّ المعدّل لكل عنوان
 */
requireDedicatedDatabase(import.meta.url);
import jwt from "jsonwebtoken";

process.env.PORT = "4655";
process.env.SKIP_PDF_BOOT_CHECK = "1";
process.env.ALLOWED_ORIGINS = "http://127.0.0.1:5173";
process.env.TRUST_PROXY_HOPS = "2";
const logs = []; const rl = console.log, re = console.error, rw = console.warn;
console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
const SF = await import("./admin/site-front.js");
await new Promise((r) => setTimeout(r, 300));
const B = "http://127.0.0.1:4655";
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const EDGE = "162.158.1.1";
let ipSeq = 10;
const freshIp = () => `198.51.100.${ipSeq++}`;
let IP = freshIp();

async function call(method, path, { body, cookie, origin, xff } = {}) {
  const h = {};
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (cookie) h.Cookie = cookie;
  if (origin) h.Origin = origin;
  h["X-Forwarded-For"] = `${xff || IP}, ${EDGE}`;
  const t0 = Date.now();
  const r = await fetch(B + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ }
  return { status: r.status, body: json, raw, headers: r.headers, ms: Date.now() - t0 };
}
const ALL12 = [...SF.LANDING_KEYS, ...SF.LEGAL_KEYS];
const allEmpty = (o, keys) => keys.every((k) => o[k] === "") && Object.keys(o).length === keys.length;
const exactKeys = (o, keys) => JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());

try {
  const mk = async (role) => {
    const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ($1,$2,'x',$3) RETURNING id`, [`sf ${role}`, `sf-${role}-${Math.random()}@kanaf.test`, role]);
    return { id: a.id, cookie: `kanaf_admin_access=${jwt.sign({ sub: a.id, role, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}` };
  };
  const owner = await mk("owner"), admin = await mk("admin"), support = await mk("support");

  /* ================= K) المفاتيح وتسامح القراءة ================= */
  ok("K0 ثمانية مفاتيح للرئيسية وأربعة للقانونيتين بأسمائها الثابتة",
    JSON.stringify(SF.LANDING_KEYS) === JSON.stringify(["app_store_url", "google_play_url", "x_url", "instagram_url", "whatsapp_url", "tiktok_url", "snapchat_url", "contact_email"])
    && JSON.stringify(SF.LEGAL_KEYS) === JSON.stringify(["privacy_text", "privacy_text_updated_at", "terms_text", "terms_text_updated_at"]));

  // ما في القاعدة المعزولة قبل أي حفظ: مفتاحا المتجر من الهجرة 020 بقيمة null، والعشرة غائبة.
  const { rows: pre } = await query(`SELECT key, value FROM app_settings WHERE key = ANY($1) ORDER BY key`, [ALL12]);
  const settingsBefore = (await query(`SELECT key, value::text v, category, updated_at FROM app_settings WHERE NOT (key = ANY($1)) ORDER BY key`, [ALL12])).rows;
  const taxBefore = (await query(`SELECT * FROM tax_settings ORDER BY 1`).catch(() => ({ rows: ["(no table)"] }))).rows;
  let r = await call("GET", "/api/public/landing");
  let r2 = await call("GET", "/api/public/legal");
  ok(`K1 قبل أي حفظ (${pre.length} مفتاح موجود، كلها null): landing ثمانية مفاتيح فارغة`, r.status === 200 && allEmpty(r.body, SF.LANDING_KEYS), r.raw);
  ok("K2 قبل أي حفظ: legal أربعة مفاتيح فارغة", r2.status === 200 && allEmpty(r2.body, SF.LEGAL_KEYS), r2.raw);
  ok("K3 الردّ قبل أي حفظ بالحرف", r.raw === JSON.stringify(Object.fromEntries(SF.LANDING_KEYS.map((k) => [k, ""]))), r.raw);

  // ولا مفتاح أصلاً (ولا صفّا الهجرة): لا رمي، فارغ.
  await query(`DELETE FROM app_settings WHERE key = ANY($1)`, [ALL12]);
  r = await call("GET", "/api/public/landing"); r2 = await call("GET", "/api/public/legal");
  ok("K4 بلا أي صفّ من الاثني عشر: 200 وفارغة ولا رمي", r.status === 200 && allEmpty(r.body, SF.LANDING_KEYS) && r2.status === 200 && allEmpty(r2.body, SF.LEGAL_KEYS), r.raw + r2.raw);
  // قيم غير نصية مخزّنة يدوياً (رقم، كائن JSON null) لا تُسقط القراءة
  await query(`INSERT INTO app_settings (key, value, category) VALUES ('x_url','null'::jsonb,'general'), ('tiktok_url','""'::jsonb,'general')`);
  r = await call("GET", "/api/public/landing");
  ok("K5 null وسلسلة فارغة مخزّنتان تُقرآن \"\"", r.status === 200 && r.body.x_url === "" && r.body.tiktok_url === "", r.raw);
  await query(`DELETE FROM app_settings WHERE key = ANY($1)`, [ALL12]);
  await query(`INSERT INTO app_settings (key, value, category, description) VALUES
    ('app_store_url','null'::jsonb,'general','رابط التطبيق في App Store (apps.apple.com). فارغ = الزر مخفيّ'),
    ('google_play_url','null'::jsonb,'general','رابط التطبيق في Google Play (play.google.com). فارغ = الزر مخفيّ')`);

  /* ================= P) النقطتان ================= */
  r = await call("GET", "/api/public/landing", { origin: "https://tanfs.net" });
  ok("P1 application/json", /^application\/json/.test(r.headers.get("content-type") || ""), r.headers.get("content-type"));
  ok("P2 Cache-Control: public, max-age=300", r.headers.get("cache-control") === "public, max-age=300", r.headers.get("cache-control"));
  ok("P3 CORS لـhttps://tanfs.net بالأصل نفسه", r.headers.get("access-control-allow-origin") === "https://tanfs.net", r.headers.get("access-control-allow-origin"));
  ok("P4 لا credentials ولا كعكة", !r.headers.get("access-control-allow-credentials") && !r.headers.get("set-cookie"), `${r.headers.get("access-control-allow-credentials")} ${r.headers.get("set-cookie")}`);
  ok("P5 Vary: Origin", /origin/i.test(r.headers.get("vary") || ""), r.headers.get("vary"));
  r = await call("GET", "/api/public/legal", { origin: "https://www.tanfs.net" });
  ok("P6 CORS لـhttps://www.tanfs.net", r.status === 200 && r.headers.get("access-control-allow-origin") === "https://www.tanfs.net", r.headers.get("access-control-allow-origin"));
  const bad = ["https://evil.example", "http://tanfs.net", "https://tanfs.net.evil.example", "https://sub.tanfs.net", "null", "http://127.0.0.1:5173"];
  const leaks = [];
  for (const o of bad) { const x = await call("GET", "/api/public/landing", { origin: o }); if (x.headers.get("access-control-allow-origin") || x.status !== 200) leaks.push(`${o}→${x.status}/${x.headers.get("access-control-allow-origin")}`); }
  ok(`P7 أصل غير مسموح (${bad.length} حالات، منها أصل اللوحة نفسه): بلا Access-Control-Allow-Origin`, leaks.length === 0, leaks.join(" "));
  r = await call("GET", "/api/public/landing");
  ok("P8 لا `*` في أي ردّ", r.headers.get("access-control-allow-origin") !== "*" && !r.raw.includes("Access-Control"), r.headers.get("access-control-allow-origin"));
  const methods = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
  const m405 = [];
  for (const m of methods) for (const p of ["/api/public/landing", "/api/public/legal"]) {
    const x = await call(m, p, { origin: "https://tanfs.net", body: m === "OPTIONS" || m === "DELETE" ? undefined : { app_store_url: "https://x" } });
    if (x.status !== 405 || x.headers.get("allow") !== "GET") m405.push(`${m} ${p}→${x.status} allow=${x.headers.get("allow")}`);
  }
  ok("P9 كل طريقة غير GET (POST وPUT وPATCH وDELETE وOPTIONS) ← 405 وAllow: GET", m405.length === 0, m405.join(" | "));
  r = await call("POST", "/api/public/landing", { body: { x_url: "https://x.com/evil" } });
  const { rows: [{ n: postWrote }] } = await query(`SELECT count(*)::int n FROM app_settings WHERE key='x_url'`);
  ok("P10 POST لا يكتب شيئاً", r.status === 405 && postWrote === 0, String(postWrote));
  r = await call("GET", "/api/public/landing", { cookie: owner.cookie });
  ok("P11 كعكة المدير لا تغيّر الردّ (لا مصادقة ولا بيانات حساب)", r.status === 200 && exactKeys(r.body, SF.LANDING_KEYS), r.raw);
  r = await call("GET", "/api/public/other");
  ok("P12 لا مسار عام آخر تحت /api/public", r.status === 404, String(r.status));

  /* ================= A) اللوحة: قراءة وRBAC ================= */
  r = await call("GET", "/admin/site-front", { cookie: owner.cookie });
  ok("A1 المالك يقرأ: القيم الاثنتا عشرة فارغة وcanEdit", r.status === 200 && allEmpty(r.body.values, ALL12) && r.body.canEdit === true && r.body.limits.urlMax === 300 && r.body.limits.textMax === 60000, r.raw.slice(0, 300));
  r = await call("GET", "/admin/site-front", { cookie: admin.cookie });
  ok("A2 المدير (app_settings:view بلا edit) يقرأ للعرض فقط", r.status === 200 && r.body.canEdit === false, r.raw.slice(0, 200));
  r = await call("PUT", "/admin/site-front", { cookie: admin.cookie, body: { values: { x_url: "https://x.com/a" } } });
  ok("A3 المدير لا يحفظ ← 403", r.status === 403, `${r.status} ${r.raw}`);
  r = await call("GET", "/admin/site-front", { cookie: support.cookie });
  ok("A4 الدعم (بلا app_settings:view) ← 403", r.status === 403, String(r.status));
  r = await call("GET", "/admin/site-front");
  ok("A5 بلا جلسة ← 401", r.status === 401, String(r.status));

  /* ================= V) التحقق ================= */
  const reject = async (key, value, code) => {
    const x = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: { values: { [key]: value } } });
    const f = x.body.fields?.[key];
    return { pass: x.status === 400 && x.body.error === "site_front_invalid" && f?.code === code && f.message.includes(SF.FIELD_LABEL[key]), got: `${x.status} ${JSON.stringify(x.body).slice(0, 200)}` };
  };
  const cases = [
    ["x_url", "javascript:alert(1)", "site_front_url_must_be_https"],
    ["instagram_url", "JavaScript:alert(document.cookie)", "site_front_url_must_be_https"],
    ["whatsapp_url", "data:text/html,<script>alert(1)</script>", "site_front_url_must_be_https"],
    ["tiktok_url", "http://www.tiktok.com/@tanfs", "site_front_url_must_be_https"],
    ["snapchat_url", "//snapchat.com/add/tanfs", "site_front_url_must_be_https"],
    ["x_url", "https://" + "a".repeat(290) + ".com", "site_front_url_too_long"],
    ["x_url", "https://", "site_front_url_invalid"],
    ["x_url", "https://user:pass@x.com/a", "site_front_url_invalid"],
    ["instagram_url", " https://instagram.com/a b", "site_front_url_invalid"],
    ["app_store_url", "https://evil.example/app", "site_front_url_host_not_allowed"],
    ["google_play_url", "https://apps.apple.com/app/id1", "site_front_url_host_not_allowed"],
    ["contact_email", "not-an-email", "site_front_email_invalid"],
    ["contact_email", "a@b", "site_front_email_invalid"],
    ["contact_email", "a b@c.com", "site_front_email_invalid"],
    ["contact_email", "<script>@x.com", "site_front_email_invalid"],
    ["x_url", 12345, "site_front_value_must_be_string"],
    ["privacy_text", ["مصفوفة"], "site_front_value_must_be_string"],
    ["instagram_url", "https://instagram.com/a\"onmouseover=\"x", "site_front_url_invalid"],
    ["x_url", "https://x.com/<b>", "site_front_url_invalid"],
    ["privacy_text_updated_at", "2020-01-01T00:00:00.000Z", "site_front_field_not_editable"],
    ["terms_text_updated_at", "", "site_front_field_not_editable"],
  ];
  const vfail = [];
  for (const [k, v, c] of cases) { const x = await reject(k, v, c); if (!x.pass) vfail.push(`${k}=${String(v).slice(0, 30)} → ${x.got}`); }
  ok(`V1 🔴 ${cases.length} قيمة مرفوضة برمزها ورسالة عربية تسمّي الحقل (javascript: وdata: وhttp: و>300 وبريد غير صالح ووقت مُرسل…)`, vfail.length === 0, vfail.join(" | "));
  const codes = [...new Set(cases.map((c) => c[2])), "site_front_text_too_long", "site_front_unknown_field", "site_front_invalid"];
  const { ERROR_AR } = await import("./admin-src/src/errors.js");
  ok("V2 كل رمز رفض له نصّ في خريطة أخطاء اللوحة", codes.every((c) => ERROR_AR[c]), codes.filter((c) => !ERROR_AR[c]).join(" "));
  r = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: { values: { secret_key: "x", x_url: "https://x.com/a" } } });
  ok("V3 مفتاح غير معروف يُرفض ولا يُحفظ معه شيء", r.status === 400 && r.body.fields?.secret_key?.code === "site_front_unknown_field" && !r.body.fields?.x_url, r.raw.slice(0, 200));
  r = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: { values: { x_url: "https://x.com/ok", instagram_url: "javascript:1", contact_email: "bad" } } });
  const { rows: [{ n: partial }] } = await query(`SELECT count(*)::int n FROM app_settings WHERE key = ANY($1)`, [ALL12]);
  ok("V4 حقلان خاطئان مع صحيح: خطأ كل حقل في مكانه، ولا يُحفظ الصحيح وحده", r.status === 400 && r.body.fields.instagram_url && r.body.fields.contact_email && !r.body.fields.x_url && partial === 2, `${partial} ${r.raw.slice(0, 200)}`);
  r = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: { values: { x_url: "https://" + "a".repeat(288) + ".com" } } });
  ok("V5 رابط من 300 حرف بالضبط مقبول", r.status === 200 && r.body.values.x_url.length === 300, `${r.status} ${r.raw.slice(0, 120)}`);
  r = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: {} });
  ok("V6 طلب بلا values ← 400 values_required", r.status === 400 && r.body.error === "values_required", r.raw);

  /* ================= مملوءة ================= */
  const filled = {
    app_store_url: "https://apps.apple.com/sa/app/tanfs/id6700000000",
    google_play_url: "https://play.google.com/store/apps/details?id=net.tanfs.app",
    x_url: "https://x.com/tanfs", instagram_url: "https://www.instagram.com/tanfs/",
    whatsapp_url: "https://wa.me/966500000000", tiktok_url: "https://www.tiktok.com/@tanfs",
    snapchat_url: "https://www.snapchat.com/add/tanfs", contact_email: "hello@tanfs.net",
    privacy_text: "## سياسة الخصوصية\n\n- لا نبيع بياناتك.\n- <script>alert('x')</script> يبقى نصاً.\n\nفقرة.",
    terms_text: "## شروط الاستخدام\n\nنصّ الشروط.",
  };
  const t0 = new Date(Date.now() - 1000);
  r = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: { values: filled } });
  ok("F0 حفظ القيم كلها بزرّ واحد", r.status === 200 && r.body.changed.length === 10, `${r.status} ${r.raw.slice(0, 300)}`);
  const pStamp = r.body.values?.privacy_text_updated_at, tStamp = r.body.values?.terms_text_updated_at;
  ok("T1 وقت آخر تعديل يضبطه الخادم حين يتغيّر النصّ (ISO UTC)", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(pStamp) && new Date(pStamp) >= t0 && new Date(tStamp) >= t0, `${pStamp} ${tStamp}`);
  r = await call("GET", "/api/public/landing", { origin: "https://tanfs.net" });
  ok("F1 landing مملوءة بالحرف، ثمانية مفاتيح لا غير", r.status === 200 && exactKeys(r.body, SF.LANDING_KEYS) && SF.LANDING_KEYS.every((k) => r.body[k] === filled[k]), r.raw);
  r2 = await call("GET", "/api/public/legal", { origin: "https://tanfs.net" });
  ok("F2 legal مملوءة، أربعة مفاتيح لا غير", r2.status === 200 && exactKeys(r2.body, SF.LEGAL_KEYS) && r2.body.privacy_text === filled.privacy_text && r2.body.terms_text === filled.terms_text && r2.body.privacy_text_updated_at === pStamp, r2.raw.slice(0, 300));
  ok("T2 <script> مخزّن نصاً ويخرج سلسلة JSON كما هو (لا تنفيذ في الخادم ولا رابط سكربت)", typeof r2.body.privacy_text === "string" && r2.body.privacy_text.includes("<script>alert('x')</script>") && /^application\/json/.test(r2.headers.get("content-type")), r2.headers.get("content-type"));
  const { rows: stored } = await query(`SELECT key, jsonb_typeof(value) t, category FROM app_settings WHERE key = ANY($1)`, [ALL12]);
  ok("T3 كل قيمة مخزّنة سلسلة JSON في app_settings (فئة general)", stored.length === 12 && stored.every((s) => s.t === "string" && s.category === "general"), JSON.stringify(stored));

  // الصفحة العامة: لا شيء غير مفاتيحها — لا بيانات مستخدم ولا سرّ ولا مدير
  const pubRaw = (await call("GET", "/api/public/landing")).raw + (await call("GET", "/api/public/legal")).raw;
  const secrets = ["ADMIN_JWT_SECRET", "JWT_SECRET", "DATABASE_URL", "TEST_DATABASE_URL"].map((k) => process.env[k]).filter((v) => v && v.length > 6);
  const { rows: users } = await query(`SELECT email FROM admin_users`);
  ok("P13 لا سرّ ولا بريد مدير ولا updated_by في الردّين", secrets.every((s) => !pubRaw.includes(s)) && users.every((u) => !pubRaw.includes(u.email)) && !/updated_by|admin|password|token/i.test(pubRaw), "");

  // تغيير نصّ واحد: وقته وحده يتقدّم
  await new Promise((s) => setTimeout(s, 20));
  r = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: { values: { ...filled, terms_text: filled.terms_text + "\n- بند." } } });
  ok("T4 تغيير الشروط وحدها: وقتها يتقدّم ووقت الخصوصية ثابت، وchanged = [terms_text]",
    r.status === 200 && JSON.stringify(r.body.changed) === '["terms_text"]' && r.body.values.privacy_text_updated_at === pStamp && r.body.values.terms_text_updated_at > tStamp, r.raw.slice(0, 200));
  r = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: { values: filled.x_url ? { x_url: filled.x_url } : {} } });
  ok("T5 حفظ بلا تغيير: changed فارغة ولا سطر في السجل", r.status === 200 && r.body.changed.length === 0, r.raw.slice(0, 120));

  // 60000
  r = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: { values: { privacy_text: "ن".repeat(60000) } } });
  ok("T6 نصّ من 60000 حرف بالضبط مقبول", r.status === 200 && r.body.values.privacy_text.length === 60000, `${r.status}`);
  r = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: { values: { privacy_text: "ن".repeat(60001) } } });
  ok("T7 60001 حرف ← site_front_text_too_long", r.status === 400 && r.body.fields?.privacy_text?.code === "site_front_text_too_long", `${r.status} ${r.raw.slice(0, 160)}`);
  // إفراغ: يُحفظ فارغاً ويعود "" للصفحة (فتعود إلى نصّها المدفون)
  r = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: { values: { privacy_text: filled.privacy_text, terms_text: "" } } });
  r2 = await call("GET", "/api/public/legal");
  ok("T8 إفراغ نصّ مقبول ويقرأ \"\" في النقطة العامة", r.status === 200 && r2.body.terms_text === "" && r2.body.privacy_text === filled.privacy_text, r2.raw.slice(0, 120));
  r = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: { values: { x_url: "" } } });
  r = await call("PUT", "/admin/site-front", { cookie: owner.cookie, body: { values: { instagram_url: null } } });
  ok("V8 null يُعامل فراغاً (لا رمي)", r.status === 200 && r.body.values.instagram_url === "", r.raw.slice(0, 100));
  ok("V7 رابط فارغ مقبول (يخفي الأيقونة)", r.status === 200 && r.body.values.x_url === "", r.raw.slice(0, 100));

  /* ================= A) السجل والسبب والمسّ بغير المفاتيح ================= */
  const { rows: log } = await query(`SELECT action, entity, entity_id, old_value, new_value, reason FROM admin_action_log WHERE admin_user_id = $1 AND action = 'site_front_updated' ORDER BY id`, [owner.id]);
  ok(`A6 سطر تدقيق لكل مفتاح تغيّر (${log.length} سطراً)`, log.length === 1 + 10 + 1 + 1 + 2 + 1 + 1 && log.every((l) => l.entity === "app_setting"), JSON.stringify(log.map((l) => l.entity_id)));
  const txtLog = log.find((l) => l.entity_id === "privacy_text" && l.old_value.length === 0);
  ok("A7 النصّ الطويل يُسجَّل طوله وبصمته لا متنه، والرابط كما هو", txtLog && txtLog.new_value.length === filled.privacy_text.length && /^[0-9a-f]{16}$/.test(txtLog.new_value.sha256) && !JSON.stringify(txtLog).includes("لا نبيع") && log.some((l) => l.entity_id === "x_url" && l.new_value.value === filled.x_url), JSON.stringify(txtLog));
  ok("A8 السبب التلقائي (auto-reason) مكتوب في كل سطر", log.every((l) => /واجهة الموقع/.test(l.reason || "")), log[0]?.reason);
  const { rows: gate } = await query(`SELECT count(*)::int n, bool_and(reason LIKE '%واجهة الموقع%') r FROM admin_access_log WHERE action = 'update_site_front' AND admin_user_id = $1`, [owner.id]);
  ok(`A9 requireReasonAndLog قيّد كل طلب حفظ في admin_access_log (${gate[0].n}) بسببه التلقائي`, gate[0].n >= 8 && gate[0].r === true, JSON.stringify(gate[0]));
  const { rows: [{ n: denied }] } = await query(`SELECT count(*)::int n FROM admin_access_log WHERE action = 'update_site_front' AND admin_user_id = $1`, [admin.id]);
  ok("A9b طلب المدير المرفوض بـ403 لم يُقيَّد كحفظ", denied === 0, String(denied));
  const settingsAfter = (await query(`SELECT key, value::text v, category, updated_at FROM app_settings WHERE NOT (key = ANY($1)) ORDER BY key`, [ALL12])).rows;
  const taxAfter = (await query(`SELECT * FROM tax_settings ORDER BY 1`).catch(() => ({ rows: ["(no table)"] }))).rows;
  ok(`A10 لا مسّ بأي مفتاح قائم آخر (${settingsBefore.length} مفتاحاً) ولا بـtax_settings`, JSON.stringify(settingsBefore) === JSON.stringify(settingsAfter) && JSON.stringify(taxBefore) === JSON.stringify(taxAfter), "");
  r = await call("GET", "/admin/app-settings", { cookie: owner.cookie });
  const listed = JSON.stringify(r.body);
  ok("A11 المفاتيح العشرة الجديدة لا تظهر مكرّرة في «إعدادات التشغيل» القديمة", r.status === 200 && ["x_url", "privacy_text", "contact_email", "terms_text_updated_at"].every((k) => !listed.includes(`"${k}"`)), `${r.status}`);

  /* ================= F) 503 سريع ================= */
  const realQuery = pool.query.bind(pool);
  pool.query = (text, ...rest) => (/app_settings/.test(String(text)) ? Promise.reject(new Error("connection refused (simulated)")) : realQuery(text, ...rest));
  r = await call("GET", "/api/public/landing", { origin: "https://tanfs.net" });
  ok(`F3 عطل القاعدة ← 503 فوراً (${r.ms}ms)`, r.status === 503 && r.body.error === "temporarily_unavailable" && r.ms < 1000, `${r.status} ${r.raw}`);
  ok("F4 الـ503 بلا تفاصيل العطل، no-store، ومع CORS ليقرأه الموقع", !r.raw.includes("refused") && r.headers.get("cache-control") === "no-store" && r.headers.get("access-control-allow-origin") === "https://tanfs.net", `${r.raw} ${r.headers.get("cache-control")}`);
  pool.query = (text, ...rest) => (/app_settings/.test(String(text)) ? new Promise(() => {}) : realQuery(text, ...rest));
  r = await call("GET", "/api/public/legal");
  ok(`F5 قاعدة معلّقة ← 503 بعد المهلة ${SF.PUBLIC_DB_TIMEOUT_MS}ms لا تعليق (${r.ms}ms)`, r.status === 503 && r.ms >= SF.PUBLIC_DB_TIMEOUT_MS - 50 && r.ms < SF.PUBLIC_DB_TIMEOUT_MS + 1500, `${r.status} ${r.ms}`);
  pool.query = realQuery;
  r = await call("GET", "/api/public/landing");
  ok("F6 بعد عودة القاعدة: 200", r.status === 200, String(r.status));

  /* ================= L) حدّ المعدّل ================= */
  IP = freshIp();
  const st = [];
  for (let i = 0; i < SF.PUBLIC_RATE.max; i++) st.push((await call("GET", i % 2 ? "/api/public/legal" : "/api/public/landing")).status);
  r = await call("GET", "/api/public/landing", { origin: "https://tanfs.net" });
  ok(`L1 ${SF.PUBLIC_RATE.max} طلباً في الدقيقة من عنوان واحد تمرّ كلها (فوق حدّ /api/ العام 60 — المحدِّدان منفصلان)`, st.every((s) => s === 200), JSON.stringify(st.filter((s) => s !== 200).slice(0, 5)));
  ok("L2 الطلب 121 ← 429 rate_limited، JSON ومع CORS", r.status === 429 && r.body.error === "rate_limited" && r.headers.get("access-control-allow-origin") === "https://tanfs.net", `${r.status} ${r.raw}`);
  ok("L3 ترويسة RateLimit المعيارية وRetry-After", !!(r.headers.get("ratelimit") || r.headers.get("ratelimit-limit")) && !!r.headers.get("retry-after"), `${r.headers.get("ratelimit-limit")} ${r.headers.get("retry-after")}`);
  r = await call("GET", "/api/public/landing", { xff: freshIp() });
  ok("L4 عنوان آخر لا يتأثر", r.status === 200, String(r.status));
  r = await call("POST", "/api/contact", { body: {} });
  ok("L5 استنفاد حدّ الصفحات لا يستهلك رصيد /api/ العام لهذا العنوان", r.status !== 429, String(r.status));
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 400), false]); }

console.log = rl; console.error = re; console.warn = rw;
let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 1200)})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
if (f) console.log(logs.slice(-15).join("\n"));
await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
