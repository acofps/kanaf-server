import express from "express";
import { query } from "../db/pool.js";
import { requireAdminAuth, requirePermission, requireReasonAndLog, fail } from "./middleware.js";
import { readPaging } from "./filters.js";

/* ============================================================
   الرسائل المرسلة — KANAF-ORD-0008 §3

   صفحة واحدة لكل رسالة خرجت إلى مستخدم، من ثلاثة مصادر قائمة —
   لا نظام إرسال موازٍ ولا جدول نسخ:
     campaign · notification_deliveries (كل قناة، بحالة التسليم الحقيقية)
     inbox    · user_notifications بلا الحملات (التذكير اليومي وإشعارات النظام)
     system   · system_message_log (بريد التحقق والاستعادة… ودفعة التذكير) — بلا نص

   🔴 القواعد:
   • المستلم يُقنَّع هنا في الخادم (a***@domain) — لا عنوان كامل يصل المتصفح.
   • رسائل النظام لا نص لها في أي مكان (الترحيل 016)؛ يعود بدله
     body_withheld = true ونص ثابت. لا كود تحقق ولا رابط إعادة تعيين.
   • سبب الفشل يُعاد بعد تقنيع أي عنوان بريد فيه (أخطاء SMTP تحمله أحياناً).
   • الفتح قراءة لبيانات شخصية: صلاحية notifications:view_sent، وسبب مكتوب
     يُسجَّل في سجل الوصول قبل إعادة أي صف (requireReasonAndLog).
   ============================================================ */

export const sentMessagesRouter = express.Router();

const MASK = (col) => `regexp_replace(${col}, '(^.).*(@.*$)', '\\1***\\2')`;
const maskEmails = (s) => (s == null ? s : String(s).replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+)/g, "$1***@$2"));

export const WITHHELD_NOTE = {
  email_verification: "رسالة تحقق — محتواها لا يُخزَّن",
  password_reset: "رسالة استعادة كلمة المرور — محتواها لا يُخزَّن",
  existing_account_notice: "إشعار «عندك حساب مسبقاً» — محتواه لا يُخزَّن",
  daily_reminder: "تذكير يومي على الجهاز — نصّه الثابت في صندوق التطبيق",
};

const UNION = `
  SELECT d.id, 'campaign'::text AS source, 'campaign'::text AS kind, d.channel, d.status,
         d.error_code, d.error_detail, COALESCE(d.last_attempt_at, d.created_at) AS at,
         d.user_id, c.title, c.body, c.id AS campaign_id
  FROM notification_deliveries d JOIN notification_campaigns c ON c.id = d.campaign_id
  UNION ALL
  SELECT n.id, 'inbox', CASE WHEN n.dedup_key LIKE 'daily_checkin:%' THEN 'daily_reminder' ELSE 'system_notice' END,
         'in_app', 'delivered', NULL, NULL, n.created_at, n.user_id, n.title, n.body, NULL
  FROM user_notifications n WHERE n.source <> 'campaign'
  UNION ALL
  SELECT s.id, 'system', s.kind, s.channel, s.status, s.error_code, NULL, s.created_at, s.user_id, NULL, NULL, NULL
  FROM system_message_log s`;

const FILTERS = {
  source: ["campaign", "inbox", "system"],
  channel: ["in_app", "email", "push"],
  status: ["queued", "processing", "sent", "delivered", "failed", "skipped"],
};

// GET /admin/sent-messages?reason=…&source=&channel=&status=&page=&pageSize=
sentMessagesRouter.get(
  "/sent-messages",
  requireAdminAuth, requirePermission("notifications:view_sent"),
  requireReasonAndLog("view_sent_messages", { resolveTargetUserId: () => null }),
  async (req, res) => {
    try {
      const { page, pageSize, offset } = readPaging(req, { defaultSize: 25, maxSize: 100 });
      const where = [];
      const params = [];
      for (const [k, allowed] of Object.entries(FILTERS)) {
        const v = String(req.query[k] || "");
        if (!v) continue;
        if (!allowed.includes(v)) return res.status(400).json({ error: `invalid_${k}` });
        params.push(v); where.push(`m.${k} = $${params.length}`);
      }
      const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM (${UNION}) m ${w}`, params);
      params.push(pageSize, offset);
      const { rows } = await query(
        `SELECT m.id, m.source, m.kind, m.channel, m.status, m.error_code, m.error_detail, m.at,
                m.title, m.body, m.campaign_id, u.name AS user_name, ${MASK("u.email")} AS user_email_masked
         FROM (${UNION}) m JOIN users u ON u.id = m.user_id
         ${w}
         ORDER BY m.at DESC, m.id
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      res.json({
        messages: rows.map((r) => {
          const withheld = r.source === "system";
          return {
            id: r.id, source: r.source, kind: r.kind, channel: r.channel, status: r.status, at: r.at,
            recipient: { name: r.user_name, emailMasked: r.user_email_masked },
            campaignId: r.campaign_id,
            title: withheld ? null : r.title,
            body: withheld ? null : r.body,
            bodyWithheld: withheld,
            withheldNote: withheld ? (WITHHELD_NOTE[r.kind] || "رسالة نظام — محتواها لا يُخزَّن") : null,
            errorCode: r.error_code,
            errorDetail: maskEmails(r.error_detail),
          };
        }),
        page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
      });
    } catch (err) {
      return fail(res, err, "admin/sent-messages", req);
    }
  }
);
