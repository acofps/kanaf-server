/* ============================================================
   بروفة ترحيلات النشر — KANAF-ORD-0014 §2.4 و§3.3
     node test-support/ord14-migration-drill.mjs <main worktree 72551d3> <prep worktree>

   على قاعدة معزولة من قالب المخطط بنمط ملكية الإنتاج (الجداول لدور التطبيق، والتسلسلات
   لـpostgres مع UPDATE — test-support/setup-isolated-db.mjs)، وكل خطوة بدور التطبيق:

     A. حالة الإنتاج: db/migrate.js من main يطبّق 001…020 وDB006 — ثم قيم الإنتاج القديمة
        (الاسم والتذييل واللاحقة والاسم النظامي) وحجم تقديري سخيّ في الجدولين اللذين يعيد
        021 و025 فحص قيودهما: notification_deliveries وsystem_message_log.
     B. المرحلة الأولى (§3.3 أ): db/migrate.js من فرع التحضير (main + الترحيلات) يطبّق
        021…027 وDB007 — زمن كل ترحيلة من سجل المشغّل نفسه.
     C. ما بعدها: القيم الحيّة صُحِّحت، والاسم النظامي لم يُمسّ، ولا صف ضاع، والقيود صالحة،
        ونداء ثانٍ للمشغّل لا يجد شيئاً.
     D. التراجع (ops/rollback-0013.mjs) بالترتيب العكسي: 027/DB007 يُرفضان (لا رجوع آلي)،
        والباقي يُجرَّب ثم يُثبَّت — وبصمة المخطط تعود إلى ما كانت عليه في A حرفاً.
     E. التقدّم مجدداً بعد التراجع: المشغّل يعيد ما تراجع عنه بلا خطأ.
     N. سلبية: صلاحية ناقصة (جدول لا يملكه دور التطبيق / لا CREATE على المخطط) — تفشل
        الترحيلة نظيفة: لا عمود ولا جدول جزئي، ولا صفّ في schema_migrations، ويتوقف المشغّل.
   الناتج: test-support/.local/logs/ord0014/migration-drill.{log,json}
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const [MAIN_DIR, PREP_DIR] = process.argv.slice(2, 4).map((d) => d && path.resolve(d));
if (![MAIN_DIR, PREP_DIR].every((d) => d && fs.existsSync(path.join(d, "db", "migrate.js")))) {
  console.error("usage: node test-support/ord14-migration-drill.mjs <main dir> <prep dir>"); process.exit(2);
}
const LOG_DIR = path.join(HERE, ".local", "logs", "ord0014"); fs.mkdirSync(LOG_DIR, { recursive: true });
const lines = []; const say = (s) => { lines.push(s); console.log(s); };
const R = []; const ok = (label, cond, x = "") => { R.push({ label, pass: !!cond, detail: x }); say(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !x ? "" : `  (${String(x).slice(0, 300)})`}`); };
const obs = {}; const note = (k, v) => { obs[k] = v; say(`OBS   ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); };
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, ".local", "test-env.json"), "utf8"));
const rev = (d) => execFileSync("git", ["-C", d, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
note("trees", { main: rev(MAIN_DIR), prep: `${rev(MAIN_DIR)}+${fs.readdirSync(path.join(PREP_DIR, "db/migrations")).filter((f) => !fs.existsSync(path.join(MAIN_DIR, "db/migrations", f))).join(",")}` });

function newDb(purpose) {
  const out = execFileSync(process.execPath, [path.join(HERE, "create-db.mjs"), purpose, "schema"], { encoding: "utf8" });
  return { url: /TEST_DATABASE_URL='([^']+)'/.exec(out)[1], marker: /KANAF_TEST_MARKER='([^']+)'/.exec(out)[1] };
}
const superUrl = (db) => { const u = new URL(cfg.superuserUrl); u.pathname = `/${db}`; return u.toString(); };
const dbName = (url) => new URL(url).pathname.slice(1);

/** المشغّل الحقيقي db/migrate.js من شجرة معيّنة، بدور التطبيق، وزمن كل ملف من سجلّه هو. */
function runMigrator(dir, db) {
  const script = `
    import "${path.join(dir, "test-support/guard.mjs")}";
    const { runMigrations } = await import("${path.join(dir, "db/migrate.js")}");
    const { pool } = await import("${path.join(dir, "db/pool.js")}");
    const t = {}; let cur = null, t0 = 0;
    const results = await runMigrations({ log: (m) => {
      const a = /Applying migration: (\\S+)/.exec(m); if (a) { cur = a[1]; t0 = performance.now(); }
      if (/applied: |FAILED: /.test(m) && cur) { t[cur] = Math.round(performance.now() - t0); }
    }});
    await pool.end();
    console.log("RESULT " + JSON.stringify({ results, ms: t }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TEST_DATABASE_URL: db.url, KANAF_TEST_MARKER: db.marker, NODE_ENV: "test" },
  });
  const m = /RESULT (.*)/.exec(r.stdout || "");
  if (!m) return { crashed: true, results: [], error: (/error: ([^\n]+)/.exec(r.stderr || "") || [, (r.stderr || "").slice(-200)])[1] };
  return JSON.parse(m[1]);
}

async function fingerprint(c) {
  const cols = (await c.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name <> 'kanaf_test_env_marker' ORDER BY 1, 2`)).rows;
  const cons = (await c.query(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`)).rows;
  const idx = (await c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`)).rows;
  return JSON.stringify({ cols, cons, idx });
}
const counts = async (c) => (await c.query(`SELECT
  (SELECT count(*)::int FROM users) users, (SELECT count(*)::int FROM notification_deliveries) deliveries,
  (SELECT count(*)::int FROM system_message_log) sysmsg, (SELECT count(*)::int FROM admin_users) admins,
  (SELECT count(*)::int FROM invoices) invoices`)).rows[0];

const SCALE = { users: Number(process.env.DRILL_USERS || 20000), campaigns: Number(process.env.DRILL_CAMPAIGNS || 25), sysmsg: Number(process.env.DRILL_SYSMSG || 1000000) };

/* ========================== A ========================== */
const db = newDb("ord14-drill");
const c = new pg.Client({ connectionString: db.url, ssl: false }); await c.connect();
const A = runMigrator(MAIN_DIR, db);
ok("A1 main يطبّق ترحيلاته بدور التطبيق (حالة الإنتاج: 001…020 + DB006)", A.results.every((r) => r.status === "applied"), A.results.filter((r) => r.status !== "applied").map((r) => r.filename).join(","));
note("A.applied", A.results.map((r) => r.filename).join(" "));
/* الإنتاج كما قاسه مسبار ORD-0012 (أمر ORD-0013 §2.3): التسلسلات الأربعة يملكها المستخدم الفائق،
   ولدور التطبيق SELECT/USAGE/UPDATE. 005 هنا أنشأ kanaf_* بدور التطبيق، فتُنقل ملكيتها لتطابق الإنتاج. */
{
  const su0 = new pg.Client({ connectionString: superUrl(dbName(db.url)), ssl: false }); await su0.connect();
  for (const sq of ["kanaf_invoice_number_seq", "kanaf_credit_note_number_seq"]) {
    await su0.query(`ALTER SEQUENCE ${sq} OWNER TO CURRENT_USER`);
    await su0.query(`GRANT SELECT, USAGE, UPDATE ON SEQUENCE ${sq} TO ${cfg.runtimeRole}`);
  }
  await su0.end();
}
const own = (await c.query(`SELECT tableowner, count(*)::int n FROM pg_tables WHERE schemaname='public' AND tablename <> 'kanaf_test_env_marker' GROUP BY 1`)).rows;
const seqOwn = (await c.query(`SELECT DISTINCT sequenceowner FROM pg_sequences WHERE schemaname='public'`)).rows.map((r) => r.sequenceowner);
const seqPriv = (await c.query(`SELECT bool_and(has_sequence_privilege(sequencename, 'UPDATE')) ok FROM pg_sequences WHERE schemaname='public'`)).rows[0].ok;
ok("A2 نمط ملكية الإنتاج: كل الجداول لدور التطبيق، والتسلسلات الأربعة لغيره مع UPDATE له", own.length === 1 && own[0].tableowner === cfg.runtimeRole && !seqOwn.includes(cfg.runtimeRole) && seqPriv === true, JSON.stringify({ own, seqOwn, seqPriv }));

/* قيم الإنتاج كما زرعها 008/DB006 الأصليان، واسم نظامي يحمل الاسم القديم (لا يُمسّ) */
await c.query(`INSERT INTO tax_settings (singleton, legal_name, vat_number, address) VALUES (true, 'أكاديمية علم النفس', '300000000000003', 'جدة') ON CONFLICT (singleton) DO NOTHING`);
await c.query(`INSERT INTO billing_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`);
const t0 = Date.now();
await c.query(`INSERT INTO users (name, email, password_hash, email_verified_at, confirmed_adult)
  SELECT 'عضو ' || g, 'drill' || g || '@example.com', 'x', now(), true FROM generate_series(1, $1) g`, [SCALE.users]);
const { rows: [adm] } = await c.query(`INSERT INTO admin_users (name, email, password_hash, role) VALUES ('مالك', 'drill-owner@kanaf.test', 'x', 'owner') RETURNING id`);
await c.query(`INSERT INTO admin_users (name, email, password_hash, role) SELECT 'مشرف ' || g, 'drill-adm' || g || '@kanaf.test', 'x', 'admin' FROM generate_series(1, 19) g`);
await c.query(`INSERT INTO notification_campaigns (title, body, audience, channels, status, created_by)
  SELECT 'حملة ' || g, 'نص', 'all', ARRAY['in_app','email','push'], 'sent', $1 FROM generate_series(1, $2) g`, [adm.id, SCALE.campaigns]);
await c.query(`INSERT INTO notification_deliveries (campaign_id, user_id, channel, status)
  SELECT nc.id, u.id, ch, 'sent' FROM notification_campaigns nc CROSS JOIN users u CROSS JOIN unnest(ARRAY['in_app','email']) ch`);
await c.query(`INSERT INTO system_message_log (user_id, kind, channel, status)
  WITH u AS (SELECT id, (row_number() OVER ()) - 1 AS rn FROM users)
  SELECT u.id, (ARRAY['email_verification','password_reset','daily_reminder'])[1 + (g % 3)], (ARRAY['email','push'])[1 + (g % 2)], 'sent'
    FROM generate_series(1, $1) g JOIN u ON u.rn = g % $2`, [SCALE.sysmsg, SCALE.users]);
await c.query("ANALYZE");
const C0 = await counts(c);
note("A.volume", { ...C0, seededInSeconds: Math.round((Date.now() - t0) / 1000) });
const plansBefore = (await c.query(`SELECT plan_key, features FROM subscription_plans ORDER BY plan_key`)).rows;
const FP0 = await fingerprint(c);

/* ========================== B ========================== */
const B = runMigrator(PREP_DIR, db);
const newOnes = B.results.filter((r) => r.status !== "skipped");
ok("B1 فرع التحضير يطبّق الترحيلات الجديدة كلها بدور التطبيق بلا فشل", newOnes.length === 8 && newOnes.every((r) => r.status === "applied"), JSON.stringify(newOnes));
note("B.ms_per_migration", B.ms);
note("B.total_ms", Object.values(B.ms).reduce((a, b) => a + b, 0));

/* ========================== C ========================== */
const v = (await c.query(`SELECT (SELECT value #>> '{}' FROM app_settings WHERE key='app_public_name') name,
  (SELECT value #>> '{}' FROM app_settings WHERE key='marketing_email_footer') footer,
  (SELECT seller_display_suffix FROM billing_settings) suffix, (SELECT legal_name FROM tax_settings) legal`)).rows[0];
ok("C1 القيم الحيّة بالاسم الرسمي (الاسم والتذييل ولاحقة البائع)", v.name === "تنفس بحرية" && v.footer === "وصلتك هذه الرسالة لأنك مسجّل في تنفس بحرية." && v.suffix === "( خدمات منصة تنفس بحرية )", JSON.stringify(v));
ok("C2 🔴 الاسم النظامي لم يُمسّ", v.legal === "أكاديمية علم النفس");
const plansAfter = (await c.query(`SELECT plan_key, features FROM subscription_plans ORDER BY plan_key`)).rows;
ok("C3 ميزات الباقات: الاسم وحده تغيّر، والعدد والترتيب كما هما", plansAfter.every((p, i) => p.features.length === plansBefore[i].features.length
  && p.features.every((f, j) => f.replace(/تنفس بحرية/g, "تنفس") === plansBefore[i].features[j].replace(/كنف/g, "تنفس"))), JSON.stringify(plansAfter.map((p) => p.features)));
const C1 = await counts(c);
ok("C4 لا صفّ ضاع أو زاد في الجداول القائمة", JSON.stringify(C1) === JSON.stringify(C0), JSON.stringify(C1));
const invalid = (await c.query(`SELECT count(*)::int n FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND NOT convalidated`)).rows[0].n;
ok("C5 كل القيود صالحة (لا NOT VALID معلّق)", invalid === 0, String(invalid));
const B2 = runMigrator(PREP_DIR, db);
ok("C6 نداء ثانٍ للمشغّل لا يجد شيئاً معلّقاً", B2.results.every((r) => r.status === "skipped"));
const Bcand = runMigrator(ROOT, db);
ok("C7 ومشغّل المرشّح نفسه لا يجد شيئاً معلّقاً (لا نافذة عند دمج الكود)", Bcand.results.every((r) => r.status === "skipped"));

/* ========================== D ========================== */
process.env.DATABASE_URL = db.url;
const { rollback } = await import(path.join(ROOT, "ops/rollback-0013.mjs"));
const rb = (key, apply) => { const log = []; return rollback({ connectionString: db.url, ssl: false, key, apply, log: (s) => log.push(s) }).then((r) => ({ ...r, log })); };
let r = await rb("026", false);
ok("D1 تراجع 026 قبل DB007/027 مرفوض (الترتيب العكسي)", !r.ok && r.log.some((l) => /reverse order/.test(l)), r.log.join(" | "));
r = await rb("DB007", false);
ok("D2 DB007 وقبله 027 بلا رجوع آلي — رسالة صريحة بالطريق اليدوي", !r.ok && r.manual && r.log.some((l) => /no automatic rollback/.test(l)), r.log.join(" | "));
// ليُختبر تراجع 026…021 بالترتيب: يُخرج 027 وDB007 من schema_migrations يدوياً كما يفعل من قرّر التراجع عنهما
await c.query(`DELETE FROM schema_migrations WHERE filename IN ('027_official_name.sql', 'DB007_official_seller_suffix.sql')`);
const rbMs = {};
for (const key of ["026", "025", "024", "023", "022", "021"]) {
  const dry = await rb(key, false);
  const fpDry = await fingerprint(c);
  const tR = performance.now();
  const app = await rb(key, true);
  rbMs[key] = Math.round(performance.now() - tR);
  ok(`D3.${key} التجربة لا تغيّر شيئاً، والتثبيت ينجح`, dry.ok && !dry.applied && app.ok && app.applied && fpDry !== null, [...dry.log, ...app.log].join(" | "));
}
note("D.rollback_ms", rbMs);
const FP1 = await fingerprint(c);
ok("D4 🔴 بعد التراجع: بصمة المخطط (أعمدة وقيود وفهارس) = حالة الإنتاج قبل B حرفاً", FP1 === FP0, FP1 === FP0 ? "" : "اختلاف في البصمة");
ok("D5 ولا صفّ ضاع من الجداول القائمة", JSON.stringify(await counts(c)) === JSON.stringify(C0));
r = await rb("021", false);
ok("D6 تراجع ما لم يُطبَّق يُرفض بلا أثر", !r.ok && r.log.some((l) => /not applied/.test(l)));

/* ========================== E ========================== */
const E = runMigrator(PREP_DIR, db);
ok("E1 التقدّم بعد التراجع: المشغّل يعيد تطبيق ما تراجع عنه بلا خطأ", E.results.filter((x) => x.status === "applied").length === 8 && !E.results.some((x) => x.status === "failed"), JSON.stringify(E.results.filter((x) => x.status !== "skipped")));
await c.end();

/* ========================== N ========================== */
async function negative(id, label, breakSql, expectFile) {
  const nd = newDb(`ord14-neg-${id}`);
  runMigrator(MAIN_DIR, nd);
  const su = new pg.Client({ connectionString: superUrl(dbName(nd.url)), ssl: false }); await su.connect();
  const nc = new pg.Client({ connectionString: nd.url, ssl: false }); await nc.connect();
  await su.query(breakSql.replaceAll("$ROLE", cfg.runtimeRole));
  const fpBefore = await fingerprint(nc);
  const res = runMigrator(PREP_DIR, nd);
  const failed = res.results.find((x) => x.status === "failed");
  const appliedFiles = (await nc.query(`SELECT filename FROM schema_migrations`)).rows.map((x) => x.filename);
  const fpAfter = await fingerprint(nc);
  const idx = res.results.findIndex((x) => x.status === "failed");
  const afterFail = res.results.slice(idx + 1);
  // أثر الترحيلات الناجحة قبلها متوقَّع؛ المطلوب: لا أثر للفاشلة ولا لما بعدها
  ok(`N${id} ${label}`, failed?.filename === expectFile && !appliedFiles.includes(expectFile) && afterFail.length === 0
    && res.results.filter((x) => x.status === "applied").every((x) => appliedFiles.includes(x.filename)),
    `${failed?.filename}: ${String(failed?.error || "").slice(0, 120)}`);
  note(`N${id}.applied_before_failure`, res.results.filter((x) => x.status === "applied").map((x) => x.filename));
  await nc.end(); await su.end();
  return { fpBefore, fpAfter };
}
await negative("1", "جدول لا يملكه دور التطبيق → 022 (ALTER admin_users) تفشل نظيفة: لا عمود phone، لا صفّ، والمشغّل يتوقف",
  `ALTER TABLE admin_users OWNER TO CURRENT_USER; REVOKE ALL ON admin_users FROM $ROLE; GRANT SELECT, INSERT, UPDATE, DELETE ON admin_users TO $ROLE;`, "022_admin_phone_and_page_grants.sql");
{
  const nd = newDb("ord14-neg-1b");
  runMigrator(MAIN_DIR, nd);
  const su = new pg.Client({ connectionString: superUrl(dbName(nd.url)), ssl: false }); await su.connect();
  await su.query(`ALTER TABLE admin_users OWNER TO CURRENT_USER; GRANT SELECT, INSERT, UPDATE, DELETE ON admin_users TO ${cfg.runtimeRole}`);
  runMigrator(PREP_DIR, nd);
  const phone = (await su.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'admin_users' AND column_name IN ('phone','page_grants')`)).rows[0].n;
  ok("N1b ولا أثر جزئي: admin_users بلا phone ولا page_grants", phone === 0, String(phone));
  await su.end();
}
{
  /* N2: بلا CREATE على المخطط لا يبلغ المشغّل أي ترحيلة: «CREATE TABLE IF NOT EXISTS schema_migrations»
     في أوله يتطلب الصلاحية حتى والجدول موجود، فيتوقف عند الإقلاع — ولا أثر لشيء. */
  const nd = newDb("ord14-neg-2");
  runMigrator(MAIN_DIR, nd);
  const su = new pg.Client({ connectionString: superUrl(dbName(nd.url)), ssl: false }); await su.connect();
  await su.query(`REVOKE CREATE ON SCHEMA public FROM ${cfg.runtimeRole}`);
  const nc = new pg.Client({ connectionString: nd.url, ssl: false }); await nc.connect();
  const fpBefore = await fingerprint(nc);
  const migBefore = (await nc.query(`SELECT count(*)::int n FROM schema_migrations`)).rows[0].n;
  const res = runMigrator(PREP_DIR, nd);
  const fpAfter = await fingerprint(nc);
  const migAfter = (await nc.query(`SELECT count(*)::int n FROM schema_migrations`)).rows[0].n;
  ok("N2 لا CREATE على المخطط → المشغّل يتوقف عند إقلاعه برفض صلاحية، ولا ترحيلة تُطبَّق، والمخطط كما كان حرفاً",
    (res.crashed || res.results.some((x) => x.status === "failed")) && migAfter === migBefore && fpAfter === fpBefore, JSON.stringify({ crashed: res.crashed, error: res.error, migBefore, migAfter }));
  note("N2.error", res.error || (res.results.find((x) => x.status === "failed") || {}).error);
  await nc.end(); await su.end();
}

const pass = R.filter((x) => x.pass).length, fail = R.length - pass;
say(`\n  ${pass} passed, ${fail} failed`);
fs.writeFileSync(path.join(LOG_DIR, "migration-drill.log"), lines.join("\n") + "\n");
fs.writeFileSync(path.join(LOG_DIR, "migration-drill.json"), JSON.stringify({ results: R, observations: obs, scale: SCALE }, null, 2));
process.exit(fail ? 1 : 0);
