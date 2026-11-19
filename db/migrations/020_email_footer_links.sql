-- ============================================================
-- 020 — روابط تذييل البريد (KANAF-ORD-0008 §9.2)
--
-- ثلاثة إعدادات جديدة فارغة (null): رابطا المتجرين وحساب تيك توك.
-- لا تُخمَّن الروابط: تبقى فارغة، والزر في البريد مخفيّ حتى يضبطها
-- المالك من «الإعدادات». حسابا X وإنستقرام قائمان أصلاً (الترحيل 010).
-- بيانات لا مخطط: صفوف في app_settings، وON CONFLICT DO NOTHING
-- حتى لا يمحو تشغيلٌ مُعاد قيمة ضبطها المالك.
-- ============================================================
INSERT INTO app_settings (key, value, category, description) VALUES
  ('app_store_url',        'null'::jsonb, 'general', 'رابط التطبيق في App Store (apps.apple.com). فارغ = الزر مخفيّ'),
  ('google_play_url',      'null'::jsonb, 'general', 'رابط التطبيق في Google Play (play.google.com). فارغ = الزر مخفيّ'),
  ('social_tiktok_handle', 'null'::jsonb, 'general', 'حساب تيك توك كما يُعرض ويُبنى منه الرابط. فارغ = مخفيّ')
ON CONFLICT (key) DO NOTHING;
