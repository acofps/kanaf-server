/* ============================================================
   قياس الإرسال الجماعي — KANAF-ORD-0001 R15-13 · X09
   (قياس لا اختبار نجاح/فشل)

     eval "$(node test-support/create-db.mjs measure)"
     node test-support/measure-campaign.mjs [inAppN=1000] [emailN=200] [smtpDelayMs=150]

   • مستخدمون اصطناعيون في قاعدة معزولة (الحارس أولاً).
   • مستقبِل SMTP محلي على loopback يتأخر smtpDelayMs لكل رسالة (يحاكي
     زمن خادم بريد حقيقي) — لا رسالة تغادر الجهاز.
   • يقيس: الزمن الكلي لـdispatchCampaign (وهو ما ينتظره طلب «إرسال الآن»
     في اللوحة اليوم)، أقصى RSS، أقصى تأخر لحلقة الأحداث، والحالة النهائية.
   ============================================================ */
import "./guard.mjs";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const [IN_APP_N = 1000, EMAIL_N = 200, DELAY = 150] = process.argv.slice(2).map(Number);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* مستقبِل SMTP بسيط */
let received = 0;
const smtp = net.createServer((sock) => {
  let inData = false, buf = "";
  sock.write("220 sink ESMTP\r\n");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === ".") { inData = false; received++; setTimeout(() => sock.write("250 queued\r\n"), DELAY); }
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250-sink\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (cmd === "AUTH") sock.write("235 ok\r\n");
      else if (cmd === "MAIL" || cmd === "RCPT" || cmd === "RSET" || cmd === "NOOP") sock.write("250 ok\r\n");
      else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
      else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("250 ok\r\n");
    }
  });
});
await new Promise((r) => smtp.listen(2525, "127.0.0.1", r));
process.env.SMTP_HOST = "127.0.0.1"; process.env.SMTP_PORT = "2525";
process.env.SMTP_USER = "sink"; process.env.SMTP_PASS = "sink"; process.env.EMAIL_FROM = "kanaf-test@localhost";
process.env.SERVER_BASE_URL = "http://127.0.0.1:3001";

const { query, pool } = await import("../db/pool.js");
const { dispatchCampaign } = await import("../notifications/service.js");

async function seedUsers(n, tag) {
  await query(`INSERT INTO users (name, email, password_hash, email_verified_at)
               SELECT 'm' || g, '${tag}-' || g || '@measure.invalid', 'x', now() FROM generate_series(1, $1) g`, [n]);
  return (await query(`SELECT id FROM users WHERE email LIKE '${tag}-%'`)).rows.map((r) => r.id);
}
async function run(label, n, channels) {
  const ids = await seedUsers(n, label);
  const { rows: [adm] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('m','${label}@measure.invalid','x','owner') RETURNING id`);
  const { rows: [c] } = await query(
    `INSERT INTO notification_campaigns (title, body, audience, audience_filter, channels, status, recipient_count, created_by)
     VALUES ($1, 'نص قياس', 'selected_users', $2, $3, 'draft', $4, $5) RETURNING id`,
    [`قياس ${label}`, JSON.stringify({ userIds: ids }), channels, n, adm.id]);
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
  let peak = process.memoryUsage().rss; const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  const t0 = Date.now();
  const res = await dispatchCampaign(c.id, { trigger: "measure" });
  const ms = Date.now() - t0; clearInterval(t); h.disable();
  const { rows: st } = await query(`SELECT status, count(*)::int n FROM notification_deliveries WHERE campaign_id=$1 GROUP BY 1`, [c.id]);
  return { label, recipients: n, channels, wallMs: ms, perRecipientMs: +(ms / n).toFixed(2), peakRssMB: +(peak / 1048576).toFixed(1),
    eventLoopMaxLagMs: +(h.max / 1e6).toFixed(1), result: { status: res.status, sent: res.sent, delivered: res.delivered, failed: res.failed, skipped: res.skipped }, deliveries: st };
}

const out = { at: new Date().toISOString(), node: process.version, smtpDelayMs: DELAY, runs: [] };
out.runs.push(await run("inapp", IN_APP_N, ["in_app"]));
out.runs.push(await run("email", EMAIL_N, ["email"]));
out.smtpReceived = received;
fs.mkdirSync(path.join(HERE, ".local", "logs"), { recursive: true });
fs.writeFileSync(path.join(HERE, ".local", "logs", "measure-campaign.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
smtp.close(); await pool.end();
