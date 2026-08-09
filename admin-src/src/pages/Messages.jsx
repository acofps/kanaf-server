import React, { useState } from "react";
import { api } from "../api.js";
import { C, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Select, SearchBox, Spinner, Empty, ErrorBar, Table, Td, useAsync,
} from "../ui.jsx";

/* ============================================================
   رسائل التواصل.

   هذه رسائل نموذج «تواصل معنا» — لا محتوى علاجي. تُحفظ في الخادم
   أولاً ثم يُحاول إرسال بريد التنبيه، فلا تضيع رسالة لأن مزوّد
   البريد كان معطلاً.
   ============================================================ */

const STATUS = {
  unread: { label: "غير مقروءة", color: "amber" },
  read: { label: "مقروءة", color: "textMuted" },
  replied: { label: "أُجيبت", color: "green" },
};

export default function Messages({ toast }) {
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState(null);
  const state = useAsync(() => api.listMessages(), []);

  const all = state.data?.messages || [];
  const rows = all.filter((m) => {
    if (filter && m.status !== filter) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return [m.name, m.email, m.message].some((v) => (v || "").toLowerCase().includes(q));
  });

  const setStatus = async (m, status) => {
    setBusyId(m.id);
    try { await api.setMessageStatus(m.id, status); state.reload(); }
    catch (e) { toast(e?.arabic || "تعذّر التحديث."); }
    finally { setBusyId(null); }
  };

  return (
    <div>
      <PageTitle title="الرسائل" subtitle="رسائل نموذج التواصل — أحدث 100 رسالة." />

      <Card>
        <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
          <SearchBox value={search} onChange={setSearch} placeholder="بحث بالاسم أو البريد أو النص…" />
          <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">كل الحالات</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        </div>

        <ErrorBar error={state.error} />
        {state.loading ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty>لا توجد رسائل مطابقة.</Empty>
        ) : (
          <Table head={["المرسل", "الرسالة", "الحالة", "التاريخ", ""]}>
            {rows.map((m) => {
              const s = STATUS[m.status] || { label: m.status, color: "textMuted" };
              return (
                <tr key={m.id}>
                  <Td>
                    <div className="font-bold">{m.name || "—"}</div>
                    <a href={`mailto:${m.email}`} className="text-[10px] underline" style={{ color: C.teal }}>
                      {m.email}
                    </a>
                  </Td>
                  <Td className="max-w-md">
                    <p className="leading-6 whitespace-pre-wrap" style={{ color: C.textMuted }}>{m.message}</p>
                  </Td>
                  <Td><Badge color={s.color}>{s.label}</Badge></Td>
                  <Td>{fmtDateTime(m.created_at)}</Td>
                  <Td>
                    <div className="flex gap-1.5 justify-end">
                      {m.status !== "read" && (
                        <Button size="sm" variant="ghost" busy={busyId === m.id}
                          onClick={() => setStatus(m, "read")}>مقروءة</Button>
                      )}
                      {m.status !== "replied" && (
                        <Button size="sm" variant="good" busy={busyId === m.id}
                          onClick={() => setStatus(m, "replied")}>أُجيبت</Button>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
        <p className="text-[11px] mt-3" style={{ color: C.textFaint }}>{rows.length} من {all.length}</p>
      </Card>
    </div>
  );
}
