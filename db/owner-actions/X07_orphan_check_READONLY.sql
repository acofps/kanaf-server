-- ============================================================
-- KANAF-ORD-0001 X07 — فحص السجلات اليتيمة (قراءة فقط)
--
-- الأعمدة أدناه مراجع منطقية بلا FOREIGN KEY: الجداول التي تحملها
-- يملكها دور التشغيل، والجداول المشار إليها (payments/invoices/...)
-- يملكها postgres ولا يملك دور التشغيل عليها REFERENCES (عدا users).
-- فالقاعدة لا تمنع اليتيم، وهذا الفحص يكشفه.
--
-- يعطي أعداداً فقط — لا صفوف ولا بيانات مستخدم. لا يحذف ولا يعدّل:
-- المعاملة READ ONLY وتنتهي بـROLLBACK. أي عدد > 0 يُعرض على المالك
-- قبل أي معالجة؛ لا حذف تلقائي لسجل مالي حقيقي.
--
--   psql "$DATABASE_URL" -f db/owner-actions/X07_orphan_check_READONLY.sql
-- ============================================================
BEGIN TRANSACTION READ ONLY;

SELECT check_name, orphans FROM (
  SELECT 'payments.invoice_id → invoices' AS check_name,
         count(*) FILTER (WHERE p.invoice_id IS NOT NULL AND i.id IS NULL) AS orphans
    FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
  UNION ALL
  SELECT 'payments.subscription_id → subscriptions',
         count(*) FILTER (WHERE p.subscription_id IS NOT NULL AND s.id IS NULL)
    FROM payments p LEFT JOIN subscriptions s ON s.id = p.subscription_id
  UNION ALL
  SELECT 'refunds.payment_id → payments',
         count(*) FILTER (WHERE r.payment_id IS NOT NULL AND p.id IS NULL)
    FROM refunds r LEFT JOIN payments p ON p.id = r.payment_id
  UNION ALL
  SELECT 'refunds.invoice_id → invoices',
         count(*) FILTER (WHERE r.invoice_id IS NOT NULL AND i.id IS NULL)
    FROM refunds r LEFT JOIN invoices i ON i.id = r.invoice_id
  UNION ALL
  SELECT 'refunds.credit_note_id → credit_notes',
         count(*) FILTER (WHERE r.credit_note_id IS NOT NULL AND c.id IS NULL)
    FROM refunds r LEFT JOIN credit_notes c ON c.id = r.credit_note_id
  UNION ALL
  SELECT 'refunds.admin_user_id → admin_users',
         count(*) FILTER (WHERE r.admin_user_id IS NOT NULL AND a.id IS NULL)
    FROM refunds r LEFT JOIN admin_users a ON a.id = r.admin_user_id
  UNION ALL
  SELECT 'invoice_state.invoice_id → invoices',
         count(*) FILTER (WHERE i.id IS NULL)
    FROM invoice_state x LEFT JOIN invoices i ON i.id = x.invoice_id
  UNION ALL
  SELECT 'subscription_state.subscription_id → subscriptions',
         count(*) FILTER (WHERE x.subscription_id IS NOT NULL AND s.id IS NULL)
    FROM subscription_state x LEFT JOIN subscriptions s ON s.id = x.subscription_id
  UNION ALL
  SELECT 'subscription_state.last_invoice_id → invoices',
         count(*) FILTER (WHERE x.last_invoice_id IS NOT NULL AND i.id IS NULL)
    FROM subscription_state x LEFT JOIN invoices i ON i.id = x.last_invoice_id
  UNION ALL
  SELECT 'subscription_state.last_payment_id → payments',
         count(*) FILTER (WHERE x.last_payment_id IS NOT NULL AND p.id IS NULL)
    FROM subscription_state x LEFT JOIN payments p ON p.id = x.last_payment_id
  UNION ALL
  SELECT 'admin_role_assignments.admin_user_id → admin_users',
         count(*) FILTER (WHERE a.id IS NULL)
    FROM admin_role_assignments x LEFT JOIN admin_users a ON a.id = x.admin_user_id
  UNION ALL
  SELECT 'admin_auth_state.admin_user_id → admin_users',
         count(*) FILTER (WHERE a.id IS NULL)
    FROM admin_auth_state x LEFT JOIN admin_users a ON a.id = x.admin_user_id
  UNION ALL
  SELECT 'admin_setup_tokens.admin_user_id → admin_users',
         count(*) FILTER (WHERE x.admin_user_id IS NOT NULL AND a.id IS NULL)
    FROM admin_setup_tokens x LEFT JOIN admin_users a ON a.id = x.admin_user_id
  UNION ALL
  SELECT 'admin_action_log.admin_user_id → admin_users (مقبول بعد حذف مدير: السجل يبقى)',
         count(*) FILTER (WHERE x.admin_user_id IS NOT NULL AND a.id IS NULL)
    FROM admin_action_log x LEFT JOIN admin_users a ON a.id = x.admin_user_id
  UNION ALL
  SELECT 'account_deletion_requests.user_id → users (مقبول: بلا FK عمداً حتى يبقى أثر الطلب)',
         count(*) FILTER (WHERE u.id IS NULL)
    FROM account_deletion_requests x LEFT JOIN users u ON u.id = x.user_id
  UNION ALL
  SELECT 'invoices.plan_id → subscription_plans',
         count(*) FILTER (WHERE i.plan_id IS NOT NULL AND sp.id IS NULL)
    FROM invoices i LEFT JOIN subscription_plans sp ON sp.plan_key = i.plan_id
  UNION ALL
  SELECT 'subscriptions.plan_id → subscription_plans',
         count(*) FILTER (WHERE s.plan_id IS NOT NULL AND sp.id IS NULL)
    FROM subscriptions s LEFT JOIN subscription_plans sp ON sp.plan_key = s.plan_id
) t ORDER BY orphans DESC, check_name;

ROLLBACK;
