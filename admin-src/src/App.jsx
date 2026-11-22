import React, { useEffect, useState, useCallback } from "react";
import {
  LayoutDashboard, Users as UsersIcon, Mail, BookOpen, Bell, CreditCard,
  FileText, ShieldAlert, UserCog, ScrollText, LogOut, Menu, X,
  SlidersHorizontal, History, Wallet, Sun, Moon, Send, ShoppingCart, TicketPercent, Plug,
} from "lucide-react";
import { api } from "./api.js";
import { C, ROLE_LABEL, canAny, sectionTone, readTheme, applyTheme } from "./theme.js";
import { Spinner } from "./ui.jsx";
import { Link, navigate, useSegments } from "./router.js";

import Login from "./pages/Login.jsx";
import Overview from "./pages/Overview.jsx";
import Users from "./pages/Users.jsx";
import Messages from "./pages/Messages.jsx";
import Content from "./pages/Content.jsx";
import Notifications from "./pages/Notifications.jsx";
import Plans from "./pages/Plans.jsx";
import Invoices from "./pages/Invoices.jsx";
import Billing, { BILLING_PERMS } from "./pages/Billing.jsx";
import BreakGlass from "./pages/BreakGlass.jsx";
import AdminUsers from "./pages/AdminUsers.jsx";
import AccessLog from "./pages/AccessLog.jsx";
import AuditLog from "./pages/AuditLog.jsx";
import SettingsPage from "./pages/Settings.jsx";
import Setup from "./pages/Setup.jsx";
import SentMessages from "./pages/SentMessages.jsx";
import Carts from "./pages/Carts.jsx";
import Discounts from "./pages/Discounts.jsx";
import Integrations from "./pages/Integrations.jsx";

/* ============================================================
   هيكل اللوحة.

   ------------------------------------------------------------
   القائمة تُبنى من الصلاحيات لا من الرتبة
   ------------------------------------------------------------
   كان لكل قسم `min: "support"` وتُقارَن برتبة رقمية. وهو نموذج
   انكسر عملياً: مدير المحتوى رتبته أعلى من «دعم»، فكان يرى صفحة
   الباقات والمستخدمين والرسائل — ويصلها في الخادم أيضاً.

   الآن كل قسم يعلن الصلاحيات التي تفتحه، والقائمة تُرشَّح بما وصل
   من GET /admin/auth/me. اللوحة لا تعرف الأدوار إطلاقاً.

   ويبقى الأصل: الإخفاء راحة عين لا حماية. كل مسار في الخادم يفحص
   بنفسه ويردّ 403 لمن كتب العنوان يدوياً.
   ============================================================ */

/* ثلاث مجموعات كما في التصميم المرجعي (KANAF-ORD-0008 §2.1):
   المتابعة · التشغيل · الحوكمة. لون كل قسم ثابت: يتكرر في القائمة
   وفي بطاقة رقمه (sectionTone في theme.js). */
const GROUPS = [
  { key: "watch", label: "المتابعة" },
  { key: "ops",   label: "التشغيل" },
  { key: "gov",   label: "الحوكمة" },
];

const SECTIONS = [
  { key: "overview",     group: "watch", label: "نظرة عامة",     icon: LayoutDashboard,   perms: ["overview:view"] },
  { key: "users",        group: "watch", label: "المستخدمون",     icon: UsersIcon,         perms: ["users:view"] },
  { key: "messages",     group: "watch", label: "الرسائل",        icon: Mail,              perms: ["messages:view"] },
  { key: "sent",         group: "watch", label: "الرسائل المرسلة", icon: Send,              perms: ["notifications:view_sent"] },
  { key: "content",      group: "ops",   label: "المحتوى",        icon: BookOpen,          perms: ["content:view"] },
  { key: "notifications",group: "ops",   label: "الإشعارات والتسويق", icon: Bell,          perms: ["notifications:view"] },
  { key: "carts",        group: "ops",   label: "السلات المتروكة", icon: ShoppingCart,      perms: ["carts:view"] },
  { key: "plans",        group: "ops",   label: "الباقات",        icon: CreditCard,        perms: ["plans:view"] },
  { key: "discounts",    group: "ops",   label: "أكواد الخصم",    icon: TicketPercent,     perms: ["discounts:view"] },
  { key: "invoices",     group: "ops",   label: "الفواتير",       icon: FileText,          perms: ["invoices:view", "credit_notes:view"] },
  // KANAF-ORD-0001 R15-09 — الشاشات المالية التي كانت مبنية في الخادم بلا واجهة
  { key: "billing",      group: "ops",   label: "المالية",        icon: Wallet,            perms: BILLING_PERMS },
  { key: "break-glass",  group: "gov",   label: "الوصول الطارئ",  icon: ShieldAlert,       perms: ["break_glass:view", "break_glass:request"] },
  { key: "settings",     group: "gov",   label: "الإعدادات",      icon: SlidersHorizontal, perms: ["billing_settings:view", "tax_settings:view", "app_settings:view"] },
  { key: "integrations", group: "gov",   label: "التكاملات",      icon: Plug,              perms: ["integrations:manage"] },
  { key: "admin-users",  group: "gov",   label: "حسابات الإدارة", icon: UserCog,           perms: ["admins:view"] },
  { key: "audit-log",    group: "gov",   label: "سجل الإجراءات",  icon: History,           perms: ["audit_log:view_actions"] },
  { key: "access-log",   group: "gov",   label: "سجل الوصول",     icon: ScrollText,        perms: ["audit_log:view_reads"] },
];

/* زر الوضع — الفاتح افتراضي، والاختيار يُحفظ في هذا المتصفّح وحده. */
function ThemeToggle({ mode, onToggle }) {
  const dark = mode === "dark";
  return (
    <button onClick={onToggle} title={dark ? "الوضع الفاتح" : "الوضع الداكن"} aria-label={dark ? "الوضع الفاتح" : "الوضع الداكن"}
      className="rounded-xl p-2 shrink-0" style={{ background: C.surface, border: `1px solid ${C.line}`, color: C.textMuted }}>
      {dark ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
    </button>
  );
}

export default function App() {
  /* رابط الدعوة يصل بالشكل /?setup=TOKEN، ويصل صاحبه **قبل** أن
     يكون له حساب — فالشاشة تُقرأ من العنوان قبل أي محاولة استعادة
     جلسة. تُقرأ مرة واحدة عند الإقلاع فلا تختفي مع أول إعادة رسم. */
  const [setupToken, setSetupToken] = useState(
    () => new URLSearchParams(window.location.search).get("setup") || ""
  );
  const [me, setMe] = useState(null);
  const [booting, setBooting] = useState(true);
  /* KANAF-ORD-0013 §3.1: القسم من العنوان لا من الذاكرة — /<قسم>/<ما بعده> */
  const segments = useSegments();
  const section = segments[0] || "overview";
  const [navOpen, setNavOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [mode, setMode] = useState(readTheme);
  const toggleMode = () => setMode((m) => applyTheme(m === "dark" ? "light" : "dark"));

  const toast = useCallback((m) => {
    setToastMsg(m);
    window.setTimeout(() => setToastMsg((cur) => (cur === m ? "" : cur)), 4500);
  }, []);

  /* استعادة الجلسة من الكوكي — لا رمز في التخزين المحلي. */
  useEffect(() => {
    api.me().then((r) => setMe(r.admin)).catch(() => setMe(null)).finally(() => setBooting(false));
  }, []);

  /* انتهاء الجلسة يصل كحدث من طبقة الشبكة، فلا تبقى الشاشة معروضة
     وهي تفشل في كل طلب.

     الشرط `me` ليس تجميلاً: أول طلب عند الإقلاع يفشل بـ401 لمن لم
     يسجّل دخوله بعد، فينطلق الحدث نفسه — ولولا الشرط لظهرت
     «انتهت الجلسة» في وجه من لم تبدأ له جلسة أصلاً. */
  useEffect(() => {
    if (!me) return;
    const h = () => { setMe(null); toast("انتهت الجلسة. سجّل الدخول من جديد."); };
    window.addEventListener("kanaf-admin-session-expired", h);
    return () => window.removeEventListener("kanaf-admin-session-expired", h);
  }, [me, toast]);

  const allowed = SECTIONS.filter((s) => canAny(me, s.perms));

  /* قسم غير معروف أو خارج الصلاحية: إلى أول مسموح، بلا إضافة إلى سجلّ «رجوع». */
  useEffect(() => {
    if (me && !allowed.some((s) => s.key === section)) navigate(`/${allowed[0]?.key || "overview"}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, section]);

  const logout = async () => {
    try { await api.logout(); } catch { /* الخروج محلي على أي حال */ }
    setMe(null);
  };

  /* تُعرض قبل شاشة الدخول وقبل انتظار /auth/me: المدعوّ لا جلسة له
     أصلاً، وإظهار «سجّل الدخول» له طريق مسدود. */
  if (setupToken) {
    return (
      <Setup
        token={setupToken}
        onDone={() => {
          // ينظَّف العنوان حتى لا يبقى الرمز في شريط المتصفّح ولا في
          // سجل التصفّح بعد استعماله.
          window.history.replaceState({}, "", window.location.pathname);
          setSetupToken("");
        }}
      />
    );
  }

  if (booting) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: C.bg }}><Spinner /></div>;
  }
  /* بعد الدخول نبقى على العنوان المطلوب أصلاً: رابط مفضَّل يفتح الشاشة نفسها بعد تسجيل الدخول. */
  if (!me) return <Login onDone={(a) => setMe(a)} />;

  const Page = {
    overview: Overview,
    users: Users,
    messages: Messages,
    sent: SentMessages,
    carts: Carts,
    discounts: Discounts,
    integrations: Integrations,
    content: Content,
    notifications: Notifications,
    plans: Plans,
    invoices: Invoices,
    billing: Billing,
    "break-glass": BreakGlass,
    settings: SettingsPage,
    "admin-users": AdminUsers,
    "audit-log": AuditLog,
    "access-log": AccessLog,
  }[section] || Overview;

  const current = SECTIONS.find((s) => s.key === section);

  return (
    <div dir="rtl" className="min-h-screen" style={{ background: C.bg }}>
      {/* شريط علوي للشاشات الصغيرة */}
      <div className="lg:hidden sticky top-0 z-40 flex items-center justify-between gap-2 px-4 py-3"
        style={{ background: C.surface, borderBottom: `1px solid ${C.line}` }}>
        <button onClick={() => setNavOpen((v) => !v)} aria-label="القائمة">
          {navOpen ? <X size={18} color={C.text} /> : <Menu size={18} color={C.text} />}
        </button>
        <span className="text-sm font-bold" style={{ color: C.text }}>لوحة تنفس</span>
        <div className="flex items-center gap-2">
          <ThemeToggle mode={mode} onToggle={toggleMode} />
          <button onClick={logout} aria-label="خروج"><LogOut size={16} color={C.textMuted} /></button>
        </div>
      </div>

      <div className="flex">
        <aside
          className={`${navOpen ? "block" : "hidden"} lg:flex lg:flex-col fixed lg:sticky top-0 right-0 z-30 h-screen w-64 shrink-0 overflow-y-auto p-4`}
          style={{ background: C.surface, borderLeft: `1px solid ${C.line}` }}
        >
          <div className="hidden lg:flex items-center gap-2.5 mb-6 px-1">
            <img src="/favicon.svg" alt="" width="36" height="36" className="shrink-0" />
            <div className="min-w-0">
              <h1 className="text-base font-bold leading-tight" style={{ color: C.text }}>لوحة تنفس</h1>
              <p className="text-[11px] mt-0.5 truncate" style={{ color: C.textFaint }}>
                {me.name} · {ROLE_LABEL[me.role] || me.role}
              </p>
            </div>
          </div>

          <nav className="grid gap-4">
            {GROUPS.map((g) => {
              const items = allowed.filter((s) => s.group === g.key);
              if (items.length === 0) return null;
              return (
                <div key={g.key}>
                  <p className="text-[11px] font-bold px-3 mb-1.5" style={{ color: C.textFaint }}>{g.label}</p>
                  <div className="grid gap-0.5">
                    {items.map((s) => {
                      const Icon = s.icon;
                      const on = s.key === section;
                      const tone = sectionTone(s.key);
                      return (
                        <Link key={s.key} to={`/${s.key}`} onClick={() => setNavOpen(false)}
                          aria-current={on ? "page" : undefined}
                          className="flex items-center gap-2.5 px-2 py-1.5 rounded-xl text-[13px] font-bold text-right"
                          style={{ background: on ? C.tealSoft : "transparent", color: on ? C.text : C.textMuted }}>
                          <span className="rounded-lg p-1.5 shrink-0" style={{ background: tone.soft }}>
                            <Icon size={16} strokeWidth={1.75} color={tone.fg} />
                          </span>
                          {s.label}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </nav>

          <button onClick={logout}
            className="hidden lg:flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold w-full mt-auto pt-6"
            style={{ color: C.textFaint }}>
            <LogOut size={15} strokeWidth={1.75} /> خروج
          </button>
        </aside>

        <main className="flex-1 min-w-0">
          <div className="hidden lg:flex items-center justify-between gap-3 px-6 py-3"
            style={{ borderBottom: `1px solid ${C.line}`, background: C.surface }}>
            <div className="flex items-center gap-2 min-w-0">
              {current && (() => { const tone = sectionTone(current.key); const Icon = current.icon; return (
                <span className="rounded-lg p-1.5" style={{ background: tone.soft }}><Icon size={16} strokeWidth={1.75} color={tone.fg} /></span>
              ); })()}
              <span className="text-xs font-bold truncate" style={{ color: C.textMuted }}>{current?.label}</span>
            </div>
            <ThemeToggle mode={mode} onToggle={toggleMode} />
          </div>
          <div className="p-4 lg:p-6">
            {/* key: الانتقال بين قسمين يبدأ الصفحة من جديد؛ route: ما بعد اسم القسم في المسار */}
            <Page key={section} me={me} toast={toast} route={segments.slice(1)} />
          </div>
        </main>
      </div>

      {toastMsg && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 rounded-xl px-4 py-3 text-xs font-bold shadow-lg"
          style={{ background: C.surfaceAlt, color: C.text, border: `1px solid ${C.line}` }}>
          {toastMsg}
        </div>
      )}
    </div>
  );
}
