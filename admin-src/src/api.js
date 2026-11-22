/* ============================================================
   طبقة الشبكة.

   منقولة بسلوكها حرفياً عن الحزمة المنشورة قبل إعادة البناء:
   كوكي httpOnly (credentials: include)، وتجديد صامت مرة واحدة عند
   401، وحدث `kanaf-admin-session-expired` حين يفشل التجديد.

   لا رمز في localStorage إطلاقاً — اللوحة تُخدَم من نفس أصل الخادم
   عمداً، لأن كوكي SameSite=Strict لا يُرسل عبر المواقع مهما ضُبط
   CORS. هذا هو سبب استضافة اللوحة داخل Express نفسه.
   ============================================================ */
const BASE = "/admin";

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `request_failed_${status}`);
    this.status = status;
    this.body = body || {};
  }
  /** رسالة عربية مفهومة بدل رمز إنجليزي في وجه المستخدم. */
  get arabic() {
    const map = {
      insufficient_role: "صلاحيتك لا تسمح بهذا الإجراء.",
      reason_required: "لازم تكتب سبباً قبل هذا الإجراء.",
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
    };
    if (map[this.message]) return map[this.message];
    if (this.status === 403) return "صلاحيتك لا تسمح بهذا الإجراء.";
    if (this.status === 401) return "انتهت الجلسة. سجّل الدخول من جديد.";
    if (this.status >= 500) return "صار خلل في الخادم. حاول بعد شوي.";
    return this.body?.message || "تعذّر تنفيذ الطلب.";
  }
}

let refreshing = null;
function refreshOnce() {
  if (!refreshing) {
    refreshing = fetch(`${BASE}/auth/refresh`, { method: "POST", credentials: "include" })
      .then((r) => { if (!r.ok) throw new Error("refresh_failed"); })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function req(path, { method = "GET", body, params, retried = false, raw = null } = {}) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    });
  }
  const res = await fetch(url.toString(), {
    method,
    credentials: "include",
    /* raw: ملف كما هو (صورة) بنوعه — KANAF-ORD-0013 §4.3 */
    headers: { "Content-Type": raw ? (raw.type || "application/octet-stream") : "application/json" },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });

  if (res.status === 401 && !retried && path !== "/auth/refresh" && path !== "/auth/login") {
    try {
      await refreshOnce();
      return req(path, { method, body, params, retried: true, raw });
    } catch {
      window.dispatchEvent(new CustomEvent("kanaf-admin-session-expired"));
      throw new ApiError(401, { error: "session_expired" });
    }
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  /* ---------- المصادقة ---------- */
  login: (email, password) => req("/auth/login", { method: "POST", body: { email, password } }),
  logout: () => req("/auth/logout", { method: "POST" }),
  me: () => req("/auth/me"),

  /* ---------- نظرة عامة ---------- */
  overview: () => req("/overview"),

  /* ---------- المستخدمون ---------- */
  listUsers: (params) => req("/users", { params }),
  // KANAF-ORD-0008 §3 — السبب إلزامي ويُسجَّل في سجل الوصول
  listSentMessages: (params) => req("/sent-messages", { params }),
  listAbandonedCarts: (params) => req("/abandoned-carts", { params }), // KANAF-ORD-0008 §4
  // KANAF-ORD-0008 §6 — غير مربوطة بالدفع
  listDiscountCodes: (params) => req("/discount-codes", { params }),
  createDiscountCode: (body) => req("/discount-codes", { method: "POST", body }),
  setDiscountActive: (id, active, reason) => req(`/discount-codes/${id}/active`, { method: "POST", body: { active, reason } }),
  checkDiscountCode: (body) => req("/discount-codes/check", { method: "POST", body }),
  discountRedemptions: (id) => req(`/discount-codes/${id}/redemptions`),
  // KANAF-ORD-0008 §7 — اعتمادات لا تكامل؛ لا مسار يعيد سرّاً
  listIntegrations: () => req("/integrations"),
  setIntegrationKey: (service, key, value, reason) => req(`/integrations/${service}/${key}`, { method: "PUT", body: { value, reason } }),
  deleteIntegrationKey: (service, key, reason) => req(`/integrations/${service}/${key}`, { method: "DELETE", body: { reason } }),
  testIntegration: (service, reason) => req(`/integrations/${service}/test`, { method: "POST", body: { reason } }),
  getUser: (id) => req(`/users/${id}`),
  /* KANAF-ORD-0013 §4.3 — تعديل الملف بسبب يُسجَّل بالقيمتين */
  editUserProfile: (id, body) => req(`/users/${id}/profile`, { method: "PATCH", body }),
  setUserAvatar: (id, file, reason) => req(`/users/${id}/avatar`, { method: "PUT", raw: file, params: { reason } }),
  deleteUserAvatar: (id, reason) => req(`/users/${id}/avatar`, { method: "DELETE", params: { reason } }),
  editUserSubscription: (id, body) => req(`/users/${id}/subscription`, { method: "PATCH", body }),
  getUserActions: (id) => req(`/users/${id}/actions`),
  getUserSensitive: (id, reason) => req(`/users/${id}/sensitive`, { params: { reason } }),
  suspendUser: (id, reason) => req(`/users/${id}/suspend`, { method: "POST", body: { reason } }),
  restoreUser: (id, reason) => req(`/users/${id}/restore`, { method: "POST", body: { reason } }),
  cancelSubscription: (id, reason, atPeriodEnd) =>
    req(`/users/${id}/subscription/cancel`, { method: "POST", body: { reason, atPeriodEnd } }),
  refundSubscription: (id, reason, amountSar) =>
    req(`/users/${id}/subscription/refund`, { method: "POST", body: { reason, amountSar } }),

  /* ---------- الرسائل ---------- */
  // الصفحة تقول «أحدث 100 رسالة»؛ بلا pageSize كان الخادم يعيد 50 (افتراضيه)
  listMessages: () => req("/messages?pageSize=100"),
  setMessageStatus: (id, status) => req(`/messages/${id}/status`, { method: "POST", body: { status } }),

  /* ---------- المحتوى ---------- */
  listContent: (params) => req("/content", { params }),
  getContentItem: (type, key) => req(`/content/${encodeURIComponent(type)}/${encodeURIComponent(key)}`),
  reviewContent: (id, status, notes) => req(`/content/${id}/review`, { method: "POST", body: { status, notes } }),
  toggleContentLaunch: (id, enabled, reason) =>
    req(`/content/${id}/toggle-launch`, { method: "POST", body: { enabled, reason } }),
  updateContentPresentation: (type, key, patch) =>
    req(`/content/${encodeURIComponent(type)}/${encodeURIComponent(key)}/presentation`, { method: "PATCH", body: patch }),
  scheduleContent: (type, key, body) =>
    req(`/content/${encodeURIComponent(type)}/${encodeURIComponent(key)}/schedule`, { method: "POST", body }),
  bulkPublish: (body) => req("/content/bulk-publish", { method: "POST", body }),

  /* ---------- الإشعارات ---------- */
  listCampaigns: (params) => req("/notifications", { params }),
  getCampaign: (id) => req(`/notifications/${id}`),
  channelAvailability: () => req("/notifications-channels"),
  /* KANAF-ORD-0013 §6 */
  listSubscribers: (params) => req("/subscribers", { params }),
  subscriberRecipients: (params) => req("/subscribers/recipients", { params }),
  campaignDeliveries: (id, params) => req(`/notifications/${id}/deliveries`, { params }),
  audienceCount: (params) => req("/notifications/audience-count", { params }),
  createCampaign: (body) => req("/notifications", { method: "POST", body }),
  sendCampaign: (id, reason) => req(`/notifications/${id}/send`, { method: "POST", body: { reason } }),
  cancelCampaign: (id, reason) => req(`/notifications/${id}/cancel`, { method: "POST", body: { reason } }),
  schedulerStatus: () => req("/notifications-scheduler/status"),
  runSweep: () => req("/notifications-scheduler/sweep", { method: "POST" }),

  /* ---------- الباقات والضريبة ---------- */
  listPlans: () => req("/plans"),
  createPlan: (body) => req("/plans", { method: "POST", body }),
  updatePlan: (id, body) => req(`/plans/${id}`, { method: "PATCH", body }),
  togglePlanActive: (id, active, reason) => req(`/plans/${id}/toggle-active`, { method: "POST", body: { active, reason } }),
  getTaxSettings: () => req("/tax-settings"),
  saveTaxSettings: (body) => req("/tax-settings", { method: "PUT", body }),

  /* ---------- الفواتير ---------- */
  listInvoices: (params) => req("/invoices", { params }),
  regenerateInvoice: (id) => req(`/invoices/${id}/regenerate`, { method: "POST" }),
  invoicePdfUrl: (id) => `${BASE}/invoices/${id}/pdf`,
  listCreditNotes: () => req("/credit-notes"),
  creditNotePdfUrl: (id) => `${BASE}/credit-notes/${id}/pdf`,

  /* ---------- وصول الطوارئ وسجل الوصول ---------- */
  requestBreakGlass: (targetUserId, reason) =>
    req("/break-glass/request", { method: "POST", body: { targetUserId, reason } }),
  listPendingBreakGlass: () => req("/break-glass/pending"),
  approveBreakGlass: (id, hoursValid) =>
    req(`/break-glass/${id}/approve`, { method: "POST", body: { hoursValid } }),
  listAccessLog: (targetUserId, page) => req("/access-log", { params: { targetUserId, page } }),

  /* ---------- حسابات الإدارة ---------- */
  listAdminUsers: () => req("/admin-users"),
  /* دعوة لا إنشاء بكلمة مرور: الرد يحمل رابطاً لمرة واحدة، لا سرّاً
     دائماً يُسلَّم بقناة خارج النظام. */
  inviteAdminUser: (body) => req("/admin-users", { method: "POST", body }),
  updateAdminUser: (id, body) => req(`/admin-users/${id}`, { method: "PATCH", body }),
  resendInvite: (id, reason) => req(`/admin-users/${id}/resend-invite`, { method: "POST", body: { reason } }),
  resetAdminPassword: (id, reason) => req(`/admin-users/${id}/reset-password`, { method: "POST", body: { reason } }),

  /* ---------- قبول الدعوة وضبط كلمة المرور — بلا مصادقة ---------- */
  validateSetupToken: (token) => req("/setup/validate", { params: { token } }),
  acceptSetup: (token, password) => req("/setup/accept", { method: "POST", body: { token, password } }),

  /* ---------- المالية — /admin/billing/* — KANAF-ORD-0001 R15-09 ----------
     كانت هذه المسارات مبنية ومختبرة في الخادم بلا شاشة. */
  billingKpis: (params) => req("/billing/kpis", { params }),
  billingSubscriptions: (params) => req("/billing/subscriptions", { params }),
  billingPayments: (params) => req("/billing/payments", { params }),
  billingRefunds: (params) => req("/billing/refunds", { params }),
  refundPayment: (id, reason, amountSar) =>
    req(`/billing/payments/${id}/refund`, { method: "POST", body: { reason, amountSar } }),
  reconcilePayment: (id, reason) => req(`/billing/payments/${id}/reconcile`, { method: "POST", body: { reason } }),
  webhookEvents: (params) => req("/billing/webhook-events", { params }),
  webhookEvent: (id) => req(`/billing/webhook-events/${id}`),
  replayWebhookEvent: (id, reason) => req(`/billing/webhook-events/${id}/replay`, { method: "POST", body: { reason } }),
  billingIntegrity: () => req("/billing/integrity"),
  paymentHolds: (status) => req("/billing/payment-holds", { params: { status } }),
  recheckPaymentHold: (id, reason) => req(`/billing/payment-holds/${id}/recheck`, { method: "POST", body: { reason } }),
  dismissPaymentHold: (id, reason) => req(`/billing/payment-holds/${id}/dismiss`, { method: "POST", body: { reason } }),
  userBilling: (id) => req(`/billing/users/${id}/billing`),

  /* ---------- الإعدادات ---------- */
  settingsOverview: () => req("/settings/overview"),
  listAppSettings: () => req("/app-settings"),
  updateAppSetting: (key, value, reason) =>
    req(`/app-settings/${encodeURIComponent(key)}`, { method: "PUT", body: { value, reason } }),
  getBillingSettings: () => req("/billing/settings"),
  saveBillingSettings: (body) => req("/billing/settings", { method: "PUT", body }),

  /* ---------- سجل الإجراءات ---------- */
  listAuditLog: (params) => req("/audit-log", { params }),

  /* ---------- التصدير ----------
     رابط لا نداء fetch: الملف يُنزَّل من المتصفّح مباشرة فلا
     يُحمَّل في ذاكرة الصفحة، والكوكي يُرسَل تلقائياً لأنه نفس
     الأصل. ونفس معاملات الشاشة تُمرَّر حرفياً، فيطابق الملف ما
     تراه بالضبط. */
  exportUrl: (kind, params = {}) => {
    const u = new URL(`${BASE}/exports/${kind}.csv`, window.location.origin);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "" && v !== "all") u.searchParams.set(k, v);
    });
    return u.toString();
  },
};
