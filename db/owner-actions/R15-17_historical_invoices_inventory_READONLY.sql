-- ============================================================
-- KANAF-ORD-0001 R15-17 — جرد الفواتير التاريخية (قراءة فقط)
--
-- يجيب عن حجم القرار D-03 دون لمس أي فاتورة: كم وثيقة صدرت قبل
-- 8 أغسطس 2026 (ملفات بحروف مقلوبة) وقبل 10 أغسطس 2026 (اسم بائع
-- ناقص)، وكم منها له لقطة بائع في invoice_state، وكم عليه إشعار دائن.
-- أعداد فقط — لا أسماء ولا بريد ولا مبالغ أفراد.
--
-- لا يعيد رسم أي وثيقة. أي معالجة (إعادة رسم بنفس الرقم والتاريخ، أو
-- إشعار دائن وفاتورة جديدة، أو إبقاء) قرار محاسبي نظامي للمالك (D-03).
--
--   psql "$DATABASE_URL" -f db/owner-actions/R15-17_historical_invoices_inventory_READONLY.sql
-- ============================================================
BEGIN TRANSACTION READ ONLY;

SELECT
  CASE
    WHEN i.zatca_issued_at <  TIMESTAMPTZ '2026-08-08 00:00+03' THEN '1) قبل 8 أغسطس (حروف مقلوبة محتملة + اسم ناقص)'
    WHEN i.zatca_issued_at <  TIMESTAMPTZ '2026-08-10 00:00+03' THEN '2) 8–9 أغسطس (اسم بائع ناقص محتمل)'
    ELSE                                                             '3) من 10 أغسطس فصاعداً'
  END                                                           AS period,
  count(*)                                                      AS invoices_issued,
  count(*) FILTER (WHERE i.pdf_data IS NOT NULL)                AS with_stored_pdf,
  count(*) FILTER (WHERE s.invoice_id IS NOT NULL)              AS with_seller_snapshot,
  count(*) FILTER (WHERE s.seller_legal_name = t.legal_name)    AS snapshot_matches_current_legal_name,
  count(*) FILTER (WHERE cn.id IS NOT NULL)                     AS with_credit_note,
  min(i.zatca_issued_at)::date                                  AS first_issued,
  max(i.zatca_issued_at)::date                                  AS last_issued
FROM invoices i
LEFT JOIN invoice_state s ON s.invoice_id = i.id
LEFT JOIN LATERAL (SELECT legal_name FROM tax_settings LIMIT 1) t ON true
LEFT JOIN LATERAL (SELECT id FROM credit_notes c WHERE c.original_invoice_id = i.id LIMIT 1) cn ON true
WHERE i.zatca_invoice_number IS NOT NULL
GROUP BY 1
ORDER BY 1;

ROLLBACK;
