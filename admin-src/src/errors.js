/* ============================================================
   رسائل الأخطاء العربية — KANAF-ORD-0015 §2.4

   كانت هذه الخريطة داخل api.js وتحمل 55 رمزاً، والخادم يردّ على اللوحة 160 رمزاً
   ونيّفاً. ما لا تعرفه الخريطة كان يسقط إلى «تعذّر تنفيذ الطلب.» — رسالة تُخفي
   السبب: «qw» كود من حرفين يُرفض بـinvalid_code_format، والمسؤول لا يعرف لماذا.

   القاعدة: كل رمز يصل اللوحة له هنا نصّ يقول ما الخطأ وما يفعله المستخدم.
   والاستثناء مكتوب بسببه في test-52، والفحص يسقط إن ظهر رمز جديد بلا نصّ ولا سبب.
   «تعذّر تنفيذ الطلب» تبقى شبكة أمان أخيرة، ومعها الرمز بخط صغير لينقله المسؤول إلينا.
   ============================================================ */

export const ERROR_AR = {
  insufficient_role: "صلاحيتك لا تسمح بهذا الإجراء.",
  invalid_credentials: "البريد أو كلمة المرور غير صحيحة.",
  session_expired: "انتهت الجلسة. سجّل الدخول من جديد.",
  cannot_enable_unapproved_content: "لا يمكن نشر محتوى غير معتمد سريرياً.",
  tier_change_requires_admin: "تغيير الطبقة قرار مالي — يحتاج صلاحية مدير.",
  scope_required: "حدّد نطاق النشر (نوع أو عناصر) أو أكّد نشر الكل.",
  push_not_configured: "قناة الإشعارات على الجهاز غير مضبوطة على الخادم.",
  no_recipients_in_audience: "لا يوجد مستلمون في هذه الفئة.",
  cannot_cancel_after_dispatch: "لا يمكن إلغاء حملة نُفّذت.",
  unpublish_before_publish: "وقت الإيقاف يجب أن يكون بعد وقت النشر.",
  title_cannot_be_empty: "العنوان لا يمكن أن يكون فارغاً.",
  already_resolved: "هذا الطلب حُسم مسبقاً.",
  cannot_self_approve: "لا يمكنك اعتماد طلبك بنفسك.",
  refund_exceeds_available_amount: "المبلغ أكبر من المتبقّي القابل للاسترداد في هذه الدفعة.",
  refund_already_recorded: "هذا الاسترداد مسجّل مسبقاً — لم يُكرَّر.",
  already_fully_refunded: "هذه الدفعة مستردة بالكامل.",
  payment_not_captured: "الدفعة غير محصّلة — لا شيء يُسترد.",
  provider_refund_failed: "رفض المزوّد الاسترداد — لم يتغيّر شيء عندنا.",
  provider_outcome_unknown: "لم يصل رد المزوّد — قد يكون الاسترداد نُفّذ. المبلغ محجوز لمنع التكرار؛ اضغط «مطابقة» على الدفعة بعد 10 دقائق قبل أي محاولة جديدة.",
  refund_amount_must_be_positive: "مبلغ الاسترداد يجب أن يكون أكبر من صفر.",
  refund_exceeds_captured_amount: "المبلغ أكبر من المحصَّل.",
  no_provider_payment_id: "لا رقم معاملة لدى المزوّد لهذه الدفعة — لا يمكن مطابقتها.",
  provider_status_not_actionable: "حالة الدفعة لدى المزوّد لا تستدعي تغييراً.",
  replay_failed: "تعذّرت إعادة معالجة الحدث — التفاصيل في سجل الخادم.",
  reconcile_failed: "تعذّرت المطابقة مع المزوّد — حاول لاحقاً.",
  provider_unavailable: "تعذّر الوصول إلى المزوّد الآن — الحدث باقٍ محجوزاً، لم يتغيّر شيء. أعد الفحص لاحقاً.",
  recheck_failed: "تعذّرت إعادة الفحص — التفاصيل في سجل الخادم.",
  hold_not_open: "هذا الحدث لم يعد مفتوحاً.",
  session_minutes_must_be_5_to_60: "عمر الجلسة عدد صحيح من 5 إلى 60 دقيقة.",
  invalid_assistant_policy: "القيمة يجب أن تكون all_verified أو plus_only.",
  /* KANAF-ORD-0013 §4.3 */
  email_taken: "هذا البريد مسجّل لحساب آخر.",
  invalid_email: "صيغة البريد غير صحيحة.",
  invalid_name: "الاسم مطلوب، وبحد أقصى 80 حرفاً.",
  invalid_saudi_phone: "الرقم السعودي تسع خانات ويبدأ بـ5، بلا الصفر ولا مفتاح الدولة.",
  dial_country_mismatch: "رمز الاتصال لا يطابق الدولة المختارة.",
  phone_incomplete: "أدخل رمز الدولة والرقم معاً.",
  invalid_phone_length: "طول الرقم غير صالح.",
  invalid_reminder_time: "الوقت بصيغة HH:MM بنظام 24 ساعة.",
  invalid_timezone: "منطقة زمنية غير معروفة.",
  nothing_to_update: "لا تغيير لحفظه.",
  unknown_plan: "الباقة غير موجودة.",
  invalid_period_end: "تاريخ انتهاء غير صالح.",
  grant_requires_plan_and_period_end: "لا اشتراك سابق: المنح اليدوي يحتاج باقة وتاريخ انتهاء.",
  unsupported_image: "نوع الصورة غير مدعوم (JPEG أو PNG أو WebP).",
  image_too_large: "الصورة أكبر من الحد المسموح.",
  channel_unavailable: "قناة معطّلة — اعتمادها غير مضبوط. أزلها أو اضبطها من «التكاملات».",
  audience_count_changed: "تغيّر عدد المستلمين منذ عرضه — راجع العدد الجديد وأكّد من جديد.",
  password_too_short: "الرقم السري خمسة عشر حرفاً على الأقل.",
  invalid_duties: "اختر مهام إدارية أو مالية.",
  invalid_pages: "صفحة غير معروفة.",
  invalid_phone: "الجوال بصيغة دولية: + ثم 8 إلى 15 رقماً.",
  email_already_exists: "هذا البريد مسجّل لحساب آخر.",
  cannot_change_own_pages: "لا تقدر تضيّق صفحاتك بنفسك.",
  no_open_deletion_request: "لا طلب حذف مفتوح لهذا الحساب — أُتمّ محوه سابقاً أو لم يطلب صاحبه الحذف.",
  account_not_deactivated: "الحساب غير معطّل — المحو النهائي لحساب طلب صاحبه حذفه فقط.",
  /* ---------- KANAF-ORD-0015 §2.4: ما كان يسقط إلى «تعذّر تنفيذ الطلب» ---------- */
  /* أكواد الخصم */
  invalid_code_format: "الكود من 3 إلى 32 خانة: حروف لاتينية وأرقام و- و_ فقط. أطِل الكود أو احذف ما سوى ذلك.",
  invalid_kind: "اختر نوع الخصم: نسبة أو مبلغ.",
  invalid_value: "القيمة يجب أن تكون رقماً أكبر من صفر.",
  percent_must_be_below_100: "النسبة أقل من 100 — خصم 100% غير مسموح.",
  value_max_two_decimals: "القيمة بخانتين عشريتين على الأكثر (مثل 9.50).",
  invalid_date: "تاريخ غير صالح — أعد اختياره من التقويم.",
  valid_until_before_from: "تاريخ الانتهاء يجب أن يكون بعد تاريخ البدء.",
  invalid_max_redemptions: "حد الاستعمال عدد صحيح أكبر من صفر، أو اتركه فارغاً بلا حد.",
  code_exists: "هذا الكود موجود مسبقاً — اختر كوداً آخر.",
  active_must_be_boolean: "قيمة التفعيل غير صالحة — حدّث الصفحة وأعد المحاولة.",
  /* عام */
  not_found: "العنصر غير موجود — ربما حُذف. حدّث الصفحة.",
  reason_too_long: "السبب طويل — اختصره.",
  nothing_to_change: "لا تغيير لحفظه.",
  forbidden: "صلاحيتك لا تسمح بهذا الإجراء.",
  insufficient_permission: "صلاحيتك لا تسمح بهذا الإجراء — اطلبه من المالك.",
  unknown_role: "دور حسابك غير معروف — راجع المالك.",
  account_inactive: "حسابك الإداري معطّل — راجع المالك.",
  account_not_found: "الحساب الإداري غير موجود. سجّل الدخول من جديد.",
  invalid_or_expired_token: "الرابط منتهٍ أو استُعمل — اطلب رابطاً جديداً.",
  token_required: "الرابط ناقص — افتحه من البريد كما هو.",
  token_and_password_required: "أدخل الرقم السري.",
  email_and_password_required: "أدخل البريد والرقم السري.",
  confirmation_required: "اكتب كلمة التأكيد كما هي للمتابعة.",
  audit_log_failed: "تعذّر تسجيل الوصول في السجل، فلم تُعرض البيانات. حاول بعد لحظات.",
  document_queue_full: "مولّد المستندات مشغول الآن — حاول بعد دقيقة.",
  invalid_status: "حالة غير صالحة.",
  /* حسابات الإدارة */
  account_already_active: "الحساب مفعّل أصلاً.",
  cannot_change_own_role: "لا تستطيع تغيير دورك بنفسك.",
  cannot_deactivate_self: "لا تستطيع تعطيل حسابك بنفسك.",
  cannot_remove_last_owner: "لا يمكن إزالة آخر مالك — أضف مالكاً آخر أولاً.",
  only_owner_can_create_owner: "إضافة مالك للمالك وحده.",
  invalid_role: "دور غير معروف.",
  name_email_required: "الاسم والبريد مطلوبان.",
  name_email_role_required: "الاسم والبريد والدور مطلوبة.",
  password_too_long: "الرقم السري أطول من الحد (72 بايتاً — الحرف العربي بايتان).",
  password_too_common: "الرقم السري شائع ويسهل تخمينه — اختر غيره.",
  /* المستخدمون */
  account_deleted: "هذا الحساب محذوف — لا يُعدَّل.",
  already_suspended: "الحساب موقوف أصلاً.",
  not_suspended: "الحساب غير موقوف.",
  no_avatar: "لا صورة لهذا العضو.",
  no_active_subscription: "لا اشتراك سارٍ لهذا العضو.",
  invalid_country: "دولة غير معروفة.",
  invalid_dial_code: "رمز الاتصال غير صالح.",
  unsupported_dial_code: "رمز الاتصال غير مدعوم — اختر الدولة من القائمة.",
  invalid_gender: "قيمة الجنس غير صالحة.",
  invalid_age_range: "الفئة العمرية غير صالحة.",
  image_too_small: "الصورة صغيرة — 128×128 على الأقل.",
  image_dimensions_too_large: "أبعاد الصورة كبيرة — صغّرها وأعد الرفع.",
  empty_body: "لم يصل ملف — اختر الصورة من جديد.",
  invalid_remindersOn: "قيمة التذكير غير صالحة — حدّث الصفحة.",
  invalid_marketingOptOut: "قيمة إيقاف التسويق غير صالحة — حدّث الصفحة.",
  /* الاسترداد والفواتير */
  already_refunded: "هذه الدفعة مستردة مسبقاً.",
  no_refundable_payment_found: "لا دفعة قابلة للاسترداد لهذا العضو.",
  payment_not_found: "الدفعة غير موجودة.",
  not_found_or_not_paid: "الفاتورة غير موجودة أو غير مدفوعة — لا يُصدر لها رقم.",
  already_has_invoice_number: "للفاتورة رقم صادر — لا يُعاد إصداره.",
  tax_settings_not_configured: "بيانات المنشأة الضريبية ناقصة — أكملها من «المالية» ثم أعد المحاولة.",
  unknown_plan_cannot_regenerate: "باقة الفاتورة لم تعد موجودة — لا يُعاد توليدها.",
  vat_rate_required: "نسبة الضريبة مطلوبة (0.15 لخمسة عشر بالمئة).",
  vat_rate_must_be_between_0_and_1: "النسبة كسر بين 0 و1 (0.15 لخمسة عشر بالمئة).",
  currency_must_be_3_letter_code: "العملة رمز من ثلاثة أحرف لاتينية (SAR).",
  settings_row_missing_run_migration_004: "صف الإعدادات المالية غير موجود — شغّل الترحيلات أولاً.",
  /* الباقات */
  invalid_price: "السعر رقم أكبر من صفر.",
  invalid_duration: "المدة عدد أيام صحيح أكبر من صفر.",
  invalid_features: "المزايا قائمة نصوص.",
  invalid_display_order: "ترتيب العرض عدد صحيح.",
  plan_key_already_exists: "مفتاح الباقة مستعمل — اختر غيره.",
  /* التجديد التلقائي */
  autorenew_not_active: "لا موافقة تجديد فعّالة لهذا العضو.",
  autorenew_unavailable: "التجديد التلقائي معطّل على هذا الخادم.",
  already_active: "موافقة التجديد فعّالة أصلاً.",
  consent_terms_changed: "تغيّر سعر الباقة منذ عرض الموافقة — أعد عرضها.",
  consent_version_outdated: "نص الموافقة تغيّر — أعد عرضه على العضو.",
  no_renewable_subscription: "لا اشتراك قابل للتجديد.",
  no_saved_card: "لا بطاقة محفوظة لهذا العضو.",
  autorenew_notice_days_1_to_14: "أيام الإشعار من 1 إلى 14.",
  autorenew_max_attempts_1_to_5: "المحاولات من 1 إلى 5.",
  autorenew_retry_hours_6_to_72: "الفاصل بين المحاولات من 6 إلى 72 ساعة.",
  /* الإعدادات */
  unknown_setting: "إعداد غير معروف — حدّث الصفحة.",
  value_required: "القيمة مطلوبة.",
  value_cannot_be_empty: "القيمة لا تكون فارغة.",
  value_too_long: "القيمة أطول من 500 حرف.",
  value_must_be_string: "القيمة نص.",
  value_must_be_string_or_null: "القيمة نص أو فارغة.",
  value_must_be_boolean: "القيمة نعم أو لا.",
  invalid_url: "الرابط غير صالح — يبدأ بـ https://.",
  invalid_handle: "اسم الحساب حروف لاتينية وأرقام و. و_ حتى 30 خانة، بلا رابط.",
  invalid_time_format: "الوقت بصيغة HH:MM.",
  invalid_whatsapp_number: "رقم واتساب بصيغة دولية بلا + ولا مسافات (مثل 9665xxxxxxxx).",
  /* التكاملات */
  unknown_service: "خدمة غير معروفة.",
  unknown_field: "حقل غير معروف لهذه الخدمة.",
  not_configured: "لا اعتماد محفوظ لهذه الخدمة.",
  missing_fields: "حقول الاعتماد ناقصة — أكملها ثم أعد الفحص.",
  encryption_not_configured: "مفتاح التشفير INTEGRATIONS_ENC_KEY غير مضبوط في بيئة الخادم — لا تُحفظ الاعتمادات قبله.",
  test_not_available: "لا فحص اتصال لهذه الخدمة بعد.",
  /* الإشعارات والقوالب */
  title_and_body_required: "العنوان والنص مطلوبان.",
  subject_message_and_valid_audience_required: "العنوان والنص والفئة مطلوبة.",
  invalid_channel: "قناة غير معروفة.",
  invalid_audience: "فئة غير معروفة.",
  invalid_account_status: "حالة حساب غير معروفة.",
  invalid_inactive_days: "عدد الأيام من 7 إلى 365.",
  selected_users_requires_user_ids: "لم يُحدَّد مستلمون.",
  invalid_scheduled_at: "وقت الجدولة غير صالح.",
  scheduled_at_in_past: "وقت الجدولة مضى — اختر وقتاً قادماً.",
  campaign_not_found: "الحملة غير موجودة.",
  invalid_subscription: "اشتراك الجهاز غير صالح.",
  invalid_subject: "العنوان مطلوب، وبحد أقصى 200 حرف.",
  invalid_body: "النص مطلوب.",
  invalid_accent: "اللون من الألوان المعتمدة فقط.",
  footer_note_too_long: "التذييل طويل — اختصره.",
  template_name_exists: "اسم القالب مستعمل — اختر غيره.",
  cannot_delete_default_template: "القالب الافتراضي لا يُحذف.",
  unknown_template: "القالب غير موجود — ربما حُذف.",
  unknown_message: "رسالة غير معروفة.",
  channels_required: "اختر قناة واحدة على الأقل.",
  channel_not_allowed: "هذه القناة غير متاحة لهذه الرسالة.",
  required_channel_missing: "قناة إلزامية لهذه الرسالة لا تُطفأ.",
  required_placeholder_missing: "النص ينقصه موضع إلزامي (مثل {{code}}) — أعده.",
  unknown_placeholder: "في النص موضع غير معروف — احذفه أو صحّحه.",
  invalid_source: "مصدر غير معروف.",
  /* المحتوى */
  invalid_subscription_tier: "الطبقة غير صالحة.",
  invalid_publish_at: "وقت النشر غير صالح.",
  invalid_unpublish_at: "وقت الإيقاف غير صالح.",
  /* الدفع (يراها التطبيق، وتُعرض هنا إن مرّت باللوحة) */
  payment_provider_not_configured: "إعداد الدفع ناقص على الخادم — راجع «أخطاء النظام».",
  payment_provider_rejected: "رفض مزوّد الدفع الطلب — راجع «أخطاء النظام».",
  payment_provider_unreachable: "مزوّد الدفع لم يردّ في الوقت المحدّد — حاول بعد دقائق.",
};

/** فاصل الرمز في نصّ الخطأ — يرسمه ErrorBar بخط صغير. */
export const CODE_MARK = " · رمز: ";

/** النص العربي لردّ خطأ من الخادم. */
export function arabicError(status, body = {}) {
  const code = body?.error || "";
  if (ERROR_AR[code]) return ERROR_AR[code];
  if (status === 403) return "صلاحيتك لا تسمح بهذا الإجراء.";
  if (status === 401) return "انتهت الجلسة. سجّل الدخول من جديد.";
  if (status >= 500) return `صار خلل في الخادم. حاول بعد شوي.${code && code !== "internal_error" ? CODE_MARK + code : ""}`;
  if (body?.message && /[\u0600-\u06FF]/.test(body.message)) return body.message;
  return `تعذّر تنفيذ الطلب.${code ? CODE_MARK + code : status ? CODE_MARK + status : ""}`;
}

/** يفصل الرمز عن النص للعرض. */
export function splitCode(text) {
  const s = String(text || "");
  const i = s.lastIndexOf(CODE_MARK);
  return i < 0 ? { text: s, code: "" } : { text: s.slice(0, i), code: s.slice(i + CODE_MARK.length) };
}
