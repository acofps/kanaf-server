-- ============================================================
-- 018 — أكواد الخصم: الجدول فقط، بلا ربط بالدفع (KANAF-ORD-0008 §6)
--
-- 🔴 الخصم تعديل على وثيقة ضريبية لا عنصر واجهة: يغيّر الوعاء
-- والضريبة، ويجب أن يظهر في الفاتورة بنداً ظاهراً، وأن يساوي المبلغ
-- المرسَل إلى بوابة الدفع المبلغ بعد الخصم. لذلك هذا الترحيل يُنشئ
-- الجدولين، ولا شيء في مسار الدفع أو الفوترة يقرؤهما. الربط أمر مستقل.
--
-- قرار محدَّد لا مكتشَف (§6.2): خصم 100% ممنوع بالقيد هنا (فاتورة
-- بصفر سلوك لم يُقرَّر بعد). والمبلغ الثابت الذي يساوي سعر الباقة أو
-- يتجاوزه يرفضه فحص الكود (billing/discounts.js).
--
-- discount_code_redemptions «من استعمله»: يبقى فارغاً حتى أمر الربط —
-- لا مسار يكتب فيه اليوم.
-- ============================================================
CREATE TABLE IF NOT EXISTS discount_codes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{3,32}$'),  -- يُخزَّن بحروف كبيرة
  kind             TEXT NOT NULL CHECK (kind IN ('percent', 'amount')),
  value            NUMERIC(10,2) NOT NULL CHECK (value > 0),
  valid_from       TIMESTAMPTZ,
  valid_until      TIMESTAMPTZ,
  max_redemptions  INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  plan_keys        TEXT[],                         -- NULL = كل الباقات
  is_active        BOOLEAN NOT NULL DEFAULT true,
  note             TEXT,
  created_by       UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'percent' OR value < 100),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);

CREATE TABLE IF NOT EXISTS discount_code_redemptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_code_id  UUID NOT NULL REFERENCES discount_codes(id) ON DELETE RESTRICT,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- مرجع منطقي بلا FK: invoices يملكها المستخدم الفائق، ودور التطبيق لا يملك REFERENCES عليها
  -- (نفس نمط المراجع المنطقية التي يفحصها X07).
  invoice_id        UUID,
  redeemed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_discount_redemptions_code ON discount_code_redemptions (discount_code_id);
