import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { KANAF_LOGO_PNG_BASE64 } from "./assets/logo.js";

/**
 * ============================================================
 * قالب الفاتورة الضريبية وإشعار الدائن
 * ============================================================
 *
 * الوثيقة تُبنى HTML ثم تُطبع في Chromium (انظر render.js).
 * كل الموارد مضمَّنة داخل الصفحة — الخط ورمز QR والشعار — فلا
 * تعتمد الطباعة على شبكة ولا على ملفات خارجية.
 *
 * الخط هو نفس خط التطبيق (IBM Plex Sans Arabic) بناءً على طلب
 * صريح، ويُقرأ من invoicing/fonts مرة واحدة ويُخزَّن في الذاكرة.
 *
 * الأرقام كلها لاتينية: الحقل الرقمي يأخذ الصنف num الذي يفرض
 * direction:ltr، وإلا خلط الـbidi ترتيب مثل "2026-09-07" أو
 * "‎+966..." عند وضعه داخل سطر عربي.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** ملفات الخط تأتي من الحزمة، فلا نحمل نسخاً ثنائية داخل المستودع. */
function fontsourceDir() {
  return path.join(
    path.dirname(require.resolve("@fontsource/ibm-plex-sans-arabic/package.json")),
    "files"
  );
}

/** نسخة احتياطية موجودة أصلاً في المستودع — تُستخدم إن غابت الحزمة. */
const LEGACY_TTF = path.join(__dirname, "fonts", "IBMPlexSansArabic-Regular.ttf");

/**
 * أربع نسخ من الخط: عربي ولاتيني، عادي وعريض.
 *
 * لماذا نسخة عريضة حقيقية بدل ترك المتصفّح «يغلّظ» العادي؟ لأن
 * التغليظ الاصطناعي يجعل Chromium يضمّن نسخة خط مستقلة لكل مقاس
 * عريض في الصفحة. القياس الفعلي: الفاتورة نفسها خرجت 407KB بأربع
 * عشرة نسخة خط مضمّنة، ونزلت إلى أقل من الربع بخط عريض حقيقي.
 * الفواتير تُخزَّن في قاعدة البيانات إلى الأبد، فحجم الملف قرار
 * تشغيلي لا تجميلي.
 *
 * والتقسيم عربي/لاتيني بـunicode-range يجعل المتصفّح لا يحمّل
 * الجزء اللاتيني إن لم يُستخدم.
 */
const FONT_FILES = [
  { file: "ibm-plex-sans-arabic-arabic-400-normal.woff2", weight: 400, range: "U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0898-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC" },
  { file: "ibm-plex-sans-arabic-arabic-700-normal.woff2", weight: 700, range: "U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0898-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC" },
  { file: "ibm-plex-sans-arabic-latin-400-normal.woff2", weight: 400, range: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" },
  { file: "ibm-plex-sans-arabic-latin-700-normal.woff2", weight: 700, range: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" },
];

let fontFacesCache = null;
export function fontFaces() {
  if (fontFacesCache !== null) return fontFacesCache;
  try {
    const dir = fontsourceDir();
    fontFacesCache = FONT_FILES.map(({ file, weight, range }) => {
      const b64 = fs.readFileSync(path.join(dir, file)).toString("base64");
      return `@font-face{font-family:"Kanaf";font-style:normal;font-weight:${weight};` +
             `src:url(data:font/woff2;base64,${b64}) format("woff2");unicode-range:${range}}`;
    }).join("\n");
  } catch (err) {
    // الحزمة غائبة (تثبيت ناقص). الفاتورة أهم من وزنها: نرجع إلى
    // النسخة المرفقة في المستودع، فيخرج المستند صحيح العربية —
    // أثقل قليلاً وبعريض اصطناعي — بدل ألا يخرج أصلاً.
    console.error(
      "[invoicing/template] تعذّر تحميل @fontsource/ibm-plex-sans-arabic — " +
      "استُخدم الخط المرفق في المستودع. شغّل npm install:", err.message
    );
    const b64 = fs.readFileSync(LEGACY_TTF).toString("base64");
    fontFacesCache = `@font-face{font-family:"Kanaf";font-weight:400;` +
      `src:url(data:font/ttf;base64,${b64}) format("truetype")}`;
  }
  return fontFacesCache;
}

/** يمنع أي قيمة قادمة من قاعدة البيانات من كسر بنية الصفحة. */
function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DASH = "—";
const money = (n) => Number(n || 0).toFixed(2);
const orDash = (v) => (v === null || v === undefined || v === "" ? DASH : esc(v));

/**
 * اسم وسيلة الدفع كما يراها العميل.
 *
 * `method` هو source.type من ميسر و`brand` هو source.company.
 * نعرض ما استُخدم فعلاً لا ما نفترضه؛ وإن لم تصلنا الوسيلة
 * (دفعة قديمة مثلاً) نعرض شرطة بدل تخمين.
 */
export function paymentInstrumentLabel(method, brand) {
  const m = String(method || "").toLowerCase().replace(/[\s_-]/g, "");
  const b = String(brand || "").toLowerCase().replace(/[\s_-]/g, "");

  if (m === "applepay") return "Apple Pay";
  if (m === "samsungpay") return "Samsung Pay";
  if (m === "googlepay") return "Google Pay";
  if (m === "stcpay") return "STC Pay";
  if (m === "sadad") return "سداد";
  if (m === "banktransfer" || m === "bank") return "تحويل بنكي";

  if (b === "mada") return "مدى";
  if (b === "visa") return "Visa";
  if (b === "master" || b === "mastercard") return "Mastercard";
  if (b === "amex" || b === "americanexpress") return "Amex";
  if (b) return brand;

  if (m === "creditcard" || m === "card") return "بطاقة";
  return null;
}

function styles() {
  return `
${fontFaces()}
@page{size:A4;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Kanaf",sans-serif;color:#1B333A;font-size:9pt;padding:8mm 11mm;line-height:1.55}
.num{font-variant-numeric:tabular-nums;direction:ltr;unicode-bidi:embed}
span.num{display:inline-block}
header{text-align:center;margin-bottom:4mm}
header img{height:14mm}
h1{font-size:12.5pt;font-weight:700;text-align:center;margin-bottom:1.5mm;color:#4A4454}
.invno{text-align:center;font-size:10pt;font-weight:700;margin-bottom:5mm;color:#1B333A}
.ref{text-align:center;font-size:9pt;margin:-3.5mm 0 5mm;color:#5C7680}
.parties{display:flex;gap:4mm;margin-bottom:5mm}
.party{flex:1;border:1px solid #DDE5E8;border-radius:2mm;overflow:hidden}
.party h2{background:#756B86;color:#fff;font-size:9.5pt;font-weight:700;padding:2mm 3mm;text-align:center}
.party dl{padding:2mm 3mm}
.party div{display:flex;gap:1.5mm;padding:.35mm 0;font-size:8.5pt}
.party dt{color:#5C7680;white-space:nowrap}
.party dd{color:#1B333A;font-weight:600;word-break:break-word}
h3{font-size:9.8pt;font-weight:700;margin:0 0 2mm;color:#4A4454}
table{width:100%;border-collapse:collapse;font-size:8.5pt}
thead th{background:#756B86;color:#fff;font-weight:700;padding:2mm 1.5mm;text-align:center;border:1px solid #6A6079}
tbody td{border:1px solid #DDE5E8;padding:2mm 1.5mm;text-align:center;vertical-align:middle;white-space:nowrap}
tbody td.desc{white-space:normal;text-align:right;line-height:1.6}
tbody td.desc small{color:#5C7680;font-size:7.6pt}
.sum{width:62mm;margin-right:auto;margin-top:-1px;border-collapse:collapse;font-size:8.6pt}
.sum td{border:1px solid #DDE5E8;padding:1.3mm 2.5mm}
.sum td:first-child{color:#5C7680}
.sum td:last-child{text-align:left;font-weight:600;width:22mm}
.sum tr.grand td{background:#F1EFF4;font-weight:700;color:#4A4454}
.foot{display:flex;gap:6mm;align-items:flex-start;margin-top:6mm}
.qr{width:34mm;text-align:center}
.qr img{width:34mm;height:34mm}
.qr p{font-size:7.4pt;color:#5C7680;margin-top:1.5mm}
.prices{flex:1}
.pricebox{width:62mm;margin-right:auto}
.prices .row{display:flex;justify-content:space-between;border-bottom:1px solid #E6ECEE;padding:1.3mm 0;font-size:8.6pt}
.prices .row span:first-child{color:#5C7680}
.prices .row span:last-child{font-weight:600}
.policy{margin-top:6mm;border-top:1px solid #E6ECEE;padding-top:3.5mm}
.policy h3{margin-bottom:2mm}
.policy li{list-style:none;font-size:8.4pt;line-height:1.85;padding-right:4mm;position:relative;color:#31474F}
.policy li::before{content:"${DASH}";position:absolute;right:0;color:#756B86}
.note{margin-top:4mm;text-align:center;font-size:7.4pt;color:#8496A0}
`;
}

function partiesBlock(seller, buyer) {
  return `<div class="parties">
  <div class="party"><h2>بيانات المنشأة</h2><dl>
    <div><dt>اسم المنشأة:</dt><dd>${esc(seller.displayName)}</dd></div>
    <div><dt>الرقم الضريبي:</dt><dd><span class="num">${esc(seller.vatNumber)}</span></dd></div>
    <div><dt>العنوان:</dt><dd>${orDash(seller.address)}</dd></div>
    <div><dt>البريد الإلكتروني:</dt><dd>${orDash(seller.email)}</dd></div>
    <div><dt>رقم الجوال:</dt><dd><span class="num">${orDash(seller.phone)}</span></dd></div>
  </dl></div>
  <div class="party"><h2>بيانات العميل</h2><dl>
    <div><dt>الاسم:</dt><dd>${orDash(buyer.name)}</dd></div>
    <div><dt>البريد الإلكتروني:</dt><dd>${orDash(buyer.email)}</dd></div>
    <div><dt>رقم الجوال:</dt><dd><span class="num">${orDash(buyer.phone)}</span></dd></div>
  </dl></div>
</div>`;
}

function itemsTable(items, vatLabel, heading) {
  const rows = items
    .map(
      (it, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td class="desc">${esc(it.description)}${
        it.period ? `<br><small>فترة الخدمة: <span class="num">${esc(it.period)}</span></small>` : ""
      }</td>
    <td class="num">${esc(it.quantity ?? 1)}</td>
    <td>${orDash(it.paymentMethod)}</td>
    <td>${orDash(it.paymentInstrument)}</td>
    <td class="num">${money(it.gross)}</td>
    <td class="num">${money(it.discount)}</td>
    <td class="num">${money(it.subtotal)}</td>
    <td class="num">${money(it.vat)}</td>
    <td class="num">${money(it.total)}</td>
  </tr>`
    )
    .join("");

  return `<h3>${esc(heading)}</h3>
<table>
  <thead><tr>
    <th style="width:7mm">#</th><th>الوصف</th><th style="width:12mm">الكمية</th>
    <th style="width:20mm">طريقة الدفع</th><th style="width:18mm">وسيلة الدفع</th>
    <th style="width:17mm">السعر</th><th style="width:15mm">الخصم</th>
    <th style="width:20mm">قبل الضريبة</th><th style="width:18mm">الضريبة ${esc(vatLabel)}</th>
    <th style="width:18mm">الإجمالي</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function summaryTable(totals, vatLabel, grandLabel, dueLabel) {
  return `<table class="sum">
  <tr><td>مجموع الأسعار</td><td class="num">${money(totals.gross)}</td></tr>
  <tr><td>الخصم</td><td class="num">${money(totals.discount)}</td></tr>
  <tr><td>السعر قبل الضريبة</td><td class="num">${money(totals.subtotal)}</td></tr>
  <tr><td>ضريبة القيمة المضافة ${esc(vatLabel)}</td><td class="num">${money(totals.vat)}</td></tr>
  <tr class="grand"><td>${esc(grandLabel)}</td><td class="num">${money(totals.total)}</td></tr>
  <tr><td>${esc(dueLabel)}</td><td class="num">${money(totals.due)}</td></tr>
</table>`;
}

function footBlock({ qrDataUrl, totals, vatLabel, paymentLine, issuedAt, totalLabel, dateLabel }) {
  return `<div class="foot">
  <div class="qr">
    <img src="${esc(qrDataUrl)}">
    <p>رمز الوثيقة وفق متطلبات هيئة الزكاة والضريبة والجمارك</p>
  </div>
  <div class="prices"><div class="pricebox">
    <h3>تفاصيل الأسعار</h3>
    <div class="row"><span>السعر قبل الضريبة</span><span class="num">${money(totals.subtotal)}</span></div>
    <div class="row"><span>ضريبة القيمة المضافة ${esc(vatLabel)}</span><span class="num">${money(totals.vat)}</span></div>
    <div class="row"><span>${esc(totalLabel)}</span><span class="num">${money(totals.total)}</span></div>
    <div class="row"><span>طريقة الدفع</span><span>${paymentLine}</span></div>
    <div class="row"><span>${esc(dateLabel)}</span><span class="num">${esc(issuedAt)}</span></div>
  </div></div>
</div>`;
}

/** سياسة الاشتراك والاسترجاع — بنصّها المعتمد، لا يُعاد صياغتها. */
const SUBSCRIPTION_POLICY = [
  "الاشتراك في منصة كنف خدمة رقمية تُتاح للمشترك فور إتمام الدفع، ولا تُسترد رسومه بعد ذلك.",
  "إيقاف استخدام المنصة قبل نهاية المدة لا يترتب عليه استرداد كلي أو جزئي للرسوم.",
];

function policyBlock(lines) {
  return `<div class="policy">
  <h3>سياسة الاشتراك والاسترجاع</h3>
  <ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
</div>`;
}

function page(inner) {
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${styles()}</style></head>
<body>
<header><img src="data:image/png;base64,${KANAF_LOGO_PNG_BASE64}"></header>
${inner}
</body></html>`;
}

/**
 * فاتورة ضريبية مبسّطة (مدفوعة).
 *
 * `doc`: { number, issuedAt, seller, buyer, items, totals, vatLabel,
 *          qrDataUrl, paymentMethod, paymentInstrument }
 */
export function buildInvoiceHtml(doc) {
  const instrument = doc.paymentInstrument;
  const paymentLine = instrument
    ? `${esc(doc.paymentMethod)} ${DASH} ${esc(instrument)}`
    : esc(doc.paymentMethod);

  return page(`
<h1>فاتورة ضريبية مبسّطة (مدفوعة)</h1>
<p class="invno">رقم الفاتورة : <span class="num">${esc(doc.number)}</span></p>
${partiesBlock(doc.seller, doc.buyer)}
${itemsTable(doc.items, doc.vatLabel, "تفاصيل الفاتورة")}
${summaryTable(doc.totals, doc.vatLabel, "الإجمالي شامل الضريبة", "المبلغ المستحق")}
${footBlock({
    qrDataUrl: doc.qrDataUrl,
    totals: doc.totals,
    vatLabel: doc.vatLabel,
    paymentLine,
    issuedAt: doc.issuedAt,
    totalLabel: "الإجمالي شامل الضريبة",
    dateLabel: "تاريخ الفاتورة",
  })}
${policyBlock(SUBSCRIPTION_POLICY)}
<div class="note">فاتورة ضريبية مبسّطة صادرة إلكترونياً ${DASH} لا تحتاج توقيعاً أو ختماً.</div>
`);
}

/**
 * إشعار دائن (استرداد) — نفس هيكل الفاتورة، مع إلزام الإشارة إلى
 * الفاتورة الأصلية التي يصحّحها. إشعار بلا مرجع لا قيمة نظامية له.
 */
export function buildCreditNoteHtml(doc) {
  const instrument = doc.paymentInstrument;
  const paymentLine = instrument
    ? `${esc(doc.paymentMethod)} ${DASH} ${esc(instrument)}`
    : esc(doc.paymentMethod);

  const policy = [
    `هذا الإشعار يصحّح الفاتورة رقم ${doc.originalInvoiceNumber} بمقدار المبلغ المسترد الموضّح أعلاه فقط.`,
    doc.reason ? `سبب الاسترداد: ${doc.reason}.` : "صدر الاسترداد بقرار من إدارة المنصة.",
  ];

  return page(`
<h1>إشعار دائن (استرداد)</h1>
<p class="invno">رقم الإشعار : <span class="num">${esc(doc.number)}</span></p>
<p class="ref">مرجع الفاتورة الأصلية : <span class="num">${esc(doc.originalInvoiceNumber)}</span></p>
${partiesBlock(doc.seller, doc.buyer)}
${itemsTable(doc.items, doc.vatLabel, "تفاصيل الإشعار")}
${summaryTable(doc.totals, doc.vatLabel, "إجمالي المبلغ المسترد", "المبلغ المسترد فعلياً")}
${footBlock({
    qrDataUrl: doc.qrDataUrl,
    totals: doc.totals,
    vatLabel: doc.vatLabel,
    paymentLine,
    issuedAt: doc.issuedAt,
    totalLabel: "إجمالي المبلغ المسترد",
    dateLabel: "تاريخ الإشعار",
  })}
<div class="policy">
  <h3>بيان الاسترداد</h3>
  <ul>${policy.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
</div>
<div class="note">إشعار دائن إلكتروني صادر وفق أنظمة هيئة الزكاة والضريبة والجمارك ${DASH} لا يحتاج توقيعاً أو ختماً.</div>
`);
}
