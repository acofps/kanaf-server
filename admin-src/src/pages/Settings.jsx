import React, { useState } from "react";
import { Save, AlertTriangle, Link2Off, Info } from "lucide-react";
import { api } from "../api.js";
import { C, can, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Field, Input, Select, Textarea,
  Spinner, ErrorBar, Table, Td, useAsync,
} from "../ui.jsx";

/* ============================================================
   الإعدادات.

   ------------------------------------------------------------
   لماذا شاشة واحدة لثلاثة جداول
   ------------------------------------------------------------
   الإعدادات كانت موزّعة بلا منطق: الإعداد المالي (نسبة الضريبة
   والمنطقة الزمنية المحاسبية) **بلا شاشة إطلاقاً** رغم أن مساره
   مختبَر منذ المرحلة 3 — تغيير النسبة كان يحتاج نداءً مباشراً.
   والبيانات الضريبية داخل صفحة «الباقات»، وهو موضع غريب.

   جمعها هنا يجعل سؤال «ما الذي يمكن ضبطه في كنف؟» له مكان واحد
   يُجاب فيه.

   ------------------------------------------------------------
   وشارة «لا يؤثر بعد» ليست تجميلاً
   ------------------------------------------------------------
   البند 6 يطلب تحديد ما هو UI-only وما هو مربوط فعلياً. والسبب أن
   الإعداد الذي يظهر في شاشة ولا يقرؤه أحد **أخطر من الغائب**:
   المسؤول يغيّره، ويرى «حُفظ»، ويبني على أنه سرى.

   وهو نفس نمط العطب الذي كلّف هذا المشروع مرتين — البث الذي كان
   يعيد dev-mock ويُحسب نجاحاً، والوثيقة التي وصفت استعلاماً بغير
   ما يفعل.

   الحالة تأتي من الخادم (`registry` في admin/settings.js) لا من
   قائمة مكتوبة هنا، فلا تتقادم.
   ============================================================ */

export default function Settings({ me, toast }) {
  const state = useAsync(() => api.settingsOverview(), []);
  const d = state.data;

  if (state.loading) return <div className="py-16 flex justify-center"><Spinner /></div>;
  if (state.error) return <ErrorBar error={state.error} />;

  const registryFor = (key) => (d?.registry || []).find((r) => r.key === key);

  return (
    <div>
      <PageTitle
        title="الإعدادات"
        subtitle="لكل إعداد مصدر واحد. وما ليس مربوطاً بسلوك حقيقي بعد، مكتوب عليه ذلك."
      />

      {d.sections?.billing && (
        <BillingSection section={d.sections.billing} registryFor={registryFor} toast={toast} onSaved={state.reload} />
      )}
      {d.sections?.tax && (
        <TaxSection section={d.sections.tax} registryFor={registryFor} toast={toast} onSaved={state.reload} />
      )}
      {d.sections?.app && (
        <AppSection section={d.sections.app} registryFor={registryFor} toast={toast} onSaved={state.reload} />
      )}
    </div>
  );
}

/** شارة الحالة — مربوط أم معروض فقط. */
function WiredBadge({ entry }) {
  if (!entry) return null;
  if (entry.wired) {
    return <Badge color="green">مربوط</Badge>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Link2Off size={11} color={C.amber} />
      <Badge color="amber">لا يؤثر بعد</Badge>
    </span>
  );
}

function Note({ entry }) {
  if (!entry?.note) return null;
  return (
    <p className="text-[11px] leading-6 mt-1 flex items-start gap-1.5" style={{ color: C.textFaint }}>
      <Info size={11} className="mt-1 shrink-0" />
      <span>{entry.note}</span>
    </p>
  );
}

/* ============================================================
   الإعداد المالي — محصور بالمالك
   ============================================================ */
function BillingSection({ section, registryFor, toast, onSaved }) {
  const v = section.values;
  const [vatRate, setVatRate] = useState(String(v.vat_rate ?? ""));
  const [includes, setIncludes] = useState(!!v.prices_include_vat);
  const [currency, setCurrency] = useState(v.currency || "SAR");
  const [tz, setTz] = useState(v.reporting_timezone || "Asia/Riyadh");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    if (!reason.trim()) { setErr("السبب مطلوب — يُسجَّل في سجل التدقيق."); return; }
    const r = Number(vatRate);
    if (!Number.isFinite(r) || r < 0 || r >= 1) {
      setErr("النسبة تُكتب ككسر عشري: 0.15 لخمسة عشر بالمئة، لا 15."); return;
    }
    setBusy(true); setErr("");
    try {
      await api.saveBillingSettings({
        vatRate: r, pricesIncludeVat: includes, currency, reportingTimezone: tz, reason: reason.trim(),
      });
      setReason(""); toast("حُفظ الإعداد المالي."); onSaved();
    } catch (e) { setErr(e?.arabic || "تعذّر الحفظ."); }
    finally { setBusy(false); }
  };

  return (
    <Card className="mb-4">
      <h3 className="text-sm font-bold mb-1" style={{ color: C.text }}>الإعداد المالي</h3>
      <p className="text-[11px] leading-6 mb-4" style={{ color: C.textMuted }}>
        يسري على كل فاتورة تصدر بعد الحفظ. <strong>الفواتير الصادرة لا تتأثر</strong> — نسبتها مجمّدة في وثيقتها وقت إصدارها.
      </p>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
        <Field label={<span className="inline-flex items-center gap-2">نسبة الضريبة <WiredBadge entry={registryFor("vat_rate")} /></span>}
          hint="كسر عشري: 0.15 = خمسة عشر بالمئة.">
          <Input value={vatRate} disabled={!section.canEdit} inputMode="decimal"
            onChange={(e) => setVatRate(e.target.value)} />
        </Field>

        <Field label={<span className="inline-flex items-center gap-2">العملة <WiredBadge entry={registryFor("currency")} /></span>}>
          <Input value={currency} disabled={!section.canEdit} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </Field>

        <Field label={<span className="inline-flex items-center gap-2">المنطقة الزمنية المحاسبية <WiredBadge entry={registryFor("reporting_timezone")} /></span>}
          hint="كل حدود التقارير محسوبة بها لا بتوقيت الخادم.">
          <Select value={tz} disabled={!section.canEdit} onChange={(e) => setTz(e.target.value)}>
            {["Asia/Riyadh", "UTC", "Asia/Dubai", "Africa/Cairo"].map((z) => <option key={z} value={z}>{z}</option>)}
          </Select>
        </Field>
      </div>

      <label className="flex items-center gap-2 text-xs mt-3" style={{ color: C.textMuted }}>
        <input type="checkbox" checked={includes} disabled={!section.canEdit}
          onChange={(e) => setIncludes(e.target.checked)} />
        الأسعار المعلنة شاملة الضريبة
      </label>

      <Note entry={registryFor("vat_rate")} />

      {section.canEdit ? (
        <div className="mt-4 grid gap-3">
          <Field label="السبب" hint="إلزامي. يُحفظ في سجل التدقيق بالقيمة القديمة والجديدة.">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <ErrorBar error={err} onClose={() => setErr("")} />
          <div><Button onClick={save} busy={busy}><Save size={13} /> حفظ</Button></div>
        </div>
      ) : (
        <p className="text-[11px] mt-4 flex items-center gap-1.5" style={{ color: C.textFaint }}>
          <AlertTriangle size={11} /> للعرض فقط — التعديل يحتاج صلاحية المالك.
        </p>
      )}
    </Card>
  );
}

/* ============================================================
   البيانات الضريبية
   ============================================================ */
function TaxSection({ section, registryFor, toast, onSaved }) {
  const v = section.values || {};
  const [legalName, setLegalName] = useState(v.legal_name || "");
  const [vatNumber, setVatNumber] = useState(v.vat_number || "");
  const [address, setAddress] = useState(v.address || "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    if (!reason.trim()) { setErr("السبب مطلوب."); return; }
    if (!/^\d{15}$/.test(vatNumber.trim())) { setErr("الرقم الضريبي خمسة عشر رقماً."); return; }
    setBusy(true); setErr("");
    try {
      await api.saveTaxSettings({ legalName: legalName.trim(), vatNumber: vatNumber.trim(), address: address.trim(), reason: reason.trim() });
      setReason(""); toast("حُفظت البيانات الضريبية."); onSaved();
    } catch (e) { setErr(e?.arabic || "تعذّر الحفظ."); }
    finally { setBusy(false); }
  };

  return (
    <Card className="mb-4">
      <h3 className="text-sm font-bold mb-1" style={{ color: C.text }}>البيانات الضريبية للبائع</h3>
      <p className="text-[11px] leading-6 mb-4" style={{ color: C.crisis }}>
        ⚠️ الاسم النظامي والرقم الضريبي يدخلان <strong>حرفياً</strong> في رمز QR لكل فاتورة تصدر بعد الحفظ.
        أي اختلاف عن شهادة التسجيل الضريبي عيب نظامي في الوثيقة.
      </p>

      <div className="grid gap-3">
        <Field label={<span className="inline-flex items-center gap-2">الاسم النظامي <WiredBadge entry={registryFor("legal_name")} /></span>}>
          <Input value={legalName} disabled={!section.canEdit} onChange={(e) => setLegalName(e.target.value)} />
        </Field>
        <Field label="الرقم الضريبي" hint="خمسة عشر رقماً.">
          <Input value={vatNumber} disabled={!section.canEdit} inputMode="numeric"
            onChange={(e) => setVatNumber(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Field label="العنوان">
          <Textarea rows={2} value={address} disabled={!section.canEdit} onChange={(e) => setAddress(e.target.value)} />
        </Field>
      </div>

      {section.canEdit ? (
        <div className="mt-4 grid gap-3">
          <Field label="السبب"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <ErrorBar error={err} onClose={() => setErr("")} />
          <div><Button onClick={save} busy={busy}><Save size={13} /> حفظ</Button></div>
        </div>
      ) : (
        <p className="text-[11px] mt-4 flex items-center gap-1.5" style={{ color: C.textFaint }}>
          <AlertTriangle size={11} /> للعرض فقط — التعديل يحتاج صلاحية المالك.
        </p>
      )}
      {v.updated_at && (
        <p className="text-[10px] mt-3" style={{ color: C.textFaint }}>آخر تعديل: {fmtDateTime(v.updated_at)}</p>
      )}
    </Card>
  );
}

/* ============================================================
   إعدادات التشغيل
   ============================================================ */
/* ------------------------------------------------------------
   عرض قيمة الإعداد.

   المرحلة 6 أدخلت أول إعداد **منطقي** (مفتاح زر واتساب) وأول
   إعداد يجوز أن يكون **فارغاً** (الرقم قبل ضبطه). وJSON.stringify
   كان يعرضهما "true" و null خامّين — نصّ برمجي في شاشة يقرؤها
   مالك لا مبرمج.
   ------------------------------------------------------------ */
function SettingValue({ value }) {
  if (typeof value === "boolean") {
    return (
      <Badge color={value ? "green" : "textFaint"}>{value ? "مفعّل" : "مطفأ"}</Badge>
    );
  }
  if (value === null || value === undefined || value === "") {
    return <span style={{ color: C.textFaint }}>غير مضبوط</span>;
  }
  return <span style={{ color: C.textMuted }}>{typeof value === "string" ? value : JSON.stringify(value)}</span>;
}

function AppSection({ section, registryFor, toast, onSaved }) {
  const [editing, setEditing] = useState(null);
  const rows = section.values || [];
  const unwired = rows.filter((r) => !registryFor(r.key)?.wired).length;

  return (
    <Card>
      <h3 className="text-sm font-bold mb-1" style={{ color: C.text }}>إعدادات التشغيل</h3>
      <p className="text-[11px] leading-6 mb-4" style={{ color: C.textMuted }}>
        {unwired > 0 && (
          <>
            <strong style={{ color: C.amber }}>{unwired} منها لا تؤثر بعد</strong> — الخادم يقدّمها،
            وتطبيق المستخدم لا يقرؤها حتى يُحدَّث. مكتوبة كذلك عمداً بدل أن تُعرض كأنها تعمل.
          </>
        )}
      </p>

      <Table head={["الإعداد", "القيمة", "الحالة", "آخر تعديل", ""]}>
        {rows.map((r) => {
          const entry = registryFor(r.key);
          return (
            <tr key={r.key}>
              <Td>
                <span className="font-bold">{entry?.label || r.key}</span>
                <span className="block text-[10px]" style={{ color: C.textFaint }}>{r.key}</span>
              </Td>
              <Td><SettingValue value={r.value} /></Td>
              <Td><WiredBadge entry={entry} /></Td>
              <Td>{r.updated_at ? fmtDateTime(r.updated_at) : "—"}</Td>
              <Td>
                <div className="flex justify-end">
                  {section.canEdit && <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>تعديل</Button>}
                </div>
              </Td>
            </tr>
          );
        })}
      </Table>

      {rows.map((r) => registryFor(r.key)?.note && (
        <div key={`n-${r.key}`} className="mt-2">
          <p className="text-[10px]" style={{ color: C.textFaint }}>
            <strong>{registryFor(r.key)?.label}:</strong> {registryFor(r.key)?.note}
          </p>
        </div>
      ))}

      {editing && (
        <EditAppSetting setting={editing} entry={registryFor(editing.key)}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); toast("حُفظ الإعداد."); onSaved(); }} />
      )}
    </Card>
  );
}

function EditAppSetting({ setting, entry, onClose, onDone }) {
  const isNumber = typeof setting.value === "number";
  /* ------------------------------------------------------------
     القيمة المنطقية تحتاج مفتاحاً لا حقل نص.

     ⚠️ بلا هذا الفرع كان محرّر الإعدادات يرسل السلسلة "true"
     لمفتاح زر واتساب، فيردّها الخادم بـvalue_must_be_boolean —
     أي أن الزر **لا يمكن تشغيله من اللوحة إطلاقاً**. وكل إعداد
     كان نصّاً قبل هذه المرحلة، فلم يظهر النقص.

     ولا يُستنتج النوع من السجلّ بل من القيمة الحالية نفسها: هي
     في الجدول من نوعها الصحيح (JSONB)، والسجلّ لا يصف الأنواع.
     ------------------------------------------------------------ */
  const isBool = typeof setting.value === "boolean";
  const [boolValue, setBoolValue] = useState(setting.value === true);
  const [value, setValue] = useState(isNumber ? String(setting.value) : String(setting.value ?? ""));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    if (!reason.trim()) { setErr("السبب مطلوب."); return; }
    if (!isBool && !String(value).trim()) { setErr("القيمة لا تكون فارغة."); return; }
    setBusy(true); setErr("");
    try {
      const payload = isBool ? boolValue : (isNumber ? Number(value) : value);
      await api.updateAppSetting(setting.key, payload, reason.trim());
      onDone();
    } catch (e) { setErr(e?.arabic || "تعذّر الحفظ."); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
      style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="rounded-2xl w-full my-8 p-5" style={{ maxWidth: 480, background: C.surface, border: `1px solid ${C.line}` }}
        onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold mb-1" style={{ color: C.text }}>{entry?.label || setting.key}</h3>
        {entry && !entry.wired && (
          <p className="text-[11px] leading-6 mb-3 rounded-xl px-3 py-2" style={{ background: C.amberSoft, color: C.amber }}>
            ⚠️ هذا الإعداد لا يؤثر بعد. {entry.note}
          </p>
        )}
        <div className="grid gap-3">
          <Field label="القيمة">
            {isBool ? (
              <div className="flex gap-2">
                {[[true, "مفعّل"], [false, "مطفأ"]].map(([v, label]) => (
                  <button key={String(v)} type="button" onClick={() => setBoolValue(v)}
                    className="px-4 py-2 rounded-xl text-xs font-bold flex-1"
                    style={{
                      background: boolValue === v ? C.tealSoft : C.surfaceAlt,
                      color: boolValue === v ? C.teal : C.textMuted,
                      border: `1px solid ${boolValue === v ? C.teal : C.line}`,
                    }}>
                    {label}
                  </button>
                ))}
              </div>
            ) : String(setting.value ?? "").length > 60
              ? <Textarea rows={3} value={value} onChange={(e) => setValue(e.target.value)} />
              : <Input value={value} inputMode={isNumber ? "numeric" : undefined} onChange={(e) => setValue(e.target.value)} />}
          </Field>
          <Field label="السبب" hint="يُحفظ في سجل التدقيق بالقيمة القديمة والجديدة.">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <ErrorBar error={err} onClose={() => setErr("")} />
          <div className="flex gap-2">
            <Button onClick={save} busy={busy}>حفظ</Button>
            <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
