// تراجع ترحيلات KANAF-ORD-0013/0014 واحدةً واحدة — من Render Shell (لا psql هناك).
//
//   node ops/rollback-0013.mjs 026            ← تجربة: يعرض ما سيُفقد، ينفّذ داخل معاملة ثم يتراجع. لا أثر.
//   node ops/rollback-0013.mjs 026 --apply    ← تثبيت.
//
// بالترتيب العكسي فقط: DB007 ثم 027 ثم 026 … ثم 021. يرفض التراجع عن ترحيلة ما دامت بعدها
// ترحيلة مطبَّقة. ويحذف صفّها من schema_migrations، فيراها db/migrate.js معلّقة من جديد.
// 027 وDB007 لا رجوع آلياً لهما (القيمة السابقة غير محفوظة) — يُرفضان برسالة توضح الطريق اليدوي.
//
// يتصل بـDATABASE_URL وDB_SSL من بيئة الخدمة (كما db/pool.js) ولا يطبع سلسلة الاتصال.
// المخرَج بالإنجليزية عمداً: النص العربي يتبعثر في صدفة Render.
// الوصف الكامل لكل تراجع وثمنه: docs/ord-0014/RELEASE_RUNBOOK_0013.md (التراجع).
import pg from "pg";

export const STEPS = {
  "021": {
    file: "021_messaging_channels.sql",
    loses: [["notification_deliveries on sms/whatsapp (must be deleted first)", `SELECT count(*)::int n FROM notification_deliveries WHERE channel IN ('sms','whatsapp')`]],
    blockIfLoss: true,
    sql: `ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_channel_check;
          ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_channel_check CHECK (channel IN ('in_app', 'email', 'push'));`,
  },
  "022": {
    file: "022_admin_phone_and_page_grants.sql",
    loses: [["admin phone numbers", `SELECT count(*)::int n FROM admin_users WHERE phone IS NOT NULL`],
            ["admins whose page grants narrow access (they WIDEN back to their full role)", `SELECT count(*)::int n FROM admin_users WHERE page_grants IS NOT NULL`]],
    sql: `ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_phone_e164;
          ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_page_grants_nonempty;
          ALTER TABLE admin_users DROP COLUMN IF EXISTS phone;
          ALTER TABLE admin_users DROP COLUMN IF EXISTS page_grants;`,
  },
  "023": {
    file: "023_system_error_log.sql",
    loses: [["system error rows", `SELECT count(*)::int n FROM system_errors`]],
    sql: `DROP TABLE IF EXISTS system_errors;`,
  },
  "024": {
    file: "024_cancelled_members.sql",
    loses: [["anonymous cancelled-member records (NOT recoverable)", `SELECT count(*)::int n FROM cancelled_members`]],
    sql: `DROP TABLE IF EXISTS cancelled_members;`,
  },
  "025": {
    file: "025_message_templates.sql",
    loses: [["saved message texts", `SELECT count(*)::int n FROM message_definitions`],
            ["email templates", `SELECT count(*)::int n FROM message_templates`],
            ["system_message_log rows of new kinds/channels (must be deleted first)",
             `SELECT count(*)::int n FROM system_message_log WHERE kind NOT IN ('email_verification','password_reset','existing_account_notice','daily_reminder') OR channel NOT IN ('email','push')`]],
    blockIfLoss: [2],
    sql: `DROP TABLE IF EXISTS message_definitions;
          DROP TABLE IF EXISTS message_templates;
          ALTER TABLE system_message_log DROP CONSTRAINT IF EXISTS system_message_log_kind_check;
          ALTER TABLE system_message_log ADD CONSTRAINT system_message_log_kind_check CHECK (kind IN ('email_verification', 'password_reset', 'existing_account_notice', 'daily_reminder'));
          ALTER TABLE system_message_log DROP CONSTRAINT IF EXISTS system_message_log_channel_check;
          ALTER TABLE system_message_log ADD CONSTRAINT system_message_log_channel_check CHECK (channel IN ('email', 'push'));`,
  },
  "026": {
    file: "026_autorenew.sql",
    loses: [["saved cards", `SELECT count(*)::int n FROM payment_methods`],
            ["auto-renew consents", `SELECT count(*)::int n FROM autorenew_consents`],
            ["renewal cycles (invoices and payments they produced STAY)", `SELECT count(*)::int n FROM renewal_cycles`]],
    blockIfLoss: [2],
    sql: `DROP TABLE IF EXISTS renewal_attempts;
          DROP TABLE IF EXISTS renewal_cycles;
          DROP TABLE IF EXISTS autorenew_consents;
          DROP TABLE IF EXISTS payment_methods;
          DELETE FROM app_settings WHERE key IN ('autorenew_notice_days', 'autorenew_max_attempts', 'autorenew_retry_hours');`,
  },
  "027": { file: "027_official_name.sql", manual: "values changed in place; the previous values are not stored. Restore them by hand from Settings / Plans if needed. No structure to undo." },
  "DB007": { file: "DB007_official_seller_suffix.sql", manual: "the seller suffix changed in place; restore it by hand from Settings > Billing if needed. Issued invoices are unaffected (their PDF is stored)." },
};
const ORDER = ["021", "022", "023", "024", "025", "026", "027", "DB007"];

const clean = (e) => String(e?.message || e)
  .replace(/postgres(ql)?:\/\/\S+/gi, "[url]").replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "[ip]").replace(/@[\w.-]+(:\d+)?/g, "@[host]");

export async function rollback({ connectionString, ssl, key, apply, log = console.log }) {
  const step = STEPS[key];
  if (!step) { log(`STOP unknown migration "${key}". Use one of: ${ORDER.join(" ")}`); return { ok: false }; }
  if (step.manual) { log(`STOP ${step.file}: no automatic rollback — ${step.manual}`); return { ok: false, manual: true }; }
  const c = new pg.Client({ connectionString, ssl, application_name: "ord-0014-rollback" });
  await c.connect();
  try {
    await c.query("SET lock_timeout = '5s'");
    const applied = new Set((await c.query(`SELECT filename FROM schema_migrations`)).rows.map((r) => r.filename));
    if (!applied.has(step.file)) { log(`STOP ${step.file} is not applied — nothing to roll back.`); return { ok: false }; }
    const later = ORDER.slice(ORDER.indexOf(key) + 1).map((k) => STEPS[k].file).filter((f) => applied.has(f));
    if (later.length) { log(`STOP roll back in reverse order first: ${later.reverse().join(", ")}`); return { ok: false }; }
    const losses = [];
    for (const [label, q] of step.loses) losses.push([label, (await c.query(q)).rows[0].n]);
    losses.forEach(([label, n]) => log(`LOSES ${n} ${label}`));
    const blocking = step.blockIfLoss === true ? losses : (step.blockIfLoss || []).map((i) => losses[i]);
    const blocked = blocking.filter(([, n]) => n > 0);
    if (blocked.length) { log(`STOP rows above block this rollback (marked "must be deleted first" or still in use). Nothing changed.`); return { ok: false, blocked: true }; }
    await c.query("BEGIN");
    try {
      await c.query(step.sql);
      await c.query(`DELETE FROM schema_migrations WHERE filename = $1`, [step.file]);
    } catch (e) { await c.query("ROLLBACK"); log(`FAIL ${clean(e)} — nothing changed.`); return { ok: false }; }
    if (!apply) { await c.query("ROLLBACK"); log(`DRY-RUN ${step.file} would roll back cleanly — nothing changed. Re-run with --apply to commit.`); return { ok: true, applied: false }; }
    await c.query("COMMIT");
    log(`DONE ${step.file} rolled back. It now shows as pending in migration status.`);
    return { ok: true, applied: true };
  } finally { await c.end().catch(() => {}); }
}

if (process.argv[1] && process.argv[1].endsWith("rollback-0013.mjs")) {
  const key = process.argv[2];
  if (!process.env.DATABASE_URL) { console.log("STOP DATABASE_URL is not set (run this in the Render Shell of the service)."); process.exit(2); }
  const ssl = (process.env.DB_SSL || "false").toLowerCase() === "true" ? { rejectUnauthorized: false } : false;
  const r = await rollback({ connectionString: process.env.DATABASE_URL, ssl, key, apply: process.argv.includes("--apply") })
    .catch((e) => { console.log(`FAIL ${clean(e)}`); return { ok: false }; });
  process.exit(r.ok ? 0 : 1);
}
