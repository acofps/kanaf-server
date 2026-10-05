/* ============================================================
   قياس توليد الفواتير تحت الحمل — KANAF-ORD-0001 X09
   (قياس لا اختبار نجاح/فشل)

     eval "$(node test-support/create-db.mjs measure_pdf)"
     PUPPETEER_EXECUTABLE_PATH=... node test-support/measure-pdf.mjs [N=12] [poolMax=10]

   • قاعدة معزولة (الحارس أولاً)، مزوّد دفع وهمي داخل العملية، بيانات
     ضريبية اصطناعية. لا طلب يغادر الجهاز.
   • يرسل N حدث payment_paid متزامنة — كل واحد يصدر فاتورة PDF — وفي
     الأثناء يطرق /api/internal/ready (استعلام SELECT 1) كل ثانية (أسرع من ذلك يصطدم بمحدّد المعدّل العام فيقيس المحدّد لا المجمّع).
   • يقيس: زمن إصدار الكل، أقصى PSS لشجرة العمليات (node + Chromium)،
     أقصى تأخر لحلقة الأحداث، أقصى اتصالات المجمّع والمنتظرين عليه،
     وزمن/حالة طلبات المسبار أثناء الدفعة.
   ============================================================ */
import "./guard.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const [N = 12] = process.argv.slice(2).map(Number);
const HERE = path.dirname(fileURLToPath(import.meta.url));
Object.assign(process.env, {
  PORT: "4651", SKIP_PDF_BOOT_CHECK: "1", ALLOWED_ORIGINS: "http://127.0.0.1:5173",
  SWEEP_MIN_INTERVAL_MS: "999999999", REMINDER_SWEEP_MIN_INTERVAL_MS: "999999999",
  PAYMENT_WEBHOOK_SECRET: process.env.PAYMENT_WEBHOOK_SECRET || "measure-secret",
  USER_JWT_SECRET: process.env.USER_JWT_SECRET || crypto.randomBytes(32).toString("hex"),
  ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET || crypto.randomBytes(32).toString("hex"),
  PAYMENT_SECRET_KEY: process.env.PAYMENT_SECRET_KEY || "sk_test_fake",
});

const realFetch = globalThis.fetch;
const prov = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const href = String(url);
  if (!href.startsWith("https://api.moyasar.com")) return realFetch(url, opts);
  const m = /\/payments\/([^/?]+)$/.exec(href);
  const body = m && prov.get(m[1]);
  return new Response(JSON.stringify(body || { message: "nf" }), { status: body ? 200 : 404, headers: { "Content-Type": "application/json" } });
};
const quiet = []; const rl = console.log; console.log = (...a) => quiet.push(a.join(" ")); console.error = console.log; console.warn = console.log;

await import("../index.js");
const { query, pool } = await import("../db/pool.js");
const B = "http://127.0.0.1:4651";
await new Promise((r) => setTimeout(r, 500));
await query(`INSERT INTO tax_settings (singleton, legal_name, vat_number, address) VALUES (true, 'مؤسسة اختبار كنف', '399999999900003', 'جدة') ON CONFLICT (singleton) DO NOTHING`);

/* PSS لشجرة العمليات: هذه العملية + أبناؤها (Chromium) */
function treeRssMB() {
  const kids = new Map();
  for (const d of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    try { const st = fs.readFileSync(`/proc/${d}/stat`, "utf8"); const ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
      (kids.get(ppid) || kids.set(ppid, []).get(ppid)).push(Number(d)); } catch {}
  }
  let total = 0; const stack = [process.pid];
  while (stack.length) { const p = stack.pop();
    // PSS لا RSS: عمليات Chromium تتشارك صفحات، وجمع RSS يعدّها مرات
    try { const m = /^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${p}/smaps_rollup`, "utf8")); if (m) total += Number(m[1]); } catch {}
    stack.push(...(kids.get(p) || [])); }
  return +(total / 1024).toFixed(1);
}

async function seedInvoice(i) {
  const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at) VALUES ($1,$2,'x',now()) RETURNING id`, [`قياس ${i}`, `pdf-${i}-${crypto.randomBytes(2).toString("hex")}@measure.invalid`]);
  const { rows: [inv] } = await query(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, provider_invoice_id) VALUES ($1,'monthly',29,'pending',$2) RETURNING id, provider_invoice_id`, [u.id, `mo_inv_m${i}`]);
  const pid = `mo_pay_m${i}_${crypto.randomBytes(2).toString("hex")}`;
  prov.set(pid, { id: pid, status: "paid", amount: 2900, refunded: 0, refunded_amount: 0, currency: "SAR" });
  return { pid, inv };
}
const webhook = ({ pid, inv }) => realFetch(`${B}/api/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
  id: `evt_${pid}`, type: "payment_paid", secret_token: process.env.PAYMENT_WEBHOOK_SECRET,
  data: { id: pid, status: "paid", amount: 2900, currency: "SAR", invoice_id: inv.provider_invoice_id, source: { type: "creditcard", company: "mada", number: "XXXX4444" }, metadata: { kanaf_invoice_id: inv.id } } }) });

/* إحماء: فاتورة واحدة حتى يُقاس الحمل لا تشغيل المتصفح الأول */
const warm = await seedInvoice(0); await webhook(warm);
const baseRss = treeRssMB();

const seeds = []; for (let i = 1; i <= N; i++) seeds.push(await seedInvoice(i));
const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
let peakRss = baseRss, peakPool = 0, peakWaiting = 0, done = false;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, treeRssMB()); peakPool = Math.max(peakPool, pool.totalCount); peakWaiting = Math.max(peakWaiting, pool.waitingCount); }, 50);
const probes = [];
const prober = (async () => { while (!done) { const t = Date.now(); let s = 0; try { s = (await realFetch(`${B}/api/internal/ready`)).status; } catch { s = -1; } probes.push({ ms: Date.now() - t, s }); await new Promise((r) => setTimeout(r, 1000)); } })();

const t0 = Date.now();
const statuses = await Promise.all(seeds.map(async (s) => { const t = Date.now(); const r = await webhook(s); return { status: r.status, ms: Date.now() - t }; }));
/* الفاتورة تصدر بعد رد الويبهوك أحياناً — ننتظر حتى تكتمل أو 120 ثانية */
const ids = seeds.map((s) => s.inv.id);
let issued = 0; const deadline = Date.now() + 120_000;
while (Date.now() < deadline) { issued = (await query(`SELECT count(*)::int n FROM invoices WHERE id = ANY($1) AND zatca_invoice_number IS NOT NULL`, [ids])).rows[0].n; if (issued === N) break; await new Promise((r) => setTimeout(r, 250)); }
const wallMs = Date.now() - t0;
done = true; await prober; clearInterval(sampler); h.disable();

const failedProbes = probes.filter((p) => p.s !== 200);
const out = {
  at: new Date().toISOString(), node: process.version, invoices: N, poolMax: pool.options.max,
  wallMsAllInvoices: wallMs, perInvoiceMs: +(wallMs / N).toFixed(0), issued,
  webhookStatus: Object.entries(statuses.reduce((a, s) => ((a[s.status] = (a[s.status] || 0) + 1), a), {})),
  webhookMaxMs: Math.max(...statuses.map((s) => s.ms)),
  pssMB: { baselineAfterWarmup: baseRss, peak: peakRss },
  eventLoopMaxLagMs: +(h.max / 1e6).toFixed(1),
  pool: { peakTotal: peakPool, peakWaiting },
  probe: { count: probes.length, failed: failedProbes.length, failStatuses: [...new Set(failedProbes.map((p) => p.s))], maxMs: Math.max(...probes.map((p) => p.ms)), p50Ms: probes.map((p) => p.ms).sort((a, b) => a - b)[Math.floor(probes.length / 2)] },
  errorKinds: [...new Set(quiet.filter((l) => /error|Error|تعذّر/.test(l)).map((l) => l.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").slice(0, 160)))].slice(0, 8),
  invoiceErrors: quiet.filter((l) => /تعذّر إصدار الفاتورة|timeout exceeded|تجاوز توليد/.test(l)).length,
};
fs.mkdirSync(path.join(HERE, ".local", "logs"), { recursive: true });
fs.writeFileSync(path.join(HERE, ".local", "logs", `measure-pdf-${N}-pool${pool.options.max}.json`), JSON.stringify(out, null, 2));
console.log = rl; console.log(JSON.stringify(out, null, 2));
const { closeBrowser } = await import("../invoicing/render.js"); await closeBrowser();
await pool.end().catch(() => {}); process.exit(0);
