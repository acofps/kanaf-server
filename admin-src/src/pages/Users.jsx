import React, { useState } from "react";
import { Eye, Ban, RotateCcw, ShieldAlert, ScrollText, CreditCard } from "lucide-react";
import { api } from "../api.js";
import { C, atLeast, fmtDate, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Field, Input, Select, SearchBox, Spinner, Empty,
  ErrorBar, Modal, ReasonPrompt, Table, Td, Pager, useAsync,
} from "../ui.jsx";

/* ============================================================
   المستخدمون.

   الحد الفاصل في هذه الشاشة ليس ما يظهر، بل ما لا يظهر:
   نص اليومية، وإجابات المقاييس التفصيلية، ومحتوى الدفاتر
   وجلسات كنف — كلها **لا تصل إلى المتصفح أصلاً**، لأن إخفاءها
   في الواجهة يبقى كشفاً في الشبكة.

   وما يظهر منها (درجات المتابعة) يمر بمطالبة سبب تُكتب في سجل
   تدقيق غير قابل للتعديل **قبل** تنفيذ القراءة.
   ============================================================ */

const ACCOUNT_STATUS = {
  active: { label: "نشط", color: "green" },
  suspended: { label: "موقوف", color: "crisis" },
  pending_verification: { label: "بانتظار التفعيل", color: "amber" },
  deleted: { label: "محذوف", color: "textFaint" },
};

export default function Users({ role, toast }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [subscription, setSubscription] = useState("all");
  const [sort, setSort] = useState("created_at");
  const [dir, setDir] = useState("desc");
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [open, setOpen] = useState(null);

  const state = useAsync(
    () => api.listUsers({ search, status, subscription, sort, dir, page, pageSize }),
    [search, status, subscription, sort, dir, page]
  );

  const rows = state.data?.users || [];

  return (
    <div>
      <PageTitle title="المستخدمون" subtitle="البحث يقبل الاسم أو البريد أو معرّف المستخدم كاملاً." />

      <Card>
        <div className="grid gap-2 mb-4" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
          <SearchBox value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="اسم أو بريد أو معرّف…" />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="all">كل الحالات</option>
            {Object.entries(ACCOUNT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
          <Select value={subscription} onChange={(e) => { setSubscription(e.target.value); setPage(1); }}>
            <option value="all">الاشتراك: الكل</option>
            <option value="active">مشترك</option>
            <option value="none">غير مشترك</option>
          </Select>
          <Select value={`${sort}:${dir}`} onChange={(e) => {
            const [s, d] = e.target.value.split(":"); setSort(s); setDir(d); setPage(1);
          }}>
            <option value="created_at:desc">الأحدث تسجيلاً</option>
            <option value="created_at:asc">الأقدم تسجيلاً</option>
            <option value="last_login:desc">آخر دخول</option>
            <option value="name:asc">الاسم أ–ي</option>
            <option value="email:asc">البريد أ–ي</option>
          </Select>
        </div>

        <ErrorBar error={state.error} />
        {state.loading ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty>لا يوجد مستخدمون مطابقون.</Empty>
        ) : (
          <Table head={["الاسم", "البريد", "الحالة", "الاشتراك", "التسجيل", "آخر دخول", ""]}>
            {rows.map((u) => {
              const s = ACCOUNT_STATUS[u.account_status] || { label: u.account_status, color: "textMuted" };
              return (
                <tr key={u.id}>
                  <Td className="font-bold">{u.name || "—"}</Td>
                  <Td>{u.email}</Td>
                  <Td><Badge color={s.color}>{s.label}</Badge></Td>
                  <Td>
                    {u.subscription_status
                      ? <span style={{ color: C.textMuted }}>{u.subscription_plan || "—"} · {u.subscription_status}</span>
                      : <span style={{ color: C.textFaint }}>—</span>}
                  </Td>
                  <Td>{fmtDate(u.created_at)}</Td>
                  <Td>{u.last_login_at ? fmtDate(u.last_login_at) : "—"}</Td>
                  <Td>
                    <div className="flex justify-end">
                      <Button size="sm" variant="ghost" onClick={() => setOpen(u.id)}>
                        <Eye size={12} /> الملف
                      </Button>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}

        <Pager page={state.data?.page || 1} totalPages={state.data?.totalPages || 1}
          total={state.data?.total} onPage={setPage} />
      </Card>

      {open && (
        <UserDetail
          id={open} role={role} toast={toast}
          onClose={() => setOpen(null)}
          onChanged={() => state.reload()}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ */

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-xs" style={{ borderTop: `1px solid ${C.line}` }}>
      <span style={{ color: C.textMuted }}>{label}</span>
      <span className="text-left" style={{ color: C.text }}>{children ?? "—"}</span>
    </div>
  );
}

function UserDetail({ id, role, toast, onClose, onChanged }) {
  const state = useAsync(() => api.getUser(id), [id]);
  const [reason, setReason] = useState(null);
  const [tab, setTab] = useState("profile");   // profile | sensitive | actions | billing

  const u = state.data;
  const isAdmin = atLeast(role, "admin");

  const act = (kind) => {
    if (kind === "suspend") {
      setReason({
        title: "إيقاف الحساب",
        description: "يُنهي كل جلسات المستخدم فوراً. الوصول إلى محتوى الطوارئ يبقى متاحاً له.",
        confirmLabel: "إيقاف", danger: true,
        run: async (r) => { const res = await api.suspendUser(id, r); toast(`أُوقف الحساب · أُنهيت ${res.sessionsRevoked} جلسة`); state.reload(); onChanged(); },
      });
    } else {
      setReason({
        title: "إعادة تفعيل الحساب", confirmLabel: "إعادة التفعيل",
        run: async (r) => { await api.restoreUser(id, r); toast("أُعيد تفعيل الحساب."); state.reload(); onChanged(); },
      });
    }
  };

  return (
    <Modal open onClose={onClose} title={u ? (u.name || u.email) : "ملف المستخدم"} width={720}>
      {state.loading ? <div className="py-10 flex justify-center"><Spinner /></div> : state.error ? (
        <ErrorBar error={state.error} />
      ) : (
        <>
          <div className="flex gap-1.5 mb-4 flex-wrap">
            {[
              ["profile", "الملف", true],
              ["billing", "الاشتراك", isAdmin],
              ["sensitive", "المتابعة اليومية", isAdmin],
              ["actions", "سجل الإجراءات", isAdmin],
            ].filter(([, , show]) => show).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                className="px-3 py-1.5 rounded-xl text-xs font-bold"
                style={{
                  background: tab === k ? C.tealSoft : C.surfaceAlt,
                  color: tab === k ? C.teal : C.textMuted,
                }}>
                {label}
              </button>
            ))}
          </div>

          {tab === "profile" && (
            <div>
              <Row label="المعرّف"><code className="text-[10px]">{u.id}</code></Row>
              <Row label="البريد">{u.email}</Row>
              <Row label="الحالة">
                <Badge color={(ACCOUNT_STATUS[u.account_status] || {}).color}>
                  {(ACCOUNT_STATUS[u.account_status] || {}).label || u.account_status}
                </Badge>
              </Row>
              <Row label="الفئة العمرية">{u.age_range}</Row>
              <Row label="أكّد أنه بالغ">{u.confirmed_adult ? "نعم" : "لا"}</Row>
              <Row label="تفعيل البريد">{u.email_verified_at ? fmtDateTime(u.email_verified_at) : "غير مفعّل"}</Row>
              <Row label="التسجيل">{fmtDateTime(u.created_at)}</Row>
              <Row label="آخر دخول">{u.last_login_at ? fmtDateTime(u.last_login_at) : "—"}</Row>
              <Row label="محاولات دخول فاشلة">{u.failed_login_count ?? 0}</Row>
              {u.locked_until && <Row label="مقفل حتى">{fmtDateTime(u.locked_until)}</Row>}
              {u.suspended_at && <Row label="سبب الإيقاف">{u.suspended_reason || "—"}</Row>}

              {isAdmin && u.account_status !== "deleted" && (
                <div className="flex gap-2 mt-4">
                  {u.account_status === "suspended" ? (
                    <Button variant="good" onClick={() => act("restore")}><RotateCcw size={13} /> إعادة تفعيل</Button>
                  ) : (
                    <Button variant="danger" onClick={() => act("suspend")}><Ban size={13} /> إيقاف الحساب</Button>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === "billing" && <Billing user={u} toast={toast} onChanged={() => { state.reload(); onChanged(); }} />}
          {tab === "sensitive" && <Sensitive id={id} />}
          {tab === "actions" && <Actions id={id} />}
        </>
      )}

      <ReasonPrompt
        open={!!reason} title={reason?.title || ""} description={reason?.description}
        confirmLabel={reason?.confirmLabel} danger={reason?.danger}
        onConfirm={(r) => reason.run(r)} onClose={() => setReason(null)}
      />
    </Modal>
  );
}

/* ------------------------------------------------------------
   المتابعة اليومية.

   درجات فقط — مزاج ونوم وطاقة. نص اليومية (`note`) وإجابات
   المقاييس التفصيلية لا تُعرض هنا بحال. الطلب نفسه لا ينطلق قبل
   كتابة سبب، والسبب يُسجَّل قبل وصول البيانات.
   ------------------------------------------------------------ */
const SCALE = ["—", "منخفض جداً", "منخفض", "متوسط", "جيد", "مرتفع"];

function Sensitive({ id }) {
  const [data, setData] = useState(null);
  const [ask, setAsk] = useState(true);
  const [err, setErr] = useState("");

  if (data) {
    return (
      <div>
        <p className="text-[11px] leading-6 mb-3" style={{ color: C.textFaint }}>
          درجات فقط. نص اليومية وإجابات المقاييس التفصيلية لا تصل إلى هذه الشاشة —
          الوصول إليها يمر بطلب وصول طارئ يعتمده المالك.
        </p>

        <h4 className="text-xs font-bold mb-2" style={{ color: C.text }}>آخر 30 يوماً</h4>
        {data.logs?.length ? (
          <Table head={["التاريخ", "المزاج", "النوم", "الطاقة"]}>
            {data.logs.map((l, i) => (
              <tr key={i}>
                <Td>{fmtDate(l.logged_on)}</Td>
                <Td>{SCALE[l.mood] || l.mood || "—"}</Td>
                <Td>{SCALE[l.sleep] || l.sleep || "—"}</Td>
                <Td>{SCALE[l.energy] || l.energy || "—"}</Td>
              </tr>
            ))}
          </Table>
        ) : <Empty>لا توجد متابعة يومية.</Empty>}

        <h4 className="text-xs font-bold mt-5 mb-2" style={{ color: C.text }}>المقاييس</h4>
        {data.screenings?.length ? (
          <Table head={["المقياس", "الدرجة", "النطاق", "التاريخ"]}>
            {data.screenings.map((s, i) => (
              <tr key={i}>
                <Td>{s.kind}</Td>
                <Td>{s.total}</Td>
                <Td>{s.band_label}</Td>
                <Td>{fmtDate(s.created_at)}</Td>
              </tr>
            ))}
          </Table>
        ) : <Empty>لا توجد مقاييس.</Empty>}
      </div>
    );
  }

  return (
    <>
      <ErrorBar error={err} />
      <ReasonPrompt
        open={ask}
        title="عرض بيانات المتابعة"
        description="هذه بيانات صحية. سيُسجَّل اسمك وسببك ووقتك في سجل التدقيق قبل عرض أي شيء، ولا يمكن حذف السجل لاحقاً."
        confirmLabel="عرض"
        onConfirm={async (r) => {
          try { setData(await api.getUserSensitive(id, r)); }
          catch (e) { setErr(e?.arabic || "تعذّر الجلب."); throw e; }
        }}
        onClose={() => setAsk(false)}
      />
      {!ask && !data && (
        <div className="text-center py-6">
          <ShieldAlert size={20} color={C.textFaint} className="mx-auto mb-2" />
          <p className="text-xs mb-3" style={{ color: C.textFaint }}>لم تُعرض البيانات — لم يُسجَّل سبب.</p>
          <Button size="sm" variant="ghost" onClick={() => setAsk(true)}>اكتب سبباً واعرض</Button>
        </div>
      )}
    </>
  );
}

function Actions({ id }) {
  const state = useAsync(() => api.getUserActions(id), [id]);
  const rows = state.data?.actions || [];
  if (state.loading) return <div className="py-8 flex justify-center"><Spinner /></div>;
  if (state.error) return <ErrorBar error={state.error} />;
  if (!rows.length) return <Empty>لا إجراءات إدارية على هذا الحساب.</Empty>;
  return (
    <Table head={["الإجراء", "من", "إلى", "السبب", "التاريخ"]}>
      {rows.map((a) => (
        <tr key={a.id}>
          <Td className="font-bold">{a.action}</Td>
          <Td>{a.old_value || "—"}</Td>
          <Td>{a.new_value || "—"}</Td>
          <Td className="max-w-xs"><span style={{ color: C.textMuted }}>{a.reason || "—"}</span></Td>
          <Td>{fmtDateTime(a.created_at)}</Td>
        </tr>
      ))}
    </Table>
  );
}

/* ------------------------------------------------------------
   الاشتراك.

   الإلغاء لا يحرّك مالاً والاسترداد يحرّكه — ولذلك زران منفصلان
   بنصّين مختلفين، لا زر واحد بخيار.
   ------------------------------------------------------------ */
function Billing({ user, toast, onChanged }) {
  const [reason, setReason] = useState(null);
  const [atPeriodEnd, setAtPeriodEnd] = useState(false);
  const [amount, setAmount] = useState("");

  const has = !!user.subscription_status;

  return (
    <div>
      <Row label="الحالة">{user.subscription_status || "لا يوجد اشتراك"}</Row>
      <Row label="الباقة">{user.subscription_plan}</Row>
      <Row label="ينتهي / يتجدد">{user.subscription_renews_at ? fmtDateTime(user.subscription_renews_at) : "—"}</Row>

      {has && (
        <div className="mt-4 grid gap-3">
          <div className="rounded-xl p-3" style={{ background: C.surfaceAlt }}>
            <p className="text-xs font-bold mb-2" style={{ color: C.text }}>إلغاء الاشتراك</p>
            <p className="text-[11px] leading-6 mb-2" style={{ color: C.textFaint }}>
              لا يحرّك مالاً ولا يصدر إشعاراً دائناً.
            </p>
            <label className="flex items-center gap-2 text-xs mb-2" style={{ color: C.textMuted }}>
              <input type="checkbox" checked={atPeriodEnd} onChange={(e) => setAtPeriodEnd(e.target.checked)} />
              يبقى الوصول حتى نهاية المدة المدفوعة
            </label>
            <Button size="sm" variant="warn" onClick={() => setReason({
              title: "إلغاء الاشتراك", confirmLabel: "إلغاء الاشتراك",
              run: async (r) => {
                const res = await api.cancelSubscription(user.id, r, atPeriodEnd);
                toast(res.mode === "at_period_end" ? `يُلغى في ${fmtDate(res.accessUntil)}` : "أُلغي الاشتراك فوراً.");
                onChanged();
              },
            })}>
              <CreditCard size={12} /> إلغاء
            </Button>
          </div>

          <div className="rounded-xl p-3" style={{ background: C.surfaceAlt }}>
            <p className="text-xs font-bold mb-2" style={{ color: C.text }}>استرداد مبلغ</p>
            <p className="text-[11px] leading-6 mb-2" style={{ color: C.textFaint }}>
              يحرّك مالاً فعلاً ويصدر إشعاراً دائناً بترقيم رسمي. اتركه فارغاً لاسترداد كامل.
            </p>
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Input type="number" step="0.01" min="0" placeholder="المبلغ بالريال (اختياري)"
                  value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <Button size="sm" variant="danger" onClick={() => setReason({
                title: "استرداد مبلغ", danger: true, confirmLabel: "تنفيذ الاسترداد",
                description: "هذا إجراء مالي لا يُتراجع عنه، ويصدر إشعاراً دائناً بترقيم رسمي.",
                run: async (r) => {
                  const res = await api.refundSubscription(user.id, r, amount === "" ? undefined : Number(amount));
                  toast(`تم الاسترداد: ${res.amount} ر.س${res.creditNoteNumber ? ` · إشعار ${res.creditNoteNumber}` : ""}`);
                  onChanged();
                },
              })}>استرداد</Button>
            </div>
          </div>
        </div>
      )}

      <ReasonPrompt
        open={!!reason} title={reason?.title || ""} description={reason?.description}
        confirmLabel={reason?.confirmLabel} danger={reason?.danger}
        onConfirm={(r) => reason.run(r)} onClose={() => setReason(null)}
      />
    </div>
  );
}
