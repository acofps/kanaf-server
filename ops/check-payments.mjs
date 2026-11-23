// تشخيص زرّ الاشتراك — قراءة فقط، من Render Shell (KANAF-ORD-0015 §2.2).
//
//   cd /opt/render/project/src && node ops/check-payments.mjs
//
// ثلاثة أسئلة، سطر لكل جواب (بالإنجليزية لأن العربية تتبعثر في صدفة Render):
//   1) هل متغيّرات الدفع مضبوطة وصالحة؟ — الأسماء فقط، لا قيمة تُطبع.
//   2) هل يقبل المزوّد المفتاح؟ — طلب قراءة واحد (قائمة فواتير بحجم 1)، لا ينشئ شيئاً ولا يخصم.
//   3) هل وقع العطب فعلاً؟ — عدد الفواتير المعلّقة بلا رابط دفع في آخر 14 يوماً (أثر كل ضغطة فشلت)،
//      وآخر أخطاء صفحة الدفع في «أخطاء النظام». معاملة READ ONLY تنتهي بـROLLBACK.
import pg from "pg";
import { paymentConfigProblems } from "../payments/config-check.js";

const line = (ok, key, val) => console.log(`${ok === null ? "INFO " : ok ? "OK   " : "CHECK"} ${key} ${val}`);
const WHY_EN = { PAYMENT_SECRET_KEY: "missing", SERVER_BASE_URL: "missing, not https, or local — the payment webhook cannot reach the server", APP_BASE_URL: "missing, not https, or local — the return page after paying will not open" };

export async function checkPayments({ env = process.env, fetchImpl = fetch, connectionString = null, ssl = false, log = line } = {}) {
  const out = {};
  const cfg = paymentConfigProblems({ ...env, NODE_ENV: "production" });
  out.blocking = cfg.blocking.map((b) => b.name);
  for (const name of ["PAYMENT_SECRET_KEY", "SERVER_BASE_URL", "APP_BASE_URL"]) {
    const bad = cfg.blocking.find((b) => b.name === name);
    log(!bad, name, bad ? WHY_EN[name] : name === "PAYMENT_SECRET_KEY" ? `set (${/^sk_live_/.test(env.PAYMENT_SECRET_KEY) ? "live" : /^sk_test_/.test(env.PAYMENT_SECRET_KEY) ? "TEST key — only test cards work" : "unknown prefix"})` : `set (${new URL(env[name]).host})`);
  }
  if (env.PAYMENT_SECRET_KEY) {
    try {
      const r = await fetchImpl("https://api.moyasar.com/v1/invoices?per=1", {
        headers: { Authorization: "Basic " + Buffer.from(`${env.PAYMENT_SECRET_KEY}:`).toString("base64") }, signal: AbortSignal.timeout(10000) });
      out.provider = r.status;
      log(r.ok, "PROVIDER_KEY", r.ok ? "accepted by Moyasar" : r.status === 401 ? "REJECTED by Moyasar (401) — wrong or revoked key" : `Moyasar answered ${r.status}`);
    } catch (e) { out.provider = "unreachable"; log(false, "PROVIDER_KEY", `Moyasar unreachable from the server (${e?.name || "error"})`); }
  }
  if (connectionString) {
    const c = new pg.Client({ connectionString, ssl, application_name: "ord-0015-check-payments" });
    await c.connect();
    try {
      await c.query("BEGIN READ ONLY");
      const { rows: [n] } = await c.query(`SELECT count(*)::int AS n, max(created_at) AS last FROM invoices WHERE status = 'pending' AND checkout_url IS NULL AND created_at > now() - interval '14 days'`);
      out.orphans = n.n;
      log(n.n === 0, "FAILED_CHECKOUTS_14D", n.n ? `${n.n} pending invoices without a payment link (last ${new Date(n.last).toISOString()}) — each is a press on "subscribe" that did not reach the payment page` : "none");
      const has = (await c.query(`SELECT to_regclass('public.system_errors') IS NOT NULL AS e`)).rows[0].e;
      if (has) {
        const { rows } = await c.query(`SELECT kind, count, last_seen FROM system_errors WHERE location LIKE 'payments:create-invoice%' ORDER BY last_seen DESC LIMIT 3`);
        out.errors = rows;
        log(null, "CHECKOUT_ERRORS", rows.length ? rows.map((r) => `${r.kind} x${r.count} (last ${new Date(r.last_seen).toISOString()})`).join("; ") : "none recorded");
      }
    } finally { await c.query("ROLLBACK").catch(() => {}); await c.end().catch(() => {}); }
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("check-payments.mjs")) {
  const ssl = (process.env.DB_SSL || "false").toLowerCase() === "true" ? { rejectUnauthorized: false } : false;
  await checkPayments({ connectionString: process.env.DATABASE_URL || null, ssl }).catch((e) => {
    console.log(`FAIL ${String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`); process.exit(1);
  });
}
