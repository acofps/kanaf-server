import React, { useEffect, useState } from "react";
import { Loader2, X, AlertTriangle, Search } from "lucide-react";
import { C } from "./theme.js";

/* ============================================================
   مكوّنات مشتركة — تُبنى مرة وتُستخدم في كل الشاشات، فلا يختلف
   شكل زر أو جدول بين صفحة وأخرى.
   ============================================================ */

export function Card({ children, className = "", style = {} }) {
  return (
    <div
      className={`rounded-2xl p-5 ${className}`}
      style={{ background: C.surface, border: `1px solid ${C.line}`, ...style }}
    >
      {children}
    </div>
  );
}

export function PageTitle({ title, subtitle, children }) {
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
      <div>
        <h2 className="text-lg font-bold" style={{ color: C.text }}>{title}</h2>
        {subtitle && <p className="text-xs mt-1 leading-6" style={{ color: C.textMuted }}>{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function Button({ children, onClick, variant = "primary", disabled, busy, size = "md", type = "button" }) {
  const styles = {
    primary: { background: C.teal, color: "#0B1418" },
    ghost: { background: C.surfaceAlt, color: C.textMuted },
    danger: { background: C.crisis, color: "#fff" },
    soft: { background: C.tealSoft, color: C.teal },
    good: { background: C.greenSoft, color: C.green },
    warn: { background: C.amberSoft, color: C.amber },
  }[variant];
  const pad = size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2.5 text-sm";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center gap-1.5 rounded-xl font-bold whitespace-nowrap ${pad}`}
      style={{ ...styles, opacity: disabled || busy ? 0.55 : 1 }}
    >
      {busy && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export function Badge({ children, color = "textMuted", soft }) {
  const bg = soft || (color === "green" ? C.greenSoft : color === "crisis" ? C.crisisSoft
    : color === "amber" ? C.amberSoft : color === "teal" ? C.tealSoft : C.surfaceAlt);
  return (
    <span className="text-[10px] font-bold px-2 py-1 rounded-full whitespace-nowrap"
      style={{ background: bg, color: C[color] || C.textMuted }}>
      {children}
    </span>
  );
}

export function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-xs font-bold mb-1.5" style={{ color: C.textMuted }}>{label}</label>
      {children}
      {hint && <p className="text-[11px] mt-1 leading-5" style={{ color: C.textFaint }}>{hint}</p>}
    </div>
  );
}

const inputStyle = { background: C.surfaceAlt, color: C.text, border: `1px solid ${C.line}` };

export function Input(props) {
  return <input {...props} className="w-full px-3 py-2.5 rounded-xl text-sm outline-none" style={inputStyle} />;
}

export function Textarea(props) {
  return <textarea {...props} className="w-full px-3 py-2.5 rounded-xl text-sm outline-none resize-none" style={inputStyle} />;
}

export function Select({ children, ...props }) {
  return (
    <select {...props} className="w-full px-3 py-2.5 rounded-xl text-sm outline-none" style={inputStyle}>
      {children}
    </select>
  );
}

export function SearchBox({ value, onChange, placeholder }) {
  return (
    <div className="relative">
      <Search size={14} color={C.textFaint} className="absolute top-1/2 -translate-y-1/2 right-3" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pr-9 pl-3 py-2.5 rounded-xl text-sm outline-none"
        style={inputStyle}
      />
    </div>
  );
}

export function Spinner() {
  return <Loader2 className="animate-spin" size={18} color={C.teal} />;
}

export function Empty({ children }) {
  return <p className="text-xs py-6 text-center" style={{ color: C.textFaint }}>{children}</p>;
}

export function ErrorBar({ error, onClose }) {
  if (!error) return null;
  return (
    <div className="rounded-xl px-3 py-2.5 mb-3 flex items-start justify-between gap-2"
      style={{ background: C.crisisSoft }}>
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} color={C.crisis} className="mt-0.5 shrink-0" />
        <span className="text-xs leading-6" style={{ color: C.crisis }}>{error}</span>
      </div>
      {onClose && <button onClick={onClose}><X size={14} color={C.crisis} /></button>}
    </div>
  );
}

/* ------------------------------------------------------------
   نافذة منبثقة. تُغلق بـEsc، ولا تُغلق بالضغط على المحتوى.
   ------------------------------------------------------------ */
export function Modal({ open, onClose, title, children, width = 560 }) {
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
      style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="rounded-2xl w-full my-8" style={{ background: C.surface, border: `1px solid ${C.line}`, maxWidth: width }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${C.line}` }}>
          <h3 className="text-sm font-bold" style={{ color: C.text }}>{title}</h3>
          <button onClick={onClose}><X size={16} color={C.textMuted} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   مطالبة السبب.

   كل مسار حساس في الخادم يشترط سبباً مكتوباً ويسجّله **قبل**
   تنفيذ القراءة. هذا المكوّن يجعل ذلك ظاهراً للمسؤول بدل أن يظهر
   له خطأ 400 غامض.
   ------------------------------------------------------------ */
export function ReasonPrompt({ open, title, description, confirmLabel = "تأكيد", danger, onConfirm, onClose }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { if (open) { setReason(""); setErr(""); setBusy(false); } }, [open]);

  const submit = async () => {
    if (!reason.trim()) { setErr("السبب مطلوب — يُسجَّل في سجل التدقيق."); return; }
    setBusy(true); setErr("");
    try { await onConfirm(reason.trim()); onClose(); }
    catch (e) { setErr(e?.arabic || "تعذّر التنفيذ."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={title}>
      {description && <p className="text-xs leading-6 mb-3" style={{ color: C.textMuted }}>{description}</p>}
      <Field label="السبب" hint="يُحفظ في سجل التدقيق باسمك ووقت التنفيذ، ولا يمكن تعديله لاحقاً.">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBar error={err} />
      <div className="flex gap-2 mt-4">
        <Button onClick={submit} busy={busy} variant={danger ? "danger" : "primary"}>{confirmLabel}</Button>
        <Button onClick={onClose} variant="ghost" disabled={busy}>إلغاء</Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------
   جدول بسيط. الترقيم من الخادم دائماً — لا نجلب كل شيء ونقسّمه
   في المتصفح.
   ------------------------------------------------------------ */
export function Table({ head, children }) {
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="w-full text-right border-collapse">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className="text-[11px] font-bold pb-2 px-2 whitespace-nowrap"
                style={{ color: C.textFaint, borderBottom: `1px solid ${C.line}` }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = "" }) {
  return (
    <td className={`text-xs py-3 px-2 align-middle ${className}`}
      style={{ color: C.text, borderBottom: `1px solid ${C.line}` }}>
      {children}
    </td>
  );
}

export function Pager({ page, totalPages, total, onPage }) {
  if (!totalPages || totalPages <= 1) {
    return <p className="text-[11px] mt-3" style={{ color: C.textFaint }}>{total ?? 0} سجل</p>;
  }
  return (
    <div className="flex items-center justify-between mt-4 gap-2">
      <span className="text-[11px]" style={{ color: C.textFaint }}>
        صفحة {page} من {totalPages} · {total} سجل
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>السابق</Button>
        <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>التالي</Button>
      </div>
    </div>
  );
}

/** جلب بيانات مع حالة تحميل وخطأ — يختصر تكراراً في كل شاشة. */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: "" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: "" }));
    fn()
      .then((data) => alive && setState({ loading: false, data, error: "" }))
      .catch((e) => alive && setState({ loading: false, data: null, error: e?.arabic || "تعذّر الجلب." }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}
