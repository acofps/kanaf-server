import React, { useState } from "react";
import { Plus, Search } from "lucide-react";
import { api } from "../api.js";
import { C, fmtDateTime, can, toIsoWithOffset } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Spinner, Empty, ErrorBar, Table, Td, Pager, Modal, Field, Input, Select, useAsync, ReasonPrompt,
} from "../ui.jsx";

/* ============================================================
   أكواد الخصم — KANAF-ORD-0008 §6

   🔴 غير مربوطة بالدفع ولا بالفاتورة بعد. الخصم تعديل على وثيقة
   ضريبية (يغيّر الوعاء والضريبة، ويجب أن يظهر بنداً)، فربطه أمر
   مستقل. «فحص كود» معاينة حسابية للمسؤول لا تحجز استعمالاً.
   ============================================================ */

const REASON_LABEL = {
  not_found: "غير موجود", inactive: "موقوف", not_started: "لم تبدأ مدته", expired: "انتهت مدته",
  limit_reached: "بلغ حد الاستعمال", plan_not_found: "باقة غير موجودة", plan_not_eligible: "لا يسري على هذه الباقة",
  discount_reaches_price: "الخصم يساوي السعر أو يتجاوزه — غير مسموح",
};
const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

export default function Discounts({ me, toast }) {
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [toggle, setToggle] = useState(null);
  const state = useAsync(() => api.listDiscountCodes({ page }), [page]);
  const plans = useAsync(() => api.listPlans(), []);
  const d = state.data;
  const rows = d?.codes || [];
  const canEdit = can(me, "discounts:edit");

  return (
    <div>
      <PageTitle title="أكواد الخصم" subtitle="تُنشأ وتُفحص هنا. غير مربوطة بالدفع ولا بالفاتورة بعد — ربطها أمر مستقل.">
        {canEdit && <Button size="sm" onClick={() => setCreating(true)}><span className="inline-flex items-center gap-1.5"><Plus size={14} /> كود جديد</span></Button>}
      </PageTitle>

      <div className="rounded-xl px-4 py-3 mb-4 text-[12px] leading-6" style={{ background: C.amberSoft, color: C.amber }}>
        لا يصل أي كود هنا إلى العميل ولا يُخصم من أي دفعة. الخصم يغيّر الوعاء الضريبي ويجب أن يظهر في الفاتورة بنداً ظاهراً،
        فربطه بمسار الدفع ينتظر أمراً مستقلاً بأدلته المالية.
      </div>

      <CheckBox plans={plans.data?.plans || []} />

      <Card>
        <ErrorBar error={state.error} />
        {state.loading ? <div className="py-8 flex justify-center"><Spinner /></div>
          : rows.length === 0 ? <Empty>لا أكواد بعد.</Empty>
          : (
            <>
              <Table head={["الكود", "الخصم", "المدة", "الاستعمال", "الباقات", "الحالة", "أُنشئ", ""]}>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <Td><code className="font-bold" dir="ltr">{c.code}</code>{c.note && <div className="text-[11px]" style={{ color: C.textFaint }}>{c.note}</div>}</Td>
                    <Td>{c.kind === "percent" ? `${fmt(c.value)}%` : `${fmt(c.value)} ر.س`}</Td>
                    <Td className="text-[12px]">{c.valid_from ? fmtDateTime(c.valid_from) : "—"} ← {c.valid_until ? fmtDateTime(c.valid_until) : "مفتوح"}</Td>
                    <Td>{c.used}{c.max_redemptions ? ` / ${c.max_redemptions}` : ""}</Td>
                    <Td className="text-[12px]">{c.plan_keys?.length ? c.plan_keys.join("، ") : "كل الباقات"}</Td>
                    <Td><Badge color={c.is_active ? "green" : "textMuted"}>{c.is_active ? "فعّال" : "موقوف"}</Badge></Td>
                    <Td className="text-[12px]">{fmtDateTime(c.created_at)}<div style={{ color: C.textFaint }}>{c.created_by_name}</div></Td>
                    <Td>{canEdit && <Button size="sm" variant="ghost" onClick={() => setToggle(c)}>{c.is_active ? "إيقاف" : "تفعيل"}</Button>}</Td>
                  </tr>
                ))}
              </Table>
              <Pager page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} />
            </>
          )}
      </Card>

      <CreateModal open={creating} plans={plans.data?.plans || []} onClose={() => setCreating(false)}
        onDone={() => { setCreating(false); toast?.("أُنشئ الكود."); state.reload(); }} />
      <ReasonPrompt open={!!toggle} title={toggle?.is_active ? `إيقاف ${toggle?.code}` : `تفعيل ${toggle?.code}`}
        onClose={() => setToggle(null)}
        onConfirm={async (reason) => { await api.setDiscountActive(toggle.id, !toggle.is_active, reason); setToggle(null); state.reload(); }} />
    </div>
  );
}

function CheckBox({ plans }) {
  const [code, setCode] = useState("");
  const [plan, setPlan] = useState("");
  const [res, setRes] = useState(null);
  const [err, setErr] = useState("");
  const run = async () => {
    setErr(""); setRes(null);
    try { setRes(await api.checkDiscountCode({ code, planKey: plan || plans[0]?.plan_key })); } catch (e) { setErr(e?.arabic || "تعذّر الفحص."); }
  };
  return (
    <Card className="mb-4">
      <p className="text-xs font-bold mb-3">فحص كود (معاينة لا تحجز استعمالاً)</p>
      <div className="flex gap-2 flex-wrap items-end">
        <div className="w-48"><Field label="الكود"><Input value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" /></Field></div>
        <div className="w-56"><Field label="الباقة"><Select value={plan} onChange={(e) => setPlan(e.target.value)}>
          {plans.map((p) => <option key={p.plan_key} value={p.plan_key}>{p.name}</option>)}
        </Select></Field></div>
        <Button size="sm" onClick={run} disabled={!code.trim()}><span className="inline-flex items-center gap-1.5"><Search size={14} /> فحص</span></Button>
      </div>
      <ErrorBar error={err} />
      {res && (res.valid ? (
        <div className="mt-3 text-[12px] leading-7" style={{ color: C.textMuted }}>
          <Badge color="green">صالح</Badge>{" "}
          السعر {fmt(res.preview.priceSar)} ← الخصم {fmt(res.preview.discountSar)} ← بعده {fmt(res.preview.finalSar)} ر.س
          · الضريبة قبل {res.preview.vatSplitBefore.vat} وبعد {res.preview.vatSplitAfter.vat} ر.س
          <div style={{ color: C.textFaint }}>{res.preview.note}</div>
        </div>
      ) : <div className="mt-3"><Badge color="crisis">غير صالح: {REASON_LABEL[res.reason] || res.reason}</Badge></div>)}
    </Card>
  );
}

function CreateModal({ open, plans, onClose, onDone }) {
  const [f, setF] = useState({ code: "", kind: "percent", value: "", validFrom: "", validUntil: "", maxRedemptions: "", planKeys: [], note: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const togglePlan = (k) => setF((x) => ({ ...x, planKeys: x.planKeys.includes(k) ? x.planKeys.filter((p) => p !== k) : [...x.planKeys, k] }));
  const submit = async () => {
    setBusy(true); setErr("");
    try {
      await api.createDiscountCode({
        ...f, value: Number(f.value), maxRedemptions: f.maxRedemptions ? Number(f.maxRedemptions) : null,
        validFrom: f.validFrom ? toIsoWithOffset(f.validFrom) : null, validUntil: f.validUntil ? toIsoWithOffset(f.validUntil) : null,
      });
      onDone();
    } catch (e) { setErr(e?.arabic || e?.code || "تعذّر الإنشاء."); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="كود خصم جديد">
      <div className="grid gap-3">
        <Field label="الكود" hint="حروف لاتينية وأرقام و- و_ ، من 3 إلى 32. يُحفظ بحروف كبيرة."><Input value={f.code} onChange={set("code")} dir="ltr" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="النوع"><Select value={f.kind} onChange={set("kind")}><option value="percent">نسبة %</option><option value="amount">مبلغ ر.س</option></Select></Field>
          <Field label="القيمة" hint={f.kind === "percent" ? "أقل من 100 — خصم 100% غير مسموح" : "أقل من سعر الباقة"}><Input type="number" min="0" step="0.01" value={f.value} onChange={set("value")} dir="ltr" /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="يبدأ (اختياري)"><Input type="datetime-local" value={f.validFrom} onChange={set("validFrom")} /></Field>
          <Field label="ينتهي (اختياري)"><Input type="datetime-local" value={f.validUntil} onChange={set("validUntil")} /></Field>
        </div>
        <Field label="حد الاستعمال (اختياري)"><Input type="number" min="1" value={f.maxRedemptions} onChange={set("maxRedemptions")} dir="ltr" /></Field>
        <Field label="الباقات" hint="بلا اختيار = كل الباقات.">
          <div className="flex gap-2 flex-wrap">
            {plans.map((p) => (
              <button key={p.plan_key} type="button" onClick={() => togglePlan(p.plan_key)} className="px-3 py-1.5 rounded-xl text-xs font-bold"
                style={{ background: f.planKeys.includes(p.plan_key) ? C.tealSoft : C.surfaceAlt, color: f.planKeys.includes(p.plan_key) ? C.teal : C.textMuted }}>{p.name}</button>
            ))}
          </div>
        </Field>
        <Field label="ملاحظة (اختياري)"><Input value={f.note} onChange={set("note")} /></Field>
        <Field label="السبب" hint="يُسجَّل في سجل الإجراءات."><Input value={f.reason} onChange={set("reason")} /></Field>
        <ErrorBar error={err} />
        <div className="flex gap-2"><Button onClick={submit} busy={busy} disabled={!f.code || !f.value || !f.reason.trim()}>إنشاء</Button><Button variant="ghost" onClick={onClose}>إلغاء</Button></div>
      </div>
    </Modal>
  );
}
