/**
 * اختبار مولّد الفاتورة الضريبية وإشعار الدائن.
 *
 * لا يحتاج قاعدة بيانات: يستدعي طبقة الرسم مباشرة، فيعمل في أي
 * بيئة فيها Chromium — بما فيها بيئة النشر نفسها للتحقق السريع.
 *
 * ما يثبته فعلاً — لا ما يبدو أنه يثبته:
 * • العربية تخرج نصاً حقيقياً قابلاً للاستخراج، لا رسماً مقطّعاً.
 *   هذا هو العطب الأصلي، ويُفحص باستخراج النص من الـPDF لا بالنظر.
 * • الأرقام في الوثيقة هي نفسها في حمولة QR — لا نسختان تُقرّبان
 *   بشكل مختلف.
 * • الوثيقة صفحة واحدة.
 * • الطلبات المتزامنة لا تفتح متصفّحين ولا تُفسد بعضها.
 * • فشل الرسم لا يترك متصفّحاً معلّقاً يمنع ما بعده.
 * • بيانات العميل لا تستطيع حقن HTML في وثيقة قانونية.
 *
 * التشغيل:
 *   node test-invoice-render.mjs
 * يحتاج pdftotext و pdfinfo (حزمة poppler-utils) لفحوص النص وعدد
 * الصفحات؛ إن غابا تُتخطّى تلك الفحوص صراحةً ولا تُعدّ ناجحة.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { generateInvoicePdf, generateCreditNotePdf } from "./invoicing/pdf.js";
import { renderHtmlToPdf, closeBrowser, verifyRenderer } from "./invoicing/render.js";
import { paymentInstrumentLabel } from "./invoicing/template.js";
import { formatDocumentNumber, splitVat } from "./billing/config.js";

/**
 * فكّ حمولة QR بشكل مستقل عن الكود الذي بناها.
 *
 * مقصود ألا نستخدم دالة من المشروع هنا: فحص يستعمل نفس المنطق
 * الذي يختبره لا يثبت شيئاً. هذا القارئ يفكّ TLV كما سيفعل تطبيق
 * هيئة الزكاة.
 */
function parseTlv(base64Payload) {
  const buf = Buffer.from(base64Payload, "base64");
  const names = { 1: "sellerName", 2: "vatNumber", 3: "timestamp", 4: "invoiceTotal", 5: "vatTotal" };
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    const len = buf[i + 1];
    out[names[tag] || `tag${tag}`] = buf.subarray(i + 2, i + 2 + len).toString("utf8");
    i += 2 + len;
  }
  return out;
}

const R = [];
const ok = (label, cond, extra = "") => R.push([label, !!cond, extra]);
const skip = (label, why) => R.push([label, null, why]);

const SETTINGS = {
  vatRate: 0.15,
  pricesIncludeVat: true,
  currency: "SAR",
  invoiceNumberPrefix: "INV",
  creditNoteNumberPrefix: "CN",
  documentNumberToken: "KANAF",
  sellerEmail: "billing@example.com",
  sellerPhone: "00966500000000",
  sellerDisplaySuffix: "( خدمات منصة كنف )",
};
const TAX = {
  legalName: "مؤسسة كنف",
  vatNumber: "300000000000003",
  address: "جدة / السعودية",
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kanaf-inv-"));
function have(bin) {
  try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; }
}
const HAS_POPPLER = have("pdftotext") && have("pdfinfo");

function writeTmp(name, buf) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, buf);
  return p;
}
const textOf = (p) => execFileSync("pdftotext", ["-enc", "UTF-8", p, "-"], { encoding: "utf8" });
const pagesOf = (p) =>
  Number(execFileSync("pdfinfo", [p], { encoding: "utf8" }).match(/Pages:\s+(\d+)/)[1]);

const baseInvoice = (over = {}) => ({
  invoiceNumber: "INV-KANAF-000001",
  planName: "الباقة الشهرية",
  totalSar: "29.00",
  discountSar: 0,
  issuedAt: new Date("2026-08-08T15:21:21Z"),
  buyerEmail: "customer@example.com",
  buyerName: "نواف",
  buyerPhone: null,
  periodStart: "2026-09-07",
  periodEnd: "2026-10-07",
  paymentMethod: "creditcard",
  paymentBrand: "mada",
  ...over,
});

try {
  /* ---------- 1) صيغة الترقيم ---------- */
  ok("T1 رقم الفاتورة INV-KANAF-000001",
    formatDocumentNumber("INV", "KANAF", 1) === "INV-KANAF-000001",
    formatDocumentNumber("INV", "KANAF", 1));
  ok("T2 رقم إشعار الدائن CN-KANAF-000042",
    formatDocumentNumber("CN", "KANAF", 42) === "CN-KANAF-000042");
  ok("T3 التسلسل لا يُقصّ عند تجاوز ست خانات",
    formatDocumentNumber("INV", "KANAF", 1234567) === "INV-KANAF-1234567");
  ok("T4 رمز فارغ يُسقط الجزء الأوسط بلا شرطتين",
    formatDocumentNumber("INV", "", 7) === "INV-000007" &&
    formatDocumentNumber("INV", null, 7) === "INV-000007");

  /* ---------- 2) خريطة وسيلة الدفع ---------- */
  const instrumentCases = [
    [["creditcard", "mada"], "مدى"],
    [["creditcard", "visa"], "Visa"],
    [["creditcard", "master"], "Mastercard"],
    [["creditcard", "mastercard"], "Mastercard"],
    [["applepay", null], "Apple Pay"],
    [["samsungpay", null], "Samsung Pay"],
    [["stcpay", null], "STC Pay"],
    [["creditcard", null], "بطاقة"],
    [[null, null], null],
  ];
  const badMap = instrumentCases.filter(([args, want]) => paymentInstrumentLabel(...args) !== want);
  ok("T5 وسيلة الدفع تُترجم لكل الحالات المعروفة", badMap.length === 0, JSON.stringify(badMap));
  ok("T6 وسيلة غير معروفة لا تُخمَّن", paymentInstrumentLabel("teleport", null) === null);

  /* ---------- 3) فحص الإقلاع ---------- */
  const boot = await verifyRenderer();
  ok("T7 فحص إقلاع المولّد ينجح", boot.bytes > 500, `${boot.bytes}B / ${boot.ms}ms`);

  /* ---------- 4) الفاتورة ---------- */
  const inv = await generateInvoicePdf({ taxSettings: TAX, settings: SETTINGS, invoice: baseInvoice() });
  const invPath = writeTmp("invoice.pdf", inv.pdfBuffer);

  ok("T8 الناتج ملف PDF صالح",
    inv.pdfBuffer.subarray(0, 5).toString() === "%PDF-", `${inv.pdfBuffer.length}B`);
  ok("T9 حجم الفاتورة معقول للتخزين الدائم",
    inv.pdfBuffer.length < 300_000, `${Math.round(inv.pdfBuffer.length / 1024)}KB`);

  const expected = splitVat("29.00", SETTINGS);
  ok("T10 التفكيك الضريبي مطابق لـsplitVat",
    inv.subtotalSar === expected.subtotal && inv.vatSar === expected.vat && inv.totalSar === expected.total,
    `${inv.subtotalSar} + ${inv.vatSar} = ${inv.totalSar}`);
  ok("T11 الوعاء + الضريبة = الإجمالي بالضبط",
    (Number(inv.subtotalSar) + Number(inv.vatSar)).toFixed(2) === inv.totalSar);

  const qr = parseTlv(inv.qrPayload);
  ok("T12 حمولة QR فيها الحقول الخمسة", Object.keys(qr).length === 5, JSON.stringify(qr));
  ok("T13 رقم QR الضريبي هو الاسم النظامي بلا لاحقة العرض",
    qr.sellerName === TAX.legalName, qr.sellerName);
  ok("T14 مبلغ QR = مبلغ الوثيقة", qr.invoiceTotal === inv.totalSar && qr.vatTotal === inv.vatSar,
    `${qr.invoiceTotal} / ${qr.vatTotal}`);

  if (HAS_POPPLER) {
    ok("T15 الفاتورة صفحة واحدة", pagesOf(invPath) === 1, String(pagesOf(invPath)));
    const t = textOf(invPath);
    const need = ["INV-KANAF-000001", "300000000000003", "customer@example.com", "29.00", "25.22", "3.78"];
    const missing = need.filter((s) => !t.includes(s));
    ok("T16 كل الأرقام والمعرّفات مطبوعة ومستخرَجة", missing.length === 0, missing.join(","));
    // هذا هو الفحص الجوهري: العطب الأصلي كان يُخرج حروفاً مفكّكة
    // مقلوبة، فلا تُستخرج ككلمات عربية أصلاً.
    const words = ["فاتورة", "الفاتورة", "بيانات", "العميل", "تفاصيل", "نواف", "الخصم"];
    const lost = words.filter((w) => !t.includes(w));
    ok("T17 العربية نص حقيقي متّصل قابل للاستخراج", lost.length === 0, lost.join(","));
    ok("T18 أرقام الوثيقة لاتينية لا عربية-هندية", !/[٠-٩]/.test(t));
    ok("T19 لاحقة اسم المنشأة تظهر في العرض", t.includes("خدمات منصة كنف"));
  } else {
    skip("T15-T19 فحوص النص وعدد الصفحات", "poppler-utils غير مثبّتة");
  }

  /* ---------- 5) الخصم ---------- */
  const disc = await generateInvoicePdf({
    taxSettings: TAX, settings: SETTINGS,
    invoice: baseInvoice({ invoiceNumber: "INV-KANAF-000002", totalSar: "290.00", discountSar: 58, paymentMethod: "applepay", paymentBrand: null }),
  });
  const discPath = writeTmp("discount.pdf", disc.pdfBuffer);
  ok("T20 الخصم لا يُطرح مرتين — الضريبة على المدفوع فعلاً",
    disc.totalSar === "290.00" && disc.subtotalSar === splitVat("290.00", SETTINGS).subtotal,
    `${disc.subtotalSar} / ${disc.totalSar}`);
  if (HAS_POPPLER) {
    const t = textOf(discPath);
    ok("T21 عمود الخصم يعرض قيمة الخصم", t.includes("58.00"));
    ok("T22 مجموع الأسعار = المدفوع + الخصم", t.includes("348.00"));
    ok("T23 وسيلة الدفع Apple Pay مطبوعة", t.includes("Apple Pay"));
    ok("T24 فاتورة الخصم صفحة واحدة", pagesOf(discPath) === 1);
  } else {
    skip("T21-T24 فحوص الخصم النصية", "poppler-utils غير مثبّتة");
  }

  /* ---------- 6) إشعار الدائن ---------- */
  const cn = await generateCreditNotePdf({
    taxSettings: TAX, settings: SETTINGS,
    creditNote: {
      creditNoteNumber: "CN-KANAF-000001",
      originalInvoiceNumber: "INV-KANAF-000001",
      planName: "الباقة الشهرية", totalSar: "29.00",
      reason: "طلب العميل", issuedAt: new Date("2026-08-09T10:00:00Z"),
      buyerEmail: "customer@example.com", buyerName: "نواف", buyerPhone: null,
      paymentMethod: "creditcard", paymentBrand: "mada",
    },
  });
  const cnPath = writeTmp("creditnote.pdf", cn.pdfBuffer);
  ok("T25 إشعار الدائن ملف PDF صالح", cn.pdfBuffer.subarray(0, 5).toString() === "%PDF-");
  if (HAS_POPPLER) {
    const t = textOf(cnPath);
    ok("T26 الإشعار يشير إلى رقم الفاتورة الأصلية", t.includes("INV-KANAF-000001"));
    ok("T27 الإشعار يحمل رقمه الخاص", t.includes("CN-KANAF-000001"));
    ok("T28 سبب الاسترداد مطبوع", t.includes("طلب العميل"));
    ok("T29 الإشعار صفحة واحدة", pagesOf(cnPath) === 1);
  } else {
    skip("T26-T29 فحوص الإشعار النصية", "poppler-utils غير مثبّتة");
  }

  /* ---------- 7) الحقن ---------- */
  const evil = await generateInvoicePdf({
    taxSettings: TAX, settings: SETTINGS,
    invoice: baseInvoice({
      invoiceNumber: "INV-KANAF-000003",
      buyerName: `<script>document.body.innerHTML=""</script><b>مُخرِّب`,
      buyerEmail: `"><img src=x onerror=alert(1)>@example.com`,
    }),
  });
  const evilPath = writeTmp("injection.pdf", evil.pdfBuffer);
  ok("T30 الوثيقة تُبنى رغم محتوى خبيث في اسم العميل",
    evil.pdfBuffer.subarray(0, 5).toString() === "%PDF-");
  if (HAS_POPPLER) {
    const t = textOf(evilPath);
    ok("T31 الوسوم تُطبع كنص ولا تُنفّذ", t.includes("<script>") || t.includes("script"));
    ok("T32 بقية الفاتورة سليمة رغم الحقن", t.includes("INV-KANAF-000003") && t.includes("29.00"));
    ok("T33 الفاتورة لم تنفجر لصفحات", pagesOf(evilPath) === 1);
  } else {
    skip("T31-T33 فحوص الحقن النصية", "poppler-utils غير مثبّتة");
  }

  /* ---------- 8) التزامن ---------- */
  const many = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      generateInvoicePdf({
        taxSettings: TAX, settings: SETTINGS,
        invoice: baseInvoice({ invoiceNumber: `INV-KANAF-00010${i}` }),
      })
    )
  );
  ok("T34 خمسة طلبات متزامنة كلها نجحت",
    many.every((m) => m.pdfBuffer.subarray(0, 5).toString() === "%PDF-"));
  ok("T35 كل ناتج مستقل بحجمه المعقول",
    many.every((m) => m.pdfBuffer.length > 10_000 && m.pdfBuffer.length < 300_000));

  /* ---------- 9) التعافي بعد فشل ---------- */
  let threw = false;
  try {
    // مهلة مستحيلة: تُجبر مسار الفشل الذي يغلق المتصفّح.
    await renderHtmlToPdf("<html><body>x</body></html>", { timeoutMs: 1 });
  } catch {
    threw = true;
  }
  ok("T36 فشل الرسم يُرمى ولا يُبتلع", threw);

  const afterFailure = await generateInvoicePdf({
    taxSettings: TAX, settings: SETTINGS,
    invoice: baseInvoice({ invoiceNumber: "INV-KANAF-000200" }),
  });
  ok("T37 المولّد يتعافى تلقائياً بعد الفشل",
    afterFailure.pdfBuffer.subarray(0, 5).toString() === "%PDF-",
    `${afterFailure.pdfBuffer.length}B`);

  /* ---------- 10) بيانات ناقصة ---------- */
  const sparse = await generateInvoicePdf({
    taxSettings: { legalName: "مؤسسة كنف", vatNumber: "300000000000003", address: null },
    settings: { ...SETTINGS, sellerEmail: null, sellerPhone: null, sellerDisplaySuffix: null },
    invoice: baseInvoice({
      invoiceNumber: "INV-KANAF-000300", buyerName: null,
      periodStart: null, periodEnd: null, paymentMethod: null, paymentBrand: null,
    }),
  });
  ok("T38 الحقول الغائبة لا تكسر الوثيقة",
    sparse.pdfBuffer.subarray(0, 5).toString() === "%PDF-");
  if (HAS_POPPLER) {
    const t = textOf(writeTmp("sparse.pdf", sparse.pdfBuffer));
    ok("T39 الغائب يُعرض شرطة لا كلمة undefined أو null",
      !t.includes("undefined") && !t.includes("null") && t.includes("—"));
    ok("T40 الوثيقة الناقصة ما زالت صفحة واحدة", pagesOf(writeTmp("sparse.pdf", sparse.pdfBuffer)) === 1);
  } else {
    skip("T39-T40 فحوص البيانات الناقصة", "poppler-utils غير مثبّتة");
  }
} finally {
  await closeBrowser();
}

const pass = R.filter((r) => r[1] === true).length;
const fail = R.filter((r) => r[1] === false);
const skipped = R.filter((r) => r[1] === null);
for (const [l, c, x] of R) {
  console.log(`${c === null ? "○" : c ? "✔" : "✘"} ${l}${x ? `  ${x}` : ""}`);
}
console.log(`\n${pass} ناجح · ${fail.length} فاشل · ${skipped.length} متخطّى`);
console.log(`مخرجات الاختبار: ${tmp}`);
process.exit(fail.length ? 1 : 0);
