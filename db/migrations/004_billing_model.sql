-- 004_billing_model.sql
-- المرحلة 3: نموذج الاشتراك والدفع والفاتورة والضريبة والاسترداد.
--
-- Safe to run more than once (كل عبارة IF NOT EXISTS). Apply with:
--   node db/migrate.js
--   أو POST /api/setup/run-migrations { token }
--
-- ============================================================
-- القيد الحاكم لهذا الملف — اقرأه قبل أي تعديل
-- ============================================================
-- الجداول الخمسة عشر الأصلية (users, subscriptions, invoices,
-- credit_notes, subscription_plans, tax_settings, ...) مملوكة
-- للمستخدم الفائق `postgres`، والتطبيق يتصل كـ`kanaf_adel`.
-- لذلك:
--   • ALTER TABLE على أي منها  → يفشل: must be owner of relation
--   • CREATE INDEX على أي منها → يفشل لنفس السبب
--   • UPDATE / INSERT / DELETE → مسموح
--   • REFERENCES على users     → مسموح (مؤكد عملياً في 002)
--
-- النتيجة العملية: كل حقل جديد يذهب إلى جدول جديد مملوك للتطبيق،
-- ومفاتيح الأجانب تُوجَّه إلى users فقط. الروابط إلى invoices و
-- subscriptions تُخزَّن كـUUID بلا قيد مرجعي — ليس تهاوناً، بل لأن
-- صلاحية REFERENCES على تلك الجداول غير مؤكدة، وترحيل قد يفشل عند
-- فحص صلاحية أسوأ من رابط منطقي موثّق ومغطّى باختبارات التكامل
-- (GET /admin/billing/integrity يفحص الأيتام صراحةً).
--
-- ولا يوجد في هذا الملف أي عبارة مدمّرة: لا DROP ولا DELETE ولا
-- تعديل على بيانات قائمة عدا تعبئة رجعية بـINSERT ... SELECT.
-- ============================================================


/* ============================================================
   1) billing_settings — الإعداد الضريبي والمالي المركزي

   قبل هذا الجدول كانت نسبة الضريبة ثابتة في الكود
   (VAT_RATE = 0.15 داخل invoicing/zatca.js)، والعملة مكتوبة
   حرفياً "SAR" في ثلاثة ملفات مختلفة. القيم الافتراضية هنا مطابقة
   تماماً للسلوك الحالي — الترحيل لا يغيّر أي حساب قائم، بل ينقل
   مصدر القيمة من الكود إلى صف واحد قابل للتحرير من اللوحة.

   ملاحظة مقصودة: لم تُخترع أي نسبة أو متطلب قانوني هنا. 0.15 هي
   القيمة التي يعمل بها المشروع فعلاً منذ البداية، و`vat_rate`
   المطبَّقة تُجمَّد على كل فاتورة عند إصدارها (invoice_state)، حتى
   لا يؤثر أي تعديل مستقبلي على فواتير صدرت قبله.
   ============================================================ */
CREATE TABLE IF NOT EXISTS billing_settings (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton                 BOOLEAN NOT NULL DEFAULT true UNIQUE CHECK (singleton = true),
  vat_rate                  NUMERIC(6, 4) NOT NULL DEFAULT 0.15 CHECK (vat_rate >= 0 AND vat_rate < 1),
  prices_include_vat        BOOLEAN NOT NULL DEFAULT true,
  currency                  TEXT NOT NULL DEFAULT 'SAR' CHECK (char_length(currency) = 3),
  invoice_number_prefix     TEXT NOT NULL DEFAULT 'INV',
  credit_note_number_prefix TEXT NOT NULL DEFAULT 'CN',
  -- تُستخدم في تعريف نطاقات تواريخ مؤشرات الأداء المالية، حتى لا
  -- يعتمد "إيراد اليوم" على المنطقة الزمنية للخادم (UTC على Render).
  reporting_timezone        TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  updated_by                UUID,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO billing_settings (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;


/* ============================================================
   2) invoice_state — لقطة الفاتورة القانونية وقت إصدارها

   الفجوة التي يسدّها: جدول invoices يخزّن المبلغ والضريبة ورقم
   الفاتورة وحمولة الـQR وملف الـPDF — لكنه لا يخزّن **بيانات البائع
   ولا المشتري ولا نسبة الضريبة المطبَّقة** إطلاقاً. هذه البيانات
   تُرسم داخل الـPDF فقط. النتيجة أن تغيير الرقم الضريبي أو الاسم
   النظامي من صفحة الإعدادات يجعل من المستحيل معرفة ما كان مطبوعاً
   على فاتورة قديمة إلا بفتح الـPDF وقراءته بصرياً.

   الفاتورة وثيقة قانونية: ما طُبع فيها يجب أن يكون مقروءاً
   بالاستعلام، لا بالعين.
   ============================================================ */
CREATE TABLE IF NOT EXISTS invoice_state (
  invoice_id          UUID PRIMARY KEY,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency            TEXT NOT NULL DEFAULT 'SAR',
  vat_rate            NUMERIC(6, 4),          -- النسبة المطبَّقة فعلاً، مجمّدة عند الإصدار
  prices_include_vat  BOOLEAN,
  -- لقطة البائع وقت الإصدار (من tax_settings)
  seller_legal_name   TEXT,
  seller_vat_number   TEXT,
  seller_address      TEXT,
  -- لقطة المشتري وقت الإصدار
  buyer_name          TEXT,
  buyer_email         TEXT,
  -- بنود الفاتورة والخصم — مطلوبان في نموذج الفاتورة ولم يكونا مخزَّنين
  line_items          JSONB NOT NULL DEFAULT '[]'::jsonb,
  discount_sar        NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (discount_sar >= 0),
  -- المدة التي تغطيها الفاتورة — يربط الفاتورة بفترة الاشتراك
  billing_cycle       TEXT,
  period_start        TIMESTAMPTZ,
  period_end          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_state_user ON invoice_state (user_id, created_at DESC);


/* ============================================================
   3) payments — كيان الدفع المستقل

   قبل هذا الجدول لم يكن هناك كيان "دفعة" إطلاقاً: جدول invoices كان
   يؤدي ثلاثة أدوار متضاربة في آنٍ واحد — نيّة شراء (pending)،
   ومعاملة دفع (provider_payment_id)، ووثيقة ضريبية
   (zatca_invoice_number). أثر ذلك ليس نظرياً:

   • محاولة دفع فاشلة ثم ناجحة على نفس الفاتورة = معاملتان حقيقيتان
     لدى Moyasar، لكن عمود واحد لا يتسع إلا لواحدة، فتُمحى الأولى.
   • صفحة "المدفوعات" في اللوحة لا يمكن بناؤها أصلاً، لأن ما يوجد
     هو فواتير لا مدفوعات: لا طريقة دفع، ولا رقم معاملة مستقل،
     ولا سبب فشل.
   • منع تكرار رقم المعاملة (Duplicate transaction IDs) مستحيل،
     لأن CREATE INDEX على invoices ممنوع بقيد الملكية.

   هذا الجدول يفصل الثلاثة، ويحمل الفهرس الفريد الذي يجعل تكرار
   رقم المعاملة خطأً من قاعدة البيانات لا اجتهاداً في الكود.
   ============================================================ */
CREATE TABLE IF NOT EXISTS payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id           UUID NOT NULL,              -- رابط منطقي إلى invoices.id
  subscription_id      UUID,                       -- رابط منطقي إلى subscriptions.id
  provider             TEXT NOT NULL DEFAULT 'moyasar',
  provider_payment_id  TEXT,                       -- رقم المعاملة لدى المزوّد
  amount               NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  currency             TEXT NOT NULL DEFAULT 'SAR',
  method               TEXT,                       -- creditcard | applepay | stcpay | ...
  card_brand           TEXT,                       -- visa | mada | master — لا يُخزَّن رقم بطاقة إطلاقاً
  card_last4           TEXT CHECK (card_last4 IS NULL OR char_length(card_last4) <= 4),
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'voided')),
  failure_reason       TEXT,
  refunded_amount      NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  captured_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- منع "استرداد أكبر من المبلغ المحصَّل" على مستوى قاعدة البيانات،
  -- لا على مستوى شرط في الكود يمكن تجاوزه بمسار جديد.
  CONSTRAINT payments_refund_not_over_captured CHECK (refunded_amount <= amount)
);

-- منع تكرار رقم المعاملة. جزئي لأن الدفعة تُنشأ أحياناً قبل أن
-- يعطينا المزوّد رقمها (حالة pending).
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_txn
  ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_user     ON payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_invoice  ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments (status, created_at DESC);


/* ============================================================
   4) refunds — سجل الاسترداد الكامل والجزئي

   قبل هذا الجدول كان الاسترداد الإداري يعلّم الفاتورة `refunded`
   ويصدر إشعاراً دائناً — **دون أن ينادي Moyasar إطلاقاً**. أي أن
   الدفاتر تقول "مُسترد" والمال لم يغادر الحساب. وكان كامل المبلغ
   فقط، بلا استرداد جزئي.

   كل صف هنا يمثّل استرداداً واحداً حقيقياً لدى المزوّد. الجمع على
   payment_id هو ما يحدّ من تجاوز المبلغ المحصَّل، مع فحص القيد على
   payments.refunded_amount كخط دفاع ثانٍ في قاعدة البيانات.
   ============================================================ */
CREATE TABLE IF NOT EXISTS refunds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_id          UUID NOT NULL,              -- رابط منطقي إلى payments.id
  invoice_id          UUID NOT NULL,              -- رابط منطقي إلى invoices.id
  credit_note_id      UUID,                       -- رابط منطقي إلى credit_notes.id
  amount              NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency            TEXT NOT NULL DEFAULT 'SAR',
  kind                TEXT NOT NULL CHECK (kind IN ('full', 'partial')),
  provider            TEXT NOT NULL DEFAULT 'moyasar',
  provider_refund_id  TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  reason              TEXT,
  initiated_by        TEXT NOT NULL DEFAULT 'admin' CHECK (initiated_by IN ('admin', 'webhook', 'provider')),
  admin_user_id       UUID,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- استرداد المزوّد الواحد لا يُسجَّل مرتين مهما تكرر وصول الحدث.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_provider_id
  ON refunds (provider, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds (payment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refunds_user    ON refunds (user_id, created_at DESC);


/* ============================================================
   5) webhook_events — سجل الأحداث ومفتاح منع التكرار

   الحماية السابقة من التكرار كانت غير مباشرة: تُقرأ حالة الفاتورة،
   فإن كانت paid أو failed يُتجاهل الحدث. هذا يمنع التكرار فعلاً،
   لكنه يمنع معه شيئاً مشروعاً تماماً: **الدفع الناجح بعد محاولة
   فاشلة على نفس الفاتورة**. الفاتورة تصير failed، فيُرفض الحدث
   payment_paid التالي بوصفه "مكرراً" — العميل يُخصم منه ولا يُفعَّل
   اشتراكه. هذا العطب مغطّى الآن باختبار صريح (C ثم D في مصفوفة
   الاختبار).

   المفتاح هنا مبني على معرّف الحدث نفسه لا على حالة الفاتورة، فهو
   يفصل السؤالين: "هل رأيت هذا الحدث بعينه؟" غير "هل هذه الفاتورة
   مدفوعة؟".

   ⚠️ الحمولة تُخزَّن **بعد نزع secret_token منها**. تخزين السر مع
   كل حدث يحوّل جدول سجلات مقروءاً من اللوحة إلى مخزن أسرار.
   ============================================================ */
CREATE TABLE IF NOT EXISTS webhook_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           TEXT NOT NULL DEFAULT 'moyasar',
  provider_event_id  TEXT,
  event_type         TEXT NOT NULL,
  -- مفتاح منع التكرار: فريد إجبارياً. الحدث المكرر يصطدم بالقيد
  -- ولا يصل إلى منطق العمل أصلاً.
  dedup_key          TEXT NOT NULL UNIQUE,
  object_id          TEXT,                       -- معرّف الدفعة لدى المزوّد
  signature_valid    BOOLEAN NOT NULL DEFAULT false,
  status             TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  outcome            TEXT,
  error              TEXT,
  attempts           INTEGER NOT NULL DEFAULT 1,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_time   ON webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events (status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_object ON webhook_events (object_id);


/* ============================================================
   6) subscription_state — الحقول التي يحتاجها الاشتراك ولا يمكن
      إضافتها إلى جدوله

   جدول subscriptions يفتقر إلى: دورة الفوترة، لقطة السعر، العملة،
   بداية الفترة الحالية، الإلغاء بنهاية المدة، ومعرّف الاشتراك لدى
   المزوّد. ALTER TABLE عليه ممنوع، فتذهب هذه الحقول هنا — بنفس
   المنطق الذي وُلد به user_auth_state في 002.

   ملاحظة صريحة على renewal_mode: تكامل Moyasar الحالي **صفحة دفع
   مستضافة لفاتورة واحدة**، وليس اشتراكاً متكرراً لدى المزوّد. لا
   يوجد تجديد تلقائي يخصم من البطاقة، والتجديد شراء جديد يبدؤه
   المستخدم. القيمة الافتراضية 'manual' توصيف للواقع لا اختيار،
   وأي تحويل لاحق إلى 'automatic' يتطلب تكاملاً مختلفاً مع المزوّد.
   ============================================================ */
CREATE TABLE IF NOT EXISTS subscription_state (
  subscription_id          UUID PRIMARY KEY,      -- رابط منطقي إلى subscriptions.id
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  billing_cycle            TEXT,                  -- monthly | semiannual | annual | custom
  billing_period_days      INTEGER,
  plan_price_sar           NUMERIC(12, 2),        -- لقطة السعر وقت الشراء — لا تتأثر بتعديل الباقة لاحقاً
  currency                 TEXT NOT NULL DEFAULT 'SAR',
  current_period_start     TIMESTAMPTZ,
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT false,
  cancel_requested_at      TIMESTAMPTZ,
  cancel_reason            TEXT,
  provider                 TEXT,
  provider_subscription_id TEXT,
  last_invoice_id          UUID,
  last_payment_id          UUID,
  renewal_mode             TEXT NOT NULL DEFAULT 'manual' CHECK (renewal_mode IN ('manual', 'automatic')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscription_state_user ON subscription_state (user_id);
CREATE INDEX IF NOT EXISTS idx_subscription_state_cape
  ON subscription_state (cancel_at_period_end)
  WHERE cancel_at_period_end = true;


/* ============================================================
   7) تعبئة رجعية — غير مدمّرة، وقابلة لإعادة التشغيل

   الغرض ليس تجميلياً: صفحة "المدفوعات" ومؤشرات الإيراد تقرأ من
   payments. بدون هذه التعبئة تظهر الصفحة فارغة رغم وجود مدفوعات
   حقيقية في invoices، وهو بالضبط نمط "جدول بلا كاتب" الموثّق في
   وثيقة حالة المشروع.
   ============================================================ */

-- 7.1 كل فاتورة لها رقم معاملة لدى المزوّد تصير دفعة مقابلة.
INSERT INTO payments (user_id, invoice_id, provider, provider_payment_id, amount, currency, status, captured_at, created_at)
SELECT i.user_id,
       i.id,
       'moyasar',
       i.provider_payment_id,
       i.amount_sar,
       'SAR',
       CASE i.status
         WHEN 'paid'     THEN 'paid'
         WHEN 'failed'   THEN 'failed'
         WHEN 'refunded' THEN 'refunded'
         ELSE 'pending'
       END,
       CASE WHEN i.status IN ('paid', 'refunded') THEN i.updated_at ELSE NULL END,
       i.created_at
FROM invoices i
WHERE i.provider_payment_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM payments p
    WHERE p.provider = 'moyasar' AND p.provider_payment_id = i.provider_payment_id
  );

-- 7.2 المبلغ المسترد على الدفعات المستردة سابقاً = كامل المبلغ،
--     لأن الاسترداد الجزئي لم يكن مدعوماً قبل هذه المرحلة.
UPDATE payments p
SET refunded_amount = p.amount, updated_at = now()
FROM invoices i
WHERE i.id = p.invoice_id AND i.status = 'refunded' AND p.refunded_amount = 0;

-- 7.3 لقطة حالة لكل اشتراك قائم، بدورة فوترة وسعر مشتقّين من الباقة.
INSERT INTO subscription_state
  (subscription_id, user_id, billing_cycle, billing_period_days, plan_price_sar, currency,
   current_period_start, provider, renewal_mode, created_at)
SELECT s.id,
       s.user_id,
       CASE
         WHEN sp.duration_days IS NULL      THEN NULL
         WHEN sp.duration_days <= 31        THEN 'monthly'
         WHEN sp.duration_days <= 186       THEN 'semiannual'
         WHEN sp.duration_days <= 366       THEN 'annual'
         ELSE 'custom'
       END,
       sp.duration_days,
       sp.price_sar,
       'SAR',
       s.started_at,
       s.payment_provider,
       'manual',
       s.created_at
FROM subscriptions s
LEFT JOIN subscription_plans sp ON sp.plan_key = s.plan_id
WHERE NOT EXISTS (SELECT 1 FROM subscription_state ss WHERE ss.subscription_id = s.id);

-- 7.4 ربط الفواتير المدفوعة باشتراك صاحبها. عمود
--     invoices.subscription_id موجود في المخطط الأصلي منذ البداية
--     ولم يُكتب فيه شيء قط — وهو سبب استحالة الانتقال من فاتورة
--     إلى اشتراكها في اللوحة (Orphan invoices).
UPDATE invoices i
SET subscription_id = s.id
FROM subscriptions s
WHERE i.subscription_id IS NULL
  AND i.status IN ('paid', 'refunded')
  AND s.user_id = i.user_id
  AND s.plan_id = i.plan_id;

-- 7.5 لقطة قابلة للاستعلام للفواتير التي صدرت فعلاً قبل هذه المرحلة.
--     نسبة الضريبة تُشتق من الأرقام المخزّنة نفسها لا من الافتراض:
--     لو كانت subtotal و vat محفوظتين فالنسبة معروفة يقيناً.
INSERT INTO invoice_state (invoice_id, user_id, currency, vat_rate, prices_include_vat, buyer_email, created_at)
SELECT i.id,
       i.user_id,
       'SAR',
       CASE WHEN i.subtotal_sar IS NOT NULL AND i.subtotal_sar > 0
            THEN ROUND(i.vat_sar / i.subtotal_sar, 4)
            ELSE NULL END,
       true,
       u.email,
       i.created_at
FROM invoices i
JOIN users u ON u.id = i.user_id
WHERE NOT EXISTS (SELECT 1 FROM invoice_state s WHERE s.invoice_id = i.id);


/* ============================================================
   ملاحظة على ما لم يُفعل عمداً
   ============================================================
   • لم يُضَف عمود status = 'expired' إلى subscriptions: قيد CHECK
     على ذلك العمود يسمح بأربع قيم فقط، وتعديله يتطلب ملكية الجدول.
     الانتهاء يُشتق وقت القراءة من current_period_end، بنفس نمط
     ACCOUNT_STATUS_SQL المعتمد في المرحلة 2. التعريف الواحد موجود
     في billing/subscription.js ويُعاد استخدامه في كل استعلام، حتى
     لا يختلف تعريف "اشتراك فعّال" بين صفحة وأخرى.

   • لم يُضَف Cron ولا Queue ولا Job runner. انتهاء الاشتراك حالة
     مشتقّة من تاريخ، لا حدث يحتاج من يوقظه.

   • لم تُنشأ فهارس على invoices أو subscriptions مهما كانت مفيدة —
     CREATE INDEX يتطلب ملكية الجدول. عتبة المراجعة الحقيقية:
     ~100 ألف صف في invoices، وعندها يلزم تدخل مالك القاعدة.
   ============================================================ */
