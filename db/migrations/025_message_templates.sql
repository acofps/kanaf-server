-- ============================================================
-- 025 — قوالب الرسائل ومحتوى رسائل النظام (KANAF-ORD-0013 §9)
--
-- «اختيار قالب» يعني أكثر من قالب، والقائم واحد (ORD-0008 §9). فتصير القوالب
-- صفوفاً، والقالب الحالي هو الافتراضي (is_default) ولا يُحذف.
-- خصائص القالب القابلة للتعديل محدودة عمداً: لون العنوان من لوحة مقيسة التباين،
-- ونص تذييل، وإظهار روابط المتجرين والحسابات. البنية نفسها (الشعار المضمَّن،
-- العرض المتسع للجوال، التهريب، رابط الإلغاء الإلزامي في التسويقية) لا تُعدَّل.
--
-- message_definitions: نص كل رسالة نظام وقالبها وقنواتها. غياب الصف = النص
-- الافتراضي المكتوب في الكود (notifications/messages.js) — فلا يتغيّر شيء على
-- الإنتاج بهذا الترحيل وحده.
--
-- 🔴 لا نص رسالة مُرسلة يُخزَّن هنا ولا في system_message_log (§9.3): ما هنا
-- قوالب بمواضع ({{code}})، لا رسائل بقيمها.
-- ============================================================
CREATE TABLE IF NOT EXISTS message_templates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 60),
  accent             TEXT NOT NULL DEFAULT '#735890' CHECK (accent IN ('#735890', '#594372', '#402F53', '#1C1626')),
  footer_note        TEXT NOT NULL DEFAULT '' CHECK (char_length(footer_note) <= 300),
  show_store_links   BOOLEAN NOT NULL DEFAULT true,
  show_social_links  BOOLEAN NOT NULL DEFAULT true,
  is_default         BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_templates_one_default ON message_templates ((true)) WHERE is_default;
INSERT INTO message_templates (name, is_default)
SELECT 'القالب الموحّد', true
WHERE NOT EXISTS (SELECT 1 FROM message_templates WHERE is_default);

CREATE TABLE IF NOT EXISTS message_definitions (
  key          TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,60}$'),
  subject      TEXT CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 200),
  body         TEXT CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 5000),
  template_id  UUID REFERENCES message_templates(id) ON DELETE SET NULL,
  channels     TEXT[],
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   UUID
);

-- سجل رسائل النظام: أنواع إشعارات التجديد (§7.3 و§7.6) وقنواتها. توسيع قيدين لا غير —
-- ولا عمود نص يُضاف (§9.3: الجدول بلا نص عمداً).
ALTER TABLE system_message_log DROP CONSTRAINT IF EXISTS system_message_log_kind_check;
ALTER TABLE system_message_log ADD CONSTRAINT system_message_log_kind_check
  CHECK (kind IN ('email_verification', 'password_reset', 'existing_account_notice', 'daily_reminder',
                  'renewal_notice', 'renewal_succeeded', 'renewal_failed', 'renewal_stopped'));
ALTER TABLE system_message_log DROP CONSTRAINT IF EXISTS system_message_log_channel_check;
ALTER TABLE system_message_log ADD CONSTRAINT system_message_log_channel_check
  CHECK (channel IN ('email', 'push', 'in_app', 'sms', 'whatsapp'));
