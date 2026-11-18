import React, { useState } from "react";
import { Lock } from "lucide-react";
import { api } from "../api.js";
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
   • فتح الصفحة قراءة لبيانات شخصية: سبب مكتوب يُسجَّل في سجل الوصول.
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
  const [reasonDraft, setReasonDraft] = useState("");
  const [reason, setReason] = useState("");
  const [filters, setFilters] = useState({ source: "", channel: "", status: "" });
  const [page, setPage] = useState(1);
  const state = useAsync(
    () => (reason ? api.listSentMessages({ reason, page, ...filters }) : Promise.resolve(null)),
    [reason, page, filters.source, filters.channel, filters.status]
  );
  const d = state.data;
  const rows = d?.messages || [];
  const setF = (k) => (e) => { setFilters((f) => ({ ...f, [k]: e.target.value })); setPage(1); };

  if (!reason) {
    return (
      <div>
        <PageTitle title="الرسائل المرسلة" subtitle="كل رسالة خرجت إلى مستخدم: حملة، أو تذكير، أو رسالة نظام." />
        <Card className="max-w-xl">
          <p className="text-xs mb-4 leading-6" style={{ color: C.textMuted }}>
            هذه الصفحة تعرض مراسلات المستخدمين، فالوصول إليها يُسجَّل في سجل الوصول مع سببه.
            رسائل التحقق واستعادة كلمة المرور لا يُخزَّن نصّها، فلا تظهر هنا بحال.
          </p>
          <form onSubmit={(e) => { e.preventDefault(); if (reasonDraft.trim()) setReason(reasonDraft.trim()); }}>
            <Field label="سبب الاطلاع">
              <Input value={reasonDraft} onChange={(e) => setReasonDraft(e.target.value)} placeholder="مثلاً: متابعة شكوى عدم وصول رسالة" />
            </Field>
            <div className="mt-3"><Button type="submit" disabled={!reasonDraft.trim()}>عرض السجل</Button></div>
          </form>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageTitle title="الرسائل المرسلة" subtitle={`سبب الاطلاع المسجَّل: ${reason}`}>
        <Button size="sm" variant="ghost" onClick={() => { setReason(""); setReasonDraft(""); }}>تغيير السبب</Button>
      </PageTitle>

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
                      <div className="font-bold">{m.recipient?.name || "—"}</div>
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
