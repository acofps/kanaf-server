import React, { useState } from "react";
import { RefreshCw, AlertTriangle, Download, Eye, X } from "lucide-react";
import { api } from "../api.js";
import { Link, useQueryState } from "../router.js";
import { UserLink } from "./Users.jsx";
import { C, can, fmtDate, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Spinner, Empty, ErrorBar, Table, Td, Pager, useAsync, Input, Select, SearchBox,
} from "../ui.jsx";

/* ============================================================
   الفواتير والإشعارات الدائنة.

   هذه الشاشة للقراءة فقط عمداً: وثيقة ضريبية صادرة لا تُعدَّل ولا
   تُحذف. التصحيح الوحيد المشروع هو إشعار دائن جديد يشير إليها.

   الاستثناء الوحيد «إعادة التوليد» — وهو لفاتورة مدفوعة لم يُصدَر
   لها رقم أصلاً (فشل التوليد وقت الدفع)، لا لتغيير رقم قائم.

   KANAF-ORD-0015 §2.7:
   • القائمة والترويسة والتصدير من بنّاء شرط واحد في الخادم (admin/filters.js) —
     /admin/billing/invoices يعيد الصفوف والمجاميع بالشرط نفسه، ورابط CSV يحمل الفلاتر نفسها.
   • الترويسة ثلاثة أرقام وعدّاد، على الفلتر المطبَّق، وتحتها سطر يقول نطاقها؛ والإشعارات
     الدائنة سطر مستقلّ لا يُطرح من الأرقام.
   • «معاينة» تفتح الملف للقراءة في المتصفّح، و«تنزيل» تنزّله — كلاهما خلف جلسة الإدارة.
   ============================================================ */

const sar = (v) => `${Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س`;
const STATUS = { paid: "مدفوعة", pending: "معلّقة", failed: "فاشلة", refunded: "مستردة", all: "كل الحالات" };

export default function Invoices({ me, toast, route = [] }) {
  const tab = route[0] === "credit" ? "credit" : "invoices"; // ORD-0013 §3.1: /invoices و /invoices/credit
  const f = useInvoiceFilters(tab);
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <PageTitle title="الفواتير" subtitle="وثائق ضريبية — للقراءة فقط. التصحيح يكون بإشعار دائن لا بتعديل.">
        {can(me, "exports:billing") && (
          <div className="flex gap-2">
            {/* KANAF-ORD-0015 §2.7.3: الملف يحمل فلاتر الشاشة نفسها — لا ينحرف المصدَّر عن المعروض */}
            <a href={api.exportUrl("invoices", f.serverParams)}><Button size="sm" variant="ghost"><Download size={13} /> الفواتير CSV (المعروض)</Button></a>
            <a href={api.exportUrl("payments", { from: f.values.from, to: f.values.to })}><Button size="sm" variant="ghost"><Download size={13} /> المدفوعات CSV</Button></a>
          </div>
        )}
      </PageTitle>
      <div className="flex gap-1.5">
        {[["invoices", "الفواتير"], ["credit", "الإشعارات الدائنة"]].map(([k, l]) => (
          <Link key={k} to={k === "invoices" ? "/invoices" : "/invoices/credit"} aria-current={tab === k ? "page" : undefined} className="px-3 py-1.5 rounded-xl text-xs font-bold"
            style={{ background: tab === k ? C.teal : C.surfaceAlt, color: tab === k ? C.onAccent : C.textMuted }}>
            {l}
          </Link>
        ))}
      </div>
      <FilterBar f={f} tab={tab} />
      {tab === "invoices" ? <InvoiceList f={f} toast={toast} /> : <CreditNotes f={f} />}
    </div>
  );
}

/* الفلاتر في العنوان: الرابط المنسوخ يفتح النطاق نفسه، والترويسة تُحسب عليه. */
function useInvoiceFilters(tab) {
  const [from, setFrom] = useQueryState("from", "");
  const [to, setTo] = useQueryState("to", "");
  const [plan, setPlan] = useQueryState("plan", "all");
  const [search, setSearch] = useQueryState("q", "");
  const [status, setStatus] = useQueryState("status", "paid");
  const [min, setMin] = useQueryState("min", "");
  const [max, setMax] = useQueryState("max", "");
  const [number, setNumber] = useQueryState("number", "");
  const [page, setPage] = useQueryState("page", 1);
  const values = { from, to, plan, search, status, min, max, number };
  const setters = { from: setFrom, to: setTo, plan: setPlan, search: setSearch, status: setStatus, min: setMin, max: setMax, number: setNumber };
  const set = (k) => (v) => { setters[k](v); setPage(1); };
  const serverParams = { from, to, plan, search, min, max, number, ...(tab === "invoices" ? { status } : {}) };
  const reset = () => { Object.entries(setters).forEach(([k, s]) => s(k === "plan" ? "all" : k === "status" ? "paid" : "")); setPage(1); };
  return { values, set, serverParams, page, setPage, reset };
}

function FilterBar({ f, tab }) {
  const plans = useAsync(() => api.listPlans(), []);
  const v = f.values;
  const lbl = "inline-flex flex-col gap-1 text-[12px] font-bold";
  return (
    <Card>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <label className={lbl} style={{ color: C.textMuted, gridColumn: "span 2" }}>العميل (اسم أو بريد أو معرّف)
          <SearchBox value={v.search} onChange={f.set("search")} placeholder="اسم أو بريد…" />
        </label>
        <label className={lbl} style={{ color: C.textMuted }}>{tab === "invoices" ? "رقم الفاتورة" : "رقم الإشعار أو الفاتورة"}
          <Input value={v.number} onChange={(e) => f.set("number")(e.target.value)} dir="ltr" placeholder="TNFS-INV-…" />
        </label>
        <label className={lbl} style={{ color: C.textMuted }}>من تاريخ
          <Input type="date" value={v.from} onChange={(e) => f.set("from")(e.target.value)} />
        </label>
        <label className={lbl} style={{ color: C.textMuted }}>إلى تاريخ
          <Input type="date" value={v.to} onChange={(e) => f.set("to")(e.target.value)} />
        </label>
        <label className={lbl} style={{ color: C.textMuted }}>الباقة
          <Select value={v.plan} onChange={(e) => f.set("plan")(e.target.value)}>
            <option value="all">كل الباقات</option>
            {(plans.data?.plans || []).map((p) => <option key={p.plan_key} value={p.plan_key}>{p.name}</option>)}
          </Select>
        </label>
        {tab === "invoices" && (
          <label className={lbl} style={{ color: C.textMuted }}>الحالة
            <Select value={v.status} onChange={(e) => f.set("status")(e.target.value)}>
              {Object.entries(STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </label>
        )}
        <label className={lbl} style={{ color: C.textMuted }}>المبلغ من (ر.س)
          <Input type="number" min="0" step="0.01" value={v.min} onChange={(e) => f.set("min")(e.target.value)} dir="ltr" />
        </label>
        <label className={lbl} style={{ color: C.textMuted }}>المبلغ إلى (ر.س)
          <Input type="number" min="0" step="0.01" value={v.max} onChange={(e) => f.set("max")(e.target.value)} dir="ltr" />
        </label>
        <div className="flex items-end">
          <Button size="sm" variant="ghost" onClick={f.reset}><X size={13} /> مسح الفلاتر</Button>
        </div>
      </div>
    </Card>
  );
}

/* السطر الذي يقول على أي نطاق حُسبت الأرقام — رقمٌ بلا نطاقه يُبنى عليه قرار خاطئ. */
function scopeLine(v, tab, plans) {
  const parts = [];
  parts.push(v.from || v.to ? `${tab === "invoices" ? "أُنشئت" : "صدرت"} ${v.from ? `من ${v.from}` : ""}${v.from && v.to ? " " : ""}${v.to ? `إلى ${v.to}` : ""}` : "كل التاريخ");
  if (tab === "invoices") parts.push(`الحالة: ${STATUS[v.status] || v.status}`);
  if (v.plan !== "all") parts.push(`الباقة: ${plans?.find((p) => p.plan_key === v.plan)?.name || v.plan}`);
  if (v.search) parts.push(`العميل: «${v.search}»`);
  if (v.number) parts.push(`الرقم: «${v.number}»`);
  if (v.min || v.max) parts.push(`المبلغ ${v.min ? `من ${v.min}` : ""}${v.min && v.max ? " " : ""}${v.max ? `إلى ${v.max}` : ""} ر.س`);
  return parts.join(" · ");
}

function Tile({ label, value, sub, tone }) {
  return (
    <div className="rounded-2xl px-4 py-3" style={{ background: C.surface, border: `1px solid ${C.line}` }} data-tile={label}>
      <div className="text-[12px] font-bold mb-1" style={{ color: C.textMuted }}>{label}</div>
      <div className="text-[20px] font-bold" style={{ color: tone || C.text }}>{value}</div>
      {sub && <div className="text-[11px] mt-0.5" style={{ color: C.textFaint }}>{sub}</div>}
    </div>
  );
}

function SummaryHeader({ s, tab, values, kind }) {
  const plans = useAsync(() => api.listPlans(), []);
  if (!s) return null;
  return (
    <section aria-label="ملخص النطاق المعروض" className="grid gap-2">
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        <Tile label={kind === "credit" ? "عدد الإشعارات الدائنة" : "عدد الفواتير"} value={s.count} />
        <Tile label={kind === "credit" ? "المردود قبل الضريبة" : "الإيراد قبل الضريبة"} value={sar(s.subtotal)}
          sub={kind === "credit" ? null : "دخل المنشأة"} />
        <Tile label="ضريبة القيمة المضافة" value={sar(s.vat)} sub={kind === "credit" ? "ضريبة مُعادة" : "محصَّلة للدولة لا دخل"} />
        <Tile label={kind === "credit" ? "إجمالي المردود بعد الضريبة" : "الإجمالي المحصَّل بعد الضريبة"} value={sar(s.total)} tone={kind === "credit" ? C.amber : C.green} />
      </div>
      <p className="text-[12px] leading-6" style={{ color: C.textMuted }} data-scope>
        محسوبة على: {scopeLine(values, tab, plans.data?.plans)}.
        {kind !== "credit" && s.without_split > 0 && <> {s.without_split} فاتورة بلا تفصيل ضريبي داخلة في الإجمالي وحده.</>}
      </p>
      {kind !== "credit" && s.creditNotes && (
        <p className="text-[12px] leading-6 rounded-xl px-3 py-2" style={{ background: C.amberSoft, color: C.amber }} data-credit-line>
          {s.creditNotes.count > 0
            ? <>إشعارات دائنة صدرت على فواتير هذا النطاق: {s.creditNotes.count} بـ{sar(s.creditNotes.total)} (قبل الضريبة {sar(s.creditNotes.subtotal)}، ضريبة {sar(s.creditNotes.vat)}). <b>الأرقام أعلاه لا تطرحها</b> — الصافي بعدها {sar(Number(s.total) - Number(s.creditNotes.total))} بعد الضريبة، و{sar(Number(s.subtotal) - Number(s.creditNotes.subtotal))} قبلها.</>
            : <>لا إشعارات دائنة على فواتير هذا النطاق — الأرقام أعلاه صافية.</>}
        </p>
      )}
    </section>
  );
}

function DocActions({ pdfUrl, label }) {
  return (
    <div className="flex gap-1.5 justify-end">
      {/* معاينة: الملف نفسه للقراءة في المتصفّح (inline)، خلف جلسة الإدارة كالتنزيل */}
      <a href={pdfUrl} target="_blank" rel="noreferrer" aria-label={`معاينة ${label}`}
        className="kt-act inline-flex items-center gap-1.5 rounded-xl font-bold px-3 text-xs"
        style={{ minHeight: 36, background: C.tealSoft, color: C.teal }} data-preview>
        <Eye size={13} aria-hidden="true" /> معاينة
      </a>
      <a href={`${pdfUrl}?download=1`} aria-label={`تنزيل ${label} PDF`}
        className="kt-act inline-flex items-center gap-1.5 rounded-xl font-bold px-3 text-xs"
        style={{ minHeight: 36, background: C.surfaceAlt, color: C.textMuted }} data-download>
        <Download size={13} aria-hidden="true" /> PDF
      </a>
    </div>
  );
}

function InvoiceList({ f, toast }) {
  const state = useAsync(() => api.billingInvoices({ ...f.serverParams, page: f.page }), [JSON.stringify(f.serverParams), f.page]);
  const [busyId, setBusyId] = useState(null);

  const rows = state.data?.invoices || [];
  const needs = state.data?.needsAttention || 0;

  const regen = async (id) => {
    setBusyId(id);
    try { await api.regenerateInvoice(id); toast("أُصدر رقم الفاتورة."); state.reload(); }
    catch (e) { toast(e?.arabic || "تعذّرت إعادة التوليد."); }
    finally { setBusyId(null); }
  };

  return (
    <>
      <SummaryHeader s={state.data?.summary} tab="invoices" values={f.values} />
      {needs > 0 && (
        <div className="rounded-xl px-3 py-2.5 flex items-start gap-2" style={{ background: C.amberSoft }}>
          <AlertTriangle size={14} color={C.amber} className="mt-0.5 shrink-0" />
          <span className="text-xs leading-6" style={{ color: C.amber }}>
            {needs} فاتورة مدفوعة بلا رقم ضريبي — كل واحدة منها التزام نظامي مفتوح.
          </span>
        </div>
      )}
      <ErrorBar error={state.error} />
      {state.loading ? (
        <div className="py-8 flex justify-center"><Spinner /></div>
      ) : rows.length === 0 ? (
        <Empty>لا فواتير في هذا النطاق.</Empty>
      ) : (
        <div>
          <Table caption="الفواتير في النطاق المعروض" minWidth={900}
            head={["رقم الفاتورة", "العميل", "الباقة", "الحالة", "قبل الضريبة", "الضريبة", "الإجمالي", "الإصدار", "معاينة / تنزيل"]}
            align={[, , , , , , , , "end"]}>
            {rows.map((inv) => (
              <tr key={inv.id}>
                <Td dir="ltr">
                  {inv.invoice_number
                    ? <code className="text-[12px] font-bold">{inv.invoice_number}</code>
                    : <Badge color="amber">بلا رقم</Badge>}
                </Td>
                <Td>
                  <div><UserLink id={inv.user_id} name={inv.user_name} email={inv.user_email} /></div>
                  <div dir="ltr" className="text-[11px]" style={{ color: C.textFaint, textAlign: "right" }}>{inv.user_email}</div>
                </Td>
                <Td>{inv.plan_name || inv.plan_id}</Td>
                <Td><Badge color={inv.payment_status === "paid" ? "green" : inv.payment_status === "pending" ? "amber" : "textFaint"}>{STATUS[inv.payment_status] || inv.payment_status}</Badge></Td>
                <Td>{Number(inv.subtotal_sar ?? 0).toFixed(2)}</Td>
                <Td>{Number(inv.vat_sar ?? 0).toFixed(2)}</Td>
                <Td className="font-bold">{Number(inv.amount_sar ?? 0).toFixed(2)} ر.س</Td>
                <Td>{inv.zatca_issued_at ? fmtDate(inv.zatca_issued_at) : fmtDate(inv.created_at)}</Td>
                <Td>
                  {inv.invoice_number && inv.has_pdf ? (
                    <DocActions pdfUrl={api.invoicePdfUrl(inv.id)} label={`الفاتورة ${inv.invoice_number}`} />
                  ) : inv.payment_status === "paid" && !inv.invoice_number ? (
                    <div className="flex justify-end">
                      <Button size="sm" variant="warn" busy={busyId === inv.id} onClick={() => regen(inv.id)}>
                        <RefreshCw size={12} /> إصدار الرقم
                      </Button>
                    </div>
                  ) : <span style={{ color: C.textFaint }}>—</span>}
                </Td>
              </tr>
            ))}
          </Table>
          <Pager page={state.data?.page || 1} totalPages={state.data?.totalPages || 1} total={state.data?.total} onPage={f.setPage} />
        </div>
      )}
    </>
  );
}

function CreditNotes({ f }) {
  const params = { ...f.serverParams, page: f.page };
  const state = useAsync(() => api.billingCreditNotes(params), [JSON.stringify(params)]);
  const rows = state.data?.creditNotes || [];
  return (
    <>
      <SummaryHeader s={state.data?.summary} tab="credit" kind="credit" values={f.values} />
      <ErrorBar error={state.error} />
      {state.loading ? (
        <div className="py-8 flex justify-center"><Spinner /></div>
      ) : rows.length === 0 ? (
        <Empty>لا إشعارات دائنة في هذا النطاق.</Empty>
      ) : (
        <div>
          <Table caption="الإشعارات الدائنة في النطاق المعروض" minWidth={860}
            head={["رقم الإشعار", "الفاتورة الأصلية", "العميل", "قبل الضريبة", "الضريبة", "المبلغ", "السبب", "التاريخ", "معاينة / تنزيل"]}
            align={[, , , , , , , , "end"]}>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td dir="ltr"><code className="text-[12px] font-bold">{c.credit_note_number}</code></Td>
                <Td dir="ltr"><code className="text-[12px]">{c.original_invoice_number || "—"}</code></Td>
                <Td>
                  <div><UserLink id={c.user_id} name={c.user_name} email={c.user_email} /></div>
                  <div dir="ltr" className="text-[11px]" style={{ color: C.textFaint, textAlign: "right" }}>{c.user_email}</div>
                </Td>
                <Td>{Number(c.subtotal_sar ?? 0).toFixed(2)}</Td>
                <Td>{Number(c.vat_sar ?? 0).toFixed(2)}</Td>
                <Td className="font-bold"><span style={{ color: C.amber }}>{Number(c.amount_sar ?? 0).toFixed(2)} ر.س</span></Td>
                <Td className="max-w-xs"><span style={{ color: C.textMuted }}>{c.reason || "—"}</span></Td>
                <Td>{fmtDateTime(c.zatca_issued_at)}</Td>
                <Td>{c.has_pdf ? <DocActions pdfUrl={api.creditNotePdfUrl(c.id)} label={`الإشعار ${c.credit_note_number}`} /> : <span style={{ color: C.textFaint }}>—</span>}</Td>
              </tr>
            ))}
          </Table>
          <Pager page={state.data?.page || 1} totalPages={state.data?.totalPages || 1} total={state.data?.total} onPage={f.setPage} />
        </div>
      )}
    </>
  );
}
