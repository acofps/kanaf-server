/* ============================================================
   مشغّل ملفات الاختبار على قواعد معزولة — قاعدة جديدة لكل ملف
   KANAF-ORD-0001 / R15-05

     node test-support/run-tests.mjs                 # كل test-*.mjs
     node test-support/run-tests.mjs test-auth.mjs   # ملف واحد
     KEEP_DB=1 node test-support/run-tests.mjs ...   # لا تحذف القاعدة بعده

   يحتاج test-support/.local/test-env.json من setup-isolated-db.mjs.

   لكل ملف: CREATE DATABASE kanaf_t_<اسم> TEMPLATE <قالب>، ثم يكتب
   اسم الملف في purpose داخل العلامة، ثم يشغّل الملف في عملية فرعية
   **ببيئة مبنية من الصفر** (لا يرث DATABASE_URL ولا أي سر من بيئة
   المشغّل)، ثم يحذف القاعدة. test-migrate.mjs وحده يأخذ قالب المخطط
   الأصلي بلا ترحيلات لأنه يقيس تطبيقها.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ENV_FILE = path.join(HERE, ".local", "test-env.json");
if (!fs.existsSync(ENV_FILE)) { console.error("شغّل setup-isolated-db.mjs أولاً"); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(ENV_FILE, "utf8"));

const TEMPLATE_FOR = { "test-migrate.mjs": "kanaf_tpl_schema" };
const NEEDS_SUPERUSER = new Set(["test-billing-resilience.mjs", "test-12-refund-edges.mjs"]);

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(ROOT).filter((f) => /^test-.*\.mjs$/.test(f)).sort();

const urlFor = (db, { superuser = false } = {}) => {
  const u = new URL(cfg.superuserUrl);
  u.pathname = `/${db}`;
  if (!superuser) { u.username = cfg.runtimeRole; u.password = cfg.runtimePassword; }
  return u.toString();
};
async function suQuery(db, sql, params) {
  const c = new pg.Client({ connectionString: urlFor(db, { superuser: true }), ssl: false });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

const LOG_DIR = path.join(HERE, ".local", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const summary = [];

for (const file of files) {
  const slug = "kanaf_t_" + file.replace(/^test-/, "").replace(/\.mjs$/, "").replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const template = TEMPLATE_FOR[file] || "kanaf_tpl_migrated";
  await suQuery("postgres", `DROP DATABASE IF EXISTS ${slug} WITH (FORCE)`);
  await suQuery("postgres", `CREATE DATABASE ${slug} TEMPLATE ${template}`);
  await suQuery(slug, `UPDATE kanaf_test_env_marker SET purpose = $1`, [file]);

  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: process.env.TZ || "UTC",
    TEST_DATABASE_URL: urlFor(slug), KANAF_TEST_MARKER: cfg.marker,
    USER_JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    ADMIN_JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    AUTH_RATE_LIMIT_MAX: "1000", APP_ROLE: cfg.runtimeRole,
    PAYMENT_SECRET_KEY: "sk_test_fake", PAYMENT_WEBHOOK_SECRET: "test-shared-secret",
    APP_BASE_URL: "http://127.0.0.1:5173", SERVER_BASE_URL: "http://127.0.0.1:3001",
  };
  for (const k of ["PUPPETEER_EXECUTABLE_PATH", "PDF_HEADLESS_MODE", "PUPPETEER_CACHE_DIR"]) if (process.env[k]) env[k] = process.env[k];
  if (NEEDS_SUPERUSER.has(file)) env.SUPERUSER_URL = urlFor(slug, { superuser: true });

  const started = Date.now();
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, env, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 64 << 20 });
  const out = (r.stdout || "") + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : "");
  fs.writeFileSync(path.join(LOG_DIR, `${file}.log`), out);

  const passes = (out.match(/^\s*(PASS|✔|✅)\s/gm) || []).length;
  const fails = (out.match(/^\s*(FAIL|✘|❌)\s/gm) || []).length;
  const skips = (out.match(/^\s*(SKIP|⏭|—)\s/gm) || []).length;
  summary.push({ file, exit: r.status, signal: r.signal, passes, fails, skips, seconds: Math.round((Date.now() - started) / 1000), template });
  console.log(`${r.status === 0 ? "OK  " : "FAIL"} ${file.padEnd(32)} exit=${r.status} pass=${passes} fail=${fails} skip=${skips} (${Math.round((Date.now() - started) / 1000)}s)`);

  if (!process.env.KEEP_DB) await suQuery("postgres", `DROP DATABASE IF EXISTS ${slug} WITH (FORCE)`);
}

fs.writeFileSync(path.join(LOG_DIR, "summary.json"), JSON.stringify({ at: new Date().toISOString(), node: process.version, summary }, null, 2));
const total = summary.reduce((a, s) => ({ p: a.p + s.passes, f: a.f + s.fails, s: a.s + s.skips }), { p: 0, f: 0, s: 0 });
console.log(`\nTOTAL pass=${total.p} fail=${total.f} skip=${total.s} files=${summary.length} nonzero-exit=${summary.filter((s) => s.exit !== 0).length}`);
process.exit(summary.some((s) => s.exit !== 0) ? 1 : 0);
