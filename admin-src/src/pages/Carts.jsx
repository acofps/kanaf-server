import React, { useState } from "react";
import { Megaphone } from "lucide-react";
import { api } from "../api.js";
import { C, fmtDateTime, can } from "../theme.js";
import { Card, PageTitle, Button, Badge, Spinner, Empty, ErrorBar, Table, Td, Pager, useAsync } from "../ui.jsx";
import { Compose } from "./Notifications.jsx";

/* ============================================================
   السلات المتروكة — KANAF-ORD-0008 §4

   فاتورة معلّقة لم تُدفع بعد 20 دقيقة من إنشائها. لا «سلة» جديدة،
   ولا تتبّع لفتح صفحة الدفع، ولا وظيفة خلفية: كل شيء يُحسب عند فتح
   الصفحة من الفواتير القائمة.

   الاستهداف بزر واحد يفتح نموذج الحملة نفسه (صفحة الإشعارات) بفئة
   «أصحاب سلات متروكة» — نفس مسار التسليم ونفس احترام منع التسويق.
   ============================================================ */

const ago = (m) => (m < 60 ? `${m} دقيقة` : m < 1440 ? `${Math.floor(m / 60)} ساعة` : `${Math.floor(m / 1440)} يوم`);

export default function Carts({ me, toast }) {
  const [page, setPage] = useState(1);
  const [hidePurchased, setHidePurchased] = useState(true);
  const [compose, setCompose] = useState(false);
  const state = useAsync(() => api.listAbandonedCarts({ page, hidePurchased: hidePurchased ? "1" : "" }), [page, hidePurchased]);
  const d = state.data;
  const rows = d?.carts || [];

  return (
    <div>
      <PageTitle title="السلات المتروكة" subtitle={`فاتورة طُلب دفعها ولم تُدفع بعد ${d?.afterMinutes ?? 20} دقيقة. تُحسب عند فتح الصفحة.`}>
        {can(me, "notifications:create") && (
          <Button size="sm" onClick={() => setCompose(true)}>
            <span className="inline-flex items-center gap-1.5"><Megaphone size={14} strokeWidth={1.75} /> حملة لأصحاب السلات</span>
          </Button>
        )}
      </PageTitle>

      {d && (
        <div className="grid gap-3 sm:grid-cols-3 mb-4">
          <Card><p className="text-[11px]" style={{ color: C.textMuted }}>عملاء لم يكملوا الدفع</p><p className="text-xl font-bold mt-1">{d.summary.openCustomers}</p></Card>
          <Card><p className="text-[11px]" style={{ color: C.textMuted }}>قيمة الفواتير المفتوحة</p><p className="text-xl font-bold mt-1">{d.summary.openValueSar.toLocaleString("en-US", { maximumFractionDigits: 2 })} ر.س</p></Card>
          <Card><p className="text-[11px]" style={{ color: C.textMuted }}>اشتروا لاحقاً بفاتورة أخرى</p><p className="text-xl font-bold mt-1">{d.summary.purchasedLater}</p></Card>
        </div>
      )}

      <Card>
        <label className="flex items-center gap-2 text-xs mb-4" style={{ color: C.textMuted }}>
          <input type="checkbox" checked={hidePurchased} onChange={(e) => { setHidePurchased(e.target.checked); setPage(1); }} />
          إخفاء من اشترى لاحقاً (لا يُطارَد من اشترى)
        </label>
        <ErrorBar error={state.error} />
        {state.loading ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty>لا سلات متروكة الآن.</Empty>
        ) : (
          <>
            <Table head={["العميل", "الباقة", "المبلغ", "أُنشئت", "مضى", "اشترى لاحقاً", "التسويق"]}>
              {rows.map((r) => (
                <tr key={r.invoiceId}>
                  <Td>
                    <div className="font-bold">{r.customer.name || "—"}</div>
                    <div className="text-[11px]" dir="ltr" style={{ color: C.textFaint }}>{r.customer.emailMasked}</div>
                  </Td>
                  <Td>{r.planName || r.planKey}</Td>
                  <Td>{r.amountSar.toLocaleString("en-US", { maximumFractionDigits: 2 })} ر.س</Td>
                  <Td>{fmtDateTime(r.createdAt)}</Td>
                  <Td>{ago(r.minutesSince)}</Td>
                  <Td>{r.purchasedLater ? <Badge color="green">اشترى</Badge> : <Badge color="textMuted">لا</Badge>}</Td>
                  <Td>{r.marketingOptOut ? <Badge color="textMuted">أوقف التسويق</Badge> : "—"}</Td>
                </tr>
              ))}
            </Table>
            <Pager page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} />
          </>
        )}
      </Card>

      <Compose open={compose} onClose={() => setCompose(false)} initialAudience="abandoned_carts"
        onDone={(m) => { toast?.(m); }} />
    </div>
  );
}
