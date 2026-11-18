-- ============================================================
-- 016 — سجل رسائل النظام بلا نص (KANAF-ORD-0008 §3.4 و§1.1)
--
-- رسائل النظام إلى المستخدم (كود تأكيد البريد، كود استعادة كلمة المرور،
-- إشعار «عندك حساب مسبقاً»، دفعة التذكير اليومي على الجهاز) لم يكن لها
-- أي سجل. هذا الجدول يسجّل أن الرسالة خرجت: النوع والقناة والحالة والوقت.
--
-- 🔴 لا عمود للنص ولا للعنوان، عمداً وبالبنية لا بالاتفاق:
--   كود التحقق مفتاح دخول؛ من يراه يملك الحساب. فلا مكان في هذا الجدول
--   يمكن أن يُكتب فيه كود أو رابط إعادة تعيين أو أي سرّ، ولا مسار يعيده.
--   والمستلم يُعرَف بـuser_id فقط، ويُقنَّع بريده عند القراءة من users.
--
-- يُحذف بحذف صف المستخدم (CASCADE)، وصراحةً في purgeDeletedAccount
-- (الحذف النهائي يجهّل صف users ولا يحذفه) — نفس نمط 014.
-- إضافي بالكامل: لا يغيّر جدولاً قائماً.
-- ============================================================
CREATE TABLE IF NOT EXISTS system_message_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('email_verification', 'password_reset', 'existing_account_notice', 'daily_reminder')),
  channel     TEXT NOT NULL CHECK (channel IN ('email', 'push')),
  status      TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error_code  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_system_message_log_time ON system_message_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_message_log_user ON system_message_log (user_id, created_at DESC);
