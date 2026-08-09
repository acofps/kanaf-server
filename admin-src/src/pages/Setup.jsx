import React, { useEffect, useState } from "react";
import { KeyRound, CheckCircle2 } from "lucide-react";
import { api } from "../api.js";
import { C } from "../theme.js";
import { Button, Field, Input, ErrorBar, Spinner } from "../ui.jsx";

/* ============================================================
   قبول الدعوة وضبط كلمة المرور.

   شاشة عامة بلا تسجيل دخول — بالضرورة: المدعوّ لا حساب يدخل به
   بعد، ومن نسي كلمة مروره لا يقدر يثبت هويته إلا بالرمز.

   تُفتح بـ/?setup=TOKEN، وهو الرابط الذي يصل في البريد.

   ------------------------------------------------------------
   ما تستبدله
   ------------------------------------------------------------
   كان إنشاء حساب الإدارة يطلب من المالك أن يكتب كلمة مرور الشخص
   الآخر ثم يوصلها له برسالة. الشاشة القديمة كانت تقول ذلك حرفياً:
   «لا تُعرض بعد الحفظ — سلّمها بقناة آمنة». وهي جملة تعترف بأن
   السرّ سيمرّ بقناة لا يملكها النظام.

   الآن الشخص نفسه يختار كلمة مروره، ولا يعرفها غيره — بما فيهم من
   دعاه. وتوقيعه في سجل التدقيق يصير يخصّه وحده.
   ============================================================ */

const MIN = 15;

export default function Setup({ token, onDone }) {
  const [state, setState] = useState({ loading: true, info: null, error: "" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    api.validateSetupToken(token)
      .then((info) => setState({ loading: false, info, error: "" }))
      .catch((e) => setState({ loading: false, info: null, error: e?.arabic || "الرابط غير صالح أو منتهي." }));
  }, [token]);

  /* الحد الأعلى بالبايتات لا بالأحرف: bcrypt يقصّ عند 72 بايتاً
     **بصمت**، والحرف العربي بايتان في UTF-8. فكلمة مرور عربية من
     أربعين حرفاً تتجاوزه، وكانت ستُقبل ويُهمل آخرها بلا إشعار.
     الخادم يفحصها أيضاً — وهذا الفحص هنا ليقول السبب قبل الرحلة. */
  const bytes = new TextEncoder().encode(password).length;

  const submit = async () => {
    if (password.length < MIN) { setErr(`كلمة المرور ${MIN} حرفاً على الأقل.`); return; }
    if (bytes > 72) { setErr("كلمة المرور طويلة جداً (الحد 72 بايتاً، والحرف العربي بايتان)."); return; }
    if (password !== confirm) { setErr("الكلمتان غير متطابقتين."); return; }
    setBusy(true); setErr("");
    try {
      await api.acceptSetup(token, password);
      setDone(true);
    } catch (e) {
      setErr(e?.arabic || "تعذّر الحفظ. قد يكون الرابط استُخدم أو انتهى.");
    } finally { setBusy(false); }
  };

  const Shell = ({ children }) => (
    <div dir="rtl" className="min-h-screen flex items-center justify-center p-4" style={{ background: C.bg }}>
      <div className="w-full rounded-2xl p-6" style={{ maxWidth: 420, background: C.surface, border: `1px solid ${C.line}` }}>
        {children}
      </div>
    </div>
  );

  if (state.loading) return <Shell><div className="py-10 flex justify-center"><Spinner /></div></Shell>;

  if (state.error) {
    return (
      <Shell>
        <h1 className="text-base font-bold mb-2" style={{ color: C.text }}>الرابط غير صالح</h1>
        <p className="text-xs leading-6 mb-4" style={{ color: C.textMuted }}>
          الرابط منتهي أو استُخدم من قبل. اطلب من المالك إعادة إرساله.
        </p>
        <Button variant="ghost" onClick={onDone}>الذهاب لتسجيل الدخول</Button>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle2 size={18} color={C.green} />
          <h1 className="text-base font-bold" style={{ color: C.text }}>تم</h1>
        </div>
        <p className="text-xs leading-6 mb-4" style={{ color: C.textMuted }}>
          كلمة المرور محفوظة. سجّل دخولك ببريدك وكلمة المرور الجديدة.
        </p>
        <Button onClick={onDone}>تسجيل الدخول</Button>
      </Shell>
    );
  }

  const isInvite = state.info?.purpose === "invite";

  return (
    <Shell>
      <div className="flex items-center gap-2 mb-1">
        <KeyRound size={16} color={C.teal} />
        <h1 className="text-base font-bold" style={{ color: C.text }}>
          {isInvite ? "تفعيل حسابك في لوحة كنف" : "إعادة ضبط كلمة المرور"}
        </h1>
      </div>
      <p className="text-xs leading-6 mb-4" style={{ color: C.textMuted }}>
        {state.info?.name} · {state.info?.email}
      </p>

      <div className="grid gap-3">
        <Field label="كلمة المرور الجديدة" hint={`${MIN} حرفاً على الأقل. اخترها أنت — لا أحد غيرك يعرفها، ولا تُعرض لمن دعاك.`}>
          <Input type="password" value={password} autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {password.length > 0 && (
          <p className="text-[11px]" style={{ color: password.length >= MIN && bytes <= 72 ? C.green : C.textFaint }}>
            {password.length} حرفاً · {bytes} بايت {bytes > 72 ? "— تجاوزت الحد" : ""}
          </p>
        )}
        <Field label="تأكيد كلمة المرور">
          <Input type="password" value={confirm} autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <ErrorBar error={err} />
        <Button onClick={submit} busy={busy}>حفظ وتفعيل</Button>
        <p className="text-[11px] leading-6" style={{ color: C.textFaint }}>
          الرابط صالح لمرة واحدة. بعد الحفظ يصير بلا مفعول.
        </p>
      </div>
    </Shell>
  );
}
