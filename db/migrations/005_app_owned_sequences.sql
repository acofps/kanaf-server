-- 005_app_owned_sequences.sql
--
-- تسلسلات أرقام الوثائق القانونية، مملوكة للتطبيق.
--
-- Safe to run more than once. Apply with: node db/migrate.js
--
-- ============================================================
-- السبب — عطب حقيقي ظهر على الإنتاج بعد أول دفعة ناجحة
-- ============================================================
-- التسلسلان zatca_invoice_number_seq و zatca_credit_note_number_seq
-- أُنشئا في schema.sql تحت المستخدم الفائق `postgres`، والتطبيق
-- يتصل كـ`kanaf_adel`. النتيجة على الإنتاج:
--
--   ERROR: permission denied for sequence zatca_invoice_number_seq
--
-- قيد الملكية الموثّق منذ الترحيل 002 كان يُقرأ دائماً على أنه
-- يخص الجداول (ALTER TABLE و CREATE INDEX). وهو يشمل **التسلسلات**
-- أيضاً — وهذا ما فات على الترحيل 004 وعلى كل مراجعة قبله، لأن
-- بيئة الاختبار يملك فيها مستخدم واحد كل شيء فلا يظهر الفرق.
--
-- الحل هنا هو نفس مبدأ الترحيل 004 حرفياً: ما لا نملكه لا نحاول
-- تعديله ولا نطلب من مالك القاعدة تعديله — ننشئ بديلاً نملكه.
-- CREATE SEQUENCE مسموح للتطبيق (أنشأ ستة جداول في 004 بنجاح).
--
-- البديل: طلب GRANT USAGE من مزوّد الاستضافة. مرفوض لأنه يجعل
-- تشغيل النظام معتمداً على تدخل طرف خارجي عند كل بيئة جديدة، وقد
-- يُنسى فيظهر العطب نفسه بعد أول عملية دفع حقيقية.
--
-- ⚠️ التسلسلان القديمان يبقيان في القاعدة بلا استخدام. لا نحذفهما
-- (لا نملكهما أصلاً)، ولا ضرر منهما.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS kanaf_invoice_number_seq     START 1;
CREATE SEQUENCE IF NOT EXISTS kanaf_credit_note_number_seq START 1;

/* ------------------------------------------------------------
   المزامنة مع ما صدر فعلاً.

   لو كانت أي فاتورة قد صدرت برقم من التسلسل القديم، يبدأ الجديد
   بعد أعلى رقم موجود — فلا يتكرر رقم فاتورة قانوني أبداً.

   يقرأ الأرقام من الوثائق نفسها لا من التسلسل القديم، لأن قراءة
   التسلسل القديم تحتاج نفس الصلاحية المفقودة.
   ------------------------------------------------------------ */
DO $$
DECLARE
  max_invoice     BIGINT := 0;
  max_credit_note BIGINT := 0;
BEGIN
  SELECT COALESCE(MAX((regexp_match(zatca_invoice_number, '([0-9]+)$'))[1]::BIGINT), 0)
    INTO max_invoice
    FROM invoices
   WHERE zatca_invoice_number IS NOT NULL;

  SELECT COALESCE(MAX((regexp_match(zatca_credit_note_number, '([0-9]+)$'))[1]::BIGINT), 0)
    INTO max_credit_note
    FROM credit_notes
   WHERE zatca_credit_note_number IS NOT NULL;

  -- is_called = false يعني أن أول nextval يعيد هذه القيمة بالضبط.
  PERFORM setval('kanaf_invoice_number_seq',     max_invoice + 1,     false);
  PERFORM setval('kanaf_credit_note_number_seq', max_credit_note + 1, false);

  RAISE NOTICE 'kanaf_invoice_number_seq يبدأ من %، و kanaf_credit_note_number_seq من %',
    max_invoice + 1, max_credit_note + 1;
END $$;
