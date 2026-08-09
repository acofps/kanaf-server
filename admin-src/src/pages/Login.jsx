import React, { useState } from "react";
import { LogIn } from "lucide-react";
import { api } from "../api.js";
import { C } from "../theme.js";
import { Button, Field, Input, ErrorBar } from "../ui.jsx";

/* ============================================================
   الدخول.

   لا يُخزَّن أي رمز في المتصفح — الجلسة كوكي httpOnly يضبطه
   الخادم. ولهذا اللوحة تُخدَم من أصل الخادم نفسه: كوكي
   SameSite=Strict لا يُرسل عبر المواقع مهما ضُبط CORS.
   ============================================================ */

export default function Login({ onDone }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try { const r = await api.login(email.trim(), password); onDone(r.admin); }
    catch (ex) { setErr(ex?.arabic || "تعذّر الدخول."); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-5" style={{ background: C.bg }}>
      <form onSubmit={submit} className="w-full rounded-2xl p-6"
        style={{ maxWidth: 400, background: C.surface, border: `1px solid ${C.line}` }}>
        <h1 className="text-lg font-bold mb-1" style={{ color: C.text }}>لوحة كنف</h1>
        <p className="text-xs mb-5 leading-6" style={{ color: C.textMuted }}>
          كل إجراء حساس هنا يُسجَّل باسمك ووقتك.
        </p>

        <div className="grid gap-3">
          <Field label="البريد">
            <Input type="email" value={email} autoComplete="username"
              onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="كلمة المرور">
            <Input type="password" value={password} autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <ErrorBar error={err} />
          <Button type="submit" busy={busy}><LogIn size={14} /> دخول</Button>
        </div>
      </form>
    </div>
  );
}
