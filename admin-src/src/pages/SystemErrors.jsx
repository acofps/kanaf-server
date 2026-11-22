import React, { useState } from "react";
import { api } from "../api.js";
import { C, fmtDateTime } from "../theme.js";
import { Card, PageTitle, Button, Badge, SearchBox, Spinner, Empty, ErrorBar, ReasonPrompt, Table, Td, Pager, useAsync } from "../ui.jsx";
import { useQueryState } from "../router.js";

/* ============================================================
   أخطاء النظام — KANAF-ORD-0013 §11
   لكل خطأ: كيف حدث (نوعه ورسالته ومسار الاستدعاء)، وأين (المسار أو العملية)،
   ومتى (أول وآخر ظهور وعدد المرات). المخزَّن منقّى من الخادم قبل التخزين:
   لا بيانات شخصية ولا نص مستخدم ولا أسرار ولا سلسلة اتصال.
   ============================================================ */
export default function SystemErrors({ toast }) {
  const [q, setQ] = useQueryState("q", "");
  const [page, setPage] = useQueryState("page", 1);
  const [open, setOpen] = useState(null);
  const [del, setDel] = useState(null);
  const state = useAsync(() => api.listSystemErrors({ q, page }), [q, page]);
  const rows = state.data?.errors || [];
  return (
    <div>
      <PageTitle title="أخطاء النظام" subtitle="المتكرر صفّ واحد بعدّاده. الرسائل منقّاة قبل التخزين، ويُحتفظ بها 30 يوماً." />
      <Card>
        <div className="mb-4" style={{ maxWidth: 360 }}>
          <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="نوع أو رسالة أو مسار…" />
        </div>
        <ErrorBar error={state.error} />
        {state.loading ? <div className="py-8 flex justify-center"><Spinner /></div>
          : rows.length === 0 ? <Empty>لا أخطاء مسجَّلة.</Empty>
          : (
            <>
              <Table head={["آخر ظهور", "النوع", "الرسالة", "أين", "المرات", "أول ظهور", ""]}>
                {rows.map((e) => (
                  <React.Fragment key={e.id}>
                    <tr>
                      <Td dir="ltr">{fmtDateTime(e.last_seen)}</Td>
                      <Td><Badge color="crisis">{e.kind}</Badge></Td>
                      <Td className="max-w-md"><span dir="ltr" className="text-[11px] break-all">{e.message}</span></Td>
                      <Td><code className="text-[10px]" dir="ltr">{e.location}</code></Td>
                      <Td>{e.count}</Td>
                      <Td dir="ltr">{fmtDateTime(e.first_seen)}</Td>
                      <Td>
                        <div className="flex gap-1.5 justify-end">
                          {e.stack && <Button size="sm" variant="ghost" onClick={() => setOpen(open === e.id ? null : e.id)}>المسار</Button>}
                          <Button size="sm" variant="ghost" onClick={() => setDel(e)}>عولج</Button>
                        </div>
                      </Td>
                    </tr>
                    {open === e.id && (
                      <tr><td colSpan={7} className="pb-3 px-2">
                        <pre className="text-[10px] leading-5 rounded-xl p-3 overflow-x-auto" dir="ltr" style={{ background: C.surfaceAlt, color: C.textMuted }}>{e.stack}</pre>
                      </td></tr>
                    )}
                  </React.Fragment>
                ))}
              </Table>
              <Pager page={state.data.page} totalPages={state.data.totalPages} total={state.data.total} onPage={setPage} />
            </>
          )}
      </Card>
      <ReasonPrompt open={!!del} title="إزالة خطأ عولج" description="يُحذف الصف من السجل، ويُسجَّل الإجراء في سجل الإجراءات."
        onClose={() => setDel(null)}
        onConfirm={async (reason) => { await api.clearSystemError(del.id, reason); toast("أُزيل."); state.reload(); }} />
    </div>
  );
}
