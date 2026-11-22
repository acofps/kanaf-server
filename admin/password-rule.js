/* ============================================================
   قاعدة كلمة مرور حساب الإدارة — موضع واحد (KANAF-ORD-0013 §5.4)

   كانت «خمسة عشر حرفاً» مكتوبة في ثلاثة مواضع: db/seed_first_admin.js،
   ومسار /api/setup/create-first-admin في index.js، وMIN_PASSWORD_LENGTH في
   admin/accounts.js (إكمال الدعوة). الثلاثة تقرأ من هنا الآن، ومعها الإنشاء
   المباشر. حساب إدارة بعامل واحد: الطول هو الحماية.
   ============================================================ */
export const ADMIN_MIN_PASSWORD_LENGTH = 15;

/** يعيد رمز الخطأ أو null. */
export function adminPasswordError(password) {
  if (typeof password !== "string" || password.length < ADMIN_MIN_PASSWORD_LENGTH) return "password_too_short";
  return null;
}
