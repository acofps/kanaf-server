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

async function req(path, { method = "GET", body, params, retried = false } = {}) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    });
  }
  const res = await fetch(url.toString(), {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !retried && path !== "/auth/refresh" && path !== "/auth/login") {
    try {
      await refreshOnce();
      return req(path, { method, body, params, retried: true });
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
  getUser: (id) => req(`/users/${id}`),
  getUserActions: (id) => req(`/users/${id}/actions`),
  getUserSensitive: (id, reason) => req(`/users/${id}/sensitive`, { params: { reason } }),
  suspendUser: (id, reason) => req(`/users/${id}/suspend`, { method: "POST", body: { reason } }),
  restoreUser: (id, reason) => req(`/users/${id}/restore`, { method: "POST", body: { reason } }),
  cancelSubscription: (id, reason, atPeriodEnd) =>
    req(`/users/${id}/subscription/cancel`, { method: "POST", body: { reason, atPeriodEnd } }),
  refundSubscription: (id, reason, amountSar) =>
    req(`/users/${id}/subscription/refund`, { method: "POST", body: { reason, amountSar } }),

  /* ---------- الرسائل ---------- */
  listMessages: () => req("/messages"),
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
  togglePlanActive: (id, active) => req(`/plans/${id}/toggle-active`, { method: "POST", body: { active } }),
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
