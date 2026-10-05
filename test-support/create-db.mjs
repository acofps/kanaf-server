/* ينشئ قاعدة معزولة من القالب لغرض محدد ويطبع سطور env لها.
     node test-support/create-db.mjs <purpose> [schema|migrated]
   مثال: eval "$(node test-support/create-db.mjs local-server)" */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, ".local", "test-env.json"), "utf8"));
const purpose = process.argv[2];
if (!purpose || !/^[a-z0-9._-]+$/i.test(purpose)) { console.error("purpose مطلوب [a-z0-9._-]"); process.exit(2); }
const tpl = process.argv[3] === "schema" ? "kanaf_tpl_schema" : "kanaf_tpl_migrated";
const db = "kanaf_t_" + purpose.replace(/[^a-z0-9]/gi, "_").toLowerCase();
const su = (d) => { const u = new URL(cfg.superuserUrl); u.pathname = `/${d}`; return u.toString(); };
async function q(d, sql, p) { const c = new pg.Client({ connectionString: su(d), ssl: false }); await c.connect(); try { return await c.query(sql, p); } finally { await c.end(); } }
await q("postgres", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
await q("postgres", `CREATE DATABASE ${db} TEMPLATE ${tpl}`);
await q(db, `UPDATE kanaf_test_env_marker SET purpose = $1`, [purpose]);
const u = new URL(su(db)); u.username = cfg.runtimeRole; u.password = cfg.runtimePassword;
console.log(`export TEST_DATABASE_URL='${u}'`);
console.log(`export KANAF_TEST_MARKER='${cfg.marker}'`);
