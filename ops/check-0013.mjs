// فحص الإصدار ORD-0013 — قراءة فقط، من Render Shell (KANAF-ORD-0014 §4).
//
//   cd /opt/render/project/src && node ops/check-0013.mjs
//
// معاملة READ ONLY تنتهي بـROLLBACK: لا يكتب شيئاً ولا يطبع سلسلة الاتصال ولا أي سرّ.
// المخرَج بالإنجليزية وسطراً لكل بند، لأن النص العربي يتبعثر في صدفة Render. القيم العربية تُطبع
// بين علامتي <> وتُقارن هنا بالمطلوب، فيكفي قراءة OK/CHECK في أول السطر.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const line = (ok, key, val) => console.log(`${ok === null ? "INFO " : ok ? "OK   " : "CHECK"} ${key} ${val}`);
const OLD = /(?<![ء-ي])(كنف|تنفس(?![ء-ي])(?!\s*بحرية)(?!\+))/;

export async function check({ connectionString, ssl, env = process.env, log = line }) {
  const c = new pg.Client({ connectionString, ssl, application_name: "ord-0014-check" });
  await c.connect();
  const out = {};
  try {
    await c.query("BEGIN READ ONLY");
    const files = fs.readdirSync(path.join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    const applied = new Set((await c.query(`SELECT filename FROM schema_migrations`)).rows.map((r) => r.filename));
    const pending = files.filter((f) => !applied.has(f));
    out.pending = pending;
    log(pending.length === 0, "MIGRATIONS", pending.length ? `pending: ${pending.join(",")}` : `none pending (${applied.size} applied)`);

    const has = async (t) => (await c.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${t}`])).rows[0].e;
    const setting = async (k) => (await c.query(`SELECT value #>> '{}' AS v FROM app_settings WHERE key = $1`, [k])).rows[0]?.v ?? null;
    const name = await setting("app_public_name"), footer = await setting("marketing_email_footer");
    out.name = name; out.footer = footer;
    log(name === "تنفس بحرية", "APP_NAME", `<${name}>${name === "تنفس بحرية" ? "" : " expected <تنفس بحرية> — if you set it yourself, keep it"}`);
    log(footer === null || !OLD.test(footer), "MARKETING_FOOTER", footer === null ? "(empty — no footer)" : `<${footer}>`);
    const bs = (await c.query(`SELECT to_jsonb(b) j FROM billing_settings b LIMIT 1`)).rows[0]?.j || {};
    out.suffix = bs.seller_display_suffix ?? null;
    log(!bs.seller_display_suffix || !OLD.test(bs.seller_display_suffix), "SELLER_SUFFIX", `<${bs.seller_display_suffix ?? ""}>`);
    const legal = (await c.query(`SELECT legal_name FROM tax_settings LIMIT 1`)).rows[0]?.legal_name ?? null;
    out.legal = legal;
    log(null, "LEGAL_NAME", `<${legal ?? ""}> (never changed by this release)`);
    const plansOld = (await c.query(`SELECT plan_key FROM subscription_plans WHERE name ~ $1 OR array_to_string(features, '|') ~ $1`, [OLD.source])).rows.map((r) => r.plan_key);
    out.plansOld = plansOld;
    log(plansOld.length === 0, "PLANS_OLD_NAME", plansOld.length ? `still mention the old name: ${plansOld.join(",")} (edit in Plans)` : "none");

    if (await has("autorenew_consents")) {
      const [a] = (await c.query(`SELECT (SELECT count(*)::int FROM autorenew_consents) consents, (SELECT count(*)::int FROM payment_methods) cards,
        (SELECT count(*)::int FROM renewal_cycles) cycles, (SELECT count(*)::int FROM renewal_attempts) attempts`)).rows;
      out.autorenewRows = a;
      log(a.cycles === 0 && a.attempts === 0, "AUTORENEW_ROWS", `consents=${a.consents} cards=${a.cards} cycles=${a.cycles} attempts=${a.attempts}`);
    } else log(null, "AUTORENEW_ROWS", "tables not created yet (migration 026 pending)");
    const ar = env.AUTORENEW_ENABLED;
    out.autorenewEnv = ar ?? null;
    log(ar === undefined || ar === "", "AUTORENEW_ENABLED", ar === undefined || ar === "" ? "absent (auto-renewal OFF — correct until the app ships)" : `SET to ${JSON.stringify(ar)} — must stay absent`);

    const seq = (await c.query(`SELECT last_value AS v, is_called AS called FROM kanaf_invoice_number_seq`)).rows[0];
    const n = seq.called ? Number(seq.v) + 1 : Number(seq.v);
    const next = [bs.invoice_number_prefix, bs.document_number_token].filter(Boolean).join("-") + "-" + String(n).padStart(6, "0");
    out.nextInvoice = next;
    log(/^TNFS-INV-\d{6}$/.test(next), "NEXT_INVOICE", next);
    const from = env.EMAIL_FROM || "";
    out.emailFrom = from;
    log(/^تنفس بحرية\s*</.test(from), "EMAIL_FROM", from ? `<${from.replace(/<.*/, "").trim()}> ${(/<[^>]+>/.exec(from) || [""])[0]}` : "(not set)");
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end().catch(() => {});
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("check-0013.mjs")) {
  if (!process.env.DATABASE_URL) { console.log("STOP DATABASE_URL is not set (run this in the Render Shell of the service)."); process.exit(2); }
  const ssl = (process.env.DB_SSL || "false").toLowerCase() === "true" ? { rejectUnauthorized: false } : false;
  await check({ connectionString: process.env.DATABASE_URL, ssl }).catch((e) => {
    console.log(`FAIL ${String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`); process.exit(1);
  });
}
