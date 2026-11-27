import React, { useEffect, useState } from "react";
import { Save, AlertTriangle } from "lucide-react";
import { api } from "../api.js";
import { C, fmtDateTime } from "../theme.js";
import { Card, Button, Field, Input, Textarea, Spinner, ErrorBar, useAsync, Screen } from "../ui.jsx";

/* ============================================================
   واجهة الموقع — KANAF-ORD-0022 ب-4

   روابط صفحات tanfs.net الثلاث ونصّاها القانونيان. الصفحات تقرؤها عند
   التحميل من /api/public/landing و/api/public/legal، فما يُحفظ هنا يظهر
   هناك خلال خمس دقائق (مدة التخزين المؤقت للردّ) بلا رفع أي ملف.

   زرّ حفظ واحد يرسل الحقول كلها، والخادم يتحقق منها كلها: فإن رُفض حقل
   لم يُحفظ شيء، وظهر خطأ كل حقل تحته.
   ============================================================ */

const LINKS = [
  { key: "app_store_url", label: "رابط التطبيق في App Store", hint: "رابط صفحة التطبيق على apps.apple.com. يظهر زرّ التنزيل في الرئيسية." },
  { key: "google_play_url", label: "رابط التطبيق في Google Play", hint: "رابط صفحة التطبيق على play.google.com. يظهر زرّ التنزيل في الرئيسية." },
  { key: "x_url", label: "حساب إكس", hint: "رابط الحساب كاملاً، مثل https://x.com/… ويظهر في الفوتر." },
  { key: "instagram_url", label: "حساب إنستقرام", hint: "رابط الحساب كاملاً، مثل https://instagram.com/… ويظهر في الفوتر." },
  { key: "whatsapp_url", label: "رابط واتساب", hint: "رابط المحادثة، مثل https://wa.me/9665XXXXXXXX ويظهر في الفوتر." },
  { key: "tiktok_url", label: "حساب تيك توك", hint: "رابط الحساب كاملاً، مثل https://www.tiktok.com/@… ويظهر في الفوتر." },
  { key: "snapchat_url", label: "حساب سناب شات", hint: "رابط الحساب كاملاً، مثل https://www.snapchat.com/add/… ويظهر في الفوتر." },
  { key: "contact_email", label: "بريد التواصل", hint: "البريد المعروض في فوتر الصفحات للتواصل." },
];

const TEXTS = [
  { key: "privacy_text", stamp: "privacy_text_updated_at", label: "نصّ سياسة الخصوصية", hint: "يظهر في صفحة سياسة الخصوصية على tanfs.net." },
  { key: "terms_text", stamp: "terms_text_updated_at", label: "نصّ شروط الاستخدام", hint: "يظهر في صفحة شروط الاستخدام على tanfs.net." },
];

const EDITABLE = [...LINKS.map((f) => f.key), ...TEXTS.map((f) => f.key)];

/** ما يُدعم في النصّين، بالضبط. */
function FormatHelp() {
  return (
    <div className="text-[11px] leading-6 mt-1.5 rounded-xl px-3 py-2" style={{ color: C.textMuted, background: C.surfaceAlt }}>
      <div><code dir="ltr">##</code> في أول السطر = عنوان فرعي</div>
      <div><code dir="ltr">-</code> في أول السطر = بند قائمة</div>
      <div>سطر فارغ = فقرة جديدة</div>
      <div>وما عدا ذلك يظهر نصاً كما هو.</div>
    </div>
  );
}

export default function SiteFront({ toast }) {
  const state = useAsync(() => api.siteFront(), []);
  const [values, setValues] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { if (state.data) setValues(state.data.values); }, [state.data]);

  if (state.loading || (!values && !state.error)) return <div className="py-16 flex justify-center"><Spinner /></div>;
  if (state.error) return <Screen title="واجهة الموقع" back="/settings"><ErrorBar error={state.error} /></Screen>;

  const canEdit = !!state.data.canEdit;
  const limits = state.data.limits || { urlMax: 300, textMax: 60000 };
  const set = (key) => (e) => { setValues((v) => ({ ...v, [key]: e.target.value })); setErrors((x) => ({ ...x, [key]: undefined })); };

  const save = async () => {
    setBusy(true); setErr(""); setErrors({});
    try {
      const body = Object.fromEntries(EDITABLE.map((k) => [k, values[k] ?? ""]));
      const r = await api.saveSiteFront(body);
      setValues(r.values);
      toast(r.changed?.length ? "حُفظت واجهة الموقع. تظهر على tanfs.net خلال خمس دقائق." : "لا تغيير لحفظه.");
    } catch (e) {
      const fields = e?.body?.fields;
      if (fields) {
        setErrors(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.message])));
        setErr("لم يُحفظ شيء: صحّح الحقول المعلَّمة ثم احفظ.");
      } else setErr(e);
    } finally { setBusy(false); }
  };

  return (
    <Screen title="واجهة الموقع" back="/settings" backLabel="الإعدادات">
      <p className="text-[12px] leading-6 mb-5" style={{ color: C.textMuted }}>
        روابط الصفحات العامة على tanfs.net ونصّاها القانونيان. ما تحفظه هنا يظهر هناك خلال خمس دقائق بلا رفع أي ملف.
        الحقل الفارغ لا يظهر في الصفحة.
      </p>

      <h3 className="text-sm font-bold mb-3" style={{ color: C.text }}>الروابط والبريد</h3>
      <div className="grid gap-4 md:grid-cols-2">
        {LINKS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint} error={errors[f.key]}>
            <Input dir="ltr" value={values[f.key] ?? ""} onChange={set(f.key)} disabled={!canEdit}
              maxLength={limits.urlMax} placeholder={f.key === "contact_email" ? "name@example.com" : "https://"}
              type={f.key === "contact_email" ? "email" : "url"} aria-invalid={!!errors[f.key]} />
          </Field>
        ))}
      </div>

      <h3 className="text-sm font-bold mt-8 mb-3" style={{ color: C.text }}>النصّان القانونيان</h3>
      <div className="rounded-xl px-3 py-2.5 mb-4 flex items-start gap-2 text-[12px] leading-6 font-bold"
        role="note" style={{ background: C.amberSoft || C.surfaceAlt, color: C.amber, border: `1px solid ${C.amber}` }}>
        <AlertTriangle size={15} className="mt-1 shrink-0" />
        <span>هذان النصّان يراهما مراجعو متجرَي أبل وجوجل. وإفراغ أحدهما يُعيد الصفحة إلى نصّها المدفون، فلا تترك صفحة بلا نصّ.</span>
      </div>
      <div className="grid gap-6">
        {TEXTS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint} error={errors[f.key]}>
            <Textarea rows={14} value={values[f.key] ?? ""} onChange={set(f.key)} disabled={!canEdit}
              maxLength={limits.textMax} aria-invalid={!!errors[f.key]} />
            <FormatHelp />
            <p className="text-[11px] mt-1.5" style={{ color: C.textFaint }}>
              {(values[f.key] || "").length} / {limits.textMax} حرف · آخر تعديل: {values[f.stamp] ? fmtDateTime(values[f.stamp]) : "لم يُعدَّل بعد"}
            </p>
          </Field>
        ))}
      </div>

      <div className="mt-6 grid gap-3">
        <ErrorBar error={err} onClose={() => setErr("")} />
        {canEdit ? (
          <div><Button onClick={save} busy={busy}><Save size={13} /> حفظ</Button></div>
        ) : (
          <p className="text-[11px] flex items-center gap-1.5" style={{ color: C.textFaint }}>
            <AlertTriangle size={11} /> للعرض فقط — التعديل يحتاج صلاحية تعديل الإعدادات.
          </p>
        )}
      </div>
    </Screen>
  );
}
