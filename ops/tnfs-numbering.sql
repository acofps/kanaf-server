-- ============================================================
-- ترقيم «تنفس» يبدأ من 1 — KANAF-ORD-0012 §6.5 (قرار المالك §1.10)
--
-- لا يُنفَّذ على الإنتاج إلا بيد المالك، بعد دمج rebrand/tanaffus، وفق RELEASE_RUNBOOK.md.
-- يُشغَّل عبر ops/tnfs-numbering.mjs (تجربة بلا أثر افتراضياً، و--apply للتثبيت)، وهو
-- الذي يلفّه في معاملة واحدة. لا BEGIN/COMMIT هنا عمداً.
--
-- ما يفعله (كله أو لا شيء):
--   1) البادئتان: TNFS-INV للفاتورة و TNFS-CN للإشعار الدائن، والرمز المشترك NULL
--      (القيد billing_settings_number_token_shape يرفض الفارغ '').
--   2) تسلسل الفواتير يُعاد بحيث يصدر التالي برقم 1: TNFS-INV-000001.
--
-- الفحص المسبق — إن خالف أيٌّ منها توقّف بلا أي تغيير (RAISE يُسقط المعاملة كلها):
--   • kanaf_invoice_number_seq عند 3 بالضبط ومُستعمَل (is_called) — كما قرأه الإنتاج (ORD-0012 §1.9).
--     أي قيمة أخرى = صدرت فاتورة بعد القراءة، أو القاعدة ليست ما نظن: يعود الأمر إلى المالك.
--   • kanaf_credit_note_number_seq لم يُستعمل بعد — فلا حاجة لإعادته ولا يُمسّ.
--     إن استُعمل: قرار جديد للمالك، لا يُتّخذ هنا.
--   • لا وثيقة تحمل TNFS- بعد — كي لا يصطدم الرقم 1 بوثيقة صادرة (UNIQUE).
--
-- ما لا يفعله: لا يمسّ أي فاتورة أو إشعار صادر (INV-KANAF-000001…3 تبقى كما هي)،
-- ولا zatca_*_seq القديمين، ولا شيئاً خارج الصف الواحد والتسلسل الواحد.
-- ============================================================
DO $tnfs$
DECLARE
  inv_last   bigint;
  inv_called boolean;
  cn_last    bigint;
  cn_called  boolean;
  tnfs_docs  int;
BEGIN
  -- يُقفل صف الإعداد كي لا يتزامن مع تعديل من اللوحة
  PERFORM 1 FROM billing_settings WHERE singleton = true FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TNFS-STOP billing_settings row is missing — nothing changed';
  END IF;

  SELECT last_value, is_called INTO inv_last, inv_called FROM kanaf_invoice_number_seq;
  IF NOT (inv_last = 3 AND inv_called) THEN
    RAISE EXCEPTION 'TNFS-STOP kanaf_invoice_number_seq is at % (is_called=%), expected 3 (true) — nothing changed', inv_last, inv_called;
  END IF;

  SELECT last_value, is_called INTO cn_last, cn_called FROM kanaf_credit_note_number_seq;
  IF cn_called THEN
    RAISE EXCEPTION 'TNFS-STOP kanaf_credit_note_number_seq has been used (last_value=%) — owner decision needed, nothing changed', cn_last;
  END IF;

  SELECT (SELECT count(*) FROM invoices WHERE zatca_invoice_number LIKE 'TNFS-%')
       + (SELECT count(*) FROM credit_notes WHERE zatca_credit_note_number LIKE 'TNFS-%')
    INTO tnfs_docs;
  IF tnfs_docs > 0 THEN
    RAISE EXCEPTION 'TNFS-STOP % document(s) already carry a TNFS- number — nothing changed', tnfs_docs;
  END IF;

  UPDATE billing_settings
     SET invoice_number_prefix     = 'TNFS-INV',
         credit_note_number_prefix = 'TNFS-CN',
         document_number_token     = NULL,
         updated_at                = now()
   WHERE singleton = true;

  -- ⚠️ setval لا يتراجع مع ROLLBACK (التسلسلات خارج المعاملات). لذا:
  --   • في التجربة (tnfs.dry_run = on) لا يُستدعى أصلاً — وإلا أعادت التجربة التسلسل إلى 1 وتراجعت
  --     البادئتان إلى INV/KANAF، فيصدر INV-KANAF-000001 مكرَّراً وتفشل كل فاتورة (مقيس في test-34).
  --   • وهو آخر جملة هنا، والمشغّل يُثبّت فوراً بعده ويُعيده إلى 3 إن فشل التثبيت.
  -- false = القيمة 1 لم تُستهلك بعد، فأول nextval يعيد 1
  IF coalesce(current_setting('tnfs.dry_run', true), 'off') <> 'on' THEN
    PERFORM setval('kanaf_invoice_number_seq', 1, false);
  END IF;
END
$tnfs$;
