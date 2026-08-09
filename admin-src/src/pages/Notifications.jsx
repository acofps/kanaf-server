import React, { useEffect, useState } from "react";
import { Send, Ban, Eye, Plus, RefreshCw, Clock, AlertTriangle } from "lucide-react";
import { api } from "../api.js";
import {
  C, AUDIENCE_LABEL, CHANNEL_LABEL, CAMPAIGN_STATUS, DELIVERY_STATUS,
  fmtDateTime, toIsoWithOffset,
} from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Field, Input, Textarea, Select, SearchBox,
  Spinner, Empty, ErrorBar, Modal, ReasonPrompt, Table, Td, useAsync,
} from "../ui.jsx";

/* ============================================================
   الإشعارات.

   الشاشة القديمة كانت "بث" واحداً: عنوان ونص وزر إرسال، ثم رقم
   "أُرسل: 120" بلا أي طريقة لمعرفة من وصله ومن لا.

   هنا نعرض ما حدث فعلاً لكل مستلم. وأهم قرار في الشاشة أن
   الحالات لا تُجمّل:
     • in_app  → "وصل"   (كتبناه في قاعدة بياناتنا، فوصل فعلاً)
     • email/push → "أُرسل" (قبله المزوّد، وقبوله ليس ظهوراً)
     • skipped ≠ failed — من أوقف رسائل التسويق ليس عطلاً.

   ولذلك "نجاح جزئي" كهرماني لا أخضر: من يقرأ "تم" لن يفتح
   التفاصيل ليكتشف أن ثلثهم لم يصله شيء.
   ============================================================ */

const CHANNELS = ["in_app", "email", "push"];
const AUDIENCES = ["all", "active_subscribers", "trial_or_free", "account_status", "selected_users"];
const ACCOUNT_STATUSES = ["active", "suspended", "pending_verification"];

export default function Notifications({ toast }) {
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 25;

  const [compose, setCompose] = useState(false);
  const [detail, setDetail] = useState(null);
  const [reason, setReason] = useState(null);

  const list = useAsync(
    () => api.listCampaigns({ limit, offset, status, channel, search }),
    [limit, offset, status, channel, search]
  );
  const sched = useAsync(() => api.schedulerStatus(), []);

  const campaigns = list.data?.campaigns || [];
  const total = list.data?.total || 0;

  const reloadAll = () => { list.reload(); sched.reload(); };

  const doSend = (c) =>
    setReason({
      title: `إرسال «${c.title}»`,
      description: "الإرسال لا يمكن التراجع عنه. يُسجَّل باسمك في سجل التدقيق.",
      confirmLabel: "إرسال الآن",
      run: async (r) => {
        const res = await api.sendCampaign(c.id, r);
        toast(
          res?.skipped
            ? `تُخطّيت: ${res.reason}`
            : `أُرسل ${res.sent ?? 0} · فشل ${res.failed ?? 0} · متجاوَز ${res.skipped ?? 0}`
        );
        reloadAll();
      },
    });

  const doCancel = (c) =>
    setReason({
      title: `إلغاء «${c.title}»`,
      description: "الإلغاء متاح للمسودات والمجدولة فقط، لا لحملة نُفّذت.",
      confirmLabel: "إلغاء الحملة",
      danger: true,
      run: async (r) => { await api.cancelCampaign(c.id, r); toast("أُلغيت الحملة."); reloadAll(); },
    });

  const [sweeping, setSweeping] = useState(false);
  const sweep = async () => {
    setSweeping(true);
    try {
      const res = await api.runSweep();
      toast(res?.skipped ? "المسح يعمل الآن في مكان آخر." : `نُفِّذت ${res.swept ?? 0} حملة مجدولة.`);
      reloadAll();
    } catch (e) { toast(e?.arabic || "تعذّر المسح."); }
    finally { setSweeping(false); }
  };

  return (
    <div>
      <PageTitle
        title="الإشعارات"
        subtitle="كل حملة تعرض ما حدث لكل مستلم فعلاً — لا رقم إجمالي بلا تفصيل."
      >
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={reloadAll}>
            <RefreshCw size={13} /> تحديث
          </Button>
          <Button size="sm" onClick={() => setCompose(true)}>
            <Plus size={13} /> حملة جديدة
          </Button>
        </div>
      </PageTitle>

      <SchedulerCard state={sched} onSweep={sweep} sweeping={sweeping} />

      <Card>
        <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
          <SearchBox value={search} onChange={(v) => { setSearch(v); setOffset(0); }} placeholder="بحث في العنوان أو النص…" />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
            <option value="">كل الحالات</option>
            {Object.entries(CAMPAIGN_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
          <Select value={channel} onChange={(e) => { setChannel(e.target.value); setOffset(0); }}>
            <option value="">كل القنوات</option>
            {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
          </Select>
        </div>

        <ErrorBar error={list.error} />
        {list.loading ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : campaigns.length === 0 ? (
          <Empty>لا توجد حملات مطابقة.</Empty>
        ) : (
          <Table head={["العنوان", "الفئة", "القنوات", "الحالة", "المستلمون", "أُرسل / فشل", "الوقت", ""]}>
            {campaigns.map((c) => {
              const st = CAMPAIGN_STATUS[c.status] || { label: c.status, color: "textMuted" };
              const cancellable = c.status === "draft" || c.status === "scheduled";
              return (
                <tr key={c.id}>
                  <Td>
                    <div className="font-bold">{c.title}</div>
                    <div className="text-[10px] mt-0.5" style={{ color: C.textFaint }}>
                      {c.created_by_name || "—"}
                    </div>
                  </Td>
                  <Td>{AUDIENCE_LABEL[c.audience] || c.audience}</Td>
                  <Td>
                    <div className="flex gap-1 flex-wrap">
                      {(c.channels || []).map((ch) => <Badge key={ch}>{CHANNEL_LABEL[ch] || ch}</Badge>)}
                    </div>
                  </Td>
                  <Td>
                    <Badge color={st.color}>{st.label}</Badge>
                    {c.last_error && (
                      <div className="text-[10px] mt-1" style={{ color: C.crisis }}>{c.last_error}</div>
                    )}
                  </Td>
                  <Td>{c.recipient_count ?? "—"}</Td>
                  <Td>
                    <span style={{ color: C.green }}>{c.sent_count ?? 0}</span>
                    {" / "}
                    <span style={{ color: (c.failed_count ?? 0) > 0 ? C.crisis : C.textFaint }}>
                      {c.failed_count ?? 0}
                    </span>
                  </Td>
                  <Td>
                    <div style={{ color: C.textMuted }}>
                      {c.scheduled_at ? `مجدولة: ${fmtDateTime(c.scheduled_at)}` : fmtDateTime(c.created_at)}
                    </div>
                    {c.finished_at && (
                      <div className="text-[10px]" style={{ color: C.textFaint }}>
                        انتهت: {fmtDateTime(c.finished_at)}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <div className="flex gap-1.5 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => setDetail(c)}>
                        <Eye size={12} /> التفاصيل
                      </Button>
                      {cancellable && (
                        <>
                          <Button size="sm" variant="soft" onClick={() => doSend(c)}>
                            <Send size={12} /> إرسال
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => doCancel(c)}>
                            <Ban size={12} /> إلغاء
                          </Button>
                        </>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}

        <div className="flex items-center justify-between mt-4 gap-2">
          <span className="text-[11px]" style={{ color: C.textFaint }}>
            {total} حملة · تعرض {campaigns.length}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={offset <= 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}>السابق</Button>
            <Button size="sm" variant="ghost" disabled={offset + limit >= total}
              onClick={() => setOffset(offset + limit)}>التالي</Button>
          </div>
        </div>
      </Card>

      <Compose
        open={compose}
        onClose={() => setCompose(false)}
        onDone={(msg) => { toast(msg); reloadAll(); }}
      />

      <DeliveriesModal campaign={detail} onClose={() => setDetail(null)} />

      <ReasonPrompt
        open={!!reason}
        title={reason?.title || ""}
        description={reason?.description}
        confirmLabel={reason?.confirmLabel}
        danger={reason?.danger}
        onConfirm={(r) => reason.run(r)}
        onClose={() => setReason(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------
   حالة الجدولة.

   لا يوجد Cron في هذا النظام عمداً — الحملات المجدولة تُنفَّذ بمسح
   يُستدعى مع حركة الطلبات. وهذا يعني أن التأخير ممكن، فنعرضه
   صراحة بدل أن نزعم أن الجدولة فورية.
   ------------------------------------------------------------ */
function SchedulerCard({ state, onSweep, sweeping }) {
  const d = state.data;
  const overdue = d?.overdue || 0;
  return (
    <Card className="mb-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Clock size={14} color={overdue > 0 ? C.amber : C.textMuted} />
            <h3 className="text-sm font-bold" style={{ color: C.text }}>الحملات المجدولة</h3>
            {overdue > 0 && <Badge color="amber">{overdue} متأخرة</Badge>}
          </div>
          <p className="text-[11px] mt-1.5 leading-6" style={{ color: C.textMuted }}>
            التنفيذ يتم بمسح دوري مع حركة الطلبات، لا بمُجدول مستقل. آخر مسح:{" "}
            {d?.lastSweepAt ? fmtDateTime(d.lastSweepAt) : "لم يُنفَّذ بعد"}
            {d?.minIntervalMs ? ` · الحد الأدنى بين مسحين: ${Math.round(d.minIntervalMs / 1000)} ثانية` : ""}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onSweep} busy={sweeping}>
          <RefreshCw size={13} /> نفّذ المسح الآن
        </Button>
      </div>

      {state.loading ? null : (d?.pending?.length ? (
        <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${C.line}` }}>
          {d.pending.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
              <span style={{ color: C.text }}>{p.title}</span>
              <span style={{ color: p.overdue_minutes > 0 ? C.amber : C.textFaint }}>
                {fmtDateTime(p.scheduled_at)}
                {p.overdue_minutes > 0 ? ` · متأخرة ${Math.round(p.overdue_minutes)} دقيقة` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null)}
      <ErrorBar error={state.error} />
    </Card>
  );
}

/* ------------------------------------------------------------
   إنشاء حملة.

   عدد المستلمين يُحسب من الخادم قبل الإرسال ويُعرض في الزر نفسه.
   السبب: "أرسل للكل" في نظام فيه 4000 مستخدم قرار مختلف تماماً
   عنه في نظام فيه 12.
   ------------------------------------------------------------ */
function Compose({ open, onClose, onDone }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState("all");
  const [accountStatus, setAccountStatus] = useState("active");
  const [userIds, setUserIds] = useState("");
  const [channels, setChannels] = useState(["in_app"]);
  const [when, setWhen] = useState("now");        // now | schedule | draft
  const [scheduledAt, setScheduledAt] = useState("");
  const [count, setCount] = useState(null);
  const [counting, setCounting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle(""); setBody(""); setAudience("all"); setAccountStatus("active");
    setUserIds(""); setChannels(["in_app"]); setWhen("now"); setScheduledAt("");
    setCount(null); setErr("");
  }, [open]);

  /* عدّ المستلمين — يُعاد الحساب كلما تغيّرت الفئة أو مرشِّحها. */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const params = { audience };
    if (audience === "account_status") params.status = accountStatus;
    if (audience === "selected_users") params.userIds = userIds.split(/[\s,]+/).filter(Boolean).join(",");
    if (audience === "selected_users" && !params.userIds) { setCount(null); return; }
    setCounting(true);
    api.audienceCount(params)
      .then((r) => alive && setCount(r.count))
      .catch(() => alive && setCount(null))
      .finally(() => alive && setCounting(false));
    return () => { alive = false; };
  }, [open, audience, accountStatus, userIds]);

  const toggleChannel = (ch) =>
    setChannels((cur) => (cur.includes(ch) ? cur.filter((x) => x !== ch) : [...cur, ch]));

  const submit = async () => {
    if (!title.trim() || !body.trim()) { setErr("العنوان والنص مطلوبان."); return; }
    if (channels.length === 0) { setErr("اختر قناة واحدة على الأقل."); return; }
    if (when === "schedule" && !scheduledAt) { setErr("حدّد وقت الجدولة."); return; }

    const payload = {
      title: title.trim(),
      body: body.trim(),
      audience,
      channels,
      sendNow: when === "now",
      scheduledAt: when === "schedule" ? toIsoWithOffset(scheduledAt) : null,
    };
    if (audience === "account_status") payload.audienceFilter = { status: accountStatus };
    if (audience === "selected_users") {
      payload.audienceFilter = { userIds: userIds.split(/[\s,]+/).filter(Boolean) };
    }

    setBusy(true); setErr("");
    try {
      const res = await api.createCampaign(payload);
      const d = res.dispatch;
      onDone(
        d && !d.skipped
          ? `أُرسل ${d.sent ?? 0} · فشل ${d.failed ?? 0} · متجاوَز ${d.skipped ?? 0}`
          : when === "schedule" ? "جُدولت الحملة." : "حُفظت كمسودة."
      );
      onClose();
    } catch (e) { setErr(e?.arabic || "تعذّر الإنشاء."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="حملة إشعارات جديدة" width={640}>
      <div className="grid gap-3">
        <Field label="العنوان">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label="النص">
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>

        <Field label="الفئة المستهدفة">
          <Select value={audience} onChange={(e) => setAudience(e.target.value)}>
            {AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
          </Select>
        </Field>

        {audience === "account_status" && (
          <Field label="حالة الحساب">
            <Select value={accountStatus} onChange={(e) => setAccountStatus(e.target.value)}>
              {ACCOUNT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
        )}

        {audience === "selected_users" && (
          <Field label="معرّفات المستخدمين" hint="افصل بينها بفاصلة أو سطر جديد.">
            <Textarea rows={3} value={userIds} onChange={(e) => setUserIds(e.target.value)} />
          </Field>
        )}

        <Field label="القنوات" hint="«داخل التطبيق» يصل دائماً. البريد والإشعار قد يُتجاوزان لمن أوقفهما أو لم يشترك فيهما.">
          <div className="flex gap-2 flex-wrap">
            {CHANNELS.map((ch) => (
              <button key={ch} type="button" onClick={() => toggleChannel(ch)}
                className="px-3 py-2 rounded-xl text-xs font-bold"
                style={{
                  background: channels.includes(ch) ? C.tealSoft : C.surfaceAlt,
                  color: channels.includes(ch) ? C.teal : C.textMuted,
                  border: `1px solid ${channels.includes(ch) ? C.teal : C.line}`,
                }}>
                {CHANNEL_LABEL[ch]}
              </button>
            ))}
          </div>
        </Field>

        <Field label="التوقيت">
          <Select value={when} onChange={(e) => setWhen(e.target.value)}>
            <option value="now">إرسال فوري</option>
            <option value="schedule">جدولة لوقت لاحق</option>
            <option value="draft">حفظ كمسودة</option>
          </Select>
        </Field>

        {when === "schedule" && (
          <Field label="وقت الإرسال" hint="التنفيذ يعتمد على المسح الدوري، فقد يتأخر دقائق عن الوقت المحدد.">
            <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </Field>
        )}

        <div className="rounded-xl px-3 py-2.5 text-xs flex items-center gap-2"
          style={{ background: C.surfaceAlt, color: C.textMuted }}>
          <AlertTriangle size={13} color={C.amber} />
          {counting ? "يُحسب عدد المستلمين…"
            : count === null ? "عدد المستلمين غير محدد بعد."
            : `سيصل هذا الإشعار إلى ${count} مستخدم.`}
        </div>

        <ErrorBar error={err} />
        <div className="flex gap-2">
          <Button onClick={submit} busy={busy} disabled={count === 0}>
            {when === "now" ? "إرسال الآن" : when === "schedule" ? "جدولة" : "حفظ مسودة"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------
   تفاصيل التسليم.

   البريد مُقنَّع من الخادم لا من الواجهة — إخفاء في المتصفح يبقى
   كشفاً في الشبكة.
   ------------------------------------------------------------ */
function DeliveriesModal({ campaign, onClose }) {
  const [fStatus, setFStatus] = useState("");
  const [fChannel, setFChannel] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 100;

  useEffect(() => { setFStatus(""); setFChannel(""); setOffset(0); }, [campaign?.id]);

  const state = useAsync(
    () => (campaign ? api.campaignDeliveries(campaign.id, { status: fStatus, channel: fChannel, limit, offset })
                    : Promise.resolve(null)),
    [campaign?.id, fStatus, fChannel, offset]
  );

  if (!campaign) return null;
  const rows = state.data?.deliveries || [];
  const summary = state.data?.summary || [];

  return (
    <Modal open onClose={onClose} title={`تفاصيل: ${campaign.title}`} width={860}>
      <p className="text-[11px] leading-6 mb-3" style={{ color: C.textFaint }}>
        {AUDIENCE_LABEL[campaign.audience] || campaign.audience} ·{" "}
        {(campaign.channels || []).map((ch) => CHANNEL_LABEL[ch] || ch).join(" · ")} ·{" "}
        {campaign.recipient_count ?? 0} مستلم
      </p>

      {summary.length > 0 && (
        <div className="flex gap-2 flex-wrap mb-4">
          {summary.map((s, i) => {
            const d = DELIVERY_STATUS[s.status] || { label: s.status, color: "textMuted" };
            return (
              <div key={i} className="rounded-xl px-3 py-2 text-xs"
                style={{ background: C.surfaceAlt, color: C.textMuted }}>
                {CHANNEL_LABEL[s.channel] || s.channel} ·{" "}
                <span style={{ color: C[d.color] || C.textMuted, fontWeight: 700 }}>{d.label}</span>{" "}
                <span style={{ color: C.text }}>{s.n}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="grid gap-2 mb-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Select value={fStatus} onChange={(e) => { setFStatus(e.target.value); setOffset(0); }}>
          <option value="">كل الحالات</option>
          {Object.entries(DELIVERY_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
        <Select value={fChannel} onChange={(e) => { setFChannel(e.target.value); setOffset(0); }}>
          <option value="">كل القنوات</option>
          {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
        </Select>
      </div>

      <ErrorBar error={state.error} />
      {state.loading ? (
        <div className="py-8 flex justify-center"><Spinner /></div>
      ) : rows.length === 0 ? (
        <Empty>لا توجد سجلات تسليم مطابقة.</Empty>
      ) : (
        <Table head={["المستخدم", "القناة", "الحالة", "المحاولات", "السبب", "آخر محاولة"]}>
          {rows.map((r) => {
            const d = DELIVERY_STATUS[r.status] || { label: r.status, color: "textMuted" };
            return (
              <tr key={r.id}>
                <Td>
                  <div>{r.user_name || "—"}</div>
                  <div className="text-[10px]" style={{ color: C.textFaint }}>{r.user_email_masked}</div>
                </Td>
                <Td>{CHANNEL_LABEL[r.channel] || r.channel}</Td>
                <Td><Badge color={d.color}>{d.label}</Badge></Td>
                <Td>{r.attempts ?? 0}</Td>
                <Td>
                  {r.error_code ? (
                    <div>
                      <div style={{ color: r.status === "skipped" ? C.textMuted : C.crisis }}>{r.error_code}</div>
                      {r.error_detail && (
                        <div className="text-[10px]" style={{ color: C.textFaint }}>{r.error_detail}</div>
                      )}
                    </div>
                  ) : "—"}
                </Td>
                <Td>{fmtDateTime(r.last_attempt_at)}</Td>
              </tr>
            );
          })}
        </Table>
      )}

      <div className="flex gap-2 justify-end mt-4">
        <Button size="sm" variant="ghost" disabled={offset <= 0}
          onClick={() => setOffset(Math.max(0, offset - limit))}>السابق</Button>
        <Button size="sm" variant="ghost" disabled={rows.length < limit}
          onClick={() => setOffset(offset + limit)}>التالي</Button>
      </div>
    </Modal>
  );
}
