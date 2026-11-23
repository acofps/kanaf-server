import React from "react";
import { api } from "../api.js";
import { C } from "../theme.js";
import { Card, PageTitle, Badge, Spinner, Empty, ErrorBar, Table, Td, Pager, useAsync } from "../ui.jsx";
import { useQueryState } from "../router.js";

/* ============================================================
   الأعضاء الملغون — KANAF-ORD-0013 §8 (قرار المالك: الاحتفاظ بلا هوية)
   🔴 لا اسم ولا رابط ملف ولا تصدير يحمل هوية (§8.4) — استثناء مقصود من §4.2.
   المعرّف عشوائي لا يُردّ إلى صاحبه، والتواريخ بالشهر. ولا استرجاع (§8.3).
   ============================================================ */
const REASON = {
  account_deleted_by_member: "حذف حسابه بنفسه",
  account_deleted_after_subscription_cancel: "ألغى اشتراكه ثم حذف حسابه",
};
const SERVICE = { daily_logs: "المتابعة اليومية", screenings: "المقاييس", notebooks: "الدفاتر", cbt_sessions: "أدوات العلاج", journeys: "الرحلات", plans: "الخطط" };

export default function CancelledMembers() {
  const [page, setPage] = useQueryState("page", 1);
  const state = useAsync(() => api.listCancelledMembers({ page }), [page]);
  const d = state.data;
  const rows = d?.members || [];
  return (
    <div>
      <PageTitle title="الأعضاء الملغون" subtitle="سجلّ مجهول لا يُردّ إلى صاحبه: لا اسم ولا بريد ولا معرّف حساب. والفواتير الصادرة خارج هذا القسم، باقية كما صدرت." />
      {d && (
        <p className="text-[11px] leading-6 mb-3" style={{ color: C.textFaint }}>
          الحذف على مرحلتين: طلب العضو يعطّل حسابه فوراً، والمحو النهائي (الذي يكتب السجل هنا) يُتمّه المالك من ملف الحساب المعطّل.
          بانتظار المحو الآن: <b style={{ color: C.text }}>{d.pendingPurge}</b> حساب.
        </p>
      )}
      <Card>
        <ErrorBar error={state.error} />
        {state.loading ? <div className="py-8 flex justify-center"><Spinner /></div>
          : rows.length === 0 ? <Empty>لا سجلات بعد.</Empty>
          : (
            <>
              <Table head={["المعرّف البديل", "انضمّ", "ألغى", "مدة البقاء", "الباقة", "أيام الاشتراك", "السبب", "الخدمات المستخدَمة", "المكتمل"]}>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <Td><code className="text-[10px]" dir="ltr">{m.id.slice(0, 8)}</code></Td>
                    <Td dir="ltr">{m.joined_month}</Td>
                    <Td dir="ltr">{m.cancelled_month}</Td>
                    <Td>{m.membership_days} يوماً</Td>
                    <Td>{m.plan_key || "—"}</Td>
                    <Td>{m.subscription_days ?? "—"}</Td>
                    <Td><Badge>{REASON[m.cancel_reason] || m.cancel_reason}</Badge></Td>
                    <Td className="text-[11px]">
                      {Object.entries(m.services || {}).filter(([, v]) => v.count > 0)
                        .map(([k, v]) => `${SERVICE[k] || k}: ${v.count} (${v.first_month}${v.last_month !== v.first_month ? `–${v.last_month}` : ""})`).join(" · ") || "—"}
                    </Td>
                    <Td className="text-[11px]">
                      {[...Object.entries(m.completed?.journeys || {}).map(([k, n]) => `رحلة ${k}×${n}`),
                        ...Object.entries(m.completed?.tools || {}).map(([k, n]) => `أداة ${k}×${n}`)].join(" · ") || "—"}
                    </Td>
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
