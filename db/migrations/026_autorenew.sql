-- ============================================================
-- 026 — التجديد التلقائي بالبطاقة المحفوظة (KANAF-ORD-0013 §7)
--
-- ⚠️ غير مفعَّل على الإنتاج: الكود خلف AUTORENEW_ENABLED (غيابه = معطَّل)،
--    ولا يُفعَّل قبل أن يشحن التطبيق نص الموافقة وواجهة الإلغاء
--    (docs/ord-0013/APP_AUTORENEW_SPEC.md). هذه الجداول تبقى فارغة حتى ذلك.
--
-- 🔴 7.1 لا بيانات بطاقة: رمز المزوّد وحده (token) مشفّراً بـAES-256-GCM
--    (نفس مفتاح INTEGRATIONS_ENC_KEY)، وآخر أربعة أرقام والعلامة للعرض.
--    لا عمود لرقم البطاقة ولا لتاريخ الانتهاء ولا لـCVV.
-- 🔴 7.2 الموافقة صريحة بنصّها ونسختها ووقتها. لا ترحيل يجعل مشتركاً قائماً
--    «تلقائياً»: renewal_mode لا يُلمس هنا، ولا صفّ موافقة يُزرع.
-- 🔴 7.4 لا خصم مكرر: دورة واحدة لكل (اشتراك × نهاية فترة) بمفتاح فريد،
--    ومحاولة واحدة لكل رقم محاولة بمفتاح فريد — فوق القفل الاستشاري.
--
-- جداول جديدة كلها، يملكها دور التطبيق. لا تعديل على جدول قائم.
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_methods (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  token_ciphertext BYTEA NOT NULL,
  token_iv         BYTEA NOT NULL,
  token_auth_tag   BYTEA NOT NULL,
  card_brand       TEXT CHECK (card_brand IS NULL OR char_length(card_brand) <= 20),
  card_last4       TEXT CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at       TIMESTAMPTZ
);
-- بطاقة فعّالة واحدة لكل عضو: حفظ بطاقة جديدة يُخرج السابقة.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_methods_active ON payment_methods (user_id) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS autorenew_consents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id   UUID NOT NULL,
  payment_method_id UUID NOT NULL REFERENCES payment_methods(id),
  consent_version   TEXT NOT NULL,
  consent_text      TEXT NOT NULL CHECK (char_length(consent_text) BETWEEN 20 AND 2000),
  plan_key          TEXT NOT NULL,
  amount_sar        NUMERIC(12, 2) NOT NULL CHECK (amount_sar > 0),
  source            TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app')),
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ,
  revoked_by        TEXT CHECK (revoked_by IS NULL OR revoked_by IN ('member', 'admin', 'system')),
  revoked_by_admin  UUID,
  revoke_reason     TEXT CHECK (revoke_reason IS NULL OR char_length(revoke_reason) <= 500),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_autorenew_consent_active ON autorenew_consents (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS renewal_cycles (
  cycle_key        TEXT PRIMARY KEY,               -- subscription_id:نهاية الفترة (ISO)
  subscription_id  UUID NOT NULL,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_id       UUID NOT NULL REFERENCES autorenew_consents(id),
  period_end       TIMESTAMPTZ NOT NULL,
  plan_key         TEXT NOT NULL,
  amount_sar       NUMERIC(12, 2) NOT NULL CHECK (amount_sar > 0),  -- المبلغ المعلَن في الإشعار
  status           TEXT NOT NULL DEFAULT 'noticed'
                   CHECK (status IN ('noticed', 'charging', 'retry', 'succeeded', 'stopped', 'cancelled', 'unknown')),
  notice_sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  TIMESTAMPTZ,
  invoice_id       UUID,
  last_error       TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 120),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_renewal_cycles_due ON renewal_cycles (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_renewal_cycles_user ON renewal_cycles (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS renewal_attempts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- مفتاح منع التكرار لدى المزوّد
  cycle_key           TEXT NOT NULL REFERENCES renewal_cycles(cycle_key),
  attempt_no          INTEGER NOT NULL CHECK (attempt_no >= 1),
  invoice_id          UUID NOT NULL,
  provider            TEXT NOT NULL,
  provider_payment_id TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
  failure_code        TEXT CHECK (failure_code IS NULL OR char_length(failure_code) <= 120),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  UNIQUE (cycle_key, attempt_no)
);

-- إعدادات قابلة للتعديل من صفحة الإعدادات (§7.3 مهلة الإشعار، §7.6 حدّ المحاولات).
INSERT INTO app_settings (key, value, category, description) VALUES
  ('autorenew_notice_days',  '3'::jsonb,  'general', 'كم يوماً قبل الخصم التلقائي يصل إشعار التجديد (1–14)'),
  ('autorenew_max_attempts', '3'::jsonb,  'general', 'أقصى عدد محاولات خصم لكل تجديد قبل التوقّف (1–5)'),
  ('autorenew_retry_hours',  '24'::jsonb, 'general', 'الساعات بين محاولة خصم فاشلة والتي تليها (6–72)')
ON CONFLICT (key) DO NOTHING;

-- ROLLBACK (يدوي، موثَّق): الجداول جديدة وفارغة ما دام المفتاح معطَّلاً.
--   DROP TABLE renewal_attempts, renewal_cycles, autorenew_consents, payment_methods;
--   DELETE FROM app_settings WHERE key IN ('autorenew_notice_days','autorenew_max_attempts','autorenew_retry_hours');
-- بعد أي تجديد فعلي لا رجوع آمن بالحذف: الفواتير والدفعات الناتجة سجلات مالية تبقى.
