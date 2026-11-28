-- ============================================================
-- KANAF-ORD-0023 ب-3 — رسالة «تغيّرت كلمة مرورك من الدعم»
--
-- توسيع قيد نوع سجلّ رسائل النظام بنوع واحد لا غير. لا عمود ولا
-- جدول ولا بيانات. متكرّر بأمان: يُسقط القيد ويعيده بالقائمة كاملة.
-- قبل تطبيقه: تعيين كلمة المرور والبريد يعملان، وصفّ السجلّ وحده
-- يُرفض بالقيد فيُبتلع (logSystemMessage لا يرمي).
-- ============================================================
ALTER TABLE system_message_log DROP CONSTRAINT IF EXISTS system_message_log_kind_check;
ALTER TABLE system_message_log ADD CONSTRAINT system_message_log_kind_check
  CHECK (kind IN ('email_verification', 'password_reset', 'existing_account_notice', 'daily_reminder',
                  'renewal_notice', 'renewal_succeeded', 'renewal_failed', 'renewal_stopped',
                  'password_set_by_support'));
