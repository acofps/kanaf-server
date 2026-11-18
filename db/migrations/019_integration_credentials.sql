-- ============================================================
-- 019 — اعتمادات التكاملات، مشفَّرة (KANAF-ORD-0008 §7)
--
-- صفحة اعتمادات ≠ تكامل. هذا الجدول يحفظ المفاتيح فقط؛ ولا مسار
-- تشغيلي في الدفع أو الفوترة أو البريد يقرأ منه. كل تكامل فعلي أمر مستقل.
--
-- • ليس app_settings: فئاتها تُقرأ حسب الدور، ومفتاح مزوّد ليس إعداداً.
-- • القيمة مشفَّرة AES-256-GCM بمفتاح من متغيّر البيئة INTEGRATIONS_ENC_KEY
--   (integrations/crypto.js). لا عمود نص صريح. last4 للعرض المقنَّع وحده.
-- • تفرّد (الخدمة، اسم المفتاح) بقيد — وفحص آلي يمنع تكرار الاسم عبر
--   هذا الجدول وapp_settings معاً (test-30).
-- ============================================================
CREATE TABLE IF NOT EXISTS integration_credentials (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service     TEXT NOT NULL CHECK (service IN ('mailgun', 'sms', 'whatsapp', 'qoyod', 'moyasar', 'tamara')),
  key_name    TEXT NOT NULL CHECK (key_name ~ '^[a-z][a-z0-9_]{1,40}$'),
  ciphertext  BYTEA NOT NULL,
  iv          BYTEA NOT NULL,
  auth_tag    BYTEA NOT NULL,
  last4       TEXT NOT NULL,
  updated_by  UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service, key_name)
);
