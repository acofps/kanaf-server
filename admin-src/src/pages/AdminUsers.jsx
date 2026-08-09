import React, { useState } from "react";
import { UserPlus, Pencil } from "lucide-react";
import { api } from "../api.js";
import { C, ROLE_LABEL, fmtDateTime } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Field, Input, Select, Spinner, Empty,
  ErrorBar, Modal, Table, Td, useAsync,
} from "../ui.jsx";

/* ============================================================
   حسابات الإدارة.

   الأدوار تصاعدية: دعم → مدير محتوى → مدير → مالك. وفرقها ليس
   شكلياً — «دعم» لا يصل إلى بيانات المتابعة إطلاقاً، والخادم هو
   من يمنعه، لا إخفاء زر في هذه الشاشة.

   والخادم يرفض تنزيل أو تعطيل آخر مالك نشط — قفل الباب على
   النفس ليس قراراً إدارياً يُتاح بضغطة.
   ============================================================ */

const ROLES = ["support", "content_manager", "admin", "owner"];

export default function AdminUsers({ me, toast }) {
  const state = useAsync(() => api.listAdminUsers(), []);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const rows = state.data?.adminUsers || [];

  return (
    <div>
      <PageTitle title="حسابات الإدارة" subtitle="الصلاحية تُطبَّق في الخادم لا بإخفاء الأزرار.">
        <Button size="sm" onClick={() => setCreating(true)}><UserPlus size={13} /> حساب جديد</Button>
      </PageTitle>

      <Card>
        <ErrorBar error={state.error} />
        {state.loading ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty>لا حسابات.</Empty>
        ) : (
          <Table head={["الاسم", "البريد", "الصلاحية", "الحالة", "الإنشاء", "آخر دخول", ""]}>
            {rows.map((a) => (
              <tr key={a.id}>
                <Td className="font-bold">
                  {a.name}
                  {a.id === me?.id && <span className="mr-2"><Badge color="teal">أنت</Badge></span>}
                </Td>
                <Td>{a.email}</Td>
                <Td><Badge color={a.role === "owner" ? "amber" : "textMuted"}>{ROLE_LABEL[a.role] || a.role}</Badge></Td>
                <Td><Badge color={a.active ? "green" : "crisis"}>{a.active ? "نشط" : "معطّل"}</Badge></Td>
                <Td>{fmtDateTime(a.created_at)}</Td>
                <Td>{a.last_login_at ? fmtDateTime(a.last_login_at) : "—"}</Td>
                <Td>
                  <div className="flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(a)}><Pencil size={12} /> تعديل</Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {creating && (
        <CreateAdmin onClose={() => setCreating(false)}
          onDone={() => { setCreating(false); state.reload(); toast("أُنشئ الحساب."); }} />
      )}
      {editing && (
        <EditAdmin admin={editing} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); state.reload(); toast("حُفظ التعديل."); }} />
      )}
    </div>
  );
}

function CreateAdmin({ onClose, onDone }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("support");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    if (password.length < 15) { setErr("كلمة المرور 15 حرفاً على الأقل."); return; }
    setBusy(true); setErr("");
    try { await api.createAdminUser({ name: name.trim(), email: email.trim(), password, role }); onDone(); }
    catch (e) { setErr(e?.arabic || "تعذّر الإنشاء."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title="حساب إدارة جديد">
      <div className="grid gap-3">
        <Field label="الاسم"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="البريد"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="كلمة المرور" hint="15 حرفاً على الأقل. لا تُعرض بعد الحفظ — سلّمها بقناة آمنة.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="الصلاحية" hint="ابدأ بأقل صلاحية تكفي العمل، ثم ارفعها عند الحاجة.">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </Select>
        </Field>
        <ErrorBar error={err} />
        <div className="flex gap-2">
          <Button onClick={save} busy={busy}>إنشاء</Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
        </div>
      </div>
    </Modal>
  );
}

function EditAdmin({ admin, onClose, onDone }) {
  const [role, setRole] = useState(admin.role);
  const [active, setActive] = useState(!!admin.active);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setBusy(true); setErr("");
    try { await api.updateAdminUser(admin.id, { role, active }); onDone(); }
    catch (e) { setErr(e?.arabic || "تعذّر الحفظ."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={`تعديل: ${admin.name}`}>
      <div className="grid gap-3">
        <Field label="الصلاحية">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-xs" style={{ color: C.textMuted }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          الحساب نشط
        </label>
        <p className="text-[11px] leading-6" style={{ color: C.textFaint }}>
          كلمة المرور لا تُعدَّل من هنا. ولا يمكن تنزيل أو تعطيل آخر مالك نشط.
        </p>
        <ErrorBar error={err} />
        <div className="flex gap-2">
          <Button onClick={save} busy={busy}>حفظ</Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>إلغاء</Button>
        </div>
      </div>
    </Modal>
  );
}
