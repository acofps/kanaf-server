import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { C, can, fmtDateTime } from "../theme.js";
import { Card, PageTitle, Button, Badge, Field, Input, Textarea, Select, Spinner, Empty, ErrorBar, ConfirmPrompt, Table, Td, Screen, useAsync } from "../ui.jsx";
import { Link, navigate } from "../router.js";

/* ============================================================
   قوالب الرسائل ومحتواها — KANAF-ORD-0013 §9

   /templates                    جرد رسائل النظام وقوالب البريد
   /templates/message/:key       نص الرسالة وقالبها وقنواتها، مع معاينة وإرسال تجريبي
   /templates/t/new | /t/:id     قالب بريد (لون من اللوحة، ملاحظة التذييل، الروابط)

   العرض للمالك والمدير (app_settings:view)، والتعديل للمالك (app_settings:edit).
   الخادم يرفض حفظ نص ينقصه موضع إلزامي ({{code}} في رسالة التحقق) — الواجهة
   تنبّه قبله، والحكم للخادم. ولا قناة معطّلة تُفعَّل (§9.5).
   ============================================================ */

const CHANNEL = { email: "البريد", in_app: "داخل التطبيق", push: "إشعار الجهاز", whatsapp: "واتساب", sms: "رسالة نصية" };
const AUDIENCE = { member: "للأعضاء", staff: "لفريق الإدارة" };
const ERR = {
  required_placeholder_missing: (d) => `النص ينقصه عنصر إلزامي: ${(d || []).join("، ")}`,
  unknown_placeholder: (d) => `موضع غير معروف لهذه الرسالة: ${(d || []).map((v) => `{{${v}}}`).join("، ")}`,
  channel_not_allowed: () => "قناة غير مسموحة لهذه الرسالة.",
  required_channel_missing: (d) => `قناة إلزامية لا تُطفأ: ${(d || []).map((c) => CHANNEL[c] || c).join("، ")}`,
  channel_unavailable: (d) => `قناة معطّلة لغياب اعتمادها: ${(d || []).map((x) => CHANNEL[x.channel] || x.channel).join("، ")}`,
  invalid_accent: () => "اللون من لوحة الهوية وحدها.",
  template_name_exists: () => "اسم القالب مستعمل.",
  cannot_delete_default_template: () => "القالب الافتراضي لا يُحذف.",
};
const explain = (e) => {
  const code = e?.body?.error || e?.code;
  return ERR[code] ? ERR[code](e?.body?.detail) : (e?.arabic || "تعذّر التنفيذ.");
};

export default function Templates({ me, toast, route = [] }) {
  const state = useAsync(() => api.messageCatalog(), []);
  const canEdit = can(me, "app_settings:edit");
  if (state.loading) return <div className="py-8 flex justify-center"><Spinner /></div>;
  if (state.error) return <ErrorBar error={state.error} />;
  const d = state.data;
  if (route[0] === "message" && route[1]) {
    const m = d.messages.find((x) => x.key === route[1]);
    return m ? <MessageEditor key={m.key} m={m} catalog={d} canEdit={canEdit} toast={toast} reload={state.reload} />
      : <Screen title="رسالة غير معروفة" back="/templates"><Empty>لا رسالة بهذا المفتاح.</Empty></Screen>;
  }
  if (route[0] === "t" && route[1]) {
    const t = route[1] === "new" ? null : d.templates.find((x) => x.id === route[1]);
    if (route[1] !== "new" && !t) return <Screen title="قالب غير موجود" back="/templates"><Empty>لعلّه حُذف.</Empty></Screen>;
    return <TemplateEditor key={route[1]} t={t} catalog={d} canEdit={canEdit} toast={toast} reload={state.reload} />;
  }
  return <Overview d={d} canEdit={canEdit} />;
}

function Overview({ d, canEdit }) {
  const tName = (id) => d.templates.find((t) => t.id === id)?.name || d.templates.find((t) => t.is_default)?.name;
  return (
    <div>
      <PageTitle title="قوالب الرسائل" subtitle="كل رسالة يرسلها النظام: نصّها وقالبها وقنواتها. بلا تعديل يُرسل النص الافتراضي كما هو." />
      <Card className="mb-4">
        <h3 className="text-sm font-bold mb-3" style={{ color: C.text }}>الرسائل</h3>
        <Table head={["الرسالة", "لمن", "القنوات", "القالب", "الحالة"]}>
          {d.messages.map((m) => (
            <tr key={m.key}>
              <Td><Link to={`/templates/message/${m.key}`} className="font-bold" style={{ color: C.teal }}>{m.label}</Link></Td>
              <Td>{AUDIENCE[m.audience]}</Td>
              <Td className="text-[11px]">{m.channels.map((c) => CHANNEL[c] || c).join("، ")}</Td>
              <Td>{m.channels.includes("email") ? tName(m.templateId) : "—"}</Td>
              <Td>{m.customized ? <Badge color="teal">معدَّلة</Badge> : <Badge>الافتراضي</Badge>}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold" style={{ color: C.text }}>قوالب البريد</h3>
          {canEdit && <Link to="/templates/t/new"><Button size="sm">قالب جديد</Button></Link>}
        </div>
        <Table head={["الاسم", "اللون", "ملاحظة التذييل", "روابط المتجرين", "آخر تعديل"]}>
          {d.templates.map((t) => (
            <tr key={t.id}>
              <Td><Link to={`/templates/t/${t.id}`} className="font-bold" style={{ color: C.teal }}>{t.name}</Link> {t.is_default && <Badge>الافتراضي</Badge>}</Td>
              <Td><span className="inline-block w-4 h-4 rounded-full align-middle" style={{ background: t.accent }} /> <span dir="ltr" className="text-[11px]">{t.accent}</span></Td>
              <Td className="text-[11px]">{t.footer_note || "—"}</Td>
              <Td>{t.show_store_links ? "تظهر" : "مخفية"}</Td>
              <Td dir="ltr">{fmtDateTime(t.updated_at)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

function Preview({ html }) {
  if (!html) return null;
  return <iframe title="معاينة" srcDoc={html} sandbox="" className="w-full rounded-xl" style={{ height: 520, border: `1px solid ${C.line}`, background: "#fff" }} />;
}

function MessageEditor({ m, catalog, canEdit, toast, reload }) {
  const [subject, setSubject] = useState(m.subject);
  const [body, setBody] = useState(m.body);
  const [templateId, setTemplateId] = useState(m.templateId || "");
  const [channels, setChannels] = useState(m.channels);
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState("");
  const [ask, setAsk] = useState(null);
  const [busy, setBusy] = useState(false);
  const missing = m.required.filter((v) => !new RegExp(`\\{\\{\\s*${v}\\s*\\}\\}`).test(body));
  const draft = { subject, body, templateId: templateId || null };

  const runPreview = async () => {
    setErr(""); setBusy(true);
    try { setPreview(await api.previewMessage(m.key, draft)); } catch (e) { setErr(explain(e)); } finally { setBusy(false); }
  };
  useEffect(() => { runPreview(); /* معاينة أولى بالمحفوظ */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (c) => setChannels((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  return (
    <Screen title={m.label} back="/templates" backLabel="قوالب الرسائل">
      <p className="text-[11px] leading-6 mb-4" style={{ color: C.textMuted }}>
        {AUDIENCE[m.audience]}. المواضع المتاحة: {m.vars.length ? m.vars.map((v) => <code key={v} dir="ltr" className="mx-0.5">{`{{${v}}}`}</code>) : "لا شيء"}.
        {m.required.length > 0 && <> الإلزامي منها: {m.required.map((v) => <b key={v} dir="ltr" className="mx-0.5">{`{{${v}}}`}</b>)} — لا يُحفظ نص بدونه.</>}
      </p>
      <div className="grid lg:grid-cols-2 gap-5">
        <div>
          <Field label="العنوان"><Input value={subject} disabled={!canEdit} onChange={(e) => setSubject(e.target.value)} /></Field>
          <Field label="النص" hint={missing.length ? `ينقصه: ${missing.map((v) => `{{${v}}}`).join("، ")}` : null}>
            <Textarea rows={12} value={body} disabled={!canEdit} onChange={(e) => setBody(e.target.value)} />
          </Field>
          {m.allowedChannels.includes("email") && (
            <Field label="قالب البريد">
              <Select value={templateId} disabled={!canEdit} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">{catalog.templates.find((t) => t.is_default)?.name} (الافتراضي)</option>
                {catalog.templates.filter((t) => !t.is_default).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="القنوات" hint="المعطّلة تنقصها بيانات اعتمادها في «التكاملات»، والإلزامية لا تُطفأ.">
            <div className="flex flex-wrap gap-3">
              {m.allowedChannels.map((c) => {
                const av = catalog.availability?.[c];
                const off = av && !av.ok && !m.requiredChannels.includes(c);
                const req = m.requiredChannels.includes(c);
                return (
                  <label key={c} className="inline-flex items-center gap-1.5 text-xs" style={{ color: off ? C.textFaint : C.text }} title={off ? av.reason : ""}>
                    <input type="checkbox" checked={channels.includes(c)} disabled={!canEdit || req || (off && !channels.includes(c))} onChange={() => toggle(c)} />
                    {CHANNEL[c] || c}{req ? " (إلزامية)" : ""}{off ? " — معطّلة" : ""}
                  </label>
                );
              })}
            </div>
          </Field>
          <ErrorBar error={err} />
          <div className="flex flex-wrap gap-2 mt-3">
            <Button variant="ghost" busy={busy} onClick={runPreview}>معاينة</Button>
            {canEdit && <Button disabled={missing.length > 0} onClick={() => setAsk("save")}>حفظ</Button>}
            {canEdit && <Button variant="ghost" onClick={async () => {
              setErr("");
              try { const r = await api.testSendMessage(m.key, draft); toast(r.delivered ? `أُرسلت إلى ${r.to}` : r.note); }
              catch (e) { setErr(explain(e)); }
            }}>إرسال تجريبي إلى بريدي</Button>}
            {canEdit && m.customized && <Button variant="ghost" onClick={() => setAsk("reset")}>العودة إلى الافتراضي</Button>}
          </div>
        </div>
        <div>
          {preview && <p className="text-xs font-bold mb-2" style={{ color: C.text }}>{preview.subject}</p>}
          <Preview html={preview?.html} />
        </div>
      </div>
      <ConfirmPrompt open={ask === "save"} title="حفظ الرسالة" description="يُسجَّل النص والقالب والقنوات قبل التعديل وبعده في سجل الإجراءات."
        onClose={() => setAsk(null)}
        onConfirm={async () => {
          try { await api.saveMessage(m.key, { ...draft, channels }); }
          catch (e) { throw Object.assign(new Error(), { arabic: explain(e) }); }
          toast("حُفظت."); reload();
        }} />
      <ConfirmPrompt open={ask === "reset"} title="العودة إلى النص الافتراضي" danger
        onClose={() => setAsk(null)}
        onConfirm={async () => { await api.resetMessage(m.key); toast("عادت إلى الافتراضي."); reload(); }} />
    </Screen>
  );
}

function TemplateEditor({ t, catalog, canEdit, toast, reload }) {
  const [v, setV] = useState({
    name: t?.name || "", accent: t?.accent || catalog.accents[0], footerNote: t?.footer_note || "",
    showStoreLinks: t ? t.show_store_links : true, showSocialLinks: t ? t.show_social_links : true,
  });
  const [ask, setAsk] = useState(null);
  const [preview, setPreview] = useState(null);
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const used = catalog.messages.filter((m) => t && m.templateId === t.id);

  useEffect(() => { if (t) api.previewMessage("email_verification", { templateId: t.is_default ? null : t.id }).then(setPreview).catch(() => {}); }, [t]);

  return (
    <Screen title={t ? t.name : "قالب جديد"} back="/templates" backLabel="قوالب الرسائل">
      <div className="grid lg:grid-cols-2 gap-5">
        <div>
          <Field label="الاسم"><Input value={v.name} disabled={!canEdit} onChange={set("name")} /></Field>
          <Field label="اللون" hint="من لوحة الهوية وحدها.">
            <div className="flex gap-2">
              {catalog.accents.map((a) => (
                <button key={a} type="button" disabled={!canEdit} onClick={() => setV({ ...v, accent: a })} aria-label={a}
                  className="w-8 h-8 rounded-full" style={{ background: a, outline: v.accent === a ? `3px solid ${C.text}` : "none", outlineOffset: 2 }} />
              ))}
            </div>
          </Field>
          <Field label="ملاحظة التذييل" hint="سطر يظهر أسفل كل رسالة بهذا القالب (300 حرف).">
            <Textarea rows={2} value={v.footerNote} disabled={!canEdit} maxLength={300} onChange={set("footerNote")} />
          </Field>
          <label className="flex items-center gap-2 text-xs mb-2" style={{ color: C.text }}><input type="checkbox" checked={v.showStoreLinks} disabled={!canEdit} onChange={set("showStoreLinks")} /> روابط المتجرين</label>
          <label className="flex items-center gap-2 text-xs mb-4" style={{ color: C.text }}><input type="checkbox" checked={v.showSocialLinks} disabled={!canEdit} onChange={set("showSocialLinks")} /> روابط التواصل</label>
          {t && <p className="text-[11px] mb-3" style={{ color: C.textMuted }}>
            {t.is_default ? "القالب الافتراضي: كل رسالة غير مربوطة بقالب آخر تُبنى عليه، ولا يُحذف." : `مربوطة به: ${used.map((m) => m.label).join("، ") || "لا رسائل"}.`}
          </p>}
          {canEdit && (
            <div className="flex gap-2">
              <Button onClick={() => setAsk("save")} disabled={!v.name.trim()}>{t ? "حفظ" : "إنشاء"}</Button>
              {t && !t.is_default && <Button variant="danger" onClick={() => setAsk("delete")}>حذف</Button>}
            </div>
          )}
        </div>
        <div>{preview && <Preview html={preview.html} />}</div>
      </div>
      <ConfirmPrompt open={ask === "save"} title={t ? "حفظ القالب" : "إنشاء قالب"} onClose={() => setAsk(null)}
        onConfirm={async () => {
          try {
            const r = t ? await api.updateTemplate(t.id, { ...v }) : await api.createTemplate({ ...v });
            toast("حُفظ."); reload(); if (!t) navigate(`/templates/t/${r.template.id}`);
          } catch (e) { throw Object.assign(new Error(), { arabic: explain(e) }); }
        }} />
      <ConfirmPrompt open={ask === "delete"} title="حذف القالب" danger description="الرسائل المربوطة به تعود إلى القالب الافتراضي."
        onClose={() => setAsk(null)}
        onConfirm={async () => {
          try { await api.deleteTemplate(t.id); } catch (e) { throw Object.assign(new Error(), { arabic: explain(e) }); }
          toast("حُذف."); reload(); navigate("/templates");
        }} />
    </Screen>
  );
}
