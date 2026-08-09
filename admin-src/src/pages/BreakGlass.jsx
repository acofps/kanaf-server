import React, { useState } from "react";
import { ShieldAlert, KeyRound, Check } from "lucide-react";
import { api } from "../api.js";
import { C, atLeast, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Field, Input, Textarea, Spinner, Empty,
  ErrorBar, Table, Td, useAsync,
} from "../ui.jsx";

/* ============================================================
   الوصول الطارئ.

   بابان لا باب واحد: من يطلب ليس من يعتمد. الطالب صلاحية «مدير»،
   والمعتمِد صلاحية «مالك»، والخادم يرفض أن يعتمد أحد طلبه بنفسه
   حتى لو كان مالكاً.

   ولهذا مدة صلاحية تنتهي — لأن صلاحية طوارئ بلا انتهاء تصير
   صلاحية دائمة بعد أسبوع.
   ============================================================ */

export default function BreakGlass({ role, toast }) {
  const isOwner = atLeast(role, "owner");
  const pending = useAsync(() => api.listPendingBreakGlass(), []);

  const [targetUserId, setTargetUserId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [hours, setHours] = useState({});
  const [busyId, setBusyId] = useState(null);

  const request = async () => {
    if (!reason.trim()) { setErr("السبب مطلوب."); return; }
    setBusy(true); setErr("");
    try {
      await api.requestBreakGlass(targetUserId.trim() || null, reason.trim());
      setTargetUserId(""); setReason("");
      toast("سُجّل الطلب. ينتظر اعتماد المالك.");
      pending.reload();
    } catch (e) { setErr(e?.arabic || "تعذّر الطلب."); }
    finally { setBusy(false); }
  };

  const approve = async (r) => {
    setBusyId(r.id);
    try {
      const res = await api.approveBreakGlass(r.id, Number(hours[r.id] || 4));
      toast(`اعتُمد حتى ${fmtDateTime(res.expires_at)}`);
      pending.reload();
    } catch (e) { toast(e?.arabic || "تعذّر الاعتماد."); }
    finally { setBusyId(null); }
  };

  const rows = pending.data?.requests || [];

  return (
    <div>
      <PageTitle
        title="الوصول الطارئ"
        subtitle="طلب يوثَّق ويعتمده المالك — ولا يعتمد أحد طلبه بنفسه."
      />

      <Card className="mb-4">
        <div className="flex items-center gap-2 mb-3">
          <KeyRound size={14} color={C.amber} />
          <h3 className="text-sm font-bold" style={{ color: C.text }}>طلب وصول</h3>
        </div>
        <p className="text-[11px] leading-6 mb-4" style={{ color: C.textFaint }}>
          يُستخدم للوصول إلى ما لا تصله الشاشات العادية — إجابات المقاييس التفصيلية
          ومحتوى الدفاتر. كل استخدام يظهر في سجل الوصول باسمك وسببك.
        </p>
        <div className="grid gap-3">
          <Field label="معرّف المستخدم (اختياري)" hint="اتركه فارغاً لطلب عام غير مرتبط بحساب.">
            <Input value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)} placeholder="UUID" />
          </Field>
          <Field label="السبب">
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <ErrorBar error={err} />
          <div><Button onClick={request} busy={busy}><ShieldAlert size={13} /> إرسال الطلب</Button></div>
        </div>
      </Card>

      <Card>
        <h3 className="text-sm font-bold mb-3" style={{ color: C.text }}>طلبات بانتظار الاعتماد</h3>
        <ErrorBar error={pending.error} />
        {pending.loading ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty>لا طلبات معلّقة.</Empty>
        ) : (
          <Table head={["الطالب", "المستخدم المستهدف", "السبب", "التاريخ", ""]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <div className="font-bold">{r.requested_by_name}</div>
                  <div className="text-[10px]" style={{ color: C.textFaint }}>{r.requested_by_email}</div>
                </Td>
                <Td>{r.target_user_id ? <code className="text-[10px]">{r.target_user_id}</code> : <Badge>عام</Badge>}</Td>
                <Td className="max-w-xs"><span style={{ color: C.textMuted }}>{r.reason}</span></Td>
                <Td>{fmtDateTime(r.created_at)}</Td>
                <Td>
                  {isOwner ? (
                    <div className="flex gap-1.5 justify-end items-center">
                      <input type="number" min="1" max="24"
                        value={hours[r.id] ?? 4}
                        onChange={(e) => setHours((h) => ({ ...h, [r.id]: e.target.value }))}
                        className="w-16 px-2 py-1.5 rounded-xl text-xs outline-none text-center"
                        style={{ background: C.surfaceAlt, color: C.text, border: `1px solid ${C.line}` }} />
                      <span className="text-[10px]" style={{ color: C.textFaint }}>ساعة</span>
                      <Button size="sm" variant="good" busy={busyId === r.id} onClick={() => approve(r)}>
                        <Check size={12} /> اعتماد
                      </Button>
                    </div>
                  ) : (
                    <span className="text-[10px]" style={{ color: C.textFaint }}>الاعتماد للمالك</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
