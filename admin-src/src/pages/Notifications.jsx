import React, { useEffect, useState } from "react";
import { Send, Ban, Eye, Plus, RefreshCw, Clock, AlertTriangle, CheckCircle2, XCircle, X } from "lucide-react";
import { api } from "../api.js";
import { can } from "../theme.js";
import {
  C, AUDIENCE_LABEL, CHANNEL_LABEL, CAMPAIGN_STATUS, DELIVERY_STATUS,
  fmtDateTime, toIsoWithOffset,
} from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Field, Input, Textarea, Select, SearchBox,
  Spinner, Empty, ErrorBar, Screen, ConfirmPrompt, Table, Td, useAsync, ToggleChip,
} from "../ui.jsx";
import { Link, navigate, useQueryState } from "../router.js";
import { UserLink } from "./Users.jsx";

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
const AUDIENCES = ["all", "active_subscribers", "trial_or_free", "account_status", "selected_users", "abandoned_carts", "inactive"];
/* KANAF-ORD-0008 §5: فئتان تسويقيتان دائماً — منع التسويق يسري عليهما في كل قناة. */
const MARKETING_ONLY = new Set(["abandoned_carts", "inactive"]);
const ACCOUNT_STATUSES = ["active", "suspended", "pending_verification"];

export default function Notifications({ me, toast, route = [] }) {
  /* KANAF-ORD-0013 §3.2: «حملة جديدة» و«تفاصيل الحملة» صفحتان بعنوانين */
  if (route[0] === "new") {
    return <Compose open back="/notifications" onClose={() => navigate("/notifications")}
      onDone={(msg) => { toast(msg); navigate("/notifications"); }} />;
  }
  if (route[0]) return <CampaignDetail id={route[0]} />;
  return <CampaignList me={me} toast={toast} />;
}

function CampaignList({ me, toast }) {
  const [status, setStatus] = useQueryState("status", "");
  const [channel, setChannel] = useQueryState("channel", "");
  const [search, setSearch] = useQueryState("q", "");
  const [offset, setOffset] = useQueryState("offset", 0);
  const limit = 25;

  const [pending, setPending] = useState(null);

  const list = useAsync(
    () => api.listCampaigns({ limit, offset, status, channel, search }),
    [limit, offset, status, channel, search]
  );
  const sched = useAsync(() => api.schedulerStatus(), []);

  const campaigns = list.data?.campaigns || [];
  const total = list.data?.total || 0;

  const reloadAll = () => { list.reload(); sched.reload(); };

  const doSend = (c, retry = false) =>
    setPending({
      title: retry ? `إعادة محاولة الفاشلة في «${c.title}»` : `إرسال «${c.title}»`,
      /* B-11: الخادم يعيد محاولة صفوف التسليم الفاشلة وحدها لنفس الجمهور الأصلي؛ الناجح لا يُعاد،
         ومن ألغى البريد التسويقي بعد الإرسال الأول يُتجاوز في البريد. */
      description: retry
        ? "تُعاد محاولة التسليمات الفاشلة فقط، لنفس المستلمين الأصليين — الرسائل الناجحة لا تُرسل مرة ثانية، ومن ألغى البريد التسويقي يُتجاوز. يُسجَّل باسمك في سجل التدقيق."
        : "الإرسال لا يمكن التراجع عنه. يُسجَّل باسمك في سجل التدقيق.",
      confirmLabel: retry ? "إعادة المحاولة" : "إرسال الآن",
      run: async () => {
        const res = await api.sendCampaign(c.id);
        /* skipped في الرد رقم (عدد المتجاوَزين) أو true (الحملة نفسها لم
           تُنفَّذ) — كان يُقرأ بولياناً فيظهر «تُخطّيت: undefined». و202 =
           الإرسال مستمر في الخلفية (KANAF-ORD-0001 R15-13). */
        toast(
          res?.accepted
            ? `بدأ الإرسال${res.recipients != null ? ` لـ ${res.recipients} مستلم` : ""} ويستمر في الخلفية — تابع حالته في القائمة.`
            : res?.skipped === true
            ? `لم تُنفَّذ: ${res.reason}`
            : `أُرسل ${res.sent ?? 0} · فشل ${res.failed ?? 0} · متجاوَز ${res.skipped ?? 0}`
        );
        reloadAll();
      },
    });

  const doCancel = (c) =>
    setPending({
      title: `إلغاء «${c.title}»`,
      description: "الإلغاء متاح للمسودات والمجدولة فقط، لا لحملة نُفّذت.",
      confirmLabel: "إلغاء الحملة",
      danger: true,
      run: async () => { await api.cancelCampaign(c.id); toast("أُلغيت الحملة."); reloadAll(); },
    });

  const [sweeping, setSweeping] = useState(false);
  const sweep = async () => {
    setSweeping(true);
    try {
      const res = await api.runSweep();
      toast(res?.skipped === true ? "المسح يعمل الآن في مكان آخر." : `نُفِّذت ${res.swept ?? 0} حملة مجدولة.`);
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
          <Link to="/notifications/new">
            <Button size="sm"><Plus size={13} /> حملة جديدة</Button>
          </Link>
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
              const retryable = (c.status === "failed" || c.status === "partially_failed") && can(me, "notifications:send");
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
                      <Link to={`/notifications/${c.id}`}>
                        <Button size="sm" variant="ghost"><Eye size={12} /> التفاصيل</Button>
                      </Link>
                      {retryable && (
                        <Button size="sm" variant="soft" onClick={() => doSend(c, true)}>
                          <RefreshCw size={12} /> إعادة محاولة الفاشلة
                        </Button>
                      )}
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


      <ConfirmPrompt
        open={!!pending}
        title={pending?.title || ""}
        description={pending?.description}
        confirmLabel={pending?.confirmLabel}
        danger={pending?.danger}
        onConfirm={() => pending.run()}
        onClose={() => setPending(null)}
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
/* ------------------------------------------------------------
   منتقي القنوات — KANAF-ORD-0013 §4.4 و§9.5. القنوات الخمس معروضة، والمعطّلة
   (بلا اعتمادها) معروضة معطّلة بسببها كما يعيده الخادم، لا مخفية ولا مقبولة.
   ------------------------------------------------------------ */
export const ALL_CHANNELS = ["in_app", "email", "push", "whatsapp", "sms"];
export function ChannelPicker({ value, onChange }) {
  const av = useAsync(() => api.channelAvailability(), []);
  const map = av.data?.channels || {};
  return (
    <div className="grid gap-2">
      <div className="flex gap-2 flex-wrap">
        {ALL_CHANNELS.map((ch) => {
          const st = map[ch]; const off = st && !st.ok; const on = value.includes(ch);
          return (
            <ToggleChip key={ch} on={on && !off} disabled={off} title={off ? st.reason : ""}
              onClick={() => onChange(on ? value.filter((x) => x !== ch) : [...value, ch])}>
              {CHANNEL_LABEL[ch] || ch}{off ? " — غير مفعّل" : ""}
            </ToggleChip>
          );
        })}
      </div>
      {ALL_CHANNELS.filter((ch) => map[ch] && !map[ch].ok).map((ch) => (
        <p key={ch} className="text-[11px]" style={{ color: C.textFaint }}>{CHANNEL_LABEL[ch] || ch}: {map[ch].reason}</p>
      ))}
    </div>
  );
}

export function Compose({ open, onClose, onDone, initialAudience = "all", back, title: screenTitle = "حملة إشعارات جديدة", fixedUserIds = null, fixedLabel = "", initialChannels = ["in_app"] }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState(initialAudience);
  const [inactiveDays, setInactiveDays] = useState(30);
  const [marketing, setMarketing] = useState(false);
  const [optedOut, setOptedOut] = useState(null);
  const isMarketing = marketing || MARKETING_ONLY.has(audience);
  const [accountStatus, setAccountStatus] = useState("active");
  const [userIds, setUserIds] = useState(fixedUserIds ? fixedUserIds.join(",") : "");
  const [channels, setChannels] = useState(initialChannels);
  const [when, setWhen] = useState("now");        // now | schedule | draft
  const [scheduledAt, setScheduledAt] = useState("");
  const [count, setCount] = useState(null);
  const [counting, setCounting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /* KANAF-ORD-0023 ب-4: نتيجة الإرسال تبقى ظاهرة فوق الزرّ حتى تُغلق. */
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setTitle(""); setBody(""); setAudience(fixedUserIds ? "selected_users" : initialAudience); setAccountStatus("active");
    setInactiveDays(30); setMarketing(false); setOptedOut(null);
    setUserIds(fixedUserIds ? fixedUserIds.join(",") : ""); setChannels(initialChannels); setWhen("now"); setScheduledAt("");
    setCount(null); setErr("");
  }, [open]);

  /* عدّ المستلمين — يُعاد الحساب كلما تغيّرت الفئة أو مرشِّحها. */
  useEffect(() => {
    if (!open) return;
    /* قائمة مجمَّدة (ملف عضو أو صفحة الاشتراكات): العدد هو طولها، ويتحقق منه الخادم عند الإرسال (expectedCount). */
    if (fixedUserIds) { setCount(fixedUserIds.length); return; }
    let alive = true;
    const params = { audience };
    if (audience === "account_status") params.status = accountStatus;
    if (audience === "selected_users") params.userIds = userIds.split(/[\s,]+/).filter(Boolean).join(",");
    if (audience === "selected_users" && !params.userIds) { setCount(null); return; }
    if (audience === "inactive") params.days = inactiveDays;
    if (isMarketing) params.marketing = "1";
    setCounting(true);
    api.audienceCount(params)
      .then((r) => { if (alive) { setCount(r.count); setOptedOut(r.optedOut ?? null); } })
      .catch(() => alive && setCount(null))
      .finally(() => alive && setCounting(false));
    return () => { alive = false; };
  }, [open, audience, accountStatus, userIds, inactiveDays, isMarketing]);


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
    if (audience === "inactive") payload.audienceFilter = { days: Number(inactiveDays) };
    if (isMarketing) payload.audienceFilter = { ...(payload.audienceFilter || {}), marketing: true };
    if (fixedUserIds) { payload.audience = "selected_users"; payload.audienceFilter = { ...(payload.audienceFilter || {}), userIds: fixedUserIds }; payload.expectedCount = fixedUserIds.length; }

    setBusy(true); setErr(""); setResult(null);
    /* KANAF-ORD-0023 ب-4 — السبب المقيس: كان التأكيد يظهر (بعد 150–165 مللي ثانية، داخل مجال النظر، 4.5 ثانية)
       لكنه شريط رمادي 12 بكسلاً بلون الحقول، بعيد عن الزرّ، نصّه «أُرسل 1 · فشل 0 · متجاوَز 0» لا يقول ما أُرسل
       ولا بأي قناة، والنموذج يبقى مملوءاً كما كان فلا يتغيّر شيء حيث ينظر المسؤول. الآن: لوحة نتيجة فوق الزرّ
       تذكر العنوان والمستلمين والقنوات، خضراء للنجاح وحمراء للفشل، تبقى حتى تُغلق، والنموذج يُفرَّغ بعد النجاح. */
    const chLabel = channels.map((c) => CHANNEL_LABEL[c] || c).join(" و");
    const what = `«${payload.title}»`;
    try {
      const res = await api.createCampaign(payload);
      const d = res.dispatch;
      const n = d?.recipients ?? d?.total ?? res.audienceCount ?? count;
      let r;
      if (d?.accepted) r = { tone: "ok", head: "بدأ الإرسال", text: `${what} إلى ${n} مستلم عبر ${chLabel} — يستمر في الخلفية، وحالته في «الإشعارات والتسويق».` };
      else if (d && d.skipped === true) r = { tone: "fail", head: "لم تُرسَل الرسالة", text: `${what}: ${d.reason || "لم تُنفَّذ"}.` };
      else if (d) {
        const sent = d.sent ?? 0, failed = d.failed ?? 0, skipped = d.skipped ?? 0;
        const tally = `أُرسل ${sent} · فشل ${failed} · متجاوَز ${skipped}`;
        r = sent > 0 && failed === 0 ? { tone: "ok", head: "أُرسلت الرسالة", text: `${what} إلى ${sent} من ${n} مستلم عبر ${chLabel}.${skipped ? ` (${tally})` : ""}` }
          : sent > 0 ? { tone: "warn", head: "أُرسلت جزئياً", text: `${what} عبر ${chLabel}: ${tally}. التفاصيل في «الإشعارات والتسويق».` }
          : { tone: "fail", head: "لم تُرسَل الرسالة", text: `${what} عبر ${chLabel}: ${tally}. السبب في تفاصيل الحملة في «الإشعارات والتسويق».` };
      } else r = { tone: "ok", head: when === "schedule" ? "جُدولت الرسالة" : "حُفظت مسودة", text: `${what} إلى ${n} مستلم عبر ${chLabel}.` };
      setResult(r);
      if (r.tone !== "fail") { setTitle(""); setBody(""); }
      onDone(`${r.head}: ${r.text}`);
      onClose();
    } catch (e) { setResult({ tone: "fail", head: "لم تُرسَل الرسالة", text: e?.arabic || "تعذّر الإنشاء." }); }
    finally { setBusy(false); }
  };

  return (
    <Screen title={screenTitle} back={back}>
      <div className="grid gap-3">
        <Field label="العنوان">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label="النص">
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>

        {fixedUserIds ? (
          <div className="rounded-xl px-3 py-2 text-xs" style={{ background: C.surfaceAlt, color: C.textMuted }}>
            المستلمون: {fixedLabel || `${fixedUserIds.length} مستلم`}
          </div>
        ) : (<>
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

        {audience === "inactive" && (
          <Field label="لم يدخل منذ (يوماً)" hint="من 7 إلى 365. آخر نشاط = أحدث دخول أو استعمال جلسة.">
            <Input type="number" min={7} max={365} value={inactiveDays} onChange={(e) => setInactiveDays(e.target.value)} dir="ltr" />
          </Field>
        )}

        {audience === "abandoned_carts" && (
          <p className="text-[12px] leading-6" style={{ color: C.textMuted }}>
            من له فاتورة لم تُدفع بعد 20 دقيقة من إنشائها، ولم يشترِ بعدها، وليس مشتركاً الآن.
          </p>
        )}

        <label className="flex items-start gap-2 text-[12px] leading-6" style={{ color: C.textMuted }}>
          <input type="checkbox" className="mt-1" checked={isMarketing} disabled={MARKETING_ONLY.has(audience)}
            onChange={(e) => setMarketing(e.target.checked)} />
          <span>
            <b style={{ color: C.text }}>رسالة تسويقية</b> — لا تصل في أي قناة إلى من أوقف الرسائل التسويقية، ويُسجَّل تسليمه «متجاوَز».
            رسائل الخدمة (تحقق، إيصال، تنبيه أمني) لا تُرسل من هنا.
          </span>
        </label>

        {audience === "selected_users" && (
          <Field label="معرّفات المستخدمين" hint="افصل بينها بفاصلة أو سطر جديد.">
            <Textarea rows={3} value={userIds} onChange={(e) => setUserIds(e.target.value)} />
          </Field>
        )}
        </>)}

        <Field label="القنوات" hint="«داخل التطبيق» يصل دائماً. البريد والإشعار قد يُتجاوزان لمن أوقفهما أو لم يشترك فيهما. والقناة المعطّلة لا تُقبل.">
          <ChannelPicker value={channels} onChange={setChannels} />
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
          {isMarketing && optedOut > 0 && !counting && (
            <span>· منهم {optedOut} أوقفوا التسويق فلن يصلهم، ويُسجَّلون «متجاوَز».</span>
          )}
        </div>

        <ErrorBar error={err} />
        {result && (
          <div role={result.tone === "fail" ? "alert" : "status"} data-send-result={result.tone}
            className="rounded-xl px-3 py-3 flex items-start justify-between gap-2"
            style={{
              background: result.tone === "ok" ? C.greenSoft : result.tone === "warn" ? C.amberSoft : C.crisisSoft,
              color: result.tone === "ok" ? C.green : result.tone === "warn" ? C.amber : C.crisis,
              border: `1px solid ${result.tone === "ok" ? C.green : result.tone === "warn" ? C.amber : C.crisis}`,
            }}>
            <div className="flex items-start gap-2 text-sm leading-6">
              {result.tone === "fail" ? <XCircle size={18} className="mt-0.5 shrink-0" /> : result.tone === "warn" ? <AlertTriangle size={18} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={18} className="mt-0.5 shrink-0" />}
              <span><b>{result.head}</b> — {result.text}</span>
            </div>
            <button type="button" onClick={() => setResult(null)} aria-label="إغلاق رسالة النتيجة"
              className="inline-flex items-center justify-center rounded-xl shrink-0" style={{ minWidth: 44, minHeight: 44 }}><X size={16} /></button>
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={submit} busy={busy} disabled={count === 0}>
            {when === "now" ? "إرسال الآن" : when === "schedule" ? "جدولة" : "حفظ مسودة"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
        </div>
      </div>
    </Screen>
  );
}

/* ------------------------------------------------------------
   تفاصيل التسليم.

   البريد مُقنَّع من الخادم لا من الواجهة — إخفاء في المتصفح يبقى
   كشفاً في الشبكة.
   ------------------------------------------------------------ */
function CampaignDetail({ id }) {
  const [fStatus, setFStatus] = useQueryState("status", "");
  const [fChannel, setFChannel] = useQueryState("channel", "");
  const [offset, setOffset] = useQueryState("offset", 0);
  const limit = 100;

  const head = useAsync(() => api.getCampaign(id), [id]);
  const state = useAsync(
    () => api.campaignDeliveries(id, { status: fStatus, channel: fChannel, limit, offset }),
    [id, fStatus, fChannel, offset]
  );
  const campaign = head.data?.campaign;
  if (head.loading) return <div className="py-10 flex justify-center"><Spinner /></div>;
  if (!campaign) return <Screen title="الحملة" back="/notifications"><ErrorBar error={head.error || "الحملة غير موجودة."} /></Screen>;
  const rows = state.data?.deliveries || [];
  const summary = state.data?.summary || [];

  return (
    <Screen title={`تفاصيل: ${campaign.title}`} back="/notifications" backLabel="الإشعارات والتسويق">
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
                  <div><UserLink id={r.user_id} name={r.user_name} /></div>
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
    </Screen>
  );
}
