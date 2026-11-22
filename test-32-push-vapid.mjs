import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0010 §2 و§8.6 — موضوع VAPID وإشعار يُسجَّل ويُرسل.
 *
 *  V) الموضوع يُفحص بصرامة: «mailto:تنفس بحرية <noreply@…>» (ما كان يُشتق من EMAIL_FROM)
 *     مرفوض، وmailto نظيف وhttps مقبولان. وبقيمة فاسدة لا يُعدّ Push مضبوطاً
 *     ويُطبع السبب (عملية فرعية بحالة نظيفة).
 *  E) من طرف إلى طرف على loopback: مستخدم موثَّق يسجّل اشتراك جهاز عبر المسار
 *     الحقيقي، ثم sendPushToUser يرسل إلى «مزوّد إشعارات» محلي (HTTPS على 127.0.0.1).
 *     يُقرأ ما وصله: توقيع VAPID بـsub = mailto:support@tanfs.net، والحمولة مشفَّرة
 *     aes128gcm وتُفكّ بمفتاح الجهاز فتطابق ما أُرسل.
 *
 *  الحارس يفرّغ مفاتيح VAPID عند الاستيراد؛ تُضبط هنا بعده بقيم اختبار مولَّدة الآن.
 *  ⚠️ NODE_TLS_REJECT_UNAUTHORIZED=0 داخل هذه العملية وحدها: شهادة المزوّد المحلي
 *  موقَّعة ذاتياً، والحارس يمنع أي اتصال غير loopback أصلاً.
 */
requireDedicatedDatabase(import.meta.url);
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const webpush = require("web-push");
const ece = require("http_ece");

const SUBJECT = "mailto:support@tanfs.net";
const keys = webpush.generateVAPIDKeys();
Object.assign(process.env, { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: SUBJECT, NODE_TLS_REJECT_UNAUTHORIZED: "0" });

const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { userDataRouter, pushPublicKeyRouter } = await import("./userdata/routes.js");
const push = await import("./notifications/push.js");

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "push-"));
const servers = [];
try {
  /* ---- V) الفحص الصارم ---- */
  ok("V1 «mailto:تنفس بحرية <noreply@tanfs.net>» (المشتقّ من EMAIL_FROM) مرفوض", push.validVapidSubject("mailto:تنفس بحرية <noreply@tanfs.net>") === null);
  ok("V2 mailto نظيف وhttps مقبولان", push.validVapidSubject(SUBJECT) === SUBJECT && push.validVapidSubject("https://tanfs.net/contact") === "https://tanfs.net/contact");
  ok("V3 بريد بلا mailto، أو بمسافة، أو localhost — مرفوض", ["support@tanfs.net", "mailto:a b@x.net", "https://localhost/x", ""].every((s) => push.validVapidSubject(s) === null));
  const child = (subject) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(path.resolve("notifications/push.js"))}); console.log("CONFIGURED=" + m.isPushConfigured());`],
    { env: { PATH: process.env.PATH, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, ...(subject === undefined ? {} : { VAPID_SUBJECT: subject }) }, encoding: "utf8" });
  const bad = child("mailto:تنفس بحرية <noreply@tanfs.net>"), none = child(undefined), good = child(SUBJECT);
  ok("V4 قيمة فاسدة → Push غير مضبوط، والسبب في السجل باسم المتغيّر", bad.stdout.includes("CONFIGURED=false") && bad.stderr.includes("VAPID_SUBJECT"), bad.stdout + bad.stderr.slice(0, 200));
  ok("V5 غياب VAPID_SUBJECT → غير مضبوط (لا اشتقاق من EMAIL_FROM)", none.stdout.includes("CONFIGURED=false"), none.stdout);
  ok("V6 قيمة نظيفة → مضبوط", good.stdout.includes("CONFIGURED=true"), good.stdout + good.stderr.slice(0, 200));

  /* ---- E) مزوّد إشعارات محلي على loopback ---- */
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tmp, "k.pem"), "-out", path.join(tmp, "c.pem"),
    "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const received = [];
  const provider = https.createServer({ key: fs.readFileSync(path.join(tmp, "k.pem")), cert: fs.readFileSync(path.join(tmp, "c.pem")) }, (req, res) => {
    const chunks = []; req.on("data", (c) => chunks.push(c));
    req.on("end", () => { received.push({ headers: req.headers, body: Buffer.concat(chunks), path: req.url }); res.writeHead(201); res.end(); });
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r)); servers.push(provider);
  const PPORT = provider.address().port;

  const app = express(); app.use(express.json()); app.use("/api", pushPublicKeyRouter); app.use("/api/me", userDataRouter);
  const api = app.listen(0, "127.0.0.1"); servers.push(api); await new Promise((r) => api.once("listening", r));
  const B = `http://127.0.0.1:${api.address().port}`;

  let r = await fetch(`${B}/api/push/public-key`).then((x) => x.json());
  ok("E1 /api/push/public-key: enabled=true والمفتاح العام نفسه", r.enabled === true && r.publicKey === keys.publicKey, JSON.stringify(r));

  const { rows: [u] } = await query(`INSERT INTO users (name, email, password_hash, confirmed_adult, agreed_policy_at, email_verified_at)
    VALUES ('مشترك الإشعار', 'push-user@example.com', 'x', true, now(), now()) RETURNING id`);
  const token = jwt.sign({ sub: u.id, type: "access" }, process.env.USER_JWT_SECRET, { expiresIn: "15m", audience: "kanaf-consumer" });
  const device = crypto.createECDH("prime256v1"); device.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const subscription = { endpoint: `https://127.0.0.1:${PPORT}/push/device-1`, keys: { p256dh: device.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") } };
  r = await fetch(`${B}/api/me/push/subscribe`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ subscription }) });
  const saved = (await query(`SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1 AND disabled_at IS NULL`, [u.id])).rows[0].n;
  ok("E2 الاشتراك يُسجَّل عبر المسار الحقيقي (201، وصف واحد فعّال)", r.status === 201 && saved === 1, `${r.status} rows=${saved} ${await r.text().catch(() => "")}`);

  const result = await push.sendPushToUser(u.id, { title: "تنفس بحرية", body: "اختبار وصول الإشعار", url: "/" });
  ok("E3 الإرسال ينجح: sent=1", result.ok === true && result.sent === 1, JSON.stringify(result));
  const got = received[0];
  ok("E4 وصل طلب واحد إلى مسار الجهاز نفسه", received.length === 1 && got.path === "/push/device-1");
  const authz = String(got?.headers?.authorization || "");
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authz);
  const claims = m ? JSON.parse(Buffer.from(m[1].split(".")[1], "base64url").toString()) : {};
  ok("E5 🔴 توقيع VAPID: sub = mailto:support@tanfs.net حرفياً", claims.sub === SUBJECT, JSON.stringify(claims));
  ok("E6 aud = أصل المزوّد، والمفتاح العام المرسل هو مفتاحنا", claims.aud === `https://127.0.0.1:${PPORT}` && m?.[2] === keys.publicKey);
  ok("E7 الحمولة مشفّرة aes128gcm", got?.headers?.["content-encoding"] === "aes128gcm" && !got.body.toString("latin1").includes("اختبار"));
  let plain = null;
  try { plain = JSON.parse(ece.decrypt(got.body, { version: "aes128gcm", privateKey: device, authSecret: authSecret.toString("base64url") }).toString("utf8")); } catch (e) { plain = { error: String(e.message) }; }
  ok("E8 الحمولة تُفكّ بمفتاح الجهاز وتطابق ما أُرسل", plain?.title === "تنفس بحرية" && plain?.body === "اختبار وصول الإشعار", JSON.stringify(plain));
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
for (const s of servers) s.close();
fs.rmSync(tmp, { recursive: true, force: true });
await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
