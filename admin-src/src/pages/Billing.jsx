import React, { useState } from "react";
import { Download, RotateCcw, RefreshCw, Eye, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../api.js";
import { C, can, fmtDate, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Spinner, Empty, ErrorBar, Table, Td, Pager, useAsync,
  Field, Input, Select, SearchBox, Modal, ReasonPrompt,
} from "../ui.jsx";

/* ============================================================
   المالية — KANAF-ORD-0001 R15-09

   مسارات /admin/billing/* كانت مبنية ومختبرة في الخادم منذ المرحلة 3
   بلا شاشة واحدة: الاشتراكات، المدفوعات، الاسترداد، المطابقة،
   الاستردادات، المؤشرات، تقرير التكامل، أحداث الدفع وإعادة تشغيلها.

   قواعد هذه الشاشة:
   • لا منطق حسابات هنا: كل رقم من الخادم (نفس الاستعلامات التي يستعملها
     التصدير)، ولا تعديل يدوي لفاتورة أو دفعة.
   • كل تبويب يظهر بصلاحيته، وكل زر بصلاحيته — والخادم يفرض بمعزل عنها.
   • كل إجراء يحرّك مالاً أو يغيّر حالة: سبب مكتوب (يُسجَّل في سجل
     التدقيق)، ونص يشرح أثره قبل التنفيذ، وزر يتعطّل أثناء التنفيذ.
   • الحمولة الخام لأحداث الدفع للمالك وحده (webhooks:view_payload)،
     والسر منزوع منها عند التخزين أصلاً — لا يُعرض حتى للمالك.
   ============================================================ */

const TABS = [
  { key: "kpis", label: "المؤشرات", perm: "reports:view_kpis" },
  { key: "subscriptions", label: "الاشتراكات", perm: "subscriptions:view" },
  { key: "payments", label: "المدفوعات", perm: "payments:view" },
  { key: "refunds", label: "الاستردادات", perm: "refunds:view" },
  { key: "events", label: "أحداث الدفع", perm: "webhooks:view" },
  { key: "integrity", label: "تكامل البيانات", perm: "reports:view_integrity" },
];

export const BILLING_PERMS = TABS.map((t) => t.perm);

const SUB_STATUS = { active: "نشط", trialing: "تجربة", canceling: "ينتهي بنهاية المدة", past_due: "تعثّر سداد", expired: "منتهٍ", canceled: "ملغى" };
const PAY_STATUS = { paid: "مدفوعة", failed: "فاشلة", refunded: "مستردة", partially_refunded: "مستردة جزئياً", initiated: "بدأت", pending: "معلّقة", voided: "ملغاة" };
const EVT_STATUS = { processed: "عولج", failed: "فشل", ignored: "تُجوهل", received: "استُلم", processing: "قيد المعالجة" };
const money = (v, cur = "SAR") => `${Number(v || 0).toFixed(2)} ${cur === "SAR" ? "ر.س" : cur}`;

export default function Billing({ me, toast }) {
  const tabs = TABS.filter((t) => can(me, t.perm));
  const [tab, setTab] = useState(tabs[0]?.key || "kpis");
  if (!tabs.length) return <Empty>صلاحيتك لا تشمل أي شاشة مالية.</Empty>;
  return (
    <div>
      <PageTitle title="المالية" subtitle="الأرقام من الخادم مباشرة — لا تعديل يدوي لدفعة أو فاتورة. كل إجراء مالي بسبب مكتوب يُسجَّل في سجل التدقيق." />
      <div className="flex gap-1.5 mb-4 flex-wrap">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className="px-3 py-1.5 rounded-xl text-xs font-bold"
            style={{ background: tab === t.key ? C.tealSoft : C.surfaceAlt, color: tab === t.key ? C.teal : C.textMuted }}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "kpis" && <Kpis />}
      {tab === "subscriptions" && <Subscriptions me={me} />}
      {tab === "payments" && <Payments me={me} toast={toast} />}
      {tab === "refunds" && <Refunds />}
      {tab === "events" && <Events me={me} toast={toast} />}
      {tab === "integrity" && <Integrity />}
    </div>
  );
}

/* ---------------- المؤشرات ---------------- */
function Kpis() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const state = useAsync(() => api.billingKpis({ from, to }), [from, to]);
  const d = state.data;
  const k = d?.kpis || {};
  const defs = d?.definitions || {};
  const items = [
    ["activeSubscriptions", "اشتراكات فعّالة الآن"], ["newSubscriptionsInRange", "اشتراكات جديدة في الفترة"],
    ["canceledInRange", "إلغاءات في الفترة"], ["scheduledToCancel", "ستنتهي بنهاية مدتها"],
    ["grossRevenue", "الإيراد الإجمالي", true], ["refunds", "الاستردادات", true], ["netRevenue", "صافي الإيراد", true],
    ["successfulPayments", "دفعات ناجحة"], ["failedPayments", "دفعات فاشلة"], ["paymentSuccessRate", "نسبة نجاح الدفع %"],
  ];
  return (
    <Card>
      <div className="flex gap-3 mb-4 flex-wrap items-end">
        <Field label="من"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="إلى"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        {d && <span className="text-[11px] pb-2" style={{ color: C.textFaint }} dir="ltr">{d.range.from} → {d.range.to} · {d.range.timezone}</span>}
      </div>
      <ErrorBar error={state.error} />
      {state.loading ? <div className="py-8 flex justify-center"><Spinner /></div> : d && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {items.map(([key, label, isMoney]) => (
            <div key={key} className="rounded-xl p-3" style={{ background: C.surfaceAlt }} title={defs[key] || ""}>
              <div className="text-[11px]" style={{ color: C.textFaint }}>{label}</div>
              <div className="text-base font-bold mt-1" style={{ color: C.text }} dir="ltr">
                {k[key] === null || k[key] === undefined ? "—" : isMoney ? money(k[key], d.currency) : k[key]}
              </div>
              {defs[key] && <div className="text-[10px] mt-1 leading-4" style={{ color: C.textFaint }}>{defs[key]}</div>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------------- الاشتراكات ---------------- */
function Subscriptions({ me }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const params = { page, search, status };
  const state = useAsync(() => api.billingSubscriptions(params), [page, search, status]);
  const rows = state.data?.subscriptions || [];
  return (
    <Card>
      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <div className="flex-1 min-w-[200px]"><SearchBox value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="بحث بالاسم أو البريد أو المعرّف" /></div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="all">كل الحالات</option>
          {Object.entries(SUB_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        {can(me, "exports:billing") && <a href={api.exportUrl("subscriptions", { search, status })}><Button size="sm" variant="ghost"><Download size={13} /> CSV بنفس الفلاتر</Button></a>}
      </div>
      <ErrorBar error={state.error} />
      {state.loading ? <div className="py-8 flex justify-center"><Spinner /></div> : rows.length === 0 ? <Empty>لا اشتراكات بهذه الفلاتر.</Empty> : (
        <Table head={["المستخدم", "الباقة", "الحالة الفعلية", "يتجدد / ينتهي", "السعر", "أُنشئ"]}>
          {rows.map((s) => (
            <tr key={s.id}>
              <Td><div className="font-bold">{s.user_name}</div><div className="text-[11px]" style={{ color: C.textFaint }} dir="ltr">{s.user_email}</div></Td>
              <Td>{s.plan_name || s.plan_id}</Td>
              <Td><Badge color={s.entitled ? "green" : "textMuted"}>{SUB_STATUS[s.status] || s.status}</Badge></Td>
              <Td>{s.renewal_date ? fmtDate(s.renewal_date) : "—"}</Td>
              <Td dir="ltr">{s.plan_price_sar ? money(s.plan_price_sar, s.currency) : "—"}</Td>
              <Td>{fmtDate(s.created_at)}</Td>
            </tr>
          ))}
        </Table>
      )}
      <Pager page={page} totalPages={state.data?.totalPages} total={state.data?.total} onPage={setPage} />
    </Card>
  );
}

/* ---------------- المدفوعات + الاسترداد + المطابقة ---------------- */
function Payments({ me, toast }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const state = useAsync(() => api.billingPayments({ page, search, status }), [page, search, status]);
  const [refundOf, setRefundOf] = useState(null);
  const [reason, setReason] = useState(null);
  const rows = state.data?.payments || [];
  const t = state.data?.totals;
  const canRefund = can(me, "payments:refund");
  const canReconcile = can(me, "payments:reconcile");

  return (
    <Card>
      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <div className="flex-1 min-w-[200px]"><SearchBox value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="بحث بالبريد أو رقم المعاملة أو المعرّف" /></div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="all">كل الحالات</option>
          {Object.entries(PAY_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        {can(me, "exports:billing") && <a href={api.exportUrl("payments", { search, status })}><Button size="sm" variant="ghost"><Download size={13} /> CSV بنفس الفلاتر</Button></a>}
      </div>
      {t && (
        <p className="text-[11px] mb-3" style={{ color: C.textMuted }}>
          الإجمالي بهذه الفلاتر: <b dir="ltr">{money(t.gross)}</b> · المسترد: <b dir="ltr">{money(t.refunded)}</b> · الصافي: <b dir="ltr">{money(t.net)}</b>
        </p>
      )}
      <ErrorBar error={state.error} />
      {state.loading ? <div className="py-8 flex justify-center"><Spinner /></div> : rows.length === 0 ? <Empty>لا مدفوعات بهذه الفلاتر.</Empty> : (
        <Table head={["المستخدم", "المبلغ", "الحالة", "المسترد", "الوسيلة", "الفاتورة", "التاريخ", ""]}>
          {rows.map((p) => {
            const refundable = Number(p.amount) - Number(p.refunded_amount || 0);
            return (
              <tr key={p.id}>
                <Td><div className="font-bold">{p.user_name}</div><div className="text-[11px]" style={{ color: C.textFaint }} dir="ltr">{p.user_email}</div></Td>
                <Td dir="ltr">{money(p.amount, p.currency)}</Td>
                <Td><Badge color={p.status === "paid" ? "green" : p.status === "failed" ? "crisis" : "amber"}>{PAY_STATUS[p.status] || p.status}</Badge>
                  {p.failure_reason && <div className="text-[10px] mt-1" style={{ color: C.textFaint }}>{p.failure_reason}</div>}</Td>
                <Td dir="ltr">{Number(p.refunded_amount) > 0 ? money(p.refunded_amount, p.currency) : "—"}</Td>
                <Td>{[p.card_brand, p.card_last4 && `•${p.card_last4}`].filter(Boolean).join(" ") || p.method || "—"}</Td>
                <Td dir="ltr">{p.invoice_number || "—"}</Td>
                <Td>{fmtDateTime(p.captured_at || p.created_at)}</Td>
                <Td>
                  <div className="flex gap-1.5 justify-end">
                    {canReconcile && p.transaction_id && (
                      <Button size="sm" variant="ghost" onClick={() => setReason({
                        title: "مطابقة الدفعة مع المزوّد",
                        description: "يسأل المزوّد عن حالة هذه الدفعة الآن ويطبّقها هنا إن اختلفت (مثلاً: دفعة نجحت ولم يصلنا حدثها). لا يخصم ولا يسترد شيئاً. إن كانت الحالتان متطابقتين لا يتغيّر شيء.",
                        confirmLabel: "مطابقة",
                        run: async (r) => { const res = await api.reconcilePayment(p.id, r); toast(`حالة المزوّد: ${res.providerStatus} · ${res.outcome}`); state.reload(); },
                      })}><RefreshCw size={12} /> مطابقة</Button>
                    )}
                    {canRefund && ["paid", "partially_refunded"].includes(p.status) && refundable > 0 && (
                      <Button size="sm" variant="danger" onClick={() => setRefundOf({ ...p, refundable })}><RotateCcw size={12} /> استرداد</Button>
                    )}
                  </div>
                </Td>
              </tr>
            );
          })}
        </Table>
      )}
      <Pager page={page} totalPages={state.data?.totalPages} total={state.data?.total} onPage={setPage} />
      <RefundModal payment={refundOf} onClose={() => setRefundOf(null)} onDone={(res) => { toast(`تم الاسترداد: ${res.amount} ر.س${res.creditNoteNumber ? ` · إشعار دائن ${res.creditNoteNumber}` : ""}`); state.reload(); }} />
      <ReasonPrompt open={!!reason} title={reason?.title || ""} description={reason?.description}
        confirmLabel={reason?.confirmLabel} onConfirm={(r) => reason.run(r)} onClose={() => setReason(null)} />
    </Card>
  );
}

function RefundModal({ payment, onClose, onDone }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  React.useEffect(() => { setAmount(""); setReason(""); setConfirm(false); setErr(""); setBusy(false); }, [payment?.id]);
  if (!payment) return null;
  const n = amount === "" ? payment.refundable : Number(amount);
  const kind = amount === "" || n >= payment.refundable ? "كامل المتبقّي" : "جزئي";
  const submit = async () => {
    if (busy) return;
    if (!reason.trim()) { setErr("السبب مطلوب — يُسجَّل في سجل التدقيق."); return; }
    if (!(n > 0) || n > payment.refundable) { setErr(`المبلغ بين 0.01 و${payment.refundable.toFixed(2)}.`); return; }
    if (!confirm) { setErr("أكّد أنك تفهم أثر الاسترداد."); return; }
    setBusy(true); setErr("");
    try { const res = await api.refundPayment(payment.id, reason.trim(), amount === "" ? undefined : n); onDone(res); onClose(); }
    catch (e) { setErr(e?.arabic || "تعذّر الاسترداد."); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={!!payment} onClose={busy ? () => {} : onClose} title="استرداد مبلغ">
      <p className="text-xs leading-6 mb-3" style={{ color: C.textMuted }}>
        {payment.user_email} · الدفعة <span dir="ltr">{money(payment.amount, payment.currency)}</span> · المتبقّي القابل للاسترداد <b dir="ltr">{money(payment.refundable, payment.currency)}</b>
      </p>
      <div className="rounded-xl p-3 mb-3 text-[11px] leading-6" style={{ background: C.crisisSoft, color: C.crisis }}>
        <AlertTriangle size={12} className="inline ml-1" />
        يُنفَّذ لدى المزوّد فعلاً ويُرجع المال لوسيلة الدفع، ويصدر إشعاراً دائناً بترقيم رسمي لا يُحذف. الاسترداد الكامل يقطع وصول المستخدم فوراً.
        لا يُتراجع عنه من هنا. إن رفض المزوّد لا يتغيّر شيء عندنا.
      </div>
      <Field label="المبلغ بالريال" hint="اتركه فارغاً لاسترداد كامل المتبقّي.">
        <Input type="number" step="0.01" min="0.01" max={payment.refundable} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={payment.refundable.toFixed(2)} dir="ltr" />
      </Field>
      <Field label="السبب" hint="يُحفظ في سجل التدقيق باسمك."><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <label className="flex items-center gap-2 text-xs mt-2" style={{ color: C.text }}>
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
        أؤكد استرداد <b dir="ltr">{Number.isFinite(n) ? money(n, payment.currency) : "—"}</b> ({kind}).
      </label>
      <ErrorBar error={err} />
      <div className="flex gap-2 mt-4">
        <Button variant="danger" onClick={submit} busy={busy} disabled={busy}>تنفيذ الاسترداد</Button>
        <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
      </div>
    </Modal>
  );
}

/* ---------------- الاستردادات ---------------- */
function Refunds() {
  const [page, setPage] = useState(1);
  const state = useAsync(() => api.billingRefunds({ page }), [page]);
  const rows = state.data?.refunds || [];
  return (
    <Card>
      <ErrorBar error={state.error} />
      {state.loading ? <div className="py-8 flex justify-center"><Spinner /></div> : rows.length === 0 ? <Empty>لا استردادات.</Empty> : (
        <Table head={["المستخدم", "المبلغ", "النوع", "الحالة", "الإشعار الدائن", "السبب", "من", "التاريخ"]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <Td dir="ltr">{r.user_email}</Td>
              <Td dir="ltr">{money(r.amount, r.currency)}</Td>
              <Td>{r.kind === "full" ? "كامل" : r.kind === "partial" ? "جزئي" : r.kind}</Td>
              <Td><Badge color={r.status === "succeeded" ? "green" : r.status === "failed" ? "crisis" : "amber"}>{r.status}</Badge>{r.error && <div className="text-[10px] mt-1" style={{ color: C.textFaint }}>{r.error}</div>}</Td>
              <Td dir="ltr">{r.credit_note_number || "—"}</Td>
              <Td className="max-w-xs"><span style={{ color: C.textMuted }}>{r.reason || "—"}</span></Td>
              <Td>{r.initiated_by === "admin" ? "الإدارة" : r.initiated_by === "provider" ? "لوحة المزوّد" : r.initiated_by || "—"}</Td>
              <Td>{fmtDateTime(r.created_at)}</Td>
            </tr>
          ))}
        </Table>
      )}
      <Pager page={page} totalPages={state.data?.totalPages} total={state.data?.total} onPage={setPage} />
    </Card>
  );
}

/* ---------------- أحداث الدفع + إعادة التشغيل ---------------- */
function Events({ me, toast }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const state = useAsync(() => api.webhookEvents({ page, status }), [page, status]);
  const [view, setView] = useState(null);
  const [reason, setReason] = useState(null);
  const rows = state.data?.events || [];
  const summary = state.data?.summary || {};
  return (
    <Card>
      <div className="flex gap-2 mb-3 items-center flex-wrap">
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="all">كل الحالات</option>
          {Object.entries(EVT_STATUS).map(([k, l]) => <option key={k} value={k}>{l}{summary[k] !== undefined ? ` (${summary[k]})` : ""}</option>)}
        </Select>
        <span className="text-[11px]" style={{ color: C.textFaint }}>الحدث المرفوض بسرّ خاطئ لا يُسجَّل أصلاً.</span>
      </div>
      <ErrorBar error={state.error} />
      {state.loading ? <div className="py-8 flex justify-center"><Spinner /></div> : rows.length === 0 ? <Empty>لا أحداث.</Empty> : (
        <Table head={["النوع", "الحالة", "النتيجة", "المحاولات", "وصل", ""]}>
          {rows.map((e) => (
            <tr key={e.id}>
              <Td dir="ltr">{e.event_type}</Td>
              <Td><Badge color={e.status === "processed" ? "green" : e.status === "failed" ? "crisis" : "textMuted"}>{EVT_STATUS[e.status] || e.status}</Badge>{e.error && <div className="text-[10px] mt-1" style={{ color: C.textFaint }}>{e.error}</div>}</Td>
              <Td dir="ltr">{e.outcome || "—"}</Td>
              <Td>{e.attempts}</Td>
              <Td>{fmtDateTime(e.received_at)}</Td>
              <Td>
                <div className="flex gap-1.5 justify-end">
                  {can(me, "webhooks:view_payload") && <Button size="sm" variant="ghost" onClick={() => setView(e.id)}><Eye size={12} /> الحمولة</Button>}
                  {can(me, "webhooks:replay") && (
                    <Button size="sm" variant="warn" onClick={() => setReason({
                      title: "إعادة معالجة حدث دفع",
                      description: "يعيد تمرير هذا الحدث المسجَّل على منطق الدفع نفسه. آمن من التكرار: الدفعة والفاتورة والاشتراك لا تُنشأ مرتين (قيود فريدة). يُستعمل بعد إصلاح سبب فشل (مثل إعداد ضريبي ناقص). لا يتصل بالمزوّد ولا يحرّك مالاً.",
                      confirmLabel: "إعادة المعالجة",
                      run: async (r) => { const res = await api.replayWebhookEvent(e.id, r); toast(`أُعيدت المعالجة: ${res.outcome}`); state.reload(); },
                    })}><RotateCcw size={12} /> إعادة</Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <Pager page={page} totalPages={state.data?.totalPages} total={state.data?.total} onPage={setPage} />
      <PayloadModal id={view} onClose={() => setView(null)} />
      <ReasonPrompt open={!!reason} title={reason?.title || ""} description={reason?.description}
        confirmLabel={reason?.confirmLabel} onConfirm={(r) => reason.run(r)} onClose={() => setReason(null)} />
    </Card>
  );
}

function PayloadModal({ id, onClose }) {
  const state = useAsync(() => (id ? api.webhookEvent(id) : Promise.resolve(null)), [id]);
  return (
    <Modal open={!!id} onClose={onClose} title="حمولة الحدث" width={720}>
      <p className="text-[11px] mb-2" style={{ color: C.textFaint }}>السر (secret_token) منزوع عند التخزين ولا يُعرض. هذه الشاشة للتشخيص فقط.</p>
      <ErrorBar error={state.error} />
      {state.loading ? <Spinner /> : state.data && (
        <pre dir="ltr" className="text-[11px] p-3 rounded-xl overflow-auto max-h-[60vh]" style={{ background: C.surfaceAlt, color: C.text }}>
          {JSON.stringify(state.data.event?.payload, null, 2)}
        </pre>
      )}
    </Modal>
  );
}

/* ---------------- تقرير التكامل ---------------- */
function Integrity() {
  const state = useAsync(() => api.billingIntegrity(), []);
  const d = state.data;
  const SEV = { critical: ["حرج", "crisis"], high: ["عالٍ", "crisis"], medium: ["متوسط", "amber"], low: ["منخفض", "textMuted"] };
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        {d && (d.ok
          ? <span className="text-xs font-bold flex items-center gap-1.5" style={{ color: C.green }}><CheckCircle2 size={14} /> لا تناقضات</span>
          : <span className="text-xs font-bold flex items-center gap-1.5" style={{ color: C.crisis }}><AlertTriangle size={14} /> {d.totalIssues} حالة تحتاج نظراً</span>)}
        <Button size="sm" variant="ghost" onClick={state.reload}><RefreshCw size={12} /> إعادة الفحص</Button>
      </div>
      <ErrorBar error={state.error} />
      {state.loading ? <div className="py-8 flex justify-center"><Spinner /></div> : d && (
        <Table head={["الفحص", "الخطورة", "العدد"]}>
          {d.checks.map((c) => (
            <tr key={c.key}>
              <Td className="max-w-md"><div>{c.description}</div><div className="text-[10px]" style={{ color: C.textFaint }} dir="ltr">{c.key}</div></Td>
              <Td><Badge color={(SEV[c.severity] || [])[1] || "textMuted"}>{(SEV[c.severity] || [c.severity])[0]}</Badge></Td>
              <Td><b style={{ color: c.count ? C.crisis : C.textMuted }}>{c.count}</b></Td>
            </tr>
          ))}
        </Table>
      )}
      {d && <p className="text-[11px] mt-3" style={{ color: C.textFaint }}>آخر فحص: {fmtDateTime(d.checkedAt)}. التقرير للقراءة؛ التصحيح بالإجراءات المشروعة (إعادة إصدار، مطابقة، إعادة معالجة) لا بتعديل البيانات.</p>}
    </Card>
  );
}
