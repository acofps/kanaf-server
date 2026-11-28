/* ============================================================
   طبقة الشبكة.

   منقولة بسلوكها حرفياً عن الحزمة المنشورة قبل إعادة البناء:
   كوكي httpOnly (credentials: include)، وتجديد صامت مرة واحدة عند
   401، وحدث `kanaf-admin-session-expired` حين يفشل التجديد.

   لا رمز في localStorage إطلاقاً — اللوحة تُخدَم من نفس أصل الخادم
   عمداً، لأن كوكي SameSite=Strict لا يُرسل عبر المواقع مهما ضُبط
   CORS. هذا هو سبب استضافة اللوحة داخل Express نفسه.
   ============================================================ */
import { arabicError } from "./errors.js";

const BASE = "/admin";

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `request_failed_${status}`);
    this.status = status;
    this.body = body || {};
  }
  /** رسالة عربية مفهومة بدل رمز إنجليزي في وجه المستخدم (errors.js). */
  get arabic() { return arabicError(this.status, { ...this.body, error: this.message }); }
  get code() { return this.message; }
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
  userRecipients: (params) => req("/users/recipients", { params }),
  // KANAF-ORD-0008 §3 — السبب إلزامي ويُسجَّل في سجل الوصول
  listSentMessages: (params) => req("/sent-messages", { params }),
  listAbandonedCarts: (params) => req("/abandoned-carts", { params }), // KANAF-ORD-0008 §4
  // KANAF-ORD-0008 §6 — غير مربوطة بالدفع
  listDiscountCodes: (params) => req("/discount-codes", { params }),
  createDiscountCode: (body) => req("/discount-codes", { method: "POST", body }),
  setDiscountActive: (id, active) => req(`/discount-codes/${id}/active`, { method: "POST", body: { active } }),
  checkDiscountCode: (body) => req("/discount-codes/check", { method: "POST", body }),
  discountRedemptions: (id) => req(`/discount-codes/${id}/redemptions`),
  // KANAF-ORD-0008 §7 — اعتمادات لا تكامل؛ لا مسار يعيد سرّاً
  listIntegrations: () => req("/integrations"),
  setIntegrationKey: (service, key, value) => req(`/integrations/${service}/${key}`, { method: "PUT", body: { value } }),
  deleteIntegrationKey: (service, key) => req(`/integrations/${service}/${key}`, { method: "DELETE" }),
  testIntegration: (service) => req(`/integrations/${service}/test`, { method: "POST" }),
  getUser: (id) => req(`/users/${id}`),
  /* KANAF-ORD-0013 §4.3 — تعديل الملف يُسجَّل بالقيمتين، والسبب تلقائي من الخادم (ملحق القرار 1) */
  editUserProfile: (id, body) => req(`/users/${id}/profile`, { method: "PATCH", body }),
  /* KANAF-ORD-0023 ب-3: للكتابة فقط — الردّ لا يحمل الكلمة. */
  setUserPassword: (id, password) => req(`/users/${id}/password`, { method: "POST", body: { password } }),
  setUserAvatar: (id, file) => req(`/users/${id}/avatar`, { method: "PUT", raw: file }),
  deleteUserAvatar: (id) => req(`/users/${id}/avatar`, { method: "DELETE" }),
  editUserSubscription: (id, body) => req(`/users/${id}/subscription`, { method: "PATCH", body }),
  getUserActions: (id) => req(`/users/${id}/actions`),
  getUserSensitive: (id) => req(`/users/${id}/sensitive`),
  suspendUser: (id) => req(`/users/${id}/suspend`, { method: "POST" }),
  restoreUser: (id) => req(`/users/${id}/restore`, { method: "POST" }),
  cancelSubscription: (id, atPeriodEnd) =>
    req(`/users/${id}/subscription/cancel`, { method: "POST", body: { atPeriodEnd } }),
  refundSubscription: (id, amountSar) =>
    req(`/users/${id}/subscription/refund`, { method: "POST", body: { amountSar } }),

  /* ---------- الرسائل ---------- */
  // الصفحة تقول «أحدث 100 رسالة»؛ بلا pageSize كان الخادم يعيد 50 (افتراضيه)
  listMessages: () => req("/messages?pageSize=100"),
  setMessageStatus: (id, status) => req(`/messages/${id}/status`, { method: "POST", body: { status } }),

  /* ---------- المحتوى ---------- */
  listContent: (params) => req("/content", { params }),
  getContentItem: (type, key) => req(`/content/${encodeURIComponent(type)}/${encodeURIComponent(key)}`),
  reviewContent: (id, status, notes) => req(`/content/${id}/review`, { method: "POST", body: { status, notes } }),
  toggleContentLaunch: (id, enabled) =>
    req(`/content/${id}/toggle-launch`, { method: "POST", body: { enabled } }),
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
  /* KANAF-ORD-0013 §5 */
  createAdminDirect: (body) => req("/admin-users/direct", { method: "POST", body }),
  updateAdminPages: (id, body) => req(`/admin-users/${id}/pages`, { method: "PATCH", body }),
  /* KANAF-ORD-0013 §11 */
  listSystemErrors: (params) => req("/system-errors", { params }),
  clearSystemError: (id) => req(`/system-errors/${id}`, { method: "DELETE" }),
  /* KANAF-ORD-0013 §7.8 */
  userAutorenew: (id) => req(`/users/${id}/autorenew`),
  disableUserAutorenew: (id) => req(`/users/${id}/autorenew/disable`, { method: "POST" }),
  listAutorenewCycles: (params) => req("/autorenew", { params }),
  /* KANAF-ORD-0013 §9 */
  messageCatalog: () => req("/message-catalog"),
  saveMessage: (key, body) => req(`/message-catalog/${key}`, { method: "PUT", body }),
  resetMessage: (key) => req(`/message-catalog/${key}`, { method: "DELETE" }),
  previewMessage: (key, body) => req(`/message-catalog/${key}/preview`, { method: "POST", body }),
  testSendMessage: (key, body) => req(`/message-catalog/${key}/test-send`, { method: "POST", body }),
  createTemplate: (body) => req("/message-templates", { method: "POST", body }),
  updateTemplate: (id, body) => req(`/message-templates/${id}`, { method: "PUT", body }),
  deleteTemplate: (id) => req(`/message-templates/${id}`, { method: "DELETE" }),
  /* KANAF-ORD-0013 §8 */
  listCancelledMembers: (params) => req("/cancelled-members", { params }),
  purgeMember: (id) => req(`/users/${id}/purge`, { method: "POST", body: { confirm: "PURGE" } }),
  campaignDeliveries: (id, params) => req(`/notifications/${id}/deliveries`, { params }),
  audienceCount: (params) => req("/notifications/audience-count", { params }),
  createCampaign: (body) => req("/notifications", { method: "POST", body }),
  sendCampaign: (id) => req(`/notifications/${id}/send`, { method: "POST" }),
  cancelCampaign: (id) => req(`/notifications/${id}/cancel`, { method: "POST" }),
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
  listAccessLog: (targetUserId, page) => req("/access-log", { params: { targetUserId, page } }),

  /* ---------- حسابات الإدارة ---------- */
  listAdminUsers: () => req("/admin-users"),
  /* دعوة لا إنشاء بكلمة مرور: الرد يحمل رابطاً لمرة واحدة، لا سرّاً
     دائماً يُسلَّم بقناة خارج النظام. */
  inviteAdminUser: (body) => req("/admin-users", { method: "POST", body }),
  updateAdminUser: (id, body) => req(`/admin-users/${id}`, { method: "PATCH", body }),
  resendInvite: (id) => req(`/admin-users/${id}/resend-invite`, { method: "POST" }),
  resetAdminPassword: (id) => req(`/admin-users/${id}/reset-password`, { method: "POST" }),

  /* ---------- قبول الدعوة وضبط كلمة المرور — بلا مصادقة ---------- */
  validateSetupToken: (token) => req("/setup/validate", { params: { token } }),
  acceptSetup: (token, password) => req("/setup/accept", { method: "POST", body: { token, password } }),

  /* ---------- المالية — /admin/billing/* — KANAF-ORD-0001 R15-09 ----------
     كانت هذه المسارات مبنية ومختبرة في الخادم بلا شاشة. */
  billingKpis: (params) => req("/billing/kpis", { params }),
  billingSubscriptions: (params) => req("/billing/subscriptions", { params }),
  billingPayments: (params) => req("/billing/payments", { params }),
  billingRefunds: (params) => req("/billing/refunds", { params }),
  billingInvoices: (params) => req("/billing/invoices", { params }),     // KANAF-ORD-0015 §2.7: الفلتر المشترك مع التصدير
  billingCreditNotes: (params) => req("/billing/credit-notes", { params }),
  refundPayment: (id, amountSar) =>
    req(`/billing/payments/${id}/refund`, { method: "POST", body: { amountSar } }),
  reconcilePayment: (id) => req(`/billing/payments/${id}/reconcile`, { method: "POST" }),
  webhookEvents: (params) => req("/billing/webhook-events", { params }),
  webhookEvent: (id) => req(`/billing/webhook-events/${id}`),
  replayWebhookEvent: (id) => req(`/billing/webhook-events/${id}/replay`, { method: "POST" }),
  billingIntegrity: () => req("/billing/integrity"),
  paymentHolds: (status) => req("/billing/payment-holds", { params: { status } }),
  recheckPaymentHold: (id) => req(`/billing/payment-holds/${id}/recheck`, { method: "POST" }),
  dismissPaymentHold: (id) => req(`/billing/payment-holds/${id}/dismiss`, { method: "POST" }),
  userBilling: (id) => req(`/billing/users/${id}/billing`),

  /* ---------- الإعدادات ---------- */
  settingsOverview: () => req("/settings/overview"),
  listAppSettings: () => req("/app-settings"),
  updateAppSetting: (key, value) =>
    req(`/app-settings/${encodeURIComponent(key)}`, { method: "PUT", body: { value } }),
  /* KANAF-ORD-0022 ب-4: «واجهة الموقع» — روابط tanfs.net ونصّاها القانونيان */
  siteFront: () => req("/site-front"),
  saveSiteFront: (values) => req("/site-front", { method: "PUT", body: { values } }),
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
