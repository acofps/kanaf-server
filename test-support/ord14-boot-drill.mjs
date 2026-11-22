/* ============================================================
   إقلاع ببيئة تشبه الإنتاج — KANAF-ORD-0014 §2.5
     node test-support/ord14-boot-drill.mjs

   الخادم الحقيقي (index.js) عملية مستقلة بـ--require net-local-only.cjs (لا اتصال إلا بـ127.0.0.1)،
   على قاعدة معزولة من القالب المُرحَّل، ومتغيّرات تشبه الإنتاج:
     NODE_ENV=production · DB_SSL=true (الخادم المحلي بـssl=on) · SMTP إلى مستقبِل محلي ·
     فحص مولّد الفواتير الحقيقي (بلا SKIP_PDF_BOOT_CHECK) · و**AUTORENEW_ENABLED غائب**.

   يثبت:
     B  إقلاع نظيف: لا FATAL ولا استثناء ولا سطر خطأ، و«[invoice] مولّد الفواتير جاهز» ظاهر،
        والاتصال بالقاعدة مشفّر فعلاً (pg_stat_ssl).
     S  المسوح (المشغّل الخارجي وهامش الطلبات) تعمل ولا تشتكي، و/api/ready يعرض النجاح.
     A  🔴 التجديد التلقائي لا ينفّذ سطراً: عضو مستحق للتجديد مزروع (بطاقة وموافقة واشتراك ينتهي
        بعد يومين) — وبعد المسوح وحدث دفع يحمل رمز بطاقة: عدّادات PostgreSQL لجداوله الأربعة
        (مسح، إدراج، تحديث) لم تتحرك، ولا رسالة تجديد، ولا نداء مزوّد (الشبكة مغلقة والسجل بلا NET_BLOCKED).
     M  بريد حقيقي يخرج باسم المرسِل «تنفس بحرية» مفكوكاً كما يُعرض.
     X  الإيقاف بـSIGTERM نظيف.
   الناتج: test-support/.local/logs/ord0014/boot-drill.{log,json} وسجل الخادم boot-drill.server.log
   ============================================================ */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startSmtpSink, mimeParts } from "./smtp-sink.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LOG_DIR = path.join(HERE, ".local", "logs", "ord0014"); fs.mkdirSync(LOG_DIR, { recursive: true });
const lines = []; const say = (s) => { lines.push(s); console.log(s); };
const R = []; const ok = (label, cond, x = "") => { R.push({ label, pass: !!cond, detail: x }); say(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !x ? "" : `  (${String(x).slice(0, 400)})`}`); };
const obs = {}; const note = (k, v) => { obs[k] = v; say(`OBS   ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, ".local", "test-env.json"), "utf8"));

const envLines = execFileSync(process.execPath, [path.join(HERE, "create-db.mjs"), "ord14-boot", "migrated"], { encoding: "utf8" });
const DB_URL = /TEST_DATABASE_URL='([^']+)'/.exec(envLines)[1];
const DB = new URL(DB_URL).pathname.slice(1);
const su = (() => { const u = new URL(cfg.superuserUrl); u.pathname = `/${DB}`; return u.toString(); })();
const db = new pg.Client({ connectionString: su, ssl: false }); await db.connect();
const q = (s, p) => db.query(s, p);

const sink = await startSmtpSink();
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const B = `http://127.0.0.1:${port}`;
const SWEEP = crypto.randomBytes(24).toString("hex"), WH = "boot-drill-webhook-secret-0123456789";
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", PORT: String(port),
  DATABASE_URL: DB_URL, DB_SSL: "true", TRUST_PROXY_HOPS: "1", ALLOWED_ORIGINS: "https://admin.tanfs.net,https://app.tanfs.net",
  USER_JWT_SECRET: crypto.randomBytes(32).toString("hex"), ADMIN_JWT_SECRET: crypto.randomBytes(32).toString("hex"),
  SETUP_TOKEN: crypto.randomBytes(24).toString("hex"), SWEEP_TRIGGER_TOKEN: SWEEP,
  SMTP_HOST: "127.0.0.1", SMTP_PORT: process.env.SMTP_PORT, SMTP_USER: "noreply@mg.acofps.com", SMTP_PASS: "local-sink",
  EMAIL_FROM: "تنفس بحرية <noreply@mg.acofps.com>",
  PAYMENT_SECRET_KEY: "sk_test_boot_drill", PAYMENT_WEBHOOK_SECRET: WH,
  SERVER_BASE_URL: "https://kanaf-server.onrender.com", APP_BASE_URL: "https://app.tanfs.net",
  INTEGRATIONS_ENC_KEY: "b".repeat(64), REMINDER_SWEEP_MIN_INTERVAL_MS: "1000", SWEEP_MIN_INTERVAL_MS: "1000",
  /* Chrome: على Render ينزّله أمر البناء إلى ذاكرة Puppeteer. في هذه البيئة متصفّح النظام بدلاً منه —
     نفس ما يمرّره مشغّل الاختبارات (run-tests.mjs). المتغيّر بيئة اختبار، لا إعداد إنتاج. */
  ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
  // AUTORENEW_ENABLED غائب عمداً — كما على الإنتاج.
};
note("env.autorenew", "AUTORENEW_ENABLED " + ("AUTORENEW_ENABLED" in env ? "SET" : "absent"));

/* ---------- عضو مستحق للتجديد: لو كان المفتاح مضبوطاً لأُشعر وخُصم ---------- */
const { rows: [u] } = await q(`INSERT INTO users (name, email, password_hash, email_verified_at, confirmed_adult) VALUES ('مستحق', 'due-renew@example.com', 'x', now(), true) RETURNING id`);
const { rows: [s] } = await q(`INSERT INTO subscriptions (user_id, plan_id, status, started_at, current_period_end, payment_provider)
  VALUES ($1, 'monthly', 'active', now() - interval '28 days', now() + interval '20 hours', 'moyasar') RETURNING id`, [u.id]);
await q(`INSERT INTO subscription_state (subscription_id, user_id, billing_cycle, billing_period_days, plan_price_sar, currency, current_period_start, provider, renewal_mode)
  VALUES ($1, $2, 'monthly', 30, 29, 'SAR', now() - interval '28 days', 'moyasar', 'automatic')`, [s.id, u.id]);
const { rows: [pm] } = await q(`INSERT INTO payment_methods (user_id, provider, token_ciphertext, token_iv, token_auth_tag, card_brand, card_last4)
  VALUES ($1, 'moyasar', '\\x00', '\\x00', '\\x00', 'mada', '4242') RETURNING id`, [u.id]);
const { rows: [cn] } = await q(`INSERT INTO autorenew_consents (user_id, subscription_id, payment_method_id, consent_version, consent_text, plan_key, amount_sar)
  VALUES ($1, $2, $3, '2026-11-v2', 'نص موافقة تجريبي للبروفة بطول كافٍ', 'monthly', 29) RETURNING id`, [u.id, s.id, pm.id]);
await q(`INSERT INTO renewal_cycles (cycle_key, subscription_id, user_id, consent_id, period_end, plan_key, amount_sar, notice_sent_at)
  VALUES ($1, $2, $3, $4, now() + interval '20 hours', 'monthly', 29, now() - interval '5 days')`, [`${s.id}:due`, s.id, u.id, cn.id]);
/* فاتورة معلّقة لحدث دفع يحمل رمز بطاقة */
const { rows: [inv] } = await q(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, provider_invoice_id) VALUES ($1, 'monthly', 29, 'pending', 'inv_boot_1') RETURNING id`, [u.id]);
await q(`INSERT INTO invoice_payment_expectations (invoice_id, amount_halalas, currency) VALUES ($1, 2900, 'SAR')`, [inv.id]);
await q(`INSERT INTO tax_settings (singleton, legal_name, vat_number, address) VALUES (true, 'منشأة البروفة', '300000000000003', 'جدة') ON CONFLICT (singleton) DO NOTHING`);

const AR_TABLES = ["payment_methods", "autorenew_consents", "renewal_cycles", "renewal_attempts"];
async function arStats() {
  await q(`SELECT pg_stat_clear_snapshot()`);
  const { rows } = await q(`SELECT relname, seq_scan, COALESCE(idx_scan, 0) idx_scan, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE relname = ANY($1) ORDER BY relname`, [AR_TABLES]);
  return JSON.stringify(rows);
}

/* ---------- الإقلاع ---------- */
const logPath = path.join(LOG_DIR, "boot-drill.server.log");
const logFd = fs.openSync(logPath, "w");
const child = spawn(process.execPath, ["--require", path.join(HERE, "net-local-only.cjs"), path.join(ROOT, "index.js")], { cwd: ROOT, env, stdio: ["ignore", logFd, logFd] });
let exited = null; child.on("exit", (code, sig) => { exited = { code, sig }; });
const readLog = () => fs.readFileSync(logPath, "utf8");
let up = false;
for (let i = 0; i < 120 && !exited; i++) { try { const r = await fetch(`${B}/api/health`); if (r.ok) { up = true; break; } } catch { /* */ } await sleep(250); }
for (let i = 0; i < 120 && !/مولّد الفواتير (جاهز|غير جاهز)/.test(readLog()); i++) await sleep(250);
await sleep(500);
const bootLog = readLog();
ok("B1 الخادم أقلع ويجيب /api/health", up && !exited, JSON.stringify(exited));
ok("B2 «[invoice] مولّد الفواتير جاهز» ظاهر في السجل", /\[invoice\] مولّد الفواتير جاهز/.test(bootLog), bootLog.slice(-400));
const ERR = /FATAL|Error|❌|غير جاهز|unhandled|NET_BLOCKED|ECONNREFUSED|stack/i;
ok("B3 لا FATAL ولا استثناء ولا سطر خطأ عند الإقلاع", !bootLog.split("\n").some((l) => ERR.test(l)), bootLog.split("\n").filter((l) => ERR.test(l)).join(" | "));
note("boot.log", bootLog.trim().split("\n"));
const ssl = (await q(`SELECT count(*)::int n, bool_and(s.ssl) all_ssl FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid) WHERE a.datname = $1 AND a.usename = $2`, [DB, cfg.runtimeRole])).rows[0];
ok("B4 اتصالات الخادم بالقاعدة مشفّرة فعلاً (DB_SSL=true)", ssl.n > 0 && ssl.all_ssl === true, JSON.stringify(ssl));

/* ---------- A ---------- */
const st0 = await arStats();
let r = await fetch(`${B}/api/internal/sweep`, { method: "POST", headers: { "X-Sweep-Token": SWEEP } });
const sweepBody = await r.json().catch(() => ({}));
ok("A1 المشغّل الخارجي: التجديد «autorenew_disabled» بلا عمل", r.status === 200 && sweepBody.autorenew?.skipped === "autorenew_disabled", JSON.stringify(sweepBody));
for (let i = 0; i < 4; i++) { await fetch(`${B}/api/content/catalog`).catch(() => {}); await sleep(1200); }   // مسوح الهامش
const wh = await fetch(`${B}/api/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
  id: "evt_boot_1", type: "payment_paid", secret_token: WH,
  data: { id: "pay_boot_1", status: "paid", amount: 2900, currency: "SAR", invoice_id: "inv_boot_1", metadata: { kanaf_invoice_id: inv.id },
          source: { type: "creditcard", company: "mada", number: "4201-32XX-XXXX-4242", token: "token_boot_should_not_be_saved" } } }) });
await sleep(1500);
const st1 = await arStats();
ok("A2 🔴 جداول التجديد الأربعة لم تُمسح ولم يُكتب فيها شيء (عدّادات PostgreSQL ثابتة) — رغم عضو مستحق وحدث دفع يحمل رمز بطاقة", st0 === st1, `${st0} → ${st1}`);
const paid = (await q(`SELECT status FROM invoices WHERE id = $1`, [inv.id])).rows[0].status;
ok("A3 حدث الدفع نفسه عولج (الفاتورة مدفوعة) — والرمز لم يُحفظ", wh.status === 200 && paid === "paid" && (await q(`SELECT count(*)::int n FROM payment_methods`)).rows[0].n === 1);
ok("A4 لا دورة جديدة ولا محاولة خصم، والدورة المزروعة كما هي", (await q(`SELECT count(*)::int n FROM renewal_attempts`)).rows[0].n === 0
  && (await q(`SELECT status FROM renewal_cycles`)).rows[0].status === "noticed");
const renewalMail = sink.inbox.filter((m) => /due-renew@example.com/.test(m.to.join(",")));
ok("A5 لا رسالة تجديد خرجت", renewalMail.length === 0, String(renewalMail.length));
ok("A6 لا محاولة اتصال بالمزوّد (لا NET_BLOCKED في السجل)", !/NET_BLOCKED/.test(readLog()));

/* ---------- S ---------- */
const ready = await (await fetch(`${B}/api/internal/ready`)).json().catch(() => ({}));
ok("S1 /api/internal/ready: القاعدة سليمة، والمسح الخارجي نجح ولم يفشل", ready.ok === true && ready.db === "ok" && ready.sweep?.lastSuccessAt && !ready.sweep?.lastFailureAt, JSON.stringify(ready));

/* ---------- M ---------- */
const n0 = sink.inbox.length;
r = await fetch(`${B}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.tanfs.net" },
  body: JSON.stringify({ name: "بروفة", email: "boot-reg@example.com", password: "Boot-Drill-Pass-2026-x", confirmedAdult: true, agreedPolicy: true }) });
await sink.waitMail(n0 + 1);
const mail = sink.inbox[n0];
const from = mail ? /^From: (.+)$/m.exec(mail.data)?.[1] || "" : "";
const decoded = from.replace(/=\?UTF-8\?([BQ])\?([^?]+)\?=/gi, (_, e, t) => e.toUpperCase() === "B" ? Buffer.from(t, "base64").toString("utf8")
  : Buffer.from(t.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8"));
const text = mail ? (mimeParts(mail.data).find((p) => p.type === "text/plain")?.text || "") : "";
ok("M1 بريد التحقق خرج فعلاً، ومرسِله مفكوكاً «تنفس بحرية» <noreply@mg.acofps.com>", r.status === 201 && /تنفس بحرية/.test(decoded) && /noreply@mg\.acofps\.com/.test(decoded), `${r.status} ${from} → ${decoded}`);
ok("M2 ونصّه بالاسم الرسمي ورمزه", /كود تأكيد بريدك في تنفس بحرية: \d{6}/.test(text) && /فريق تنفس بحرية/.test(text), text.slice(0, 160));
note("mail.from_raw", from);

/* ---------- الإيقاف ---------- */
const finalLog = readLog();
ok("S2 السجل كاملاً بعد المسوح والطلبات: لا سطر خطأ", !finalLog.split("\n").some((l) => ERR.test(l)), finalLog.split("\n").filter((l) => ERR.test(l)).join(" | "));
child.kill("SIGTERM");
for (let i = 0; i < 40 && !exited; i++) await sleep(250);
ok("X1 الإيقاف بـSIGTERM نظيف (رمز 0)", exited && (exited.code === 0 || exited.sig === "SIGTERM"), JSON.stringify(exited));

sink.close(); await db.end();
const pass = R.filter((x) => x.pass).length, fail = R.length - pass;
say(`\n  ${pass} passed, ${fail} failed`);
fs.writeFileSync(path.join(LOG_DIR, "boot-drill.log"), lines.join("\n") + "\n");
fs.writeFileSync(path.join(LOG_DIR, "boot-drill.json"), JSON.stringify({ results: R, observations: obs }, null, 2));
process.exit(fail ? 1 : 0);
