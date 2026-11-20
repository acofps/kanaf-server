import { query } from "../db/pool.js";
import { sendEmail } from "../mail/send.js";
import { serviceEmailExtra } from "./email-template.js";

/* ============================================================
   سجل رسائل النظام — KANAF-ORD-0008 §3.4 و§1.1

   يسجّل أن رسالة نظام خرجت إلى مستخدم: النوع والقناة والحالة والوقت.
   🔴 لا يقبل نصاً ولا عنواناً ولا رمزاً، ولا يملك الجدول عموداً لأيٍّ
   منها (الترحيل 016). فلا طريق لكود تحقق أو رابط إعادة تعيين أن يُخزَّن
   هنا ولو أخطأ مستدعٍ لاحقاً.

   ولا يغيّر الإرسال نفسه: sendSystemEmail تنادي sendEmail بالمعاملات
   نفسها، وترمي ما ترميه، وتعيد ما تعيده. السجل يُكتب بعدها، وفشله
   يُبتلع ولا يُفشل الإرسال — ويُطبع سطرٌ بلا عنوان ولا نص.
   ============================================================ */

export const SYSTEM_MESSAGE_KINDS = ["email_verification", "password_reset", "existing_account_notice", "daily_reminder"];

/** يكتب صفاً واحداً. userId أو email (يُحلّ إلى المستخدم داخل الاستعلام). لا يرمي أبداً. */
export async function logSystemMessage({ userId = null, email = null, kind, channel, status, errorCode = null }) {
  try {
    if (!SYSTEM_MESSAGE_KINDS.includes(kind)) throw new Error(`unknown kind ${kind}`);
    await query(
      `INSERT INTO system_message_log (user_id, kind, channel, status, error_code)
       SELECT u.id, $3, $4, $5, $6 FROM users u
       WHERE ($1::uuid IS NOT NULL AND u.id = $1::uuid)
          OR ($1::uuid IS NULL AND LOWER(u.email) = LOWER($2) AND u.deleted_at IS NULL)
       LIMIT 1`,
      [userId, email, kind, channel, status, errorCode ? String(errorCode).slice(0, 60) : null]
    );
  } catch (err) {
    console.error(`[system-log] تعذّر تسجيل رسالة نظام (${kind}/${channel}):`, err?.code || "error");
  }
}

/**
 * sendEmail كما هي + سطر سجل بلا نص.
 * dev (لا SMTP خارج الإنتاج) = skipped، بنفس تسمية الحملات.
 */
export async function sendSystemEmail(kind, to, subject, text, extra = {}) {
  let result;
  // القالب الموحّد (§9): النص كما هو، ومعه نسخة HTML بالشعار — بلا رابط إلغاء اشتراك.
  const withHtml = extra.html ? extra : { ...(await serviceEmailExtra(subject, text)), ...extra };
  try {
    result = await sendEmail(to, subject, text, withHtml);
  } catch (err) {
    await logSystemMessage({ email: to, kind, channel: "email", status: "failed", errorCode: "send_error" });
    throw err;
  }
  await logSystemMessage({
    email: to, kind, channel: "email",
    status: result && result.dev ? "skipped" : "sent",
    errorCode: result && result.dev ? "mail_not_configured" : null,
  });
  return result;
}
