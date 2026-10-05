-- ============================================================
-- 014 — إيصالات الكتابة لمنع التكرار (KANAF-ORD-0002 B-04)
--
-- الإنشاء عبر POST في الاستبيانات وجلسات الأدوات والدفاتر يُدرج صفاً جديداً
-- في كل نداء. فإن انقطع الرد بعد أن وصلت الكتابة، ثم أعاد التطبيق المحاولة،
-- تتكرر النتيجة. العميل يرسل clientRef (UUID يولّده مرة لكل كتابة منطقية
-- ويعيد استعماله في إعادة المحاولة)، والخادم يسجل إيصالاً بالمفتاح
-- (user_id, client_ref) في نفس معاملة الإدراج: الإيصال الموجود يعني أن
-- الكتابة تمت فيُعاد معرّفها بلا إدراج ثانٍ.
--
-- جدول جديد بدل تعديل الجداول الأصلية (screenings ملك postgres في الإنتاج)؛
-- لا يحمل نصاً نفسياً — معرّفات فقط. يُحذف مع الحساب (CASCADE وpurge).
-- إضافي بالكامل: العميل القديم بلا clientRef يعمل كما كان.
-- ============================================================
CREATE TABLE IF NOT EXISTS user_write_receipts (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_ref   UUID NOT NULL,
  resource     TEXT NOT NULL CHECK (resource IN ('screening', 'cbt_session', 'notebook')),
  resource_id  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_ref)
);
CREATE INDEX IF NOT EXISTS idx_user_write_receipts_created ON user_write_receipts (created_at);
