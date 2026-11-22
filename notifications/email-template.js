import { query } from "../db/pool.js";
import { KANAF_LOGO_PNG_BASE64 } from "../invoicing/assets/logo.js";

/* ============================================================
   قالب البريد الموحّد — KANAF-ORD-0008 §9

   قالب واحد لرسائل النظام والحملات معاً. ما كان قائماً قبله:
   wrapAsHtml داخل notifications/service.js للحملات وحدها، ورسائل النظام
   نصاً بلا HTML. هذا يحلّ محلّ الأول ويُضاف إلى الثانية، ولا طبقة إرسال
   ثانية: الإرسال كما هو في mail/send.js.

   • الشعار مضمَّن مرفقاً (cid) لا رابطاً من الشبكة — كثير من عملاء البريد
     يحجب الصور الخارجية. وهو صورة الشعار نفسها المضمَّنة في الفاتورة.
   • ألوان العلامة (brand-600 للعنوان، brand-50 للخلفية)، وعرض يتسع للجوال.
   • التذييل: زرّا المتجرين ثم حسابات X وإنستقرام وتيك توك — كلٌّ يظهر
     فقط إن ضُبط رابطه في الإعدادات. لا رابط مخمَّن، ولا شعار مقلَّد:
     الأزرار نصية حتى تصل ملفات الشارات الرسمية (§9.3).
   • رابط إلغاء الاشتراك إلزامي في التسويقية، ولا يظهر في رسائل الخدمة.
   • كل نص مُهرَّب؛ والروابط داخل النص تُحوَّل روابطَ بعد التهريب.
   ============================================================ */

export const LOGO_CID = "tanaffus-logo";
const LOGO_BUFFER = Buffer.from(KANAF_LOGO_PNG_BASE64, "base64");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const linkify = (escaped) => escaped.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#735890;word-break:break-all;">${u}</a>`);
const HANDLE_RE = /^@?[A-Za-z0-9._]{1,30}$/;

/** روابط التذييل من app_settings. ما لم يُضبط لا يظهر. لا يرمي. */
export async function footerLinks() {
  try {
    const { rows } = await query(
      `SELECT key, value FROM app_settings WHERE key IN ('app_store_url','google_play_url','social_x_handle','social_instagram_handle','social_tiktok_handle')`);
    const v = Object.fromEntries(rows.map((r) => [r.key, typeof r.value === "string" ? r.value.trim() : null]));
    const handle = (h) => (h && HANDLE_RE.test(h) ? h.replace(/^@/, "") : null);
    const store = (u, host) => { try { const x = new URL(u); return x.protocol === "https:" && x.hostname === host ? x.toString() : null; } catch { return null; } };
    const x = handle(v.social_x_handle), ig = handle(v.social_instagram_handle), tt = handle(v.social_tiktok_handle);
    return {
      appStore: v.app_store_url ? store(v.app_store_url, "apps.apple.com") : null,
      googlePlay: v.google_play_url ? store(v.google_play_url, "play.google.com") : null,
      social: [
        x && { label: "X", url: `https://x.com/${x}` },
        ig && { label: "Instagram", url: `https://www.instagram.com/${ig}` },
        tt && { label: "TikTok", url: `https://www.tiktok.com/@${tt}` },
      ].filter(Boolean),
    };
  } catch { return { appStore: null, googlePlay: null, social: [] }; }
}

/**
 * يبني البريد. kind: "service" (تحقق، استعادة، دعوة…) أو "marketing" (حملة).
 * يعيد { html, attachments } لتمريرهما إلى sendEmail كما هما.
 */
/* KANAF-ORD-0013 §9: accent من قالب مختار — لوحة مقيدة بقيد في القاعدة (الترحيل 025)، كلها داكنة
   تباينها على الأبيض فوق 4.5:1. الافتراضي هو اللون نفسه الذي كان ثابتاً هنا. */
const ACCENTS = new Set(["#735890", "#594372", "#402F53", "#1C1626"]);
export function renderEmail({ title, text, kind = "service", unsubscribeUrl = null, footerNote = "", links = { appStore: null, googlePlay: null, social: [] }, accent = "#735890" }) {
  if (!ACCENTS.has(accent)) accent = "#735890";
  if (kind === "marketing" && !unsubscribeUrl) throw new Error("renderEmail: marketing e-mail requires an unsubscribe link");
  const paragraphs = String(text || "").split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;">${linkify(esc(p)).replace(/\n/g, "<br>")}</p>`).join("");
  const storeBtn = (url, label) => url
    ? `<a href="${esc(url)}" style="display:inline-block;margin:4px;padding:9px 16px;border:1px solid #D9CDE7;border-radius:10px;color:#1C1626;text-decoration:none;font-size:13px;font-weight:bold;background:#FFFFFF;">${label}</a>` : "";
  const stores = storeBtn(links.appStore, "App Store") + storeBtn(links.googlePlay, "Google Play");
  const social = links.social.map((s) => `<a href="${esc(s.url)}" style="color:#5B5168;text-decoration:none;margin:0 8px;font-size:12px;">${esc(s.label)}</a>`).join("");
  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#F6F2FA;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F2FA;"><tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:Tahoma,Arial,sans-serif;direction:rtl;text-align:right;">
    <tr><td align="center" style="padding:0 0 16px;"><img src="cid:${LOGO_CID}" alt="تنفس" width="40" height="61" style="display:block;border:0;"></td></tr>
    <tr><td style="background:#FFFFFF;border:1px solid #ECE4F4;border-radius:14px;padding:24px;color:#1C1626;font-size:15px;line-height:1.8;">
      <h1 style="margin:0 0 14px;font-size:18px;color:${accent};">${esc(title)}</h1>
      ${paragraphs}
    </td></tr>
    ${stores ? `<tr><td align="center" style="padding:18px 0 4px;">${stores}</td></tr>` : ""}
    ${social ? `<tr><td align="center" style="padding:6px 0;">${social}</td></tr>` : ""}
    ${footerNote ? `<tr><td align="center" style="padding:10px 0 0;color:#5B5168;font-size:12px;">${esc(footerNote)}</td></tr>` : ""}
    ${kind === "marketing" ? `<tr><td align="center" style="padding:10px 0 0;font-size:12px;"><a href="${esc(unsubscribeUrl)}" style="color:#5B5168;">إلغاء الاشتراك من هذه الرسائل</a></td></tr>` : ""}
  </table>
</td></tr></table>
</body></html>`;
  return { html, attachments: [{ filename: "tanaffus.png", content: LOGO_BUFFER, cid: LOGO_CID, contentType: "image/png" }] };
}

/** معاملات sendEmail الإضافية لرسالة خدمة (تحقق، استعادة، دعوة) — بلا رابط إلغاء اشتراك. */
export async function serviceEmailExtra(subject, text) {
  return renderEmail({ title: subject, text, kind: "service", links: await footerLinks() });
}
