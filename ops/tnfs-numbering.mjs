// ترقيم «تنفس» — مشغّل ops/tnfs-numbering.sql من Render Shell (لا psql هناك). KANAF-ORD-0012 §6.5
//
//   node ops/tnfs-numbering.mjs           ← تجربة: ينفّذ داخل معاملة ثم يتراجع. لا أثر.
//   node ops/tnfs-numbering.mjs --apply   ← تثبيت: نفس الشيء ثم COMMIT.
//
// يتصل بـDATABASE_URL وDB_SSL من بيئة الخدمة نفسها (كما db/pool.js) ولا يطبع سلسلة الاتصال.
// المخرَج بالإنجليزية عمداً: النص العربي يتبعثر في صدفة Render.
// لا يُشغَّل إلا وفق RELEASE_RUNBOOK.md، بعد دمج rebrand/tanaffus، وبعد نسخة احتياطية مُستعادة فعلاً.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const SQL = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "tnfs-numbering.sql"), "utf8");
const out = (s) => console.log(s);
const clean = (e) => String(e?.message || e)
  .replace(/postgres(ql)?:\/\/\S+/gi, "[url]").replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "[ip]").replace(/@[\w.-]+(:\d+)?/g, "@[host]");

export async function snapshot(c, { assumeInvoiceSeqReset = false } = {}) {
  const [b] = (await c.query(`SELECT invoice_number_prefix AS ip, credit_note_number_prefix AS cp, document_number_token AS tok
    FROM billing_settings WHERE singleton = true`)).rows;
  const [s0] = (await c.query(`SELECT last_value AS v, is_called AS called FROM kanaf_invoice_number_seq`)).rows;
  // في التجربة لا يُعاد التسلسل فعلاً (setval لا يتراجع) — يُعرض ما سيكون
  const s = assumeInvoiceSeqReset ? { v: "1", called: false, assumed: true } : s0;
  const [n] = (await c.query(`SELECT last_value AS v, is_called AS called FROM kanaf_credit_note_number_seq`)).rows;
  const [d] = (await c.query(`SELECT (SELECT count(*)::int FROM invoices WHERE zatca_invoice_number IS NOT NULL) AS inv,
    (SELECT count(*)::int FROM credit_notes) AS cn`)).rows;
  // الرقم التالي كما سيصدر فعلاً (نفس formatDocumentNumber في billing/config.js)
  const next = (prefix, seq) => [prefix, b.tok, String(seq.called ? Number(seq.v) + 1 : Number(seq.v)).padStart(6, "0")].filter(Boolean).join("-");
  return `prefixes=${b.ip}/${b.cp} token=${b.tok ?? "NULL"} invoice_seq=${s.v}(called=${s.called})${s.assumed ? "[would-be]" : ""} credit_note_seq=${n.v}(called=${n.called}) issued_invoices=${d.inv} credit_notes=${d.cn} next_invoice=${next(b.ip, s)} next_credit_note=${next(b.cp, n)}`;
}

export async function run({ connectionString, ssl, apply, log = out }) {
  const c = new pg.Client({ connectionString, ssl, application_name: "ord-0012-tnfs-numbering" });
  await c.connect();
  try {
    await c.query("SET lock_timeout = '5s'");
    await c.query("BEGIN");
    if (!apply) await c.query("SET LOCAL tnfs.dry_run = 'on'");
    log(`BEFORE ${await snapshot(c)}`);
    try {
      await c.query(SQL);
    } catch (e) {
      await c.query("ROLLBACK");
      const stop = /TNFS-STOP/.test(e.message);
      log(`${stop ? "STOP" : "FAIL"} ${clean(e).replace(/^.*?TNFS-STOP /, "")}`);
      return { ok: false, stopped: stop };
    }
    if (!apply) {
      log(`AFTER  ${await snapshot(c, { assumeInvoiceSeqReset: true })}`);
      await c.query("ROLLBACK");
      log("DRY-RUN rolled back — nothing changed. Re-run with --apply to commit.");
      return { ok: true, applied: false };
    }
    // التثبيت فوراً بعد setval: لا شيء بينهما يمكن أن يفشل
    try {
      await c.query("COMMIT");
    } catch (e) {
      // البادئتان تراجعتا، والتسلسل لا يتراجع وحده — يُعاد إلى 3 صراحةً كي لا يصدر INV-KANAF-000001 مكرَّراً
      await c.query("SELECT setval('kanaf_invoice_number_seq', 3, true)").catch(() => {});
      log(`FAIL commit failed, invoice sequence restored to 3: ${clean(e)}`);
      log(`STATE ${await snapshot(c).catch((x) => "unreadable " + clean(x))}`);
      return { ok: false, stopped: false };
    }
    log("APPLIED committed");
    log(`AFTER  ${await snapshot(c)}`);
    return { ok: true, applied: true };
  } finally {
    await c.end().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) { out("FAIL DATABASE_URL is not set in this shell"); process.exit(1); }
  const ssl = (process.env.DB_SSL || "false").toLowerCase() === "true" ? { rejectUnauthorized: false } : false;
  out(`== tnfs-numbering ${APPLY ? "APPLY" : "DRY-RUN"}`);
  try {
    const r = await run({ connectionString: process.env.DATABASE_URL, ssl, apply: APPLY });
    process.exitCode = r.ok ? 0 : 1;
  } catch (e) { out("FAIL " + clean(e)); process.exitCode = 1; }
  out("== end");
}
