import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0001 — إعدادات بلا قارئ (R15-19) ومسح رقم
 * واتساب (R15-21، جانب الخادم). كل إعداد يُفحص عند **مستهلكه الحقيقي**
 * لا بوجود صفه: البريد المُرسل فعلاً، صف جدولة التذكير، مدة الرمز
 * والكوكي، ورد /api/support-info.
 */
requireDedicatedDatabase(import.meta.url);
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

process.env.PORT = "4637";
process.env.SKIP_PDF_BOOT_CHECK = "1";
process.env.ALLOWED_ORIGINS = "http://127.0.0.1:5173";
const sent = [], logs = []; const rl = console.log, re = console.error, rw = console.warn;
console.log = (...a) => { const l = a.join(" "); if (l.includes("[dev] Would send")) sent.push(l); else logs.push(l); };
console.error = (...a) => logs.push(a.join(" ")); console.warn = console.error;
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
const { refreshAdminSessionMinutes } = await import("./admin/auth.js");
await new Promise((r) => setTimeout(r, 300));
const B = "http://127.0.0.1:4637";
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
async function call(method, path, { body, token, cookie } = {}) {
  const h = { "Content-Type": "application/json" }; if (token) h.Authorization = `Bearer ${token}`; if (cookie) h.Cookie = cookie;
  const r = await fetch(B + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.clone().json(); } catch {}
  return { status: r.status, body: j, headers: r.headers };
}
const PW = "Kanaf-Test-2026-a", APW = "Owner-Long-Password-2026";

try {
  const { rows: [own] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('م','own-s@kanaf.test',$1,'owner') RETURNING id`, [await bcrypt.hash(APW, 4)]);
  const cookie = `kanaf_admin_access=${jwt.sign({ sub: own.id, role: "owner", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "10m" })}`;
  const put = (key, value) => call("PUT", `/admin/app-settings/${key}`, { cookie, body: { value, reason: "اختبار الربط" } });
  async function mkUser(tag) {
    const email = `s-${tag}-${crypto.randomBytes(3).toString("hex")}@kanaf.test`;
    const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at) VALUES ($1,$2,$3,now()) RETURNING id`, [tag, email, await bcrypt.hash(PW, 4)]);
    const l = await call("POST", "/api/auth/login", { body: { email, password: PW } });
    return { id: u.id, email, token: l.body.accessToken };
  }

  /* marketing_email_footer */
  const FOOT = `تذييل-اختبار-${crypto.randomBytes(3).toString("hex")}`;
  let r = await put("marketing_email_footer", FOOT);
  ok("F0 footer saved by owner", r.status === 200 && r.body.setting?.wired === true, JSON.stringify(r.body).slice(0, 120));
  const u1 = await mkUser("f");
  r = await call("POST", "/admin/notifications", { cookie, body: { title: "حملة تذييل", body: "نص الحملة", audience: "selected_users", audienceFilter: { userIds: [u1.id] }, channels: ["email"], sendNow: true } });
  await new Promise((x) => setTimeout(x, 500));
  const mail = sent.find((m) => m.includes(u1.email));
  ok("F1 the campaign e-mail actually carries the footer", !!mail && mail.includes(FOOT), `${r.status} ${mail ? mail.slice(0, 80) : "no mail"}`);
  await put("marketing_email_footer", "بلا");
  ok("F2 footer is not added to verification/reset mail", !sent.filter((m) => /كود/.test(m)).some((m) => m.includes(FOOT)));

  /* daily_reminder_time */
  r = await put("daily_reminder_time", "07:30");
  ok("D0 default time saved", r.status === 200 && r.body.setting?.wired === true);
  const u2 = await mkUser("d");
  r = await call("PATCH", "/api/me/preferences", { token: u2.token, body: { remindersOn: true } });
  const { rows: [p2] } = await query(`SELECT to_char(local_time,'HH24:MI') t FROM user_reminder_prefs WHERE user_id=$1`, [u2.id]);
  ok("D1 a user enabling reminders for the first time gets the configured default", p2?.t === "07:30", JSON.stringify(p2));
  const u3 = await mkUser("e");
  await query(`INSERT INTO user_reminder_prefs (user_id, local_time, timezone) VALUES ($1,'21:00','Asia/Riyadh')`, [u3.id]);
  await put("daily_reminder_time", "06:00");
  await call("PATCH", "/api/me/preferences", { token: u3.token, body: { remindersOn: true } });
  const { rows: [p3] } = await query(`SELECT to_char(local_time,'HH24:MI') t FROM user_reminder_prefs WHERE user_id=$1`, [u3.id]);
  ok("D2 an existing personal time is NOT overridden by the default", p3?.t === "21:00", JSON.stringify(p3));
  r = await put("daily_reminder_time", "8 مساءً");
  ok("D3 invalid time rejected", r.status === 400);

  /* admin_session_minutes */
  r = await put("admin_session_minutes", 3);
  ok("A0 below 5 minutes rejected", r.status === 400 && r.body.error === "session_minutes_must_be_5_to_60", JSON.stringify(r.body));
  r = await put("admin_session_minutes", "15");
  ok("A0b non-integer rejected", r.status === 400);
  r = await put("admin_session_minutes", 7);
  ok("A1 7 minutes saved", r.status === 200 && r.body.setting?.wired === true);
  const login = await call("POST", "/admin/auth/login", { body: { email: "own-s@kanaf.test", password: APW } });
  const setCookie = login.headers.get("set-cookie") || "";
  const access = /kanaf_admin_access=([^;]+)/.exec(setCookie)?.[1];
  const claims = access ? jwt.decode(access) : null;
  ok("A2 new admin access token lives 7 minutes", claims && claims.exp - claims.iat === 420, claims ? String(claims.exp - claims.iat) : setCookie.slice(0, 80));
  ok("A3 its cookie Max-Age is 7 minutes too", /kanaf_admin_access=[^;]+;[^,]*Max-Age=420/.test(setCookie), setCookie.slice(0, 160));
  await query(`UPDATE app_settings SET value='15'::jsonb WHERE key='admin_session_minutes'`); await refreshAdminSessionMinutes();

  /* R15-21 — مسح رقم واتساب (الخادم) */
  await put("whatsapp_number", "966500000000"); await put("whatsapp_enabled", true);
  r = await call("GET", "/api/support-info");
  ok("W0 with a number and switch on the button is shown", r.body.whatsapp?.enabled === true && /wa\.me/.test(r.body.whatsapp.url));
  r = await put("whatsapp_number", null);
  ok("W1 owner can clear the number (null)", r.status === 200 && r.body.setting?.value === null, JSON.stringify(r.body).slice(0, 100));
  r = await call("GET", "/api/support-info");
  ok("W2 cleared number → no button and no broken link, even with switch on", r.body.whatsapp?.enabled === false && r.body.whatsapp?.url === null, JSON.stringify(r.body.whatsapp));

  /* app_public_name — صادق: غير مربوط */
  r = await call("GET", "/admin/app-settings", { cookie });
  const row = r.body.settings?.find((x) => x.key === "app_public_name");
  /* حقول مالية فارغة لا تُحفظ صفراً */
  let v = await call("PUT", "/admin/billing/settings", { cookie, body: { vatRate: "", reason: "اختبار حقل فارغ" } });
  const bs = await query(`SELECT vat_rate FROM billing_settings LIMIT 1`).catch(() => ({ rows: [] }));
  ok("V1 empty VAT rate is refused 400 (Number(\"\") was saving 0%)", v.status === 400 && v.body.error === "vat_rate_required" && (bs.rows[0] ? Number(bs.rows[0].vat_rate) > 0 : true), JSON.stringify(v.body));
  const pl = (await query(`SELECT id, price_sar FROM subscription_plans ORDER BY display_order LIMIT 1`)).rows[0];
  v = await call("PATCH", `/admin/plans/${pl.id}`, { cookie, body: { priceSar: "", reason: "اختبار حقل فارغ" } });
  const pl2 = (await query(`SELECT price_sar FROM subscription_plans WHERE id = $1`, [pl.id])).rows[0];
  ok("V2 empty plan price is refused 400 and the price is unchanged", v.status === 400 && Number(pl2.price_sar) === Number(pl.price_sar), `${v.status} ${pl2.price_sar}`);
  ok("N1 app_public_name is still reported as not wired (no consumer)", row && row.wired === false, JSON.stringify(row).slice(0, 120));
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

console.log = rl; console.error = re; console.warn = rw;
let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
if (f) console.log(logs.slice(-12).join("\n"));
await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
