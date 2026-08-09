import React, { useEffect, useState } from "react";
import { Plus, Pencil, Power } from "lucide-react";
import { api } from "../api.js";
import { C, atLeast, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Field, Input, Textarea, Spinner, Empty,
  ErrorBar, Modal, Table, Td, useAsync,
} from "../ui.jsx";

/* ============================================================
   الباقات والبيانات الضريبية.

   السعر هنا هو ما يُحصَّل فعلاً، فأي تعديل عليه يظهر في الفاتورة
   القادمة مباشرة. ومفتاح الباقة (`plan_key`) لا يُعدَّل بعد
   الإنشاء عمداً — فواتير صادرة تشير إليه، وتغييره يجعل وثيقة
   ضريبية تشير إلى شيء غير موجود.
   ============================================================ */

export default function Plans({ role, toast }) {
  const canEdit = atLeast(role, "admin");
  const state = useAsync(() => api.listPlans(), []);
  const [editing, setEditing] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const plans = state.data?.plans || [];

  const toggle = async (p) => {
    setBusyId(p.id);
    try { await api.togglePlanActive(p.id, !p.is_active); state.reload(); }
    catch (e) { toast(e?.arabic || "تعذّر التغيير."); }
    finally { setBusyId(null); }
  };

  return (
    <div>
      <PageTitle title="الباقات" subtitle="السعر المعروض هنا هو ما يُحصَّل ويظهر في الفاتورة.">
        {canEdit && <Button size="sm" onClick={() => setEditing({})}><Plus size={13} /> باقة جديدة</Button>}
      </PageTitle>

      <Card className="mb-4">
        <ErrorBar error={state.error} />
        {state.loading ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : plans.length === 0 ? (
          <Empty>لا توجد باقات.</Empty>
        ) : (
          <Table head={["المفتاح", "الاسم", "السعر", "المدة", "المزايا", "الحالة", ""]}>
            {plans.map((p) => (
              <tr key={p.id}>
                <Td><code className="text-[10px]">{p.plan_key}</code></Td>
                <Td className="font-bold">{p.name}</Td>
                <Td>{Number(p.price_sar).toLocaleString("en-US")} ر.س</Td>
                <Td>{p.duration_days} يوم</Td>
                <Td className="max-w-xs">
                  <span style={{ color: C.textMuted }}>
                    {(Array.isArray(p.features) ? p.features : []).join(" · ") || "—"}
                  </span>
                </Td>
                <Td>
                  <Badge color={p.is_active ? "green" : "textFaint"}>{p.is_active ? "فعّالة" : "متوقفة"}</Badge>
                </Td>
                <Td>
                  {canEdit && (
                    <div className="flex gap-1.5 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(p)}><Pencil size={12} /> تعديل</Button>
                      <Button size="sm" variant={p.is_active ? "warn" : "good"} busy={busyId === p.id}
                        onClick={() => toggle(p)}>
                        <Power size={12} /> {p.is_active ? "إيقاف" : "تفعيل"}
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <TaxSettings role={role} toast={toast} />

      {editing && (
        <PlanEditor plan={editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); state.reload(); toast("حُفظت الباقة."); }} />
      )}
    </div>
  );
}

function PlanEditor({ plan, onClose, onSaved }) {
  const isNew = !plan.id;
  const [planKey, setPlanKey] = useState(plan.plan_key || "");
  const [name, setName] = useState(plan.name || "");
  const [priceSar, setPriceSar] = useState(plan.price_sar ?? "");
  const [durationDays, setDurationDays] = useState(plan.duration_days ?? 30);
  const [features, setFeatures] = useState((Array.isArray(plan.features) ? plan.features : []).join("\n"));
  const [displayOrder, setDisplayOrder] = useState(plan.display_order ?? 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setBusy(true); setErr("");
    const body = {
      name: name.trim(),
      priceSar: Number(priceSar),
      durationDays: Number(durationDays),
      features: features.split("\n").map((s) => s.trim()).filter(Boolean),
      displayOrder: Number(displayOrder) || 0,
    };
    try {
      if (isNew) await api.createPlan({ ...body, planKey: planKey.trim() });
      else await api.updatePlan(plan.id, body);
      onSaved();
    } catch (e) { setErr(e?.arabic || "تعذّر الحفظ."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={isNew ? "باقة جديدة" : `تعديل: ${plan.name}`}>
      <div className="grid gap-3">
        <Field label="مفتاح الباقة"
          hint={isNew ? "حروف إنجليزية صغيرة وأرقام وشرطة سفلية فقط. لا يمكن تعديله بعد الإنشاء."
                      : "غير قابل للتعديل — فواتير صادرة تشير إليه."}>
          <Input value={planKey} disabled={!isNew} onChange={(e) => setPlanKey(e.target.value)} />
        </Field>
        <Field label="الاسم"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="السعر (ر.س)">
            <Input type="number" step="0.01" min="0" value={priceSar} onChange={(e) => setPriceSar(e.target.value)} />
          </Field>
          <Field label="المدة (أيام)">
            <Input type="number" min="1" value={durationDays} onChange={(e) => setDurationDays(e.target.value)} />
          </Field>
          <Field label="الترتيب">
            <Input type="number" value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} />
          </Field>
        </div>
        <Field label="المزايا" hint="ميزة في كل سطر.">
          <Textarea rows={4} value={features} onChange={(e) => setFeatures(e.target.value)} />
        </Field>
        <ErrorBar error={err} />
        <div className="flex gap-2">
          <Button onClick={save} busy={busy}>حفظ</Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------
   البيانات الضريبية.

   الرقم الضريبي 15 رقماً — والخادم يرفض غير ذلك. لو خُزّن رقم
   خاطئ فكل فاتورة صادرة بعده تحمله، ولا تُصحَّح فاتورة صادرة.
   ------------------------------------------------------------ */
function TaxSettings({ role, toast }) {
  const canEdit = atLeast(role, "owner");
  const state = useAsync(() => api.getTaxSettings(), []);
  const [legalName, setLegalName] = useState("");
  const [vatNumber, setVatNumber] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const s = state.data?.settings;
    if (s) { setLegalName(s.legal_name || ""); setVatNumber(s.vat_number || ""); setAddress(s.address || ""); }
  }, [state.data]);

  const save = async () => {
    setBusy(true); setErr("");
    try {
      await api.saveTaxSettings({ legalName: legalName.trim(), vatNumber: vatNumber.trim(), address });
      toast("حُفظت البيانات الضريبية."); state.reload();
    } catch (e) { setErr(e?.arabic || "تعذّر الحفظ."); }
    finally { setBusy(false); }
  };

  return (
    <Card>
      <h3 className="text-sm font-bold mb-1" style={{ color: C.text }}>البيانات الضريبية</h3>
      <p className="text-[11px] mb-4 leading-6" style={{ color: C.textFaint }}>
        تظهر على كل فاتورة تُصدَر بعد الحفظ. الفواتير الصادرة سابقاً تحتفظ ببياناتها وقت الإصدار.
        {state.data?.settings?.updated_at && ` · آخر تحديث: ${fmtDateTime(state.data.settings.updated_at)}`}
      </p>
      <ErrorBar error={state.error || err} />
      <div className="grid gap-3">
        <Field label="الاسم النظامي">
          <Input value={legalName} disabled={!canEdit} onChange={(e) => setLegalName(e.target.value)} />
        </Field>
        <Field label="الرقم الضريبي" hint="15 رقماً بالضبط.">
          <Input value={vatNumber} disabled={!canEdit} inputMode="numeric"
            onChange={(e) => setVatNumber(e.target.value.replace(/\D/g, "").slice(0, 15))} />
        </Field>
        <Field label="العنوان">
          <Textarea rows={2} value={address} disabled={!canEdit} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        {canEdit ? (
          <div><Button onClick={save} busy={busy}>حفظ</Button></div>
        ) : (
          <p className="text-[11px]" style={{ color: C.textFaint }}>التعديل لصلاحية المالك فقط.</p>
        )}
      </div>
    </Card>
  );
}
