// KANAF-ORD-0011 — مسبار قراءة فقط لقاعدة الإنتاج من Render Shell.
// يُخرج: (أ) الترحيلات المطبَّقة، (ب) مالك كل جدول/تسلسل وصلاحيات دور التطبيق عليه، (ج) عدّادات وتسلسلات.
// لا كتابة، لا معاملة، لا DDL، لا صفوف بيانات (count(*) فقط)، ولا يطبع DATABASE_URL.
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
if (!pg) { out("FAIL pg غير موجود: شغّل الأمر من مجلد المشروع (فيه node_modules)"); process.exit(1); }
if (!process.env.DATABASE_URL) { out("FAIL DATABASE_URL غير مضبوط في هذه الصدفة"); process.exit(1); }
const ssl = (process.env.DB_SSL || "false").toLowerCase() === "true" ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl, application_name: "ord-0011-readonly-probe" });
const q = async (sql, p) => (await c.query(sql, p)).rows;
try {
  await c.connect();
  // أمان: قراءة فقط على مستوى الخادم، ومهلات قصيرة كي لا يُمسك قفل على الإنتاج
  await c.query("SET default_transaction_read_only = on");
  await c.query("SET statement_timeout = '5s'");
  await c.query("SET lock_timeout = '1s'");
  const [{ transaction_read_only: ro }] = await q("SHOW transaction_read_only");
  if (ro !== "on") { out("FAIL لم تُفعَّل القراءة فقط — توقّف بلا أي قراءة"); process.exit(1); }
  out("== ORD-0011 probe v1 · read_only=" + ro);

  // بيئة الدور (أرقام وأسماء أدوار فقط)
  const [env] = await q(`SELECT current_setting('server_version_num') AS v, current_user AS me,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
      (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS createrole,
      pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = 'public')) AS public_owner,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
      pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database())) AS db_owner`);
  out(`ENV pg=${env.v} me=${env.me} super=${env.su} createrole=${env.createrole} public_owner=${env.public_owner} create_in_public=${env.can_create} db_owner=${env.db_owner}`);

  // (أ) الترحيلات المطبَّقة — أسماء ملفات فقط
  try {
    const m = await q("SELECT filename FROM schema_migrations ORDER BY filename");
    out(`MIG ${m.length}: ${m.map((r) => r.filename.replace(/\.sql$/, "").replace(/^(\d+|DB\d+)_.*/, "$1")).join(",")}`);
  } catch (e) { out("MIG " + (e.code === "42P01" ? "absent (schema_migrations غير موجود)" : clean(e))); }

  // (ب) الملكية والصلاحيات: مجمَّعة حسب المالك، ولكل جدول غير مملوك لدور التطبيق ما ينقصه
  const objs = await q(`SELECT c.relname AS n, c.relkind AS k, pg_get_userbyid(c.relowner) AS owner,
      c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS mine,
      array_remove(ARRAY[
        CASE WHEN NOT has_table_privilege(current_user, c.oid, 'SELECT')     THEN 's' END,
        CASE WHEN c.relkind IN ('r','p') AND NOT has_table_privilege(current_user, c.oid, 'INSERT')     THEN 'i' END,
        CASE WHEN c.relkind IN ('r','p') AND NOT has_table_privilege(current_user, c.oid, 'UPDATE')     THEN 'u' END,
        CASE WHEN c.relkind IN ('r','p') AND NOT has_table_privilege(current_user, c.oid, 'DELETE')     THEN 'd' END,
        CASE WHEN c.relkind IN ('r','p') AND NOT has_table_privilege(current_user, c.oid, 'REFERENCES') THEN 'R' END,
        CASE WHEN c.relkind IN ('r','p') AND NOT has_table_privilege(current_user, c.oid, 'TRIGGER')    THEN 'T' END,
        CASE WHEN c.relkind = 'S' AND NOT has_sequence_privilege(current_user, c.oid, 'USAGE')          THEN 'U' END
      ], NULL) AS missing
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r','p','S') ORDER BY c.relkind, c.relname`);
  const groups = new Map();
  for (const o of objs) {
    const key = `${o.k === "S" ? "SEQ" : "TBL"} owner=${o.owner}${o.mine ? "(app)" : ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o.missing.length ? `${o.n}[-${o.missing.join("")}]` : o.n);
  }
  // جداول دور التطبيق بكامل صلاحياتها: عددها وبصمة أسمائها (تُطابَق بالمستودع) بدل سردها
  for (const [k, names] of groups) {
    const full = k.includes("(app)") && names.every((n) => !n.includes("[-"));
    if (full) out(`OWN ${k} ${names.length} #${crypto.createHash("sha256").update([...names].sort().join(",")).digest("hex").slice(0, 10)}`);
    else out(`OWN ${k} ${names.length}: ${names.join(",")}`);
  }
  out("OWN legend: [-…] = ما ينقص دور التطبيق: s=select i=insert u=update d=delete R=references T=trigger U=usage");

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
  const seqs = await q(`SELECT sequencename AS n, last_value AS v,
      has_sequence_privilege(current_user, format('%I.%I', schemaname, sequencename), 'SELECT') AS can
    FROM pg_sequences WHERE schemaname = 'public' AND sequencename ~ '(invoice|credit_note)' ORDER BY 1`);
  out("SEQ " + (seqs.map((s) => `${s.n}=${s.can ? (s.v ?? "unused") : "noaccess"}`).join(" ") || "none"));
  out("== end");
} catch (e) {
  out("FAIL " + clean(e));
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
