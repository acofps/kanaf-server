// KANAF-ORD-0011 / ORD-0012 §3 — مسبار قراءة فقط لقاعدة الإنتاج من Render Shell (v2).
// يُخرج: (أ) الترحيلات المطبَّقة، (ب) مالك كل جدول/تسلسل وصلاحيات دور التطبيق عليه (فعلية + منح صريحة
// من information_schema.role_table_grants)، (ج) عدّادات وتسلسلات، (د) تشخيص الاتصال بديلاً لـdiag.js المحذوف.
// لا كتابة، لا معاملة، لا DDL، لا صفوف بيانات (count(*) فقط)، لا طلب لخادم التطبيق، ولا يطبع DATABASE_URL.
// المخرَج بالإنجليزية عمداً: النص العربي يتبعثر في صدفة Render (ORD-0011 ملحق 2).
// التشغيل: انظر RELEASE_RUNBOOK.md — سطر curl واحد.
import { createRequire } from "node:module";
import path from "node:path";
import crypto from "node:crypto";
const tryReq = (d) => { try { return createRequire(path.join(d, "package.json"))("pg"); } catch { return null; } };
const pg = tryReq(process.cwd()) || tryReq("/opt/render/project/src");
const out = (s) => console.log(s);
// لا يُطبع شيء من سلسلة الاتصال: لا عنوان ولا مضيف ولا منفذ ولا IP.
const clean = (e) => `${e?.code || "ERR"} ${String(e?.message || e)
  .replace(/postgres(ql)?:\/\/\S+/gi, "[url]")
  .replace(/(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|connect)\s+\S+/gi, "$1 [host]")
  .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "[ip]")
  .replace(/@[\w.-]+(:\d+)?/g, "@[host]").slice(0, 140)}`;
if (!pg) { out("FAIL pg module not found: run from the project folder (cd /opt/render/project/src)"); process.exit(1); }
const URLS = process.env.DATABASE_URL;
if (!URLS) { out("FAIL DATABASE_URL is not set in this shell"); process.exit(1); }
const dbSsl = (process.env.DB_SSL || "false").toLowerCase();
const ssl = dbSsl === "true" ? { rejectUnauthorized: false } : false;
// (د) تشخيص قبل الاتصال — أعلام لا قيم
const hasSslmode = /[?&]sslmode=/i.test(URLS);
out("== ORD-0012 probe v2.1");
out(`CONN DB_SSL=${dbSsl} url_has_sslmode=${hasSslmode}${hasSslmode ? "  <-- WARNING: pg ignores DB_SSL and verifies the certificate fully; remove ?sslmode from DATABASE_URL (ORD-0012 §1.3)" : ""}`);
const c = new pg.Client({ connectionString: URLS, ssl, application_name: "ord-0012-readonly-probe" });
const q = async (sql, p) => (await c.query(sql, p)).rows;
try {
  await c.connect();
  // أمان: قراءة فقط على مستوى الخادم، ومهلات قصيرة كي لا يُمسك قفل على الإنتاج
  await c.query("SET default_transaction_read_only = on");
  await c.query("SET statement_timeout = '5s'");
  await c.query("SET lock_timeout = '1s'");
  const [{ transaction_read_only: ro }] = await q("SHOW transaction_read_only");
  if (ro !== "on") { out("FAIL read-only could not be enforced — stopping before any read"); process.exit(1); }
  out(`SAFE read_only=${ro}`);
  const [tls] = await q(`SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()`);
  out(`CONN encrypted=${tls?.ssl ?? "unknown"}${tls?.version ? " tls=" + tls.version : ""}`);

  // بيئة الدور (أرقام وأسماء أدوار فقط)
  const [env] = await q(`SELECT current_setting('server_version_num') AS v, current_user AS me, current_database() AS db,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
      (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS createrole,
      pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = 'public')) AS public_owner,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
      pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database())) AS db_owner`);
  out(`ENV pg=${env.v} role=${env.me} db=${env.db} superuser=${env.su} createrole=${env.createrole} public_owner=${env.public_owner} create_in_public=${env.can_create} db_owner=${env.db_owner}`);

  // (أ) الترحيلات المطبَّقة — أسماء ملفات فقط
  try {
    const m = await q("SELECT filename FROM schema_migrations ORDER BY filename");
    const names = m.map((r) => r.filename.replace(/\.sql$/, "").replace(/^(\d+|DB\d+)_.*/, "$1"));
    const want = ["011", "012", "013", "014", "015", "016", "017", "018", "019", "020"];
    out(`MIG applied ${m.length}: ${names.join(",")}`);
    out(`MIG pending from 011-020: ${want.filter((w) => !names.includes(w)).join(",") || "none"}`);
  } catch (e) { out("MIG " + (e.code === "42P01" ? "absent (no schema_migrations table)" : clean(e))); }

  // (ب) الملكية والصلاحيات: جدول لكل جدول/تسلسل
  // المالك من pg_tables.tableowner وpg_sequences.sequenceowner كما يسمّيهما الأمر (§3)، والصلاحيات من pg_class
  const objs = await q(`SELECT c.relname AS n, c.relkind AS k,
      COALESCE(t.tableowner, sq.sequenceowner) AS owner,
      COALESCE(t.tableowner, sq.sequenceowner) = current_user AS mine,
      concat_ws('',
        CASE WHEN has_table_privilege(current_user, c.oid, 'SELECT') THEN 's' ELSE '-' END,
        CASE WHEN c.relkind = 'S' THEN '' WHEN has_table_privilege(current_user, c.oid, 'INSERT') THEN 'i' ELSE '-' END,
        CASE WHEN c.relkind = 'S' THEN '' WHEN has_table_privilege(current_user, c.oid, 'UPDATE') THEN 'u' ELSE '-' END,
        CASE WHEN c.relkind = 'S' THEN '' WHEN has_table_privilege(current_user, c.oid, 'DELETE') THEN 'd' ELSE '-' END,
        CASE WHEN c.relkind = 'S' THEN '' WHEN has_table_privilege(current_user, c.oid, 'REFERENCES') THEN 'R' ELSE '-' END,
        CASE WHEN c.relkind = 'S' THEN '' WHEN has_table_privilege(current_user, c.oid, 'TRIGGER') THEN 'T' ELSE '-' END,
        CASE WHEN c.relkind <> 'S' THEN '' WHEN has_sequence_privilege(current_user, c.oid, 'USAGE') THEN 'U' ELSE '-' END) AS eff
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    LEFT JOIN pg_tables t ON t.schemaname = ns.nspname AND t.tablename = c.relname AND c.relkind IN ('r','p')
    LEFT JOIN pg_sequences sq ON sq.schemaname = ns.nspname AND sq.sequencename = c.relname AND c.relkind = 'S'
    WHERE ns.nspname = 'public' AND c.relkind IN ('r','p','S') ORDER BY c.relkind DESC, c.relname`);
  const grants = await q(`SELECT table_name AS n, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS g
    FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = current_user GROUP BY 1`);
  const g = new Map(grants.map((r) => [r.n, r.g.replace(/SELECT/, "SEL").replace(/INSERT/, "INS").replace(/UPDATE/, "UPD").replace(/DELETE/, "DEL").replace(/REFERENCES/, "REF").replace(/TRIGGER/, "TRG").replace(/TRUNCATE/, "TRN")]));
  const tables = objs.filter((o) => o.k !== "S"), seqs = objs.filter((o) => o.k === "S");
  const byOwner = {};
  for (const o of objs) byOwner[`${o.k === "S" ? "seq" : "tbl"}:${o.owner}${o.mine ? "(app)" : ""}`] = (byOwner[`${o.k === "S" ? "seq" : "tbl"}:${o.owner}${o.mine ? "(app)" : ""}`] || 0) + 1;
  out(`OWN summary ${Object.entries(byOwner).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  out(`OWN all_tables_owned_by_app_role=${tables.every((o) => o.mine)} (ORD-0012 §1.5 claim)`);
  out(`OWN app_tables_fingerprint ${tables.filter((o) => o.mine).length} #${crypto.createHash("sha256").update(tables.filter((o) => o.mine).map((o) => o.n).sort().join(",")).digest("hex").slice(0, 10)}`);
  out("TBL name | owner | app effective (s=select i=insert u=update d=delete R=references T=trigger) | explicit grants to app");
  for (const o of tables) out(`TBL ${o.n} | ${o.owner}${o.mine ? "(app)" : ""} | ${o.eff} | ${o.mine ? "owner" : (g.get(o.n) || "none")}`);
  for (const o of seqs) out(`SEQ ${o.n} | ${o.owner}${o.mine ? "(app)" : ""} | ${o.eff} (s=select U=usage)`);

  // (ج) عدّادات (أرقام فقط) وتسلسلات
  const counts = [];
  for (const [label, sql] of [
    ["users", "SELECT count(*)::int AS n FROM users"],
    ["invoices", "SELECT count(*)::int AS n FROM invoices"],
    ["invoices_issued", "SELECT count(*)::int AS n FROM invoices WHERE zatca_invoice_number IS NOT NULL"],
    ["credit_notes", "SELECT count(*)::int AS n FROM credit_notes"],
    ["payments", "SELECT count(*)::int AS n FROM payments"],
  ]) {
    try { counts.push(`${label}=${(await q(sql))[0].n}`); } catch (e) { counts.push(`${label}=${e.code === "42P01" ? "absent" : "ERR:" + e.code}`); }
  }
  out("CNT " + counts.join(" "));
  // last_value فارغ في pg_sequences لسببين: لم يُستعمل، أو لا صلاحية — يُفرَّق بينهما صراحةً
  const sq = await q(`SELECT sequencename AS n, last_value AS v,
      has_sequence_privilege(current_user, format('%I.%I', schemaname, sequencename), 'SELECT') AS can
    FROM pg_sequences WHERE schemaname = 'public' AND sequencename ~ '(invoice|credit_note)' ORDER BY 1`);
  out("SEQVAL " + (sq.map((s) => `${s.n}=${s.can ? (s.v ?? "unused") : "noaccess"}`).join(" ") || "none"));
  try {
    const [b] = await q(`SELECT invoice_number_prefix AS ip, credit_note_number_prefix AS cp, document_number_token AS tok FROM billing_settings WHERE singleton = true`);
    out(`NUMBERING invoice_prefix=${b?.ip} credit_note_prefix=${b?.cp} token=${b?.tok ?? "NULL"}`);
  } catch (e) { out("NUMBERING " + clean(e)); }
  out("== end");
} catch (e) {
  out("FAIL " + clean(e));
  if (/self.signed|certificate/i.test(String(e?.message))) out("HINT certificate error: DATABASE_URL probably carries ?sslmode=...; remove it and keep DB_SSL=true (ORD-0012 §1.3)");
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
