import React, { useState } from "react";
import { KeyRound, PlugZap, Trash2, ShieldCheck } from "lucide-react";
import { api } from "../api.js";
import { C, fmtDateTime } from "../theme.js";
import { Card, PageTitle, Button, Badge, Spinner, ErrorBar, Screen, Field, Input, useAsync, ConfirmPrompt } from "../ui.jsx";
import { Link, navigate } from "../router.js";

/* ============================================================
   التكاملات — صفحة اعتمادات، لا تكامل (KANAF-ORD-0008 §7)

   حفظ مفتاح هنا لا يجعل الخدمة تعمل. لا شيء في الدفع أو الفوترة أو
   البريد يقرأ هذه المفاتيح اليوم؛ كل ربط فعلي أمر مستقل.
   المفاتيح مشفَّرة في الخادم، ولا يصل إلى هذه الصفحة منها إلا آخر
   أربعة محارف. للمالك وحده.
   ============================================================ */

export default function Integrations({ toast, route = [] }) {
  const state = useAsync(() => api.listIntegrations(), []);
  /* KANAF-ORD-0013 §3.2: ضبط مفتاح صفحة /integrations/<service>/<key> */
  if (route[0] && route[1]) {
    if (state.loading) return <div className="py-10 flex justify-center"><Spinner /></div>;
    const svc = (state.data?.services || []).find((x) => x.service === route[0]);
    const f = svc?.fields?.find((x) => x.key === route[1]);
    if (!f || !state.data?.encryptionConfigured) return <Screen title="التكاملات" back="/integrations"><ErrorBar error={state.error || (f ? "الحفظ معطّل: INTEGRATIONS_ENC_KEY غير مضبوط." : "المفتاح غير معروف.")} /></Screen>;
    return <SetModal target={{ service: svc.service, key: f.key, label: f.label }} onClose={() => navigate("/integrations")}
      onDone={() => { toast?.("حُفظ مشفَّراً."); navigate("/integrations"); }} />;
  }
  return <IntegrationList toast={toast} state={state} />;
}

function IntegrationList({ toast, state }) {
  const [del, setDel] = useState(null);
  const [test, setTest] = useState(null);     // service
  const [results, setResults] = useState({});
  const d = state.data;

  return (
    <div>
      <PageTitle title="التكاملات" subtitle="اعتمادات الخدمات الخارجية — تُحفظ مشفَّرة، وتُعرض مقنَّعة. حفظها لا يشغّل أي خدمة." />
      {d && !d.encryptionConfigured && (
        <div className="rounded-xl px-4 py-3 mb-4 text-[12px] leading-6" style={{ background: C.amberSoft, color: C.amber }}>
          الحفظ معطّل: متغيّر البيئة <code dir="ltr">INTEGRATIONS_ENC_KEY</code> غير مضبوط على الخادم. لا تُحفظ المفاتيح بنص صريح بحال.
        </div>
      )}
      <ErrorBar error={state.error} />
      {state.loading ? <div className="py-8 flex justify-center"><Spinner /></div> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {(d?.services || []).map((s) => (
            <Card key={s.service}>
              <div className="flex items-center justify-between gap-2 mb-3">
                <p className="text-sm font-bold">{s.label}</p>
                {s.testAvailable
                  ? <Button size="sm" variant="ghost" onClick={() => setTest(s.service)}><span className="inline-flex items-center gap-1.5"><PlugZap size={14} /> فحص الاتصال</span></Button>
                  : <span className="text-[11px]" style={{ color: C.textFaint }}>فحص الاتصال ينتظر توثيق المزوّد</span>}
              </div>
              {results[s.service] && (
                <div className="mb-3"><Badge color={results[s.service].ok ? "green" : "crisis"}>
                  {results[s.service].ok ? `متصل (${results[s.service].httpStatus})` : `فشل: ${results[s.service].httpStatus || results[s.service].error}`}
                </Badge></div>
              )}
              <div className="grid gap-2">
                {s.fields.map((f) => (
                  <div key={f.key} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2" style={{ background: C.surfaceAlt }}>
                    <div className="min-w-0">
                      <p className="text-[12px] font-bold">{f.label}</p>
                      <p className="text-[11px]" style={{ color: C.textFaint }}>
                        <code dir="ltr">{s.service}_{f.key}</code>
                        {f.configured ? <> · <span dir="ltr">{f.masked}</span> · {fmtDateTime(f.updatedAt)} · {f.updatedBy}</> : " · غير مضبوط"}
                      </p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Button size="sm" variant="ghost" disabled={!d.encryptionConfigured} onClick={() => navigate(`/integrations/${s.service}/${f.key}`)}>
                        <span className="inline-flex items-center gap-1"><KeyRound size={13} /> {f.configured ? "استبدال" : "ضبط"}</span>
                      </Button>
                      {f.configured && <Button size="sm" variant="ghost" onClick={() => setDel({ service: s.service, key: f.key })}><Trash2 size={13} /></Button>}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmPrompt open={!!del} title="حذف المفتاح" danger onClose={() => setDel(null)}
        onConfirm={async () => { await api.deleteIntegrationKey(del.service, del.key); setDel(null); state.reload(); }} />
      <ConfirmPrompt open={!!test} title="فحص الاتصال" description="قراءة واحدة من المزوّد. تُسجَّل النتيجة في سجل الإجراءات بلا أي مفتاح."
        onClose={() => setTest(null)}
        onConfirm={async () => { const r = await api.testIntegration(test); setResults((x) => ({ ...x, [test]: r })); setTest(null); }} />
    </div>
  );
}

function SetModal({ target, onClose, onDone }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const close = () => { setValue(""); setErr(""); onClose(); };
  const submit = async () => {
    setBusy(true); setErr("");
    try { await api.setIntegrationKey(target.service, target.key, value); setValue(""); onDone(); }
    catch (e) { setErr(e?.arabic || e?.code || "تعذّر الحفظ."); } finally { setBusy(false); }
  };
  return (
    <Screen title={target ? `ضبط: ${target.label}` : ""} back="/integrations" backLabel="التكاملات">
      <div className="grid gap-3">
        <div className="flex items-start gap-2 text-[12px] leading-6" style={{ color: C.textMuted }}>
          <ShieldCheck size={16} className="shrink-0 mt-1" />
          تُشفَّر القيمة في الخادم قبل التخزين، ولا تعود إلى أي شاشة بعد الحفظ — يظهر آخر أربعة محارف فقط.
        </div>
        <Field label="القيمة"><Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} dir="ltr" /></Field>
        <ErrorBar error={err} />
        <div className="flex gap-2"><Button onClick={submit} busy={busy} disabled={!value.trim()}>حفظ مشفَّراً</Button><Button variant="ghost" onClick={close}>إلغاء</Button></div>
      </div>
    </Screen>
  );
}
