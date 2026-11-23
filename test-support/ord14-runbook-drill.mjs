/* ============================================================
   تجربة أوامر الكرّاس حرفياً — KANAF-ORD-0014 §4.3
     node test-support/ord14-runbook-drill.mjs <main worktree> <prep worktree>

   كل أمر في docs/ord-0014/RELEASE_RUNBOOK_0013.md يُقرأ من الكرّاس نفسه (كتل ```bash)، ويُنفَّذ
   كما هو في صدفة bash بمتغيّرات «Render Shell» (SETUP_TOKEN، DATABASE_URL، DB_SSL، EMAIL_FROM)،
   مع استبدال عنوان الإنتاج بخادم محلي فقط. ويُتحقَّق من أن كل أمر سطر واحد بلا heredoc.
   المراحل كما في الكرّاس: main على حالة الإنتاج ← نشر فرع التحضير ← الترحيل ← نشر المرشّح ← التراجع.
   الناتج: test-support/.local/logs/ord0014/runbook-drill.{log,json}
   ============================================================ */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const [MAIN_DIR, PREP_DIR] = process.argv.slice(2, 4).map((d) => d && path.resolve(d));
if (![MAIN_DIR, PREP_DIR].every((d) => d && fs.existsSync(path.join(d, "index.js")))) { console.error("usage: <main dir> <prep dir>"); process.exit(2); }
const LOG_DIR = path.join(HERE, ".local", "logs", "ord0014"); fs.mkdirSync(LOG_DIR, { recursive: true });
const lines = []; const say = (s) => { lines.push(s); console.log(s); };
const R = []; const ok = (label, cond, x = "") => { R.push({ label, pass: !!cond, detail: x }); say(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !x ? "" : `  (${String(x).slice(0, 400)})`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROD = "https://kanaf-server.onrender.com";

/* ---------- الأوامر من الكرّاس نفسه ---------- */
const RUNBOOK = fs.readFileSync(path.join(ROOT, "docs/ord-0014/RELEASE_RUNBOOK_0013.md"), "utf8");
const blocks = [...RUNBOOK.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\n\s*$/, "").trim());
const multi = blocks.filter((b) => b.split("\n").length !== 1 || /<<\s*['"]?\w+/.test(b));
ok(`R0 كل أوامر الكرّاس (${blocks.length}) سطر واحد بلا heredoc`, blocks.length >= 8 && multi.length === 0, multi.join(" ‖ "));
const cmd = (needle) => { const b = blocks.find((x) => x.includes(needle)); if (!b) throw new Error(`no runbook command contains ${needle}`); return b; };

/* ---------- قاعدة بحالة الإنتاج ---------- */
const envLines = execFileSync(process.execPath, [path.join(HERE, "create-db.mjs"), "ord14-runbook", "schema"], { encoding: "utf8" });
const DB_URL = /TEST_DATABASE_URL='([^']+)'/.exec(envLines)[1], MARKER = /KANAF_TEST_MARKER='([^']+)'/.exec(envLines)[1];
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, ".local", "test-env.json"), "utf8"));
const mig = spawnSync(process.execPath, [path.join(MAIN_DIR, "test-support/migrate-isolated.mjs")], { cwd: MAIN_DIR, encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TEST_DATABASE_URL: DB_URL, KANAF_TEST_MARKER: MARKER } });
ok("P0 حالة الإنتاج: ترحيلات main مطبَّقة", mig.status === 0, mig.stderr);
{
  const su = new pg.Client({ connectionString: (() => { const u = new URL(cfg.superuserUrl); u.pathname = new URL(DB_URL).pathname; return u.toString(); })(), ssl: false });
  await su.connect();
  for (const sq of ["kanaf_invoice_number_seq", "kanaf_credit_note_number_seq"]) {
    await su.query(`ALTER SEQUENCE ${sq} OWNER TO CURRENT_USER`); await su.query(`GRANT SELECT, USAGE, UPDATE ON SEQUENCE ${sq} TO ${cfg.runtimeRole}`);
  }
  // الترقيم كما صار على الإنتاج بعد ORD-0012 (TNFS-INV بلا رمز، والتسلسل لم يُستعمل)
  await su.query(`UPDATE billing_settings SET invoice_number_prefix = 'TNFS-INV', credit_note_number_prefix = 'TNFS-CN', document_number_token = NULL`);
  await su.query(`SELECT setval('kanaf_invoice_number_seq', 1, false)`);
  await su.query(`INSERT INTO tax_settings (singleton, legal_name, vat_number, address) VALUES (true, 'أكاديمية علم النفس', '300000000000003', 'جدة') ON CONFLICT (singleton) DO NOTHING`);
  await su.end();
}

const SHELL_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, SETUP_TOKEN: crypto.randomBytes(24).toString("hex"), DATABASE_URL: DB_URL, DB_SSL: "true",
  EMAIL_FROM: "تنفس <noreply@mg.acofps.com>" };
let server = null, port = 0;
async function deploy(dir, tag) {
  if (server) { server.kill("SIGTERM"); await sleep(800); }
  port = await new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
  const fd = fs.openSync(path.join(LOG_DIR, `runbook-drill.${tag}.server.log`), "w");
  server = spawn(process.execPath, ["--require", path.join(HERE, "net-local-only.cjs"), "index.js"], { cwd: dir, stdio: ["ignore", fd, fd], env: {
    ...SHELL_ENV, NODE_ENV: "production", PORT: String(port), TRUST_PROXY_HOPS: "1", ALLOWED_ORIGINS: "https://admin.tanfs.net",
    USER_JWT_SECRET: crypto.randomBytes(32).toString("hex"), ADMIN_JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    SKIP_PDF_BOOT_CHECK: "1", SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "" } });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true; } catch { /* */ } await sleep(250); }
  return false;
}
/** ينفّذ أمر الكرّاس حرفياً في المجلد المنشور، بعنوان محلي بدل الإنتاج. */
function run(command, dir) {
  const local = command.replaceAll(PROD, `http://127.0.0.1:${port}`).replace("cd /opt/render/project/src && ", "");
  const r = spawnSync("bash", ["-c", local], { cwd: dir, encoding: "utf8", env: SHELL_ENV, timeout: 60000 });
  const outp = `${r.stdout}${r.stderr}`.trim();
  say(`  $ ${command.slice(0, 110)}${command.length > 110 ? "…" : ""}\n    ${outp.split("\n").join("\n    ")}`);
  return outp;
}

/* ---------- الخطوات ---------- */
ok("S1 الكود الحالي (main) يقلع على حالة الإنتاج", await deploy(MAIN_DIR, "main"));
let o = run(cmd("'SETUP_TOKEN','DATABASE_URL'"), MAIN_DIR);
ok("S1a أمر فحص المتغيّرات: الثلاثة present", (o.match(/present/g) || []).length === 3 && !/MISSING/.test(o));

ok("S2 نشر فرع التحضير", await deploy(PREP_DIR, "prep"));
o = run(cmd("migration-status"), PREP_DIR);
ok("S2a الحالة: الثماني الجديدة معلّقة وحدها", /^200 021_messaging_channels\.sql,.*027_official_name\.sql,DB007_official_seller_suffix\.sql$/m.test(o) && o.split(",").length === 8, o);
o = run(cmd("check-0013.mjs"), PREP_DIR);
ok("S2b الفحص قبل الترحيل: الترحيلات معلّقة، والاسم القديم ظاهر، والتسلسل جاهز", /CHECK MIGRATIONS pending: 021/.test(o) && /CHECK APP_NAME/.test(o) && /NEXT_INVOICE TNFS-INV-000001/.test(o), o);

o = run(cmd("run-migrations"), PREP_DIR);
ok("S3 تشغيل الترحيل: 200 والثماني applied", /^200 /.test(o) && (o.match(/:applied/g) || []).length === 8 && !/failed/.test(o), o);
o = run(cmd("migration-status"), PREP_DIR);
ok("S3a الحالة بعده: NONE PENDING", /^200 NONE PENDING$/m.test(o), o);
o = run(cmd("run-migrations"), PREP_DIR);
ok("S3b إعادة الأمر بلا أثر (NOTHING TO APPLY)", /^200 NOTHING TO APPLY$/m.test(o), o);
o = run(cmd("check-0013.mjs"), PREP_DIR);
ok("S3c الفحص بعده: الاسم والتذييل واللاحقة بالاسم الرسمي، والاسم النظامي كما هو، والتجديد بلا صفوف ومعطَّل",
  /OK    MIGRATIONS none pending/.test(o) && /OK    APP_NAME <تنفس بحرية>/.test(o) && /OK    SELLER_SUFFIX <\( خدمات منصة تنفس بحرية \)>/.test(o)
  && /LEGAL_NAME <أكاديمية علم النفس>/.test(o) && /OK    AUTORENEW_ROWS consents=0 cards=0 cycles=0 attempts=0/.test(o) && /OK    AUTORENEW_ENABLED absent/.test(o)
  && /OK    NEXT_INVOICE TNFS-INV-000001/.test(o) && /CHECK EMAIL_FROM <تنفس>/.test(o), o);

ok("S4 نشر المرشّح على المخطط الجاهز", await deploy(ROOT, "candidate"));
o = run(cmd("migration-status"), ROOT);
ok("S4a لا ترحيل معلّق عند نشر الكود (لا نافذة)", /^200 NONE PENDING$/m.test(o), o);
const login = await fetch(`http://127.0.0.1:${port}/admin/auth/me`);
ok("S4b اللوحة تجيب (401 بلا جلسة، لا 500)", login.status === 401, String(login.status));

SHELL_ENV.EMAIL_FROM = "تنفس بحرية <noreply@mg.acofps.com>";
o = run(cmd("check-0013.mjs"), ROOT);
ok("S5 بعد ضبط EMAIL_FROM: الفحص كله OK", !/^CHECK/m.test(o) && /OK    EMAIL_FROM <تنفس بحرية>/.test(o), o);

o = run(cmd("rollback-0013.mjs 026"), ROOT);
ok("S6 أمر تراجع بالترتيب الخطأ يُرفض بلا أثر", /STOP roll back in reverse order first/.test(o), o);
o = run(cmd("rollback-0013.mjs DB007"), ROOT);
ok("S6a DB007 بلا رجوع آلي — رسالة الطريق اليدوي", /STOP DB007_official_seller_suffix\.sql: no automatic rollback/.test(o), o);

server.kill("SIGTERM"); await sleep(500);
const pass = R.filter((x) => x.pass).length, fail = R.length - pass;
say(`\n  ${pass} passed, ${fail} failed`);
fs.writeFileSync(path.join(LOG_DIR, "runbook-drill.log"), lines.join("\n") + "\n");
fs.writeFileSync(path.join(LOG_DIR, "runbook-drill.json"), JSON.stringify({ results: R, commands: blocks }, null, 2));
process.exit(fail ? 1 : 0);
