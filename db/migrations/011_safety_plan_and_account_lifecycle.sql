-- ============================================================
-- 011 — خطة الأمان ودائرة الدعم، ودورة حياة الحساب (طلب الحذف)
-- KANAF-ORD-0001: R15-01, R15-02
--
-- قيد الملكية (انظر 002/004/007): الجداول الأصلية يملكها postgres،
-- والتطبيق يتصل بدور لا يملكها. لذلك:
--   • لا ALTER TABLE ولا CREATE INDEX على أي جدول أصلي.
--   • جداول جديدة يملكها التطبيق، و REFERENCES users وحده (مؤكَّد).
--   • users.deleted_at عمود أصلي موجود منذ schema.sql — يُكتب بـUPDATE
--     (مسموح) ولا يحتاج تعديل بنية.
-- اختُبر هذا الملف على قاعدة معزولة بدورين: مالك فائق للجداول الأصلية
-- ودور تشغيل بلا عضوية فيه (test-support/setup-isolated-db.mjs).
-- ============================================================

-- ------------------------------------------------------------
-- 1) خطة الأمان الشخصية — صف واحد لكل مستخدم
--
-- كانت حالة React وحدها: تُفقد مع أول تحديث للصفحة، ورسالة «تم الحفظ»
-- تظهر بلا حفظ. النص هنا محتوى نفسي خاص: لا يقرؤه أي مسار إداري
-- (مثل الأعمدة الأربعة المحمية)، ولا يُكتب في السجل.
-- version للتزامن بين جهازين: الحفظ بنسخة أقدم يُرفض 409 بدل أن
-- يكتب فوق تعديل أحدث بصمت.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_safety_plans (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  warning_signs      TEXT NOT NULL DEFAULT '' CHECK (char_length(warning_signs) <= 2000),
  coping_strategies  TEXT NOT NULL DEFAULT '' CHECK (char_length(coping_strategies) <= 2000),
  safe_place         TEXT NOT NULL DEFAULT '' CHECK (char_length(safe_place) <= 2000),
  version            INTEGER NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 2) دائرة الدعم — شخصان كحد أقصى لكل مستخدم
--
-- الحد يُفرض في القاعدة (position ∈ {1,2} + فرادة) لا في الواجهة وحدها:
-- طلبان متزامنان لا يُنتجان ثلاثة أشخاص.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_support_contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position      SMALLINT NOT NULL CHECK (position IN (1, 2)),
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  phone         TEXT NOT NULL CHECK (phone ~ '^\+?[0-9]{5,15}$'),
  relationship  TEXT NOT NULL DEFAULT '' CHECK (char_length(relationship) <= 60),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, position)
);
CREATE INDEX IF NOT EXISTS idx_user_support_contacts_user ON user_support_contacts (user_id);

-- ------------------------------------------------------------
-- 3) طلبات حذف الحساب
--
-- بلا مفتاح أجنبي عمداً: السجل يجب أن يبقى بعد إخفاء هوية صف users
-- (أثر تشغيلي لا محتوى نفسي)، ولا يجوز أن يمحوه CASCADE.
-- لا يحوي بريداً ولا اسماً — المعرّف وحده.
--
-- لماذا لا حذف لصف users أصلاً (حتى بعد قرار الاحتفاظ):
--   invoices و payments و credit_notes و refunds تتبع users بـ
--   ON DELETE CASCADE — حذف الصف يمحو الفواتير الضريبية الصادرة.
--   و admin_access_log و break_glass_requests تشير إليه بلا ON DELETE،
--   فيفشل الحذف لأي مستخدم سبق أن فُتح ملفه إدارياً.
-- لذلك «الحذف النهائي» = حذف البيانات النفسية والشخصية + إخفاء هوية
-- صف users، وفق سياسة احتفاظ يعتمدها المالك (قرار D-01).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status           TEXT NOT NULL DEFAULT 'deactivated'
                   CHECK (status IN ('deactivated', 'purged', 'canceled')),
  sessions_revoked INTEGER NOT NULL DEFAULT 0,
  push_removed     INTEGER NOT NULL DEFAULT 0,
  purged_at        TIMESTAMPTZ,
  purge_policy     TEXT,
  purge_counts     JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_deletion_open
  ON account_deletion_requests (user_id) WHERE status = 'deactivated';
