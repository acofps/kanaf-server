import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0015 — ملاحظات المالك الثماني في متصفّح حقيقي على الخادم الكامل واللوحة المبنية.
 *  L) 2.1 الشعار في معاينة القالب يُحمَّل فعلاً (صورة بأبعاد، لا مكسورة).
 *  G) 2.3/2.4 تحديد الباقة يُرى (aria-pressed وتعبئة)، و«qw» يُوقَف قبل أي طلب.
 *  U) 2.5 المستخدمون: المراسلة الجماعية تتبع الفلتر، والتحديد يغيّر الهدف، وما يصل الإرسال هو العدد المعلن؛
 *     أيقونات السطر أزرار بأسماء مقروءة ولمس 44، والمطفأة بسببها؛ وعلى الجوال يمرّر الجدول داخل صندوقه.
 *  I) 2.7 الفواتير: الترويسة = مجموع الفلتر من الخادم، وسطر النطاق، ورابط التصدير يحمل الفلتر،
 *     والمعاينة inline خلف الجلسة والتنزيل attachment.
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
process.env.PORT = "4654";
process.env.SKIP_PDF_BOOT_CHECK = "1";
const bcrypt = (await import("bcrypt")).default;
const logs = []; console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
await new Promise((r) => setTimeout(r, 300));
const out = (s) => process.stdout.write(s + "\n");
const B = "http://127.0.0.1:4654";
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const PW = "Owner-ORD15-Standards-2026-long";
let browser;

try {
  await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('المالك','o15-owner@kanaf.test',$1,'owner')`, [await bcrypt.hash(PW, 12)]);
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at,confirmed_adult) VALUES ($1,$2,'x',now(),true) RETURNING id`, [`عضو ${i + 1}`, `o15-m${i + 1}@example.com`]);
    ids.push(u.id);
    await query(`INSERT INTO user_auth_state (user_id, suspended_at) VALUES ($1, $2)`, [u.id, i < 2 ? new Date() : null]);
    const plan = i % 2 ? "monthly" : "annual", price = i % 2 ? 29 : 229;
    await query(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, zatca_invoice_number, subtotal_sar, vat_sar, zatca_issued_at, pdf_data)
      VALUES ($1,$2,$3,'paid',$4,$5,$6,now(),$7)`, [u.id, plan, price, `TNFS-INV-0154${i}0`, Math.round(price / 1.15 * 100) / 100, Math.round((price - price / 1.15) * 100) / 100, Buffer.from("%PDF-1.4\n%o15\n")]);
  }

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(`${page.url()} ${e.message}`));
  await page.goto(`${B}/`);
  await page.fill('input[type="email"]', "o15-owner@kanaf.test");
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForSelector("nav a[href]", { timeout: 15000 });
  const api = async (p) => page.evaluate(async (u) => (await fetch(u, { credentials: "include" })).json(), p);

  /* ---------- L) ---------- */
  await page.goto(`${B}/templates/message/email_verification`);
  await page.waitForSelector("iframe[title='معاينة']"); await page.waitForTimeout(800);
  const img = await page.frameLocator("iframe[title='معاينة']").locator("img").first().evaluate((i) => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.getAttribute("src").slice(0, 22) }));
  ok("L1 🔴 الشعار في معاينة القالب يُحمَّل (153×232 لا صورة مكسورة)", img.w === 153 && img.h === 232 && img.src === "data:image/png;base64,", JSON.stringify(img));

  /* ---------- G) ---------- */
  await page.goto(`${B}/discounts/new`); await page.waitForSelector("h1, h2");
  const chip = page.locator("button[aria-pressed]", { hasText: "الباقة الشهرية" }).first();
  const before = await chip.evaluate((el) => ({ p: el.getAttribute("aria-pressed"), bg: getComputedStyle(el).backgroundColor }));
  await chip.click(); await page.waitForTimeout(400); // انتقال اللون (transition) قبل القراءة
  const after = await chip.evaluate((el) => ({ p: el.getAttribute("aria-pressed"), bg: getComputedStyle(el).backgroundColor, check: !!el.querySelector("svg") }));
  ok("G1 تحديد الباقة يُرى: aria-pressed يتغيّر، والتعبئة تتغيّر، وعلامة ✓", before.p === "false" && after.p === "true" && before.bg !== after.bg && after.check, JSON.stringify({ before, after }));
  let posted = 0; page.on("request", (r) => { if (/\/admin\/discount-codes$/.test(r.url()) && r.method() === "POST") posted++; });
  await page.locator('input[dir="ltr"]').first().fill("qw");
  await page.locator('input[type="number"]').first().fill("10");
  const create = page.locator("button", { hasText: "إنشاء" }).first();
  const disabled = await create.isDisabled();
  const msg = await page.locator('[role="status"]').first().innerText().catch(() => "");
  ok("G2 🔴 «qw» يُوقَف قبل الإرسال برسالة تقول القاعدة والطول (ولا طلب يُرسَل)", disabled && /3 إلى 32/.test(msg) && /2/.test(msg) && posted === 0, `${disabled} ${msg}`);

  /* ---------- U) ---------- */
  const all = await api("/admin/users?pageSize=1");
  await page.goto(`${B}/users`); await page.waitForSelector("[data-bulk-target]"); await page.waitForSelector("table.kt tbody tr");
  await page.waitForFunction((n) => document.querySelector("[data-bulk-target]").innerText.includes(`(${n})`), all.total, { timeout: 10000 }).catch(() => {});
  let target = await page.locator("[data-bulk-target]").innerText();
  ok(`U1 بلا تحديد: الهدف كل المعروضين بعددهم من الخادم (${all.total})`, target.includes("لا أحد محدَّد") && target.includes(`(${all.total})`), target);
  const susp = await api("/admin/users?pageSize=1&status=suspended");
  await page.goto(`${B}/users?status=suspended`); await page.waitForSelector("table.kt tbody tr");
  await page.waitForFunction((n) => document.querySelector("[data-bulk-target]")?.innerText.includes(`(${n})`), susp.total, { timeout: 10000 }).catch(() => {});
  target = await page.locator("[data-bulk-target]").innerText();
  ok(`U2 🔴 العدد يتبع الفلتر المطبَّق لا القاعدة كلها (${susp.total} موقوف من ${all.total})`, susp.total === 2 && target.includes(`(${susp.total})`) && target.includes("بالفلتر المطبَّق"), target);
  await page.locator("button", { hasText: "إشعار داخلي" }).first().click();
  await page.waitForSelector("text=مراسلة 2 عضواً", { timeout: 15000 }).catch(() => {});
  const composeText = await page.locator("main").innerText();
  const inApp = await page.locator("button[aria-pressed='true']", { hasText: "داخل التطبيق" }).count();
  ok("U3 الإرسال بلا تحديد يجمّد المعروض بالفلتر نفسه: المستلمون 2 والقناة المختارة محدَّدة", /: 2 —/.test(composeText) && inApp === 1 && page.url().includes("/users/message"), `${page.url()} ${inApp} ${composeText.slice(0, 600)}`);

  await page.goto(`${B}/users`); await page.waitForSelector("table.kt tbody tr");
  const boxes = page.locator("table.kt tbody input[type=checkbox]");
  await boxes.nth(0).check(); await boxes.nth(1).check();
  target = await page.locator("[data-bulk-target]").innerText();
  ok("U4 التحديد يغيّر الهدف: «2 عضواً محدَّداً»", /2 عضواً محدَّداً/.test(target), target);
  await page.locator("button", { hasText: "إشعار داخلي" }).first().click();
  await page.waitForSelector("text=مراسلة 2 عضواً", { timeout: 15000 }).catch(() => {});
  ok("U5 الإرسال للمحدَّدين وحدهم: شاشة الإرسال بـ2 مستلمين", /مراسلة 2 عضواً/.test(await page.locator("main").innerText()));

  await page.goto(`${B}/users`); await page.waitForSelector("table.kt tbody tr");
  const rowBtns = await page.evaluate(() => [...document.querySelectorAll("table.kt tbody tr")][0].querySelectorAll("td button"))
    .catch(() => null);
  const a11y = await page.evaluate(() => {
    const tr = document.querySelector("table.kt tbody tr");
    const name = tr.querySelector("a").innerText.trim();
    return [...tr.querySelectorAll("td button")].map((b) => ({ label: b.getAttribute("aria-label") || "", w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, off: b.disabled, name }));
  });
  ok("U6 أيقونات السطر خمس أزرار، كلٌّ باسم يذكر العضو، ولمس 44×44", a11y.length === 5 && a11y.every((b) => b.label.includes(b.name) && b.w >= 44 && b.h >= 44), JSON.stringify(a11y.map((b) => [b.label, b.w, b.h])));
  ok("U7 القناة غير المهيّأة مطفأة بسببها لا مخفية (sms ثابت غير مفعّل)", a11y.some((b) => b.off && /رسالة نصية .*غير مفعّل.*مزوّد SMS/.test(b.label)), JSON.stringify(a11y.filter((b) => b.off).map((b) => b.label)));
  void rowBtns;

  /* ---------- I) ---------- */
  const inv = await api("/admin/billing/invoices?status=paid&plan=monthly");
  await page.goto(`${B}/invoices?plan=monthly`); await page.waitForSelector("[data-tile]"); await page.waitForTimeout(400);
  const tiles = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-tile]")].map((t) => [t.getAttribute("data-tile"), t.innerText.split("\n")[1]])));
  const scope = await page.locator("[data-scope]").innerText();
  const num = (s) => Number((String(s).replace(/,/g, "").match(/\d+(?:\.\d+)?/) || ["NaN"])[0]);
  ok(`I1 🔴 الترويسة = مجموع الفلتر من الخادم (الباقة الشهرية: ${inv.summary.count} فواتير)`, inv.summary.count === 3 && num(tiles["عدد الفواتير"]) === 3
    && num(tiles["الإجمالي المحصَّل بعد الضريبة"]) === Number(inv.summary.total) && num(tiles["الإيراد قبل الضريبة"]) === Number(inv.summary.subtotal)
    && num(tiles["ضريبة القيمة المضافة"]) === Number(inv.summary.vat), JSON.stringify({ tiles, s: inv.summary }));
  ok("I2 سطر النطاق يقول على أي فلتر حُسبت", /الباقة: الباقة الشهرية/.test(scope) && /كل التاريخ/.test(scope), scope);
  const exportHref = await page.locator("a[href*='/exports/invoices.csv']").getAttribute("href");
  ok("I3 رابط التصدير يحمل فلتر الشاشة نفسه", /plan=monthly/.test(exportHref) && /status=paid/.test(exportHref), exportHref);
  const pv = await page.locator("[data-preview]").first().getAttribute("href");
  const dl = await page.locator("[data-download]").first().getAttribute("href");
  const head = await page.evaluate(async ([a, b]) => {
    const r1 = await fetch(a, { credentials: "include" }); const r2 = await fetch(b, { credentials: "include" });
    return { s: r1.status, cd: r1.headers.get("content-disposition"), csp: r1.headers.get("content-security-policy"), s2: r2.status, cd2: r2.headers.get("content-disposition") };
  }, [pv, dl]);
  const anon = await fetch(B + pv);
  ok("I4 🔴 المعاينة inline والتنزيل attachment، وكلاهما خلف جلسة الإدارة (بلا جلسة 401)",
    head.s === 200 && /^inline/.test(head.cd) && head.s2 === 200 && /^attachment/.test(head.cd2) && anon.status === 401, JSON.stringify({ ...head, anon: anon.status }));
  ok("I5 ملف PDF بسياسة تسمح لعارض المتصفّح (لا object-src 'none')، ولا مورد خارجي", !/object-src 'none'/.test(head.csp) && /default-src 'none'/.test(head.csp), head.csp);

  /* ---------- M) الجوال ---------- */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await mctx.newPage();
  await mp.goto(`${B}/`); await mp.fill('input[type="email"]', "o15-owner@kanaf.test"); await mp.fill('input[type="password"]', PW);
  await mp.click('button[type="submit"]'); await mp.waitForSelector("nav a[href]", { state: "attached", timeout: 15000 });
  const mob = {};
  for (const p of ["/users", "/invoices"]) {
    await mp.goto(`${B}${p}`); await mp.waitForSelector("table.kt", { timeout: 15000 }).catch(() => {}); await mp.waitForTimeout(300);
    mob[p] = await mp.evaluate(() => { const s = document.querySelector(".kt-scroll"); return { page: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, box: s ? s.scrollWidth > s.clientWidth : false }; });
  }
  ok("M1 🔴 390px: لا تمرير أفقي للصفحة، والجدول يمرّر داخل صندوقه (المستخدمون والفواتير)", Object.values(mob).every((m) => m.page && m.box), JSON.stringify(mob));
  ok("E1 بلا خطأ JavaScript في أي صفحة", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 400), false); }
finally { await browser?.close().catch(() => {}); await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; out(`  PASS  ${l}`); } else { fail++; out(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 600)})` : ""}`); } }
out(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
