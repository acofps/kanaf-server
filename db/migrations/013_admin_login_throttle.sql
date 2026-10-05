-- ============================================================
-- 013 — تهدئة محاولات دخول الإدارة لكل حساب
-- KANAF-ORD-0001: R15-23
--
-- كان الحد بالعنوان وحده (10 كل ربع ساعة)، وعنوان الطلب على الإنتاج
-- عنوان طرف Cloudflare (R15-07) — فالحد مشترك بين مسؤولين لا علاقة
-- بينهم، ومهاجم يوزّع محاولاته على عناوين لا يصطدم به.
--
-- جدول جانبي يملكه التطبيق (ALTER على admin_users ممنوع — يملكه
-- postgres). بلا مفتاح أجنبي إلى admin_users (REFERENCES عليه غير
-- مؤكد — سابقة 003/007). صف واحد لكل حساب يُكتب عند الفشل فقط.
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_auth_state (
  admin_user_id      UUID PRIMARY KEY,
  failed_count       INTEGER NOT NULL DEFAULT 0,
  locked_until       TIMESTAMPTZ,
  last_failed_at     TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
