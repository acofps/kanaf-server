import React, { useState } from "react";
import { Check, X, Power, CalendarClock, Pencil, History, Rocket } from "lucide-react";
import { api } from "../api.js";
import { C, CONTENT_TYPE_LABEL, REVIEW_LABEL, atLeast, fmtDateTime, toIsoWithOffset, toLocalInput } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Field, Input, Textarea, Select, SearchBox, Spinner, Empty,
  ErrorBar, Modal, ReasonPrompt, Table, Td, Pager, useAsync,
} from "../ui.jsx";

/* ============================================================
   إدارة المحتوى.

   هذه الشاشة هي ما كانت المرحلة 4 تعد به: زر ينشر محتوى فيراه
   المستخدم فعلاً. قبلها كانت الصفحة تقرأ جدولاً فارغاً لا يقرأه
   التطبيق، وكان النشر يتم بأمر في الطرفية.

   شرطان مستقلان يحكمان الظهور، ولهما زران منفصلان عمداً:
     • الاعتماد السريري — قرار على المحتوى نفسه.
     • مفتاح الإطلاق   — كاسر دائرة يوقف محتوى حياً فوراً بلا
       إعادة مراجعة، ويعيده بضغطة.

   الإيقاف الطارئ لا ينبغي أن يكلّف دورة مراجعة كاملة لاستعادته.
   ============================================================ */

const TYPES = ["", "journey", "overlay", "notebook", "cbt_tool", "library_article"];
const STATUSES = ["", "review_required", "approved", "rejected", "retired"];

export default function Content({ role, toast }) {
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [published, setPublished] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [reason, setReason] = useState(null);   // { title, description, danger, run }
  const [editing, setEditing] = useState(null);
  const [scheduling, setScheduling] = useState(null);
  const [history, setHistory] = useState(null);
  const [bulk, setBulk] = useState(false);
  const [err, setErr] = useState("");

  const canReview = atLeast(role, "admin");
  const canBulk = atLeast(role, "owner");

  const list = useAsync(
    () => api.listContent({
      type: type || undefined,
      status: status || undefined,
      search: search.trim() || undefined,
      published: published || undefined,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    [type, status, published, search, page]
  );

  const items = list.data?.items || [];
  const total = list.data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const run = async (fn, okMsg) => {
    setErr("");
    try { await fn(); toast(okMsg); list.reload(); }
    catch (e) { setErr(e?.arabic || "تعذّر التنفيذ."); }
  };

  return (
    <div className="space-y-4">
      <PageTitle
        title="المحتوى"
        subtitle="لا يظهر أي محتوى للمستخدمين قبل اعتماد سريري وتفعيل صريح هنا. التغيير ينعكس على التطبيق في الطلب التالي — بلا إعادة بناء."
      >
        {canBulk && <Button variant="soft" onClick={() => setBulk(true)}><Rocket size={13} /> نشر جماعي</Button>}
      </PageTitle>

      <ErrorBar error={err} onClose={() => setErr("")} />

      <Card>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
          <Field label="بحث"><SearchBox value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="عنوان أو مفتاح" /></Field>
          <Field label="النوع">
            <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
              {TYPES.map((t) => <option key={t} value={t}>{t === "" ? "الكل" : CONTENT_TYPE_LABEL[t]}</option>)}
            </Select>
          </Field>
          <Field label="حالة المراجعة">
            <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              {STATUSES.map((s) => <option key={s} value={s}>{s === "" ? "الكل" : REVIEW_LABEL[s]}</option>)}
            </Select>
          </Field>
          <Field label="الظهور">
            <Select value={published} onChange={(e) => { setPublished(e.target.value); setPage(1); }}>
              <option value="">الكل</option>
              <option value="true">ظاهر للمستخدم</option>
              <option value="false">غير ظاهر</option>
            </Select>
          </Field>
        </div>
      </Card>

      <Card>
        {list.loading ? <div className="py-6 flex justify-center"><Spinner /></div>
          : list.error ? <ErrorBar error={list.error} />
          : items.length === 0 ? <Empty>ما فيه محتوى بهذه المعايير.</Empty>
          : (
            <>
              <Table head={["العنصر", "النوع", "الطبقة", "المراجعة", "الظهور", ""]}>
                {items.map((it) => (
                  <tr key={it.id}>
                    <Td>
                      <div className="font-bold" style={{ color: C.text }}>{it.title || it.content_key}</div>
                      <div className="text-[10px] font-mono mt-0.5" style={{ color: C.textFaint }}>
                        {it.content_key} · v{it.content_version}
                      </div>
                    </Td>
                    <Td><span style={{ color: C.textMuted }}>{CONTENT_TYPE_LABEL[it.content_type] || it.content_type}</span></Td>
                    <Td>
                      <Badge color={it.subscription_tier === "plus" ? "amber" : "textMuted"}>
                        {it.subscription_tier === "plus" ? "كنف+" : "مجاني"}
                      </Badge>
                    </Td>
                    <Td>
                      <Badge color={it.clinical_review_status === "approved" ? "green"
                        : it.clinical_review_status === "rejected" ? "crisis" : "amber"}>
                        {REVIEW_LABEL[it.clinical_review_status]}
                      </Badge>
                    </Td>
                    <Td>
                      {it.is_live
                        ? <Badge color="green">ظاهر</Badge>
                        : <span title={it.hidden_reason || ""}><Badge color="textFaint">{it.hidden_reason || "غير ظاهر"}</Badge></span>}
                    </Td>
                    <Td>
                      <div className="flex gap-1.5 flex-wrap justify-end">
                        {canReview && it.clinical_review_status !== "approved" && (
                          <Button size="sm" variant="good" onClick={() => setReason({
                            title: `اعتماد «${it.title || it.content_key}»`,
                            description: "اعتماد سريري يعني أن هذا النص صالح للعرض على شخص قد يكون في ضائقة.",
                            run: (r) => run(() => api.reviewContent(it.id, "approved", r), "اعتُمد المحتوى."),
                          })}><Check size={12} /> اعتماد</Button>
                        )}
                        {canReview && it.clinical_review_status !== "rejected" && (
                          <Button size="sm" variant="ghost" onClick={() => setReason({
                            title: `رفض «${it.title || it.content_key}»`,
                            description: "الرفض ينزل مفتاح الإطلاق معه، ولا يمسّه النشر الجماعي بعدها.",
                            danger: true,
                            run: (r) => run(() => api.reviewContent(it.id, "rejected", r), "رُفض المحتوى."),
                          })}><X size={12} /> رفض</Button>
                        )}
                        {canReview && it.clinical_review_status === "approved" && (
                          <Button size="sm" variant={it.launch_enabled ? "warn" : "primary"}
                            onClick={() => setReason({
                              title: it.launch_enabled ? `إيقاف «${it.title}»` : `نشر «${it.title}»`,
                              description: it.launch_enabled
                                ? "سيختفي من التطبيق فوراً لكل المستخدمين."
                                : "سيظهر في التطبيق فوراً لكل من تسمح له طبقته.",
                              danger: it.launch_enabled,
                              run: (r) => run(
                                () => api.toggleContentLaunch(it.id, !it.launch_enabled, r),
                                it.launch_enabled ? "أُوقف المحتوى." : "نُشر المحتوى."
                              ),
                            })}>
                            <Power size={12} /> {it.launch_enabled ? "إيقاف" : "نشر"}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setEditing(it)}><Pencil size={12} /></Button>
                        {canReview && <Button size="sm" variant="ghost" onClick={() => setScheduling(it)}><CalendarClock size={12} /></Button>}
                        <Button size="sm" variant="ghost" onClick={() => setHistory(it)}><History size={12} /></Button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </Table>
              <Pager page={page} totalPages={totalPages} total={total} onPage={setPage} />
            </>
          )}
      </Card>

      <ReasonPrompt
        open={!!reason}
        title={reason?.title || ""}
        description={reason?.description}
        danger={reason?.danger}
        onConfirm={(r) => reason.run(r)}
        onClose={() => setReason(null)}
      />

      {editing && <EditPresentation item={editing} role={role} onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); list.reload(); toast("حُدّث العرض."); }} />}

      {scheduling && <ScheduleContent item={scheduling} onClose={() => setScheduling(null)}
        onDone={() => { setScheduling(null); list.reload(); toast("حُفظت الجدولة."); }} />}

      {history && <HistoryModal item={history} onClose={() => setHistory(null)} />}

      <BulkPublish open={bulk} onClose={() => setBulk(false)}
        onDone={(n) => { setBulk(false); list.reload(); toast(`نُشر ${n} عنصراً.`); }} />
    </div>
  );
}

/* ------------------------------------------------------------
   تحرير العرض — العنوان والتصنيف والترتيب والطبقة.

   الطبقة محصورة بصلاحية مدير لأنها **قرار مالي**: تحويل رحلة إلى
   مجانية يلغي سبب اشتراك. الحقل يُعطَّل بصرياً لمن دونها بدل أن
   يرسل ويُرفض.
   ------------------------------------------------------------ */
function EditPresentation({ item, role, onClose, onDone }) {
  const [title, setTitle] = useState(item.title || "");
  const [category, setCategory] = useState(item.category || "");
  const [order, setOrder] = useState(item.display_order ?? 0);
  const [tier, setTier] = useState(item.subscription_tier || "free");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const canTier = atLeast(role, "admin");

  const save = async () => {
    setBusy(true); setErr("");
    try {
      const patch = { title, category, displayOrder: Number(order), reason };
      if (canTier && tier !== item.subscription_tier) patch.subscriptionTier = tier;
      await api.updateContentPresentation(item.content_type, item.content_key, patch);
      onDone();
    } catch (e) { setErr(e?.arabic || "تعذّر الحفظ."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={`تحرير «${item.content_key}»`}>
      <div className="space-y-3">
        <Field label="العنوان"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="التصنيف"><Input value={category} onChange={(e) => setCategory(e.target.value)} /></Field>
        <Field label="ترتيب العرض"><Input type="number" value={order} onChange={(e) => setOrder(e.target.value)} /></Field>
        <Field label="الطبقة" hint={canTier ? "تغيير الطبقة قرار مالي — يُسجَّل في سجل التدقيق." : "يحتاج صلاحية مدير."}>
          <Select value={tier} disabled={!canTier} onChange={(e) => setTier(e.target.value)}>
            <option value="free">مجاني</option>
            <option value="plus">كنف+</option>
          </Select>
        </Field>
        <Field label="السبب"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="اختياري" /></Field>
        <ErrorBar error={err} />
        <div className="flex gap-2 pt-1">
          <Button onClick={save} busy={busy}>حفظ</Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------
   الجدولة.

   لا وظيفة خلفية تحوّل «مجدول» إلى «منشور» — الخادم يقارن التاريخين
   بالوقت الحالي في كل قراءة. فيستحيل أن يظهر عنصر قبل وقته،
   ويستحيل أن يتأخر لأن وظيفة ما لم تعمل.

   المتصفح يرسل الوقت بإزاحة جهازك الصريحة، والخادم يخزّنه لحظةً
   مطلقة. لا تُخزَّن أوقات محلية بلا إزاحة إطلاقاً.
   ------------------------------------------------------------ */
function ScheduleContent({ item, onClose, onDone }) {
  const [pub, setPub] = useState(toLocalInput(item.publish_at));
  const [unpub, setUnpub] = useState(toLocalInput(item.unpublish_at));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setBusy(true); setErr("");
    try {
      await api.scheduleContent(item.content_type, item.content_key, {
        publishAt: toIsoWithOffset(pub),
        unpublishAt: toIsoWithOffset(unpub),
        reason,
      });
      onDone();
    } catch (e) { setErr(e?.arabic || "تعذّرت الجدولة."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={`جدولة «${item.content_key}»`}>
      <div className="space-y-3">
        <p className="text-xs leading-6" style={{ color: C.textMuted }}>
          الجدولة وحدها لا تنشر — لا بد أن يكون العنصر معتمداً ومفتاح الإطلاق مرفوعاً أيضاً.
        </p>
        <Field label="يظهر ابتداءً من" hint="اتركه فارغاً ليظهر فور التفعيل.">
          <Input type="datetime-local" value={pub} onChange={(e) => setPub(e.target.value)} />
        </Field>
        <Field label="يختفي عند" hint="اتركه فارغاً ليبقى بلا نهاية.">
          <Input type="datetime-local" value={unpub} onChange={(e) => setUnpub(e.target.value)} />
        </Field>
        <Field label="السبب"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="اختياري" /></Field>
        <ErrorBar error={err} />
        <div className="flex gap-2 pt-1">
          <Button onClick={save} busy={busy}>حفظ الجدولة</Button>
          <Button variant="ghost" onClick={() => { setPub(""); setUnpub(""); }} disabled={busy}>مسح التواريخ</Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
        </div>
      </div>
    </Modal>
  );
}

/** سجل تغييرات العنصر — يُكتب صف لكل تغيير ولا يُعدَّل ولا يُحذف. */
function HistoryModal({ item, onClose }) {
  const h = useAsync(() => api.getContentItem(item.content_type, item.content_key), [item.content_key]);
  const rows = h.data?.history || [];
  const KIND = {
    review: "مراجعة", publish: "نشر", unpublish: "إيقاف",
    schedule: "جدولة", tier_change: "تغيير طبقة", presentation: "تحرير عرض", seed: "بذر",
  };
  return (
    <Modal open onClose={onClose} title={`سجل «${item.content_key}»`} width={640}>
      {h.loading ? <div className="py-6 flex justify-center"><Spinner /></div>
        : rows.length === 0 ? <Empty>ما فيه تغييرات مسجّلة.</Empty>
        : (
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="rounded-xl p-3" style={{ background: C.surfaceAlt }}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <Badge color="teal">{KIND[r.change_kind] || r.change_kind}</Badge>
                  <span className="text-[10px]" style={{ color: C.textFaint }}>{fmtDateTime(r.created_at)}</span>
                </div>
                <div className="text-[11px]" style={{ color: C.textMuted }}>
                  {r.changed_by_name ? `بواسطة ${r.changed_by_name}` : "بواسطة النظام"}
                  {r.note ? ` — ${r.note}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
    </Modal>
  );
}

/* ------------------------------------------------------------
   النشر الجماعي — أخطر فعل في هذه اللوحة.

   لا يعمل بالافتراض: لا بد من تحديد نوع أو تأكيد «كل المحتوى»
   صراحةً. ولا يمسّ المرفوض سريرياً إطلاقاً.
   ------------------------------------------------------------ */
function BulkPublish({ open, onClose, onDone }) {
  const [scope, setScope] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!reason.trim()) { setErr("السبب مطلوب."); return; }
    setBusy(true); setErr("");
    try {
      const body = { reason: reason.trim() };
      if (scope) body.type = scope; else body.all = true;
      const r = await api.bulkPublish(body);
      onDone(r.published ?? 0);
    } catch (e) { setErr(e?.arabic || "تعذّر النشر."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="نشر جماعي">
      <div className="rounded-xl p-3 mb-3" style={{ background: C.amberSoft }}>
        <p className="text-xs leading-6" style={{ color: C.amber }}>
          يعتمد وينشر كل المحتوى في النطاق المحدد دفعة واحدة، ويصير ظاهراً للمستخدمين فوراً.
          <br />المحتوى <b>المرفوض سريرياً لا يُمَس</b> — يُراجَع كل عنصر منه على حدة.
        </p>
      </div>
      <div className="space-y-3">
        <Field label="النطاق">
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">كل المحتوى</option>
            {TYPES.filter(Boolean).map((t) => <option key={t} value={t}>{CONTENT_TYPE_LABEL[t]}</option>)}
          </Select>
        </Field>
        <Field label="السبب" hint="يُكتب في سجل النسخ لكل عنصر وفي سجل التدقيق.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorBar error={err} />
        <div className="flex gap-2">
          <Button onClick={submit} busy={busy}>تأكيد النشر</Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
        </div>
      </div>
    </Modal>
  );
}
