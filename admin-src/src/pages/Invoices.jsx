import React, { useState } from "react";
import { FileText, RefreshCw, AlertTriangle, Download } from "lucide-react";
import { api } from "../api.js";
import { C, can, fmtDate, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Spinner, Empty, ErrorBar, Table, Td, Pager, useAsync,
} from "../ui.jsx";

/* ============================================================
   الفواتير والإشعارات الدائنة.

   هذه الشاشة للقراءة فقط عمداً: وثيقة ضريبية صادرة لا تُعدَّل ولا
   تُحذف. التصحيح الوحيد المشروع هو إشعار دائن جديد يشير إليها.

   الاستثناء الوحيد «إعادة التوليد» — وهو لفاتورة مدفوعة لم يُصدَر
   لها رقم أصلاً (فشل التوليد وقت الدفع)، لا لتغيير رقم قائم.
   ============================================================ */

export default function Invoices({ me, toast }) {
  const [tab, setTab] = useState("invoices");
  return (
    <div>
      <PageTitle title="الفواتير" subtitle="وثائق ضريبية — للقراءة فقط. التصحيح يكون بإشعار دائن لا بتعديل.">
        {can(me, "exports:billing") && (
          <div className="flex gap-2">
            <a href={api.exportUrl("invoices")}><Button size="sm" variant="ghost"><Download size={13} /> الفواتير CSV</Button></a>
            <a href={api.exportUrl("payments")}><Button size="sm" variant="ghost"><Download size={13} /> المدفوعات CSV</Button></a>
          </div>
        )}
      </PageTitle>
      <div className="flex gap-1.5 mb-4">
        {[["invoices", "الفواتير"], ["credit", "الإشعارات الدائنة"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className="px-3 py-1.5 rounded-xl text-xs font-bold"
            style={{ background: tab === k ? C.tealSoft : C.surfaceAlt, color: tab === k ? C.teal : C.textMuted }}>
            {l}
          </button>
        ))}
      </div>
      {tab === "invoices" ? <InvoiceList toast={toast} /> : <CreditNotes />}
    </div>
  );
}

function InvoiceList({ toast }) {
  const [page, setPage] = useState(1);
  const state = useAsync(() => api.listInvoices({ page }), [page]);
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
    <Card>
      {needs > 0 && (
        <div className="rounded-xl px-3 py-2.5 mb-4 flex items-start gap-2" style={{ background: C.amberSoft }}>
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
        <Empty>لا توجد فواتير مدفوعة.</Empty>
      ) : (
        <Table head={["رقم الفاتورة", "العميل", "الباقة", "الصافي", "الضريبة", "الإجمالي", "الإصدار", ""]}>
          {rows.map((inv) => (
            <tr key={inv.id}>
              <Td>
                {inv.zatca_invoice_number
                  ? <code className="text-[10px] font-bold">{inv.zatca_invoice_number}</code>
                  : <Badge color="amber">بلا رقم</Badge>}
              </Td>
              <Td>
                <div>{inv.user_name || "—"}</div>
                <div className="text-[10px]" style={{ color: C.textFaint }}>{inv.user_email}</div>
              </Td>
              <Td>{inv.plan_id}</Td>
              <Td>{Number(inv.subtotal_sar ?? 0).toFixed(2)}</Td>
              <Td>{Number(inv.vat_sar ?? 0).toFixed(2)}</Td>
              <Td className="font-bold">{Number(inv.amount_sar ?? 0).toFixed(2)} ر.س</Td>
              <Td>{inv.zatca_issued_at ? fmtDate(inv.zatca_issued_at) : fmtDate(inv.created_at)}</Td>
              <Td>
                <div className="flex gap-1.5 justify-end">
                  {inv.zatca_invoice_number ? (
                    <a href={api.invoicePdfUrl(inv.id)} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-xl font-bold px-3 py-1.5 text-xs"
                      style={{ background: C.surfaceAlt, color: C.textMuted }}>
                      <Download size={12} /> PDF
                    </a>
                  ) : (
                    <Button size="sm" variant="warn" busy={busyId === inv.id} onClick={() => regen(inv.id)}>
                      <RefreshCw size={12} /> إصدار الرقم
                    </Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <Pager page={state.data?.page || 1} totalPages={state.data?.totalPages || 1}
        total={state.data?.total} onPage={setPage} />
    </Card>
  );
}

function CreditNotes() {
  const state = useAsync(() => api.listCreditNotes(), []);
  const rows = state.data?.creditNotes || [];
  return (
    <Card>
      <ErrorBar error={state.error} />
      {state.loading ? (
        <div className="py-8 flex justify-center"><Spinner /></div>
      ) : rows.length === 0 ? (
        <Empty>لا توجد إشعارات دائنة.</Empty>
      ) : (
        <Table head={["رقم الإشعار", "الفاتورة الأصلية", "العميل", "المبلغ", "السبب", "التاريخ", ""]}>
          {rows.map((c) => (
            <tr key={c.id}>
              <Td><code className="text-[10px] font-bold">{c.zatca_credit_note_number}</code></Td>
              <Td><code className="text-[10px]">{c.original_invoice_number || "—"}</code></Td>
              <Td>
                <div>{c.user_name || "—"}</div>
                <div className="text-[10px]" style={{ color: C.textFaint }}>{c.user_email}</div>
              </Td>
              <Td className="font-bold" >
                <span style={{ color: C.amber }}>{Number(c.amount_sar ?? 0).toFixed(2)} ر.س</span>
              </Td>
              <Td className="max-w-xs"><span style={{ color: C.textMuted }}>{c.reason || "—"}</span></Td>
              <Td>{fmtDateTime(c.zatca_issued_at)}</Td>
              <Td>
                <div className="flex justify-end">
                  <a href={api.creditNotePdfUrl(c.id)} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-xl font-bold px-3 py-1.5 text-xs"
                    style={{ background: C.surfaceAlt, color: C.textMuted }}>
                    <Download size={12} /> PDF
                  </a>
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
