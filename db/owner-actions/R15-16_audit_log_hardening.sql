-- ============================================================
-- R15-16 — جعل سجلات التدقيق إلحاقية فقط لدور التشغيل
-- KANAF-ORD-0001 · التصنيف: PRODUCTION_APPROVAL_REQUIRED
--
-- ⚠️ ليس ترحيلاً ولا يُشغَّل عبر db/migrate.js أو /api/setup:
--    يحتاج صلاحيات مالك القاعدة (postgres) لأن:
--      • admin_access_log يملكه postgres (من schema.sql).
--      • admin_action_log و content_versions يملكهما دور التطبيق نفسه
--        (أنشأهما الترحيلان 003 و 007)، ومالك الجدول يستطيع دائماً
--        إعادة منح نفسه الصلاحيات — فـREVOKE وحده لا يكفي؛ الملكية
--        تُنقل إلى دور منفصل لا يدخل.
--    يشغّله من يملك صلاحية postgres على الاستضافة (دعم Dimofinf أو
--    من يملك psql). المالك لا يملك محرر SQL على cPanel.
--
-- قبل التشغيل: نسخة احتياطية. استبدل :app_role باسم دور التطبيق
-- الفعلي (حسب الوثائق: kanaf_adel) — تحقق منه بـ SELECT current_user
-- من التطبيق، لا من الذاكرة.
--
-- ما لا يضمنه: من يملك postgres يستطيع التراجع عن كل هذا. هذا فصل
-- صلاحيات بين التطبيق والسجل، لا «سجل غير قابل للعبث» مطلقاً.
-- التراجع: الملف R15-16_audit_log_hardening_ROLLBACK.sql بجانبه.
-- اختُبر على قاعدة معزولة: test-support/audit-hardening-check.mjs
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kanaf_audit_owner') THEN
    CREATE ROLE kanaf_audit_owner NOLOGIN NOINHERIT;
  END IF;
END $$;

-- 1) admin_access_log (يملكه postgres): سحب التعديل والحذف من التطبيق
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON admin_access_log FROM :app_role;
GRANT SELECT, INSERT ON admin_access_log TO :app_role;

-- 2) admin_action_log و content_versions (يملكهما التطبيق): نقل الملكية
ALTER TABLE admin_action_log OWNER TO kanaf_audit_owner;
ALTER TABLE content_versions OWNER TO kanaf_audit_owner;
REVOKE ALL ON admin_action_log, content_versions FROM :app_role;
GRANT SELECT, INSERT ON admin_action_log, content_versions TO :app_role;

COMMIT;

-- تحقق بعده (كدور التطبيق): يجب أن تفشل الثلاث برسالة permission denied
--   UPDATE admin_action_log SET reason = reason WHERE false;
--   DELETE FROM admin_access_log WHERE false;
--   TRUNCATE content_versions;
