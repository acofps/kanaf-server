/* ============================================================
   توجيه اللوحة — KANAF-ORD-0013 §3.1

   كان التنقّل حالة في الذاكرة (useState("overview"))، فلا عنوان
   يتغيّر، ولا «فتح في علامة تبويب جديدة»، ولا رجوع/تقدّم.

   الآن:
   • لكل شاشة مسار: /<القسم>/<ما بعده>، وحالة الجداول في query string.
   • الروابط <a href> حقيقية. النقرة العادية تُعترض وتصير pushState،
     والنقرة بمفتاح تعديل أو بالزر الأوسط تُترك للمتصفّح — فيفتح
     الرابط في تبويب جديد كأي موقع.
   • 🔴 لا عنوان مطلق: كل href يبدأ بـ«/» من الأصل نفسه. اللوحة تُخدم
     من أكثر من أصل (admin.tanfs.net وonrender.com)، والرابط المطلق
     يرسل المتصفّح إلى أصل آخر فلا تُرسل كوكي SameSite=Strict.
   • لا مكتبة جديدة: بضعة أسطر فوق History API.
   ============================================================ */
import React, { useEffect, useState, useCallback } from "react";

const EVT = "tanfs-admin-navigate";

/** مسار نسبي من الأصل نفسه فقط. أي شيء آخر يُرفض بدل أن يُتبع. */
export function safePath(to) {
  const s = String(to || "/");
  if (!s.startsWith("/") || s.startsWith("//")) return "/";
  return s;
}

export function navigate(to, { replace = false } = {}) {
  const target = safePath(to);
  if (target === window.location.pathname + window.location.search) return;
  window.history[replace ? "replaceState" : "pushState"]({}, "", target);
  window.dispatchEvent(new Event(EVT));
}

function readLoc() {
  return { path: window.location.pathname, search: window.location.search };
}

export function useLocation() {
  const [loc, setLoc] = useState(readLoc);
  useEffect(() => {
    const h = () => setLoc(readLoc());
    window.addEventListener("popstate", h);
    window.addEventListener(EVT, h);
    return () => { window.removeEventListener("popstate", h); window.removeEventListener(EVT, h); };
  }, []);
  return loc;
}

/** أجزاء المسار: "/users/abc/billing" → ["users","abc","billing"] */
export function useSegments() {
  const { path } = useLocation();
  return path.split("/").filter(Boolean).map(decodeURIComponent);
}

/** رابط حقيقي. النقرة العادية داخل التطبيق، وما عداها للمتصفّح. */
export function Link({ to, children, onClick, replace, ...rest }) {
  const href = safePath(to);
  const handle = (e) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // تبويب/نافذة جديدة: للمتصفّح
    if (rest.target && rest.target !== "_self") return;
    e.preventDefault();
    navigate(href, { replace });
  };
  return React.createElement("a", { href, onClick: handle, ...rest }, children);
}

/* ------------------------------------------------------------
   حالة في العنوان. useQueryState("page", 1) يعمل كـuseState، لكن
   قيمته في ?page=… فالرابط المنسوخ يفتح الشاشة نفسها بفلاترها.
   القيمة الافتراضية لا تُكتب في العنوان (عنوان نظيف).
   التحديث replaceState: الكتابة في مربّع البحث لا تملأ سجلّ «رجوع».
   ------------------------------------------------------------ */
export function useQueryState(key, initial) {
  const { search } = useLocation();
  const raw = new URLSearchParams(search).get(key);
  const isNum = typeof initial === "number";
  const value = raw === null ? initial : isNum ? (Number.isFinite(Number(raw)) ? Number(raw) : initial) : raw;
  const set = useCallback((next) => {
    const p = new URLSearchParams(window.location.search);
    const cur = p.get(key);
    const curVal = cur === null ? initial : isNum ? Number(cur) : cur;
    const v = typeof next === "function" ? next(curVal) : next;
    if (v === initial || v === "" || v === null || v === undefined) p.delete(key); else p.set(key, String(v));
    const qs = p.toString();
    navigate(window.location.pathname + (qs ? `?${qs}` : ""), { replace: true });
  }, [key, initial, isNum]);
  return [value, set];
}

/** يبني مساراً مع query: href("/users", {page:2}) → "/users?page=2" */
export function href(path, query = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const qs = p.toString();
  return safePath(path) + (qs ? `?${qs}` : "");
}
