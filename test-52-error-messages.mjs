import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0015 §2.3–2.4 — رسائل الأخطاء في اللوحة، وفحص كود الخصم قبل الإرسال.
 *  E) 🔴 كل رمز يصل اللوحة له نصّ عربي (admin-src/src/errors.js)، أو سبب استثناء مكتوب هنا. رمز جديد بلا أيّهما يُسقط الفحص.
 *  F) «تعذّر تنفيذ الطلب» شبكة أمان أخيرة ومعها الرمز.
 *  D) مرآة اللوحة لقواعد كود الخصم توافق الخادم على حالات حدّية (لا يُرسَل المحكوم بالفشل، ولا يُمنع الصالح).
 */
requireDedicatedDatabase(import.meta.url);
import fs from "node:fs";
const { extractCodes } = await import("./test-support/error-codes.mjs");
const { ERROR_AR, arabicError, splitCode } = await import("./admin-src/src/errors.js");
const { discountProblems } = await import("./admin-src/src/discount-rules.js");
const { validateDiscountInput } = await import("./billing/discounts.js");
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);

/* ما يصل اللوحة ولا يُترجَم عمداً — وسببه. */
export const PANEL_EXEMPT = {
  internal_error: "ردّ 5xx: يعرض نصّ «صار خلل في الخادم» حسب الحالة لا الرمز، والتفاصيل في «أخطاء النظام».",
  missing_token: "401 بلا جلسة: api.js يجدّد الجلسة بصمت ثم ينقل إلى شاشة الدخول — لا يُعرض الرمز.",
  wrong_token_type: "401: كالسابق — مسار تجديد الجلسة لا نصّ خطأ.",
  no_refresh_cookie: "401 من /auth/refresh نفسه: يُطلق حدث انتهاء الجلسة وشاشة الدخول.",
  invalid_or_expired_refresh_token: "401 من /auth/refresh نفسه: كالسابق.",
  reason_required: "قرار المالك D1 (ملحق ORD-0013): لا سبب مكتوب في اللوحة — admin/auto-reason.js يملأ السبب في كل طلب إداري قبل المسار، فلا يصل الرمز واجهةً. ونصّ «السبب مطلوب» ممنوع في الحزمة (test-44 P3).",
};
const { all, panel } = extractCodes();
const missing = [...panel.keys()].filter((c) => !ERROR_AR[c] && !PANEL_EXEMPT[c]).sort();
const before = 55;
ok(`E1 🔴 كل رمز يصل اللوحة له نصّ عربي أو سبب استثناء (${panel.size} رمزاً يصل اللوحة من ${all.size} ينتجها الخادم؛ مترجَم ${[...panel.keys()].filter((c) => ERROR_AR[c]).length}، مستثنى ${Object.keys(PANEL_EXEMPT).length})`,
  missing.length === 0, missing.map((c) => `${c} ← ${[...panel.get(c)].join(",")}`).join(" | "));
ok("E2 الاستثناءات رموز حقيقية يصلها الخادم (لا استثناء ميت)", Object.keys(PANEL_EXEMPT).every((c) => panel.has(c)), Object.keys(PANEL_EXEMPT).filter((c) => !panel.has(c)).join(" "));
const weak = Object.entries(ERROR_AR).filter(([, t]) => !/[؀-ۿ]/.test(t) || t.length < 8 || /^تعذّر تنفيذ الطلب/.test(t));
ok(`E3 كل نصّ عربي فعلاً وليس شبكة الأمان نفسها (${Object.keys(ERROR_AR).length} نصاً، كانت ${before})`, weak.length === 0 && Object.keys(ERROR_AR).length > before, weak.map(([c]) => c).join(" "));
ok("E4 invalid_code_format («qw») له نصّ يقول القاعدة وما يفعله المسؤول", /3 إلى 32/.test(ERROR_AR.invalid_code_format));
const api = fs.readFileSync("admin-src/src/api.js", "utf8");
ok("E5 خريطة واحدة: api.js لا يحمل نسخة ثانية من النصوص", api.includes('from "./errors.js"') && !/insufficient_role:\s*"/.test(api));

/* F */
const unk = arabicError(400, { error: "brand_new_code" });
ok("F1 رمز لم يُتوقَّع: «تعذّر تنفيذ الطلب» ومعه الرمز ليُنقل إلينا", splitCode(unk).text === "تعذّر تنفيذ الطلب." && splitCode(unk).code === "brand_new_code");
ok("F2 رمز معروف: نصّه وحده بلا رمز", splitCode(arabicError(400, { error: "invalid_code_format" })).code === "" && arabicError(409, { error: "code_exists" }).includes("موجود"));
ok("F3 403 و401 و5xx كما كانت (internal_error بلا رمز)", arabicError(403, { error: "zzz" }).includes("صلاحيتك") && arabicError(401, { error: "zzz" }).includes("الجلسة") && splitCode(arabicError(500, { error: "internal_error" })).code === "");

/* D */
const cases = [
  { code: "qw", kind: "percent", value: "10" }, { code: "QWE", kind: "percent", value: "10" }, { code: "x".repeat(33), kind: "percent", value: "10" },
  { code: "رمضان", kind: "percent", value: "10" }, { code: "RAMADAN 26", kind: "percent", value: "10" }, { code: " ok_2026 ", kind: "amount", value: "9.5" },
  { code: "PCT", kind: "percent", value: "100" }, { code: "PCT", kind: "percent", value: "99.99" }, { code: "AMT", kind: "amount", value: "9.999" },
  { code: "AMT", kind: "amount", value: "0" }, { code: "AMT", kind: "amount", value: "-3" }, { code: "MAXR", kind: "percent", value: "5", maxRedemptions: "1.5" },
  { code: "MAXR", kind: "percent", value: "5", maxRedemptions: "0" }, { code: "DATES", kind: "percent", value: "5", validFrom: "2026-12-02T10:00", validUntil: "2026-12-01T10:00" },
];
const disagree = cases.filter((f) => {
  const client = Object.keys(discountProblems(f)).length === 0;
  let server = true; try { validateDiscountInput({ ...f, value: Number(f.value), maxRedemptions: f.maxRedemptions ? Number(f.maxRedemptions) : null }); } catch { server = false; }
  return client !== server;
});
ok(`D1 فحص اللوحة يوافق الخادم في ${cases.length} حالة حدّية`, disagree.length === 0, JSON.stringify(disagree));
ok("D2 «qw» يُوقَف في اللوحة برسالة تقول الطول الحالي", /الآن 2/.test(discountProblems({ code: "qw", kind: "percent", value: "10" }).code || ""));

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 1500)})` : ""}`); } }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
