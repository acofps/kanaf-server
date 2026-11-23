import React, { createContext, useContext, useEffect, useState } from "react";
import { Loader2, X, AlertTriangle, Search, ArrowRight, Check } from "lucide-react";
import { C } from "./theme.js";
import { Link } from "./router.js";
import { splitCode } from "./errors.js";

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
    primary: { background: C.teal, color: C.onAccent },
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
    : color === "amber" ? C.amberSoft : color === "teal" ? C.tealSoft : color === "gold" ? C.goldSoft : C.surfaceAlt);
  /* الذهبي لشارة الطبقة «تنفس+» وحدها، لا لشارة حالة (ORD-0005 §4.5-ج).
     على الفاتح: تعبئة gold-100 وحد gold-600 ونص داكن — الذهبي لا يُكتب
     نصاً صغيراً على الفاتح (§4.4)، والحد هو ما يفرّقه عن شارة التحذير. */
  const border = color === "gold" ? `1px solid ${C.goldLine}` : "1px solid transparent";
  return (
    <span className="text-[10px] font-bold px-2 py-1 rounded-full whitespace-nowrap"
      style={{ background: bg, color: C[color] || C.textMuted, border }}>
      {children}
    </span>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <div>
      <label className="block text-xs font-bold mb-1.5" style={{ color: C.textMuted }}>{label}</label>
      {children}
      {/* KANAF-ORD-0015 §2.4(أ): الحقل يقول تحت نفسه ما المطلوب قبل أي إرسال */}
      {error
        ? <p className="text-[11px] mt-1 leading-5 font-bold" style={{ color: C.crisis }} role="status">{error}</p>
        : hint && <p className="text-[11px] mt-1 leading-5" style={{ color: C.textFaint }}>{hint}</p>}
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
        {/* KANAF-ORD-0015 §2.4.3: الرمز بخط صغير — ليُنقل إلينا حين يقع ما لم يُتوقَّع */}
        <span className="text-xs leading-6" style={{ color: C.crisis }} role="alert">
          {splitCode(error).text}
          {splitCode(error).code && <small dir="ltr" className="ms-2 text-[10px] opacity-75" data-error-code>{splitCode(error).code}</small>}
        </span>
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
      style={{ background: C.overlay }} onClick={onClose}>
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
   شاشة — KANAF-ORD-0013 §3.2: ما كان نافذة منبثقة للمحتوى (ملف،
   تفاصيل، تحرير، إنشاء) صار صفحة بعنوانها. «رجوع» رابط حقيقي إلى
   الصفحة الأم، فيعمل معه زر الرجوع في المتصفّح والفتح في تبويب.
   تبقى Modal لصناديق التأكيد القصيرة وحدها (ConfirmPrompt وما شابه).
   ------------------------------------------------------------ */
export function Screen({ title, back, backLabel = "رجوع", children, actions }) {
  /* عنوان التبويب = عنوان الشاشة (KANAF-ORD-0014 §2.7) — يُحفظ في المفضّلة باسم ما فيه. */
  useEffect(() => { if (title) document.title = `${title} · لوحة تنفس بحرية`; }, [title]);
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          {back && (
            <Link to={back} className="inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs font-bold shrink-0"
              style={{ color: C.textMuted, background: C.surface, border: `1px solid ${C.line}` }}>
              <ArrowRight size={13} /> {backLabel}
            </Link>
          )}
          <h2 className="text-lg font-bold truncate" style={{ color: C.text }}>{title}</h2>
        </div>
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>
      <Card>{children}</Card>
    </div>
  );
}

/* ------------------------------------------------------------
   تأكيد بنقرة — ملحق KANAF-ORD-0013، قرار المالك 1.

   كانت هنا «مطالبة السبب» (ReasonPrompt): حقل سبب إلزامي قبل كل إجراء.
   أُلغيت بنصّ المالك: «ولا في أي مكان اكتب السبب». السبب يولّده الخادم
   من الإجراء وهدفه (admin/auto-reason.js)، والأثر الحقيقي باقٍ: من،
   ومتى، والقيمة قبل، والقيمة بعد، وعنوان IP.

   يبقى تأكيد بنقرة واحدة للأفعال التي كانت تمرّ بالمطالبة — لا كتابة
   فيه — حتى لا تُنفَّذ نقرةٌ خاطئة استرداداً أو حذفاً.
   ------------------------------------------------------------ */
export function ConfirmPrompt({ open, title, description, confirmLabel = "تأكيد", danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { if (open) { setErr(""); setBusy(false); } }, [open]);

  const submit = async () => {
    setBusy(true); setErr("");
    try { await onConfirm(); onClose(); }
    catch (e) { setErr(e?.arabic || "تعذّر التنفيذ."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={title}>
      {description && <p className="text-xs leading-6 mb-3" style={{ color: C.textMuted }}>{description}</p>}
      <ErrorBar error={err} />
      <div className="flex gap-2 mt-4">
        <Button onClick={submit} busy={busy} variant={danger ? "danger" : "primary"}>{confirmLabel}</Button>
        <Button onClick={onClose} variant="ghost" disabled={busy}>إلغاء</Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------
   زرّ اختيار (متعدّد أو مفرد) — KANAF-ORD-0015 §2.3

   كان المحدَّد في «أكواد الخصم» صبغة شفافة 10% على خلفية رمادية فاتحة: التحديد
   يعمل (الحمولة تحمل الباقة) ولا تراه العين. والقاعدة الآن لكل اختيار في اللوحة:
   المحدَّد تعبئة كاملة بلون العلامة ونصّ أبيض، وعلامة ✓، وحدّ متّصل أعرض، و
   aria-pressed يتغيّر — فالفرق في الشكل والعلامة لا في اللون وحده. والمعطَّل حدّ
   متقطّع وسبب مقروء.
   ------------------------------------------------------------ */
export function ToggleChip({ on, onClick, disabled = false, title = "", children, label }) {
  return (
    <button type="button" aria-pressed={on ? "true" : "false"} disabled={disabled} title={title} aria-label={label}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3.5 rounded-xl text-xs font-bold transition-colors"
      style={{
        minHeight: 40,
        background: disabled ? C.surfaceAlt : on ? C.teal : C.surface,
        color: disabled ? C.textFaint : on ? C.onAccent : C.text,
        border: disabled ? `1.5px dashed ${C.line}` : on ? `2px solid ${C.teal}` : `1.5px solid ${C.line}`,
        cursor: disabled ? "not-allowed" : "pointer",
        boxShadow: on && !disabled ? "0 1px 3px rgba(43,35,51,.18)" : "none",
      }}>
      <span aria-hidden="true" className="inline-flex items-center justify-center rounded-md"
        style={{ width: 16, height: 16, border: on ? "none" : `1.5px solid ${disabled ? C.line : C.textFaint}`, background: on ? "rgba(255,255,255,.22)" : "transparent" }}>
        {on && <Check size={12} strokeWidth={3} />}
      </span>
      {children}
    </button>
  );
}

/* ------------------------------------------------------------
   الجدول — مكوّن واحد لكل جداول اللوحة (KANAF-ORD-0015 §2.6).

   الترقيم من الخادم دائماً — لا نجلب كل شيء ونقسّمه في المتصفح.

   التصميم (KANAF-DESIGN-USERS-TABLE) هنا وحده لا في الصفحات: صندوق بحدّ وزوايا،
   رأس بخلفية هادئة وخط 12، صفوف بفاصل علوي تُضاء عند المرور، أرقام بعرض ثابت،
   وتمرير أفقي **داخل الصندوق** على الجوال فلا تتّسع الصفحة. والتعديل القادم تعديل
   واحد هنا، لا ثمانية عشر.

   ما يخصّ صفحة بعينها خيارٌ تطلبه الصفحة لا استثناء مكتوب هنا:
     caption   عنوان مقروء لقارئ الشاشة (مخفيّ بصرياً)
     minWidth  أدنى عرض قبل أن يمرّر الصندوق أفقياً (جدول عريض كالمستخدمين)
     select    { ids, selected, onChange, allLabel } — عمود تحديد بمربّعات و«تحديد الكل»؛
               والصفوف تكتب <Tr id label> فيُضاف مربّعها من السياق.
     align     محاذاة كل عمود في الرأس ("start" افتراضياً، "end" لعمود الإجراء)
   والواجهة القديمة { head, children } تعمل كما هي.
   ------------------------------------------------------------ */
const TableSelect = createContext(null);

export function Table({ head, children, caption, minWidth, select = null, align = [] }) {
  const ids = select?.ids || [];
  const chosen = new Set(select?.selected || []);
  const all = ids.length > 0 && ids.every((id) => chosen.has(id));
  const some = !all && ids.some((id) => chosen.has(id));
  const toggleAll = () => {
    const next = new Set(chosen);
    if (all) ids.forEach((id) => next.delete(id)); else ids.forEach((id) => next.add(id));
    select.onChange([...next]);
  };
  return (
    <div className="kt-box">
      <div className="kt-scroll" role={caption ? "region" : undefined} aria-label={caption} tabIndex={caption ? 0 : undefined}>
        <table className="kt" style={minWidth ? { minWidth } : undefined}>
          {caption && <caption className="kt-sr">{caption}</caption>}
          <thead>
            <tr>
              {select && (
                <th scope="col" className="kt-check">
                  <input type="checkbox" checked={all} aria-checked={some ? "mixed" : all ? "true" : "false"}
                    ref={(el) => { if (el) el.indeterminate = some; }}
                    aria-label={select.allLabel || "تحديد كل المعروض"} onChange={toggleAll} disabled={!ids.length} />
                </th>
              )}
              {head.map((h, i) => (
                <th key={i} scope="col" style={align[i] === "end" ? { textAlign: "left" } : undefined}>{h}</th>
              ))}
            </tr>
          </thead>
          <TableSelect.Provider value={select ? { chosen, onChange: select.onChange } : null}>
            <tbody>{children}</tbody>
          </TableSelect.Provider>
        </table>
      </div>
    </div>
  );
}

/** صفّ يعرف التحديد إن طلبته الصفحة. label: ما يُقرأ لمربّع الصف («تحديد سارة العتيبي»). */
export function Tr({ id, label, children, ...rest }) {
  const sel = useContext(TableSelect);
  const on = sel?.chosen.has(id);
  const toggle = () => {
    const next = new Set(sel.chosen);
    if (on) next.delete(id); else next.add(id);
    sel.onChange([...next]);
  };
  return (
    <tr {...rest} aria-selected={sel ? (on ? "true" : "false") : undefined} className={on ? "kt-on" : undefined}>
      {sel && <td className="kt-check"><input type="checkbox" checked={!!on} onChange={toggle} aria-label={label ? `تحديد ${label}` : "تحديد الصف"} /></td>}
      {children}
    </tr>
  );
}

export function Td({ children, className = "", dir, style }) {
  return (
    <td dir={dir} className={className} style={dir === "ltr" ? { textAlign: "right", ...style } : style}>
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


/* ------------------------------------------------------------
   فرق القيم قبل/بعد — مشترك بين «سجل الإجراءات» وتبويب «الإجراءات»
   في صفحة المستخدم. KANAF-ORD-0001 R15-22:
   • حقول الطوابع (updated_at وما شابه) تتغيّر في كل حفظ فتظهر «تغييراً»
     بلا معنى — تُخفى من العرض فقط وتبقى كاملة في التخزين والتصدير.
   • القيمة كائن أو نص أو null — كانت صفحة المستخدم تعرضها مباشرة
     كعنصر React فتنهار النافذة مع أول كائن.
   • التواريخ والأرقام باتجاه LTR داخل واجهة RTL.
   ------------------------------------------------------------ */
const DIFF_NOISE = new Set(["updated_at", "updatedAt", "updated_by", "created_at", "last_used_at"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function showValue(v) {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "string" && ISO_RE.test(v)) {
    try { return new Date(v).toLocaleString("ar-SA-u-ca-gregory-nu-latn", { dateStyle: "medium", timeStyle: "short" }); } catch { return v; }
  }
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
function asObject(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") { try { const p = JSON.parse(v); return p && typeof p === "object" ? p : { value: v }; } catch { return { value: v }; } }
  return typeof v === "object" ? v : { value: v };
}
export function ValueDiff({ oldValue, newValue }) {
  const a0 = asObject(oldValue), b0 = asObject(newValue);
  if (!a0 && !b0) return <span style={{ color: C.textFaint }}>—</span>;
  const keys = [...new Set([...Object.keys(a0 || {}), ...Object.keys(b0 || {})])].filter((k) => !DIFF_NOISE.has(k));
  if (!keys.length) return <span style={{ color: C.textFaint }}>—</span>;
  return (
    <div className="grid gap-1">
      {keys.map((k) => {
        const a = a0?.[k], b = b0?.[k];
        const changed = JSON.stringify(a) !== JSON.stringify(b);
        return (
          <div key={k} className="text-[11px] flex items-center gap-1.5 flex-wrap">
            <span style={{ color: C.textFaint }}>{k}:</span>
            {a0 && <span dir="ltr" style={{ color: changed ? C.crisis : C.textMuted, textDecoration: changed && b0 ? "line-through" : "none" }}>{showValue(a)}</span>}
            {changed && b0 && <span style={{ color: C.textFaint }}>←</span>}
            {b0 && changed && <span dir="ltr" className="font-bold" style={{ color: C.green }}>{showValue(b)}</span>}
          </div>
        );
      })}
    </div>
  );
}
