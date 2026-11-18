-- ============================================================
-- 017 — فئتا جمهور للتسويق (KANAF-ORD-0008 §4.4 و§5.2)
--
-- صفحة التسويق امتداد لنظام الحملات القائم، لا نظام ثانٍ. والفئتان
-- الجديدتان مشتقّتان عند القراءة — لا جدول ولا عمود ولا وظيفة خلفية:
--   abandoned_carts  من له فاتورة pending مضى عليها أكثر من 20 دقيقة،
--                    ولم يشترِ بعدها، وليس مشتركاً الآن
--   inactive         من لم يدخل منذ N يوماً (من سجلّ الدخول والجلسات)
--
-- التغيير الوحيد: توسيع قيد CHECK على notification_campaigns.audience
-- بقيمتين. القيم الخمس القائمة كما هي، ولا صف قائم يتأثر.
-- ============================================================
ALTER TABLE notification_campaigns DROP CONSTRAINT IF EXISTS notification_campaigns_audience_check;
ALTER TABLE notification_campaigns ADD CONSTRAINT notification_campaigns_audience_check
  CHECK (audience IN ('all', 'active_subscribers', 'trial_or_free', 'selected_users', 'account_status',
                      'abandoned_carts', 'inactive'));
