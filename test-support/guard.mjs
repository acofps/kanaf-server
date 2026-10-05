/* ============================================================
   الحارس المركزي لملفات الاختبار — KANAF-ORD-0001 / U09-2

   يُستورد **أول سطر** في كل ملف test-*.mjs:

     import "./test-support/guard.mjs";

   استيراد ES يُقيَّم بالترتيب، وكل ما هنا متزامن (حتى فحص الهوية
   يجري في عملية فرعية متزامنة)، فلا تُقيَّم db/pool.js ولا أي
   موجّه ولا أي وحدة ذات أثر جانبي قبل أن ينتهي الحارس أو يُنهي
   العملية. أي شك = خروج فوري برمز 97 قبل أي اتصال كاتب.

   ما يفحصه (كله إلزامي — لا يكفي اسم قاعدة فيه test ولا NODE_ENV):
     1. TEST_DATABASE_URL موجود. لا fallback إلى DATABASE_URL أبداً؛
        وإن كان DATABASE_URL مضبوطاً بقيمة مختلفة يُرفض التشغيل
        (بيئة مختلطة = شك).
     2. المضيف loopback أو مقبس unix محلي، أو مضيف أُعلن صراحةً في
        KANAF_TEST_ALLOWED_HOSTS — ومضيفات الإنتاج المعروفة مرفوضة
        دائماً حتى لو أُعلنت.
     3. الدور ليس دور الإنتاج (kanaf_adel) ولا postgres، وليس
        superuser فعلياً (يُقرأ من pg_roles لا من الاسم).
     4. علامة بيئة اختبار موثوقة: جدول kanaf_test_env_marker في
        القاعدة الهدف يحمل nonce يطابق KANAF_TEST_MARKER. القاعدة
        الحية لا تحمل هذا الجدول، فيفشل الفحص مغلقاً.
     5. الاتصال الأولي للتعريف read-only (BEGIN READ ONLY) ولا يكتب.
     6. عزل المزودات: تُحذف أسرار SMTP وVAPID وAnthropic من البيئة،
        ويُرفض مفتاح دفع حي (sk_live_)، وNODE_ENV لا يكون production.
     7. الشبكة: أي اتصال TCP/TLS إلى غير loopback يُرفض داخل العملية
        (pg وnodemailer وhttps وfetch كلها تمر بـnet.Socket).
   ============================================================ */
import { execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_CODE = 97;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const PRODUCTION_HOST_PATTERNS = [
  /kanaf\.me$/i, /kanaf\.app$/i, /onrender\.com$/i, /render\.com$/i,
  /dimofinf/i, /cpanel/i, /amazonaws\.com$/i,
];
const FORBIDDEN_ROLES = new Set(["kanaf_adel", "postgres"]);
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

function die(reason) {
  // console.error قد يكون مُعاداً تعريفه لاحقاً؛ نكتب مباشرة.
  process.stderr.write(`\n[KANAF TEST GUARD] REFUSED: ${reason}\n` +
    `[KANAF TEST GUARD] لم يُنفَّذ أي اتصال كاتب. راجع test-support/README.md\n\n`);
  process.exit(EXIT_CODE);
}

function parseTarget(urlString, label) {
  let u;
  try { u = new URL(urlString); } catch { die(`${label} ليس عنواناً صالحاً`); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) die(`${label}: البروتوكول ليس postgres`);
  // pg يقبل ?host=/path/to/socket لمقبس unix
  const socketHost = u.searchParams.get("host");
  const host = socketHost || decodeURIComponent(u.hostname || "");
  const role = decodeURIComponent(u.username || "");
  const database = decodeURIComponent((u.pathname || "").replace(/^\//, ""));
  const port = u.searchParams.get("port") || u.port || "5432";
  return { host, role, database, port, isSocket: Boolean(socketHost && socketHost.startsWith("/")) };
}

function assertHostAllowed(t, label) {
  if (!t.host) die(`${label}: لا مضيف`);
  if (PRODUCTION_HOST_PATTERNS.some((re) => re.test(t.host))) die(`${label}: مضيف إنتاج معروف (${t.host})`);
  if (t.isSocket) return;
  const extra = (process.env.KANAF_TEST_ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!LOOPBACK.has(t.host) && !extra.includes(t.host)) {
    die(`${label}: المضيف ${t.host} ليس loopback ولا معلناً في KANAF_TEST_ALLOWED_HOSTS`);
  }
}

/* ---------- 1) الإعداد ---------- */
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) die("TEST_DATABASE_URL غير مضبوط (لا fallback إلى DATABASE_URL)");
if (process.env.DATABASE_URL && process.env.DATABASE_URL !== TEST_URL) {
  die("DATABASE_URL مضبوط بقيمة تختلف عن TEST_DATABASE_URL — بيئة مختلطة");
}
const MARKER = process.env.KANAF_TEST_MARKER;
if (!MARKER || MARKER.length < 16) die("KANAF_TEST_MARKER غائب أو أقصر من 16 حرفاً");

/* ---------- 2) و 3) الهدف والدور (ثابتاً) ---------- */
const target = parseTarget(TEST_URL, "TEST_DATABASE_URL");
assertHostAllowed(target, "TEST_DATABASE_URL");
if (!target.role) die("TEST_DATABASE_URL بلا دور صريح");
if (FORBIDDEN_ROLES.has(target.role.toLowerCase())) die(`الدور ${target.role} ممنوع في الاختبار`);

let superTarget = null;
if (process.env.SUPERUSER_URL) {
  superTarget = parseTarget(process.env.SUPERUSER_URL, "SUPERUSER_URL");
  assertHostAllowed(superTarget, "SUPERUSER_URL");
  if (superTarget.host !== target.host || superTarget.port !== target.port) {
    die("SUPERUSER_URL لا يشير إلى نفس الخادم المعزول");
  }
}

/* ---------- 6) عزل المزودات قبل أي استيراد ---------- */
if ((process.env.PAYMENT_SECRET_KEY || "").startsWith("sk_live_")) die("مفتاح دفع حي في بيئة الاختبار");
if (process.env.NODE_ENV === "production") die("NODE_ENV=production في بيئة الاختبار");
/* قيمة فارغة لا حذف: dotenv لا يكتب فوق مفتاح موجود ولو فارغاً، فلو
   استورد ملفٌ لاحقاً index.js (وفيه dotenv/config) لا يعيد .env أسرار
   SMTP الحقيقية. والكود يعامل الفارغ كغير مضبوط (Boolean). */
for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_PORT", "VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY",
  "VAPID_SUBJECT", "ANTHROPIC_API_KEY", "SETUP_TOKEN", "UNSUBSCRIBE_SECRET"]) process.env[k] = "";
process.env.NODE_ENV = "test";
process.env.PAYMENT_SECRET_KEY = process.env.PAYMENT_SECRET_KEY || "sk_test_guarded_fake";
process.env.PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || "guarded-test-webhook-secret";
process.env.DB_SSL = "false";

/* ---------- 4) و 5) الهوية الفعلية بقراءة فقط (متزامن) ---------- */
function probe(url, expectSuper) {
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, "guard-probe.mjs")], {
      env: { PATH: process.env.PATH, PROBE_URL: url, PROBE_MARKER: MARKER, PROBE_EXPECT_SUPER: expectSuper ? "1" : "0" },
      timeout: 15000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out.trim().split("\n").pop());
  } catch (e) {
    die(`فحص الهوية فشل: ${(e.stderr || e.message || "").toString().trim().split("\n").pop()}`);
  }
}
const id = probe(TEST_URL, false);
if (id.database !== target.database) die("القاعدة المتصل بها لا تطابق العنوان");
if (id.purpose) process.env.KANAF_TEST_DB_PURPOSE = id.purpose;
if (superTarget) probe(process.env.SUPERUSER_URL, true);

/* pool.js يقرأ DATABASE_URL — نثبّته على الهدف المتحقَّق منه. */
process.env.DATABASE_URL = TEST_URL;

/* ---------- 7) الشبكة: loopback فقط ---------- */
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0];
  let host, socketPath;
  if (opts && typeof opts === "object") { host = opts.host; socketPath = opts.path; }
  else if (typeof opts === "number" || /^\d+$/.test(String(opts))) host = typeof args[1] === "string" ? args[1] : "localhost";
  else if (typeof opts === "string") socketPath = opts;
  const ok = socketPath ? String(socketPath).startsWith("/") : (!host || LOOPBACK.has(host) || host === "0.0.0.0"
    || (process.env.KANAF_TEST_ALLOWED_HOSTS || "").split(",").includes(host));
  if (!ok) {
    const err = new Error(`[KANAF TEST GUARD] outbound connection to ${host} blocked`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return origConnect.apply(this, args);
};

process.env.KANAF_TEST_GUARD_ACTIVE = "1";
if (!process.env.KANAF_TEST_GUARD_QUIET) {
  process.stderr.write(`[KANAF TEST GUARD] OK db=${id.database} role=${id.user} server=${id.addr}:${id.port}` +
    `${id.purpose ? ` purpose=${id.purpose}` : ""}\n`);
}

/**
 * لملفات تفترض قاعدة نظيفة أو تكتب كتابات عامة (TRUNCATE/نشر جماعي):
 * تشترط أن المشغّل أنشأ هذه القاعدة لهذا الملف وحده من القالب.
 */
export function requireDedicatedDatabase(fileUrl) {
  const name = path.basename(fileURLToPath(fileUrl));
  if (process.env.KANAF_TEST_DB_PURPOSE !== name) {
    die(`${name} يحتاج قاعدة مخصّصة له (purpose=${name})، والقاعدة الحالية purpose=${process.env.KANAF_TEST_DB_PURPOSE || "∅"}. شغّله عبر test-support/run-tests.mjs`);
  }
}
