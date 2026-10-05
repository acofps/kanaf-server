/* ============================================================
   تمرين استعادة النسخة الاحتياطية في هدف معزول — KANAF-ORD-0001 X02

     node test-support/restore-drill.mjs <source_db>

   1) pg_dump بصيغة custom من قاعدة اختبار فيها بيانات اصطناعية.
   2) pg_restore إلى قاعدة جديدة فارغة على نفس العنقود المعزول.
   3) يقارن: عدد الصفوف لكل جدول، بصمة محتوى كل جدول، قيم
      التسلسلات، مالك كل جدول، صلاحيات كل جدول (relacl)، سجل
      الترحيلات، وبصمات ملفات PDF للفواتير.
   لا يلمس أي قاعدة غير معزولة: العناوين تُبنى من test-env.json فقط.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, ".local", "test-env.json"), "utf8"));
const SRC = process.argv[2];
if (!SRC || !SRC.startsWith("kanaf_t_")) { console.error("المصدر يجب أن يكون قاعدة اختبار kanaf_t_*"); process.exit(2); }
const DST = "kanaf_t_restore_drill";
const su = (d) => { const u = new URL(cfg.superuserUrl); u.pathname = `/${d}`; return u.toString(); };
const BIN = process.env.PG_BIN || "/usr/lib/postgresql/16/bin";
async function q(d, sql, p) { const c = new pg.Client({ connectionString: su(d), ssl: false }); await c.connect(); try { return await c.query(sql, p); } finally { await c.end(); } }

async function snapshot(db) {
  const { rows: tables } = await q(db, `SELECT c.relname t, pg_get_userbyid(c.relowner) owner, coalesce(c.relacl::text,'') acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1`);
  const out = { tables: {}, sequences: {}, migrations: [], pdfs: {} };
  for (const t of tables) {
    const { rows } = await q(db, `SELECT count(*)::int n, md5(coalesce(string_agg(x::text,'|' ORDER BY x::text),'')) h FROM "${t.t}" x`);
    out.tables[t.t] = { rows: rows[0].n, contentMd5: rows[0].h, owner: t.owner, acl: t.acl };
  }
  const { rows: seqs } = await q(db, `SELECT sequencename s, sequenceowner o, last_value v FROM pg_sequences WHERE schemaname='public' ORDER BY 1`);
  for (const s of seqs) out.sequences[s.s] = { owner: s.o, lastValue: s.v === null ? null : String(s.v) };
  out.migrations = (await q(db, `SELECT filename FROM schema_migrations ORDER BY filename`)).rows.map((r) => r.filename);
  for (const r of (await q(db, `SELECT zatca_invoice_number n, md5(pdf_data) h FROM invoices WHERE pdf_data IS NOT NULL ORDER BY 1`)).rows) out.pdfs[r.n] = r.h;
  return out;
}

const dumpFile = path.join(HERE, ".local", `${SRC}.dump`);
const t0 = Date.now();
execFileSync(`${BIN}/pg_dump`, ["--format=custom", "--file", dumpFile, "--dbname", su(SRC)]);
const dumpMs = Date.now() - t0;
await q("postgres", `DROP DATABASE IF EXISTS ${DST} WITH (FORCE)`);
await q("postgres", `CREATE DATABASE ${DST} TEMPLATE template0`);
const t1 = Date.now();
let restoreErr = null;
try { execFileSync(`${BIN}/pg_restore`, ["--exit-on-error", "--dbname", su(DST), dumpFile], { stdio: ["ignore", "pipe", "pipe"] }); }
catch (e) { restoreErr = String(e.stderr || e.message).slice(0, 2000); }
const restoreMs = Date.now() - t1;

const a = await snapshot(SRC);
const b = await snapshot(DST);
const diffs = [];
for (const [t, v] of Object.entries(a.tables)) {
  const w = b.tables[t];
  if (!w) { diffs.push(`table missing: ${t}`); continue; }
  for (const k of ["rows", "contentMd5", "owner", "acl"]) if (v[k] !== w[k]) diffs.push(`${t}.${k}: ${v[k]} != ${w[k]}`);
}
for (const [s, v] of Object.entries(a.sequences)) if (JSON.stringify(v) !== JSON.stringify(b.sequences[s])) diffs.push(`sequence ${s}: ${JSON.stringify(v)} != ${JSON.stringify(b.sequences[s])}`);
if (JSON.stringify(a.migrations) !== JSON.stringify(b.migrations)) diffs.push("schema_migrations differ");
if (JSON.stringify(a.pdfs) !== JSON.stringify(b.pdfs)) diffs.push("invoice PDFs differ");

const report = {
  at: new Date().toISOString(), source: SRC, target: DST, dumpBytes: fs.statSync(dumpFile).size, dumpMs, restoreMs, restoreErr,
  tables: Object.keys(a.tables).length, totalRows: Object.values(a.tables).reduce((s, t) => s + t.rows, 0),
  sequences: a.sequences, invoicePdfs: Object.keys(a.pdfs).length, migrations: a.migrations.length, diffs,
  notIncluded: ["الأدوار وكلمات مرورها (pg_dump لا يشملها؛ تحتاج pg_dumpall --roles-only بصلاحية مالك العنقود)",
    "متغيرات Render والأسرار", "ملفات cPanel (التطبيق المنشور، .htaccess، البريد)"],
};
fs.writeFileSync(path.join(HERE, ".local", "logs", "restore-drill.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, sequences: undefined }, null, 2));
await q("postgres", `DROP DATABASE IF EXISTS ${DST} WITH (FORCE)`);
fs.unlinkSync(dumpFile);
process.exit(diffs.length || restoreErr ? 1 : 0);
