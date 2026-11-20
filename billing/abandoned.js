/* ============================================================
   السلة المتروكة — تعريف واحد لصفحة اللوحة ولفئة الجمهور معاً
   (KANAF-ORD-0008 §4)

   لا «سلة» في النظام، ولا حاجة لاختراعها. المعادل قائم: فاتورة
   حالتها pending مضى على إنشائها أكثر من 20 دقيقة ولم تُدفع
   (payments/routes.js يُنشئها pending عند طلب الدفع).

   كل شيء يُحسب عند القراءة — لا وظيفة خلفية، ولا جدول، ولا حقل حالة.
   ولا يُعرف «هل فتح صفحة الدفع»: النظام لا يسجّل فتح الرابط، ووجود
   checkout_url لا يعني زيارته. تتبّع ذلك آلية جديدة لها أثر خصوصي
   خارج هذا الأمر.

   «اشترى لاحقاً» = فاتورة مدفوعة للمستخدم نفسه أُنشئت بعد هذه.
   ============================================================ */
export const ABANDONED_AFTER_MINUTES = 20;

/** شرط SQL على فاتورة باسم مستعار `alias`: معلّقة ومتروكة. */
export function abandonedWhere(alias = "i") {
  return `${alias}.status = 'pending' AND ${alias}.created_at < now() - interval '${ABANDONED_AFTER_MINUTES} minutes'`;
}

/** تعبير SQL منطقي: هل اشترى صاحب الفاتورة `alias` لاحقاً بفاتورة أخرى؟ */
export function purchasedLaterSql(alias = "i") {
  return `EXISTS (SELECT 1 FROM invoices p WHERE p.user_id = ${alias}.user_id AND p.status = 'paid' AND p.created_at > ${alias}.created_at)`;
}
