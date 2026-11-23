import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0014 §2.2.2 — الترحيلتان 027 وDB007 على قاعدة فعلية، بدور التطبيق.
 *  F) قاعدة جديدة (القالب المُرحَّل): الزرع القديم صُحِّح بالترتيب الصحيح (DB007 بعد DB006).
 *  P) حالة تشبه الإنتاج: قيم بالاسم القديم وأخرى عدّلها المالك — يُستبدل القديم المطابق حرفياً
 *     وحده، ويبقى ما عدّله المالك، و«تنفس+» و«تنفس بحرية» و«التنفس» (كلمة عادية) كما هي.
 *  L) 🔴 tax_settings.legal_name لا يُمسّ ولو حمل «كنف».
 *  I) الإعادة بلا أثر.
 */
requireDedicatedDatabase(import.meta.url);
import fs from "node:fs";
const { query, pool } = await import("./db/pool.js");
const out = (s) => process.stdout.write(s + "\n");
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const sql027 = fs.readFileSync("db/migrations/027_official_name.sql", "utf8");
const sqlDB007 = fs.readFileSync("db/migrations/DB007_official_seller_suffix.sql", "utf8");
const setting = async (k) => (await query(`SELECT value #>> '{}' AS v FROM app_settings WHERE key = $1`, [k])).rows[0]?.v;
const suffix = async () => (await query(`SELECT seller_display_suffix AS s FROM billing_settings`)).rows[0]?.s;

try {
  /* ---------- F) قاعدة جديدة ---------- */
  const { rows: mig } = await query(`SELECT filename FROM schema_migrations WHERE filename IN ('027_official_name.sql', 'DB007_official_seller_suffix.sql', 'DB006_invoice_presentation.sql') ORDER BY applied_at, filename`);
  ok("F1 027 وDB007 مطبَّقتان، وDB007 بعد DB006", mig.length === 3 && mig.map((r) => r.filename).indexOf("DB007_official_seller_suffix.sql") > mig.map((r) => r.filename).indexOf("DB006_invoice_presentation.sql"), JSON.stringify(mig));
  ok("F2 الاسم التجاري وتذييل التسويق على قاعدة جديدة بالاسم الرسمي", await setting("app_public_name") === "تنفس بحرية" && await setting("marketing_email_footer") === "وصلتك هذه الرسالة لأنك مسجّل في تنفس بحرية.");
  ok("F3 لاحقة البائع على قاعدة جديدة بالاسم الرسمي (DB006 زرع القديم ثم صحّحه DB007)", await suffix() === "( خدمات منصة تنفس بحرية )", await suffix());
  const { rows: [mp] } = await query(`SELECT features FROM subscription_plans WHERE plan_key = 'monthly'`);
  ok("F4 ميزات الباقة المزروعة بالاسم الرسمي وترتيبها محفوظ", mp.features[0] === "كل أدوات تنفس بحرية الأربع" && mp.features[1] === "بوصلة تنفس بحرية الكاملة" && mp.features[3] === "مناقشة سند غير محدودة", JSON.stringify(mp.features));

  /* ---------- P) حالة تشبه الإنتاج ---------- */
  await query(`UPDATE app_settings SET value = '"كنف"'::jsonb WHERE key = 'app_public_name'`);
  await query(`UPDATE app_settings SET value = '"نص كتبه المالك عن كنف بنفسه"'::jsonb WHERE key = 'marketing_email_footer'`);
  await query(`UPDATE app_settings SET description = 'plus_only (مشترك كنف+ مستحق) وتنفس+ وتنفس بحرية' WHERE key = 'assistant_access_policy'`);
  await query(`UPDATE billing_settings SET seller_display_suffix = '( خدمات منصة كنف )'`);
  await query(`INSERT INTO tax_settings (singleton, legal_name, vat_number, address) VALUES (true, 'مؤسسة كنف للتقنية', '300000000000003', 'جدة')
               ON CONFLICT (singleton) DO UPDATE SET legal_name = EXCLUDED.legal_name`);
  await query(`INSERT INTO subscription_plans (plan_key, name, price_sar, duration_days, features, display_order) VALUES
    ('p14_plan', 'باقة كنف+', 9, 30, ARRAY['كل أدوات كنف', 'ميزة تنفس+ كاملة', 'بوصلة تنفس', 'تمرين التنفس العميق', 'مكتبة تنفس بحرية'], 9)`);
  const before = { legal: (await query(`SELECT legal_name FROM tax_settings`)).rows[0].legal_name };
  await query("BEGIN"); await query(sql027); await query(sqlDB007); await query("COMMIT");

  ok("P1 الاسم التجاري المطابق حرفياً للقديم («كنف») ← «تنفس بحرية»", await setting("app_public_name") === "تنفس بحرية");
  ok("P2 🔴 تذييل عدّله المالك لا يُمسّ ولو ذكر «كنف»", await setting("marketing_email_footer") === "نص كتبه المالك عن كنف بنفسه");
  const desc = (await query(`SELECT description FROM app_settings WHERE key = 'assistant_access_policy'`)).rows[0].description;
  ok("P3 الوصف: «كنف+» ← «تنفس+»، و«تنفس+» و«تنفس بحرية» القائمان كما هما", desc === "plus_only (مشترك تنفس+ مستحق) وتنفس+ وتنفس بحرية", desc);
  ok("P4 لاحقة البائع القديمة ← الرسمية", await suffix() === "( خدمات منصة تنفس بحرية )");
  const { rows: [pp] } = await query(`SELECT name, features FROM subscription_plans WHERE plan_key = 'p14_plan'`);
  ok("P5 اسم الباقة: «باقة كنف+» ← «باقة تنفس+»", pp.name === "باقة تنفس+", pp.name);
  ok("P6 الميزات: الاسم وحده يُستبدل؛ «تنفس+» و«التنفس» (كلمة عادية) و«تنفس بحرية» تبقى؛ الترتيب محفوظ",
    JSON.stringify(pp.features) === JSON.stringify(["كل أدوات تنفس بحرية", "ميزة تنفس+ كاملة", "بوصلة تنفس بحرية", "تمرين التنفس العميق", "مكتبة تنفس بحرية"]), JSON.stringify(pp.features));

  /* ---------- L) ---------- */
  ok("L1 🔴 tax_settings.legal_name لم يُمسّ ولو حمل «كنف»", (await query(`SELECT legal_name FROM tax_settings`)).rows[0].legal_name === before.legal && before.legal === "مؤسسة كنف للتقنية");

  /* ---------- I) ---------- */
  const snap = async () => JSON.stringify([
    (await query(`SELECT key, value, description, updated_at FROM app_settings ORDER BY key`)).rows,
    (await query(`SELECT seller_display_suffix, updated_at FROM billing_settings`)).rows,
    (await query(`SELECT plan_key, name, features, updated_at FROM subscription_plans ORDER BY plan_key`)).rows]);
  const s1 = await snap();
  await query("BEGIN"); await query(sql027); await query(sqlDB007); await query("COMMIT");
  ok("I1 الإعادة لا تغيّر شيئاً (ولا updated_at)", (await snap()) === s1);
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 400), false); }
finally { await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; out(`  PASS  ${l}`); } else { fail++; out(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 400)})` : ""}`); } }
out(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
