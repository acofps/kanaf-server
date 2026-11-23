import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0014 §2.6 — سجلّ الأخطاء لا يخزّن بيانات شخصية ولا نصّ مستخدم ولا أسراراً.
 * أخطاء مفتعلة بأشكال واقعية، عبر المسارين الحقيقيين: recordError (يناديه fail() والمعالج الأخير
 * في Express) ومعالج unhandledRejection في index.js نفسه.
 *  E1 🔴 لا رمز تحقق (6 أرقام) ولا بريد ولا هاتف ولا نصّ مستخدم عربي — مقتبساً أو غير مقتبس.
 *  E2 🔴 لا سلسلة اتصال ولا كلمة مرور فيها ولا مضيف قاعدة، ولا JWT ولا مفتاح API ولا Bearer.
 *  E3 ما يفيد التشخيص باقٍ: النوع، والموضع بلا معرّفات، ومواضع الأسطر في مسار الاستدعاء.
 *  E4 فشل كتابة السجل لا يُسقط الطلب ولا يرمي.
 */
requireDedicatedDatabase(import.meta.url);
process.env.PORT = "4648";
process.env.SKIP_PDF_BOOT_CHECK = "1";
const logs = []; console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
const { recordError, sanitizeErrorText } = await import("./ops/error-log.js");
const out = (s) => process.stdout.write(s + "\n");
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SECRETS = {
  code: "482913", code2: "771204", email: "victim@example.com", phone: "512345678", note: "أشعر بالحزن الشديد اليوم",
  note2: "لا أستطيع النوم منذ أيام", pass: "S3cretPass", host: "dpg-abc123.oregon-postgres.render.com", scheme: "postgresql://",
  jwt: "eyJhbGciOiJIUzI1NiJ9", apikey: "sk_live_", bearer: "abc.def.ghi-bearer-token",
};

try {
  await query(`DELETE FROM system_errors`);
  const pgDup = Object.assign(new Error(`duplicate key value violates unique constraint "users_email_key"`), {
    code: "23505", detail: `Key (email)=(${SECRETS.email}) already exists.` });
  await recordError(new Error(`verification code ${SECRETS.code} expired for ${SECRETS.email}`), { location: "POST /api/auth/verify-email", status: 500 });
  await recordError(pgDup, { location: "POST /admin/users/1b2e3f4a-0000-4000-8000-000000000001/profile", status: 500 });
  await recordError(new Error(`connect ECONNREFUSED postgresql://kanaf_kanaf:${SECRETS.pass}@${SECRETS.host}:5432/kanaf_kanaf`), { location: "boot" });
  await recordError(new Error(`cannot save note: ${SECRETS.note} — ${SECRETS.note2}`), { location: "PUT /api/me/daily-logs" });
  await recordError(new Error(`provider said "${SECRETS.note}" with key ${SECRETS.apikey}abcdef1234567890 and Bearer ${SECRETS.bearer}`), { location: "POST /api/payments/webhook" });
  await recordError(new Error(`token ${SECRETS.jwt}.eyJzdWIiOiIxMjMifQ.signaturepartxyz rejected; phone +966${SECRETS.phone}`), { location: "GET /api/me" });
  // المسار الحقيقي الثاني: معالج unhandledRejection في index.js
  process.emit("unhandledRejection", new Error(`password reset code ${SECRETS.code2} for ${SECRETS.email} failed`), Promise.resolve());
  await sleep(800);

  const { rows } = await query(`SELECT kind, message, stack, location FROM system_errors`);
  const all = JSON.stringify(rows);
  const leaked = Object.entries(SECRETS).filter(([, v]) => all.includes(v)).map(([k]) => k);
  ok(`E1/E2 🔴 لا شيء من الأسرار والبيانات الشخصية في ${rows.length} صفوف مخزَّنة (رمز التحقق، البريد، الهاتف، نصّ المستخدم، سلسلة الاتصال، المضيف، JWT، المفتاح، Bearer)`, rows.length >= 7 && leaked.length === 0, `تسرّب: ${leaked.join(",")} ${all.slice(0, 300)}`);
  ok("E1b مسار unhandledRejection نفسه سُجِّل ونُقّي", rows.some((r) => r.location === "process:unhandledRejection" && !r.message.includes(SECRETS.code2)), JSON.stringify(rows.find((r) => r.location === "process:unhandledRejection")));
  ok("E3 النوع والموضع باقيان، والموضع بلا معرّف عميل", rows.some((r) => r.kind === "23505" && r.location === "POST /admin/users/:id/profile"));
  const stack = rows.find((r) => r.stack)?.stack || "";
  ok("E3b مواضع الأسطر في مسار الاستدعاء مقروءة (رقم السطر بعد «:» لا يُحذف)", /\.mjs:\d+:\d+/.test(stack), stack.slice(0, 200));
  ok("E3c وحدة: رمز من 4–8 أرقام يُحذف، وموضع السطر يبقى", sanitizeErrorText("code 482913 at file.js:1146:12") === "code [number] at file.js:1146:12", sanitizeErrorText("code 482913 at file.js:1146:12"));

  /* E4: فشل الكتابة (جدول غير موجود مؤقتاً) لا يرمي */
  await query(`ALTER TABLE system_errors RENAME TO system_errors_off`);
  let threw = false;
  try { await recordError(new Error("x"), { location: "t" }); } catch { threw = true; }
  const health = await fetch("http://127.0.0.1:4648/api/health");
  await query(`ALTER TABLE system_errors_off RENAME TO system_errors`);
  ok("E4 فشل كتابة السجل لا يرمي، والخادم يجيب", !threw && health.ok);
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 400), false); }
finally { await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; out(`  PASS  ${l}`); } else { fail++; out(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 500)})` : ""}`); } }
out(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
