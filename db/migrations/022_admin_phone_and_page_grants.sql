-- ============================================================
-- 022 — جوال حساب الإدارة ومنح الصفحات (KANAF-ORD-0013 §5)
--
-- admin_users صار مملوكاً لدور التطبيق على الإنتاج (مسبار ORD-0012، §2.2)،
-- فيُضاف العمودان إليه مباشرة. ولا شيء آخر: لا إعادة هيكلة لقيد role
-- ولا لجدول admin_role_assignments.
--
-- phone: صيغة E.164 (+ ثم 8 إلى 15 رقماً). اختياري.
-- page_grants: قائمة صفحات اللوحة الممنوحة للحساب — طبقة تضييق فوق دوره.
--   NULL = بلا تضييق (كل ما يسمح به الدور) — وهو حال كل حساب قائم، فلا
--   يتغيّر سلوك أحد بهذا الترحيل. المفاتيح يتحقق منها الخادم
--   (admin/permissions.js: PAGE_KEYS)، والقيد هنا يمنع القائمة الفارغة فقط:
--   حساب بلا أي صفحة حساب معطّل يُعطَّل بـactive لا بقائمة فارغة.
-- ============================================================
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS page_grants TEXT[];
ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_phone_e164;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_phone_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_page_grants_nonempty;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_page_grants_nonempty CHECK (page_grants IS NULL OR cardinality(page_grants) > 0);
