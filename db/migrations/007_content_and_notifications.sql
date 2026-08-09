-- 007_content_and_notifications.sql
--
-- المرحلة 4: المحتوى والإشعارات والبيانات التشغيلية للمستخدم.
--
-- Safe to run more than once. Apply with:  node db/migrate.js
--
-- ============================================================
-- لماذا هذا الترحيل موجود
-- ============================================================
-- ثلاث حلقات مغلقة اكتُشفت في فحص المرحلة 4:
--
-- 1. المحتوى: جدول content_items موجود منذ schema.sql ولا يحوي صفاً
--    واحداً — لا INSERT له في المستودع كله. صفحة المحتوى في اللوحة
--    تقرأ جدولاً فارغاً، والتطبيق يقرأ ثوابت JS مضمّنة في حزمته
--    (JOURNEY_LAUNCH_CONFIG / OVERLAY_LAUNCH_CONFIG /
--    NOTEBOOK_LAUNCH_CONFIG). أي أن "إدارة المحتوى" لم تكن موصولة
--    من أي طرف. هذا الترحيل يبذر الجدول بالمحتوى الفعلي المشحون في
--    التطبيق (64 عنصراً) ليصير للوحة ما تديره فعلاً.
--
-- 2. الإشعارات: القناة الوحيدة الحقيقية كانت بريداً جماعياً، وجرس
--    الإشعارات داخل التطبيق حالة React محلية تضيع مع تحديث الصفحة.
--    ولا يوجد أي سجل حالة تسليم — broadcast_notifications يخزن
--    عدّادين فقط بلا صف لكل مستلم ولا سبب فشل.
--
-- 3. البيانات التشغيلية: لا مسار كتابة لأي شيء يفعله المستخدم —
--    لا يوميات ولا فرز ولا تقدّم رحلات ولا دفاتر. daily_logs و
--    screenings موجودان في المخطط بلا كاتب منذ اليوم الأول.
--
-- ============================================================
-- قيد الملكية — يُراعى في كل سطر أدناه
-- ============================================================
-- الجداول الخمسة عشر الأصلية يملكها المستخدم الفائق postgres،
-- والتطبيق يتصل كـkanaf_adel. المسموح: SELECT/INSERT/UPDATE/DELETE
-- على كل شيء، وREFERENCES على users، وCREATE TABLE/SEQUENCE.
-- الممنوع: ALTER TABLE وCREATE INDEX على الجداول الأصلية، وnextval
-- على التسلسلات الأصلية.
--
-- لذلك هنا:
--   • لا ALTER TABLE ولا CREATE INDEX على أي جدول أصلي.
--   • content_items يُبذر بـINSERT فقط (مسموح) — وكل حقل عرض جديد
--     يذهب إلى جدول جديد منفصل (content_presentation).
--   • لا مفتاح أجنبي إلى content_items ولا إلى admin_users:
--     REFERENCES عليهما غير مؤكَّد لـkanaf_adel، وترحيل قد يسقط على
--     فحص صلاحية أسوأ من جدول بلا FK. نفس سابقة الترحيل 003.
--     الربط بـ(content_type, content_key) وهو فريد أصلاً.
--   • REFERENCES users مستخدَم بحرية — مؤكَّد ✅.
--
-- ⚠️ ترتيب الملفات في مشغّل الترحيل بالاسم: "007_" يسبق "DB006_"
-- (الرقم قبل الحرف في ASCII). لا ضرر هنا لأن هذا الترحيل لا يعتمد
-- على DB006 إطلاقاً، لكن انتبه لها في أي ترحيل قادم.
-- ============================================================


/* ============================================================
   الجزء 1 — كتالوج المحتوى
   ============================================================ */

/* ------------------------------------------------------------
   1.1  بذر content_items بالمحتوى المشحون فعلاً في التطبيق.

   64 عنصراً: 18 رحلة + 8 تراكبات سياقية + 29 دفتراً + 4 أدوات
   معرفية سلوكية + 5 مقالات مكتبة. المفاتيح مستخرجة حرفياً من
   wellness-companion.jsx (journey_key / overlay_key / template_key
   / CBT_TOOLS[].id)، فأي خطأ إملائي في مفتاح يعني عنصراً لا يظهر —
   وهذا مقصود: التطابق يُختبر لا يُفترض.

   الحالة الابتدائية: review_required + launch_enabled = false.
   أي **مسودة**. وهذا هو الصواب لا التحفّظ:
   المحتوى في التطبيق اليوم كله clinical_review_status = "review_required"
   ودوال canEnrollInJourney / canOpenNotebook ترفض أي شيء غير
   "approved" — أي أن كل الرحلات والدفاتر معروضة وغير قابلة للفتح
   أصلاً. البذر بهذه الحالة يصف الواقع بصدق، والنشر يصير فعلاً
   إدارياً حقيقياً له صاحب ووقت وسجل.

   للنشر الجماعي بعد المراجعة: POST /admin/content/bulk-publish
   ------------------------------------------------------------ */

/* ------------------------------------------------------------
   1.2  الطبقات (free/plus) مستخرَجة آلياً من التطبيق لا مكتوبة يدوياً.

   ⚠️ درس: أول نسخة من هذا البذر كُتبت من استخراج بتعبير نمطي يشترط
   ورود subscription_tier في أول السطر. ثمانية تراكبات وخمسة
   وعشرون دفتراً وعشر رحلات تكتب الحقل **داخل سطر مشترك**، فلم
   يطابقها التعبير فسقطت إلى القيمة الافتراضية 'free'. النتيجة
   كانت ستكون: 45 عنصراً من كنف+ تصير مجانية على الإنتاج، لأن
   الخادم يتقدّم على القيمة المضمّنة في التطبيق.

   القيم أدناه تطابق `wellness-companion.jsx` عنصراً بعنصر:
     • رحلة مجانية واحدة  : reactivate_your_day
     • كل التراكبات        : كنف+
     • أربعة دفاتر مجانية  : need_right_now · understand_emotion ·
                             difficult_decision · realistic_gratitude
     • أدوات كنف           : solve_problem كنف+، والثلاث الباقية مجانية
                             (النسخة العميقة من check_thought تُفرض
                              داخل التطبيق عبر CBT_ENTITLEMENTS)
     • المكتبة             : مجانية

   وهو مطابق تماماً لنموذج التسعير في وثيقة حالة المشروع.
   `ROOT-test-content-notifications.mjs` يتحقق من هذا التطابق آلياً
   بدل الاعتماد على إعادة كتابة يدوية.
   ------------------------------------------------------------ */

/* ------------------------------------------------------------
   لماذا CTE ولا جدول مؤقّت.

   النسخة الأولى استخدمت CREATE TEMP TABLE ... ON COMMIT DROP.
   داخل مشغّل الترحيل (الذي يلفّ كل ملف في معاملة) تعمل صحيحة —
   لكن تشغيل الملف بـpsql مباشرة يعني أن كل عبارة معاملة مستقلة،
   فيُحذف الجدول المؤقّت فور إنشائه، وتفشل عبارات البذر الثلاث،
   **ويخرج psql بالرمز 0** بلا ON_ERROR_STOP. النتيجة: كل الجداول
   تُنشأ وصفر محتوى، وهو فشل لا يُميَّز عن النجاح إلا حين يقرأ
   الكتالوج فارغاً.

   الـCTE لا يعتمد على حدود المعاملة إطلاقاً.
   ------------------------------------------------------------ */

WITH seed (content_type, content_key, title, category, subscription_tier, display_order) AS (
  VALUES
    ('journey', 'reactivate_your_day', 'استعادة النشاط', 'energy', 'free', 1),
    ('journey', 'break_the_thought_loop', 'الخروج من دوامة التفكير', 'anxiety_thinking', 'plus', 2),
    ('journey', 'organize_daily_anxiety', 'تنظيم القلق اليومي', 'anxiety_thinking', 'plus', 3),
    ('journey', 'balanced_sleep', 'نوم أكثر اتزاناً', 'sleep', 'plus', 4),
    ('journey', 'inner_critic', 'التعامل مع الناقد الداخلي', 'emotions_self', 'plus', 5),
    ('journey', 'solve_problem_step_by_step', 'حل المشكلات خطوة بخطوة', 'decisions_problems', 'plus', 6),
    ('journey', 'understand_your_emotions', 'افهم مشاعرك', 'emotions_self', 'plus', 7),
    ('journey', 'handling_strong_emotions', 'التعامل مع المشاعر القوية', 'emotions_self', 'plus', 8),
    ('journey', 'start_despite_procrastination', 'ابدأ رغم التسويف', 'change_direction', 'plus', 9),
    ('journey', 'clearer_boundaries', 'حدود أكثر وضوحاً', 'relationships_boundaries', 'plus', 10),
    ('journey', 'communicate_better', 'تواصل بصورة أفضل', 'relationships_boundaries', 'plus', 11),
    ('journey', 'getting_closer_to_others', 'الاقتراب من الآخرين', 'relationships_boundaries', 'plus', 12),
    ('journey', 'adapt_to_change', 'التكيف مع التغيير', 'change_direction', 'plus', 13),
    ('journey', 'live_what_matters', 'عِش ما يهمك', 'change_direction', 'plus', 14),
    ('journey', 'be_kinder_to_yourself', 'كن أرفق بنفسك', 'emotions_self', 'plus', 15),
    ('journey', 'maintain_what_helps', 'المحافظة على ما نفعك', 'help_maintenance', 'plus', 16),
    ('journey', 'prepare_to_seek_help', 'الاستعداد لطلب المساعدة', 'specialist_prep', 'plus', 17),
    ('journey', 'benefit_from_your_session', 'استفد من جلستك النفسية', 'specialist_prep', 'plus', 18),
    ('overlay', 'work_pressure', 'ضغط العمل', 'context_overlay', 'plus', 1),
    ('overlay', 'work_life_balance', 'التوازن بين العمل والحياة', 'context_overlay', 'plus', 2),
    ('overlay', 'study_exam_stress', 'ضغوط الدراسة والاختبارات', 'context_overlay', 'plus', 3),
    ('overlay', 'moving_transition', 'الانتقال إلى وظيفة أو مدينة جديدة', 'context_overlay', 'plus', 4),
    ('overlay', 'marriage_prep', 'الاستعداد للزواج', 'context_overlay', 'plus', 5),
    ('overlay', 'parenting_pressure', 'ضغوط الوالدية', 'context_overlay', 'plus', 6),
    ('overlay', 'caregiver_support', 'دعم مقدمي الرعاية', 'context_overlay', 'plus', 7),
    ('overlay', 'retirement_role_change', 'التقاعد وتغيّر الأدوار', 'context_overlay', 'plus', 8),
    ('notebook', 'need_right_now', 'ما الذي أحتاجه الآن؟', 'self_emotions', 'free', 1),
    ('notebook', 'understand_emotion', 'افهم شعورك', 'self_emotions', 'free', 2),
    ('notebook', 'difficult_decision', 'قرار يحيّرني', 'decisions_problems', 'free', 3),
    ('notebook', 'realistic_gratitude', 'امتنان واقعي', 'kindness_growth', 'free', 4),
    ('notebook', 'unresolved_situation', 'موقف لم أتجاوزه', 'self_emotions', 'plus', 5),
    ('notebook', 'daily_drain', 'ما الذي استنزفني اليوم؟', 'self_emotions', 'plus', 6),
    ('notebook', 'did_despite_difficulty', 'شيء فعلته رغم صعوبته', 'self_emotions', 'plus', 7),
    ('notebook', 'inner_critic_voice', 'صوت الناقد الداخلي', 'self_emotions', 'plus', 8),
    ('notebook', 'what_am_i_avoiding', 'ماذا أحاول تجنبه؟', 'self_emotions', 'plus', 9),
    ('notebook', 'problem_to_sort', 'مشكلة تحتاج ترتيباً', 'decisions_problems', 'plus', 10),
    ('notebook', 'circle_of_influence', 'ما الذي يقع ضمن سيطرتي؟', 'decisions_problems', 'plus', 11),
    ('notebook', 'worst_case_realistic_plan', 'أسوأ احتمال والخطة الواقعية', 'decisions_problems', 'plus', 12),
    ('notebook', 'next_small_step', 'خطوتي الصغيرة القادمة', 'decisions_problems', 'plus', 13),
    ('notebook', 'unsaid_words', 'كلام لم أقله', 'relationships_boundaries', 'plus', 14),
    ('notebook', 'boundary_needed', 'حد أحتاج إلى وضعه', 'relationships_boundaries', 'plus', 15),
    ('notebook', 'prepare_conversation', 'محادثة أحتاج إلى الاستعداد لها', 'relationships_boundaries', 'plus', 16),
    ('notebook', 'relationship_needs', 'ما الذي أحتاجه من هذه العلاقة؟', 'relationships_boundaries', 'plus', 17),
    ('notebook', 'felt_misunderstood', 'موقف شعرت فيه أنني غير مفهوم', 'relationships_boundaries', 'plus', 18),
    ('notebook', 'letter_not_sent', 'رسالة لن أرسلها', 'relationships_boundaries', 'plus', 19),
    ('notebook', 'advice_to_loved_one', 'ماذا سأقول لشخص أحبه؟', 'kindness_growth', 'plus', 20),
    ('notebook', 'self_forgiveness', 'أمر أحتاج أن أتعامل معه برفق', 'kindness_growth', 'plus', 21),
    ('notebook', 'learned_about_self', 'ما الذي تعلمته عن نفسي؟', 'kindness_growth', 'plus', 22),
    ('notebook', 'value_to_live', 'قيمة أريد أن أعيشها', 'kindness_growth', 'plus', 23),
    ('notebook', 'better_than_expected', 'ما الذي سار أفضل مما توقعت؟', 'kindness_growth', 'plus', 24),
    ('notebook', 'before_specialist_visit', 'قبل لقائي بالمختص', 'specialist_prep', 'plus', 25),
    ('notebook', 'after_therapy_session', 'بعد الجلسة النفسية', 'specialist_prep', 'plus', 26),
    ('notebook', 'questions_for_specialist', 'أسئلة أريد طرحها', 'specialist_prep', 'plus', 27),
    ('notebook', 'since_last_session', 'ما الذي تغيّر منذ الجلسة الماضية؟', 'specialist_prep', 'plus', 28),
    ('notebook', 'what_did_not_fit', 'ما الذي جربته ولم يناسبني؟', 'specialist_prep', 'plus', 29),
    ('cbt_tool', 'understand_cycle', 'افهم الحلقة', 'cbt', 'free', 1),
    ('cbt_tool', 'check_thought', 'افحص الفكرة', 'cbt', 'free', 2),
    ('cbt_tool', 'activate_day', 'نشّط يومك', 'cbt', 'free', 3),
    ('cbt_tool', 'solve_problem', 'حلّها خطوة بخطوة', 'cbt', 'plus', 4),
    ('library_article', 'anxiety', 'القلق', 'library', 'free', 1),
    ('library_article', 'low_mood', 'المزاج المنخفض والاكتئاب', 'library', 'free', 2),
    ('library_article', 'rumination', 'الاجترار الفكري', 'library', 'free', 3),
    ('library_article', 'sleep_hygiene', 'نظافة النوم', 'library', 'free', 4),
    ('library_article', 'grounding', 'التأريض (Grounding)', 'library', 'free', 5)
),
ins_items AS (
  INSERT INTO content_items (content_type, content_key, content_version, clinical_review_status, launch_enabled)
  SELECT content_type, content_key, '1.0.0', 'review_required', false FROM seed
  ON CONFLICT (content_type, content_key, content_version) DO NOTHING
  RETURNING 1
)
SELECT count(*) FROM ins_items;


/* ------------------------------------------------------------
   1.2  content_presentation — كل حقل عرض/نشر جديد لعنصر محتوى.

   منفصل لأن ALTER TABLE على content_items مستحيل (يملكه postgres).
   مفتاحه المنطقي (content_type, content_key) لا مفتاح أجنبي، لنفس
   سبب امتناع الترحيل 003 عن FK إلى admin_users.

   publish_at / unpublish_at هما آلية الجدولة كاملةً: لا Cron ولا
   Queue ولا Background Job. الكاشف (content/catalog.js) يقارنهما
   بـnow() في كل قراءة، فالمحتوى المجدول ينشر نفسه بمجرد أن يمر
   وقته — بلا أي مكوّن يعمل في الخلفية. وهذا الشكل هو الوحيد الذي
   لا يمكن أن "يقول نُشر" قبل النشر الحقيقي، لأنه لا يخزّن حالة
   نشر منفصلة عن الوقت أصلاً.
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS content_presentation (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type      TEXT NOT NULL,
  content_key       TEXT NOT NULL,
  title             TEXT NOT NULL,
  category          TEXT,
  subscription_tier TEXT NOT NULL DEFAULT 'free' CHECK (subscription_tier IN ('free', 'plus')),
  display_order     INTEGER NOT NULL DEFAULT 0,
  publish_at        TIMESTAMPTZ,   -- NULL = فوري عند التفعيل
  unpublish_at      TIMESTAMPTZ,   -- NULL = بلا نهاية
  scheduled_by      UUID,
  updated_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (content_type, content_key)
);

CREATE INDEX IF NOT EXISTS idx_content_presentation_type
  ON content_presentation (content_type, display_order);

WITH seed (content_type, content_key, title, category, subscription_tier, display_order) AS (
  VALUES
    ('journey', 'reactivate_your_day', 'استعادة النشاط', 'energy', 'free', 1),
    ('journey', 'break_the_thought_loop', 'الخروج من دوامة التفكير', 'anxiety_thinking', 'plus', 2),
    ('journey', 'organize_daily_anxiety', 'تنظيم القلق اليومي', 'anxiety_thinking', 'plus', 3),
    ('journey', 'balanced_sleep', 'نوم أكثر اتزاناً', 'sleep', 'plus', 4),
    ('journey', 'inner_critic', 'التعامل مع الناقد الداخلي', 'emotions_self', 'plus', 5),
    ('journey', 'solve_problem_step_by_step', 'حل المشكلات خطوة بخطوة', 'decisions_problems', 'plus', 6),
    ('journey', 'understand_your_emotions', 'افهم مشاعرك', 'emotions_self', 'plus', 7),
    ('journey', 'handling_strong_emotions', 'التعامل مع المشاعر القوية', 'emotions_self', 'plus', 8),
    ('journey', 'start_despite_procrastination', 'ابدأ رغم التسويف', 'change_direction', 'plus', 9),
    ('journey', 'clearer_boundaries', 'حدود أكثر وضوحاً', 'relationships_boundaries', 'plus', 10),
    ('journey', 'communicate_better', 'تواصل بصورة أفضل', 'relationships_boundaries', 'plus', 11),
    ('journey', 'getting_closer_to_others', 'الاقتراب من الآخرين', 'relationships_boundaries', 'plus', 12),
    ('journey', 'adapt_to_change', 'التكيف مع التغيير', 'change_direction', 'plus', 13),
    ('journey', 'live_what_matters', 'عِش ما يهمك', 'change_direction', 'plus', 14),
    ('journey', 'be_kinder_to_yourself', 'كن أرفق بنفسك', 'emotions_self', 'plus', 15),
    ('journey', 'maintain_what_helps', 'المحافظة على ما نفعك', 'help_maintenance', 'plus', 16),
    ('journey', 'prepare_to_seek_help', 'الاستعداد لطلب المساعدة', 'specialist_prep', 'plus', 17),
    ('journey', 'benefit_from_your_session', 'استفد من جلستك النفسية', 'specialist_prep', 'plus', 18),
    ('overlay', 'work_pressure', 'ضغط العمل', 'context_overlay', 'plus', 1),
    ('overlay', 'work_life_balance', 'التوازن بين العمل والحياة', 'context_overlay', 'plus', 2),
    ('overlay', 'study_exam_stress', 'ضغوط الدراسة والاختبارات', 'context_overlay', 'plus', 3),
    ('overlay', 'moving_transition', 'الانتقال إلى وظيفة أو مدينة جديدة', 'context_overlay', 'plus', 4),
    ('overlay', 'marriage_prep', 'الاستعداد للزواج', 'context_overlay', 'plus', 5),
    ('overlay', 'parenting_pressure', 'ضغوط الوالدية', 'context_overlay', 'plus', 6),
    ('overlay', 'caregiver_support', 'دعم مقدمي الرعاية', 'context_overlay', 'plus', 7),
    ('overlay', 'retirement_role_change', 'التقاعد وتغيّر الأدوار', 'context_overlay', 'plus', 8),
    ('notebook', 'need_right_now', 'ما الذي أحتاجه الآن؟', 'self_emotions', 'free', 1),
    ('notebook', 'understand_emotion', 'افهم شعورك', 'self_emotions', 'free', 2),
    ('notebook', 'difficult_decision', 'قرار يحيّرني', 'decisions_problems', 'free', 3),
    ('notebook', 'realistic_gratitude', 'امتنان واقعي', 'kindness_growth', 'free', 4),
    ('notebook', 'unresolved_situation', 'موقف لم أتجاوزه', 'self_emotions', 'plus', 5),
    ('notebook', 'daily_drain', 'ما الذي استنزفني اليوم؟', 'self_emotions', 'plus', 6),
    ('notebook', 'did_despite_difficulty', 'شيء فعلته رغم صعوبته', 'self_emotions', 'plus', 7),
    ('notebook', 'inner_critic_voice', 'صوت الناقد الداخلي', 'self_emotions', 'plus', 8),
    ('notebook', 'what_am_i_avoiding', 'ماذا أحاول تجنبه؟', 'self_emotions', 'plus', 9),
    ('notebook', 'problem_to_sort', 'مشكلة تحتاج ترتيباً', 'decisions_problems', 'plus', 10),
    ('notebook', 'circle_of_influence', 'ما الذي يقع ضمن سيطرتي؟', 'decisions_problems', 'plus', 11),
    ('notebook', 'worst_case_realistic_plan', 'أسوأ احتمال والخطة الواقعية', 'decisions_problems', 'plus', 12),
    ('notebook', 'next_small_step', 'خطوتي الصغيرة القادمة', 'decisions_problems', 'plus', 13),
    ('notebook', 'unsaid_words', 'كلام لم أقله', 'relationships_boundaries', 'plus', 14),
    ('notebook', 'boundary_needed', 'حد أحتاج إلى وضعه', 'relationships_boundaries', 'plus', 15),
    ('notebook', 'prepare_conversation', 'محادثة أحتاج إلى الاستعداد لها', 'relationships_boundaries', 'plus', 16),
    ('notebook', 'relationship_needs', 'ما الذي أحتاجه من هذه العلاقة؟', 'relationships_boundaries', 'plus', 17),
    ('notebook', 'felt_misunderstood', 'موقف شعرت فيه أنني غير مفهوم', 'relationships_boundaries', 'plus', 18),
    ('notebook', 'letter_not_sent', 'رسالة لن أرسلها', 'relationships_boundaries', 'plus', 19),
    ('notebook', 'advice_to_loved_one', 'ماذا سأقول لشخص أحبه؟', 'kindness_growth', 'plus', 20),
    ('notebook', 'self_forgiveness', 'أمر أحتاج أن أتعامل معه برفق', 'kindness_growth', 'plus', 21),
    ('notebook', 'learned_about_self', 'ما الذي تعلمته عن نفسي؟', 'kindness_growth', 'plus', 22),
    ('notebook', 'value_to_live', 'قيمة أريد أن أعيشها', 'kindness_growth', 'plus', 23),
    ('notebook', 'better_than_expected', 'ما الذي سار أفضل مما توقعت؟', 'kindness_growth', 'plus', 24),
    ('notebook', 'before_specialist_visit', 'قبل لقائي بالمختص', 'specialist_prep', 'plus', 25),
    ('notebook', 'after_therapy_session', 'بعد الجلسة النفسية', 'specialist_prep', 'plus', 26),
    ('notebook', 'questions_for_specialist', 'أسئلة أريد طرحها', 'specialist_prep', 'plus', 27),
    ('notebook', 'since_last_session', 'ما الذي تغيّر منذ الجلسة الماضية؟', 'specialist_prep', 'plus', 28),
    ('notebook', 'what_did_not_fit', 'ما الذي جربته ولم يناسبني؟', 'specialist_prep', 'plus', 29),
    ('cbt_tool', 'understand_cycle', 'افهم الحلقة', 'cbt', 'free', 1),
    ('cbt_tool', 'check_thought', 'افحص الفكرة', 'cbt', 'free', 2),
    ('cbt_tool', 'activate_day', 'نشّط يومك', 'cbt', 'free', 3),
    ('cbt_tool', 'solve_problem', 'حلّها خطوة بخطوة', 'cbt', 'plus', 4),
    ('library_article', 'anxiety', 'القلق', 'library', 'free', 1),
    ('library_article', 'low_mood', 'المزاج المنخفض والاكتئاب', 'library', 'free', 2),
    ('library_article', 'rumination', 'الاجترار الفكري', 'library', 'free', 3),
    ('library_article', 'sleep_hygiene', 'نظافة النوم', 'library', 'free', 4),
    ('library_article', 'grounding', 'التأريض (Grounding)', 'library', 'free', 5)
)
INSERT INTO content_presentation (content_type, content_key, title, category, subscription_tier, display_order)
SELECT content_type, content_key, title, category, subscription_tier, display_order FROM seed
ON CONFLICT (content_type, content_key) DO UPDATE
  SET title             = EXCLUDED.title,
      category          = EXCLUDED.category,
      -- ⚠️ الطبقة تُصحَّح عند إعادة التشغيل **إلا** إذا غيّرها مسؤول
      -- من اللوحة (updated_by غير فارغ). فالترحيل يصلح خطأ بذر،
      -- ولا يدهس قراراً مالياً اتخذه إنسان.
      subscription_tier = CASE WHEN content_presentation.updated_by IS NULL
                               THEN EXCLUDED.subscription_tier
                               ELSE content_presentation.subscription_tier END,
      display_order     = EXCLUDED.display_order;


/* ------------------------------------------------------------
   1.3  content_versions — تاريخ النسخ للمحتوى الحساس.

   يُكتب صف عند كل تغيير حالة مراجعة أو نشر أو إيقاف أو تعديل
   طبقة/ترتيب. لا يُحدَّث ولا يُحذف — سجل يقرأ منه "من غيّر ماذا
   ومتى" لأي عنصر محتوى، وهو ما يعجز عنه content_items لأنه يحمل
   الحالة الحالية فقط (reviewer واحد، تاريخ واحد).
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS content_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type    TEXT NOT NULL,
  content_key     TEXT NOT NULL,
  content_version TEXT NOT NULL,
  change_kind     TEXT NOT NULL
                    CHECK (change_kind IN ('review', 'publish', 'unpublish', 'schedule',
                                           'tier_change', 'presentation', 'seed')),
  old_value       JSONB,
  new_value       JSONB,
  changed_by      UUID,            -- admin_users.id — بلا FK، انظر أعلى
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_versions_item
  ON content_versions (content_type, content_key, created_at DESC);


/* ============================================================
   الجزء 2 — الإشعارات
   ============================================================ */

/* ------------------------------------------------------------
   2.1  notification_campaigns — الحملة الواحدة.

   لماذا جدول جديد بدل broadcast_notifications؟ لأن الأخير يملكه
   postgres فلا يقبل ALTER، وينقصه كل ما تحتاجه المرحلة: قناة،
   وحالة، ووقت جدولة، وجمهور مخصص. الجدول القديم يبقى كما هو
   لسجلات البث السابقة، ولا يُحذف منه شيء.

   status لا يصير 'sent' إلا بعد تنفيذ حقيقي، ولا يصير 'sent' لو
   فشل أي مستلم — يصير 'partially_failed'. زر الإرسال لا يغيّر
   الحالة بذاته إطلاقاً.
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS notification_campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  audience         TEXT NOT NULL
                     CHECK (audience IN ('all', 'active_subscribers', 'trial_or_free', 'selected_users', 'account_status')),
  audience_filter  JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { userIds: [...] } أو { status: 'pending_verification' }
  channels         TEXT[] NOT NULL DEFAULT ARRAY['in_app']::TEXT[],
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'partially_failed', 'failed', 'canceled')),
  scheduled_at     TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  recipient_count  INTEGER NOT NULL DEFAULT 0,
  sent_count       INTEGER NOT NULL DEFAULT 0,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_by       UUID NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_campaigns_status
  ON notification_campaigns (status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_notification_campaigns_time
  ON notification_campaigns (created_at DESC);


/* ------------------------------------------------------------
   2.2  notification_deliveries — صف لكل (حملة، مستخدم، قناة).

   هذا هو الجدول الذي كان غائباً تماماً. بدونه لا يمكن الإجابة على
   "هل وصلت فلاناً؟" ولا "لماذا فشلت؟" — كان النظام يخزّن عدّادين
   مجمّعين ويعرضهما كأنهما دليل تسليم.

   القيد الفريد (campaign_id, user_id, channel) هو مرساة منع
   التكرار: إعادة تشغيل حملة أو تزامن نداءين لا يمكن أن ينتج عنه
   إرسال مزدوج لأن الصف الثاني يسقط على القيد. نفس مبدأ dedup_key
   في طبقة الدفع.
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES notification_campaigns(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL CHECK (channel IN ('in_app', 'email', 'push')),
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'processing', 'sent', 'delivered', 'failed', 'skipped')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  error_code          TEXT,
  error_detail        TEXT,
  last_attempt_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, user_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_campaign
  ON notification_deliveries (campaign_id, status);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_user
  ON notification_deliveries (user_id, created_at DESC);


/* ------------------------------------------------------------
   2.3  user_notifications — صندوق الإشعارات داخل التطبيق.

   الجرس في التطبيق كان useState([]) — لا خادم ولا حتى
   localStorage، فيضيع مع أول تحديث للصفحة، ولا يعرف الخادم عنه
   شيئاً. هذا الجدول يجعله قناة حقيقية.

   dedup_key يمنع تكرار الإشعارات النظامية (مثل "باقي يومان على
   انتهاء اشتراكك") مهما تكرر النداء. NULL لا يتعارض في Postgres،
   فالإشعارات غير المعرَّفة بمفتاح لا تتأثر بالقيد.
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS user_notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'info' CHECK (kind IN ('info', 'success', 'warning')),
  source      TEXT NOT NULL DEFAULT 'system' CHECK (source IN ('campaign', 'system', 'billing')),
  campaign_id UUID REFERENCES notification_campaigns(id) ON DELETE SET NULL,
  dedup_key   TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_inbox
  ON user_notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
  ON user_notifications (user_id) WHERE read_at IS NULL;

-- مفتاح أجنبي بلا فهرس = مسح كامل عند حذف حملة (ON DELETE SET NULL).
CREATE INDEX IF NOT EXISTS idx_user_notifications_campaign
  ON user_notifications (campaign_id);


/* ------------------------------------------------------------
   2.4  push_subscriptions — اشتراكات Web Push (PWA).

   التطبيق PWA بـService Worker أصلاً (vite-plugin-pwa)، فالقناة
   متاحة بلا مزوّد خارجي ولا تكلفة: Web Push معيار في المتصفح،
   والخادم يوقّع بمفتاح VAPID ويرسل إلى endpoint المتصفح مباشرة.

   failure_count / disabled_at: اشتراك يرد 404 أو 410 يعني أن
   المستخدم أزال التطبيق أو ألغى الإذن — يُعطَّل فوراً بدل إعادة
   المحاولة إلى الأبد.
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  disabled_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions (user_id) WHERE disabled_at IS NULL;

-- الفهرس الجزئي أعلاه لا يخدم CASCADE عند حذف المستخدم.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_all
  ON push_subscriptions (user_id);


/* ============================================================
   الجزء 3 — البيانات التشغيلية للمستخدم

   كل ما يفعله المستخدم كان يعيش في حالة React ويموت مع تحديث
   الصفحة. الأثر الأوضح: شرط فتح "بوصلة كنف" المدفوعة هو
   trackedDays >= 7، والعدّاد يصفّر مع كل تحديث — ميزة مدفوعة
   يستحيل الوصول إليها.

   daily_logs و screenings موجودان في schema.sql منذ اليوم الأول
   بلا كاتب واحد، فلا يحتاجان جدولاً جديداً — يحتاجان مسار كتابة
   فقط (userdata/routes.js).
   ============================================================ */

/* ------------------------------------------------------------
   3.1  الرحلات — التسجيل وحالة كل يوم.
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS user_journey_enrollments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  journey_key     TEXT NOT NULL,
  -- 'companion' ليست تخميناً: رحلتان في التطبيق تحملانها فعلاً
  -- (prepare_to_seek_help و benefit_from_your_session). بلا هذا
  -- القيد كانتا ستُقبلان بلا اعتراض وتسقطان من أي تجميع إداري
  -- يفلتر بـ primary/overlay.
  journey_type    TEXT NOT NULL DEFAULT 'primary'
                    CHECK (journey_type IN ('primary', 'overlay', 'companion')),
  content_version TEXT NOT NULL DEFAULT '1.0.0',
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'completed', 'abandoned')),
  total_days      INTEGER NOT NULL CHECK (total_days > 0),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  -- حالة العميل كما هي: الهدف الشخصي، ودرجة الأداء الابتدائية،
  -- ومسودات الأيام. تقسيم مقصود بين عمودين من نوعين مختلفين:
  --   • الأعمدة المنظّمة أعلاه (status/total_days/الأيام) هي ما
  --     تحتاجه الإدارة للتجميع — "كم مستخدماً أكمل هذه الرحلة".
  --   • client_state ملك المستخدم وحده، ولا استعلام إداري في هذا
  --     المستودع يختاره. تصنيفه (D) في 04_PRIVACY_CLASSIFICATION.md.
  -- الفصل يجعل تقارير الإدارة ممكنة بلا أن تمرّ على نص المستخدم.
  client_state    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, journey_key)
);

CREATE INDEX IF NOT EXISTS idx_journey_enrollments_user
  ON user_journey_enrollments (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_journey_day_states (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES user_journey_enrollments(id) ON DELETE CASCADE,
  day_number    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'available'
                  CHECK (status IN ('locked', 'available', 'completed', 'skipped')),
  completed_at  TIMESTAMPTZ,
  UNIQUE (enrollment_id, day_number)
);

/* ------------------------------------------------------------
   3.2  الدفاتر.

   ⚠️ answers هو أخطر عمود في قاعدة البيانات كلها: نص حر يكتبه
   المستخدم عن حالته النفسية. تصنيفه في 04_PRIVACY_CLASSIFICATION.md
   هو (D) غير مرئي للإدارة إطلاقاً — لا في مسار الدعم ولا في
   "البيانات الحساسة". الوصول إليه يمر بـbreak-glass بموافق ثانٍ
   فقط. لا استعلام إداري في هذا المستودع يختار هذا العمود.
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS user_notebook_entries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_key     TEXT NOT NULL,
  template_version TEXT NOT NULL DEFAULT '1.0.0',
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  answers          JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision         INTEGER NOT NULL DEFAULT 1,
  -- 0..3 مطابقة لـHELPFUL_LABELS في التطبيق. بلا القيد كانت قيمة
  -- خارج المدى تُرجع 500 من Postgres بدل 400 من المسار.
  helpfulness      SMALLINT CHECK (helpfulness BETWEEN 0 AND 3),
  last_prompt_key  TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notebook_entries_user
  ON user_notebook_entries (user_id, updated_at DESC);

/* ------------------------------------------------------------
   3.3  جلسات أدوات كنف المعرفية السلوكية.

   payload يحمل مخرجات التمرين (أفكار، مشاعر، بدائل) — نص حر
   حساس. نفس تصنيف answers: (D).
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS user_cbt_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_id      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cbt_sessions_user
  ON user_cbt_sessions (user_id, started_at DESC);


/* ============================================================
   ملاحظة ختامية — ما لم يُنشأ هنا عمداً
   ============================================================
   • لا جدول Cache ولا Queue ولا Jobs. الجدولة كلها مقارنة وقت
     عند القراءة (المحتوى) أو مسح مستحقّ عند أول نداء (الإشعارات).
   • لا نسخ من نص المحتوى في قاعدة البيانات. نصوص الرحلات والدفاتر
     تبقى في حزمة التطبيق، والخادم يتحكم في الظهور والطبقة فقط.
     الأعمدة جاهزة لاستقبال النص لاحقاً بلا ترحيل مؤلم إن لزم.
   • لا تعديل على أي جدول أصلي — ولا سطر ALTER واحد.
   ============================================================ */
