/* يحذف قاعدة اختبار أنشأها create-db.mjs لغرض محدد (لا يقبل إلا اسماً يبدأ بـ kanaf_t_).
     node test-support/drop-db.mjs <purpose> */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, ".local", "test-env.json"), "utf8"));
const purpose = process.argv[2];
if (!purpose || !/^[a-z0-9._-]+$/i.test(purpose)) { console.error("purpose مطلوب [a-z0-9._-]"); process.exit(2); }
const db = "kanaf_t_" + purpose.replace(/[^a-z0-9]/gi, "_").toLowerCase();
const u = new URL(cfg.superuserUrl); u.pathname = "/postgres";
const host = u.hostname;
if (!["127.0.0.1", "localhost", "::1"].includes(host)) { console.error("ليس عنقوداً محلياً"); process.exit(3); }
const c = new pg.Client({ connectionString: u.toString(), ssl: false });
await c.connect();
try { await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); console.log(`dropped ${db}`); } finally { await c.end(); }
