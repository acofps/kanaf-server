import React, { useEffect, useState } from "react";
import { Plus, Pencil, Power } from "lucide-react";
import { api } from "../api.js";
import { Link, navigate } from "../router.js";
import { C, can } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Field, Input, Textarea, Spinner, Empty,
  ErrorBar, Screen, ConfirmPrompt, Table, Td, useAsync,
} from "../ui.jsx";

/* ============================================================
   الباقات والبيانات الضريبية.

   السعر هنا هو ما يُحصَّل فعلاً، فأي تعديل عليه يظهر في الفاتورة
   القادمة مباشرة. ومفتاح الباقة (`plan_key`) لا يُعدَّل بعد
   الإنشاء عمداً — فواتير صادرة تشير إليه، وتغييره يجعل وثيقة
   ضريبية تشير إلى شيء غير موجود.
   ============================================================ */

export default function Plans({ me, toast, route = [] }) {
  /* KANAF-ORD-0013 §3.2: إنشاء الباقة وتعديلها صفحتان: /plans/new و /plans/<plan_key>/edit */
  if (route[0]) return <PlanEditorScreen planKey={route[0] === "new" ? null : route[0]} toast={toast} />;
  return <PlanList me={me} toast={toast} />;
}

function PlanEditorScreen({ planKey, toast }) {
  const st = useAsync(() => (planKey ? api.listPlans() : Promise.resolve({ plans: [] })), [planKey]);
  if (st.loading) return <div className="py-10 flex justify-center"><Spinner /></div>;
  const plan = planKey ? (st.data?.plans || []).find((p) => p.plan_key === planKey) : {};
  if (!plan) return <Screen title="الباقة" back="/plans"><ErrorBar error={st.error || "الباقة غير موجودة."} /></Screen>;
  return <PlanEditor plan={plan} onClose={() => navigate("/plans")} onSaved={() => { toast("حُفظت الباقة."); navigate("/plans"); }} />;
}

function PlanList({ me, toast }) {
  const canEdit = can(me, "plans:edit");
  const state = useAsync(() => api.listPlans(), []);
  const [busyId, setBusyId] = useState(null);

  const plans = state.data?.plans || [];

  /* تشغيل الباقة أو إيقافها بتأكيد بنقرة. السبب يولّده الخادم (ملحق KANAF-ORD-0013، قرار المالك 1). */
  const [toggling, setToggling] = useState(null);
  const toggle = (p) => setToggling(p);
  const runToggle = async () => {
    const p = toggling;
    setBusyId(p.id);
    try { await api.togglePlanActive(p.id, !p.is_active); state.reload(); toast(p.is_active ? "أُوقفت الباقة." : "فُعّلت الباقة."); }
    finally { setBusyId(null); }
  };

  return (
    <div>
      <PageTitle title="الباقات" subtitle="السعر المعروض هنا هو ما يُحصَّل ويظهر في الفاتورة.">
        {canEdit && <Link to="/plans/new"><Button size="sm"><Plus size={13} /> باقة جديدة</Button></Link>}
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
                      <Link to={`/plans/${encodeURIComponent(p.plan_key)}`}><Button size="sm" variant="ghost"><Pencil size={12} /> تعديل</Button></Link>
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
      <ConfirmPrompt open={!!toggling}
        title={toggling?.is_active ? `إيقاف باقة «${toggling?.name}»` : `تفعيل باقة «${toggling?.name || ""}»`}
        description={toggling?.is_active ? "الباقة الموقوفة تختفي من صفحة الاشتراك للمستخدمين الجدد. الاشتراكات القائمة والفواتير الصادرة لا تتأثر." : "الباقة المفعّلة تظهر في صفحة الاشتراك بسعرها الحالي."}
        confirmLabel={toggling?.is_active ? "إيقاف" : "تفعيل"} danger={!!toggling?.is_active}
        onConfirm={runToggle} onClose={() => setToggling(null)} />
      </Card>


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
    if (String(priceSar).trim() === "") { setErr("السعر مطلوب."); return; }   // Number("") = 0 — باقة مجانية بلا قصد
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
    <Screen title={isNew ? "باقة جديدة" : `تعديل: ${plan.name}`} back="/plans" backLabel="الباقات">
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
    </Screen>
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
