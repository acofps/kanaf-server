import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0001 — بوابة إصدار الوثائق (X09).
 * المنتظر على البوابة لا يمسك اتصالاً من المجمّع، والتجاوز يُرفض فوراً.
 * (القياس الكامل بأحداث دفع حقيقية ورسم PDF: test-support/measure-pdf.mjs)
 */
requireDedicatedDatabase(import.meta.url);
process.env.PDF_DOC_CONCURRENCY = "1";
process.env.PDF_DOC_MAX_WAITING = "2";
const { withDocumentSlot, documentSlotStats } = await import("./invoicing/slot.js");
const { withTransaction, pool } = await import("./db/pool.js");
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  /* 1) بلا بوابة (السلوك السابق): كل مهمة تمسك اتصالاً طوال انتظارها */
  let peak = 0; const s1 = setInterval(() => { peak = Math.max(peak, pool.totalCount - pool.idleCount); }, 5);
  await Promise.all([1, 2, 3, 4, 5].map(() => withTransaction(async (c) => { await c.query("SELECT 1"); await sleep(150); })));
  clearInterval(s1);
  ok("N0 control: without the gate 5 concurrent jobs hold 5 connections at once", peak === 5, String(peak));

  /* 2) بالبوابة */
  peak = 0; let peakActive = 0;
  const s2 = setInterval(() => { peak = Math.max(peak, pool.totalCount - pool.idleCount); peakActive = Math.max(peakActive, documentSlotStats().active); }, 5);
  const order = [];
  const t0 = Date.now();
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => withDocumentSlot(() => withTransaction(async (c) => { await c.query("SELECT 1"); order.push(i); await sleep(150); return i; }))));
  clearInterval(s2);
  const rejected = results.filter((r) => r.status === "rejected");
  ok("G1 at most one job holds a DB connection (waiters hold none)", peak === 1, String(peak));
  ok("G2 waiting list bounded: 1 running + 2 waiting, the other 2 refused", results.filter((r) => r.status === "fulfilled").length === 3 && rejected.length === 2, JSON.stringify(results.map((r) => r.status)));
  ok("G3 refusal is immediate and explicit (document_queue_full / 503)", rejected.every((r) => r.reason?.message === "document_queue_full" && r.reason?.status === 503));
  ok("G4 accepted jobs run in arrival order", JSON.stringify(order) === "[1,2,3]", JSON.stringify(order));
  ok("G5 slot fully released afterwards", documentSlotStats().active === 0 && documentSlotStats().waiting === 0, JSON.stringify(documentSlotStats()));

  /* 3) فشل مهمة لا يسمّم البوابة */
  const r3 = await Promise.allSettled([withDocumentSlot(async () => { throw new Error("boom"); }), withDocumentSlot(async () => "after")]);
  ok("G6 a failing job releases its slot; the next one still runs", r3[0].status === "rejected" && r3[1].value === "after" && documentSlotStats().active === 0);
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
