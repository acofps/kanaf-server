import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * خطوة ترقيم «تنفس بحرية» — KANAF-ORD-0012 §6.5. يختبر ops/tnfs-numbering.{sql,mjs} على قاعدة معزولة
 * بحالة الإنتاج كما قُرئت (§1.9): بادئتان INV/KANAF، والتسلسل عند 3 مُستعمَلاً، وثلاث فواتير صادرة.
 *   S) الفحص المسبق يوقف كل حالة شاذة بلا أي تغيير.
 *   D) التجربة (بلا --apply) لا تترك أثراً.
 *   A) التثبيت: الفاتورة التالية TNFS-INV-000001 والإشعار التالي TNFS-CN-000001، والصادر لا يُمسّ.
 *   R) إعادة التشغيل بعد التثبيت تتوقف.
 */
requireDedicatedDatabase(import.meta.url);
import pg from "pg";
import { run, snapshot } from "./ops/tnfs-numbering.mjs";
import { getBillingSettings, formatDocumentNumber } from "./billing/config.js";

const URL_ = process.env.TEST_DATABASE_URL;
let pass = 0, fail = 0;
const log = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`); ok ? pass++ : fail++; };
const db = new pg.Client({ connectionString: URL_, ssl: false });
await db.connect();
const q = (s, p) => db.query(s, p);
const lines = [];
const go = (apply) => run({ connectionString: URL_, ssl: false, apply, log: (s) => lines.push(s) });
const snap = () => snapshot(db);
const state = async () => JSON.stringify({ s: await snap(), docs: (await q(`SELECT zatca_invoice_number FROM invoices WHERE zatca_invoice_number IS NOT NULL ORDER BY 1`)).rows.map((r) => r.zatca_invoice_number) });

/* حالة الإنتاج */
await q(`INSERT INTO billing_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`);
await q(`UPDATE billing_settings SET invoice_number_prefix='INV', credit_note_number_prefix='CN', document_number_token='KANAF' WHERE singleton`);
const { rows: [u] } = await q(`INSERT INTO users (name, email, password_hash, confirmed_adult) VALUES ('ترقيم', 'tnfs-num@kanaf.test', 'x', true) RETURNING id`);

/* S1: تسلسل غير مُستعمَل (ليس 3) → توقف */
let before = await state(); lines.length = 0;
let r = await go(true);
log("S1 التسلسل ليس عند 3 → توقف بلا تغيير", !r.ok && r.stopped && (await state()) === before && lines.some((l) => /^STOP .*expected 3/.test(l)), lines.find((l) => l.startsWith("STOP")));

/* ثلاث فواتير صادرة كما على الإنتاج */
for (let i = 1; i <= 3; i++) {
  const { rows: [n] } = await q(`SELECT nextval('kanaf_invoice_number_seq') n`);
  await q(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, zatca_invoice_number) VALUES ($1, 'monthly', 29, 'paid', $2)`, [u.id, formatDocumentNumber("INV", "KANAF", n.n)]);
}
before = await state();
log("P0 حالة الإنتاج مُعادة: INV-KANAF-000001…3 والتسلسل 3", /invoice_seq=3\(called=true\)/.test(before) && before.includes("INV-KANAF-000003") && before.includes("next_invoice=INV-KANAF-000004"));

/* S2: الإشعار الدائن مُستعمَل → توقف */
await q(`SELECT nextval('kanaf_credit_note_number_seq')`);
lines.length = 0; r = await go(true);
log("S2 تسلسل الإشعارات مُستعمَل → توقف بلا تغيير", !r.ok && r.stopped && lines.some((l) => /credit_note_number_seq has been used/.test(l)) && /prefixes=INV\/CN/.test(await snap()));
await q(`SELECT setval('kanaf_credit_note_number_seq', 1, false)`);

/* S3: وثيقة TNFS- موجودة → توقف */
await q(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, zatca_invoice_number) VALUES ($1, 'monthly', 29, 'paid', 'TNFS-INV-000001')`, [u.id]);
lines.length = 0; r = await go(true);
log("S3 وثيقة TNFS- قائمة → توقف بلا تغيير", !r.ok && r.stopped && lines.some((l) => /already carry a TNFS- number/.test(l)) && /invoice_seq=3\(called=true\)/.test(await snap()));
await q(`DELETE FROM invoices WHERE zatca_invoice_number = 'TNFS-INV-000001'`);
log("S0 الحالة بعد حالات التوقف هي حالة الإنتاج نفسها", (await state()) === before);

/* D: التجربة */
lines.length = 0; r = await go(false);
log("D1 التجربة تُظهر الرقم التالي TNFS-INV-000001 و TNFS-CN-000001", r.ok && !r.applied && lines.some((l) => l.startsWith("AFTER") && l.includes("[would-be]") && l.includes("next_invoice=TNFS-INV-000001") && l.includes("next_credit_note=TNFS-CN-000001") && l.includes("token=NULL")), lines.find((l) => l.startsWith("AFTER")));
log("D2 التجربة لا تترك أثراً", (await state()) === before && lines.some((l) => l.startsWith("DRY-RUN")));

/* A: التثبيت */
lines.length = 0; r = await go(true);
log("A1 التثبيت ينجح", r.ok && r.applied && lines.includes("APPLIED committed"), lines.join(" | "));
const s = await getBillingSettings(db);
const { rows: [ni] } = await q(`SELECT nextval('kanaf_invoice_number_seq') n`);
const { rows: [nc] } = await q(`SELECT nextval('kanaf_credit_note_number_seq') n`);
const inv = formatDocumentNumber(s.invoiceNumberPrefix, s.documentNumberToken, ni.n);
const cn = formatDocumentNumber(s.creditNoteNumberPrefix, s.documentNumberToken, nc.n);
log("A2 الفاتورة التالية كما يصدرها الكود: TNFS-INV-000001", inv === "TNFS-INV-000001", inv);
log("A3 الإشعار الدائن التالي: TNFS-CN-000001", cn === "TNFS-CN-000001", cn);
await q(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, zatca_invoice_number) VALUES ($1, 'monthly', 29, 'paid', $2)`, [u.id, inv]);
const docs = (await q(`SELECT zatca_invoice_number z FROM invoices WHERE zatca_invoice_number IS NOT NULL ORDER BY created_at, z`)).rows.map((x) => x.z);
log("A4 الصادر قبله لم يُمسّ، والجديد يجاوره بلا تصادم", JSON.stringify(docs) === JSON.stringify(["INV-KANAF-000001", "INV-KANAF-000002", "INV-KANAF-000003", "TNFS-INV-000001"]), docs.join(","));

/* R: إعادة التشغيل */
const after = await state(); lines.length = 0; r = await go(true);
log("R1 إعادة التشغيل بعد التثبيت تتوقف بلا تغيير", !r.ok && r.stopped && (await state()) === after);

/* سرية */
const all = lines.join("\n");
log("X1 لا تظهر سلسلة الاتصال ولا كلمة المرور في المخرَج", !all.includes(new URL(URL_).password) && !/postgres(ql)?:\/\//.test(all));

await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
