import React from "react";
import { Users, CreditCard, Mail, LifeBuoy } from "lucide-react";
import { api } from "../api.js";
import { C, can } from "../theme.js";
import { Card, PageTitle, Spinner, ErrorBar, Empty, useAsync } from "../ui.jsx";

/* ============================================================
   نظرة عامة.

   الأرقام هنا محسوبة في الخادم، لا مجموعة في المتصفح. وإشارات
   الأزمة تُعرض **مجمّعة حسب المصدر فقط** — بلا هوية ولا نص. عدّ
   الحوادث معلومة تشغيلية، ومَن مرّ بها ليست معلومة إدارية.
   ============================================================ */

const SOURCE_LABEL = {
  chat: "محادثة",
  screening: "مقياس",
  daily_log: "تدوين يومي",
  manual: "زر الأزمة",
  notebook: "دفتر",
  cbt: "أداة كنف",
};

function Stat({ icon: Icon, label, value, hint, color = "teal" }) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="rounded-xl p-2.5 shrink-0" style={{ background: C[`${color}Soft`] || C.surfaceAlt }}>
          <Icon size={16} color={C[color] || C.textMuted} />
        </div>
        <div>
          <p className="text-[11px]" style={{ color: C.textMuted }}>{label}</p>
          <p className="text-xl font-bold mt-0.5" style={{ color: C.text }}>{value}</p>
          {hint && <p className="text-[10px] mt-1" style={{ color: C.textFaint }}>{hint}</p>}
        </div>
      </div>
    </Card>
  );
}

const sar = (n) => `${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} ر.س`;

export default function Overview({ me }) {
  const state = useAsync(() => api.overview(), []);
  const d = state.data;

  if (state.loading) return <div className="py-16 flex justify-center"><Spinner /></div>;
  if (state.error) return <ErrorBar error={state.error} />;

  /* ⚠️ الكتلة المالية قد لا تصل أصلاً.

     الخادم **لا يشغّل استعلامها** لمن لا يملك overview:view_revenue —
     لا يخفيها في الواجهة. فغيابها هنا ليس نقصاً في الرد بل هو
     الرد الصحيح، والشاشة تتعامل معه كذلك بدل أن ترسم أصفاراً
     تُقرأ «لا إيراد» بدل «لا صلاحية». */
  const rev = d?.last30Days;
  const showRevenue = !!rev && can(me, "overview:view_revenue");
  const crisis = d?.crisisEventsLast30Days || [];
  const crisisTotal = crisis.reduce((s, r) => s + Number(r.n || 0), 0);

  return (
    <div>
      <PageTitle title="نظرة عامة" subtitle="الأرقام محسوبة لحظة فتح الصفحة." />

      <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
        <Stat icon={Users} label="إجمالي المستخدمين" value={d?.totalUsers ?? 0} />
        <Stat icon={CreditCard} label="اشتراكات فعّالة" value={d?.activeSubscriptions ?? 0}
          hint="حسب أحدث اشتراك لكل مستخدم" color="green" />
        <Stat icon={Mail} label="رسائل غير مقروءة" value={d?.unreadMessages ?? 0}
          color={(d?.unreadMessages ?? 0) > 0 ? "amber" : "teal"} />
        <Stat icon={LifeBuoy} label="إشارات أزمة (30 يوماً)" value={crisisTotal}
          hint="مجمّعة بلا هوية" color="crisis" />
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))" }}>
        {showRevenue && (
          <Card>
            <h3 className="text-sm font-bold" style={{ color: C.text }}>الإيراد — آخر 30 يوماً</h3>
            <p className="text-[11px] mb-3" style={{ color: C.textFaint }}>
              بتوقيت {d?.range?.timezone || "Asia/Riyadh"} — لا بتوقيت الخادم.
            </p>
            {[
              ["الإجمالي", sar(rev.grossRevenue), C.text],
              ["المستردّ", `− ${sar(rev.refunds)}`, C.amber],
              ["الصافي", sar(rev.netRevenue), C.green],
              ["مدفوعات فاشلة", rev.failedPayments ?? 0, (rev.failedPayments ?? 0) > 0 ? C.crisis : C.textFaint],
            ].map(([k, v, col]) => (
              <div key={k} className="flex items-center justify-between py-2 text-xs"
                style={{ borderTop: `1px solid ${C.line}` }}>
                <span style={{ color: C.textMuted }}>{k}</span>
                <span className="font-bold" style={{ color: col }}>{v}</span>
              </div>
            ))}
          </Card>
        )}

        <Card>
          <h3 className="text-sm font-bold mb-1" style={{ color: C.text }}>إشارات الأزمة حسب المصدر</h3>
          <p className="text-[11px] mb-3 leading-6" style={{ color: C.textFaint }}>
            عدد فقط. لا هوية ولا نص — الوصول إلى التفاصيل يمر بطلب وصول طارئ موثّق.
          </p>
          {crisis.length === 0 ? <Empty>لا إشارات في آخر 30 يوماً.</Empty> : crisis.map((r, i) => (
            <div key={i} className="flex items-center justify-between py-2 text-xs"
              style={{ borderTop: `1px solid ${C.line}` }}>
              <span style={{ color: C.textMuted }}>{SOURCE_LABEL[r.trigger_source] || r.trigger_source}</span>
              <span className="font-bold" style={{ color: C.crisis }}>{r.n}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
