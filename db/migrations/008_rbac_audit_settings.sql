-- 008_rbac_audit_settings.sql
-- المرحلة 5: الأدوار والصلاحيات، وسجل التدقيق، والإعدادات المركزية.
--
-- يُطبَّق بـ:  node -e "import('./db/migrate.js').then(async m=>{console.log(await m.runMigrations());process.exit(0)})"
-- آمن لإعادة التشغيل: كل عبارة فيه IF NOT EXISTS أو مكافئها.

/* ============================================================
   1) الأدوار — ولماذا في جدول جديد لا في admin_users

   المرحلة 5 تطلب دور محاسب يرى المال ولا يرى البيانات النفسية.
   والطريق المباشر — إضافة 'accountant' إلى admin_users.role —
   مغلق بقيد ملكية قاعدة البيانات نفسه الذي يحكم المشروع منذ
   7 أغسطس:

     admin_users أحد الجداول الخمسة عشر الأصلية التي يملكها
     المستخدم الفائق postgres، وعمود role عليه:

       CHECK (role IN ('support','content_manager','admin','owner'))

     وتوسيع القيد يحتاج ALTER TABLE، فيرد:
       ERROR: must be owner of relation admin_users

   وهذه ليست عقبة عابرة: أي دور يُطلب مستقبلاً سيصطدم بها من جديد.

   الحل هو نفس النمط الذي حلّ به المشروع تعليق الحسابات في
   الترحيل 003: حقل جديد لكيان قائم يذهب إلى جدول جديد يملكه
   التطبيق. هناك كان user_auth_state لجدول users، وهنا
   admin_role_assignments لجدول admin_users.

   ------------------------------------------------------------
   الدور الفعلي = COALESCE(هذا الجدول، admin_users.role)
   ------------------------------------------------------------
   وترتيب الاحتياط مقصود في الاتجاه الآمن: حساب المحاسب يُكتب في
   admin_users.role بقيمة 'support' — أضعف دور يقبله القيد —
   وترقيته إلى 'accountant' تأتي من هذا الجدول وحده. فلو ضاع صف
   الإسناد لأي سبب، يسقط الحساب إلى **أقل** صلاحية لا إلى أكثرها.

   لا مفتاح أجنبي إلى admin_users: صلاحية REFERENCES على ذلك
   الجدول غير مؤكدة لـkanaf_adel — نفس السبب المكتوب في الترحيل
   003 حرفياً. المعرّف يأتي دائماً من صف موجود يقرؤه الخادم قبل
   الكتابة، والقيد الفريد أدناه يمنع تعدد الإسنادات للحساب الواحد.
   ============================================================ */

CREATE TABLE IF NOT EXISTS admin_role_assignments (
  admin_user_id  UUID PRIMARY KEY,
  role           TEXT NOT NULL
                 CHECK (role IN ('support', 'content_manager', 'accountant', 'admin', 'owner')),
  -- من أسند الدور ومتى. سجل التدقيق يحمل التفاصيل، وهذان هنا
  -- ليُقرأ "الدور الحالي ومن منحه" باستعلام واحد بلا مسح السجل.
  assigned_by    UUID,
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  note           TEXT
);

/* الأدوار المسموح بها كلها في مكان واحد يقرؤه الخادم — بدل قائمة
   مكرّرة في الكود تختلف عن القيد يوماً ما. */
COMMENT ON TABLE admin_role_assignments IS
  'الدور الفعلي للمسؤول. يعلو على admin_users.role الذي لا يمكن توسيع قيده (جدول يملكه postgres).';

/* ============================================================
   2) سجل التدقيق — الكيان الذي وقع عليه الفعل

   admin_action_log أنشأه الترحيل 003 فيملكه التطبيق، وALTER عليه
   مسموح — بخلاف admin_access_log الذي يملكه postgres ولا يقبل
   عموداً جديداً أبداً.

   العطب الذي يُصلحه هذا القسم: الجدول يعرف "على أي **مستخدم**"
   وقع الفعل عبر target_user_id، ولا يعرف شيئاً عن أي كيان آخر.
   فتعديل سعر باقة، وتغيير الرقم الضريبي، وترقية مسؤول إلى مالك —
   كلها تُكتب بـtarget_user_id = NULL، ولا يبقى ما يميّز بينها إلا
   نص action وحقل metadata غير منظّم لا يمكن الفلترة عليه.

   والأسوأ أن target_user_id له مفتاح أجنبي إلى users، فمعرّف
   **مسؤول** لا يمكن وضعه فيه أصلاً — وهو بالضبط العطب الذي أوقف
   الاسترداد في المرحلة 3 حين وُضع معرّف دفعة في هذا العمود.

   entity_id نصّي بلا مفتاح أجنبي عمداً: الكيانات المُدقَّقة أنواع
   مختلفة (UUID مسؤول، مفتاح باقة، مفتاح محتوى، 'singleton'
   للإعداد المفرد)، وعمود واحد بمفتاح أجنبي واحد لا يسعها.
   ============================================================ */

ALTER TABLE admin_action_log ADD COLUMN IF NOT EXISTS entity    TEXT;
ALTER TABLE admin_action_log ADD COLUMN IF NOT EXISTS entity_id TEXT;

/* ملء أثري للصفوف السابقة: كل صف يحمل target_user_id كان — بحكم
   المسارات الموجودة وقتها — فعلاً على مستخدم. الصفوف الأخرى تُترك
   NULL ولا تُخمَّن: سجل تدقيق يُملأ بالاستنتاج أسوأ من سجل ناقص. */
UPDATE admin_action_log
   SET entity = 'user', entity_id = target_user_id::text
 WHERE entity IS NULL AND target_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_action_log_entity
  ON admin_action_log (entity, entity_id, created_at DESC);

/* فهرس زمني عام — صفحة سجل التدقيق تقرأ بالأحدث بلا فلتر، وبدونه
   يمسح الجدول كاملاً كلما فُتحت. */
CREATE INDEX IF NOT EXISTS idx_admin_action_log_created
  ON admin_action_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_action_log_action
  ON admin_action_log (action, created_at DESC);

/* ============================================================
   3) الإعدادات المركزية غير المالية

   الإعدادات المالية لها مصدر حقيقة واحد بالفعل (billing_settings
   من الترحيل 004)، والبيانات الضريبية في tax_settings. الناقص هو
   إعدادات التشغيل التي لم يكن لها بيت: بيانات التواصل والدعم،
   ومفاتيح تشغيل عامة.

   جدول مفاتيح/قيم لا أعمدة ثابتة، لسبب واحد: كل إعداد جديد بعمود
   جديد يعني ترحيلاً جديداً، وقد أثبت هذا المشروع أن الترحيل الذي
   يُنسى تشغيله يترك ميزة تبدو موجودة وهي ليست كذلك (الترحيل 006).

   القيمة JSONB لا TEXT حتى يحمل الإعداد نوعه معه؛ ونصّ الإعداد
   المعروض للمستخدم يُقرأ من هنا مرة واحدة، فلا تتكرر قيمة واحدة
   في ملفين يختلفان يوماً ما.
   ============================================================ */

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  -- تصنيف يُستخدم للعرض والصلاحية معاً: إعداد 'support' يراه
  -- الدعم، وإعداد 'security' لا يراه إلا المالك.
  category    TEXT NOT NULL DEFAULT 'general'
              CHECK (category IN ('general', 'support', 'notifications', 'security')),
  description TEXT,
  updated_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* القيم الابتدائية — تُكتب مرة واحدة ولا تُدهس عند إعادة التشغيل،
   حتى لا يمحو ترحيلٌ مُعاد ما عدّله المالك من اللوحة. */
INSERT INTO app_settings (key, value, category, description) VALUES
  ('support_email',        '"support@kanaf.me"'::jsonb,  'support',
   'البريد المعروض للمستخدم للتواصل مع الدعم'),
  ('support_hours',        '"الأحد إلى الخميس، 9 صباحاً إلى 5 مساءً بتوقيت الرياض"'::jsonb, 'support',
   'أوقات العمل المعلنة'),
  ('app_public_name',      '"كنف"'::jsonb,               'general',
   'الاسم التجاري المعروض في الرسائل والوثائق'),
  ('marketing_email_footer', '"وصلتك هذه الرسالة لأنك مسجّل في كنف."'::jsonb, 'notifications',
   'تذييل رسائل البث التسويقي'),
  ('admin_session_minutes', '15'::jsonb,                 'security',
   'عمر رمز الوصول الإداري بالدقائق — للعرض فقط؛ القيمة السارية من ADMIN_JWT_EXPIRES_IN')
ON CONFLICT (key) DO NOTHING;

/* ============================================================
   4) فهارس التقارير والتصدير

   ⚠️ لا فهرس هنا على invoices أو subscriptions أو users — الثلاثة
   من الجداول الأصلية التي يملكها postgres، وCREATE INDEX عليها
   يفشل بنفس خطأ ALTER. المذكور أدناه كله على جداول أنشأها
   التطبيق (الترحيل 004 وما بعده).

   السبب في وجودها أصلاً: تصدير المدفوعات يفلتر بتاريخ التحصيل،
   وتقرير المؤشرات يجمع على نفس العمود. بلا فهرس يمسح الجدول
   كاملاً في كل مرة، وهو مقبول اليوم وغير مقبول بعد سنة.
   ============================================================ */

CREATE INDEX IF NOT EXISTS idx_payments_captured
  ON payments (COALESCE(captured_at, created_at) DESC);

CREATE INDEX IF NOT EXISTS idx_payments_status_captured
  ON payments (status, COALESCE(captured_at, created_at) DESC);

CREATE INDEX IF NOT EXISTS idx_refunds_created
  ON refunds (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_refunds_status_created
  ON refunds (status, created_at DESC);

/* ============================================================
   5) تشديد سجل التدقيق — خطوة يملكها مالك القاعدة وحده

   admin_access_log و admin_action_log سجلان يُكتب فيهما ولا
   يُعدَّلان: لا يوجد في المستودع كله دالة تحديث أو حذف لأي منهما،
   وهذا مكتوب في تعليق admin/middleware.js وفي schema.sql.

   لكن "لا يوجد كود يفعلها" ليس "لا يمكن أن تُفعل". المسافة بينهما
   هي بالضبط ما يجعل سجل التدقيق دليلاً أو مجرد قائمة. والتشديد
   الحقيقي عبارتان لا يملكهما هذا التطبيق:

     REVOKE UPDATE, DELETE ON admin_access_log FROM kanaf_adel;
     REVOKE UPDATE, DELETE ON admin_action_log FROM kanaf_adel;

   الأولى تحتاج postgres لأنه مالك الجدول. والثانية يملكها
   kanaf_adel نفسه — ومن يملك الجدول يقدر أن يعيد منح نفسه
   الصلاحية، فالسحب الذاتي لا يعني شيئاً أمنياً. لذلك لا تُنفَّذان
   هنا: عبارة تبدو تشديداً وهي ليست كذلك أسوأ من غيابها.

   الخطوة موثقة كبند مفتوح (12.19)، وتُنفَّذ من حساب postgres.
   ============================================================ */
