import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0013 §3.1 — دليل المتصفّح الحقيقي (Chromium عبر Playwright) على الخادم الكامل (index.js)
 * واللوحة المبنية (admin-ui)، على قاعدة الاختبار المعزولة.
 *  N) عناصر القائمة الجانبية روابط <a href> حقيقية نسبية.
 *  T) Ctrl+نقر يفتح تبويباً جديداً بالعنوان نفسه ويبقي الأصل مكانه.
 *  U) عنوان منسوخ بفلاتره يفتح الشاشة نفسها بفلاتره في سياق جديد بعد الدخول.
 *  B) الرجوع والتقدّم في المتصفّح، والفتح المباشر لعنوان عميق.
 *  L) اسم العميل رابط حقيقي إلى ملفه.
 *  F) احتياط SPA: مسار اللوحة يعيد الصفحة، و/admin و/api المجهولان JSON 404.
 * ⚠️ قائمة «افتح في تبويب جديد» الأصلية للمتصفّح لا تُلتقط في وضع بلا واجهة؛ يغنينا عنها أن
 *    العنصر <a href> (N) — وهو بالضبط ما يجعل المتصفّح يعرضها.
 * لا يعمل إن غاب Playwright: يُسجَّل SKIP بلا فشل.
 */
requireDedicatedDatabase(import.meta.url);
let chromium;
/* المشغّل يبني بيئة من الصفر (بلا NODE_PATH)، فيُبحث عن Playwright المثبَّت عاماً أيضاً. */
const { createRequire } = await import("node:module");
const { existsSync } = await import("node:fs");
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/opt/pw-browsers")) process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
for (const base of [import.meta.url, "file:///opt/node-tools/", "file:///usr/local/lib/node_modules_global/"]) {
  try { ({ chromium } = createRequire(base)("playwright")); break; } catch { /* التالي */ }
}
if (!chromium) { console.log("  SKIP  Playwright غير متاح في هذه البيئة"); process.exit(0); }
process.env.PORT = "4644";
process.env.SKIP_PDF_BOOT_CHECK = "1";
/* لقطات الدليل: test-support/.local/e2e (خارج git) — المشغّل لا يمرّر متغيّرات البيئة. */
const shots = new URL("./test-support/.local/e2e", import.meta.url).pathname;
(await import("node:fs")).mkdirSync(shots, { recursive: true });
const bcrypt = (await import("bcrypt")).default;
const logs = []; console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
await new Promise((r) => setTimeout(r, 300));
const out = (s) => process.stdout.write(s + "\n");
const B = "http://127.0.0.1:4644";
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const PW = "Owner-E2E-Pass-2026-long";
let browser;

async function login(page, email) {
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForSelector("nav a[href]", { timeout: 15000 });
}

try {
  await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('المالك','e2e-owner@kanaf.test',$1,'owner')`, [await bcrypt.hash(PW, 12)]);
  const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at,confirmed_adult) VALUES ('سارة الاختبار','sara-e2e@example.com','x',now(),true) RETURNING id`);
  await query(`INSERT INTO users (name,email,password_hash,email_verified_at,confirmed_adult) VALUES ('خالد آخر','khaled-e2e@example.com','x',now(),true)`);
  await query(`INSERT INTO invoices (user_id, plan_id, amount_sar, status) VALUES ($1,'monthly',29,'paid')`, [u.id]);

  /* ---------- F) الخادم ---------- */
  const f1 = await fetch(`${B}/users/${u.id}/billing`);
  const f2 = await fetch(`${B}/admin/no-such-thing`);
  const f3 = await fetch(`${B}/api/no-such-thing`);
  ok("F1 مسار لوحة عميق يعيد صفحة اللوحة (احتياط SPA)", f1.status === 200 && /text\/html/.test(f1.headers.get("content-type")));
  ok("F2 /admin/مجهول و/api/مجهول → JSON 404 لا الصفحة", f2.status === 404 && /json/.test(f2.headers.get("content-type")) && f3.status === 404 && /json/.test(f3.headers.get("content-type")));

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${B}/`);
  await login(page, "e2e-owner@kanaf.test");

  /* ---------- N) ---------- */
  const navHrefs = await page.$$eval("nav a", (as) => as.map((a) => a.getAttribute("href")));
  ok("N1 كل عناصر القائمة <a> بـhref نسبي حقيقي", navHrefs.length >= 15 && navHrefs.every((h) => /^\/[a-z-]+$/.test(h)), navHrefs.join(" "));
  ok("N2 لا رابط مطلق في القائمة (يعمل على admin.tanfs.net وonrender.com معاً)", !navHrefs.some((h) => /^https?:/.test(h)));
  if (shots) await page.screenshot({ path: `${shots}/e2e-1-overview.png` });

  /* ---------- T) ---------- */
  const [popup] = await Promise.all([
    ctx.waitForEvent("page", { timeout: 10000 }),
    page.click('nav a[href="/invoices"]', { modifiers: ["Control"] }),
  ]);
  await popup.waitForLoadState();
  ok("T1 Ctrl+نقر على «الفواتير» يفتح تبويباً جديداً بعنوانه", new URL(popup.url()).pathname === "/invoices", popup.url());
  ok("T2 والتبويب الأصلي لم يتحرّك", new URL(page.url()).pathname === "/" || new URL(page.url()).pathname === "/overview", page.url());
  await popup.waitForSelector(`a[href="/users/${u.id}"]`, { timeout: 15000 });
  ok("L1 اسم العميل في الفواتير رابط حقيقي إلى ملفه", (await popup.textContent(`a[href="/users/${u.id}"]`)).includes("سارة"));
  if (shots) await popup.screenshot({ path: `${shots}/e2e-2-invoices-newtab.png` });
  await popup.close();

  /* ---------- U) ---------- */
  await page.click('nav a[href="/users"]');
  await page.fill('input[placeholder="اسم أو بريد أو معرّف…"]', "سارة");
  await page.waitForFunction(() => new URLSearchParams(location.search).get("q") === "سارة", null, { timeout: 10000 });
  await page.waitForSelector(`a[href="/users/${u.id}"]`);
  const copied = page.url();
  const rowsBefore = await page.$$eval("tbody tr", (t) => t.length);
  ok("U1 الفلتر في عنوان الصفحة (q=سارة)", new URL(copied).searchParams.get("q") === "سارة" && rowsBefore === 1, copied);

  const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const p2 = await ctx2.newPage();
  await p2.goto(copied);
  ok("U2 سياق جديد بلا جلسة: العنوان المنسوخ يطلب الدخول", await p2.isVisible('input[type="password"]'));
  await login(p2, "e2e-owner@kanaf.test");
  await p2.waitForSelector(`a[href="/users/${u.id}"]`, { timeout: 15000 });
  ok("U3 وبعد الدخول: الشاشة نفسها بفلترها، والنتيجة نفسها", new URL(p2.url()).pathname === "/users" && (await p2.inputValue('input[placeholder="اسم أو بريد أو معرّف…"]')) === "سارة" && (await p2.$$eval("tbody tr", (t) => t.length)) === 1, p2.url());
  if (shots) await p2.screenshot({ path: `${shots}/e2e-3-copied-url-fresh-context.png` });

  /* ---------- B) ---------- */
  await page.click(`a[href="/users/${u.id}"]`);
  await page.waitForFunction((id) => location.pathname.startsWith(`/users/${id}`), u.id);
  await page.goBack();
  await page.waitForFunction(() => location.pathname === "/users");
  ok("B1 «رجوع» المتصفّح يعيد القائمة بفلترها", new URL(page.url()).searchParams.get("q") === "سارة");
  await page.goForward();
  await page.waitForFunction((id) => location.pathname.startsWith(`/users/${id}`), u.id);
  ok("B2 و«تقدّم» يعيد الملف", new URL(page.url()).pathname.startsWith(`/users/${u.id}`));
  const p3 = await ctx.newPage();
  await p3.goto(`${B}/templates/message/email_verification`);
  await p3.waitForSelector("iframe[title='معاينة']", { timeout: 15000 });
  ok("B3 فتح مباشر لعنوان عميق (/templates/message/email_verification) يعرض المحرّر ومعاينته", (await p3.textContent("h2")).includes("كود التحقق"));
  if (shots) await p3.screenshot({ path: `${shots}/e2e-4-deep-link-template.png` });
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 400), false); }
finally { await browser?.close().catch(() => {}); await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; out(`  PASS  ${l}`); } else { fail++; out(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 300)})` : ""}`); } }
out(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
