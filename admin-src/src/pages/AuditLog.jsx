import React, { useState } from "react";
import { Download, ChevronDown, ChevronLeft } from "lucide-react";
import { api } from "../api.js";
import { C, can, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Field, Select, Input, Spinner, Empty,
  ErrorBar, Table, Td, Pager, useAsync,
} from "../ui.jsx";

/* ============================================================
   سجل الإجراءات — من غيّر ماذا، ومن أي قيمة إلى أي قيمة.

   ------------------------------------------------------------
   لماذا هذه الشاشة جديدة
   ------------------------------------------------------------
   جدول admin_action_log موجود منذ الترحيل 003 ويُكتب فيه بانتظام،
   ولم يكن له قارئ واحد في اللوحة إلا داخل صفحة مستخدم بعينه. أي أن
   كل فعل لا يخصّ مستخدماً — تعديل سعر باقة، تغيير الرقم الضريبي،
   ترقية مسؤول إلى مالك — كان يُسجَّل ولا يُقرأ أبداً.

   وسجل لا يُقرأ ليس سجلاً؛ هو أرشيف يطمئن من كتبه ولا يكشف شيئاً.

   ------------------------------------------------------------
   وهو غير «سجل الوصول»
   ------------------------------------------------------------
   ذاك يجيب «من **قرأ** بيانات حساسة ولماذا»، وهذا يجيب «من
   **غيّر** حالة». وفصلهما مقصود منذ الترحيل 003.
   ============================================================ */

/* الأسماء العربية للأفعال. الأفعال نفسها تأتي من الخادم في
   `facets`، فالقائمة لا تتقادم — ما لا اسم له يظهر بمفتاحه بدل أن
   يختفي. */
const ACTION_LABEL = {
  suspend_account: "تعليق حساب",
  restore_account: "رفع تعليق",
  manual_subscription_cancel: "إلغاء اشتراك يدوي",
  manual_subscription_refund: "استرداد يدوي",
  payment_refund: "استرداد دفعة",
  payment_reconcile: "مطابقة دفعة",
  webhook_replay: "إعادة تشغيل حدث دفع",
  plan_created: "إنشاء باقة",
  plan_updated: "تعديل باقة",
  plan_price_changed: "تغيير سعر باقة",
  plan_activated: "تفعيل باقة",
  plan_deactivated: "تعطيل باقة",
  tax_settings_updated: "تعديل البيانات الضريبية",
  update_billing_settings: "تعديل الإعداد المالي",
  app_setting_updated: "تعديل إعداد تشغيل",
  admin_account_invited: "دعوة حساب إدارة",
  admin_invite_accepted: "قبول دعوة",
  admin_invite_resent: "إعادة إرسال دعوة",
  admin_role_changed: "تغيير دور مسؤول",
  admin_account_activated: "تفعيل حساب إدارة",
  admin_account_deactivated: "تعطيل حساب إدارة",
  admin_password_reset_issued: "إصدار استعادة كلمة مرور",
  admin_password_reset_completed: "إتمام استعادة كلمة مرور",
  content_presentation_update: "تعديل عرض محتوى",
  invoice_document_regenerated: "إعادة إصدار وثيقة فاتورة",
  break_glass_requested: "طلب وصول طارئ",
  break_glass_approved: "اعتماد وصول طارئ",
  data_exported: "تصدير بيانات",
};

const ENTITY_LABEL = {
  user: "مستخدم", admin_user: "حساب إدارة", plan: "باقة", payment: "دفعة",
  invoice: "فاتورة", subscription: "اشتراك", campaign: "حملة", content: "محتوى",
  tax_settings: "بيانات ضريبية", billing_settings: "إعداد مالي",
  app_setting: "إعداد تشغيل", export: "تصدير", break_glass: "وصول طارئ",
};

/* الأفعال التي تستحق لوناً: نقل مال، أو تغيير من يقدر على ماذا. */
const HIGH_STAKES = new Set([
  "manual_subscription_refund", "payment_refund", "payment_reconcile",
  "plan_price_changed", "tax_settings_updated", "update_billing_settings",
  "admin_role_changed", "admin_account_invited", "admin_account_deactivated",
  "break_glass_approved", "data_exported",
]);

function ValueDiff({ oldValue, newValue }) {
  if (!oldValue && !newValue) return <span style={{ color: C.textFaint }}>—</span>;
  const keys = [...new Set([...Object.keys(oldValue || {}), ...Object.keys(newValue || {})])];
  return (
    <div className="grid gap-1">
      {keys.map((k) => {
        const a = oldValue?.[k];
        const b = newValue?.[k];
        const changed = JSON.stringify(a) !== JSON.stringify(b);
        const show = (v) => (v === undefined || v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
        return (
          <div key={k} className="text-[11px] flex items-center gap-1.5 flex-wrap">
            <span style={{ color: C.textFaint }}>{k}:</span>
            {oldValue !== null && oldValue !== undefined && (
              <span style={{ color: changed ? C.crisis : C.textMuted, textDecoration: changed ? "line-through" : "none" }}>
                {show(a)}
              </span>
            )}
            {changed && newValue && <ChevronLeft size={10} color={C.textFaint} />}
            {newValue !== null && newValue !== undefined && changed && (
              <span className="font-bold" style={{ color: C.green }}>{show(b)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function AuditLog({ me, toast }) {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [open, setOpen] = useState(null);

  const params = { page, action, entity, from, to };
  const state = useAsync(() => api.listAuditLog(params), [page, action, entity, from, to]);
  const d = state.data;
  const rows = d?.entries || [];

  const reset = (fn) => (v) => { fn(v); setPage(1); };

  return (
    <div>
      <PageTitle
        title="سجل الإجراءات"
        subtitle="كل تغيير في حالة النظام: من نفّذه، ومن أي قيمة إلى أي قيمة، وبأي سبب. لا يُعدَّل ولا يُحذف."
      >
        {can(me, "exports:audit") && (
          <a href={api.exportUrl("audit-log", { action, entity, from, to })}>
            <Button size="sm" variant="ghost"><Download size={13} /> تصدير CSV</Button>
          </a>
        )}
      </PageTitle>

      <Card className="mb-4">
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
          <Field label="الإجراء">
            <Select value={action} onChange={(e) => reset(setAction)(e.target.value)}>
              <option value="">الكل</option>
              {(d?.facets?.actions || []).map((a) => (
                <option key={a} value={a}>{ACTION_LABEL[a] || a}</option>
              ))}
            </Select>
          </Field>
          <Field label="نوع الكيان">
            <Select value={entity} onChange={(e) => reset(setEntity)(e.target.value)}>
              <option value="">الكل</option>
              {(d?.facets?.entities || []).map((x) => (
                <option key={x} value={x}>{ENTITY_LABEL[x] || x}</option>
              ))}
            </Select>
          </Field>
          <Field label="من تاريخ"><Input type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} /></Field>
          <Field label="إلى تاريخ"><Input type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} /></Field>
        </div>
      </Card>

      <Card>
        <ErrorBar error={state.error} />
        {state.loading ? (
          <div className="py-10 flex justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty>لا إجراءات مطابقة.</Empty>
        ) : (
          <>
            <Table head={["الوقت", "المسؤول", "الإجراء", "الكيان", "السبب", ""]}>
              {rows.map((r) => (
                <React.Fragment key={r.id}>
                  <tr>
                    <Td>{fmtDateTime(r.created_at)}</Td>
                    <Td className="font-bold">{r.admin_name || "—"}</Td>
                    <Td>
                      <Badge color={HIGH_STAKES.has(r.action) ? "amber" : "textMuted"}>
                        {ACTION_LABEL[r.action] || r.action}
                      </Badge>
                    </Td>
                    <Td>
                      {r.entity ? (
                        <span style={{ color: C.textMuted }}>
                          {ENTITY_LABEL[r.entity] || r.entity}
                          {r.entity_id && (
                            <span className="block text-[10px]" style={{ color: C.textFaint }}>
                              {String(r.entity_id).slice(0, 18)}
                            </span>
                          )}
                        </span>
                      ) : "—"}
                    </Td>
                    <Td><span style={{ color: C.textMuted }}>{r.reason}</span></Td>
                    <Td>
                      <div className="flex justify-end">
                        <button onClick={() => setOpen(open === r.id ? null : r.id)}>
                          <ChevronDown size={14} color={C.textFaint}
                            style={{ transform: open === r.id ? "rotate(180deg)" : "none" }} />
                        </button>
                      </div>
                    </Td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <Td className="!py-3" >
                        <div />
                      </Td>
                      <td colSpan={5} className="text-xs pb-3 px-2" style={{ borderBottom: `1px solid ${C.line}` }}>
                        <div className="rounded-xl p-3" style={{ background: C.surfaceAlt }}>
                          <ValueDiff oldValue={r.old_value} newValue={r.new_value} />
                          <div className="mt-2 pt-2 text-[10px] grid gap-1" style={{ borderTop: `1px solid ${C.line}`, color: C.textFaint }}>
                            <span>{r.admin_email}</span>
                            {r.ip_address && <span>العنوان: {r.ip_address}</span>}
                            {r.metadata && <span>إضافي: {JSON.stringify(r.metadata)}</span>}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </Table>
            <Pager page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
