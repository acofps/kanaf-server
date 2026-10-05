import express from "express";
import crypto from "node:crypto";
import { query } from "../db/pool.js";
import { sweepDueCampaigns } from "../notifications/scheduler.js";
import { sweepDailyReminders } from "../notifications/reminders.js";

/* ============================================================
   نقطة تشغيل محمية للمجدول + تنظيف الرموز المنتهية
   KANAF-ORD-0001: R15-14 · R15-15 · X10

   ------------------------------------------------------------
   لماذا
   ------------------------------------------------------------
   المسح كان يعمل على هامش طلبات المستخدمين فقط (sweepMiddleware):
   بلا حركة مرور لا تذكير ولا حملة مجدولة. هذه النقطة تسمح لمشغّل
   خارجي بسيط (Render Cron Job أو cron على cPanel أو أي خدمة تنادي
   عنواناً) بتشغيل نفس الدالتين في موعدهما — بلا Redis ولا Queue.

   ------------------------------------------------------------
   الحماية
   ------------------------------------------------------------
   • سرّ مستقل SWEEP_TRIGGER_TOKEN (لا SETUP_TOKEN: ذاك يفتح إنشاء
     المالك والترحيلات، ولا يجوز أن يقيم في مهمة دورية).
   • غيابه = النقطة معطّلة (404) — السلوك الحالي للإنتاج لا يتغيّر.
   • الرمز في ترويسة X-Sweep-Token فقط (لا في العنوان فيُكتب في السجلات)،
     ومقارنته بزمن ثابت.
   • التشغيل نفسه آمن للتكرار والتزامن: الأقفال الاستشارية في
     الدالتين تجعل النداء الثاني ينسحب، وقيود الفرادة تمنع التكرار.
   تفعيل المشغّل الخارجي قرار تشغيلي (D-07 في الأمر) — الكود جاهز.

   ------------------------------------------------------------
   التنظيف (R15-15)
   ------------------------------------------------------------
   يحذف بدفعات محدودة: أكواد التحقق المنتهية أو المستهلكة، وجلسات
   التجديد الملغاة أو المنتهية — الأقدم من AUTH_CLEANUP_RETENTION_DAYS.
   لا يمسّ جلسة فعّالة (غير ملغاة ولم تنتهِ) ولا كوداً صالحاً أبداً.
   غياب المتغيّر = لا تنظيف إطلاقاً: مدة الاحتفاظ قرار سياسة (D-01).
   ============================================================ */
export const internalRouter = express.Router();

const state = {
  lastRunAt: null, lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null,
  lastResult: null, runs: 0,
};
export function internalSweepState() { return { ...state }; }

function tokenOk(req) {
  const expected = process.env.SWEEP_TRIGGER_TOKEN;
  const given = String(req.headers["x-sweep-token"] || "");
  if (!expected || expected.length < 24 || !given) return false;
  const h = (v) => crypto.createHash("sha256").update(v).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}

export async function cleanupExpiredAuthArtifacts({ retentionDays, batch = 500, maxBatches = 20 } = {}) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("retention_days_required");
  const counts = { verification_codes: 0, sessions: 0, batches: 0 };
  for (let i = 0; i < maxBatches; i++) {
    const a = await query(
      `DELETE FROM email_verification_codes WHERE id IN (
         SELECT id FROM email_verification_codes
         WHERE (consumed_at IS NOT NULL OR expires_at < now())
           AND created_at < now() - ($1 || ' days')::interval
         LIMIT $2)`, [String(retentionDays), batch]);
    const b = await query(
      `DELETE FROM user_sessions WHERE id IN (
         SELECT id FROM user_sessions
         WHERE (revoked_at IS NOT NULL OR expires_at < now())
           AND COALESCE(revoked_at, expires_at) < now() - ($1 || ' days')::interval
         LIMIT $2)`, [String(retentionDays), batch]);
    counts.verification_codes += a.rowCount; counts.sessions += b.rowCount; counts.batches++;
    if (a.rowCount < batch && b.rowCount < batch) break;
  }
  return counts;
}

internalRouter.post("/sweep", async (req, res) => {
  if (!process.env.SWEEP_TRIGGER_TOKEN) return res.status(404).json({ error: "not_found" });
  if (!tokenOk(req)) return res.status(403).json({ error: "invalid_token" });
  state.lastRunAt = new Date().toISOString(); state.runs++;
  try {
    const campaigns = await sweepDueCampaigns();
    const reminders = await sweepDailyReminders();
    const days = process.env.AUTH_CLEANUP_RETENTION_DAYS ? Number(process.env.AUTH_CLEANUP_RETENTION_DAYS) : null;
    const cleanup = days ? await cleanupExpiredAuthArtifacts({ retentionDays: days }) : { skipped: "AUTH_CLEANUP_RETENTION_DAYS غير مضبوط (D-01)" };
    state.lastSuccessAt = new Date().toISOString();
    state.lastResult = {
      campaigns: { swept: campaigns.swept ?? 0, skipped: Boolean(campaigns.skipped) },
      reminders: { swept: reminders.swept ?? 0, failed: reminders.failed ?? 0, skipped: Boolean(reminders.skipped) },
      cleanup,
    };
    res.json({ ok: true, ...state.lastResult });
  } catch (err) {
    state.lastFailureAt = new Date().toISOString();
    state.lastFailureReason = String(err.code || err.name || "error");
    console.error("[internal/sweep]", err.message);
    res.status(500).json({ error: "sweep_failed" });
  }
});

/* ============================================================
   X10 — جاهزية مفصولة عن الحياة.
   /api/health كما هو (حيّ = العملية تستجيب) لأن Render يفحصه.
   /api/ready يفحص القاعدة بقراءة واحدة ويعرض آخر نجاح/فشل للمجدول
   الخارجي — بلا أسرار ولا بيانات مستخدمين ولا عدّادات أعمال.
   ============================================================ */
internalRouter.get("/ready", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    await query("SELECT 1");
    res.json({ ok: true, db: "ok", sweep: { lastSuccessAt: state.lastSuccessAt, lastFailureAt: state.lastFailureAt }, version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || null });
  } catch {
    res.status(503).json({ ok: false, db: "unreachable" });
  }
});
