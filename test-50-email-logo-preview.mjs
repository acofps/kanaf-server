import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0015 §2.1 — شعار القالب الموحّد.
 *  P) 🔴 لا نصّ قالب يخرج إلى المعاينة وفيه cid: — لكل رسالة نظام × كل قالب محفوظ؛ والشعار مصدر يفهمه المتصفّح.
 *  S) البريد الحقيقي كما هو: cid: والصورة مرفقة بالمعرّف نفسه — القالب واحد، والمرجع وحده يختلف.
 *  L) الشعار هو العلامة المعتمدة نفسها (لم يتغيّر ملفه، فالفاتورة الضريبية لم تتغيّر).
 */
requireDedicatedDatabase(import.meta.url);
import crypto from "node:crypto";
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { messageCatalogRouter } = await import("./admin/message-catalog.js");
const { MESSAGES, renderMessage } = await import("./notifications/messages.js");
const { renderEmail, LOGO_CID } = await import("./notifications/email-template.js");
const { KANAF_LOGO_PNG_BASE64 } = await import("./invoicing/assets/logo.js");
for (const k of ["error", "warn"]) console[k] = () => {};

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/admin", messageCatalogRouter);
const server = app.listen(4650); const B = "http://127.0.0.1:4650";
try {
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('معاينة','logo-preview@kanaf.test','x','owner') RETURNING id`);
  const cookie = `kanaf_admin_access=${jwt.sign({ sub: a.id, role: "owner", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  await query(`INSERT INTO message_templates (name, accent, footer_note, show_store_links, show_social_links) VALUES ('قالب ثانٍ', '#402F53', 'تذييل', false, false)`);
  const templates = (await query(`SELECT id, is_default FROM message_templates`)).rows;
  const keys = Object.keys(MESSAGES);
  const bad = [], srcs = new Set();
  for (const key of keys) for (const t of templates) {
    const r = await fetch(`${B}/admin/message-catalog/${key}/preview`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ templateId: t.is_default ? null : t.id }) });
    const j = await r.json();
    if (r.status !== 200 || /cid:/i.test(j.html || "x cid:")) bad.push(`${key}/${t.is_default ? "default" : "custom"}:${r.status}`);
    for (const m of (j.html || "").matchAll(/<img[^>]+src="([^"]+)"/g)) srcs.add(m[1].slice(0, 40));
  }
  ok(`P1 🔴 لا cid: في أي معاينة (${keys.length} رسالة × ${templates.length} قالب)`, bad.length === 0 && keys.length >= 10, bad.join(" "));
  ok("P2 الشعار في المعاينة صورة PNG مضمَّنة (data:) يعرضها المتصفّح", srcs.size === 1 && [...srcs][0].startsWith("data:image/png;base64,iVBOR"), [...srcs].join(" "));

  const mail = await renderMessage("email_verification", { name: "س", code: "123456" });
  ok("S1 البريد المُرسَل كما كان: cid: والصورة مرفقة بالمعرّف نفسه", mail.extra.html.includes(`src="cid:${LOGO_CID}"`) && mail.extra.attachments.length === 1 && mail.extra.attachments[0].cid === LOGO_CID && !mail.extra.html.includes("data:image"));
  const one = renderEmail({ title: "ع", text: "ن" }), two = renderEmail({ title: "ع", text: "ن", logo: "inline" });
  ok("S2 بناء واحد: الفرق بين البريد والمعاينة مرجع الصورة وحده", one.html.replace(`cid:${LOGO_CID}`, "X") === two.html.replace(`data:image/png;base64,${KANAF_LOGO_PNG_BASE64}`, "X") && two.attachments.length === 0);
  let threw = false; try { renderEmail({ title: "ع", text: "ن", logo: "https://evil" }); } catch { threw = true; }
  ok("S3 مرجع غير معروف يُرفض (لا رابط خارجي يتسلّل)", threw);

  const png = Buffer.from(KANAF_LOGO_PNG_BASE64, "base64");
  const sha = crypto.createHash("sha256").update(png).digest("hex");
  ok("L1 ملف الشعار هو العلامة المعتمدة كما هي (153×232، 33,897 بايتاً) — لم يتغيّر، فالفاتورة لم تتغيّر",
    sha === "cf25df324fd0e969840fac83952ef4986d85d494ba5de6adcc7ab0020b187281" && png.length === 33897 && png.readUInt32BE(16) === 153 && png.readUInt32BE(20) === 232, sha);
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 400), false); }
finally { server.close(); await pool.end().catch(() => {}); }
let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 400)})` : ""}`); } }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
