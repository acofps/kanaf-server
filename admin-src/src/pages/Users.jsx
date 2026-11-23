import React, { useState, useEffect } from "react";
import { Eye, Ban, RotateCcw, ShieldAlert, ScrollText, CreditCard, Download, User as UserIcon, Bell, Compass, Mail, Smartphone, MessageCircle, MessageSquare, ExternalLink } from "lucide-react";
import { api } from "../api.js";
import { C, can, fmtDate, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Field, Input, Select, SearchBox, Spinner, Empty,
  ErrorBar, Screen, ConfirmPrompt, Table, Tr, Td, Pager, useAsync, ValueDiff,
} from "../ui.jsx";
import { Link, useQueryState, navigate, href } from "../router.js";
import { Compose } from "./Notifications.jsx";

/* ============================================================
   المستخدمون.

   الحد الفاصل في هذه الشاشة ليس ما يظهر، بل ما لا يظهر:
   نص اليومية، وإجابات المقاييس التفصيلية، ومحتوى الدفاتر
   وجلسات تنفس بحرية — كلها **لا تصل إلى المتصفح أصلاً**، لأن إخفاءها
   في الواجهة يبقى كشفاً في الشبكة.

   وما يظهر منها (درجات المتابعة) يمر بتأكيد بنقرة، ويُكتب في سجل
   تدقيق غير قابل للتعديل **قبل** تنفيذ القراءة.
   ============================================================ */

/* ------------------------------------------------------------
   صورة المستخدم.

   العنوان مبنيّ هنا لا في api.js عمداً: هذه ليست نداء fetch بل
   src لوسم img. واللوحة تُخدَم من **نفس أصل** الخادم (السبب مكتوب
   في رأس api.js)، فكوكي الجلسة يُرسل مع طلب الصورة تلقائياً بلا
   أي ترويسة يدوية.

   وعند غياب الصورة يردّ الخادم 404 نظيفة، فنرسم البديل بدل صورة
   مكسورة — والمرحلة تطلب ذلك نصّاً. onError هو ما يلتقط ذلك:
   الطلب لا يمكن قراءة حالته من وسم img.
   ------------------------------------------------------------ */
function Avatar({ id, name, size = 28, hasPhoto = true }) {
  const [failed, setFailed] = useState(false);
  const initial = (name || "").trim().charAt(0) || "؟";
  const box = {
    width: size, height: size, borderRadius: "50%",
    background: C.surfaceAlt, color: C.textMuted,
    display: "flex", alignItems: "center", justifyContent: "center",
    overflow: "hidden", flexShrink: 0,
    fontSize: Math.round(size * 0.42), fontWeight: 700,
  };
  if (!hasPhoto || failed) return <div style={box}>{initial}</div>;
  return (
    <div style={box}>
      <img
        src={`/admin/users/${id}/avatar`}
        alt=""
        width={size} height={size}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/* أسماء الدول من الخادم لا من قائمة في اللوحة.

   نفس المبدأ المطبَّق في التطبيق: قائمة هنا وقائمة هناك تختلفان
   يوماً، فيظهر رمز الدولة خاماً أو باسم خاطئ. تُقرأ مرة واحدة في
   عمر الصفحة وتُخزَّن في الوحدة. */
let COUNTRY_CACHE = null;
function useCountryNames() {
  const [map, setMap] = useState(COUNTRY_CACHE);
  useEffect(() => {
    if (COUNTRY_CACHE) return;
    let alive = true;
    fetch("/api/countries")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !alive) return;
        COUNTRY_CACHE = Object.fromEntries((d.countries || []).map((c) => [c.code, c.name]));
        setMap(COUNTRY_CACHE);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  // الرمز نفسه احتياطاً: عرض "SA" أصدق من عرض فراغ.
  return (code) => (code ? (map?.[code] || code) : null);
}

const ACCOUNT_STATUS = {
  active: { label: "نشط", color: "green" },
  suspended: { label: "موقوف", color: "crisis" },
  pending_verification: { label: "بانتظار التفعيل", color: "amber" },
  deleted: { label: "محذوف", color: "textFaint" },
};

export default function Users({ me, toast, route = [] }) {
  /* KANAF-ORD-0013 §3/§4.1: الملف صفحة بعنوانها /users/<id>/<تبويب> */
  if (route[0] === "message") return <BulkMessage toast={toast} />;
  if (route[0]) return <UserDetail id={route[0]} tab={route[1] || "profile"} me={me} toast={toast} />;
  return <UsersList me={me} />;
}

/* ============================================================
   قائمة المستخدمين — KANAF-ORD-0015 §2.5 (KANAF-DESIGN-USERS-TABLE)

   • شريط مراسلة جماعية أعلى الصفحة، وسطر يقول صراحةً إلى من سيُرسَل:
     لا أحد محدَّد → كل الأعضاء المعروضين **بالفلتر المطبَّق** (عددهم من الخادم)،
     أو N عضواً محدَّداً. المستلمون يُجمَّدون من الخادم بالشرط نفسه الذي تُبنى به
     القائمة (/users/recipients) ويُتحقق من عددهم عند الإرسال.
   • وفي كل سطر أيقونات المراسلة الفردية بلون قناتها. القناة غير المهيّأة تُرسم مطفأةً
     مع سببها ولا تُخفى — والحالة والسبب من channelAvailability() كما هما، فتضيء
     القناة من نفسها حين تُضبط بياناتها بلا نشر جديد.
   • كل أيقونة زرٌّ حقيقي باسم مقروء يذكر العضو والقناة، ولمسه 44 بكسل.
   ============================================================ */
export const CHANNEL_ORDER = ["email", "in_app", "push", "whatsapp", "sms"];
const CH = {
  email: { label: "بريد إلكتروني", verb: (n) => `مراسلة ${n} بالبريد`, Icon: Mail },
  in_app: { label: "إشعار داخلي", verb: (n) => `إشعار داخلي إلى ${n}`, Icon: Bell },
  push: { label: "إشعار الجهاز", verb: (n) => `إشعار جهاز إلى ${n}`, Icon: Smartphone },
  whatsapp: { label: "واتساب", verb: (n) => `واتساب إلى ${n}`, Icon: MessageCircle },
  sms: { label: "رسائل نصية", verb: (n) => `رسالة نصية إلى ${n}`, Icon: MessageSquare },
};
const chStyle = (ch, off) => off
  ? { background: "var(--ch-off-soft)", color: "var(--ch-off)", border: "1.5px dashed var(--ch-off-line)", cursor: "not-allowed" }
  : { background: `var(--ch-${ch}-soft)`, color: `var(--ch-${ch})`, border: "1.5px solid transparent" };
const chFill = (ch, off) => off
  ? { background: "var(--ch-off-soft)", color: "var(--ch-off)", border: "1.5px dashed var(--ch-off-line)", cursor: "not-allowed" }
  : { background: `var(--ch-${ch})`, color: "var(--surface)", border: "1.5px solid transparent" };

/* لون الصورة الرمزية ثابت للاسم نفسه (لا عشوائي بين التحديثات). */
const AVATAR_TONES = ["var(--ch-email)", "var(--ch-push)", "var(--ch-sms)", "var(--ch-in_app)", "var(--sec-content)", "var(--sec-discounts)"];
function InitialAvatar({ id, name, hasPhoto }) {
  const [failed, setFailed] = useState(false);
  const tone = AVATAR_TONES[[...String(id || name || "")].reduce((a, c) => (a + c.charCodeAt(0)) % 997, 0) % AVATAR_TONES.length];
  const box = { width: 40, height: 40, borderRadius: 12, flex: "0 0 auto", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
    background: tone, color: "var(--surface)", fontWeight: 700, fontSize: 16 };
  if (hasPhoto && !failed) {
    return <div style={box}><img src={`/admin/users/${id}/avatar`} alt="" width={40} height={40} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={() => setFailed(true)} /></div>;
  }
  return <div style={box} aria-hidden="true">{(name || "").trim().charAt(0) || "؟"}</div>;
}

const SUB_TONE = { active: "green", trialing: "green", canceling: "amber", canceled_at_period_end: "amber", past_due: "amber", expired: "crisis", canceled: "crisis" };
const SUB_LABEL = { active: "نشط", trialing: "تجريبي", canceling: "ملغى بنهاية المدة", canceled_at_period_end: "ملغى بنهاية المدة", past_due: "متأخر", expired: "منتهٍ", canceled: "ملغى" };
function Pill({ tone = "textMuted", dot = false, children }) {
  const fg = { green: C.green, amber: C.amber, crisis: C.crisis, accent: C.teal, textMuted: C.textMuted }[tone] || C.textMuted;
  const bg = { green: C.greenSoft, amber: C.amberSoft, crisis: C.crisisSoft, accent: C.tealSoft, textMuted: C.surfaceAlt }[tone] || C.surfaceAlt;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold whitespace-nowrap" style={{ background: bg, color: fg }}>
      {dot && <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", background: fg }} />}{children}
    </span>
  );
}

function UsersList({ me }) {
  /* الفلاتر في العنوان: الرابط المنسوخ يفتح القائمة نفسها (§3.1) */
  const [search, setSearch] = useQueryState("q", "");
  const [status, setStatus] = useQueryState("status", "all");
  const [subscription, setSubscription] = useQueryState("sub", "all");
  const [sort, setSort] = useQueryState("sort", "created_at");
  const [dir, setDir] = useQueryState("dir", "desc");
  const [page, setPage] = useQueryState("page", 1);
  const [selected, setSelected] = useState([]);
  const pageSize = 25;

  const state = useAsync(
    () => api.listUsers({ search, status, subscription, sort, dir, page, pageSize }),
    [search, status, subscription, sort, dir, page]
  );
  const av = useAsync(() => api.channelAvailability(), []);
  const channels = av.data?.channels || {};
  // تغيير الفلتر يفرّغ التحديد: محدَّدٌ خارج المعروض لا يُرسَل إليه خلسة.
  useEffect(() => { setSelected([]); }, [search, status, subscription]);

  const rows = state.data?.users || [];
  const total = state.data?.total;
  const canSend = can(me, "notifications:send");
  const filtered = search || status !== "all" || subscription !== "all";
  const filters = { q: search, status, sub: subscription };

  const target = selected.length
    ? `ترسل إلى ${selected.length} ${selected.length === 1 ? "عضو محدَّد" : "عضواً محدَّداً"}.`
    : total == null ? "…"
    : `لا أحد محدَّد ← ترسل إلى كل الأعضاء المعروضين${filtered ? " بالفلتر المطبَّق" : ""} (${total}).`;

  const bulk = (ch) => {
    if (selected.length) {
      let token = "";
      try { token = `s${Date.now().toString(36)}`; sessionStorage.setItem(`kanaf-sel-${token}`, JSON.stringify(selected)); } catch { token = ""; }
      navigate(href("/users/message", { ...filters, channel: ch, sel: token || undefined, ids: token ? undefined : selected.join(",") }));
    } else {
      navigate(href("/users/message", { ...filters, channel: ch }));
    }
  };

  return (
    /* minmax(0,1fr): عنصر الشبكة لا ينكمش دون عرض محتواه، فكان أدنى عرض الجدول (1020) يمدّ الصفحة كلها على الجوال */
    <div className="grid gap-5" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <PageTitle title="المستخدمون" subtitle="البحث يقبل الاسم أو البريد أو معرّف المستخدم كاملاً.">
        <div className="flex gap-2.5 items-center flex-wrap">
          <Stat value={total} label={filtered ? "عضواً بالفلتر" : "عضواً"} />
          <Stat value={state.data?.activeTotal} label="مشترك فعّال" tone={C.green} />
          {/* الرابط يحمل **نفس** معاملات الشاشة، فالملف يطابق ما تراه بالضبط. */}
          {can(me, "exports:users") && (
            <a href={api.exportUrl("users", { search, status, subscription })} className="kt-act inline-flex items-center gap-1.5 rounded-xl px-4 text-[13px] font-bold"
              style={{ minHeight: 44, border: `1px solid ${C.line}`, background: C.surface, color: C.text }}>
              <Download size={14} /> تصدير المعروض
            </a>
          )}
        </div>
      </PageTitle>

      {canSend && (
        <section aria-labelledby="bulk-h" className="rounded-2xl px-5 py-4 flex flex-wrap gap-4 items-center justify-between"
          style={{ background: C.surface, border: `1px solid ${C.line}` }}>
          <div style={{ minWidth: 220 }}>
            <h2 id="bulk-h" className="text-[15px] font-bold mb-1" style={{ color: C.text }}>مراسلة جماعية</h2>
            <p className="text-[13px]" style={{ color: C.textMuted }} data-bulk-target>{target}</p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            {CHANNEL_ORDER.map((ch) => {
              const st = channels[ch]; const off = !st || !st.ok; const { Icon } = CH[ch];
              return (
                <button key={ch} type="button" className="kt-act inline-flex items-center gap-2 rounded-xl px-4 text-[14px] font-bold"
                  style={{ minHeight: 44, ...chFill(ch, off) }} disabled={off || total === 0}
                  title={off ? (st?.reason || "جارٍ التحقق من القناة…") : ""}
                  aria-label={off ? `${CH[ch].label} — غير مفعّل: ${st?.reason || ""}` : `${CH[ch].label} — ${target}`}
                  onClick={() => bulk(ch)}>
                  <Icon size={17} aria-hidden="true" /> {CH[ch].label}{off ? " · غير مفعّل" : ""}
                </button>
              );
            })}
          </div>
          {CHANNEL_ORDER.some((ch) => channels[ch] && !channels[ch].ok) && (
            <ul className="w-full text-[11px] leading-6" style={{ color: C.textFaint }}>
              {CHANNEL_ORDER.filter((ch) => channels[ch] && !channels[ch].ok).map((ch) => <li key={ch}>{CH[ch].label}: {channels[ch].reason}</li>)}
            </ul>
          )}
        </section>
      )}

      <div className="flex flex-wrap gap-3 items-center">
        <div style={{ flex: "1 1 280px", minWidth: 220 }}>
          <SearchBox value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="اسم أو بريد أو معرّف…" />
        </div>
        <label className="inline-flex items-center gap-2 text-[13px]" style={{ color: C.textMuted }}>الحالة
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="all">كل الحالات</option>
            {Object.entries(ACCOUNT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        </label>
        <label className="inline-flex items-center gap-2 text-[13px]" style={{ color: C.textMuted }}>الاشتراك
          <Select value={subscription} onChange={(e) => { setSubscription(e.target.value); setPage(1); }}>
            <option value="all">الكل</option>
            <option value="active">مشترك</option>
            <option value="none">غير مشترك</option>
          </Select>
        </label>
        <label className="inline-flex items-center gap-2 text-[13px]" style={{ color: C.textMuted }}>الترتيب
          <Select value={`${sort}:${dir}`} onChange={(e) => {
            const [s2, d] = e.target.value.split(":"); setSort(s2); setDir(d); setPage(1);
          }}>
            <option value="created_at:desc">الأحدث تسجيلاً</option>
            <option value="created_at:asc">الأقدم تسجيلاً</option>
            <option value="last_login:desc">آخر دخول</option>
            <option value="name:asc">الاسم أ–ي</option>
            <option value="email:asc">البريد أ–ي</option>
          </Select>
        </label>
      </div>

      <ErrorBar error={state.error} />
      {state.loading ? (
        <div className="py-8 flex justify-center"><Spinner /></div>
      ) : rows.length === 0 ? (
        <Empty>لا يوجد مستخدمون مطابقون.</Empty>
      ) : (
        <div>
          <Table caption="قائمة الأعضاء ووسائل مراسلتهم" minWidth={1000}
            head={["العضو", "الاشتراك", "الحالة", "التسجيل", "آخر دخول", canSend ? "مراسلة فردية" : null, "الملف"].filter((h) => h !== null)}
            align={[, , , , , , "end"]}
            select={canSend ? { ids: rows.map((u) => u.id), selected, onChange: setSelected, allLabel: "تحديد كل الأعضاء المعروضين في هذه الصفحة" } : null}>
            {rows.map((u) => {
              const s = ACCOUNT_STATUS[u.account_status] || { label: u.account_status, color: "textMuted" };
              const nm = u.name || u.email;
              return (
                <Tr key={u.id} id={u.id} label={nm}>
                  <Td>
                    <div className="flex items-center gap-3">
                      <InitialAvatar id={u.id} name={u.name} hasPhoto={u.has_photo === true} />
                      <div style={{ minWidth: 0 }}>
                        <UserLink id={u.id} name={u.name} email={u.email} />
                        <div dir="ltr" className="text-[12px]" style={{ color: C.textMuted, textAlign: "right" }}>{u.email}</div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    {u.subscription_status
                      ? <Pill tone={SUB_TONE[u.subscription_status] === "green" ? "accent" : SUB_TONE[u.subscription_status]}>
                          {u.subscription_plan_name || u.subscription_plan || "—"} · {SUB_LABEL[u.subscription_status] || u.subscription_status}
                        </Pill>
                      : <Pill>بلا اشتراك</Pill>}
                  </Td>
                  <Td><Pill tone={s.color === "green" ? "green" : s.color === "crisis" ? "crisis" : s.color === "amber" ? "amber" : "textMuted"} dot>{s.label}</Pill></Td>
                  <Td dir="ltr">{fmtDate(u.created_at)}</Td>
                  <Td dir="ltr">{u.last_login_at ? fmtDate(u.last_login_at) : "—"}</Td>
                  {canSend && (
                    <Td>
                      <div className="flex gap-1.5">
                        {CHANNEL_ORDER.map((ch) => {
                          const st = channels[ch]; const off = !st || !st.ok; const { Icon } = CH[ch];
                          return (
                            <button key={ch} type="button" className="kt-act inline-flex items-center justify-center rounded-xl"
                              style={{ width: 44, height: 44, ...chStyle(ch, off) }} disabled={off}
                              aria-label={off ? `${CH[ch].verb(nm)} — غير مفعّل${st?.reason ? `: ${st.reason}` : ""}` : CH[ch].verb(nm)}
                              title={off ? `${CH[ch].label} — غير مفعّل${st?.reason ? `: ${st.reason}` : ""}` : CH[ch].label}
                              onClick={() => navigate(href(`/users/${u.id}/message`, { channel: ch }))}>
                              <Icon size={18} aria-hidden="true" />
                            </button>
                          );
                        })}
                      </div>
                    </Td>
                  )}
                  <Td style={{ textAlign: "left" }}>
                    <Link to={`/users/${u.id}`} className="kt-act inline-flex items-center gap-1.5 rounded-xl px-4 text-[13px] font-bold"
                      style={{ minHeight: 44, color: C.text, border: `1px solid ${C.line}`, background: C.surface }} aria-label={`ملف ${nm}`}>
                      <ExternalLink size={14} aria-hidden="true" /> الملف
                    </Link>
                  </Td>
                </Tr>
              );
            })}
          </Table>
          <div className="flex items-center justify-between gap-3 flex-wrap mt-3">
            {canSend && <span className="text-[12px]" style={{ color: C.textMuted }}>محدَّد {selected.length} · {total} عضواً</span>}
            <div className="flex-1"><Pager page={state.data?.page || 1} totalPages={state.data?.totalPages || 1} total={total} onPage={setPage} /></div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ value, label, tone }) {
  return (
    <div className="rounded-xl px-4 py-2 text-center" style={{ background: C.surface, border: `1px solid ${C.line}`, minWidth: 76 }}>
      <div className="text-[20px] font-bold leading-tight" style={{ color: tone || C.text }}>{value ?? "…"}</div>
      <div className="text-[11px]" style={{ color: C.textMuted }}>{label}</div>
    </div>
  );
}

/* مراسلة جماعية: المستلمون مجمَّدون — المحدَّدون كما اختيروا، أو المعروض كله بفلاتره من الخادم. */
function BulkMessage({ toast }) {
  const qs = new URLSearchParams(window.location.search);
  const filters = { q: qs.get("q") || "", status: qs.get("status") || "all", sub: qs.get("sub") || "all" };
  const back = href("/users", Object.fromEntries(Object.entries(filters).filter(([, v]) => v && v !== "all")));
  const channel = CHANNEL_ORDER.includes(qs.get("channel")) ? qs.get("channel") : "in_app";
  let picked = null;
  if (qs.get("sel")) { try { picked = JSON.parse(sessionStorage.getItem(`kanaf-sel-${qs.get("sel")}`) || "null"); } catch { picked = null; } }
  else if (qs.get("ids")) picked = qs.get("ids").split(",").filter(Boolean);
  const fromFilter = !qs.get("sel") && !qs.get("ids");
  const rec = useAsync(() => (fromFilter
    ? api.userRecipients({ search: filters.q, status: filters.status, subscription: filters.sub })
    : Promise.resolve(picked ? { userIds: picked, count: picked.length } : null)), []);
  if (rec.loading) return <div className="py-10 flex justify-center"><Spinner /></div>;
  if (!rec.data) return <Screen title="مراسلة جماعية" back={back}><ErrorBar error="انتهى التحديد (أُعيد تحميل الصفحة) — ارجع إلى القائمة واختر الأعضاء من جديد." /></Screen>;
  if (rec.error || !rec.data.count) return <Screen title="مراسلة جماعية" back={back}><ErrorBar error={rec.error || "لا أعضاء بهذا الفلتر."} /></Screen>;
  const label = fromFilter
    ? `كل الأعضاء المعروضين${filters.q || filters.status !== "all" || filters.sub !== "all" ? " بالفلتر المطبَّق" : ""}: ${rec.data.count} — العدد يُتحقق منه عند الإرسال.`
    : `${rec.data.count} ${rec.data.count === 1 ? "عضو محدَّد" : "عضواً محدَّداً"}.`;
  return (
    <Compose open fixedUserIds={rec.data.userIds} fixedLabel={label} back={back} title={`مراسلة ${rec.data.count} عضواً`} initialChannels={[channel]}
      onClose={() => navigate(back)} onDone={(m) => { toast(m); navigate(back); }} />
  );
}

/* ------------------------------------------------------------ */

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-xs" style={{ borderTop: `1px solid ${C.line}` }}>
      <span style={{ color: C.textMuted }}>{label}</span>
      <span className="text-left" style={{ color: C.text }}>{children ?? "—"}</span>
    </div>
  );
}

function UserDetail({ id, tab, me, toast }) {
  const state = useAsync(() => api.getUser(id), [id]);
  const [pending, setPending] = useState(null);
  const onChanged = () => {};

  const u = state.data;
  const countryName = useCountryNames();
  /* ثلاث صلاحيات مستقلة لا شرط واحد: كان `isAdmin` يحكم الثلاثة
     معاً، والمحاسب يحتاج المالي ولا يجوز أن يرى المتابعة اليومية.
     الخادم يفصلها أصلاً، والشاشة تتبعه. */
  const canBilling = can(me, "billing:view_user");
  const canSensitive = can(me, "users:view_sensitive");
  const canActions = can(me, "users:view_actions");
  const canSuspend = can(me, "users:suspend");

  const act = (kind) => {
    if (kind === "suspend") {
      setPending({
        title: "إيقاف الحساب",
        description: "يُنهي كل جلسات المستخدم فوراً. الوصول إلى محتوى الطوارئ يبقى متاحاً له.",
        confirmLabel: "إيقاف", danger: true,
        run: async () => { const res = await api.suspendUser(id); toast(`أُوقف الحساب · أُنهيت ${res.sessionsRevoked} جلسة`); state.reload(); onChanged(); },
      });
    } else {
      setPending({
        title: "إعادة تفعيل الحساب", confirmLabel: "إعادة التفعيل",
        run: async () => { await api.restoreUser(id); toast("أُعيد تفعيل الحساب."); state.reload(); onChanged(); },
      });
    }
  };

  return (
    <Screen title={u ? (u.name || u.email) : "ملف المستخدم"} back="/users" backLabel="المستخدمون">
      {state.loading ? <div className="py-10 flex justify-center"><Spinner /></div> : state.error ? (
        <ErrorBar error={state.error} />
      ) : (
        <>
          <div className="flex gap-1.5 mb-4 flex-wrap">
            {[
              ["profile", "الملف", true],
              ["edit", "تعديل", can(me, "users:edit")],
              ["message", "مراسلة", can(me, "notifications:create") && can(me, "notifications:send")],
              ["billing", "الاشتراك", canBilling],
              ["sensitive", "المتابعة اليومية", canSensitive],
              ["actions", "سجل الإجراءات", canActions],
            ].filter(([, , show]) => show).map(([k, label]) => (
              <Link key={k} to={`/users/${id}${k === "profile" ? "" : `/${k}`}`} replace
                aria-current={tab === k ? "page" : undefined}
                className="px-3 py-1.5 rounded-xl text-xs font-bold"
                style={{
                  background: tab === k ? C.tealSoft : C.surfaceAlt,
                  color: tab === k ? C.teal : C.textMuted,
                }}>
                {label}
              </Link>
            ))}
          </div>

          {tab === "profile" && (
            <div>
              <div className="flex items-center gap-3 pb-3">
                <Avatar id={u.id} name={u.name} size={56} hasPhoto={u.has_photo === true} />
                <div>
                  <div className="text-sm font-bold" style={{ color: C.text }}>{u.name || "—"}</div>
                  <div className="text-[11px]" style={{ color: C.textFaint }}>
                    {u.has_photo ? "صورة محفوظة من التطبيق" : "لا صورة — يُعرض الحرف الأول"}
                  </div>
                </div>
              </div>

              <Row label="المعرّف"><code className="text-[10px]">{u.id}</code></Row>
              <Row label="البريد">{u.email}</Row>

              {/* الجوال يظهر للمالك وحده. والخادم لا يرسل الحقل أصلاً
                  لمن لا يملك users:view_contact — فغيابه من الحمولة
                  هو الحارس، لا هذا الشرط. هذا يمنع صفاً فارغاً لا
                  معنى له في وجه بقية الأدوار. */}
              {"phone" in u && <Row label="الجوال">{u.phone ? <span dir="ltr">{u.phone}</span> : "—"}</Row>}
              {"country" in u && <Row label="الدولة">{countryName(u.country)}</Row>}
              <Row label="الحالة">
                <Badge color={(ACCOUNT_STATUS[u.account_status] || {}).color}>
                  {(ACCOUNT_STATUS[u.account_status] || {}).label || u.account_status}
                </Badge>
              </Row>
              <Row label="الفئة العمرية">{u.age_range}</Row>
              {/* الجنس: نفس مستوى الفئة العمرية (users:view) — الحقل في الحمولة منذ البداية ولم يكن يُعرض.
                  لا توسيع للاطلاع: لا حقل جديد يُقرأ من القاعدة (KANAF-ORD-0002 B-07). */}
              <Row label="الجنس">{u.gender === "male" ? "ذكر" : u.gender === "female" ? "أنثى" : "—"}</Row>
              <Row label="أكّد أنه بالغ">{u.confirmed_adult ? "نعم" : "لا"}</Row>
              <Row label="تفعيل البريد">{u.email_verified_at ? fmtDateTime(u.email_verified_at) : "غير مفعّل"}</Row>
              <Row label="التسجيل">{fmtDateTime(u.created_at)}</Row>
              <Row label="آخر دخول">{u.last_login_at ? fmtDateTime(u.last_login_at) : "—"}</Row>
              <Row label="محاولات دخول فاشلة">{u.failed_login_count ?? 0}</Row>
              {u.locked_until && <Row label="مقفل حتى">{fmtDateTime(u.locked_until)}</Row>}
              {u.suspended_at && <Row label="سبب الإيقاف">{u.suspended_reason || "—"}</Row>}

              {/* ------------------------------------------------------
                  حالة تشغيلية للإدارة — بلا أي محتوى نفسي.

                  «له خطة» نعم أو لا، ولا شيء من داخلها: الملخّص
                  ومجالات التركيز محتوى يخصّ صاحبه، ولا يختارها
                  استعلام هذه الشاشة إطلاقاً (admin/routes.js).
                  ------------------------------------------------------ */}
              <Row label="تذكير التسجيل اليومي">
                {u.reminders_on
                  ? <span style={{ color: C.text }}>
                      <Bell size={11} style={{ display: "inline", marginLeft: 4 }} />
                      مفعّل{u.reminder_local_time ? ` · ${u.reminder_local_time}` : ""}
                      {u.reminder_timezone ? ` (${u.reminder_timezone})` : ""}
                    </span>
                  : <span style={{ color: C.textFaint }}>مطفأ</span>}
              </Row>
              {u.reminders_on && (
                <Row label="آخر تذكير أُرسل">
                  {u.reminder_last_sent_on ? fmtDate(u.reminder_last_sent_on) : "لم يُرسل بعد"}
                </Row>
              )}
              <Row label="خطة نشطة">
                {u.has_active_plan
                  ? <span style={{ color: C.text }}><Compass size={11} style={{ display: "inline", marginLeft: 4 }} />نعم</span>
                  : <span style={{ color: C.textFaint }}>لا</span>}
              </Row>

              {/* ------------------------------------------------------
                  الحالة الفعلية للاشتراك — لا العمود المخزّن.

                  والعمود المخزّن يُعرض بجانبها **فقط حين يختلفان**:
                  اختلافهما ليس عطباً بل هو التصميم (لا يمكن تخزين
                  'expired' — قيد CHECK على جدول يملكه postgres)،
                  لكن رؤيته تختصر تشخيص أي التباس مالي.
                  ------------------------------------------------------ */}
              {u.subscription_status && (
                <Row label="الاشتراك">
                  <span style={{ color: C.text }}>
                    {u.subscription_plan || "—"} · {u.subscription_status}
                  </span>
                  {u.subscription_stored_status && u.subscription_stored_status !== u.subscription_status && (
                    <span className="text-[10px]" style={{ color: C.textFaint }}>
                      {" "}(المخزَّن: {u.subscription_stored_status})
                    </span>
                  )}
                </Row>
              )}

              {/* KANAF-ORD-0013 §8: المحو النهائي لحساب طلب صاحبه حذفه — للمالك وحده، ولا رجعة. */}
              {u.account_status === "deleted" && can(me, "members:purge") && (
                <div className="mt-4 rounded-xl p-3" style={{ background: C.surfaceAlt }}>
                  <p className="text-[11px] leading-6 mb-2" style={{ color: C.textMuted }}>
                    طلب العضو حذف حسابه فعُطّل. المحو النهائي يمحو بياناته النفسية والشخصية ويكتب سجلاً مجهولاً في «الأعضاء الملغون».
                    الفواتير الصادرة تبقى. <b>لا رجعة فيه.</b>
                  </p>
                  <Button variant="danger" onClick={() => setPending({
                    title: "إتمام الحذف النهائي", danger: true, confirmLabel: "محو نهائي",
                    description: "يُمحى كل ما يخص العضو ولا يمكن استرجاعه. يبقى سجل مجهول لا يُردّ إليه، والفواتير كما صدرت.",
                    run: async () => { await api.purgeMember(id); toast("أُتمّ المحو النهائي."); state.reload(); },
                  })}>إتمام الحذف النهائي</Button>
                </div>
              )}

              {canSuspend && u.account_status !== "deleted" && (
                <div className="flex gap-2 mt-4">
                  {u.account_status === "suspended" ? (
                    <Button variant="good" onClick={() => act("restore")}><RotateCcw size={13} /> إعادة تفعيل</Button>
                  ) : (
                    <Button variant="danger" onClick={() => act("suspend")}><Ban size={13} /> إيقاف الحساب</Button>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === "edit" && can(me, "users:edit") && <EditUser u={u} toast={toast} onSaved={() => state.reload()} />}
          {/* KANAF-ORD-0013 §4.4: إرسال فردي على آلية الحملات نفسها (selected_users بمستلم واحد) */}
          {tab === "message" && can(me, "notifications:send") && (
            <Compose open fixedUserIds={[u.id]} fixedLabel={u.name || u.email} title={`مراسلة ${u.name || u.email}`}
              initialChannels={[new URLSearchParams(window.location.search).get("channel") || "in_app"]}
              onClose={() => {}} onDone={(m) => toast(m)} />
          )}
          {tab === "billing" && <Billing user={u} me={me} toast={toast} onChanged={() => { state.reload(); onChanged(); }} />}
          {tab === "billing" && can(me, "subscriptions:edit") && <EditSubscription user={u} toast={toast} onSaved={() => state.reload()} />}
          {tab === "billing" && can(me, "subscriptions:view") && <AutoRenewPanel user={u} canEdit={can(me, "subscriptions:edit")} toast={toast} />}
          {tab === "sensitive" && <Sensitive id={id} />}
          {tab === "actions" && <Actions id={id} />}
        </>
      )}

      <ConfirmPrompt
        open={!!pending} title={pending?.title || ""} description={pending?.description}
        confirmLabel={pending?.confirmLabel} danger={pending?.danger}
        onConfirm={() => pending.run()} onClose={() => setPending(null)}
      />
    </Screen>
  );
}

/** اسم العميل رابط إلى ملفه — KANAF-ORD-0013 §4.2. يُستورد من كل صفحة تعرض اسم عميل. */
export function UserLink({ id, name, email }) {
  const label = name || email || "—";
  if (!id) return <span>{label}</span>;
  return (
    <Link to={`/users/${id}`} className="font-bold underline-offset-2 hover:underline" style={{ color: C.teal }}>
      {label}
    </Link>
  );
}

/* ------------------------------------------------------------
   المتابعة اليومية.

   درجات فقط — مزاج ونوم وطاقة. نص اليومية (`note`) وإجابات
   المقاييس التفصيلية لا تُعرض هنا بحال. الطلب لا ينطلق قبل تأكيد
   بنقرة، والوصول يُسجَّل قبل وصول البيانات بسبب يولّده الخادم.
   ------------------------------------------------------------ */
const SCALE = ["—", "منخفض جداً", "منخفض", "متوسط", "جيد", "مرتفع"];

function Sensitive({ id }) {
  const [data, setData] = useState(null);
  const [ask, setAsk] = useState(true);
  const [err, setErr] = useState("");

  if (data) {
    return (
      <div>
        <p className="text-[11px] leading-6 mb-3" style={{ color: C.textFaint }}>
          درجات فقط. نص اليومية وإجابات المقاييس التفصيلية لا تصل إلى اللوحة
          أصلاً — لا مسار إداري يقرؤها (D-ADM-01).
        </p>

        <h4 className="text-xs font-bold mb-2" style={{ color: C.text }}>آخر 30 يوماً</h4>
        {data.logs?.length ? (
          <Table head={["التاريخ", "المزاج", "النوم", "الطاقة"]}>
            {data.logs.map((l, i) => (
              <tr key={i}>
                <Td>{fmtDate(l.logged_on)}</Td>
                <Td>{SCALE[l.mood] || l.mood || "—"}</Td>
                <Td>{SCALE[l.sleep] || l.sleep || "—"}</Td>
                <Td>{SCALE[l.energy] || l.energy || "—"}</Td>
              </tr>
            ))}
          </Table>
        ) : <Empty>لا توجد متابعة يومية.</Empty>}

        <h4 className="text-xs font-bold mt-5 mb-2" style={{ color: C.text }}>المقاييس</h4>
        {data.screenings?.length ? (
          <Table head={["المقياس", "الدرجة", "النطاق", "التاريخ"]}>
            {data.screenings.map((s, i) => (
              <tr key={i}>
                <Td>{s.kind}</Td>
                <Td>{s.total}</Td>
                <Td>{s.band_label}</Td>
                <Td>{fmtDate(s.created_at)}</Td>
              </tr>
            ))}
          </Table>
        ) : <Empty>لا توجد مقاييس.</Empty>}
      </div>
    );
  }

  return (
    <>
      <ErrorBar error={err} />
      <ConfirmPrompt
        open={ask}
        title="عرض بيانات المتابعة"
        description="هذه بيانات صحية. سيُسجَّل اسمك ووقت الاطلاع في سجل الوصول قبل عرض أي شيء، ولا يمكن حذف السجل لاحقاً."
        confirmLabel="عرض"
        onConfirm={async () => {
          try { setData(await api.getUserSensitive(id)); }
          catch (e) { setErr(e?.arabic || "تعذّر الجلب."); throw e; }
        }}
        onClose={() => setAsk(false)}
      />
      {!ask && !data && (
        <div className="text-center py-6">
          <ShieldAlert size={20} color={C.textFaint} className="mx-auto mb-2" />
          <p className="text-xs mb-3" style={{ color: C.textFaint }}>لم تُعرض البيانات.</p>
          <Button size="sm" variant="ghost" onClick={() => setAsk(true)}>اعرض</Button>
        </div>
      )}
    </>
  );
}

function Actions({ id }) {
  const state = useAsync(() => api.getUserActions(id), [id]);
  const rows = state.data?.actions || [];
  if (state.loading) return <div className="py-8 flex justify-center"><Spinner /></div>;
  if (state.error) return <ErrorBar error={state.error} />;
  if (!rows.length) return <Empty>لا إجراءات إدارية على هذا الحساب.</Empty>;
  return (
    <Table head={["الإجراء", "قبل ← بعد", "السبب", "التاريخ"]}>
      {rows.map((a) => (
        <tr key={a.id}>
          <Td className="font-bold">{a.action}</Td>
          <Td><ValueDiff oldValue={a.old_value} newValue={a.new_value} /></Td>
          <Td className="max-w-xs"><span style={{ color: C.textMuted }}>{a.reason || "—"}</span></Td>
          <Td dir="ltr">{fmtDateTime(a.created_at)}</Td>
        </tr>
      ))}
    </Table>
  );
}

/* ------------------------------------------------------------
   الاشتراك.

   الإلغاء لا يحرّك مالاً والاسترداد يحرّكه — ولذلك زران منفصلان
   بنصّين مختلفين، لا زر واحد بخيار.
   ------------------------------------------------------------ */
function Billing({ user, me, toast, onChanged }) {
  const [pending, setPending] = useState(null);
  const [atPeriodEnd, setAtPeriodEnd] = useState(true);
  const [amount, setAmount] = useState("");
  /* KANAF-ORD-0001 R15-09: الزران كانا يظهران لكل من يرى الملف المالي،
     والخادم يشترط subscriptions:cancel و payments:refund — فيرى المحاسب
     زراً يردّ 403. والملف المالي الكامل (GET /admin/billing/users/:id/billing)
     كان بلا شاشة. */
  const canCancel = can(me, "subscriptions:cancel");
  const canRefundIt = can(me, "payments:refund");
  const full = useAsync(() => api.userBilling(user.id), [user.id]);
  const t = full.data?.totals;

  const has = !!user.subscription_status;

  return (
    <div>
      <Row label="الحالة">{user.subscription_status || "لا يوجد اشتراك"}</Row>
      <Row label="الباقة">{user.subscription_plan}</Row>
      <Row label="ينتهي / يتجدد">{user.subscription_renews_at ? fmtDateTime(user.subscription_renews_at) : "—"}</Row>
      {t && <Row label="إجمالي ما دفع / المسترد / الصافي"><span dir="ltr">{t.lifetimeGross.toFixed(2)} / {t.lifetimeRefunded.toFixed(2)} / {t.lifetimeNet.toFixed(2)} ر.س</span></Row>}
      {full.data && <Row label="دفعات · فواتير · إشعارات دائنة">{full.data.payments.length} · {full.data.invoices.length} · {full.data.creditNotes.length}</Row>}

      {has && (
        <div className="mt-4 grid gap-3">
          {canCancel && <div className="rounded-xl p-3" style={{ background: C.surfaceAlt }}>
            <p className="text-xs font-bold mb-2" style={{ color: C.text }}>إلغاء الاشتراك</p>
            <p className="text-[11px] leading-6 mb-2" style={{ color: C.textFaint }}>
              لا يحرّك مالاً ولا يصدر إشعاراً دائناً.
            </p>
            <label className="flex items-center gap-2 text-xs mb-2" style={{ color: C.textMuted }}>
              <input type="checkbox" checked={atPeriodEnd} onChange={(e) => setAtPeriodEnd(e.target.checked)} />
              يبقى الوصول حتى نهاية المدة المدفوعة
            </label>
            <Button size="sm" variant="warn" onClick={() => setPending({
              title: "إلغاء الاشتراك", confirmLabel: "إلغاء الاشتراك",
              run: async () => {
                const res = await api.cancelSubscription(user.id, atPeriodEnd);
                toast(res.mode === "at_period_end" ? `يُلغى في ${fmtDate(res.accessUntil)}` : "أُلغي الاشتراك فوراً.");
                onChanged();
              },
            })}>
              <CreditCard size={12} /> إلغاء
            </Button>
          </div>}

          {canRefundIt && <div className="rounded-xl p-3" style={{ background: C.surfaceAlt }}>
            <p className="text-xs font-bold mb-2" style={{ color: C.text }}>استرداد مبلغ</p>
            <p className="text-[11px] leading-6 mb-2" style={{ color: C.textFaint }}>
              يحرّك مالاً فعلاً ويصدر إشعاراً دائناً بترقيم رسمي. اتركه فارغاً لاسترداد كامل.
            </p>
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Input type="number" step="0.01" min="0" placeholder="المبلغ بالريال (اختياري)"
                  value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <Button size="sm" variant="danger" onClick={() => setPending({
                title: "استرداد مبلغ", danger: true, confirmLabel: "تنفيذ الاسترداد",
                description: "هذا إجراء مالي لا يُتراجع عنه، ويصدر إشعاراً دائناً بترقيم رسمي.",
                run: async () => {
                  const res = await api.refundSubscription(user.id, amount === "" ? undefined : Number(amount));
                  toast(`تم الاسترداد: ${res.amount} ر.س${res.creditNoteNumber ? ` · إشعار ${res.creditNoteNumber}` : ""}`);
                  onChanged();
                },
              })}>استرداد</Button>
            </div>
          </div>}
        </div>
      )}

      <ConfirmPrompt
        open={!!pending} title={pending?.title || ""} description={pending?.description}
        confirmLabel={pending?.confirmLabel} danger={pending?.danger}
        onConfirm={() => pending.run()} onClose={() => setPending(null)}
      />
    </div>
  );
}


/* ============================================================
   تعديل الملف — KANAF-ORD-0013 §4.3
   كل حفظ يُكتب في سجل الإجراءات بالقيمة قبل وبعد، والسبب يولّده الخادم
   (ملحق KANAF-ORD-0013، قرار المالك 1: لا سبب مكتوب). يُرسَل ما تغيّر
   فقط. والمحجوب (D-ADM-01) ليس هنا: لا حقل ولا مسار.
   ============================================================ */
const AGE_RANGES = ["20-30", "30-40", "40-50", "50-60"];
function useCountries() {
  const [list, setList] = useState([]);
  useEffect(() => { fetch("/api/countries").then((r) => (r.ok ? r.json() : null)).then((d) => d && setList(d.countries || [])).catch(() => {}); }, []);
  return list;
}

function EditUser({ u, toast, onSaved }) {
  const countries = useCountries();
  const canContact = "phone" in u;
  const init = {
    name: u.name || "", email: u.email || "", ageRange: u.age_range || "", gender: u.gender || "",
    remindersOn: !!u.reminders_on, reminderTime: u.reminder_local_time || "", reminderTimezone: u.reminder_timezone || "",
    marketingOptOut: !!u.marketing_opt_out,
    country: u.country || "", dial: u.phone_parts?.dial || "", national: u.phone_parts?.national || "",
  };
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e }));

  const patch = () => {
    const b = {};
    if (f.name !== init.name) b.name = f.name;
    if (f.email.trim().toLowerCase() !== init.email.toLowerCase()) b.email = f.email.trim();
    if (f.ageRange !== init.ageRange) b.ageRange = f.ageRange || null;
    if (f.gender !== init.gender) b.gender = f.gender || null;
    if (f.remindersOn !== init.remindersOn) b.remindersOn = f.remindersOn;
    if (f.reminderTime !== init.reminderTime && f.reminderTime) b.reminderTime = f.reminderTime;
    if (f.reminderTimezone !== init.reminderTimezone && f.reminderTimezone) b.reminderTimezone = f.reminderTimezone;
    if (f.marketingOptOut !== init.marketingOptOut) b.marketingOptOut = f.marketingOptOut;
    if (canContact) {
      if (f.country !== init.country) b.country = f.country || null;
      if (f.dial !== init.dial || f.national !== init.national) b.phone = f.dial || f.national ? { dial: f.dial, national: f.national } : null;
    }
    return b;
  };

  const save = async () => {
    const b = patch();
    if (!Object.keys(b).length) { setErr("لا تغيير لحفظه."); return; }
    setBusy(true); setErr("");
    try {
      const r = await api.editUserProfile(u.id, b);
      toast(r.verification === "sent" ? "حُفظ. البريد الجديد يحتاج تحقّقاً، وأُرسل إليه رمز."
        : r.verification === "send_failed" ? "حُفظ، لكن تعذّر إرسال رمز التحقق إلى البريد الجديد."
        : `حُفظ: ${r.changed.length} حقل.`);
      onSaved();
    } catch (e) { setErr(e?.arabic || "تعذّر الحفظ."); }
    finally { setBusy(false); }
  };

  const [photoBusy, setPhotoBusy] = useState(false);
  const photo = async (file) => {
    setPhotoBusy(true); setErr("");
    try { file ? await api.setUserAvatar(u.id, file) : await api.deleteUserAvatar(u.id); toast(file ? "حُفظت الصورة." : "حُذفت الصورة."); onSaved(); }
    catch (e) { setErr(e?.arabic || "تعذّر."); }
    finally { setPhotoBusy(false); }
  };

  const emailChanging = f.email.trim().toLowerCase() !== init.email.toLowerCase();
  return (
    <div className="grid gap-3" style={{ maxWidth: 560 }}>
      <Field label="الاسم"><Input value={f.name} onChange={set("name")} maxLength={80} /></Field>
      <Field label="البريد" hint={emailChanging ? "⚠️ تغيير البريد يُلغي تفعيله وكل جلسات العميل، ويُرسل رمز تحقق إلى البريد الجديد." : "هوية الدخول."}>
        <Input value={f.email} onChange={set("email")} dir="ltr" type="email" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="الفئة العمرية"><Select value={f.ageRange} onChange={set("ageRange")}><option value="">—</option>{AGE_RANGES.map((a) => <option key={a} value={a}>{a}</option>)}</Select></Field>
        <Field label="الجنس"><Select value={f.gender} onChange={set("gender")}><option value="">—</option><option value="male">ذكر</option><option value="female">أنثى</option></Select></Field>
      </div>
      {canContact && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="الدولة"><Select value={f.country} onChange={(e) => { const c = countries.find((x) => x.code === e.target.value); setF((x) => ({ ...x, country: e.target.value, dial: c ? c.dial : x.dial })); }}>
            <option value="">—</option>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</Select></Field>
          <Field label="رمز الاتصال"><Input value={f.dial} onChange={set("dial")} dir="ltr" /></Field>
          <Field label="الرقم بلا صفر"><Input value={f.national} onChange={set("national")} dir="ltr" /></Field>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="التذكير اليومي"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.remindersOn} onChange={set("remindersOn")} /> مفعّل</label></Field>
        <Field label="وقت التذكير"><Input type="time" value={f.reminderTime} onChange={set("reminderTime")} dir="ltr" /></Field>
        <Field label="المنطقة الزمنية"><Input value={f.reminderTimezone} onChange={set("reminderTimezone")} placeholder="Asia/Riyadh" dir="ltr" /></Field>
      </div>
      <label className="flex items-center gap-2 text-xs" style={{ color: C.textMuted }}>
        <input type="checkbox" checked={f.marketingOptOut} onChange={set("marketingOptOut")} /> أوقف الرسائل التسويقية
      </label>
      <Field label="الصورة">
        <div className="flex items-center gap-2 flex-wrap">
          <Avatar id={u.id} name={u.name} size={40} hasPhoto={u.has_photo === true} />
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={photoBusy} onChange={(e) => e.target.files?.[0] && photo(e.target.files[0])} />
          {u.has_photo && <Button size="sm" variant="ghost" busy={photoBusy} onClick={() => photo(null)}>حذف الصورة</Button>}
        </div>
      </Field>
      <ErrorBar error={err} />
      <div><Button onClick={save} busy={busy}>حفظ التعديلات</Button></div>
    </div>
  );
}

/* الباقة وحالة الاشتراك ومدته — يدوياً بلا حركة مال (subscriptions:edit). */
/* ============================================================
   التجديد التلقائي — KANAF-ORD-0013 §7.8: العرض (الموافقة بنصّها، البطاقة بآخر
   أربعة أرقامها، والدورات بمحاولاتها) والإيقاف بنقرة تأكيد. الرمز لا يصل إلى المتصفّح.
   ============================================================ */
export const RENEWAL_STATUS = {
  noticed: { label: "أُشعر — بانتظار الخصم", color: "textMuted" }, charging: { label: "يُخصم الآن", color: "teal" },
  retry: { label: "فشل — ستُعاد المحاولة", color: "amber" }, succeeded: { label: "تجدّد", color: "teal" },
  stopped: { label: "توقّف بعد المحاولات", color: "crisis" }, cancelled: { label: "أُلغي", color: "textMuted" },
  unknown: { label: "نتيجة مجهولة — راجع", color: "crisis" },
};
const REVOKED_BY = { member: "العضو", admin: "الإدارة", system: "النظام" };

function AutoRenewPanel({ user, canEdit, toast }) {
  const state = useAsync(() => api.userAutorenew(user.id), [user.id]);
  const [ask, setAsk] = useState(false);
  const d = state.data;
  return (
    <div className="mt-6 pt-4" style={{ borderTop: `1px solid ${C.line}` }}>
      <h4 className="text-xs font-bold mb-1" style={{ color: C.text }}>التجديد التلقائي</h4>
      <ErrorBar error={state.error} />
      {state.loading ? <Spinner /> : d && (
        <>
          {!d.enabled && <p className="text-[11px] mb-2" style={{ color: C.textFaint }}>الميزة معطّلة على هذا الخادم (AUTORENEW_ENABLED) — لا خصم ولا إشعار. العرض للسجلّ وحده.</p>}
          <div className="text-xs leading-7" style={{ color: C.textMuted }}>
            <div>الحالة: {d.active ? <Badge color="teal">مفعَّل منذ {fmtDate(d.active.granted_at)}</Badge> : <Badge>غير مفعَّل</Badge>}</div>
            <div>البطاقة المحفوظة: {d.cards.find((c) => !c.removed_at) ? <span dir="ltr">{d.cards.find((c) => !c.removed_at).brand || ""} ••{d.cards.find((c) => !c.removed_at).last4}</span> : "لا بطاقة"}</div>
            {d.active && <div className="mt-1 rounded-xl p-2 text-[11px]" style={{ background: C.surfaceAlt }}>نصّ الموافقة ({d.active.consent_version}): {d.active.consent_text}</div>}
          </div>
          {d.consents.filter((c) => c.revoked_at).length > 0 && (
            <p className="text-[11px] mt-2" style={{ color: C.textFaint }}>
              موافقات سابقة: {d.consents.filter((c) => c.revoked_at).map((c) => `${fmtDate(c.granted_at)}–${fmtDate(c.revoked_at)} (سحبها ${REVOKED_BY[c.revoked_by]}${c.revoke_reason ? `: ${c.revoke_reason}` : ""}${c.revoked_by_admin_name ? ` — ${c.revoked_by_admin_name}` : ""})`).join(" · ")}
            </p>
          )}
          {d.cycles.length > 0 && (
            <div className="mt-3">
              <Table head={["نهاية الفترة", "المبلغ", "الحالة", "المحاولات", "الفاتورة", "ملاحظة"]}>
                {d.cycles.map((c) => (
                  <tr key={c.cycle_key}>
                    <Td dir="ltr">{fmtDate(c.period_end)}</Td>
                    <Td>{Number(c.amount_sar).toFixed(2)}</Td>
                    <Td><Badge color={RENEWAL_STATUS[c.status]?.color}>{RENEWAL_STATUS[c.status]?.label || c.status}</Badge></Td>
                    <Td className="text-[11px]">{c.attempts_log.map((a) => `${a.no}: ${a.status}${a.code ? ` (${a.code})` : ""}`).join(" · ") || "—"}</Td>
                    <Td dir="ltr">{c.invoice_number || "—"}</Td>
                    <Td className="text-[11px]" dir="ltr">{c.last_error || ""}</Td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
          {canEdit && d.active && <div className="mt-3"><Button variant="danger" size="sm" onClick={() => setAsk(true)}>إيقاف التجديد التلقائي</Button></div>}
        </>
      )}
      <ConfirmPrompt open={ask} danger title="إيقاف التجديد التلقائي" description="تُسحب موافقة العضو باسمك، ولا خصم بعدها. اشتراكه الحالي يبقى إلى نهايته، ويقدر يفعّل التجديد من التطبيق من جديد."
        onClose={() => setAsk(false)}
        onConfirm={async () => { await api.disableUserAutorenew(user.id); toast("أُوقف التجديد التلقائي."); state.reload(); }} />
    </div>
  );
}

function EditSubscription({ user, toast, onSaved }) {
  const plans = useAsync(() => api.listPlans(), []);
  const [planId, setPlanId] = useState(user.subscription_plan || "");
  const [periodEnd, setPeriodEnd] = useState(user.subscription_renews_at ? String(user.subscription_renews_at).slice(0, 10) : "");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    const b = {};
    if (planId && planId !== user.subscription_plan) b.planId = planId;
    if (periodEnd && periodEnd !== String(user.subscription_renews_at || "").slice(0, 10)) b.periodEnd = `${periodEnd}T23:59:59+03:00`;
    if (status) b.status = status;
    if (!Object.keys(b).length) { setErr("لا تغيير لحفظه."); return; }
    setBusy(true); setErr("");
    try { const r = await api.editUserSubscription(user.id, b); toast(r.created ? "مُنح اشتراك يدوي." : "عُدّل الاشتراك."); onSaved(); }
    catch (e) { setErr(e?.arabic || "تعذّر الحفظ."); }
    finally { setBusy(false); }
  };
  return (
    <div className="mt-6 pt-4" style={{ borderTop: `1px solid ${C.line}` }}>
      <h4 className="text-xs font-bold mb-1" style={{ color: C.text }}>تعديل الاشتراك يدوياً</h4>
      <p className="text-[11px] leading-6 mb-3" style={{ color: C.textFaint }}>بلا حركة مال: لا فاتورة ولا استرداد. يُسجَّل بالقيمتين قبل وبعد. ولا اشتراك سابق = منح يدوي.</p>
      <div className="grid gap-3 sm:grid-cols-3" style={{ maxWidth: 680 }}>
        <Field label="الباقة"><Select value={planId} onChange={(e) => setPlanId(e.target.value)}><option value="">—</option>{(plans.data?.plans || []).map((p) => <option key={p.plan_key} value={p.plan_key}>{p.name}</option>)}</Select></Field>
        <Field label="ينتهي في"><Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} dir="ltr" /></Field>
        <Field label="الحالة"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">بلا تغيير</option><option value="active">نشط</option><option value="canceled">ملغى</option></Select></Field>
      </div>
      <div className="grid gap-3 mt-3" style={{ maxWidth: 680 }}>
        <ErrorBar error={err} />
        <div><Button onClick={save} busy={busy}>حفظ الاشتراك</Button></div>
      </div>
    </div>
  );
}
