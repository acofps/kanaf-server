import React from "react";
import { Megaphone } from "lucide-react";
import { api } from "../api.js";
import { C, can, fmtDate } from "../theme.js";
import { Card, PageTitle, Button, Badge, Field, Select, Spinner, Empty, ErrorBar, Table, Td, Pager, Screen, useAsync } from "../ui.jsx";
import { Link, navigate, useQueryState, href } from "../router.js";
import { UserLink, RENEWAL_STATUS } from "./Users.jsx";
import { Compose } from "./Notifications.jsx";

/* ============================================================
   الاشتراكات — KANAF-ORD-0013 §6

   المشتركون فعلياً (السارية اشتراكاتهم)، بفلترة الباقة والمدة. ومعنى «ساري»
   يُعرض في الصفحة كما يعيده الخادم، لا يُترك ضمنياً (§6.1).

   المراسلة الجماعية ترسل إلى المعروض بفلاتره لا إلى الجميع (§6.2): المستلمون
   يُجمَّدون من الخادم بالفلاتر نفسها، والعدد يُعرض ويُؤكَّد قبل الإرسال، والخادم
   يرفض (409) إن تغيّر بين العرض والإرسال. وتمرّ على آلية الحملات نفسها (§6.3).
   ============================================================ */

const RENEWAL = { manual: { label: "يدوي", color: "textMuted" }, automatic: { label: "تلقائي", color: "teal" } };

export default function Subscribers({ me, toast, route = [] }) {
  const [plan, setPlan] = useQueryState("plan", "");
  const [duration, setDuration] = useQueryState("duration", "");
  if (route[0] === "message") return <BulkMessage plan={plan} duration={duration} toast={toast} />;
  if (route[0] === "autorenew") return <AutoRenewCycles />;
  return <SubscriberList me={me} plan={plan} setPlan={setPlan} duration={duration} setDuration={setDuration} />;
}

function SubscriberList({ me, plan, setPlan, duration, setDuration }) {
  const [page, setPage] = useQueryState("page", 1);
  const state = useAsync(() => api.listSubscribers({ plan, duration, page }), [plan, duration, page]);
  const d = state.data;
  const rows = d?.subscribers || [];
  const canMessage = can(me, "notifications:create") && can(me, "notifications:send");

  return (
    <div>
      <PageTitle title="الاشتراكات" subtitle={d?.definition || "المشتركون فعلياً."}>
        <Link to="/subscribers/autorenew"><Button size="sm" variant="ghost">التجديد التلقائي</Button></Link>
        {canMessage && d?.total > 0 && (
          <Link to={href("/subscribers/message", { plan, duration })}>
            <Button size="sm"><span className="inline-flex items-center gap-1.5"><Megaphone size={14} /> مراسلة المعروض ({d.total})</span></Button>
          </Link>
        )}
      </PageTitle>
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 mb-4" style={{ maxWidth: 520 }}>
          <Field label="نوع الباقة">
            <Select value={plan} onChange={(e) => { setPlan(e.target.value); setPage(1); }}>
              <option value="">كل الباقات</option>
              {(d?.options?.plans || []).map((p) => <option key={p.plan_key} value={p.plan_key}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="مدة الاشتراك">
            <Select value={duration} onChange={(e) => { setDuration(e.target.value); setPage(1); }}>
              <option value="">كل المدد</option>
              {(d?.options?.durations || []).map((x) => <option key={x} value={x}>{x} يوماً</option>)}
            </Select>
          </Field>
        </div>
        <ErrorBar error={state.error} />
        {state.loading ? <div className="py-8 flex justify-center"><Spinner /></div>
          : rows.length === 0 ? <Empty>لا مشتركين سارين بهذا الفلتر.</Empty>
          : (
            <>
              <Table head={["العميل", "البريد", "الباقة", "المدة", "ينتهي", "التجديد"]}>
                {rows.map((s) => (
                  <tr key={s.user_id}>
                    <Td><UserLink id={s.user_id} name={s.name} email={s.email} /></Td>
                    <Td dir="ltr">{s.email}</Td>
                    <Td>{s.plan_name || s.plan_id}{s.status !== "active" && <span className="text-[10px]" style={{ color: C.amber }}> · {s.status}</span>}</Td>
                    <Td>{s.duration_days ? `${s.duration_days} يوماً` : "—"}</Td>
                    <Td>{fmtDate(s.current_period_end)}</Td>
                    <Td><Badge color={(RENEWAL[s.renewal_mode] || RENEWAL.manual).color}>{(RENEWAL[s.renewal_mode] || RENEWAL.manual).label}</Badge></Td>
                  </tr>
                ))}
              </Table>
              <Pager page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} />
            </>
          )}
      </Card>
    </div>
  );
}

/* مراسلة المعروض: المستلمون مجمَّدون من الخادم بالفلاتر نفسها، والعدد يُعرض ويُؤكَّد. */
function BulkMessage({ plan, duration, toast }) {
  const back = href("/subscribers", { plan, duration });
  const rec = useAsync(() => api.subscriberRecipients({ plan, duration }), [plan, duration]);
  if (rec.loading) return <div className="py-10 flex justify-center"><Spinner /></div>;
  if (rec.error || !rec.data?.count) return <Screen title="مراسلة المشتركين" back={back}><ErrorBar error={rec.error || "لا مستلمين بهذا الفلتر."} /></Screen>;
  const label = `${rec.data.count} مشترك ساري${plan ? ` · الباقة: ${plan}` : ""}${duration ? ` · المدة: ${duration} يوماً` : ""} — العدد يُتحقق منه عند الإرسال.`;
  return (
    <Compose open fixedUserIds={rec.data.userIds} fixedLabel={label} back={back} title={`مراسلة ${rec.data.count} مشترك`}
      onClose={() => navigate(back)} onDone={(m) => { toast(m); navigate(back); }} />
  );
}

/* KANAF-ORD-0013 §7.8 — دورات التجديد التلقائي عبر كل الأعضاء: المجهولة والمتوقفة والمتعثّرة أولاً. */
function AutoRenewCycles() {
  const [status, setStatus] = useQueryState("status", "");
  const [page, setPage] = useQueryState("page", 1);
  const state = useAsync(() => api.listAutorenewCycles({ status, page }), [status, page]);
  const d = state.data;
  return (
    <Screen title="التجديد التلقائي" back="/subscribers" backLabel="الاشتراكات">
      {d && (
        <p className="text-[11px] leading-6 mb-3" style={{ color: C.textMuted }}>
          {d.enabled ? "مفعَّل على هذا الخادم." : "معطَّل على هذا الخادم (AUTORENEW_ENABLED) — لا إشعار ولا خصم."}
          {" "}موافقات فعّالة: <b>{d.counts.active_consents}</b> · نتائج مجهولة تنتظر المراجعة: <b>{d.counts.unknown_cycles}</b>
          {" "}· الإشعار قبل الخصم بـ{d.settings.noticeDays} أيام، وحتى {d.settings.maxAttempts} محاولات بفاصل {d.settings.retryHours} ساعة (من «الإعدادات»).
        </p>
      )}
      <div className="mb-3" style={{ maxWidth: 260 }}>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">كل الحالات</option>
          {Object.entries(RENEWAL_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
      </div>
      <ErrorBar error={state.error} />
      {state.loading ? <div className="py-8 flex justify-center"><Spinner /></div>
        : !d?.cycles.length ? <Empty>لا دورات.</Empty>
        : (
          <>
            <Table head={["العميل", "الباقة", "المبلغ", "نهاية الفترة", "الحالة", "المحاولات", "الفاتورة", "ملاحظة"]}>
              {d.cycles.map((c) => (
                <tr key={c.cycle_key}>
                  <Td>{c.user_deleted ? <span style={{ color: C.textFaint }}>حساب محذوف</span> : <UserLink id={c.user_id} name={c.user_name} />}</Td>
                  <Td>{c.plan_key}</Td>
                  <Td>{Number(c.amount_sar).toFixed(2)}</Td>
                  <Td dir="ltr">{fmtDate(c.period_end)}</Td>
                  <Td><Badge color={RENEWAL_STATUS[c.status]?.color}>{RENEWAL_STATUS[c.status]?.label || c.status}</Badge></Td>
                  <Td>{c.attempts}</Td>
                  <Td dir="ltr">{c.invoice_number || "—"}</Td>
                  <Td className="text-[11px]" dir="ltr">{c.last_error || ""}</Td>
                </tr>
              ))}
            </Table>
            <Pager page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} />
          </>
        )}
    </Screen>
  );
}
