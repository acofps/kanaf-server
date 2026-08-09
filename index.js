import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import { adminRouter } from "./admin/routes.js";
import { paymentsRouter } from "./payments/routes.js";
import { authRouter } from "./auth/routes.js";
import { sendEmail, verifySmtpConnection } from "./mail/send.js";
import { query } from "./db/pool.js";
import { runMigrations, migrationStatus } from "./db/migrate.js";
import { verifyUnsubscribeToken } from "./notifications/unsubscribe.js";
import { hashPassword } from "./admin/auth.js";
import { verifyRenderer, closeBrowser } from "./invoicing/render.js";
/* ---------------------------------------------------------
   المرحلة 4 — المحتوى والإشعارات والبيانات التشغيلية للمستخدم.
--------------------------------------------------------- */
import { contentRouter } from "./content/routes.js";
import { userDataRouter, pushPublicKeyRouter } from "./userdata/routes.js";
import { adminContentRouter } from "./admin/content.js";
import { adminNotificationsRouter } from "./admin/notifications.js";
import { sweepMiddleware } from "./notifications/scheduler.js";
import { requireUserAuth } from "./auth/middleware.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// Render (and most PaaS hosts) terminates TLS and proxies requests
// through their own edge — exactly one hop. Trusting that specific
// hop (not an arbitrary number) lets express-rate-limit correctly
// read the real client IP from X-Forwarded-For instead of either
// rate-limiting everyone as a single client, or trusting a
// spoofable header from an untrusted number of hops.
app.set("trust proxy", 1);
app.use(express.json({ limit: "200kb" }));
app.use(cookieParser());

/* ---------------------------------------------------------
   CORS — only your real domain(s) may call this API.
   credentials: true is required for the admin panel's httpOnly
   cookies to actually be sent/received on cross-origin requests
   (e.g. admin frontend on admin.yourdomain.com calling this API on
   a different subdomain). Per the fetch/CORS spec, a wildcard "*"
   origin is not permitted together with credentials — this is why
   ALLOWED_ORIGINS must be a real, explicit list before you deploy.
--------------------------------------------------------- */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (allowedOrigins.length === 0) {
  console.warn(
    "WARNING: ALLOWED_ORIGINS is empty — CORS will reflect any origin. " +
    "This is fine for local development only. Set real domain(s) before deploying, " +
    "especially since the admin panel now relies on credentialed (cookie) requests."
  );
}
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

/* ---------------------------------------------------------
   Rate limiting — basic abuse protection
--------------------------------------------------------- */
app.use(
  "/api/",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    /* ---------------------------------------------------------
       الـwebhook مستثنى — وهذا إصلاح لعطب حقيقي لا رفاهية.

       كل أحداث Moyasar تصل من عدد صغير من عناوين IP الخاصة بهم،
       فهي عملياً "عميل واحد" أمام المحدِّد. حدّ 60 طلباً لكل ربع
       ساعة يعني أن دفعة نشاط عادية — أو عاصفة إعادة محاولات بعد
       انقطاع قصير — تجعل الخادم يرد 429 على أحداث دفع حقيقية.

       والأثر ليس تأخيراً: الحدث المرفوض بـ429 قد تُستنفد محاولات
       تسليمه، فيدفع العميل ولا يُفعَّل اشتراكه أبداً، ولا شيء في
       النظام يعرف أن ذلك حدث.

       الاستبدال ليس فتحاً للباب: المسار محمي بتحقق السر قبل أي
       كتابة، وبقيد فريد يمنع تكرار الأحداث.
    --------------------------------------------------------- */
    /* ------------------------------------------------------------
       الاستثناءات — أُعيد النظر فيها في المرحلة 4.

       الحد 60 طلباً لكل ربع ساعة كُتب حين كان تحت /api/ ثلاثة
       مسارات فقط. المرحلة 4 أدخلت تحته **مستوى بيانات التطبيق
       كاملاً**: الكتالوج، وكل /api/me/*، ومسار الأمان. إقلاع واحد
       للتطبيق يستهلك خمسة طلبات، وجلسة استخدام عادية تتجاوز
       الستين بسهولة. والأخطر: العنوان الواحد قد يخدم حياً كاملاً
       خلف CGNAT، فيُخنق كل مستخدميه معاً.

       والأسوأ من ذلك كله أن المحدِّد يسبق crisisFirewall — أي أن
       مستخدماً في أزمة على عنوان مزدحم كان يستقبل «طلبات كثيرة»
       بدل مسار الأمان. وهذا كسر مباشر لالتزام لا يُكسر.

       المستثنى هنا لا يعني بلا حماية:
         • /api/crisis-signal و /api/chat و /api/plan — مسار الأمان
           ومحادثته. /api/chat و /api/plan محميان بالمصادقة بعد
           جدار الأمان، فالتكلفة لا تُستهلك بلا حساب.
         • /api/me/* — كلها خلف requireVerifiedUser، فالحد الطبيعي
           هو الحساب الموثَّق لا العنوان.
         • /api/content/catalog — قراءة عامة بلا بيانات شخصية.
         • webhook الدفع — أحداث Moyasar تصل من عناوين قليلة فتبدو
           «عميلاً واحداً»؛ رفضها بـ429 يعني دفعة بلا تفعيل.

       الباقي (التسجيل، الدخول، إعادة التعيين، التواصل) يظل تحت
       الحد الأصلي، وهو ما يستحق التحديد فعلاً.
    ------------------------------------------------------------ */
    skip: (req) => {
      const u = req.originalUrl;
      return (
        u.startsWith("/api/payments/webhook") ||
        u.startsWith("/api/crisis-signal") ||
        u.startsWith("/api/chat") ||
        u.startsWith("/api/plan") ||
        u.startsWith("/api/me/") ||
        u.startsWith("/api/content/")
      );
    },
  })
);

/* ---------------------------------------------------------
   حدّ منفصل وأوسع لمستوى بيانات التطبيق.

   ليس بلا حد — لكنه حد يناسب تطبيقاً يزامن بياناته، لا مسار
   تسجيل. مفتاحه معرّف المستخدم حين يكون الطلب موثَّقاً، فمستخدمو
   عنوان مشترك لا يخنق بعضهم بعضاً.
--------------------------------------------------------- */
app.use(
  ["/api/me", "/api/content"],
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const h = req.headers.authorization || "";
      // بصمة الرمز لا الرمز نفسه — لا يُسجَّل سر في ذاكرة المحدِّد.
      if (h.startsWith("Bearer ")) return `t:${h.slice(7, 27)}`;
      return req.ip;
    },
  })
);

/* ---------------------------------------------------------
   مسح الإشعارات المجدولة المستحقّة.

   يُوضع بعد المحدِّد وقبل المسارات، ويستدعي next() فوراً ثم يعمل
   على الهامش — لا طلب ينتظره ولا طلب يفشل بسببه.

   هذا هو كامل "بنية الجدولة" في المشروع: لا Cron ولا Queue ولا
   Background Job. التفاصيل والحد الصادق لهذه الآلية موثّقان في
   notifications/scheduler.js وفي 04_NOTIFICATION_FLOW.md.
--------------------------------------------------------- */
app.use(sweepMiddleware);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-5";

/* ---------------------------------------------------------
   Server-side crisis check — defense in depth. The frontend
   already checks this before sending; we check again here so
   the safeguard cannot be bypassed by calling the API directly.
--------------------------------------------------------- */
const CRISIS_PATTERNS = [
  "انتحار", "اقتل نفسي", "بقتل نفسي", "اذي نفسي", "أؤذي نفسي", "ابي اموت",
  "أبغى أموت", "مافي داعي أعيش", "أفضل أموت", "ماعاد أقدر أكمل", "خلاص تعبت من الحياة",
  "suicide", "kill myself", "end my life", "self harm", "self-harm", "hurt myself",
  "i want to die", "don't want to live", "no reason to live",
];
/* ⚠️ التطبيع ليس تجميلاً — هذه دالة في مسار الأمان.

   كانت `text.toLowerCase()` مباشرة. ورسالة Anthropic قد يكون
   محتواها **مصفوفة كتل** لا نصاً (`[{type:"text",text:"..."}]`)،
   وهو شكل صحيح تماماً قد يتبناه التطبيق أي يوم. عندها ترمي الدالة
   TypeError، فيرد المسار 500 — أي أن **فحص إشارة الخطر يُتخطّى
   بالكامل** لرسالة قد تحمل إشارة خطر حقيقية. أثبتته المراجعة
   عملياً برسالة تحوي "أفكر في الانتحار" داخل مصفوفة كتل. */
function normalizeContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b?.text || "")).join(" ");
  if (c && typeof c === "object" && typeof c.text === "string") return c.text;
  return "";
}
function containsCrisisSignal(text = "") {
  const norm = normalizeContent(text).toLowerCase();
  if (!norm) return false;
  return CRISIS_PATTERNS.some((p) => norm.includes(p.toLowerCase()));
}

const CHAT_SYSTEM_PROMPT = `أنت مساعد تثقيفي داعم داخل تطبيق للصحة النفسية اسمه Kanaf، اسمك "رفيق". قواعدك صارمة ولا يجوز كسرها:
1. لا تقدّم أبداً تشخيصاً طبياً قاطعاً. استخدم "الأعراض التي وصفتها تشبه نمط..." بدل "أنت مصاب بـ...".
2. لا تذكر أي دواء أو جرعة إطلاقاً.
3. لا تقدّم "خطة علاجية" متكاملة. قدّم خطوة أو خطوتين دعم ذاتي فوريتين بسيطتين، وأحل الباقي لأخصائي مرخّص.
4. لو بيانات المستخدم تشير لشدة متوسطة فأعلى، انصح بوضوح ودفء بمراجعة أخصائي قريباً.
5. كن دافئاً، مختصراً، تعاطفياً، وتكلم بالعربية.
6. لست بديلاً عن أخصائي.`;

const PLAN_SYSTEM_PROMPT = `أنت مولّد "خطط تحسين جودة حياة" داخل تطبيق Kanaf. ليست خطة علاجية أو إكلينيكية:
1. ركّز فقط على أسلوب الحياة: النوم، الحركة، الروتين، التواصل الاجتماعي، إدارة التوتر.
2. ممنوع أي لغة تشخيصية أو ذكر أدوية أو "علاج".
3. الأهداف صغيرة وقابلة للتحقيق خلال أسبوع واحد فقط.
4. لو الشدة متوسطة فأعلى، أضف specialist_note ينصح بمراجعة أخصائي عاجلاً.
5. أعد ردك بصيغة JSON فقط بدون أي نص خارج الأقواس وبدون Markdown، بالشكل:
{"summary":"...","focus_areas":[{"title":"...","goal":"...","small_step":"..."}],"specialist_note":"نص أو null"}
قدّم بين ٢ إلى ٣ عناصر في focus_areas فقط.`;

/* ---------------------------------------------------------
   جدار الأمان قبل المصادقة — الاستثناء الصريح المطلوب.

   ============================================================
   المشكلة التي يحلها هذا الترتيب
   ============================================================
   /api/chat و /api/plan كانا بلا مصادقة إطلاقاً: أي شخص في العالم
   يقدر يستهلك رصيد Anthropic خلف حدّ 60 طلباً لكل IP فقط — نزيف
   مالي قابل للتوزيع على عناوين متعددة.

   والحل المباشر (إضافة requireUserAuth) كان يصطدم بالتزام ثابت لا
   يجوز كسره: **مسار الأمان لا يُحجب خلف تسجيل دخول أبداً**. ولو
   كانت المحادثة قناة يمر عبرها اكتشاف الخطر، لصار طلب الرمز حاجزاً
   أمام شخص في أزمة.

   ============================================================
   لماذا لا تعارض بينهما فعلياً
   ============================================================
   اكتشاف الخطر هنا لا يحتاج النموذج إطلاقاً: containsCrisisSignal
   مطابقة نصوص محلية، وترد { crisis: true } **قبل** أي نداء
   لـAnthropic. أي أن الجزء الذي يجب ألا يُحجب لا يكلّف شيئاً،
   والجزء المكلف هو وحده ما يحتاج حماية.

   لذلك الترتيب: الفحص أولاً بلا مصادقة، ثم المصادقة لما بعده.
   شخص في أزمة يصله مسار الأمان بلا حساب؛ ومن يريد محادثة عامة
   يحتاج حساباً موثَّقاً.
--------------------------------------------------------- */
function crisisFirewall(req, res, next) {
  const { messages, dataNote } = req.body || {};
  const raw = Array.isArray(messages)
    ? [...messages].reverse().find((m) => m.role === "user")?.content
    : dataNote;
  const text = normalizeContent(raw);
  if (text && containsCrisisSignal(text)) {
    return res.status(200).json({ crisis: true });
  }
  next();
}

/* ---------------------------------------------------------
   POST /api/chat  { messages: [{role, content}] }
--------------------------------------------------------- */
app.post("/api/chat", crisisFirewall, requireUserAuth, async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system: CHAT_SYSTEM_PROMPT,
      messages,
    });

    const reply = response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();

    if (containsCrisisSignal(reply)) {
      return res.status(200).json({ crisis: true });
    }
    res.json({ reply: reply || "عذراً، ما قدرت أرد الحين. جرب مرة ثانية." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ---------------------------------------------------------
   POST /api/plan  { dataNote: string }
--------------------------------------------------------- */
app.post("/api/plan", crisisFirewall, requireUserAuth, async (req, res) => {
  try {
    const { dataNote } = req.body || {};
    if (!dataNote) return res.status(400).json({ error: "dataNote is required" });

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system: PLAN_SYSTEM_PROMPT,
      messages: [{ role: "user", content: dataNote }],
    });

    const raw = response.content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ---------------------------------------------------------
   Consumer authentication — registration, email verification, login.

   Replaces the old /api/send-code and /api/verify-code pair, which
   are GONE. They stored codes in a process-local Map (wiped on every
   redeploy, invisible to a second instance), generated them with
   Math.random, had no attempt limit, and — the core problem — never
   wrote a users row or issued a session. Nothing downstream could
   prove a verification had happened, and the admin panel's user list
   stayed empty because no INSERT INTO users existed anywhere.

   The consumer app must be updated to call /api/auth/* instead. The
   old paths are not aliased on purpose: silently redirecting them
   would leave the app appearing to work while sessions behaved
   differently.
--------------------------------------------------------- */
app.use("/api/auth", authRouter);

/* ---------------------------------------------------------
   POST /api/contact  { name, email, message }
--------------------------------------------------------- */
app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) return res.status(400).json({ error: "name, email, and message are required" });

    /* ---------------------------------------------------------
       كان هذا المسار يرسل بريداً ويرد { ok: true } **بلا كتابة صف
       واحد**. الأثر: صفحة "الرسائل" في اللوحة تقرأ contact_messages
       وتبقى فارغة أبداً — وهي تبدو شغالة تماماً، وهذا أخطر ما فيها.

       الصف يُكتب أولاً. لو فشل البريد بعده تبقى الرسالة محفوظة
       ويراها الدعم؛ العكس كان يعني رسالة عميل تضيع لأن SMTP تعثّر.
    --------------------------------------------------------- */
    const { rows } = await query(
      `INSERT INTO contact_messages (name, email, message)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [String(name).trim().slice(0, 200), String(email).trim().slice(0, 200), String(message).trim().slice(0, 5000)]
    );

    try {
      await sendEmail(
        process.env.EMAIL_FROM || "you@yourdomain.com",
        `رسالة تواصل جديدة من ${name}`,
        `From: ${name} <${email}>\n\n${message}`
      );
    } catch (mailErr) {
      // الرسالة محفوظة — فشل الإشعار البريدي لا يُفشل الطلب، لكنه
      // يُسجَّل بوضوح بدل أن يُبتلع.
      console.error("[contact] حُفظت الرسالة ولم يُرسل الإشعار البريدي:", mailErr.message);
    }

    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* ---------------------------------------------------------
   POST /api/crisis-signal  { source }

   عدّاد مجهول تماماً لأحداث مسار الأمان.

   جدول crisis_trigger_events موجود منذ schema.sql بلا كاتب واحد،
   فمؤشر "أحداث الخطر" في لوحة الإدارة صفر أبداً — لا لأن الأحداث
   لا تقع، بل لأن أحداً لم يكتبها.

   ثلاثة قيود مقصودة، وكلها في اتجاه واحد:
     • بلا مصادقة — مسار الأمان لا يُحجب، والعدّ لا يجوز أن يكلّف
       المستخدم في أزمة أي خطوة.
     • بلا user_id ولا IP ولا نص — الجدول نفسه لا يحوي عموداً
       لأي منها. المقصود "كم مرة يشتغل مسار الأمان"، لا "من".
     • بلا رد ذي معنى — { ok: true } فقط، فلا شيء يمكن استنتاجه من
       الرد عن حالة أي مستخدم.
--------------------------------------------------------- */
const CRISIS_SOURCES = ["phq9_item9", "chat_keyword", "journal_keyword", "manual_button", "screening_band"];
app.post("/api/crisis-signal", async (req, res) => {
  try {
    const source = CRISIS_SOURCES.includes(req.body?.source) ? req.body.source : "manual_button";
    await query(`INSERT INTO crisis_trigger_events (trigger_source) VALUES ($1)`, [source]);
  } catch (err) {
    // لا يفشل أبداً أمام المستخدم: مسار الأمان أهم من العدّاد.
    console.error("[crisis-signal] تعذّر تسجيل الحدث:", err.message);
  }
  res.json({ ok: true });
});

/* ---------------------------------------------------------
   المحتوى والبيانات التشغيلية للمستخدم — المرحلة 4.
--------------------------------------------------------- */
app.use("/api/content", contentRouter);
app.use("/api", pushPublicKeyRouter);
app.use("/api/me", userDataRouter);

app.get("/api/health", (req, res) => res.json({ ok: true }));

/* ---------------------------------------------------------
   Unsubscribe from broadcast emails — the real gap a strict review
   found: bulk email had no opt-out mechanism at all. GET only shows
   a confirmation page and never unsubscribes directly — some email
   security scanners pre-fetch links in emails, which would silently
   trigger a one-click GET-based unsubscribe for people who never
   actually clicked anything. The actual action happens on POST.
--------------------------------------------------------- */
app.get("/api/unsubscribe", (req, res) => {
  const userId = verifyUnsubscribeToken(req.query.token);
  if (!userId) {
    return res.status(400).send(`<!DOCTYPE html><html dir="rtl" lang="ar"><body style="font-family:Arial;text-align:center;padding:40px;">
      <p>الرابط غير صالح أو منتهي.</p></body></html>`);
  }
  res.send(`<!DOCTYPE html><html dir="rtl" lang="ar"><body style="font-family:Arial;text-align:center;padding:40px;">
    <p>تأكيد إلغاء الاشتراك من رسائل كنف التسويقية؟</p>
    <form method="POST" action="/api/unsubscribe">
      <input type="hidden" name="token" value="${String(req.query.token).replace(/"/g, "&quot;")}">
      <button type="submit" style="padding:10px 24px;border-radius:8px;background:#0D5C6B;color:#fff;border:none;font-size:14px;">تأكيد إلغاء الاشتراك</button>
    </form>
  </body></html>`);
});

app.post("/api/unsubscribe", express.urlencoded({ extended: false }), async (req, res) => {
  const userId = verifyUnsubscribeToken(req.body?.token || req.query.token);
  if (!userId) {
    return res.status(400).send(`<!DOCTYPE html><html dir="rtl" lang="ar"><body style="font-family:Arial;text-align:center;padding:40px;">
      <p>الرابط غير صالح أو منتهي.</p></body></html>`);
  }
  try {
    await query(`UPDATE users SET marketing_opt_out = true, updated_at = now() WHERE id = $1`, [userId]);
    res.send(`<!DOCTYPE html><html dir="rtl" lang="ar"><body style="font-family:Arial;text-align:center;padding:40px;">
      <p>تم إلغاء اشتراكك. ما بتوصلك رسائل تسويقية بعد الآن.</p></body></html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("internal_error");
  }
});

/* ---------------------------------------------------------
   موجّهات الإدارة.

   موجّها المحتوى والإشعارات يُركَّبان قبل adminRouter عمداً: مسارا
   /admin/content القديمان حُذفا من admin/routes.js في هذه المرحلة،
   والترتيب هنا يضمن أن أي بقية منهما — في نسخة قديمة مثلاً — لا
   تحجب النسخة العاملة. طبقة دفاع ثانية ضد انحراف النسخة المنشورة
   عن المستودع، وهو انحراف حصل فعلاً في هذا المشروع.
--------------------------------------------------------- */
app.use("/admin", adminContentRouter);
app.use("/admin", adminNotificationsRouter);
app.use("/admin", adminRouter);

/* ---------------------------------------------------------
   One-time bootstrap: create the first owner admin account.
   Exists because this deployment has no SSH/Shell access to run
   db/seed_first_admin.js directly. Protected by two independent
   safeguards: a secret token (SETUP_TOKEN env var) AND a check that
   admin_users is completely empty — so even if the token ever leaks
   after setup, this can never create a second admin account or be
   used as a backdoor. Safe to leave the code in place permanently;
   once one admin exists, every call is rejected regardless of token.
--------------------------------------------------------- */
app.post("/api/setup/create-first-admin", async (req, res) => {
  try {
    const setupToken = process.env.SETUP_TOKEN;
    if (!setupToken) return res.status(403).json({ error: "setup_disabled" });

    const { token, name, email, password } = req.body || {};
    if (!token || token !== setupToken) return res.status(403).json({ error: "invalid_token" });

    const { rows: existing } = await query(`SELECT count(*)::int AS n FROM admin_users`);
    if (existing[0].n > 0) return res.status(409).json({ error: "admin_already_exists" });

    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ error: "name_email_password_required" });
    }
    if (password.length < 15) {
      return res.status(400).json({ error: "password_must_be_at_least_15_chars" });
    }

    const passwordHash = await hashPassword(password);
    const { rows } = await query(
      `INSERT INTO admin_users (name, email, password_hash, role) VALUES ($1, $2, $3, 'owner')
       RETURNING id, name, email, role`,
      [name.trim(), email.trim().toLowerCase(), passwordHash]
    );
    res.status(201).json({ ok: true, admin: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});
/* ---------------------------------------------------------
   Schema migrations over HTTP — same reasoning, and the same two
   safeguards, as create-first-admin above: this deployment has no
   shell access, and cPanel provides no PostgreSQL SQL console
   (phpMyAdmin is MySQL only).

   Gated by SETUP_TOKEN. It is not a SQL executor — it can only apply
   .sql files already committed to db/migrations/, in order, once
   each. Re-running it after everything is applied is a no-op, so it's
   safe to leave in place.
--------------------------------------------------------- */
app.get("/api/setup/migration-status", async (req, res) => {
  try {
    const setupToken = process.env.SETUP_TOKEN;
    if (!setupToken) return res.status(403).json({ error: "setup_disabled" });
    if (req.query.token !== setupToken) return res.status(403).json({ error: "invalid_token" });

    res.json({ migrations: await migrationStatus() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", detail: err.message });
  }
});

app.post("/api/setup/run-migrations", async (req, res) => {
  try {
    const setupToken = process.env.SETUP_TOKEN;
    if (!setupToken) return res.status(403).json({ error: "setup_disabled" });

    const { token } = req.body || {};
    if (!token || token !== setupToken) return res.status(403).json({ error: "invalid_token" });

    const results = await runMigrations();
    const failed = results.find((r) => r.status === "failed");
    res.status(failed ? 500 : 200).json({ ok: !failed, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", detail: err.message });
  }
});

app.use("/api/payments", paymentsRouter);

/* ---------------------------------------------------------
   Admin UI — served from this same origin, on purpose.
   The admin panel's cookies use SameSite=Strict (see admin/auth.js),
   which browsers never send on cross-site requests, no matter how
   the CORS/domain config is tuned on either side. Hosting the admin
   frontend on a different domain (e.g. a separate admin.yourdomain
   on different infrastructure) than this API is what breaks login —
   confirmed by testing during actual deployment. Serving the built
   admin UI directly from this same Express app makes every request
   genuinely same-origin, which is the only configuration where
   SameSite=Strict cookies work with no further changes needed.
--------------------------------------------------------- */
const adminUiPath = path.join(__dirname, "admin-ui");
app.use(express.static(adminUiPath));
// SPA catch-all: any GET that isn't an API route falls through to
// index.html so client-side routing (React state, not real URLs)
// still works correctly on a hard refresh or direct link.
app.get(/^(?!\/admin|\/api).*/, (req, res) => {
  res.sendFile(path.join(adminUiPath, "index.html"));
});

/* ---------------------------------------------------------
   معالج الأخطاء النهائي.

   لم يكن في المشروع أي معالج أخطاء، فأي استثناء يفلت من مسار كان
   يمر إلى معالج Express الافتراضي — الذي يرسل **أثر المكدّس
   كاملاً إلى العميل** خارج NODE_ENV=production. أي أن الحماية
   الوحيدة كانت متغيّر بيئة، وقد نُسي من قبل في هذا المشروع.

   يوضع بعد كل المسارات وقبل الاستماع. أربعة وسائط إلزامية —
   Express يميّز معالج الأخطاء بعددها لا باسمها.
--------------------------------------------------------- */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("[unhandled]", req.method, req.originalUrl, err);
  res.status(err?.status && err.status < 600 ? err.status : 500).json({ error: "internal_error" });
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, async () => {
  console.log(`Kanaf backend running on port ${PORT}`);
  // Surfaces a broken mail config in the deploy logs rather than on a
  // real user's first signup. Never blocks startup — the rest of the
  // API is still useful if mail is down.
  await verifySmtpConnection();

  // نفس المنطق للفواتير: الوثيقة الضريبية تُطبع في Chromium، ونشرٌ
  // بلا متصفّح يعني دفعات صحيحة بلا فواتير — وهو عطب لا يظهر إلا
  // عند أول عملية دفع حقيقية. الفحص هنا يُظهره في سجل النشر فوراً.
  // لا يمنع الإقلاع: بقية الـAPI تعمل، والفواتير الناقصة تُصلَّح من
  // زر «إعادة الإصدار» في اللوحة بعد الإصلاح.
  if (process.env.SKIP_PDF_BOOT_CHECK !== "1") {
    try {
      const { bytes, ms } = await verifyRenderer();
      console.log(`[invoice] مولّد الفواتير جاهز (${bytes} بايت في ${ms}ms).`);
    } catch (err) {
      console.error(
        "[invoice] ⚠️ مولّد الفواتير غير جاهز — لن تصدر فواتير ضريبية. " +
        "تأكد أن أمر البناء ينزّل Chromium وأن PUPPETEER_CACHE_DIR مضبوط. السبب:", err.message
      );
    }
  }
});

// إغلاق نظيف: Render يرسل SIGTERM عند كل نشر. متصفّح لا يُغلق
// يبقى عملية يتيمة تأكل ذاكرة الحاوية حتى تُقتل.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal} — إغلاق نظيف.`);
    server.close(() => {});
    closeBrowser().finally(() => process.exit(0));
  });
}
