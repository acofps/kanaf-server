-- ============================================================
-- 015 — التحقق المالي لحدث الدفع (KANAF-ORD-0003 N-02)
--
-- 1) invoice_payment_expectations: المبلغ (بالهللة) والعملة المتوقعان لفاتورة، يُكتبان
--    في نفس معاملة إنشاء الفاتورة (payments/routes.js). هو مرجع المطابقة لحدث «مدفوع»:
--    لا سعر الباقة الحالي، ولا billing_settings وقت وصول الحدث. جدول جديد مملوك للتطبيق
--    لأن invoices ملك postgres في الإنتاج (لا ALTER عليه — ADR-03). الفواتير الأقدم بلا صف هنا
--    تُطابَق بقاعدة «legacy» موثقة في payments/verify.js (لا ترحيل تخميني).
-- 2) payment_event_holds: حدث دفع لم يُقبل (عدم مطابقة، أو تعذّر تحقق مؤقت). يُحفظ بسبب
--    قابل للفحص وبالمتوقع والوارد (معرّفات ومبالغ فقط — لا بيانات بطاقة ولا الحمولة الخام)،
--    بلا تفعيل ولا وثيقة ولا استرداد. تظهر لمن يملك payments:view، ويعيد فحصها payments:reconcile.
--
-- بلا مفاتيح أجنبية إلى invoices/webhook_events: صلاحية REFERENCES لدور التشغيل على جداول
-- postgres غير متحققة على الإنتاج، وترحيل يفشل على صلاحية أسوأ من معرّف مخزَّن (نفس منطق X07).
-- إضافي بالكامل: لا تعديل ولا حذف لعمود أو صف قائم.
-- ============================================================
CREATE TABLE IF NOT EXISTS invoice_payment_expectations (
  invoice_id      UUID PRIMARY KEY,
  amount_halalas  BIGINT NOT NULL CHECK (amount_halalas > 0),
  currency        TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_event_holds (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 TEXT NOT NULL CHECK (kind IN ('mismatch', 'verification_unavailable')),
  reason               TEXT NOT NULL,
  source               TEXT NOT NULL CHECK (source IN ('webhook', 'replay', 'reconcile', 'recheck')),
  event_type           TEXT NOT NULL,
  webhook_event_id     UUID,
  provider_payment_id  TEXT,
  invoice_id           UUID,
  expected             JSONB,
  received             JSONB,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution           JSONB,
  seen_count           INTEGER NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at          TIMESTAMPTZ
);
-- حدث واحد مفتوح لكل (دفعة، نوع، سبب): التسليم المكرر يزيد seen_count ولا ينشئ صفاً ثانياً.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_event_holds_open
  ON payment_event_holds (COALESCE(provider_payment_id, ''), event_type, reason) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_payment_event_holds_status ON payment_event_holds (status, created_at DESC);
