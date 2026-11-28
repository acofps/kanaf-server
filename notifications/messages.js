import { query } from "../db/pool.js";
import { renderEmail, footerLinks } from "./email-template.js";

/* ============================================================
   رسائل النظام: النص والقالب والقنوات — KANAF-ORD-0013 §9

   سجلّ واحد لكل رسالة يرسلها النظام (الجرد في docs/ord-0013/MESSAGES_INVENTORY.md).
   لكل رسالة: نصّ افتراضي في الكود (كان مطابقاً حرفاً لما يُرسل قبل هذا الأمر، ثم صار الاسم فيه «تنفس بحرية» — ملحق ORD-0013 الثاني، القرار 5)،
   ومواضع ({{code}}…) معروفة، وأخرى إلزامية، وقنوات مسموحة وأخرى إلزامية.

   ما يحفظه المالك في message_definitions يعلو الافتراضي. وغياب الصف = الافتراضي،
   فلا يتغيّر شيء على الإنتاج قبل أن يعدّل أحد.

   🔴 9.2 العناصر الإلزامية محروسة عند الحفظ: نص تحقق بلا {{code}} يُرفض — محرِّر
      يسمح بحذفه يعطّل التسجيل بضغطة. وموضع مجهول يُرفض أيضاً (لا يُرسل «{{password}}»).
   🔴 9.3 لا نص مُرسل يُخزَّن: يُعرض هنا ويُرسل، ولا يُكتب في أي سجل.
   ============================================================ */

const VERIFY = `أهلاً {{name}}،

كود تأكيد بريدك في تنفس بحرية: {{code}}

الكود صالح لمدة {{minutes}} دقائق.
إذا ما طلبت هذا الكود، تجاهل الرسالة ولا تشاركها مع أحد.

فريق تنفس بحرية
tanfs.net`;

const RESET = `أهلاً {{name}}،

كود استعادة كلمة المرور في تنفس بحرية: {{code}}

الكود صالح لمدة {{minutes}} دقائق، ويُستخدم مرة واحدة.
إذا ما طلبت استعادة كلمة المرور، تجاهل الرسالة — كلمة مرورك ما تغيّرت ولا يحتاج منك أي إجراء.

فريق تنفس بحرية
tanfs.net`;

const EXISTING = `أهلاً {{name}}،

وصلنا طلب إنشاء حساب في تنفس بحرية بهذا البريد، وعندك حساب مسجّل مسبقاً.

لو كنت أنت: سجّل الدخول مباشرة من app.tanfs.net
لو ما كنت أنت: ما صار شيء، حسابك بأمان ولا يحتاج أي إجراء.

فريق تنفس بحرية
tanfs.net`;

const ADMIN_INVITE = `مرحباً {{name}}،

أُنشئ لك حساب في لوحة إدارة تنفس بحرية بصلاحية «{{role}}».

لتفعيل حسابك واختيار كلمة مرورك، افتح الرابط التالي:

{{url}}

الرابط صالح {{hours}} ساعة ولمرة واحدة. لو انتهى، اطلب من المالك إعادة إرسال الدعوة.

إذا ما كنت تتوقع هذه الرسالة، تجاهلها — الحساب لا يعمل قبل فتح الرابط.

فريق تنفس بحرية`;

const ADMIN_RESET = `مرحباً {{name}}،

وصلنا طلب لإعادة ضبط كلمة مرور حسابك في لوحة إدارة تنفس بحرية.

{{url}}

الرابط صالح {{hours}} ساعة ولمرة واحدة.

إذا ما طلبت هذا، تجاهل الرسالة — كلمة مرورك الحالية ما زالت تعمل، ويُستحسن تخبر المالك.

فريق تنفس بحرية`;

const RENEWAL_NOTICE = `أهلاً {{name}}،

اشتراكك في «{{plan}}» يتجدّد تلقائياً في {{date}}، ويُخصم {{amount}} من بطاقتك المنتهية بـ{{card_last4}}.

لو ما تبغى التجديد، ألغِ التجديد التلقائي من صفحتك الشخصية في التطبيق قبل هذا التاريخ. اشتراكك الحالي يبقى إلى نهايته.

فريق تنفس بحرية`;

const RENEWAL_SUCCEEDED = `أهلاً {{name}}،

تجدّد اشتراكك في «{{plan}}» حتى {{date}}، وخُصم {{amount}}. فاتورتك: {{invoice_number}}.

فريق تنفس بحرية`;

const RENEWAL_FAILED = `أهلاً {{name}}،

ما قدرنا نجدّد اشتراكك في «{{plan}}»: البطاقة المنتهية بـ{{card_last4}} لم تقبل الخصم.

نحاول مرة أخرى في {{next_attempt}}. تقدر تحدّث بطاقتك أو تجدّد يدوياً من التطبيق.

فريق تنفس بحرية`;

const RENEWAL_STOPPED = `أهلاً {{name}}،

توقّف التجديد التلقائي لاشتراكك في «{{plan}}» بعد محاولات لم تنجح. اشتراكك يبقى حتى نهاية فترته، وتقدر تجدّد يدوياً من التطبيق في أي وقت.

فريق تنفس بحرية`;

/* KANAF-ORD-0023 ب-3: إخطار العميل بأن الدعم عيّن كلمة مروره — بلا الكلمة نفسها ولا أي جزء منها. */
const PASSWORD_SET_BY_SUPPORT = `أهلاً {{name}}،

غيّر فريق الدعم كلمة مرور حسابك في تنفس بحرية بطلبٍ منك، وأُنهيت جلساتك المفتوحة على كل الأجهزة.

ادخل بكلمة المرور التي أبلغك بها الدعم، وتقدر تغيّرها متى شئت من صفحتك في التطبيق.

إذا ما طلبت هذا، راسلنا فوراً بالرد على هذه الرسالة.

فريق تنفس بحرية`;

/** السجلّ. audience: member (عضو) أو staff (موظف). push/in_app يستعملان subject عنواناً وbody نصاً. */
export const MESSAGES = {
  email_verification: { label: "كود التحقق من البريد", audience: "member", allowed: ["email"], required: ["email"], defaults: ["email"], subject: "كود التحقق — تنفس بحرية", body: VERIFY, vars: ["name", "code", "minutes"], must: ["code"], sample: { name: "سارة", code: "482913", minutes: 10 } },
  password_reset: { label: "كود استعادة كلمة المرور", audience: "member", allowed: ["email"], required: ["email"], defaults: ["email"], subject: "استعادة كلمة المرور — تنفس بحرية", body: RESET, vars: ["name", "code", "minutes"], must: ["code"], sample: { name: "سارة", code: "482913", minutes: 10 } },
  existing_account_notice: { label: "إشعار «عندك حساب مسبقاً»", audience: "member", allowed: ["email"], required: ["email"], defaults: ["email"], subject: "محاولة إنشاء حساب — تنفس بحرية", body: EXISTING, vars: ["name"], must: [], sample: { name: "سارة" } },
  admin_invite: { label: "دعوة حساب إدارة", audience: "staff", allowed: ["email"], required: ["email"], defaults: ["email"], subject: "دعوة إلى لوحة إدارة تنفس بحرية", body: ADMIN_INVITE, vars: ["name", "url", "hours", "role"], must: ["url"], sample: { name: "أحمد", url: "https://kanaf-server.onrender.com/?setup=example", hours: 48, role: "محاسب" } },
  admin_password_reset: { label: "إعادة ضبط كلمة مرور الإدارة", audience: "staff", allowed: ["email"], required: ["email"], defaults: ["email"], subject: "إعادة ضبط كلمة مرور لوحة تنفس بحرية", body: ADMIN_RESET, vars: ["name", "url", "hours"], must: ["url"], sample: { name: "أحمد", url: "https://kanaf-server.onrender.com/?setup=example", hours: 2 } },
  daily_reminder: { label: "التذكير اليومي", audience: "member", allowed: ["in_app", "push"], required: ["in_app"], defaults: ["in_app", "push"], subject: "وقت تسجيل يومك", body: "دقيقة وحدة بس: سجّل مزاجك ونومك وطاقتك، وخلّ بوصلتك تقرأ أسبوعك صح.", vars: [], must: [], sample: {} },
  renewal_notice: { label: "إشعار قبل التجديد التلقائي", audience: "member", allowed: ["email", "in_app", "push", "whatsapp", "sms"], required: ["email"], defaults: ["email", "in_app"], subject: "تجديد اشتراكك قريباً — تنفس بحرية", body: RENEWAL_NOTICE, vars: ["name", "plan", "date", "amount", "card_last4"], must: ["date", "amount"], sample: { name: "سارة", plan: "الباقة الشهرية", date: "2026-12-20", amount: "29.00 ر.س", card_last4: "4242" } },
  renewal_succeeded: { label: "تمّ التجديد التلقائي", audience: "member", allowed: ["email", "in_app", "push", "whatsapp", "sms"], required: ["email"], defaults: ["email", "in_app"], subject: "تجدّد اشتراكك — تنفس بحرية", body: RENEWAL_SUCCEEDED, vars: ["name", "plan", "date", "amount", "invoice_number"], must: ["invoice_number"], sample: { name: "سارة", plan: "الباقة الشهرية", date: "2027-01-20", amount: "29.00 ر.س", invoice_number: "TNFS-INV-000042" } },
  renewal_failed: { label: "فشل التجديد التلقائي", audience: "member", allowed: ["email", "in_app", "push", "whatsapp", "sms"], required: ["email"], defaults: ["email", "in_app"], subject: "تعذّر تجديد اشتراكك — تنفس بحرية", body: RENEWAL_FAILED, vars: ["name", "plan", "card_last4", "next_attempt"], must: [], sample: { name: "سارة", plan: "الباقة الشهرية", card_last4: "4242", next_attempt: "2026-12-22" } },
  password_set_by_support: { label: "تغيير كلمة المرور من الدعم", audience: "member", allowed: ["email"], required: ["email"], defaults: ["email"], subject: "تغيّرت كلمة مرور حسابك — تنفس بحرية", body: PASSWORD_SET_BY_SUPPORT, vars: ["name"], must: [], sample: { name: "سارة" } },
  renewal_stopped: { label: "توقّف التجديد التلقائي", audience: "member", allowed: ["email", "in_app", "push", "whatsapp", "sms"], required: ["email"], defaults: ["email", "in_app"], subject: "توقّف التجديد التلقائي — تنفس بحرية", body: RENEWAL_STOPPED, vars: ["name", "plan"], must: [], sample: { name: "سارة", plan: "الباقة الشهرية" } },
};

const PH = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** 9.2: يعيد رمز الخطأ أو null. */
export function validateMessageText(key, subject, body) {
  const def = MESSAGES[key];
  if (!def) return { error: "unknown_message" };
  const all = `${subject ?? ""}\n${body ?? ""}`;
  const used = [...all.matchAll(PH)].map((m) => m[1]);
  const unknown = used.filter((v) => !def.vars.includes(v));
  if (unknown.length) return { error: "unknown_placeholder", detail: [...new Set(unknown)] };
  const missing = def.must.filter((v) => !String(body ?? "").includes(`{{${v}}}`) && !new RegExp(`\\{\\{\\s*${v}\\s*\\}\\}`).test(String(body ?? "")));
  if (missing.length) return { error: "required_placeholder_missing", detail: missing.map((v) => `{{${v}}}`) };
  return null;
}

export function fill(text, vars) {
  return String(text ?? "").replace(PH, (_, k) => (vars[k] === undefined || vars[k] === null ? "" : String(vars[k])));
}

async function loadTemplate(id) {
  const { rows } = await query(
    `SELECT id, name, accent, footer_note, show_store_links, show_social_links, is_default FROM message_templates
      WHERE ($1::uuid IS NOT NULL AND id = $1) OR is_default ORDER BY (id = $1) DESC NULLS LAST LIMIT 1`, [id || null]);
  return rows[0] || null;
}

/** التعريف الفعلي: ما حفظه المالك فوق الافتراضي. لا يرمي — عند أي خطأ قراءة يعود الافتراضي. */
export async function effectiveDefinition(key) {
  const def = MESSAGES[key];
  if (!def) throw new Error(`unknown message: ${key}`);
  let row = null;
  try { row = (await query(`SELECT subject, body, template_id, channels FROM message_definitions WHERE key = $1`, [key])).rows[0] || null; }
  catch { row = null; }
  return {
    key, label: def.label,
    subject: row?.subject || def.subject,
    body: row?.body || def.body,
    templateId: row?.template_id || null,
    channels: Array.isArray(row?.channels) ? row.channels : [...def.defaults],
    customized: Boolean(row),
  };
}

/** HTML بالقالب المختار — نفس renderEmail بخصائص القالب. */
export async function renderWithTemplate({ subject, text, templateId, kind = "service", logo = "cid" }) {
  const t = await loadTemplate(templateId).catch(() => null);
  const links = await footerLinks();
  return renderEmail({
    title: subject, text, kind, logo,
    footerNote: t?.footer_note || "",
    accent: t?.accent || undefined,
    links: { appStore: t && !t.show_store_links ? null : links.appStore, googlePlay: t && !t.show_store_links ? null : links.googlePlay, social: t && !t.show_social_links ? [] : links.social },
  });
}

/** { subject, text, extra: {html, attachments}, channels } جاهزة للإرسال. */
export async function renderMessage(key, vars = {}, override = null, { logo = "cid" } = {}) {
  const d = override ? { ...(await effectiveDefinition(key)), ...override } : await effectiveDefinition(key);
  const subject = fill(d.subject, vars);
  const text = fill(d.body, vars);
  const extra = await renderWithTemplate({ subject, text, templateId: d.templateId, logo });
  return { subject, text, extra, channels: d.channels, templateId: d.templateId };
}
