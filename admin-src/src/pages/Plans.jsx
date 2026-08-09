import React, { useEffect, useState } from "react";
import { Plus, Pencil, Power } from "lucide-react";
import { api } from "../api.js";
import { C, can } from "../theme.js";
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

export default function Plans({ me, toast }) {
  const canEdit = can(me, "plans:edit");
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

/* ------------------------------------------------------------
   ⚠️ انتقلت البيانات الضريبية من هذه الصفحة إلى «الإعدادات».

   كانت بطاقة داخل «الباقات»، وهو موضع غريب أصلاً — البيانات
   الضريبية ليست باقة. والأهم أنها كانت تُرسَم لكل من يفتح الصفحة،
   فيرى موظف الدعم بطاقة تفشل بـ403 في وجهه بلا سبب مفهوم.

   ومع وجود صفحة إعدادات موحّدة، بقاؤها هنا كان سيعني شاشتين
   تعدّلان نفس الصف — وهو نمط «مسارين لنفس العنوان» الذي كلّف هذا
   المشروع مرتين.
   ------------------------------------------------------------ */
