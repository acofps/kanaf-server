import React, { useState } from "react";
import { api } from "../api.js";
import { useQueryState } from "../router.js";
import { UserLink } from "./Users.jsx";
import { C, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, SearchBox, Spinner, Empty, ErrorBar, Table, Td, Pager, useAsync,
} from "../ui.jsx";

/* ============================================================
   سجل الوصول.

   يُكتب **قبل** تنفيذ القراءة لا بعدها — فمحاولة الوصول تظهر هنا
   حتى لو فشل الاستعلام بعدها. وسجل يُكتب بعد النجاح فقط يخفي
   بالضبط الحالة التي بُني ليكشفها.
   ============================================================ */

const ACTION_LABEL = {
  view_sensitive_data: "عرض بيانات متابعة",
  view_sent_messages: "عرض الرسائل المرسلة",
  update_tax_settings: "تعديل البيانات الضريبية",
  update_billing_settings: "تعديل الإعداد المالي",
  update_app_setting: "تعديل إعداد تشغيل",
  payment_refund: "استرداد دفعة",
  payment_reconcile: "مطابقة دفعة",
  webhook_replay: "إعادة تشغيل حدث دفع",
  break_glass_request: "طلب وصول طارئ",
  break_glass_approve: "اعتماد وصول طارئ",
  manual_subscription_cancel: "إلغاء اشتراك يدوي",
  manual_subscription_refund: "استرداد يدوي",
  suspend_account: "إيقاف حساب",
  restore_account: "إعادة تفعيل حساب",
};

const SENSITIVE = new Set(["view_sensitive_data", "view_sent_messages", "break_glass_request", "break_glass_approve"]);

export default function AccessLog() {
  const [targetUserId, setTargetUserId] = useState(() => new URLSearchParams(window.location.search).get("user") || "");
  const [applied, setApplied] = useQueryState("user", "");
  const [page, setPage] = useQueryState("page", 1);
  const state = useAsync(() => api.listAccessLog(applied || undefined, page), [applied, page]);
  const d = state.data;
  const rows = d?.entries || [];

  return (
    <div>
      <PageTitle
        title="سجل الوصول"
        subtitle="يُكتب قبل تنفيذ القراءة، ولا يُعدَّل بعدها."
      />

      <Card>
        <div className="flex gap-2 mb-4 flex-wrap items-end">
          <div className="flex-1 min-w-[220px]">
            <SearchBox value={targetUserId} onChange={setTargetUserId} placeholder="تصفية بمعرّف المستخدم (UUID)…" />
          </div>
          <Button size="sm" onClick={() => { setApplied(targetUserId.trim()); setPage(1); }}>تصفية</Button>
          {applied && <Button size="sm" variant="ghost" onClick={() => { setTargetUserId(""); setApplied(""); setPage(1); }}>إلغاء التصفية</Button>}
        </div>

        <ErrorBar error={state.error} />
        {state.loading ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty>لا سجلات.</Empty>
        ) : (
          <Table head={["المسؤول", "الإجراء", "المستخدم المستهدف", "السبب", "IP", "التاريخ"]}>
            {rows.map((e) => (
              <tr key={e.id}>
                <Td>
                  <div className="font-bold">{e.admin_name || "—"}</div>
                  <div className="text-[10px]" style={{ color: C.textFaint }}>{e.admin_email}</div>
                </Td>
                <Td>
                  <Badge color={SENSITIVE.has(e.action) ? "amber" : "textMuted"}>
                    {ACTION_LABEL[e.action] || e.action}
                  </Badge>
                </Td>
                <Td>{e.target_user_id ? <UserLink id={e.target_user_id} name={e.target_user_name || e.target_user_id.slice(0, 8)} /> : "—"}</Td>
                <Td className="max-w-xs"><span style={{ color: C.textMuted }}>{e.reason || "—"}</span></Td>
                <Td><code className="text-[10px]" style={{ color: C.textFaint }}>{e.ip_address || "—"}</code></Td>
                <Td>{fmtDateTime(e.created_at)}</Td>
              </tr>
            ))}
          </Table>
        )}
        {d && <Pager page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} />}
      </Card>
    </div>
  );
}
