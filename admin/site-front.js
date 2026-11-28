import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { query, withTransaction } from "../db/pool.js";
import {
  requireAdminAuth, requirePermission, requireReasonAndLog, logAdminAction, fail, httpError,
} from "./middleware.js";
import { serverError } from "../ops/http-errors.js";

/* ============================================================
   واجهة الموقع — KANAF-ORD-0022 القسم ب

   ثلاث صفحات عامة على جذر tanfs.net (الرئيسية، وسياسة الخصوصية،
   وشروط الاستخدام) لا تحمل روابطها ولا نصوصها ثابتةً، بل تقرؤها عند
   التحميل من نقطتين عامتين هنا، فيغيّرها المالك من اللوحة بلا رفع ملف.

   ------------------------------------------------------------
   التخزين: app_settings القائم، بلا جدول جديد ولا ترحيل
   ------------------------------------------------------------
   اثنا عشر مفتاحاً بأسماء ثابتة تقرؤها الصفحات المسلَّمة بعينها.
   المفتاح الغائب يُقرأ سلسلةً فارغة ولا يرمي: فلا يعتمد النشر على
   ترتيب بين الكود والترحيل، ولا يتعطّل شيء قبل أن يُدخل المالك أي قيمة.
   والحفظ «إدراج أو تحديث» (ON CONFLICT)، فالصف يُنشأ عند أول حفظ.

   اثنان منها قائمان قبل هذا الأمر: app_store_url وgoogle_play_url
   (KANAF-ORD-0008 §9.2، يقرؤهما تذييل البريد). تُقرأ القيمة نفسها هنا،
   وبالمدقّق نفسه: https والمضيف الرسمي بعينه.

   و**contact_email لا مفتاح له** (ملحق ORD-0022 §2-2): اسم في الردّ
   وفي اللوحة فقط، وقيمته support_email القائم — البريد نفسه الذي يظهر
   تحت «تواصل معنا» في التطبيق. فللبريد مصدر واحد لا مصدران يفترقان.
   أمّا x_url وinstagram_url فمنفصلان عن social_*_handle عمداً (§2-3):
   رابط كامل لموقع tanfs.net مقابل معرّف لنموذج «تواصل معنا».
   ============================================================ */

/** الروابط والبريد — GET /api/public/landing */
export const LANDING_KEYS = [
  "app_store_url", "google_play_url", "x_url", "instagram_url",
  "whatsapp_url", "tiktok_url", "snapchat_url", "contact_email",
];
/** النصوص القانونية — GET /api/public/legal (حقلا الوقت يضبطهما الخادم وحده) */
export const LEGAL_KEYS = ["privacy_text", "privacy_text_updated_at", "terms_text", "terms_text_updated_at"];
const TEXT_KEYS = ["privacy_text", "terms_text"];
const STAMP_OF = { privacy_text: "privacy_text_updated_at", terms_text: "terms_text_updated_at" };
/** ما تقبله اللوحة في الحفظ — حقلا الوقت ليسا منه، فإرسالهما يُرفض */
export const EDITABLE_KEYS = [...LANDING_KEYS, ...TEXT_KEYS];
export const SITE_FRONT_KEYS = [...LANDING_KEYS, ...LEGAL_KEYS];
/** الاسم المعروض ← المفتاح المخزَّن، حيث يختلفان. */
export const STORAGE_KEY = { contact_email: "support_email" };
const storageKey = (k) => STORAGE_KEY[k] || k;
/** مفاتيح لا يحرّرها إلا «واجهة الموقع» — تُخفى من جدول «إعدادات التشغيل» القديم.
    مفتاحا المتجر وsupport_email مشتركة، فتبقى هناك أيضاً. */
export const SITE_FRONT_OWN_KEYS = SITE_FRONT_KEYS.filter((k) => !["app_store_url", "google_play_url"].includes(k) && !STORAGE_KEY[k]);

export const URL_MAX = 300;
export const TEXT_MAX = 60000;

/** أسماء الحقول بالعربية — تدخل رسائل الرفض فتسمّي الحقل. */
export const FIELD_LABEL = {
  app_store_url: "رابط App Store",
  google_play_url: "رابط Google Play",
  x_url: "حساب إكس",
  instagram_url: "حساب إنستقرام",
  whatsapp_url: "رابط واتساب",
  tiktok_url: "حساب تيك توك",
  snapchat_url: "حساب سناب شات",
  contact_email: "بريد التواصل",
  privacy_text: "نصّ سياسة الخصوصية",
  terms_text: "نصّ شروط الاستخدام",
  privacy_text_updated_at: "وقت آخر تعديل لسياسة الخصوصية",
  terms_text_updated_at: "وقت آخر تعديل لشروط الاستخدام",
};

/** رمز الرفض ← سببه بالعربية. الرموز نفسها في خريطة أخطاء اللوحة. */
const REASON_AR = {
  site_front_value_must_be_string: "القيمة يجب أن تكون نصاً",
  site_front_url_invalid: "ليس عنواناً صالحاً",
  site_front_url_must_be_https: "يُقبل رابط يبدأ بـ https:// وحده",
  site_front_url_too_long: `أطول من ${URL_MAX} حرف`,
  site_front_url_host_not_allowed: "يُقبل رابط المتجر الرسمي وحده",
  site_front_email_invalid: "صيغة البريد غير صحيحة",
  site_front_text_too_long: `أطول من ${TEXT_MAX} حرف`,
  site_front_field_not_editable: "يضبطه الخادم وحده ولا يُرسل في الطلب",
  site_front_unknown_field: "حقل غير معروف",
};

/* ------------------------------------------------------------
   التحقق — في الخادم، لا يُعتمد على المتصفح
   ------------------------------------------------------------ */
const STORE_HOST = { app_store_url: "apps.apple.com", google_play_url: "play.google.com" };

function checkUrl(key, v) {
  if (v.length > URL_MAX) return "site_front_url_too_long";
  // https:// حرفياً قبل أي تحليل: javascript: وdata: وhttp: وكل ما عداها تسقط هنا.
  if (!/^https:\/\//i.test(v)) return "site_front_url_must_be_https";
  // مسافة أو محرف تحكّم أو علامة اقتباس أو <> داخل الرابط: ليس رابطاً منسوخاً من المتصفح.
  // (URL يقبلها ويرمّزها بصمت، فتُحفظ قيمة غير التي كتبها المسؤول.)
  if (/[\s\u0000-\u001f\u007f<>"'`\\]/.test(v)) return "site_front_url_invalid";
  let u;
  try { u = new URL(v); } catch { return "site_front_url_invalid"; }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return "site_front_url_invalid";
  if (STORE_HOST[key] && u.hostname !== STORE_HOST[key]) return "site_front_url_host_not_allowed";
  return null;
}

/* بريد بصيغة معقولة: جزء محلي بلا مسافات ولا @، ونطاق فيه نقطة. لا أكثر من ذلك —
   التحقق الكامل من RFC 5322 لا يُفيد صفحة تعرض البريد للزائر. */
const EMAIL = /^[^\s@<>()"',;:]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * يتحقق من القيم كلها مرة واحدة، فتصل اللوحةَ أخطاءُ كل الحقول معاً.
 * يعيد { values } مطبّعةً (الفراغ → "")، أو { errors: { key: { code, message } } }.
 */
export function validateSiteFront(input) {
  const errors = {};
  const values = {};
  const reject = (key, code) => {
    errors[key] = { code, message: `${FIELD_LABEL[key] || key}: ${REASON_AR[code]}.` };
  };
  for (const key of Object.keys(input || {})) {
    if (LEGAL_KEYS.includes(key) && !TEXT_KEYS.includes(key)) { reject(key, "site_front_field_not_editable"); continue; }
    if (!EDITABLE_KEYS.includes(key)) { errors[key] = { code: "site_front_unknown_field", message: `${key}: ${REASON_AR.site_front_unknown_field}.` }; continue; }
    let v = input[key];
    if (v === null || v === undefined) v = "";
    if (typeof v !== "string") { reject(key, "site_front_value_must_be_string"); continue; }
    if (TEXT_KEYS.includes(key)) {
      // النصّ يُخزَّن كما هو: نصّ عادي لا HTML. الصفحات تهرّب كل حرف عند العرض.
      if (v.length > TEXT_MAX) { reject(key, "site_front_text_too_long"); continue; }
      values[key] = v;
      continue;
    }
    v = v.trim();
    if (v === "") { values[key] = ""; continue; }
    if (key === "contact_email") {
      if (v.length > URL_MAX || !EMAIL.test(v)) { reject(key, "site_front_email_invalid"); continue; }
      values[key] = v;
      continue;
    }
    const bad = checkUrl(key, v);
    if (bad) { reject(key, bad); continue; }
    values[key] = v;
  }
  return Object.keys(errors).length ? { errors } : { values };
}

/* ------------------------------------------------------------
   القراءة — متحمّلة لغياب أي مفتاح
   ------------------------------------------------------------ */
const asText = (v) => (v === null || v === undefined ? "" : typeof v === "string" ? v : String(v));

/** يقرأ المفاتيح المطلوبة؛ الغائب والفارغ والـnull كلها "". */
export async function readSiteFront(keys = SITE_FRONT_KEYS) {
  const { rows } = await query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [keys.map(storageKey)]);
  const found = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(keys.map((k) => [k, asText(found[storageKey(k)])]));
}

/* ============================================================
   النقطتان العامتان

     GET /api/public/landing   ← المفاتيح الثمانية
     GET /api/public/legal     ← المفاتيح الأربعة

   بلا مصادقة ولا كعكة، ولا تقرأ إلا جدول الإعدادات: لا بيانات
   مستخدمين ولا سرّ. وCORS هنا وحده لأصلَي tanfs.net، بلا credentials:
   المحدِّد العام في index.js يتنحّى عن /api/public (انظر هناك).
   ============================================================ */
export const PUBLIC_ORIGINS = ["https://tanfs.net", "https://www.tanfs.net"];
/** مهلة القراءة: عند عطل في القاعدة يُردّ 503 بعدها لا يُترك الطلب معلّقاً. */
export const PUBLIC_DB_TIMEOUT_MS = 2500;

/* حدّ المعدّل — 120 طلباً في الدقيقة لكل عنوان.
   زائر الصفحة يحتاج طلباً واحداً لكل تحميل، والردّ يُخزَّن عنده خمس
   دقائق (max-age=300)، فيكفيه أقل من طلب في الدقيقة. والحدّ أعلى من
   ذلك بكثير لأن مستخدمي شبكات الجوال يخرجون غالباً من عنوان واحد
   مشترك (CGNAT)، فلا يُحجب زوار حقيقيون يتشاركون عنواناً. وهو في
   الوقت نفسه يحصر عميلاً واحداً في طلبين في الثانية على قراءة
   صفّ صغير. ومحدِّده مستقل عن محدِّد /api/ العام (60 في ربع ساعة):
   ذاك محسوب لمسارات الحساب والدخول، وزوار الصفحات لا يُستنزف بهم
   رصيد الدخول ولا العكس. */
export const PUBLIC_RATE = { windowMs: 60 * 1000, max: 120 };

export const publicSiteFrontRouter = express.Router();

publicSiteFrontRouter.use(rateLimit({
  ...PUBLIC_RATE,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    setPublicCors(req, res);
    res.status(429).json({ error: "rate_limited" });
  },
}));

function setPublicCors(req, res) {
  res.setHeader("Vary", "Origin");
  const origin = req.headers.origin;
  if (origin && PUBLIC_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
}

function publicEndpoint(keys) {
  return async (req, res) => {
    setPublicCors(req, res);
    // GET وحده. HEAD وOPTIONS وكل ما عداهما 405 — ولا طلب تمهيدي يلزم: GET بلا ترويسات خاصة طلب بسيط.
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "method_not_allowed" });
    }
    let timer;
    try {
      const values = await Promise.race([
        readSiteFront(keys),
        new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error("site_front_db_timeout"), { timeout: true })), PUBLIC_DB_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json(values);
    } catch (err) {
      clearTimeout(timer);
      // الصفحات تتحمّل هذا: الرئيسية بلا روابط، والقانونيتان على نصّهما المدفون.
      // عطل حقيقي: يُسجَّل في «أخطاء النظام» كسائر 5xx (test-51)، والردّ بلا تفاصيله.
      res.setHeader("Cache-Control", "no-store");
      return serverError(res, err, err.timeout ? "public/site-front:db-timeout" : "public/site-front:read", req,
        { status: 503, body: { error: "temporarily_unavailable" } });
    }
  };
}

publicSiteFrontRouter.all("/landing", publicEndpoint(LANDING_KEYS));
publicSiteFrontRouter.all("/legal", publicEndpoint(LEGAL_KEYS));

/* ============================================================
   صفحة اللوحة — «واجهة الموقع» تحت الإعدادات

   صلاحيتها صلاحية إعدادات التشغيل نفسها: app_settings:view للقراءة،
   وapp_settings:edit للحفظ. لا صلاحية جديدة ولا توسيع.
   ============================================================ */
export const adminSiteFrontRouter = express.Router();

adminSiteFrontRouter.get(
  "/site-front",
  requireAdminAuth, requirePermission("app_settings:view"),
  async (req, res) => {
    try {
      const values = await readSiteFront();
      res.setHeader("Cache-Control", "no-store");
      res.json({
        values,
        canEdit: req.admin.can("app_settings:edit"),
        limits: { urlMax: URL_MAX, textMax: TEXT_MAX },
        labels: FIELD_LABEL,
      });
    } catch (err) { fail(res, err, "admin/site-front:read", req); }
  }
);

/** ما يُكتب في سجل التدقيق: الرابط والبريد كما هما، والنصّ الطويل طوله وبصمته لا متنه. */
const auditValue = (key, v) =>
  TEXT_KEYS.includes(key)
    ? { length: v.length, sha256: crypto.createHash("sha256").update(v).digest("hex").slice(0, 16) }
    : { value: v };

/**
 * PUT /admin/site-front  { values: { <مفتاح>: <قيمة>, … } }
 *
 * زرّ حفظ واحد في اللوحة يرسل الحقول كلها. يتحقق منها كلها أولاً، فإن
 * رُفض حقل واحد لا يُكتب شيء، وتعود أخطاء كل الحقول معاً.
 * والحقل الذي لم تتغيّر قيمته لا يُكتب ولا يُقيَّد. وحقل الوقت يضبطه
 * الخادم حين يتغيّر نصّه، ولا يقبله من الطلب إطلاقاً.
 */
adminSiteFrontRouter.put(
  "/site-front",
  requireAdminAuth,
  requirePermission("app_settings:edit"),
  requireReasonAndLog("update_site_front", { resolveTargetUserId: () => null }),
  async (req, res) => {
    const reason = String(req.body?.reason || req.query?.reason || "").trim();
    try {
      const input = req.body?.values;
      if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "values_required");
      const checked = validateSiteFront(input);
      if (checked.errors) {
        return res.status(400).json({
          error: "site_front_invalid",
          message: Object.values(checked.errors).map((e) => e.message).join(" "),
          fields: checked.errors,
        });
      }

      const changed = await withTransaction(async (client) => {
        const keys = Object.keys(checked.values);
        const { rows } = await client.query(
          `SELECT key, value FROM app_settings WHERE key = ANY($1) FOR UPDATE`, [keys.map(storageKey)]
        );
        const before = Object.fromEntries(rows.map((r) => [r.key, asText(r.value)]));
        const out = [];
        /* يكتب في المفتاح المخزَّن. والصف القائم يُحدَّث في قيمته وحدها (فئته ووصفه كما هما)؛
           وsupport_email الفارغ null كما يكتبه «إعدادات التشغيل»، فيبقى /api/support-info على معناه. */
        const write = (key, value) => client.query(
          `INSERT INTO app_settings (key, value, category, description, updated_by, updated_at)
           VALUES ($1, $2::jsonb, $3, $4, $5, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [key, JSON.stringify(key === "support_email" && value === "" ? null : value),
           key === "support_email" ? "support" : "general", `واجهة الموقع — ${FIELD_LABEL[key] || key}`, req.admin.id]
        );
        for (const field of keys) {
          const key = storageKey(field);
          const old = before[key] ?? "";
          const value = checked.values[field];
          if (old === value) continue;
          await write(key, value);
          out.push({ key, field, old, value });
          if (STAMP_OF[key]) {
            const { rows: [{ now }] } = await client.query(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
            await write(STAMP_OF[key], now);
          }
        }
        return out;
      });

      for (const c of changed) {
        await logAdminAction({
          adminUserId: req.admin.id, action: "site_front_updated",
          entity: "app_setting", entityId: c.key,
          oldValue: auditValue(c.key, c.old), newValue: auditValue(c.key, c.value),
          reason, ipAddress: req.ip,
        });
      }

      res.json({ values: await readSiteFront(), changed: changed.map((c) => c.field) });
    } catch (err) { fail(res, err, "admin/site-front:update", req); }
  }
);
