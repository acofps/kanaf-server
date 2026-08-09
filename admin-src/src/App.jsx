import React, { useEffect, useState, useCallback } from "react";
import {
  LayoutDashboard, Users as UsersIcon, Mail, BookOpen, Bell, CreditCard,
  FileText, ShieldAlert, UserCog, ScrollText, LogOut, Menu, X,
} from "lucide-react";
import { api } from "./api.js";
import { C, ROLE_LABEL, atLeast } from "./theme.js";
import { Spinner } from "./ui.jsx";

import Login from "./pages/Login.jsx";
import Overview from "./pages/Overview.jsx";
import Users from "./pages/Users.jsx";
import Messages from "./pages/Messages.jsx";
import Content from "./pages/Content.jsx";
import Notifications from "./pages/Notifications.jsx";
import Plans from "./pages/Plans.jsx";
import Invoices from "./pages/Invoices.jsx";
import BreakGlass from "./pages/BreakGlass.jsx";
import AdminUsers from "./pages/AdminUsers.jsx";
import AccessLog from "./pages/AccessLog.jsx";

/* ============================================================
   هيكل اللوحة.

   القائمة تُخفي ما لا تصله صلاحيتك — لكن الإخفاء راحة عين لا
   حماية. الحماية في الخادم: كل مسار يفحص الدور بنفسه، ومن يكتب
   العنوان يدوياً يقابله 403 لا صفحة.
   ============================================================ */

const SECTIONS = [
  { key: "overview",     label: "نظرة عامة",      icon: LayoutDashboard, min: "support" },
  { key: "users",        label: "المستخدمون",      icon: UsersIcon,       min: "support" },
  { key: "messages",     label: "الرسائل",         icon: Mail,            min: "support" },
  { key: "content",      label: "المحتوى",         icon: BookOpen,        min: "content_manager" },
  { key: "notifications",label: "الإشعارات",       icon: Bell,            min: "admin" },
  { key: "plans",        label: "الباقات",         icon: CreditCard,      min: "support" },
  { key: "invoices",     label: "الفواتير",        icon: FileText,        min: "admin" },
  { key: "break-glass",  label: "الوصول الطارئ",   icon: ShieldAlert,     min: "admin" },
  { key: "admin-users",  label: "حسابات الإدارة",  icon: UserCog,         min: "owner" },
  { key: "access-log",   label: "سجل الوصول",      icon: ScrollText,      min: "owner" },
];

export default function App() {
  const [me, setMe] = useState(null);
  const [booting, setBooting] = useState(true);
  const [section, setSection] = useState("overview");
  const [navOpen, setNavOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState("");

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

  const allowed = SECTIONS.filter((s) => atLeast(me?.role, s.min));

  /* لو تغيّرت الصلاحية وصار القسم المفتوح خارجها، نعود لأول مسموح. */
  useEffect(() => {
    if (me && !allowed.some((s) => s.key === section)) setSection(allowed[0]?.key || "overview");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const logout = async () => {
    try { await api.logout(); } catch { /* الخروج محلي على أي حال */ }
    setMe(null);
  };

  if (booting) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: C.bg }}><Spinner /></div>;
  }
  if (!me) return <Login onDone={(a) => { setMe(a); setSection("overview"); }} />;

  const Page = {
    overview: Overview,
    users: Users,
    messages: Messages,
    content: Content,
    notifications: Notifications,
    plans: Plans,
    invoices: Invoices,
    "break-glass": BreakGlass,
    "admin-users": AdminUsers,
    "access-log": AccessLog,
  }[section] || Overview;

  return (
    <div dir="rtl" className="min-h-screen" style={{ background: C.bg }}>
      {/* شريط علوي للشاشات الصغيرة */}
      <div className="lg:hidden sticky top-0 z-40 flex items-center justify-between px-4 py-3"
        style={{ background: C.surface, borderBottom: `1px solid ${C.line}` }}>
        <button onClick={() => setNavOpen((v) => !v)}>
          {navOpen ? <X size={18} color={C.text} /> : <Menu size={18} color={C.text} />}
        </button>
        <span className="text-sm font-bold" style={{ color: C.text }}>لوحة كنف</span>
        <button onClick={logout}><LogOut size={16} color={C.textMuted} /></button>
      </div>

      <div className="flex">
        <aside
          className={`${navOpen ? "block" : "hidden"} lg:block fixed lg:sticky top-0 right-0 z-30 h-screen w-64 shrink-0 overflow-y-auto p-4`}
          style={{ background: C.surface, borderLeft: `1px solid ${C.line}` }}
        >
          <div className="hidden lg:block mb-6">
            <h1 className="text-base font-bold" style={{ color: C.text }}>لوحة كنف</h1>
            <p className="text-[11px] mt-1" style={{ color: C.textFaint }}>
              {me.name} · {ROLE_LABEL[me.role] || me.role}
            </p>
          </div>

          <nav className="grid gap-1">
            {allowed.map((s) => {
              const Icon = s.icon;
              const on = s.key === section;
              return (
                <button key={s.key} onClick={() => { setSection(s.key); setNavOpen(false); }}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-right"
                  style={{ background: on ? C.tealSoft : "transparent", color: on ? C.teal : C.textMuted }}>
                  <Icon size={15} />
                  {s.label}
                </button>
              );
            })}
          </nav>

          <button onClick={logout}
            className="hidden lg:flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold w-full mt-6"
            style={{ color: C.textFaint }}>
            <LogOut size={15} /> خروج
          </button>
        </aside>

        <main className="flex-1 min-w-0 p-4 lg:p-6">
          <Page role={me.role} me={me} toast={toast} />
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
