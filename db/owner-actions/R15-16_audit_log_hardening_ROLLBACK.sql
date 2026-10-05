-- تراجع R15-16 — يعيد الصلاحيات والملكية كما كانت قبل التقوية.
-- PRODUCTION_APPROVAL_REQUIRED · بصلاحية postgres · استبدل :app_role
\set ON_ERROR_STOP on
BEGIN;
GRANT UPDATE, DELETE ON admin_access_log TO :app_role;
ALTER TABLE admin_action_log OWNER TO :app_role;
ALTER TABLE content_versions OWNER TO :app_role;
COMMIT;
