import React, { useState } from "react";
import { UserPlus, Pencil, Send, KeyRound, Copy, Check } from "lucide-react";
import { api } from "../api.js";
import { C, ROLE_LABEL, ROLE_HINT, can, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Field, Input, Select, Textarea, Spinner, Empty,
  ErrorBar, Modal, Screen, Table, Td, useAsync,
} from "../ui.jsx";
import { Link, navigate } from "../router.js";

/* ============================================================
   حسابات الإدارة.

   ------------------------------------------------------------
   ما استُبدل، ولماذا
   ------------------------------------------------------------
   كانت الشاشة تطلب من المالك أن يكتب **كلمة مرور الشخص الآخر**،
   وتقول له حرفياً: «لا تُعرض بعد الحفظ — سلّمها بقناة آمنة». وهي
   جملة تعترف بأن السرّ سيمرّ بقناة لا يملكها النظام ولا يقدر
   يمحوها، وتجعل المالك يعرف كلمة مرور من تُوقَّع أفعاله باسمه في
   سجل التدقيق.

   الآن: دعوة برابط لمرة واحدة، والشخص نفسه يختار كلمة مروره.
   ولم تكن هناك استعادة كلمة مرور لمسؤول إطلاقاً — من ينساها كان
   يحتاج وصولاً مباشراً لقاعدة البيانات.

   ------------------------------------------------------------
   والأدوار خمسة لا أربعة
   ------------------------------------------------------------
   «محاسب» جديد: يقرأ الدفاتر كاملة، ولا يرى بيانات نفسية، ولا
   يحرّك مالاً. وهو ليس درجة على سلّم — لا هو فوق «مدير محتوى» ولا
   تحته، بل في مكان آخر. الأدوار تأتي من الخادم لا من قائمة هنا.

   ------------------------------------------------------------
   وكل فعل هنا يشترط سبباً
   ------------------------------------------------------------
   لأن هذه الشاشة تقرر **من يقدر على ماذا**. وترقية حساب إلى مالك
   كانت تمرّ بلا أثر واحد في سجل التدقيق قبل هذه المرحلة.
   ============================================================ */

const STATE_LABEL = {
  active: { label: "نشط", color: "green" },
  invited: { label: "دعوة معلّقة", color: "amber" },
  invite_expired: { label: "دعوة منتهية", color: "crisis" },
  deactivated: { label: "معطّل", color: "crisis" },
};

export default function AdminUsers({ me, toast, route = [] }) {
  const state = useAsync(() => api.listAdminUsers(), []);
  const [editing, setEditing] = useState(null);
  const [link, setLink] = useState(null);

  const rows = state.data?.adminUsers || [];
  const roles = state.data?.roles || Object.keys(ROLE_LABEL);
  const pages = state.data?.pages || [];
  const canInvite = can(me, "admins:invite");

  /* KANAF-ORD-0013 §3.2 و§5: الإضافة والدعوة والتعديل صفحات بعناوينها.
     ويبقى نافذةً: إعادة الإرسال/الضبط (سبب قبل إجراء حساس)، وعرض رابط لمرة واحدة
     (سرّ مؤقت لا يُوضع في عنوان ولا في سجل التصفّح). */
  if (route[0] === "new" && canInvite) {
    return <AddAdmin pages={pages} onClose={() => navigate("/admin-users")}
      onDone={(res) => { toast(`أُنشئ حساب ${res.adminUser.name} بدور ${ROLE_LABEL[res.adminUser.role] || res.adminUser.role}.`); navigate("/admin-users"); }} />;
  }
  if (route[0] === "invite" && canInvite) {
    return (
      <>
        <InviteAdmin roles={roles} onClose={() => navigate("/admin-users")}
          onDone={(res) => {
            setLink({ url: res.setupUrl, emailed: res.emailed, hours: res.expiresInHours, to: res.adminUser.email, after: "/admin-users" });
            toast(res.emailed ? "أُرسلت الدعوة." : "أُنشئ الحساب — تعذّر إرسال البريد.");
          }} />
        {link && <LinkModal {...link} onClose={() => { setLink(null); navigate("/admin-users"); }} />}
      </>
    );
  }
  if (route[0] && route[1] === "edit") {
    if (state.loading) return <div className="py-10 flex justify-center"><Spinner /></div>;
    const target = rows.find((a) => a.id === route[0]);
    if (!target) return <Screen title="حساب الإدارة" back="/admin-users"><ErrorBar error={state.error || "الحساب غير موجود."} /></Screen>;
    return <EditAdmin admin={target} roles={roles} pages={pages} isSelf={target.id === me?.id} canPages={can(me, "admins:change_role")}
      onClose={() => navigate("/admin-users")}
      onDone={() => { toast("حُفظ التعديل."); navigate("/admin-users"); }} />;
  }

  return (
    <div>
      <PageTitle
        title="حسابات الإدارة"
        subtitle="الصلاحية تُطبَّق في الخادم لا بإخفاء الأزرار. وكل تغيير هنا يُسجَّل بسبب مكتوب."
      >
        {canInvite && (
          <div className="flex gap-2">
            <Link to="/admin-users/new"><Button size="sm"><UserPlus size={13} /> إضافة</Button></Link>
            <Link to="/admin-users/invite"><Button size="sm" variant="ghost"><Send size={13} /> دعوة حساب</Button></Link>
          </div>
        )}
      </PageTitle>

      <Card>
        <ErrorBar error={state.error} />
        {state.loading ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty>لا حسابات.</Empty>
        ) : (
          <Table head={["الاسم", "البريد", "الصلاحية", "الحالة", "الإنشاء", "آخر دخول", ""]}>
            {rows.map((a) => {
              const st = STATE_LABEL[a.account_state] || STATE_LABEL.deactivated;
              return (
                <tr key={a.id}>
                  <Td className="font-bold">
                    {a.name}
                    {a.id === me?.id && <span className="mr-2"><Badge color="teal">أنت</Badge></span>}
                  </Td>
                  <Td>{a.email}</Td>
                  <Td>
                    <Badge color={a.role === "owner" ? "amber" : a.role === "accountant" ? "teal" : "textMuted"}>
                      {ROLE_LABEL[a.role] || a.role}
                    </Badge>
                  </Td>
                  <Td><Badge color={st.color}>{st.label}</Badge></Td>
                  <Td>{fmtDateTime(a.created_at)}</Td>
                  <Td>{a.last_login_at ? fmtDateTime(a.last_login_at) : "—"}</Td>
                  <Td>
                    <div className="flex justify-end gap-1.5">
                      {canInvite && a.account_state !== "active" && (
                        <Button size="sm" variant="ghost"
                          onClick={() => setEditing({ ...a, mode: "resend" })}><Send size={12} /></Button>
                      )}
                      {canInvite && a.account_state === "active" && (
                        <Button size="sm" variant="ghost"
                          onClick={() => setEditing({ ...a, mode: "reset" })}><KeyRound size={12} /></Button>
                      )}
                      {can(me, "admins:change_role") && (
                        <Link to={`/admin-users/${a.id}/edit`}><Button size="sm" variant="ghost"><Pencil size={12} /> تعديل</Button></Link>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>


      {(editing?.mode === "resend" || editing?.mode === "reset") && (
        <CredentialLink admin={editing} mode={editing.mode}
          onClose={() => setEditing(null)}
          onDone={(res) => {
            setEditing(null);
            setLink({ url: res.setupUrl, emailed: res.emailed, hours: res.expiresInHours, to: editing.email });
            toast(res.emailed ? "أُرسل الرابط." : "أُنشئ الرابط — تعذّر إرسال البريد.");
          }} />
      )}

      {link && <LinkModal {...link} onClose={() => setLink(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------
   عرض الرابط.

   يُعرض للمالك مرة واحدة، ولا يُخزَّن في أي سجل. والفرق بينه وبين
   ما كان: هذا رابط لمرة واحدة ينتهي خلال ساعات، لا كلمة مرور
   دائمة يعرفها اثنان.
   ------------------------------------------------------------ */
function LinkModal({ url, emailed, hours, to, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* بعض المتصفّحات تمنع النسخ بلا تفاعل مباشر — النص ظاهر للتحديد اليدوي */ }
  };
  return (
    <Modal open onClose={onClose} title={emailed ? "أُرسلت الدعوة" : "الرابط جاهز — البريد لم يُرسَل"}>
      {emailed ? (
        <p className="text-xs leading-6 mb-3" style={{ color: C.textMuted }}>
          وصل الرابط إلى <strong style={{ color: C.text }}>{to}</strong>، وهو صالح {hours} ساعة ولمرة واحدة.
        </p>
      ) : (
        <p className="text-xs leading-6 mb-3 rounded-xl px-3 py-2" style={{ background: C.amberSoft, color: C.amber }}>
          ⚠️ تعذّر إرسال البريد. الحساب أُنشئ والرابط صالح — سلّمه بنفسك لصاحبه.
        </p>
      )}

      <div className="rounded-xl p-3 text-[11px] break-all select-all"
        style={{ background: C.surfaceAlt, color: C.textMuted, border: `1px solid ${C.line}` }}>
        {url}
      </div>

      <div className="flex gap-2 mt-4">
        <Button onClick={copy} variant={copied ? "good" : "primary"}>
          {copied ? <><Check size={13} /> نُسخ</> : <><Copy size={13} /> نسخ الرابط</>}
        </Button>
        <Button variant="ghost" onClick={onClose}>إغلاق</Button>
      </div>

      <p className="text-[11px] leading-6 mt-3" style={{ color: C.textFaint }}>
        لن يُعرض هذا الرابط مرة أخرى. لو ضاع، أرسل دعوة جديدة — والقديم يُلغى تلقائياً.
      </p>
    </Modal>
  );
}

function InviteAdmin({ roles, onClose, onDone }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("support");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    if (!name.trim() || !email.trim()) { setErr("الاسم والبريد مطلوبان."); return; }
    if (!reason.trim()) { setErr("السبب مطلوب — يُسجَّل في سجل التدقيق."); return; }
    setBusy(true); setErr("");
    try { onDone(await api.inviteAdminUser({ name: name.trim(), email: email.trim(), role, reason: reason.trim() })); }
    catch (e) { setErr(e?.arabic || "تعذّرت الدعوة."); }
    finally { setBusy(false); }
  };

  return (
    <Screen title="دعوة حساب إدارة" back="/admin-users" backLabel="حسابات الإدارة">
      <div className="grid gap-3">
        <Field label="الاسم"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="البريد" hint="يصله رابط لمرة واحدة يختار به كلمة مروره بنفسه.">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="الصلاحية" hint={ROLE_HINT[role]}>
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}
          </Select>
        </Field>
        <Field label="السبب" hint="لماذا يُنشأ هذا الحساب؟ يُحفظ في سجل التدقيق.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <p className="text-[11px] leading-6" style={{ color: C.textFaint }}>
          الحساب لا يعمل قبل أن يفتح صاحبه الرابط ويختار كلمة مروره. ولا أحد غيره يعرفها — ولا أنت.
        </p>
        <ErrorBar error={err} onClose={() => setErr("")} />
        <div className="flex gap-2">
          <Button onClick={save} busy={busy}>إرسال الدعوة</Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
        </div>
      </div>
    </Screen>
  );
}

function EditAdmin({ admin, roles, pages, isSelf, canPages, onClose, onDone }) {
  const [role, setRole] = useState(admin.role);
  const [active, setActive] = useState(!!admin.active);
  const [grants, setGrants] = useState(Array.isArray(admin.page_grants) ? admin.page_grants : null);
  const [phone, setPhone] = useState(admin.phone || "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    if (!reason.trim()) { setErr("السبب مطلوب."); return; }
    const patch = { reason: reason.trim() };
    if (role !== admin.role) patch.role = role;
    if (active !== !!admin.active) patch.active = active;
    const grantsChanged = JSON.stringify(grants) !== JSON.stringify(Array.isArray(admin.page_grants) ? admin.page_grants : null);
    const phoneChanged = (phone || "") !== (admin.phone || "");
    if (patch.role === undefined && patch.active === undefined && !grantsChanged && !phoneChanged) { setErr("لا تغيير."); return; }
    setBusy(true); setErr("");
    try {
      if (patch.role !== undefined || patch.active !== undefined) await api.updateAdminUser(admin.id, patch);
      if (grantsChanged || phoneChanged) {
        await api.updateAdminPages(admin.id, { ...(grantsChanged ? { pages: grants } : {}), ...(phoneChanged ? { phone: phone || null } : {}), reason: reason.trim() });
      }
      onDone();
    }
    catch (e) { setErr(e?.arabic || "تعذّر الحفظ."); }
    finally { setBusy(false); }
  };

  return (
    <Screen title={`تعديل: ${admin.name}`} back="/admin-users" backLabel="حسابات الإدارة">
      <div className="grid gap-3">
        {isSelf && (
          <p className="text-[11px] leading-6 rounded-xl px-3 py-2" style={{ background: C.amberSoft, color: C.amber }}>
            ⚠️ لا تقدر تغيّر دورك ولا تعطّل نفسك. مسؤول يخفض دوره بالخطأ يقفل نفسه خارج الصلاحية
            التي يحتاجها ليعيدها.
          </p>
        )}
        <Field label="الصلاحية" hint={ROLE_HINT[role]}>
          <Select value={role} disabled={isSelf} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-xs" style={{ color: C.textMuted }}>
          <input type="checkbox" checked={active} disabled={isSelf} onChange={(e) => setActive(e.target.checked)} />
          الحساب نشط
        </label>
        <p className="text-[11px] leading-6" style={{ color: C.textFaint }}>
          التعطيل يسري في الطلب التالي مباشرة — الدور والحالة يُقرآن من قاعدة البيانات في كل طلب إداري،
          لا من رمز الجلسة. ولا يمكن تنزيل أو تعطيل آخر مالك نشط.
        </p>
        {canPages && (
          <>
            <Field label="الجوال" hint="بصيغة دولية: +9665…"><Input value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" /></Field>
            <PageGrants pages={pages} value={grants} onChange={setGrants} disabled={isSelf} />
          </>
        )}
        <Field label="السبب"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBar error={err} onClose={() => setErr("")} />
        <div className="flex gap-2">
          <Button onClick={save} busy={busy}>حفظ</Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
        </div>
      </div>
    </Screen>
  );
}

function CredentialLink({ admin, mode, onClose, onDone }) {
  const isResend = mode === "resend";
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const go = async () => {
    if (!isResend && !reason.trim()) { setErr("السبب مطلوب."); return; }
    setBusy(true); setErr("");
    try {
      onDone(isResend
        ? await api.resendInvite(admin.id, reason.trim() || "إعادة إرسال دعوة")
        : await api.resetAdminPassword(admin.id, reason.trim()));
    } catch (e) { setErr(e?.arabic || "تعذّر التنفيذ."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={isResend ? `إعادة إرسال الدعوة: ${admin.name}` : `إعادة ضبط كلمة المرور: ${admin.name}`}>
      <p className="text-xs leading-6 mb-3" style={{ color: C.textMuted }}>
        {isResend
          ? "يُنشأ رابط جديد ويُلغى القديم. الحساب يبقى معطّلاً حتى يفتحه صاحبه."
          : "يُرسَل رابط لمرة واحدة يختار به صاحب الحساب كلمة مرور جديدة. كلمته الحالية تبقى تعمل حتى يستعمله."}
      </p>
      <Field label="السبب" hint="يُحفظ في سجل التدقيق."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <ErrorBar error={err} onClose={() => setErr("")} />
      <div className="flex gap-2 mt-4">
        <Button onClick={go} busy={busy}>{isResend ? "إعادة الإرسال" : "إرسال رابط الاستعادة"}</Button>
        <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
      </div>
    </Modal>
  );
}


/* ============================================================
   منح الصفحات — KANAF-ORD-0013 §5.2: تضييق فوق الدور، لا توسيع.
   null = بلا تضييق (كل ما يسمح به الدور). والخادم هو الحكم: التأشير على
   صفحة لا يملك الدور صلاحيتها لا يفتحها.
   ============================================================ */
function PageGrants({ pages, value, onChange, disabled }) {
  const all = value === null;
  const toggle = (k) => {
    const cur = value || [];
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    onChange(next.length ? next : []);
  };
  return (
    <Field label="الصفحات الممنوحة" hint="تضييق فوق الدور: الموظف يرى ما يسمح به دوره ومؤشَّر له معاً. التأشير لا يمنح صلاحية لا يملكها الدور.">
      <label className="flex items-center gap-2 text-xs mb-2" style={{ color: C.textMuted }}>
        <input type="checkbox" checked={all} disabled={disabled} onChange={(e) => onChange(e.target.checked ? null : [])} />
        كل ما يسمح به الدور (بلا تضييق)
      </label>
      {!all && (
        <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
          {pages.map((p) => (
            <label key={p.key} className="flex items-center gap-2 text-xs" style={{ color: C.text }}>
              <input type="checkbox" disabled={disabled} checked={(value || []).includes(p.key)} onChange={() => toggle(p.key)} /> {p.label}
            </label>
          ))}
        </div>
      )}
    </Field>
  );
}

/* الإضافة المباشرة — KANAF-ORD-0013 §5. «المهام» دوران قائمان: إدارية → مدير، مالية → محاسب. */
function AddAdmin({ pages, onClose, onDone }) {
  const [f, setF] = useState({ name: "", email: "", phone: "", password: "", reason: "" });
  const [duties, setDuties] = useState(["finance"]);
  const [grants, setGrants] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const toggleDuty = (d) => setDuties((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  const save = async () => {
    if (!f.name.trim() || !f.email.trim()) { setErr("اسم المستخدم والبريد مطلوبان."); return; }
    if (!duties.length) { setErr("اختر مهمة واحدة على الأقل."); return; }
    if (grants !== null && !grants.length) { setErr("أشّر على صفحة واحدة على الأقل، أو اختر «كل ما يسمح به الدور»."); return; }
    if (!f.reason.trim()) { setErr("السبب مطلوب — يُسجَّل في سجل التدقيق."); return; }
    setBusy(true); setErr("");
    try {
      onDone(await api.createAdminDirect({ name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim() || null,
        password: f.password, duties, pages: grants, reason: f.reason.trim() }));
    } catch (e) { setErr(e?.arabic || "تعذّر الإنشاء."); }
    finally { setBusy(false); }
  };
  return (
    <Screen title="إضافة حساب موظف" back="/admin-users" backLabel="حسابات الإدارة">
      <div className="grid gap-3" style={{ maxWidth: 640 }}>
        <Field label="اسم المستخدم"><Input value={f.name} onChange={set("name")} /></Field>
        <Field label="البريد الإلكتروني"><Input type="email" value={f.email} onChange={set("email")} dir="ltr" /></Field>
        <Field label="رقم الجوال" hint="بصيغة دولية: +9665…"><Input value={f.phone} onChange={set("phone")} dir="ltr" /></Field>
        <Field label="الرقم السري" hint="خمسة عشر حرفاً على الأقل. لا يُعرض بعد الحفظ ولا يُسجَّل."><Input type="password" autoComplete="new-password" value={f.password} onChange={set("password")} dir="ltr" /></Field>
        <Field label="المهام" hint="مهام إدارية = دور «مدير». مهام مالية = دور «محاسب»: يقرأ الدفاتر ولا يحرّك مالاً (لا استرداد ولا تعديل فاتورة). الاثنتان معاً = «مدير».">
          <div className="flex gap-4 text-xs">
            <label className="flex items-center gap-2"><input type="checkbox" checked={duties.includes("admin")} onChange={() => toggleDuty("admin")} /> مهام إدارية</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={duties.includes("finance")} onChange={() => toggleDuty("finance")} /> مهام مالية</label>
          </div>
        </Field>
        <PageGrants pages={pages} value={grants} onChange={setGrants} />
        <Field label="السبب"><Textarea rows={2} value={f.reason} onChange={set("reason")} /></Field>
        <ErrorBar error={err} onClose={() => setErr("")} />
        <div className="flex gap-2">
          <Button onClick={save} busy={busy}>إنشاء الحساب</Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
        </div>
      </div>
    </Screen>
  );
}
