/* ============================================================
   اختبارات الحارس السلبية — شرط دخول G1 (KANAF-ORD-0001 U09-2)

     node test-support/guard-negative-tests.mjs

   تنشئ قاعدة «كناري» معزولة فيها صفوف اصطناعية معروفة، ثم تشغّل
   **أخطر ملف اختبار فعلي** (test-billing.mjs) مباشرةً بـnode — كما
   يفعل شخص مستعجل — تحت إعدادات خاطئة، وتتحقق في كل حالة من:
     (1) الخروج برمز الحارس 97،
     (2) أن الكناري لم يتغيّر بايتاً (بصمة محتوى الجداول المرصودة).
   الأهداف «الإنتاجية» هنا وهمية أو معزولة؛ لا يُلمس أي نظام حي.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, ".local", "test-env.json"), "utf8"));
const CANARY = "kanaf_t_guard_canary";
const VICTIM = "test-billing.mjs";

const url = (db, { su = false, role, password } = {}) => {
  const u = new URL(cfg.superuserUrl); u.pathname = `/${db}`;
  if (!su) { u.username = role || cfg.runtimeRole; u.password = password ?? cfg.runtimePassword; }
  return u.toString();
};
async function suq(db, sql, p) { const c = new pg.Client({ connectionString: url(db, { su: true }), ssl: false }); await c.connect(); try { return await c.query(sql, p); } finally { await c.end(); } }

async function fingerprint() {
  const tables = ["users", "admin_users", "tax_settings", "subscription_plans", "invoices", "content_items", "app_settings", "kanaf_test_env_marker"];
  const h = crypto.createHash("sha256");
  for (const t of tables) {
    const { rows } = await suq(CANARY, `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) m, count(*)::int n FROM ${t} x`);
    h.update(`${t}:${rows[0].n}:${rows[0].m};`);
  }
  const { rows: seq } = await suq(CANARY, `SELECT last_value, is_called FROM kanaf_invoice_number_seq`);
  h.update(JSON.stringify(seq));
  return h.digest("hex");
}

await suq("postgres", `DROP DATABASE IF EXISTS ${CANARY} WITH (FORCE)`);
await suq("postgres", `CREATE DATABASE ${CANARY} TEMPLATE kanaf_tpl_migrated`);
await suq(CANARY, `UPDATE kanaf_test_env_marker SET purpose = 'guard-canary'`);
await suq(CANARY, `INSERT INTO users (name, email, password_hash, email_verified_at) VALUES
  ('مستخدم كناري ١','canary1@canary.invalid','x', now()), ('مستخدم كناري ٢','canary2@canary.invalid','x', now())`);
await suq(CANARY, `INSERT INTO tax_settings (singleton, legal_name, vat_number) VALUES (true, 'اسم كناري', '399999999900003')
  ON CONFLICT (singleton) DO UPDATE SET legal_name = 'اسم كناري'`);
await suq(CANARY, `SELECT nextval('kanaf_invoice_number_seq')`);

const base = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8",
  USER_JWT_SECRET: crypto.randomBytes(32).toString("hex"), ADMIN_JWT_SECRET: crypto.randomBytes(32).toString("hex") };

const CASES = [
  ["N1 عنوان إنتاج مُدخل بالخطأ (مضيف بعيد ودور الإنتاج)", { TEST_DATABASE_URL: "postgresql://kanaf_adel:x@db.kanaf.me:5432/kanaf", KANAF_TEST_MARKER: cfg.marker }],
  ["N1b عنوان محلي لقاعدة بلا علامة (نسخة إنتاج مستعادة محلياً مثلاً)", { TEST_DATABASE_URL: url("postgres"), KANAF_TEST_MARKER: cfg.marker }],
  ["N1c مضيف إنتاج حتى لو أُعلن في KANAF_TEST_ALLOWED_HOSTS", { TEST_DATABASE_URL: "postgresql://kanaf_runtime_test:x@kanaf-server.onrender.com:5432/x", KANAF_TEST_MARKER: cfg.marker, KANAF_TEST_ALLOWED_HOSTS: "kanaf-server.onrender.com" }],
  ["N2 غياب الإعداد (DATABASE_URL وحده مضبوط على الكناري)", { DATABASE_URL: url(CANARY) }],
  ["N2b غياب علامة KANAF_TEST_MARKER", { TEST_DATABASE_URL: url(CANARY) }],
  ["N2c nonce خاطئ", { TEST_DATABASE_URL: url(CANARY), KANAF_TEST_MARKER: "0".repeat(48) }],
  ["N2d بيئة مختلطة: DATABASE_URL يختلف عن TEST_DATABASE_URL", { TEST_DATABASE_URL: url(CANARY), DATABASE_URL: "postgresql://kanaf_adel:x@db.kanaf.me/kanaf", KANAF_TEST_MARKER: cfg.marker }],
  ["N3 دور غير مسموح: superuser فعلي على الكناري ذي العلامة الصحيحة", { TEST_DATABASE_URL: url(CANARY, { su: true }), KANAF_TEST_MARKER: cfg.marker }],
  ["N3b دور غير مسموح بالاسم (kanaf_adel)", { TEST_DATABASE_URL: url(CANARY, { role: "kanaf_adel", password: "x" }), KANAF_TEST_MARKER: cfg.marker }],
  ["N3c SUPERUSER_URL يشير إلى خادم آخر", { TEST_DATABASE_URL: url(CANARY), KANAF_TEST_MARKER: cfg.marker, SUPERUSER_URL: "postgresql://postgres:x@db.kanaf.me:5432/kanaf" }],
  ["N4 الهدف سليم لكنه ليس قاعدة مخصّصة لهذا الملف (purpose مختلف)", { TEST_DATABASE_URL: url(CANARY), KANAF_TEST_MARKER: cfg.marker }],
  ["N5 مفتاح دفع حي", { TEST_DATABASE_URL: url(CANARY), KANAF_TEST_MARKER: cfg.marker, PAYMENT_SECRET_KEY: "sk_live_fake" }],
];

const before = await fingerprint();
const results = [];
for (const [label, env] of CASES) {
  const r = spawnSync(process.execPath, [VICTIM], { cwd: ROOT, env: { ...base, ...env }, encoding: "utf8", timeout: 60000 });
  const after = await fingerprint();
  const reason = (r.stderr.match(/REFUSED: (.*)/) || [])[1] || "";
  const ok = r.status === 97 && after === before;
  results.push({ label, ok, exit: r.status, unchanged: after === before, reason });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      exit=${r.status} canary_unchanged=${after === before} reason=${reason}`);
}

/* الحالة الإيجابية المقابلة: نفس الكناري، purpose صحيح → الحارس يسمح. */
await suq(CANARY, `UPDATE kanaf_test_env_marker SET purpose = 'guard-probe-only.mjs'`);
const probeOnly = path.join(ROOT, "test-support", ".local", "guard-probe-only.mjs");
fs.writeFileSync(probeOnly, `import "../guard.mjs";\nconsole.log("GUARD_ALLOWED " + process.env.DATABASE_URL.includes("${CANARY}"));\n`);
const pos = spawnSync(process.execPath, [probeOnly], { cwd: ROOT, env: { ...base, TEST_DATABASE_URL: url(CANARY), KANAF_TEST_MARKER: cfg.marker }, encoding: "utf8" });
const posOk = pos.status === 0 && /GUARD_ALLOWED true/.test(pos.stdout);
results.push({ label: "P1 الهدف المعزول ذو العلامة والدور الصحيحين مسموح", ok: posOk, exit: pos.status });
console.log(`${posOk ? "PASS" : "FAIL"}  P1 الهدف المعزول ذو العلامة والدور الصحيحين مسموح (exit=${pos.status})`);

/* الشبكة: اتصال خارجي من داخل عملية محروسة يُرفض */
const netProbe = path.join(ROOT, "test-support", ".local", "guard-net-probe.mjs");
fs.writeFileSync(netProbe, `import "../guard.mjs";\ntry { await fetch("https://api.moyasar.com/v1/invoices"); console.log("NET_ALLOWED"); } catch (e) { console.log("NET_BLOCKED " + (e.cause?.message || e.message)); }\n`);
const np = spawnSync(process.execPath, [netProbe], { cwd: ROOT, env: { ...base, TEST_DATABASE_URL: url(CANARY), KANAF_TEST_MARKER: cfg.marker }, encoding: "utf8", timeout: 30000 });
const npOk = /NET_BLOCKED/.test(np.stdout);
results.push({ label: "P2 اتصال شبكي خارجي من عملية محروسة يُرفض", ok: npOk, out: np.stdout.trim() });
console.log(`${npOk ? "PASS" : "FAIL"}  P2 اتصال شبكي خارجي من عملية محروسة يُرفض (${np.stdout.trim()})`);

await suq("postgres", `DROP DATABASE IF EXISTS ${CANARY} WITH (FORCE)`);
fs.mkdirSync(path.join(HERE, ".local", "logs"), { recursive: true });
fs.writeFileSync(path.join(HERE, ".local", "logs", "guard-negative.json"), JSON.stringify({ at: new Date().toISOString(), victim: VICTIM, results }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
