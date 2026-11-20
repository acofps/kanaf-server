import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0002 B-03 — إيقاف الرحلة مؤقتاً واستئنافها وإنهاؤها عبر الخادم.
 * التطبيق صار يرسل POST /api/me/journeys/:key/status (كان الإيقاف والإنهاء محليين فقط).
 * هنا: الانتقالات المسموحة فقط، والتكرار آمن، وبقاء الحالة لإعادة الدخول، والملكية،
 * ورفض إعادة تسجيل رحلة منتهية بدل الكتابة فوق حالتها.
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const crypto = await import("node:crypto");
const bcrypt = (await import("bcrypt")).default;
const { query, pool } = await import("./db/pool.js");
const { issueAccessToken } = await import("./auth/tokens.js");
const { userDataRouter } = await import("./userdata/routes.js");

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use("/api/me", userDataRouter);
const server = app.listen(4599); const B = "http://127.0.0.1:4599";
async function call(method, path, body, token) {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function mkUser(tag) {
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, confirmed_adult, agreed_policy_at, email_verified_at)
     VALUES ($1, $2, $3, true, now(), now()) RETURNING id`,
    [`مستخدم ${tag}`, `js-${tag}-${crypto.randomBytes(3).toString("hex")}@kanaf.test`, await bcrypt.hash("x-" + tag, 4)]);
  return { id: rows[0].id, token: issueAccessToken({ id: rows[0].id }) };
}
const KEY = "reactivate_your_day";
const st = (t) => call("POST", `/api/me/journeys/${KEY}/status`, { status: t.s }, t.tok);
const serverStatus = async (uid) => (await query(`SELECT status FROM user_journey_enrollments WHERE user_id = $1 AND journey_key = $2`, [uid, KEY])).rows[0]?.status;

try {
  await query(`UPDATE content_items SET clinical_review_status = 'approved', launch_enabled = true WHERE content_type = 'journey' AND content_key = $1`, [KEY]); // fixture معلن
  const A = await mkUser("a"), Bu = await mkUser("b");
  const enroll = (u, cs = { goal: "أرجع أتحرك" }) => call("POST", "/api/me/journeys", { journeyKey: KEY, totalDays: 7, clientState: cs }, u.token);
  let r = await enroll(A);
  ok("J0 enrollment created active", r.status === 201 && r.body.status === "active");

  r = await st({ s: "paused", tok: A.token });
  ok("J1 pause → paused on the server", r.status === 200 && r.body.status === "paused" && await serverStatus(A.id) === "paused");
  r = await st({ s: "paused", tok: A.token });
  ok("J2 repeated pause (retry after a lost reply) is harmless (200, still paused)", r.status === 200 && await serverStatus(A.id) === "paused");
  r = await call("GET", "/api/me/journeys", null, A.token);
  ok("J3 re-entry (GET) reports paused", r.body.enrollments.find((e) => e.journey_key === KEY)?.status === "paused");
  r = await st({ s: "active", tok: A.token });
  ok("J4 resume → active", r.status === 200 && await serverStatus(A.id) === "active");

  r = await st({ s: "abandoned", tok: Bu.token });
  ok("O1 another user cannot change it (404 — they have no such enrollment)", r.status === 404 && await serverStatus(A.id) === "active");
  r = await call("POST", `/api/me/journeys/${KEY}/status`, { status: "completed" }, A.token);
  ok("V1 'completed' cannot be set through this route (400)", r.status === 400 && r.body.error === "invalid_status");

  r = await st({ s: "abandoned", tok: A.token });
  ok("S1 stop → abandoned", r.status === 200 && await serverStatus(A.id) === "abandoned");
  r = await st({ s: "abandoned", tok: A.token });
  ok("S2 repeated stop is harmless", r.status === 200);
  r = await st({ s: "active", tok: A.token });
  ok("S3 no way back from abandoned via status (409 invalid_transition)", r.status === 409 && r.body.error === "invalid_transition" && r.body.from === "abandoned" && await serverStatus(A.id) === "abandoned");
  r = await st({ s: "paused", tok: A.token });
  ok("S4 abandoned → paused also refused (409)", r.status === 409);
  const csBefore = (await query(`SELECT client_state FROM user_journey_enrollments WHERE user_id = $1 AND journey_key = $2`, [A.id, KEY])).rows[0].client_state;
  r = await enroll(A, { goal: "بداية جديدة" });
  const csAfter = (await query(`SELECT client_state FROM user_journey_enrollments WHERE user_id = $1 AND journey_key = $2`, [A.id, KEY])).rows[0].client_state;
  ok("S5 re-enrolling a stopped journey is refused (409 journey_stopped) and its saved state is not overwritten", r.status === 409 && r.body.error === "journey_stopped"
    && JSON.stringify(csBefore) === JSON.stringify(csAfter) && await serverStatus(A.id) === "abandoned", JSON.stringify(r.body));

  /* إكمال يوم على رحلة غير جارية (امتحان المرجع ORD-0002، AQ05) */
  const dayRows = async (uid) => +(await query(`SELECT count(*) n FROM user_journey_day_states d JOIN user_journey_enrollments e ON e.id = d.enrollment_id WHERE e.user_id = $1 AND e.journey_key = $2`, [uid, KEY])).rows[0].n;
  const day = (u, n) => call("POST", `/api/me/journeys/${KEY}/days/${n}/complete`, null, u.token);
  const rowsA = await dayRows(A.id);
  r = await day(A, 1);
  ok("D1 completing a day of an abandoned journey → 409 journey_stopped, no day written, still abandoned", r.status === 409 && r.body.error === "journey_stopped" && await dayRows(A.id) === rowsA && await serverStatus(A.id) === "abandoned", JSON.stringify(r.body));
  const Cu = await mkUser("c");
  await enroll(Cu); await st({ s: "paused", tok: Cu.token });
  r = await day(Cu, 1);
  ok("D2 completing a day of a paused journey → 409 invalid_transition, no day written, still paused", r.status === 409 && r.body.error === "invalid_transition" && await dayRows(Cu.id) === 0 && await serverStatus(Cu.id) === "paused", JSON.stringify(r.body));
  await st({ s: "active", tok: Cu.token });
  r = await day(Cu, 1);
  ok("D3 control: after resuming, the same day completes (200, 1 day)", r.status === 200 && r.body.completedDays === 1 && await serverStatus(Cu.id) === "active", JSON.stringify(r.body));

  /* ضابط: إعادة تسجيل رحلة موقوفة مؤقتاً تبقى استئنافاً كما كانت */
  r = await enroll(Bu); await call("POST", `/api/me/journeys/${KEY}/status`, { status: "paused" }, Bu.token);
  r = await enroll(Bu);
  ok("C1 control: re-enrolling a paused journey still resumes it (unchanged behaviour)", r.status === 201 && r.body.status === "active");

  /* مكتملة */
  await query(`UPDATE user_journey_enrollments SET status = 'completed' WHERE user_id = $1 AND journey_key = $2`, [Bu.id, KEY]); // fixture
  r = await call("POST", `/api/me/journeys/${KEY}/status`, { status: "paused" }, Bu.token);
  ok("X1 a completed journey cannot be paused (409, stays completed)", r.status === 409 && await serverStatus(Bu.id) === "completed");
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
server.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
