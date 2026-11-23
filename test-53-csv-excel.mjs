import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0015 §2.8 — ملفات التصدير تفتح أعمدةً في إكسل المالك.
 *  X) 🔴 كل تصدير (ستة) يُقسم أعمدةً بفاصل قوائم «;» كما يفعل إكسل على ويندوز العربي، والعربية سليمة (BOM)،
 *     وأول صفّ رؤوس الأعمدة، والتعريف والمجموع آخر الملف بعد سطر فارغ.
 *  K) لا تغيير في الأعمدة: الأسماء والترتيب كما كانت في main bfd4bbf حرفياً.
 *  S) حماية حقن الصيغ باقية، والخلية التي فيها «;» مقتبسة، والتاريخ ISO بحرف T (نصّ لا يعيد إكسل تفسيره).
 *  C) ?delimiter=comma يعيد الفاصلة لمن يحتاجها (إكسل بإعدادات إنجليزية، أدوات أخرى).
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const jwt = (await import("jsonwebtoken")).default;
const { query, pool } = await import("./db/pool.js");
const { adminExportsRouter } = await import("./admin/exports.js");
for (const k of ["error", "warn"]) console[k] = () => {};
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);

/* الأعمدة كما صدّرها main bfd4bbf (مستخرجة من ملفات مصدَّرة فعلاً قبل التغيير). */
const HEADERS = {
  invoices: ["معرّف الفاتورة", "الرقم الضريبي", "تاريخ الإنشاء", "تاريخ الإصدار", "الاسم", "البريد", "مفتاح الباقة", "اسم الباقة", "قبل الضريبة", "الضريبة", "الإجمالي", "نسبة الضريبة", "العملة", "الحالة"],
  payments: ["معرّف الدفعة", "تاريخ الإنشاء", "تاريخ التحصيل", "الاسم", "البريد", "رقم الفاتورة", "المبلغ", "العملة", "الحالة", "الوسيلة", "نوع البطاقة", "آخر 4 أرقام", "المزوّد", "معرّف المعاملة", "المسترد", "سبب الفشل"],
  subscriptions: ["معرّف الاشتراك", "معرّف المستخدم", "الاسم", "البريد", "مفتاح الباقة", "اسم الباقة", "الحالة الفعلية", "الحالة المخزّنة", "مستحق", "البداية", "بداية الفترة", "نهاية الفترة", "تاريخ الإلغاء", "إلغاء بنهاية المدة", "دورة الفوترة", "السعر", "العملة", "المزوّد"],
  refunds: ["معرّف الاسترداد", "التاريخ", "الاسم", "البريد", "معرّف الدفعة", "رقم الإشعار الدائن", "المبلغ", "العملة", "النوع", "الحالة", "المزوّد", "معرّف الاسترداد لدى المزوّد", "البادئ", "السبب", "الخطأ"],
  users: ["المعرّف", "الاسم", "البريد", "تاريخ التسجيل", "تاريخ توثيق البريد", "آخر دخول", "تاريخ التعليق", "حالة الحساب", "حالة الاشتراك", "الباقة"],
  "audit-log": ["الوقت", "المسؤول", "بريد المسؤول", "الإجراء", "الكيان", "معرّف الكيان", "المستخدم الهدف", "القيمة السابقة", "القيمة الجديدة", "السبب", "بيانات إضافية", "العنوان"],
};

/* قارئ CSV مستقلّ عن كود المشروع (اقتباس RFC 4180) — يقسم بالفاصل المعطى فقط، كما يفعل إكسل بفاصل القوائم. */
function parse(text, sep) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\r") { /* */ }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/admin", adminExportsRouter);
const server = app.listen(0); const B = `http://127.0.0.1:${server.address().port}`;
try {
  const { rows: [a] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('مصدّر','csv-owner@kanaf.test','x','owner') RETURNING id`);
  const cookie = `kanaf_admin_access=${jwt.sign({ sub: a.id, role: "owner", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  const { rows: [u] } = await query(`INSERT INTO users (name, email, password_hash, confirmed_adult, email_verified_at) VALUES ('=HYPERLINK("x");نورة', 'csv1@example.com', 'x', true, now()) RETURNING id`);
  const { rows: [s] } = await query(`INSERT INTO subscriptions (user_id, plan_id, status, started_at, current_period_end) VALUES ($1,'monthly','active',now(),now()+interval '30 days') RETURNING id`, [u.id]);
  const { rows: [inv] } = await query(`INSERT INTO invoices (user_id, subscription_id, plan_id, amount_sar, status, zatca_invoice_number, subtotal_sar, vat_sar, zatca_issued_at)
    VALUES ($1,$2,'monthly',29,'paid','TNFS-INV-009901',25.22,3.78,'2026-11-20T09:30:00Z') RETURNING id`, [u.id, s.id]);
  const { rows: [p] } = await query(`INSERT INTO payments (user_id, invoice_id, subscription_id, amount, status, captured_at) VALUES ($1,$2,$3,29,'paid',now()) RETURNING id`, [u.id, inv.id, s.id]);
  await query(`INSERT INTO refunds (user_id, payment_id, invoice_id, amount, kind, status, reason) VALUES ($1,$2,$3,5,'partial','succeeded','جزئي; لسبب')`, [u.id, p.id, inv.id]);
  await query(`INSERT INTO admin_action_log (admin_user_id, action, reason) VALUES ($1, 'csv_probe', 'فحص')`, [a.id]);

  const get = async (kind, qs = "") => {
    const r = await fetch(`${B}/admin/exports/${kind}.csv${qs}`, { headers: { Cookie: cookie } });
    return { status: r.status, raw: Buffer.from(await r.arrayBuffer()) };
  };
  const bad = { split: [], bom: [], first: [], footer: [], headers: [] };
  let invText = "", usersText = "";
  for (const kind of Object.keys(HEADERS)) {
    const { status, raw } = await get(kind);
    if (status !== 200) { bad.split.push(`${kind}:${status}`); continue; }
    if (!(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf)) bad.bom.push(kind);
    const text = raw.subarray(3).toString("utf8");
    if (kind === "invoices") invText = text; if (kind === "users") usersText = text;
    const rows = parse(text, ";");
    const blank = rows.findIndex((r) => r.length === 1 && r[0] === "");
    const data = rows.slice(0, blank < 0 ? rows.length : blank);
    if (data.some((r) => r.length !== HEADERS[kind].length)) bad.split.push(`${kind}:${data.map((r) => r.length).join(",")}`);
    if (rows[0][0].startsWith("#") || rows[0][0] !== HEADERS[kind][0]) bad.first.push(`${kind}:${rows[0][0]}`);
    const tail = rows.slice(blank + 1).map((r) => r[0]);
    if (blank < 1 || !/^# إجمالي الصفوف: \d+$/.test(tail[0] || "") || !(tail[1] || "").startsWith("# ")) bad.footer.push(`${kind}:${tail.join("|").slice(0, 80)}`);
    if (JSON.stringify(rows[0]) !== JSON.stringify(HEADERS[kind])) bad.headers.push(kind);
  }
  ok("X1 🔴 بفاصل قوائم «;» (إكسل على ويندوز العربي) كل صفّ في الملفات الستة بعدد أعمدة رأسه — لا عمود واحد", bad.split.length === 0, bad.split.join(" "));
  ok("X2 BOM أول الملف في الستة (العربية سليمة)", bad.bom.length === 0, bad.bom.join(" "));
  ok("X3 أول صفّ مرئي رؤوس الأعمدة لا سطر تعريف", bad.first.length === 0, bad.first.join(" "));
  ok("X4 المجموع ثم التعريف آخر الملف بعد سطر فارغ", bad.footer.length === 0, bad.footer.join(" "));
  ok("K1 🔴 الأعمدة كما كانت في bfd4bbf: الأسماء والترتيب حرفياً، في الستة", bad.headers.length === 0, bad.headers.join(" "));

  const urow = parse(usersText, ";").find((r) => r[2] === "csv1@example.com");
  ok("S1 حقن الصيغ ما زال محجوزاً: =HYPERLINK تُسبق بفاصلة عليا، و«;» داخل الخلية لا تشقّها", urow && urow[1] === `'=HYPERLINK("x");نورة`, JSON.stringify(urow));
  const irow = parse(invText, ";").find((r) => r[1] === "TNFS-INV-009901");
  ok("S2 التاريخ ISO بحرف T ومنطقة Z — نصّ صريح لا يعيد إكسل تفسيره", irow && irow[3] === "2026-11-20T09:30:00.000Z", JSON.stringify(irow?.slice(2, 4)));
  ok("S3 الأرقام لاتينية في الملف (القيمة لا تنسيق الجهاز)", irow && irow[8] === "25.22" && !/[٠-٩]/.test(invText));

  const comma = await get("invoices", "?delimiter=comma");
  const crow = parse(comma.raw.subarray(3).toString("utf8"), ",");
  ok("C1 ?delimiter=comma: الفاصلة لمن يحتاجها، بالأعمدة نفسها وBOM والذيل نفسه", crow[0].length === HEADERS.invoices.length && comma.raw[0] === 0xef && crow.some((r) => /^# إجمالي الصفوف/.test(r[0])));
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 400), false); }
finally { server.close(); await pool.end().catch(() => {}); }
let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 500)})` : ""}`); } }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
