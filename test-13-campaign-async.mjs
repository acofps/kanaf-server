import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0001 — الإرسال الجماعي (R15-13).
 * مستقبِل SMTP على loopback بتأخير 100ms لكل رسالة؛ ميزانية الانتظار
 * المتزامن 500ms. لا رسالة تغادر الجهاز.
 */
requireDedicatedDatabase(import.meta.url);
import net from "node:net";
import jwt from "jsonwebtoken";

let received = 0;
const smtp = net.createServer((sock) => {
  let inData = false, buf = "";
  sock.write("220 sink\r\n");
  sock.on("data", (c) => {
    buf += c.toString(); let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) { if (line === ".") { inData = false; received++; setTimeout(() => sock.write("250 ok\r\n"), 100); } continue; }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250-sink\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (cmd === "AUTH") sock.write("235 ok\r\n");
      else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
      else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("250 ok\r\n");
    }
  });
});
await new Promise((r) => smtp.listen(2526, "127.0.0.1", r));
Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: "2526", SMTP_USER: "s", SMTP_PASS: "s", EMAIL_FROM: "t@localhost",
  PORT: "4641", SKIP_PDF_BOOT_CHECK: "1", ALLOWED_ORIGINS: "http://127.0.0.1:5173", CAMPAIGN_SYNC_BUDGET_MS: "500",
  SWEEP_TRIGGER_TOKEN: "s".repeat(40), SWEEP_MIN_INTERVAL_MS: "999999999", REMINDER_SWEEP_MIN_INTERVAL_MS: "999999999" });
const logs = []; const rl = console.log, re = console.error, rw = console.warn;
console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
await new Promise((r) => setTimeout(r, 300));
const B = "http://127.0.0.1:4641";
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
let cookie;
async function call(method, path, body, headers = {}) {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const users = async (n, tag) => { await query(`INSERT INTO users (name,email,password_hash,email_verified_at) SELECT 'م', '${tag}-' || g || '@c.invalid', 'x', now() FROM generate_series(1,$1) g`, [n]);
  return (await query(`SELECT id FROM users WHERE email LIKE '${tag}-%'`)).rows.map((r) => r.id); };
const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

try {
  await call("GET", "/api/health"); await new Promise((r) => setTimeout(r, 800));
  const { rows: [own] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('م','own-c@kanaf.test','x','owner') RETURNING id`);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: own.id, role: "owner", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;

  const small = await users(3, "small");
  let r = await call("POST", "/admin/notifications", { title: "صغيرة", body: "نص", audience: "selected_users", audienceFilter: { userIds: small }, channels: ["in_app"], sendNow: true });
  ok("A1 small campaign finishes inside the budget → 201 with full results (unchanged behaviour)", r.status === 201 && r.body.dispatch?.sent === 3, JSON.stringify(r.body.dispatch));

  const big = await users(30, "big");
  const t0 = Date.now();
  r = await call("POST", "/admin/notifications", { title: "كبيرة", body: "نص", audience: "selected_users", audienceFilter: { userIds: big }, channels: ["email"], sendNow: true });
  const elapsed = Date.now() - t0;
  ok("A2 large e-mail campaign answers 202 quickly instead of holding the request", r.status === 202 && r.body.dispatch?.accepted === true && elapsed < 3000, `${r.status} in ${elapsed}ms ${JSON.stringify(r.body.dispatch)}`);
  const cid = r.body.id;
  const finished = await waitFor(async () => (await query(`SELECT status FROM notification_campaigns WHERE id=$1`, [cid])).rows[0].status === "sent");
  const { rows: d } = await query(`SELECT status, count(*)::int n FROM notification_deliveries WHERE campaign_id=$1 GROUP BY 1`, [cid]);
  ok("A3 background send completes: campaign 'sent', 30 deliveries 'sent'", finished && d.length === 1 && d[0].status === "sent" && d[0].n === 30, JSON.stringify(d));
  ok("A4 each recipient received exactly one e-mail", received === 30, String(received));

  /* حملة عالقة في sending (انقطاع خادم): تُستأنف تلقائياً من المسح */
  const stuck = await users(5, "stuck");
  const { rows: [sc] } = await query(`INSERT INTO notification_campaigns (title, body, audience, audience_filter, channels, status, started_at, recipient_count, created_by)
    VALUES ('عالقة','نص','selected_users',$1,'{in_app}','sending', now() - interval '20 minutes', 5, $2) RETURNING id`, [JSON.stringify({ userIds: stuck }), own.id]);
  await query(`INSERT INTO notification_deliveries (campaign_id, user_id, channel, status) SELECT $1, u, 'in_app', 'queued' FROM unnest($2::uuid[]) u`, [sc.id, stuck]);
  await query(`UPDATE notification_deliveries SET status = 'processing' WHERE campaign_id = $1 AND user_id = $2`, [sc.id, stuck[0]]);
  const sweeps = await Promise.all([1, 2].map(() => call("POST", "/api/internal/sweep", null, { "X-Sweep-Token": process.env.SWEEP_TRIGGER_TOKEN })));
  const { rows: [st] } = await query(`SELECT status FROM notification_campaigns WHERE id=$1`, [sc.id]);
  const { rows: inbox } = await query(`SELECT count(*)::int n FROM user_notifications WHERE campaign_id=$1`, [sc.id]);
  ok("S1 interrupted campaign resumed automatically by the sweep (no manual click)", sweeps.every((x) => x.status === 200) && st.status === "sent", `${st.status} ${JSON.stringify(sweeps.map((x) => x.body.campaigns))}`);
  ok("S2 resumed without duplicates even with two concurrent sweeps (5 inbox rows)", inbox[0].n === 5, String(inbox[0].n));
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

console.log = rl; console.error = re; console.warn = rw;
let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
if (f) console.log(logs.slice(-15).join("\n"));
smtp.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
