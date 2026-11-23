import React, { useState } from "react";
import { Lock } from "lucide-react";
import { api } from "../api.js";
import { useQueryState } from "../router.js";
import { UserLink } from "./Users.jsx";
import { C, fmtDateTime, DELIVERY_STATUS, CHANNEL_LABEL } from "../theme.js";
import {
  Card, PageTitle, Button, Badge, Spinner, Empty, ErrorBar, Table, Td, Pager, Field, Input, Select, useAsync,
} from "../ui.jsx";

/* ============================================================
   الرسائل المرسلة — KANAF-ORD-0008 §3

   كل رسالة خرجت إلى مستخدم: حملة، أو تذكير، أو رسالة نظام.
   • المستلم يصل من الخادم مقنَّعاً، والواجهة لا ترى العنوان أصلاً.
   • رسائل النظام (تحقق، استعادة…) **لا نص لها في أي مكان** — يظهر
     بدله نوعها ونصّ ثابت. كود التحقق مفتاح دخول، وعرضه يعني أن من
     يصل إلى هذه الشاشة يستولي على الحساب.
   • فتح الصفحة قراءة لبيانات شخصية: تُسجَّل في سجل الوصول بسبب تلقائي (§10).
   ============================================================ */

const SOURCE_LABEL = { campaign: "حملة", inbox: "صندوق التطبيق", system: "رسالة نظام" };
const KIND_LABEL = {
  campaign: "حملة",
  daily_reminder: "تذكير يومي",
  system_notice: "إشعار نظام",
  email_verification: "تأكيد البريد",
  password_reset: "استعادة كلمة المرور",
  existing_account_notice: "حساب مسجّل مسبقاً",
};

export default function SentMessages() {
  /* KANAF-ORD-0013 §10: تُعرض الرسائل مباشرةً بلا مطالبة بسبب. الوصول يُسجَّل في
     سجل الوصول من الخادم صامتاً (المطّلع والوقت والصفحة والمرشّحات). والمرشّحات في العنوان. */
  const [source, setSource] = useQueryState("source", "");
  const [channel, setChannel] = useQueryState("channel", "");
  const [status, setStatus] = useQueryState("status", "");
  const [page, setPage] = useQueryState("page", 1);
  const filters = { source, channel, status };
  const state = useAsync(() => api.listSentMessages({ page, ...filters }), [page, source, channel, status]);
  const d = state.data;
  const rows = d?.messages || [];
  const setF = (k) => (e) => { ({ source: setSource, channel: setChannel, status: setStatus })[k](e.target.value); setPage(1); };

  return (
    <div>
      <PageTitle title="الرسائل المرسلة" subtitle="كل رسالة خرجت إلى مستخدم: حملة، أو تذكير، أو رسالة نظام. فتح الصفحة يُسجَّل في سجل الوصول." />

      <Card>
        <div className="grid gap-3 sm:grid-cols-3 mb-4">
          <Field label="المصدر">
            <Select value={filters.source} onChange={setF("source")}>
              <option value="">الكل</option>
              {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="القناة">
            <Select value={filters.channel} onChange={setF("channel")}>
              <option value="">الكل</option>
              {Object.entries(CHANNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <Field label="الحالة">
            <Select value={filters.status} onChange={setF("status")}>
              <option value="">الكل</option>
              {Object.entries(DELIVERY_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </Field>
        </div>

        <ErrorBar error={state.error} />
        {state.loading ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty>لا رسائل تطابق هذا التصفية.</Empty>
        ) : (
          <>
            <Table head={["الوقت", "المستلم", "النوع", "القناة", "الحالة", "النص", "سبب الفشل"]}>
              {rows.map((m) => {
                const st = DELIVERY_STATUS[m.status] || { label: m.status, color: "textMuted" };
                return (
                  <tr key={`${m.source}-${m.id}`}>
                    <Td>{fmtDateTime(m.at)}</Td>
                    <Td>
                      <div><UserLink id={m.recipient?.id} name={m.recipient?.name} /></div>
                      <div className="text-[11px]" dir="ltr" style={{ color: C.textFaint }}>{m.recipient?.emailMasked}</div>
                    </Td>
                    <Td>
                      <div>{KIND_LABEL[m.kind] || m.kind}</div>
                      <div className="text-[11px]" style={{ color: C.textFaint }}>{SOURCE_LABEL[m.source]}</div>
                    </Td>
                    <Td>{CHANNEL_LABEL[m.channel] || m.channel}</Td>
                    <Td><Badge color={st.color}>{st.label}</Badge></Td>
                    <Td className="max-w-sm">
                      {m.bodyWithheld ? (
                        <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: C.textMuted }}>
                          <Lock size={13} strokeWidth={1.75} /> {m.withheldNote}
                        </span>
                      ) : (
                        <div>
                          <div className="font-bold text-[12px]">{m.title}</div>
                          <div className="text-[12px] leading-5 line-clamp-3" style={{ color: C.textMuted }}>{m.body}</div>
                        </div>
                      )}
                    </Td>
                    <Td className="max-w-xs">
                      {m.errorCode ? (
                        <span className="text-[11px]" style={{ color: C.textMuted }}>
                          <code>{m.errorCode}</code>{m.errorDetail ? ` — ${m.errorDetail}` : ""}
                        </span>
                      ) : "—"}
                    </Td>
                  </tr>
                );
              })}
            </Table>
            <Pager page={d.page} totalPages={d.totalPages} total={d.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
