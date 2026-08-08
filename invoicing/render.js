import puppeteer from "puppeteer";

/**
 * ============================================================
 * محرّك تحويل HTML إلى PDF
 * ============================================================
 *
 * لماذا متصفّح أصلاً؟
 * -------------------
 * pdfkit لا يقوم بأي «تشكيل» للنص (text shaping): يرسم كل حرف
 * بشكله المنعزل ولا يصل الحروف ولا يعكس ترتيب السطر. الحيلة
 * القديمة (arabic-reshaper + عكس يدوي) تعتمد على كتلة
 * Presentation Forms-B في يونيكود، والخطوط الحديثة — ومنها خط
 * التطبيق IBM Plex Sans Arabic — لا تحتوي هذه الكتلة أصلاً،
 * فينتج نص مقطّع مقلوب. هذي هي المشكلة التي ظهرت في الفاتورة
 * الأولى حرفياً.
 *
 * Chromium يملك محرّك تشكيل كامل (HarfBuzz) ويطبّق خوارزمية
 * bidi القياسية. فتوليد الوثيقة عبره ليس ترفاً في التصميم،
 * بل هو الطريقة الوحيدة التي تُخرج عربية صحيحة بخط التطبيق نفسه.
 *
 * الحرص على الذاكرة (الخادم على خطة 512MB)
 * ----------------------------------------
 * • متصفّح واحد فقط في كل لحظة، يُفتح عند أول طلب.
 * • قفل تسلسلي: صفحتان لا تُرسمان معاً مهما تزامنت الطلبات.
 * • يُغلق المتصفّح تلقائياً بعد فترة خمول، فلا يبقى محجوزاً
 *   للذاكرة بين دفعة وأخرى (الفواتير أحداث متفرّقة لا تدفّق).
 * • مهلة صارمة لكل عملية رسم، وبعدها يُقتل المتصفّح كاملاً لا
 *   الصفحة وحدها — صفحة معلّقة تترك عملية Chromium حيّة.
 *
 * لا يُرمى استثناء إلى مستدعٍ داخل معاملة قاعدة بيانات: كل
 * استدعاء لهذا المحرّك يقع **بعد** الـCOMMIT في مسار مستقل،
 * وهو نفس الترتيب الذي أُصلح في المرحلة 3 بعد حادثة الدفعة
 * المفقودة.
 */

const IDLE_SHUTDOWN_MS = Number(process.env.PDF_BROWSER_IDLE_MS || 45_000);
const RENDER_TIMEOUT_MS = Number(process.env.PDF_RENDER_TIMEOUT_MS || 25_000);
/**
 * إعادة تدوير المتصفّح بعد عدد من الوثائق.
 *
 * القياس على هذه الآلة: الذاكرة المنسوبة للمتصفّح تزحف من 176MB
 * إلى 190MB خلال ثلاث وثائق فقط. الزحف بطيء لكنه لا يتوقف، وخطة
 * الخادم 512MB لا تحتمل تراكماً. الإغلاق الدوري يعيدها للصفر
 * بتكلفة ثانية واحدة كل خمس وعشرين فاتورة.
 */
const MAX_RENDERS_PER_BROWSER = Number(process.env.PDF_BROWSER_MAX_RENDERS || 25);

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  // /dev/shm في الحاويات صغير جداً؛ بدونه ينهار Chromium عشوائياً
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--font-render-hinting=none",
  // وثيقة واحدة في كل لحظة — لا حاجة لأكثر من عملية رسم.
  "--renderer-process-limit=1",
  "--js-flags=--max-old-space-size=96",
];

/**
 * chrome-headless-shell بدل Chrome الكامل.
 *
 * القياس على نفس الفاتورة: 176MB مقابل 270MB، وناتج PDF مطابق
 * (فرق بضع مئات من البايتات في بيانات الملف الوصفية فقط). على خطة
 * 512MB هذا الفرق هو الفاصل بين هامش مريح وقتل بسبب الذاكرة.
 *
 * إن لم تكن النسخة المصغّرة منزَّلة نسقط إلى Chrome الكامل بدل
 * الفشل — فاتورة ثقيلة أفضل من لا فاتورة.
 */
const HEADLESS_MODES = process.env.PDF_HEADLESS_MODE
  ? [process.env.PDF_HEADLESS_MODE]
  : ["shell", true];

let browserPromise = null;
let idleTimer = null;
let queue = Promise.resolve();
let rendersOnCurrentBrowser = 0;

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleShutdown() {
  clearIdleTimer();
  if (IDLE_SHUTDOWN_MS <= 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    closeBrowser().catch(() => {});
  }, IDLE_SHUTDOWN_MS);
  // لا يمنع الخادم من الإغلاق النظيف
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

async function launchWithFallback() {
  let lastError = null;
  for (const headless of HEADLESS_MODES) {
    try {
      return await puppeteer.launch({ headless, args: LAUNCH_ARGS });
    } catch (err) {
      lastError = err;
      console.error(
        `[invoice] تعذّر تشغيل المتصفّح بوضع "${headless}" — تجربة الوضع التالي. السبب: ${err.message}`
      );
    }
  }
  throw lastError;
}

async function getBrowser() {
  if (!browserPromise) {
    rendersOnCurrentBrowser = 0;
    browserPromise = launchWithFallback()
      .then((browser) => {
        // إن مات المتصفّح لأي سبب (OOM مثلاً) نُسقط المرجع فوراً
        // حتى لا نظل نسلّم مقبضاً ميّتاً للطلب التالي.
        browser.on("disconnected", () => {
          if (browserPromise) browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

/** يغلق المتصفّح إن كان مفتوحاً. آمن للاستدعاء المتكرّر. */
export async function closeBrowser() {
  clearIdleTimer();
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    /* المتصفّح مات أصلاً — لا شيء لإغلاقه */
  }
}

async function renderOnce(html, { timeoutMs }) {
  const browser = await getBrowser();
  let page = null;
  try {
    page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);

    // كل الموارد مُضمَّنة في الـHTML (الخط واللوجو ورمز QR كـ
    // data URLs)، فأي طلب شبكة يعني خطأً في القالب لا مورداً
    // ناقصاً. نمنعه صراحةً: وثيقة ضريبية يجب ألا تعتمد على
    // الإنترنت وقت الطباعة.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.url().startsWith("data:") || req.url() === "about:blank") return req.continue();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) return req.continue();
      req.abort().catch(() => {});
    });

    await page.setContent(html, { waitUntil: "load", timeout: timeoutMs });
    await page.evaluateHandle("document.fonts.ready");

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
      timeout: timeoutMs,
    });

    rendersOnCurrentBrowser += 1;
    return Buffer.from(pdf);
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * يحوّل HTML مكتفياً بذاته إلى Buffer فيه PDF.
 * يرمي استثناءً عند الفشل — المستدعي مسؤول عن التقاطه.
 */
export async function renderHtmlToPdf(html, { timeoutMs = RENDER_TIMEOUT_MS } = {}) {
  // القفل: نربط كل طلب بذيل الطابور، فلا يبدأ رسم قبل انتهاء
  // سابقه. نمسك الأخطاء داخل الطابور نفسه حتى لا يُسمَّم للطلبات
  // اللاحقة.
  const run = queue.then(
    () => guardedRender(html, timeoutMs),
    () => guardedRender(html, timeoutMs)
  );
  queue = run.then(() => {}, () => {});
  return run;
}

async function guardedRender(html, timeoutMs) {
  clearIdleTimer();
  let timer = null;
  try {
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`تجاوز توليد الـPDF المهلة (${timeoutMs}ms)`)),
        timeoutMs + 5_000
      );
    });
    const pdf = await Promise.race([renderOnce(html, { timeoutMs }), watchdog]);
    if (MAX_RENDERS_PER_BROWSER > 0 && rendersOnCurrentBrowser >= MAX_RENDERS_PER_BROWSER) {
      await closeBrowser().catch(() => {});
    }
    return pdf;
  } catch (err) {
    // صفحة معلّقة تبقي عملية Chromium حيّة تأكل الذاكرة إلى
    // الأبد. الإغلاق الكامل هو المخرج الوحيد المضمون.
    await closeBrowser().catch(() => {});
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    scheduleIdleShutdown();
  }
}

/**
 * فحص إقلاع: يرسم صفحة عربية صغيرة ويتأكد أن الناتج PDF سليم.
 *
 * الغرض منه أن يظهر عطب النشر في سجل Render فوراً، لا عند أول
 * عملية دفع حقيقية. نشر بلا Chromium يعني دفعات صحيحة بلا
 * فواتير — وهذا بالضبط ما لا نريد تكراره.
 */
export async function verifyRenderer() {
  const started = Date.now();
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>@page{size:A4;margin:0}body{padding:10mm;font-size:12pt}</style></head>
<body>فحص إقلاع مولّد الفواتير — تجربة تشكيل عربي.</body></html>`;
  const pdf = await renderHtmlToPdf(html, { timeoutMs: 20_000 });
  if (!Buffer.isBuffer(pdf) || pdf.length < 500 || pdf.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error("ناتج الفحص ليس ملف PDF صالحاً");
  }
  await closeBrowser();
  return { bytes: pdf.length, ms: Date.now() - started };
}
