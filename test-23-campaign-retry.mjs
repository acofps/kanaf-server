import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0002 B-11 (F-EXTRA-NOTIF-RETRY) — إعادة محاولة حملة فاشلة جزئياً.
 * الزر الجديد في اللوحة ينادي مسار الإرسال القائم. المطلوب: تُعاد التسليمات الفاشلة وحدها،
 * لنفس الجمهور الأصلي (لا يُضاف من صار يطابق الفلتر بعد الإرسال الأول)، ولا يُعاد الناجح.
 * القناة in_app فقط؛ الفشل يُصنع كـ fixture (صف التسليم failed وحذف صف الصندوق المقابل).
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { adminNotificationsRouter } = await import("./admin/notifications.js");

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/admin", adminNotificationsRouter);
const server = app.listen(4603); const B = "http://127.0.0.1:4603";
let cookie;
const call = async (method, path, body) => { const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const n = async (sql, p) => +(await query(sql, p)).rows[0].n;

try {
  const { rows: [adm] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('b11','b11-admin@kanaf.test','x','admin') RETURNING id`);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: adm.id, role: "admin", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  await query(`INSERT INTO users (name,email,password_hash,email_verified_at) SELECT 'م', 'b11-' || g || '@kanaf.test', 'x', now() FROM generate_series(1,3) g`);
  const audienceBefore = await n(`SELECT count(*) n FROM users WHERE deleted_at IS NULL`);

  let r = await call("POST", "/admin/notifications", { title: "حملة إعادة", body: "نص", audience: "all", channels: ["in_app"], sendNow: true });
  const cid = r.body.id;
  ok("R0 first send reaches the whole current audience", r.status === 201 && r.body.dispatch?.sent === audienceBefore, JSON.stringify(r.body.dispatch));

  /* fixture: تسليم واحد فشل (لا صف صندوق له)، والحملة partially_failed */
  const { rows: [victim] } = await query(`SELECT user_id FROM notification_deliveries WHERE campaign_id = $1 ORDER BY user_id LIMIT 1`, [cid]);
  await query(`DELETE FROM user_notifications WHERE campaign_id = $1 AND user_id = $2`, [cid, victim.user_id]);
  await query(`UPDATE notification_deliveries SET status = 'failed', error_code = 'test_failure' WHERE campaign_id = $1 AND user_id = $2`, [cid, victim.user_id]);
  await query(`UPDATE notification_campaigns SET status = 'partially_failed' WHERE id = $1`, [cid]);
  /* مستخدم جديد يطابق «all» بعد الإرسال الأول */
  const { rows: [late] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at) VALUES ('متأخر','b11-late@kanaf.test','x',now()) RETURNING id`);
  const deliveriesBefore = await n(`SELECT count(*) n FROM notification_deliveries WHERE campaign_id = $1`, [cid]);
  const recipientCountBefore = (await query(`SELECT recipient_count FROM notification_campaigns WHERE id = $1`, [cid])).rows[0].recipient_count;

  r = await call("POST", `/admin/notifications/${cid}/send`, { reason: "إعادة محاولة الفاشلة" });
  ok("R1 retry accepted on a partially_failed campaign", r.status === 200 || r.status === 201 || r.status === 202, `${r.status} ${JSON.stringify(r.body)}`);
  ok("R2 the failed delivery is retried and now sent (one inbox row for that user)", await n(`SELECT count(*) n FROM notification_deliveries WHERE campaign_id = $1 AND user_id = $2 AND status IN ('sent','delivered')`, [cid, victim.user_id]) === 1
    && await n(`SELECT count(*) n FROM user_notifications WHERE campaign_id = $1 AND user_id = $2`, [cid, victim.user_id]) === 1);
  ok("R3 successful deliveries are not re-sent (still exactly one inbox row per original recipient)", await n(
    `SELECT count(*) n FROM (SELECT user_id FROM user_notifications WHERE campaign_id = $1 GROUP BY user_id HAVING count(*) > 1) d`, [cid]) === 0);
  ok("R4 the audience is not expanded: the user created after the first send gets no delivery and no inbox row",
    await n(`SELECT count(*) n FROM notification_deliveries WHERE campaign_id = $1 AND user_id = $2`, [cid, late.id]) === 0
    && await n(`SELECT count(*) n FROM user_notifications WHERE campaign_id = $1 AND user_id = $2`, [cid, late.id]) === 0
    && await n(`SELECT count(*) n FROM notification_deliveries WHERE campaign_id = $1`, [cid]) === deliveriesBefore);
  ok("R5 recipient_count keeps the original audience size", (await query(`SELECT recipient_count FROM notification_campaigns WHERE id = $1`, [cid])).rows[0].recipient_count === recipientCountBefore);
  ok("R6 campaign ends 'sent' after the successful retry", (await query(`SELECT status FROM notification_campaigns WHERE id = $1`, [cid])).rows[0].status === "sent");
  r = await call("POST", `/admin/notifications/${cid}/send`, { reason: "مرة ثانية" });
  ok("R7 a sent campaign cannot be sent again (skipped / no new rows)", await n(`SELECT count(*) n FROM user_notifications WHERE campaign_id = $1`, [cid]) === audienceBefore, JSON.stringify(r.body));
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
server.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
