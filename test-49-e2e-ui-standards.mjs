import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0014 §2.7 — معايير الواجهة القائمة، في متصفّح حقيقي على الخادم الكامل واللوحة المبنية.
 * لكل قسم في القائمة ولكل شاشة جديدة عميقة:
 *  L 🔴 تحميل مباشر للعنوان (= تحديث الصفحة) يعرض الشاشة بلا خطأ في الصفحة.
 *  T عنوان التبويب خاص بالشاشة (لا «لوحة تحكم تنفس بحرية» واحدة لكل شيء) — يُحفظ في المفضّلة باسمه.
 *  D الأرقام لاتينية (ORD-0008 §2.6): لا ٠–٩ ولا ۰–۹ في نصّ الصفحة.
 *  M عرض الجوال (390px): لا تمرير أفقي للصفحة.
 *  K الوضع الداكن: يُطبَّق ويبقى بعد التحديث، والخلفية داكنة فعلاً، بلا خطأ.
 *  J /admin/* و/api/* المجهولان JSON 404 لا HTML.
 * لا يعمل إن غاب Playwright: SKIP بلا فشل.
 */
requireDedicatedDatabase(import.meta.url);
let chromium;
{
  const { createRequire } = await import("node:module");
  const { existsSync } = await import("node:fs");
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/opt/pw-browsers")) process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
  for (const base of [import.meta.url, "file:///opt/node-tools/", "file:///usr/local/lib/node_modules_global/"]) {
    try { ({ chromium } = createRequire(base)("playwright")); break; } catch { /* التالي */ }
  }
}
if (!chromium) { console.log("  SKIP  Playwright غير متاح في هذه البيئة"); process.exit(0); }
process.env.PORT = "4649";
process.env.SKIP_PDF_BOOT_CHECK = "1";
const bcrypt = (await import("bcrypt")).default;
const fs = await import("node:fs");
const shots = new URL("./test-support/.local/e2e", import.meta.url).pathname; fs.mkdirSync(shots, { recursive: true });
const logs = []; console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
await new Promise((r) => setTimeout(r, 300));
const out = (s) => process.stdout.write(s + "\n");
const B = "http://127.0.0.1:4649";
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const PW = "Owner-UI-Standards-2026-long";
const PANEL = "لوحة تنفس بحرية";
const ARABIC_DIGITS = /[٠-٩۰-۹]/;
let browser;

try {
  await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('المالك','ui-owner@kanaf.test',$1,'owner')`, [await bcrypt.hash(PW, 12)]);
  const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at,confirmed_adult) VALUES ('سارة 2026','sara-ui@example.com','x',now(),true) RETURNING id`);
  await query(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, zatca_invoice_number) VALUES ($1,'monthly',29,'paid','TNFS-INV-000123')`, [u.id]);
  await query(`INSERT INTO system_errors (fingerprint, kind, message, location, count) VALUES ('fp-ui', 'TypeError', 'x is undefined at 12345', 'GET /admin/users', 3)`);

  const SECTIONS = [["overview", "نظرة عامة"], ["users", "المستخدمون"], ["messages", "الرسائل"], ["sent", "الرسائل المرسلة"], ["content", "المحتوى"],
    ["notifications", "الإشعارات والتسويق"], ["carts", "السلات المتروكة"], ["plans", "الباقات"], ["subscribers", "الاشتراكات"],
    ["cancelled-members", "الأعضاء الملغون"], ["discounts", "أكواد الخصم"], ["invoices", "الفواتير"], ["billing", "المالية"], ["settings", "الإعدادات"],
    ["integrations", "التكاملات"], ["admin-users", "حسابات الإدارة"], ["audit-log", "سجل الإجراءات"], ["access-log", "سجل الوصول"],
    ["templates", "قوالب الرسائل"], ["errors", "أخطاء النظام"]];
  const DEEP = [[`/users/${u.id}`, "سارة 2026"], [`/users/${u.id}/edit`, "سارة 2026"], [`/users/${u.id}/billing`, "سارة 2026"],
    ["/templates/message/email_verification", "كود التحقق من البريد"], ["/templates/t/new", "قالب جديد"],
    ["/subscribers/autorenew", "التجديد التلقائي"], ["/admin-users/new", null], ["/notifications/new", null]];
  const ROUTES = [...SECTIONS.map(([k, l]) => [`/${k}`, l]), ...DEEP];

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(`${page.url()} ${e.message}`));
  await page.goto(`${B}/`);
  ok("T0 شاشة الدخول لها عنوانها", (await page.title()) === `تسجيل الدخول · ${PANEL}`, await page.title());
  await page.fill('input[type="email"]', "ui-owner@kanaf.test");
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForSelector("nav a[href]", { timeout: 15000 });

  const loadFail = [], titleFail = [], digitFail = [], titles = new Map();
  for (const [p, label] of ROUTES) {
    await page.goto(`${B}${p}`);                                   // تحميل مباشر = تحديث الصفحة
    await page.waitForSelector("main h1, main h2, h2", { timeout: 15000 }).catch(() => loadFail.push(p));
    await page.waitForTimeout(400);
    const t = await page.title();
    titles.set(p, t);
    if (t === PANEL || t === `لوحة تحكم ${PANEL}` || !t.endsWith(`· ${PANEL}`) || (label && !t.startsWith(label))) titleFail.push(`${p}→${t}`);
    const text = await page.evaluate(() => document.body.innerText);
    if (ARABIC_DIGITS.test(text)) digitFail.push(`${p}: ${(text.match(/.{0,20}[٠-٩۰-۹].{0,20}/) || [""])[0]}`);
  }
  ok(`L1 🔴 تحميل مباشر/تحديث لـ${ROUTES.length} عنواناً يعرض الشاشة`, loadFail.length === 0, loadFail.join(" "));
  ok("L2 بلا خطأ JavaScript في أي صفحة", errors.length === 0, errors.slice(0, 3).join(" | "));
  ok(`T1 كل شاشة بعنوان تبويب خاص بها («الشاشة · ${PANEL}»)`, titleFail.length === 0, titleFail.join(" | "));
  ok("T2 العناوين مختلفة بين الأقسام (لا تتشابه المفضّلات)", new Set(SECTIONS.map(([k]) => titles.get(`/${k}`))).size === SECTIONS.length);
  ok(`D1 الأرقام لاتينية في كل الشاشات (${ROUTES.length})`, digitFail.length === 0, digitFail.join(" | "));

  /* تحديث فعلي (reload) على شاشة عميقة */
  await page.goto(`${B}/templates/message/email_verification`);
  await page.waitForSelector("iframe[title='معاينة']");
  await page.reload();
  await page.waitForSelector("iframe[title='معاينة']", { timeout: 15000 });
  ok("L3 page.reload على شاشة عميقة يعيدها كما هي بعنوانها", (await page.title()).startsWith("كود التحقق من البريد"));

  /* ---------- M) الجوال ---------- */
  /* دخول داخل سياق الجوال نفسه — نقل الجلسة بـstorageState لم يحملها، فكان الفحص يقيس شاشة الدخول. */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const mp = await mctx.newPage();
  await mp.goto(`${B}/`);
  await mp.fill('input[type="email"]', "ui-owner@kanaf.test");
  await mp.fill('input[type="password"]', PW);
  await mp.click('button[type="submit"]');
  await mp.waitForFunction(() => !!document.querySelector("nav a[href]") || location.pathname !== "/", null, { timeout: 15000 }).catch(() => {});
  const overflow = [], notSignedIn = [];
  for (const [p] of ROUTES) {
    await mp.goto(`${B}${p}`);
    await mp.waitForSelector("h1, h2", { timeout: 15000 }).catch(() => {});
    await mp.waitForTimeout(300);
    const w = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, login: !document.querySelector("nav a[href]") }));
    if (w.login) notSignedIn.push(p);
    if (w.sw > w.cw + 1) overflow.push(`${p} (${w.sw}>${w.cw})`);
  }
  await mp.goto(`${B}/subscribers/autorenew`); await mp.waitForTimeout(400);
  await mp.screenshot({ path: `${shots}/ui-mobile-autorenew.png`, fullPage: true });
  ok(`M0 سياق الجوال داخل الجلسة فعلاً (لا شاشة دخول) في ${ROUTES.length} شاشة`, notSignedIn.length === 0, notSignedIn.join(" "));
  ok(`M1 عرض 390px: لا تمرير أفقي للصفحة في ${ROUTES.length} شاشة`, overflow.length === 0, overflow.join(" | "));

  /* ---------- K) الداكن ---------- */
  await page.goto(`${B}/templates`); await page.waitForSelector("h1, h2");
  await page.evaluate(() => localStorage.setItem("tanaffus-admin-theme", "dark"));
  await page.reload(); await page.waitForSelector("h1, h2"); await page.waitForTimeout(300);
  const dark = await page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    const lum = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255;
    return { attr: document.documentElement.getAttribute("data-theme"), lum };
  });
  await page.screenshot({ path: `${shots}/ui-dark-templates.png` });
  const darkErr = [];
  for (const p of ["/subscribers/autorenew", "/cancelled-members", "/errors", `/users/${u.id}/billing`]) {
    await page.goto(`${B}${p}`); await page.waitForSelector("h1, h2", { timeout: 15000 }).catch(() => darkErr.push(p));
  }
  ok("K1 الوضع الداكن يُطبَّق ويبقى بعد التحديث، والخلفية داكنة فعلاً", dark.attr === "dark" && dark.lum < 0.25, JSON.stringify(dark));
  ok("K2 الشاشات الجديدة تعمل في الداكن بلا خطأ", darkErr.length === 0 && errors.length === 0, [...darkErr, ...errors].join(" | "));

  /* ---------- J) ---------- */
  const j1 = await fetch(`${B}/admin/no-such-route`), j2 = await fetch(`${B}/api/no-such-route`), h = await fetch(`${B}/templates/message/x`);
  ok("J1 /admin/* و/api/* المجهولان JSON 404، ومسار اللوحة HTML", j1.status === 404 && /json/.test(j1.headers.get("content-type")) && j2.status === 404 && /json/.test(j2.headers.get("content-type")) && /html/.test(h.headers.get("content-type")));
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 400), false); }
finally { await browser?.close().catch(() => {}); await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; out(`  PASS  ${l}`); } else { fail++; out(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 600)})` : ""}`); } }
out(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
