import React, { useState } from "react";
import { api } from "../api.js";
import { C, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, SearchBox, Spinner, Empty, ErrorBar, Table, Td, useAsync,
} from "../ui.jsx";

/* ============================================================
   سجل الوصول.

   يُكتب **قبل** تنفيذ القراءة لا بعدها — فمحاولة الوصول تظهر هنا
   حتى لو فشل الاستعلام بعدها. وسجل يُكتب بعد النجاح فقط يخفي
   بالضبط الحالة التي بُني ليكشفها.
   ============================================================ */

const ACTION_LABEL = {
  view_sensitive_data: "عرض بيانات متابعة",
  break_glass_request: "طلب وصول طارئ",
  break_glass_approve: "اعتماد وصول طارئ",
  manual_subscription_cancel: "إلغاء اشتراك يدوي",
  manual_subscription_refund: "استرداد يدوي",
  suspend_account: "إيقاف حساب",
  restore_account: "إعادة تفعيل حساب",
};

const SENSITIVE = new Set(["view_sensitive_data", "break_glass_request", "break_glass_approve"]);

export default function AccessLog() {
  const [targetUserId, setTargetUserId] = useState("");
  const [applied, setApplied] = useState("");
  const state = useAsync(() => api.listAccessLog(applied || undefined), [applied]);
  const rows = state.data?.entries || [];

  return (
    <div>
      <PageTitle
        title="سجل الوصول"
        subtitle="يُكتب قبل تنفيذ القراءة، ولا يُعدَّل بعدها. أحدث 200 سجل."
      />

      <Card>
        <div className="flex gap-2 mb-4 flex-wrap items-end">
          <div className="flex-1 min-w-[220px]">
            <SearchBox value={targetUserId} onChange={setTargetUserId} placeholder="تصفية بمعرّف المستخدم (UUID)…" />
          </div>
          <Button size="sm" onClick={() => setApplied(targetUserId.trim())}>تصفية</Button>
          {applied && <Button size="sm" variant="ghost" onClick={() => { setTargetUserId(""); setApplied(""); }}>إلغاء التصفية</Button>}
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
                <Td>{e.target_user_id ? <code className="text-[10px]">{e.target_user_id}</code> : "—"}</Td>
                <Td className="max-w-xs"><span style={{ color: C.textMuted }}>{e.reason || "—"}</span></Td>
                <Td><code className="text-[10px]" style={{ color: C.textFaint }}>{e.ip_address || "—"}</code></Td>
                <Td>{fmtDateTime(e.created_at)}</Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="text-[11px] mt-3" style={{ color: C.textFaint }}>{rows.length} سجل</p>
      </Card>
    </div>
  );
}
