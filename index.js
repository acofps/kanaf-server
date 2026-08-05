import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import { adminRouter } from "./admin/routes.js";
import { paymentsRouter } from "./payments/routes.js";
import { query } from "./db/pool.js";
import { verifyUnsubscribeToken } from "./notifications/unsubscribe.js";

const app = express();
// Render (and most PaaS hosts) terminates TLS and proxies requests
// through their own edge — exactly one hop.
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
  })
);

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
function containsCrisisSignal(text = "") {
  const norm = text.toLowerCase();
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
   POST /api/chat  { messages: [{role, content}] }
--------------------------------------------------------- */
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (lastUserMsg && containsCrisisSignal(lastUserMsg.content)) {
      return res.status(200).json({ crisis: true });
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
app.post("/api/plan", async (req, res) => {
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
   Email verification codes (in-memory demo store).
   For real production, swap the Map for Redis or a DB table
   with an expiry column, especially if you run more than one
   server process.
--------------------------------------------------------- */
const verificationCodes = new Map(); // email -> { code, expiresAt }

async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[dev] Would send email to ${to}: ${subject}\n${text}`);
    return;
  }
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "Kanaf <noreply@example.com>",
      to,
      subject,
      text,
    }),
  });
}

app.post("/api/send-code", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !email.includes("@")) return res.status(400).json({ error: "valid email is required" });

    const code = String(Math.floor(1000 + Math.random() * 9000));
    verificationCodes.set(email, { code, expiresAt: Date.now() + 10 * 60 * 1000 });

    await sendEmail(email, "كود التحقق — Kanaf", `كود التحقق الخاص بك هو: ${code}\nصالح لمدة 10 دقائق.`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

app.post("/api/verify-code", (req, res) => {
  const { email, code } = req.body || {};
  const entry = verificationCodes.get(email);
  if (!entry || entry.expiresAt < Date.now()) return res.json({ verified: false, reason: "expired_or_missing" });
  const ok = entry.code === code;
  if (ok) verificationCodes.delete(email);
  res.json({ verified: ok });
});

/* ---------------------------------------------------------
   POST /api/contact  { name, email, message }
--------------------------------------------------------- */
app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) return res.status(400).json({ error: "name, email, and message are required" });

    await sendEmail(
      process.env.EMAIL_FROM || "you@yourdomain.com",
      `رسالة تواصل جديدة من ${name}`,
      `From: ${name} <${email}>\n\n${message}`
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  }
});

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

app.use("/admin", adminRouter);
app.use("/api/payments", paymentsRouter);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Kanaf backend running on port ${PORT}`));
