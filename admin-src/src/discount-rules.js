/* KANAF-ORD-0015 §2.4(أ): قواعد الخادم نفسها (billing/discounts.js validateDiscountInput) تُفحص قبل الإرسال،
   فلا يُرسَل طلب محكوم بالفشل، ويقول كل حقل ما ينقصه. الخادم يبقى الحَكَم: هذه مرآة لا بديل. */
export function discountProblems(f) {
  const e = {};
  const code = String(f.code || "").trim().toUpperCase();
  if (code && !/^[A-Z0-9_-]+$/.test(code)) e.code = "حروف لاتينية وأرقام و- و_ فقط — بلا مسافات ولا حروف عربية.";
  else if (code && (code.length < 3 || code.length > 32)) e.code = `الكود من 3 إلى 32 خانة — الآن ${code.length}.`;
  if (f.value !== "" && f.value !== undefined) {
    const v = Number(f.value);
    if (!Number.isFinite(v) || v <= 0) e.value = "القيمة رقم أكبر من صفر.";
    else if (f.kind === "percent" && v >= 100) e.value = "النسبة أقل من 100 — خصم 100% غير مسموح.";
    else if (Math.round(v * 100) !== v * 100) e.value = "خانتان عشريتان على الأكثر (مثل 9.50).";
  }
  if (f.validFrom && f.validUntil && new Date(f.validUntil) <= new Date(f.validFrom)) e.validUntil = "الانتهاء بعد البدء.";
  if (f.maxRedemptions !== "" && f.maxRedemptions !== undefined && f.maxRedemptions !== null) {
    const m = Number(f.maxRedemptions);
    if (!Number.isInteger(m) || m <= 0) e.maxRedemptions = "عدد صحيح أكبر من صفر، أو اتركه فارغاً.";
  }
  if (!code) e.required = "الكود مطلوب.";
  else if (f.value === "" || f.value === undefined) e.required = "القيمة مطلوبة.";
  return e;
}
