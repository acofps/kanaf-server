import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0002 B-04 — كتابة مرة واحدة بمفتاح العميل.
 * POST للاستبيانات وجلسات الأدوات والدفاتر يُدرج صفاً في كل نداء؛ فإن
 * وصلت الكتابة وانقطع الرد ثم أعاد التطبيق المحاولة تكررت النتيجة.
 * مع clientRef: الإعادة ترجع نفس المورد بلا صف ثانٍ.
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const crypto = await import("node:crypto");
const bcrypt = (await import("bcrypt")).default;
const { query, pool } = await import("./db/pool.js");
const { issueAccessToken } = await import("./auth/tokens.js");
const { userDataRouter } = await import("./userdata/routes.js");
const { purgeDeletedAccount } = await import("./userdata/account.js");

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use("/api/me", userDataRouter);
const server = app.listen(4596); const B = "http://127.0.0.1:4596";
async function call(method, path, body, token) {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, replayed: r.headers.get("idempotent-replayed"), body: await r.json().catch(() => ({})) };
}
async function mkUser(tag) {
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, confirmed_adult, agreed_policy_at, email_verified_at)
     VALUES ($1, $2, $3, true, now(), now()) RETURNING id`,
    [`مستخدم ${tag}`, `wr-${tag}-${crypto.randomBytes(3).toString("hex")}@kanaf.test`, await bcrypt.hash("x-" + tag, 4)]);
  return { id: rows[0].id, token: issueAccessToken({ id: rows[0].id }) };
}
const count = async (sql, p) => +(await query(sql, p)).rows[0].n;
const SCR = { kind: "gad7", total: 4, bandLabel: "طفيف", answers: { q1: 1 } };

try {
  const A = await mkUser("a"), Bu = await mkUser("b");
  /* fixture معلن (قاعدة معزولة): المحتوى في القالب غير معتمد سريرياً، فيُفتح العنصران المستعملان هنا فقط */
  await query(`UPDATE content_items SET clinical_review_status = 'approved', launch_enabled = true
               WHERE (content_type, content_key) IN (('notebook', 'need_right_now'), ('cbt_tool', 'check_thought'))`);

  /* N0 — ضابط سلبي: بلا clientRef يبقى السلوك القديم، فالإعادة تكرر الصف */
  await call("POST", "/api/me/screenings", SCR, A.token);
  await call("POST", "/api/me/screenings", SCR, A.token);
  ok("N0 control: without clientRef a retried POST /screenings creates a second row (the defect)",
    await count(`SELECT count(*) n FROM screenings WHERE user_id = $1`, [A.id]) === 2);
  await query(`DELETE FROM screenings WHERE user_id = $1`, [A.id]);

  /* W1 — نفس المفتاح مرتين: صف واحد ونفس المعرّف */
  const k1 = crypto.randomUUID();
  const s1 = await call("POST", "/api/me/screenings", { ...SCR, clientRef: k1 }, A.token);
  const s2 = await call("POST", "/api/me/screenings", { ...SCR, clientRef: k1 }, A.token);
  ok("W1 same clientRef twice → 201 then 200, same id, one row", s1.status === 201 && s2.status === 200 && s1.body.id === s2.body.id && s2.replayed === "true"
    && await count(`SELECT count(*) n FROM screenings WHERE user_id = $1`, [A.id]) === 1, JSON.stringify([s1.status, s2.status]));
  ok("W1b replay body has the same shape as the create body", JSON.stringify(Object.keys(s1.body).sort()) === JSON.stringify(Object.keys(s2.body).sort()));

  /* W2 — تزامن: خمس إعادات متزامنة بنفس المفتاح */
  const k2 = crypto.randomUUID();
  const par = await Promise.all([1, 2, 3, 4, 5].map(() => call("POST", "/api/me/screenings", { ...SCR, clientRef: k2 }, A.token)));
  ok("W2 five concurrent requests with one clientRef → one row, one 201, all the same id",
    new Set(par.map((p) => p.body.id)).size === 1 && par.filter((p) => p.status === 201).length === 1
    && await count(`SELECT count(*) n FROM screenings WHERE user_id = $1`, [A.id]) === 2, JSON.stringify(par.map((p) => p.status)));

  /* W3 — مستخدم آخر بنفس المفتاح مستقل ولا يرى مورد الأول */
  const s3 = await call("POST", "/api/me/screenings", { ...SCR, clientRef: k1 }, Bu.token);
  ok("W3 another user with the same clientRef gets their own new row (no cross-account replay)", s3.status === 201 && s3.body.id !== s1.body.id
    && await count(`SELECT count(*) n FROM screenings WHERE user_id = $1`, [Bu.id]) === 1);

  /* W4 — مفتاح غير صالح */
  const s4 = await call("POST", "/api/me/screenings", { ...SCR, clientRef: "not-a-uuid" }, A.token);
  ok("W4 malformed clientRef → 400 invalid_client_ref and nothing written", s4.status === 400 && s4.body.error === "invalid_client_ref"
    && await count(`SELECT count(*) n FROM screenings WHERE user_id = $1`, [A.id]) === 2);

  /* W5 — نفس المفتاح لمورد آخر */
  const s5 = await call("POST", "/api/me/notebooks", { templateKey: "need_right_now", clientRef: k1 }, A.token);
  ok("W5 reusing a clientRef for another resource → 409 client_ref_reused, no notebook created", s5.status === 409 && s5.body.error === "client_ref_reused"
    && await count(`SELECT count(*) n FROM user_notebook_entries WHERE user_id = $1`, [A.id]) === 0, JSON.stringify(s5));

  /* W6 — جلسة أداة */
  const k6 = crypto.randomUUID();
  const c1 = await call("POST", "/api/me/cbt-sessions", { toolId: "check_thought", payload: { a: 1 }, clientRef: k6 }, A.token);
  const c2 = await call("POST", "/api/me/cbt-sessions", { toolId: "check_thought", payload: { a: 1 }, clientRef: k6 }, A.token);
  ok("W6 cbt-session: retry with same clientRef → one row, completed_at returned both times", c1.status === 201 && c2.status === 200 && c1.body.id === c2.body.id
    && !!c1.body.completed_at && c1.body.completed_at === c2.body.completed_at
    && await count(`SELECT count(*) n FROM user_cbt_sessions WHERE user_id = $1`, [A.id]) === 1);

  /* W7 — دفتر، ثم حذف، ثم إعادة متأخرة بنفس المفتاح */
  const k7 = crypto.randomUUID();
  const n1 = await call("POST", "/api/me/notebooks", { templateKey: "need_right_now", clientRef: k7 }, A.token);
  const n2 = await call("POST", "/api/me/notebooks", { templateKey: "need_right_now", clientRef: k7 }, A.token);
  ok("W7 notebook: retry with same clientRef → same entry", n1.status === 201 && n2.status === 200 && n1.body.id === n2.body.id
    && await count(`SELECT count(*) n FROM user_notebook_entries WHERE user_id = $1`, [A.id]) === 1);
  await call("DELETE", `/api/me/notebooks/${n1.body.id}`, null, A.token);
  const n3 = await call("POST", "/api/me/notebooks", { templateKey: "need_right_now", clientRef: k7 }, A.token);
  ok("W7b a late retry after the user deleted the entry → 410, the entry is not resurrected", n3.status === 410
    && await count(`SELECT count(*) n FROM user_notebook_entries WHERE user_id = $1`, [A.id]) === 0, JSON.stringify(n3));

  /* W8 — مستخدم آخر لا يستعيد مورد غيره حتى بمفتاحه */
  const n4 = await call("POST", "/api/me/notebooks", { templateKey: "need_right_now", clientRef: k6 }, Bu.token);
  ok("W8 user B using user A's cbt clientRef on notebooks → new own entry (keys are per user)", n4.status === 201
    && await count(`SELECT count(*) n FROM user_notebook_entries WHERE user_id = $1`, [Bu.id]) === 1);

  /* W9 — الإيصال لا يحمل محتوى؛ ويُحذف مع الحساب */
  const cols = (await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_write_receipts' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  ok("W9 receipts hold identifiers only (no answers/payload/text)", JSON.stringify(cols) === JSON.stringify(["user_id", "client_ref", "resource", "resource_id", "created_at"]), cols.join(","));
  await query(`DELETE FROM users WHERE id = $1`, [Bu.id]);
  ok("W9b deleting the account removes its receipts (ON DELETE CASCADE)", await count(`SELECT count(*) n FROM user_write_receipts WHERE user_id = $1`, [Bu.id]) === 0);
  ok("W9c the other account's receipts are untouched", await count(`SELECT count(*) n FROM user_write_receipts WHERE user_id = $1`, [A.id]) === 4);

  /* W10 — إعادة بنفس المفتاح بعد زوال الاستبيان الأصلي: 410 لا 200 بجسم فارغ */
  const k10 = crypto.randomUUID();
  const s10 = await call("POST", "/api/me/screenings", { ...SCR, clientRef: k10 }, A.token);
  await query(`DELETE FROM screenings WHERE id = $1`, [s10.body.id]);
  const s10b = await call("POST", "/api/me/screenings", { ...SCR, clientRef: k10 }, A.token);
  ok("W10 replay whose screening row is gone → 410 already_deleted, nothing recreated", s10b.status === 410 && s10b.body.error === "already_deleted"
    && await count(`SELECT count(*) n FROM screenings WHERE id = $1`, [s10.body.id]) === 0, JSON.stringify(s10b));

  /* W11 — الحذف النهائي يجهّل صف المستخدم (لا CASCADE) فيجب أن يحذف الإيصالات صراحةً */
  const C = await mkUser("c");
  await call("POST", "/api/me/screenings", { ...SCR, clientRef: crypto.randomUUID() }, C.token);
  const before = await count(`SELECT count(*) n FROM user_write_receipts WHERE user_id = $1`, [C.id]);
  await query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [C.id]); // fixture: حساب معطَّل بانتظار الحذف النهائي
  const pc = await purgeDeletedAccount(C.id, { policy: "TEST_ONLY_not_an_approved_policy" });
  ok("W11 purge removes the account's receipts (1 → 0) and reports the count", before === 1 && pc.user_write_receipts === 1
    && await count(`SELECT count(*) n FROM user_write_receipts WHERE user_id = $1`, [C.id]) === 0, JSON.stringify(pc));
  ok("W11b purge leaves other accounts' receipts", await count(`SELECT count(*) n FROM user_write_receipts WHERE user_id = $1`, [A.id]) >= 4);
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
server.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
