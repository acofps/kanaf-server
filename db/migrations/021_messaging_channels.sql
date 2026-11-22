-- ============================================================
-- 021 — قناتا الرسالة النصية وواتساب لصفوف التسليم (KANAF-ORD-0013 §4.4 و§6.3)
--
-- المراسلة الفردية والجماعية تمرّ على آلية الحملات نفسها وسجلّها
-- (notification_deliveries)، لا على مسار ثانٍ. فيُوسَّع قيد القناة بقيمتين.
-- القيم الثلاث القائمة كما هي، ولا صفّ قائم يتأثر: توسيع لا تضييق.
--
-- القناة لا تُقبل في حملة إلا إن كانت مضبوطة فعلاً (notifications/channels.js):
-- لا تُقبل رسالة ثم تفشل بصمت.
-- ============================================================
ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_channel_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_channel_check
  CHECK (channel IN ('in_app', 'email', 'push', 'sms', 'whatsapp'));
