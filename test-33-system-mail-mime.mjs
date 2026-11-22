import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0010 §1 و§8.5 — رسالة نظام حقيقية كما تخرج من الكود.
 *
 *  لا نرسم القالب وحده: نشغّل مسار الإرسال الفعلي (sendSystemEmail ← mail/send.js
 *  ← nodemailer ← SMTP) إلى خادم SMTP محلي على loopback يستقبل الرسالة كاملة (MIME)،
 *  ثم نقرأ ما وصل فعلاً:
 *   M1 التسجيل يُخرج رسالة تحقق، ونصّها وجزء HTML منها موقَّعان «فريق تنفس بحرية / tanfs.net»
 *   M2 لا «kanaf.me» ولا «كنف» في أي جزء من الرسالة
 *   M3 إشعار «عندك حساب مسبقاً» يحيل إلى app.tanfs.net
 *   M4 المُرسِل من EMAIL_FROM والشعار مرفق cid
 *
 *  الحارس يفرّغ متغيّرات SMTP؛ تُضبط هنا بعده إلى المستقبِل المحلي وحده.
 *  KANAF_EVIDENCE_DIR (اختياري): يحفظ الرسالة الخام دليلاً للتسليم.
 */
requireDedicatedDatabase(import.meta.url);
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

/* ---- مستقبِل SMTP محلي بأبسط ما يكفي (بلا TLS، loopback فقط) ---- */
const inbox = [];
const smtpLog = [];
const smtp = net.createServer((sock) => {
  let buf = "", state = "cmd", msg = { from: "", to: [], data: "" };
  const say = (s) => { smtpLog.push("S: " + s.split("\r\n")[0]); sock.write(s + "\r\n"); };
  say("220 local-sink ESMTP");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    while (true) {
      if (state === "data") {
        const end = buf.indexOf("\r\n.\r\n");
        if (end === -1) return;
        msg.data = buf.slice(0, end).replace(/\r\n\.\./g, "\r\n."); buf = buf.slice(end + 5); state = "cmd";
        inbox.push(msg); msg = { from: "", to: [], data: "" }; say("250 OK queued");
        continue;
      }
      const i = buf.indexOf("\r\n");
      if (i === -1) return;
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      smtpLog.push("C: " + line.slice(0, 40));
      if (state === "auth-user") { state = "auth-pass"; say("334 UGFzc3dvcmQ6"); continue; }
      if (state === "auth-pass") { state = "cmd"; say("235 ok"); continue; }
      const cmd = line.toUpperCase();
      if (cmd.startsWith("EHLO")) sock.write("250-local-sink\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (cmd.startsWith("HELO")) say("250 local-sink");
      else if (cmd.startsWith("AUTH PLAIN")) say("235 ok");
      else if (cmd.startsWith("AUTH LOGIN")) { state = "auth-user"; say("334 VXNlcm5hbWU6"); }
      else if (cmd.startsWith("MAIL FROM")) { msg.from = line; say("250 OK"); }
      else if (cmd.startsWith("RCPT TO")) { msg.to.push(line); say("250 OK"); }
      else if (cmd === "DATA") { state = "data"; say("354 end with ."); }
      else if (cmd === "QUIT") { say("221 bye"); sock.end(); }
      else say("250 OK");
    }
  });
});
await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
Object.assign(process.env, {
  SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.address().port), SMTP_USER: "noreply@tanfs.net", SMTP_PASS: "local-sink",
  EMAIL_FROM: "تنفس بحرية <noreply@tanfs.net>",
});

const express = (await import("express")).default;
const { query, pool } = await import("./db/pool.js");
const { authRouter } = await import("./auth/routes.js");

/* ---- تفكيك MIME بما يكفي: أجزاء النص وHTML بعد فكّ ترميزها ---- */
function parts(raw) {
  const out = [];
  const walk = (block) => {
    const sep = block.indexOf("\r\n\r\n");
    const head = block.slice(0, sep), body = block.slice(sep + 4);
    const type = /content-type:\s*([^;\r\n]+)/i.exec(head)?.[1]?.trim().toLowerCase() || "text/plain";
    const boundary = /boundary="?([^";\r\n]+)"?/i.exec(head)?.[1];
    if (type.startsWith("multipart/") && boundary) {
      for (const p of body.split(`--${boundary}`).slice(1)) if (!p.startsWith("--")) walk(p.replace(/^\r\n/, ""));
      return;
    }
    const enc = /content-transfer-encoding:\s*([^\s;]+)/i.exec(head)?.[1]?.toLowerCase();
    let text;
    if (enc === "base64") text = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    else if (enc === "quoted-printable") text = Buffer.from(body.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
    else text = body;
    out.push({ type, head, text });
  };
  walk(raw);
  return out;
}

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use("/api/auth", authRouter);
const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
const B = `http://127.0.0.1:${server.address().port}`;
const post = (p, b) => fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const waitMail = async (n) => { for (let i = 0; i < 100 && inbox.length < n; i++) await new Promise((r) => setTimeout(r, 30)); };

try {
  const EMAIL = "mime-check@example.com";
  let r = await post("/api/auth/register", { name: "سارة", email: EMAIL, password: "Tanfs-Mime-2026-a", confirmedAdult: true, agreedPolicy: true });
  await waitMail(1);
  ok("setup التسجيل 201 ووصلت رسالة إلى المستقبِل المحلي عبر SMTP", r.status === 201 && inbox.length === 1, `${r.status} inbox=${inbox.length} smtp=${smtpLog.join(" | ").slice(0, 300)}`);
  const raw = inbox[0]?.data || "";
  const ps = parts(raw);
  const textPart = ps.find((p) => p.type === "text/plain")?.text || "";
  const htmlPart = ps.find((p) => p.type === "text/html")?.text || "";
  if (process.env.KANAF_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.KANAF_EVIDENCE_DIR, "verification-email.eml"), raw);
  ok("M1 النص موقَّع «فريق تنفس بحرية» ثم «tanfs.net» في سطرين متتاليين", /فريق تنفس بحرية\r?\ntanfs\.net\s*$/.test(textPart.trim() + "\n"), JSON.stringify(textPart.slice(-60)));
  ok("M1b وجزء HTML يحمل التوقيع نفسه", htmlPart.includes("فريق تنفس بحرية") && htmlPart.includes("tanfs.net"));
  const all = textPart + htmlPart + raw;
  ok("M2 🔴 لا «kanaf.me» ولا «كنف» في أي جزء من الرسالة", !/kanaf\.me/i.test(all) && !all.includes("كنف"), (all.match(/.{0,30}(kanaf\.me|كنف).{0,30}/i) || [""])[0]);
  ok("M4 المُرسِل noreply@tanfs.net والشعار مرفق cid", /^from:.*noreply@tanfs\.net/im.test(raw) && /content-id:\s*<tanaffus-logo>/i.test(raw) && /cid:tanaffus-logo/.test(htmlPart));

  await query(`UPDATE users SET email_verified_at = now() WHERE email = $1`, [EMAIL]);
  r = await post("/api/auth/register", { name: "سارة", email: EMAIL, password: "Tanfs-Mime-2026-a", confirmedAdult: true, agreedPolicy: true });
  await waitMail(2);
  const notice = parts(inbox[1]?.data || "").find((p) => p.type === "text/plain")?.text || "";
  ok("M3 «عندك حساب مسبقاً» يحيل إلى app.tanfs.net وموقَّع tanfs.net", notice.includes("app.tanfs.net") && /tanfs\.net\s*$/.test(notice.trim()) && !/kanaf\.me/.test(notice), JSON.stringify(notice.slice(-120)));
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
server.close(); smtp.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
