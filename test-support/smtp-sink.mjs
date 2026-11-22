/* مستقبِل SMTP محلي (loopback، بلا TLS) ومفكّك MIME بسيط — للاختبارات التي تحتاج
   رؤية البريد كما يخرج فعلاً. نفس آلية test-33 مستخرجةً لإعادة الاستعمال. */
import net from "node:net";

export async function startSmtpSink() {
  const inbox = [];
  const ctl = { reject: null }; // ctl.reject = (rcptLine) => true يرفض المستلم بـ550 (فشل تسليم حقيقي)
  const smtp = net.createServer((sock) => {
    let buf = "", state = "cmd", msg = { from: "", to: [], data: "" };
    const say = (s) => sock.write(s + "\r\n");
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
        if (state === "auth-user") { state = "auth-pass"; say("334 UGFzc3dvcmQ6"); continue; }
        if (state === "auth-pass") { state = "cmd"; say("235 ok"); continue; }
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) sock.write("250-local-sink\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (cmd.startsWith("HELO")) say("250 local-sink");
        else if (cmd.startsWith("AUTH PLAIN")) say("235 ok");
        else if (cmd.startsWith("AUTH LOGIN")) { state = "auth-user"; say("334 VXNlcm5hbWU6"); }
        else if (cmd.startsWith("MAIL FROM")) { msg.from = line; say("250 OK"); }
        else if (cmd.startsWith("RCPT TO")) { if (ctl.reject && ctl.reject(line)) say("550 mailbox unavailable"); else { msg.to.push(line); say("250 OK"); } }
        else if (cmd === "DATA") { state = "data"; say("354 end with ."); }
        else if (cmd === "QUIT") { say("221 bye"); sock.end(); }
        else say("250 OK");
      }
    });
  });
  await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.address().port), SMTP_USER: "noreply@tanfs.net", SMTP_PASS: "local-sink",
    EMAIL_FROM: "تنفس <noreply@tanfs.net>",
  });
  const waitMail = async (n) => { for (let i = 0; i < 150 && inbox.length < n; i++) await new Promise((r) => setTimeout(r, 30)); };
  return { inbox, waitMail, ctl, close: () => smtp.close() };
}

/** أجزاء الرسالة بعد فكّ ترميزها: [{type, head, text}] */
export function mimeParts(raw) {
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
