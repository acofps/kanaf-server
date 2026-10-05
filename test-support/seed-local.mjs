/* بذر حسابات اصطناعية في قاعدة الاختبار المعزولة (خلف الحارس).
     node test-support/seed-local.mjs
   ينشئ مالكاً إدارياً ومستخدماً موثّقاً بكلمات مرور اصطناعية تُطبع
   مرة واحدة وتُكتب في test-support/.local/seed.json (مستثنى من git). */
import "./guard.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const { query, pool } = await import("../db/pool.js");
const { hashPassword } = await import("../admin/auth.js");
const bcrypt = (await import("bcrypt")).default;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pw = () => crypto.randomBytes(12).toString("base64url");
const seed = {
  owner: { email: "owner@kanaf.test", password: pw() },
  user: { email: "user1@kanaf.test", password: pw() },
  user2: { email: "user2@kanaf.test", password: pw() },
};
await query(`INSERT INTO admin_users (name, email, password_hash, role) VALUES ('مالك اختبار', $1, $2, 'owner')
             ON CONFLICT DO NOTHING`, [seed.owner.email, await hashPassword(seed.owner.password)]);
/* بقية الأدوار — لاختبار الصلاحيات عبر الواجهة. المحاسب أساسه support
   ودوره الفعلي في admin_role_assignments (كما في الإنتاج). */
for (const [k, role, assigned] of [["admin", "admin"], ["support", "support"], ["content", "content_manager"], ["accountant", "support", "accountant"]]) {
  seed[k] = { email: `${k}@kanaf.test`, password: pw() };
  const { rows } = await query(`INSERT INTO admin_users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`${k} اختبار`, seed[k].email, await hashPassword(seed[k].password), role]);
  if (assigned) await query(`INSERT INTO admin_role_assignments (admin_user_id, role) VALUES ($1, $2)`, [rows[0].id, assigned]);
}
/* بيانات بائع اصطناعية — بدونها لا تصدر أرقام فواتير ضريبية ولا إشعارات
   دائنة (السلوك الصحيح للنظام). ليست بيانات المالك الحقيقية. */
await query(`INSERT INTO tax_settings (singleton, legal_name, vat_number, address) VALUES (true, 'مؤسسة اختبار كنف', '399999999900003', 'جدة')
             ON CONFLICT (singleton) DO NOTHING`);
for (const k of ["user", "user2"]) {
  await query(`INSERT INTO users (name, email, password_hash, confirmed_adult, agreed_policy_at, email_verified_at)
               VALUES ($1, $2, $3, true, now(), now()) ON CONFLICT DO NOTHING`,
    [k === "user" ? "مستخدم اختبار" : "مستخدم ثانٍ", seed[k].email, await bcrypt.hash(seed[k].password, 12)]);
}
fs.writeFileSync(path.join(HERE, ".local", "seed.json"), JSON.stringify(seed, null, 2), { mode: 0o600 });
console.log("seeded", Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.email])));
await pool.end();
