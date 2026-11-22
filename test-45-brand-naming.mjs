import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * ملحق KANAF-ORD-0013 — قرارا المالك 3 و4 (فحص ثابت على الشجرة، بلا قاعدة).
 *  K1) لا «كنف» — بالتشكيل والتطويل أيضاً — في أي ملف من الكود أو الزرع أو اللوحة المبنية.
 *      الاستثناء الوحيد: حارس اختبار يبحث عن الكلمة نفسها (test-33 M2، وهذا الملف).
 *      الوثائق التاريخية (docs/ord-0012، وتسليم ORD-0013 الأصلي) خارج الفحص — سجلات لا نصوص منتج.
 *  K2) لا «كنف+»؛ والباقة «تنفس+» في وصف صفحة الدفع وسطر الفاتورة والإشعار الدائن — لا «تنفس بحرية+».
 *  K3) العلامة الكاملة «تنفس بحرية» في نص سياسة الاسترداد وقيم الزرع ولاحقة البائع.
 *  T)  الملحق الثاني، القرار 5: «تنفس» المجرّدة (الاسم وحده) ← «تنفس بحرية»، و«تنفس+» كما هي.
 *      T1 صفر «تنفس» مجرّدة في كل ملف كود ولوحة واختبار وزرع، وفي اللوحة المبنية.
 *      T2 المواصفات الحيّة: لا مجرّدة إلا الاقتباسين الحرفيين من التطبيق (موسومين).
 *      T3 نصّ الموافقة بالاسم الرسمي ونسخته 2026-11-v2.  T4 «تنفس+» باقية.
 *  K4) الاستثناءان: أرقام INV-KANAF-000001..3 الصادرة لا يُعاد كتابتها في أي ترحيلة،
 *      والمعرّفات التقنية باقية (kanaf-server.onrender.com، kanaf_kanaf، الكوكي، الأقفال، الحدث الداخلي).
 */
requireDedicatedDatabase(import.meta.url);
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const out = (s) => process.stdout.write(s + "\n");
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const KANAF = /ك[ً-ْـ]*ن[ً-ْـ]*ف/;
const read = (f) => fs.readFileSync(f, "utf8");

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean)
  .filter((f) => !/\.(png|ttf|woff2?|pdf|ico|svg|md)$/.test(f) && f !== "package-lock.json" && !f.startsWith("docs/") && !f.startsWith("admin-ui/"));
const GUARDS = new Set(["test-33-system-mail-mime.mjs", "test-45-brand-naming.mjs"]);
/* KANAF-ORD-0014 §2.2: ما طُبِّق على الإنتاج يبقى كما طُبِّق (يصف ما جرى)، فهو خارج الفحص النصّي —
   وفحصه أنه **مطابق بايتاً لـmain 72551d3** (K1d). والترحيلتان اللتان تصحّحان القيم الحيّة تذكران
   الاسم القديم في شروط البحث وحدها. */
const APPLIED = ["db/migrations/007_content_and_notifications.sql", "db/migrations/008_rbac_audit_settings.sql",
  "db/migrations/012_assistant_access_policy.sql", "db/migrations/DB006_invoice_presentation.sql", "db/schema.sql"];
const NAME_FIX_MIGRATIONS = ["db/migrations/027_official_name.sql", "db/migrations/DB007_official_seller_suffix.sql"];
/* KANAF-ORD-0014: ما يزرع الاسم القديم أو يبحث عنه ليثبت أنه يُستبدل — لا يعرضه لأحد:
   اختبار الترحيلة، وبروفتا الترحيل والكرّاس (حالة الإنتاج القديمة)، وأداة الفحص (نمط بحث). */
const NAME_FIX_PROOFS = ["test-47-official-name-migration.mjs", "test-support/ord14-migration-drill.mjs", "test-support/ord14-runbook-drill.mjs", "ops/check-0013.mjs"];
const EXEMPT = new Set([...GUARDS, ...APPLIED, ...NAME_FIX_MIGRATIONS, ...NAME_FIX_PROOFS]);
const hits = [];
for (const f of files) {
  if (EXEMPT.has(f)) continue;
  let src; try { src = read(f); } catch { continue; }
  src.split("\n").forEach((l, i) => { if (KANAF.test(l)) hits.push(`${f}:${i + 1}`); });
}
const bundle = read("admin-ui/assets/app.js") + read("admin-ui/index.html");
ok(`K1 🔴 لا «كنف» (بالتشكيل والتطويل) في ${files.length} ملفاً من الكود والزرع والاختبارات`, hits.length === 0, hits.join(" "));
ok("K1b ولا في اللوحة المبنية (admin-ui)", !KANAF.test(bundle));
const changedApplied = APPLIED.filter((f) => {
  try { return execFileSync("git", ["show", `72551d3:${f}`], { encoding: "utf8" }) !== read(f); } catch { return false; }
});
ok("K1d 🔴 الترحيلات المطبَّقة على الإنتاج (007، 008، 012، DB006، schema.sql) مطابقة بايتاً لـmain 72551d3", changedApplied.length === 0, changedApplied.join(" "));
ok("K1c حارسا الاختبار يذكرانها بحثاً لا عرضاً (test-33 M2 وحده خارج هذا الملف)", [...GUARDS].every((g) => fs.existsSync(g)));

const plusSites = { "payments/routes.js": "اشتراك تنفس+ —", "invoicing/generate.js": "اشتراك تنفس+ —", "invoicing/pdf.js": "استرداد اشتراك تنفس+" };
const plusMissing = Object.entries(plusSites).filter(([f, s]) => !read(f).includes(s)).map(([f]) => f);
ok("K2 «اشتراك تنفس+» في وصف صفحة الدفع وسطر الفاتورة والإشعار الدائن", plusMissing.length === 0, plusMissing.join(" "));
ok("K2b لا «كنف+» ولا «تنفس بحرية+» في أي ملف", !files.some((f) => !EXEMPT.has(f) && /كنف\+|تنفس بحرية\+/.test(fs.existsSync(f) ? read(f) : "")));

ok("K3 سياسة الاسترداد في الفاتورة: «منصة تنفس بحرية»", read("invoicing/template.js").includes("الاشتراك في منصة تنفس بحرية خدمة رقمية"));
const m027 = read(NAME_FIX_MIGRATIONS[0]), mDB007 = read(NAME_FIX_MIGRATIONS[1]);
ok("K3b القيم الحيّة تصحّحها 027 وDB007 (بشرط مطابقة حرفية، والسلوك على القاعدة في test-47)",
  m027.includes(`'"تنفس بحرية"'::jsonb`) && m027.includes("مسجّل في تنفس بحرية.") && mDB007.includes("'( خدمات منصة تنفس بحرية )'")
  && !/legal_name|zatca_invoice_number|document_number_token\s*=/.test(m027.replace(/--[^\n]*/g, "") + mDB007.replace(/--[^\n]*/g, "")));
ok("K3c موجِّه المساعد يسمّي التطبيق «تنفس بحرية»", (read("index.js").match(/«تنفس بحرية»/g) || []).length === 2 && !/اسمه Kanaf|تطبيق Kanaf/.test(read("index.js")));

/* ---------- T) القرار 5 ---------- */
const AR = "\u0621-\u064A\u0640\u064B-\u0652";
const BARE = new RegExp(`(?<![${AR}])تنفس(?![${AR}])(?!\\s*بحرية)(?!\\+)`);
const bare = [];
for (const f of files) {
  if (EXEMPT.has(f)) continue;
  let src; try { src = read(f); } catch { continue; }
  // استثناء واحد: سجلّ نسخ نصّ الموافقة يقتبس نصّ v1 كما وافق عليه أصحابه (billing/autorenew.js).
  src.split("\n").forEach((l, i) => { if (BARE.test(l) && !(f === "billing/autorenew.js" && /2026-11-v1:/.test(l))) bare.push(`${f}:${i + 1}`); });
}
ok(`T1 🔴 صفر «تنفس» مجرّدة في ${files.length} ملفاً (كود، لوحة، زرع، اختبارات، أمثلة البيئة)`, bare.length === 0, bare.join(" "));
ok("T1b ولا في اللوحة المبنية", !BARE.test(bundle));
const specBare = ["docs/ord-0013/APP_AUTORENEW_SPEC.md", "docs/ord-0013/APP_NAMING_SPEC.md"].flatMap((f) => read(f).split("\n").map((l, i) => [f, i + 1, l]))
  .filter(([, , l]) => BARE.test(l) && !/لا خصم تلقائياً في تنفس أصلاً|ما فيه خصم تلقائي في تنفس|«تنفس» المجرّدة|«…أن يجدّد تنفس اشتراكي…»|«تنفس»|grep -rnP/.test(l));
ok("T2 المواصفات الحيّة بلا «تنفس» مجرّدة إلا الاقتباسات الحرفية الموسومة", specBare.length === 0, specBare.map(([f, i]) => `${f}:${i}`).join(" "));
const ar = await import("./billing/autorenew.js");
ok("T3 نصّ الموافقة بالاسم الرسمي، ونسخته رُفعت إلى 2026-11-v2", ar.CONSENT_VERSION === "2026-11-v2"
  && ar.consentText({ plan: "س", amount: "1", last4: "1111", days: 3 }).startsWith("أوافق على أن يجدّد تنفس بحرية اشتراكي"));
ok("T4 «تنفس+» باقية كما هي (الدفع، الفاتورة، الإشعار الدائن)", Object.entries(plusSites).every(([f, x]) => read(f).includes(x)));

const migs = fs.readdirSync("db/migrations").map((f) => read(`db/migrations/${f}`)).join("\n");
ok("K4 🔴 لا ترحيلة تعيد كتابة أرقام الوثائق الصادرة (INV-KANAF-…)", !/UPDATE\s+invoices[\s\S]{0,200}zatca_invoice_number\s*=/i.test(migs) && !/UPDATE\s+credit_notes[\s\S]{0,200}number\s*=/i.test(migs));
ok("K4b المعرّفات التقنية باقية: الحدث الداخلي، كوكي الإدارة، دور الإنتاج في الحارس",
  read("admin-src/src/api.js").includes("kanaf-admin-session-expired") && read("admin/auth.js").includes("kanaf_admin_access") && read("test-support/guard.mjs").includes("kanaf_kanaf"));

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; out(`  PASS  ${l}`); } else { fail++; out(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 400)})` : ""}`); } }
out(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
