-- ============================================================
-- 024 — الأعضاء الملغون: سجلّ مجهول لا يُردّ إلى صاحبه (KANAF-ORD-0013 §8)
--
-- قرار المالك 2026-11-22: «الاحتفاظ بلا هوية». يُكتب صفّ هنا عند الحذف النهائي
-- (purgeDeletedAccount)، في المعاملة نفسها التي تمحو بيانات العضو.
--
-- 🔴 8.1 المعرّف عشوائي (gen_random_uuid) لا يُشتق من معرّف المستخدم ولا من
--    بريده ولا من أي قيمة أصلية. ولا عمود هنا يحمل user_id أو بريداً أو اسماً.
-- 🔴 8.4 لا ربط بشخص ولا بلحظة: التواريخ بالشهر (YYYY-MM) لا بالطابع الزمني —
--    طابع دقيق لتاريخ الانضمام كان سيُطابق users.created_at للصفّ المُجهَّل
--    الباقي لأجل الفواتير، فيصير «المجهول» معروفاً بالمقارنة.
-- 8.2 الفواتير خارج هذا الجدول، وتبقى كما صدرت.
-- 8.3 لا استرجاع: لا مسار ولا عمود يعيد العضو.
-- ============================================================
CREATE TABLE IF NOT EXISTS cancelled_members (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  joined_month       TEXT NOT NULL CHECK (joined_month ~ '^\d{4}-\d{2}$'),
  cancelled_month    TEXT NOT NULL CHECK (cancelled_month ~ '^\d{4}-\d{2}$'),
  membership_days    INTEGER NOT NULL CHECK (membership_days >= 0),
  plan_key           TEXT,                       -- آخر باقة (مفتاح الباقة، لا سعر ولا فاتورة)
  subscription_days  INTEGER,                    -- مجموع أيام الاشتراك
  cancel_reason      TEXT NOT NULL CHECK (cancel_reason IN ('account_deleted_by_member', 'account_deleted_after_subscription_cancel')),
  services           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { daily_logs: {count, first_month, last_month}, … } أعداد وأشهر فقط
  completed          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { journeys: {key: n}, tools: {tool_id: n} } مفاتيح المحتوى وأعداد فقط
  recorded_month     TEXT NOT NULL CHECK (recorded_month ~ '^\d{4}-\d{2}$')
);
