import "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد (check-guard-imports)
/**
 * فحوص ثابتة — KANAF-ORD-0008 §2.6 و§12.5 (و§12.6 في test-30).
 *
 *  D) الأرقام لاتينية: كل نداء toLocaleString / toLocaleDateString /
 *     toLocaleTimeString / Intl.NumberFormat / Intl.DateTimeFormat في مصدر
 *     اللوحة والخادم يجب أن يسمّي لغته صراحةً بسلسلة حرفية، وأن تكون
 *     اللغة إنجليزية (en…) أو تحمل ‎-nu-latn‎. النداء بلا لغة يأخذ لغة
 *     المتصفح — وعند مسؤول لغة متصفحه العربية تخرج أرقام هندية.
 *  N) الفاحص نفسه يرفض الأمثلة السيئة ويقبل الجيدة (فحص سلبي للفاحص).
 *
 *  لا قاعدة بيانات ولا خادم: قراءة ملفات فقط.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const log = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`); ok ? pass++ : fail++; };

const CALL = /\b(toLocaleString|toLocaleDateString|toLocaleTimeString)\s*\(|\bIntl\.(NumberFormat|DateTimeFormat)\s*\(/g;

/** يعيد قائمة المخالفات في نص واحد. */
export function findDigitViolations(src) {
  const out = [];
  let m;
  CALL.lastIndex = 0;
  while ((m = CALL.exec(src))) {
    const after = src.slice(m.index + m[0].length).trimStart();
    const lit = /^(["'`])([^"'`]*)\1/.exec(after);
    const line = src.slice(0, m.index).split("\n").length;
    // Intl.DateTimeFormat بلغة "en"/"en-US" مع timeZone فحص صلاحية منطقة زمنية لا عرض — مقبول لأنه en.
    if (!lit) { out.push({ line, why: "بلا لغة صريحة" }); continue; }
    const loc = lit[2];
    if (/^en(-|$)/i.test(loc) || /-nu-latn\b/i.test(loc)) continue;
    out.push({ line, why: `لغة بلا nu-latn: ${loc}` });
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(m?js|jsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/* N) الفاحص يعمل قبل أن نثق بنتيجته */
log("N1 نداء بلا لغة مرفوض", findDigitViolations("x.toLocaleString()").length === 1);
log("N2 لغة عربية بلا nu-latn مرفوضة", findDigitViolations('d.toLocaleDateString("ar-SA")').length === 1);
log("N3 Intl بلا لغة مرفوض", findDigitViolations("new Intl.NumberFormat(undefined)").length === 1);
log("N4 ar-SA-u-nu-latn مقبول", findDigitViolations('d.toLocaleString("ar-SA-u-ca-gregory-nu-latn")').length === 0);
log("N5 en-US مقبول", findDigitViolations("n.toLocaleString('en-US')").length === 0);

/* D) المصدر الحقيقي: اللوحة والخادم (ناتج البناء admin-ui مستثنى — يُبنى من المصدر) */
const dirs = ["admin-src/src", "admin", "auth", "billing", "content", "invoicing", "mail", "notifications", "payments", "userdata", "ops", "assistant"];
const files = [...dirs.flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? walk(path.join(ROOT, d)) : [])), path.join(ROOT, "index.js")];
const bad = [];
for (const f of files) {
  for (const v of findDigitViolations(fs.readFileSync(f, "utf8"))) bad.push(`${path.relative(ROOT, f)}:${v.line} ${v.why}`);
}
log(`D1 لا تنسيق أرقام/تواريخ يفلت من الأرقام اللاتينية (${files.length} ملفاً)`, bad.length === 0, bad.join(" · "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
