import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
/**
 * اختبارات قبول KANAF-ORD-0002 B-02 — مزامنة الدفاتر مع الخادم.
 * التطبيق صار يرسل الإجابات والإنهاء والتقييم والحذف (كانت محلية فقط وتبقى صفوف
 * الخادم مسودات فارغة). هنا: دورة الحياة كاملة، وحماية الأحدث (baseUpdatedAt → 409)،
 * والملكية، ومعرّف غير صالح يرد 404 لا 500.
 */
requireDedicatedDatabase(import.meta.url);
const express = (await import("express")).default;
const crypto = await import("node:crypto");
const bcrypt = (await import("bcrypt")).default;
const { query, pool } = await import("./db/pool.js");
const { issueAccessToken } = await import("./auth/tokens.js");
const { userDataRouter } = await import("./userdata/routes.js");

const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const app = express(); app.use(express.json()); app.use("/api/me", userDataRouter);
const server = app.listen(4598); const B = "http://127.0.0.1:4598";
async function call(method, path, body, token) {
  const r = await fetch(B + path, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function mkUser(tag) {
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, confirmed_adult, agreed_policy_at, email_verified_at)
     VALUES ($1, $2, $3, true, now(), now()) RETURNING id`,
    [`مستخدم ${tag}`, `nb-${tag}-${crypto.randomBytes(3).toString("hex")}@kanaf.test`, await bcrypt.hash("x-" + tag, 4)]);
  return { id: rows[0].id, token: issueAccessToken({ id: rows[0].id }) };
}

try {
  await query(`UPDATE content_items SET clinical_review_status = 'approved', launch_enabled = true WHERE content_type = 'notebook' AND content_key = 'need_right_now'`); // fixture معلن
  const A = await mkUser("a"), Bu = await mkUser("b");

  const c = await call("POST", "/api/me/notebooks", { templateKey: "need_right_now", clientRef: crypto.randomUUID() }, A.token);
  ok("N1 create returns updated_at (the client's first base)", c.status === 201 && !!c.body.updated_at, JSON.stringify(c.body));
  const id = c.body.id;

  let r = await call("PATCH", `/api/me/notebooks/${id}`, { answers: { q1: "نص" }, lastPromptKey: "q2", baseUpdatedAt: c.body.updated_at }, A.token);
  ok("N2 answers saved with the current base", r.status === 200 && r.body.status === "draft", JSON.stringify(r.body));
  const u1 = r.body.updated_at;

  /* ضابط سلبي: بلا baseUpdatedAt يبقى السلوك القديم — كتابة فوق أي نسخة */
  const stale = c.body.updated_at;
  r = await call("PATCH", `/api/me/notebooks/${id}`, { answers: { q1: "قديم" }, baseUpdatedAt: stale }, A.token);
  ok("N3 a save based on an older copy is refused (409 notebook_conflict), newer answers kept", r.status === 409 && r.body.error === "notebook_conflict"
    && (await query(`SELECT answers->>'q1' a FROM user_notebook_entries WHERE id = $1`, [id])).rows[0].a === "نص", JSON.stringify(r.body));
  ok("N3b the conflict reply carries no answer text (status/revision/updated_at only)", r.body.current && !("answers" in r.body.current));
  r = await call("PATCH", `/api/me/notebooks/${id}`, { lastPromptKey: "q3" }, A.token);
  ok("N4 control: without baseUpdatedAt the old behaviour (unconditional write) is unchanged", r.status === 200);
  const u2 = r.body.updated_at;

  r = await call("PATCH", `/api/me/notebooks/${id}`, { answers: { q1: "نص", q2: "نص 2" }, status: "completed", baseUpdatedAt: u2 }, A.token);
  ok("N5 finish: completed with completed_at, revision 1", r.status === 200 && r.body.status === "completed" && !!r.body.completed_at && r.body.revision === 1, JSON.stringify(r.body));
  r = await call("PATCH", `/api/me/notebooks/${id}`, { helpfulness: 2, baseUpdatedAt: r.body.updated_at }, A.token);
  ok("N6 rating saved", r.status === 200);
  r = await call("PATCH", `/api/me/notebooks/${id}`, { answers: { q1: "معدّل", q2: "نص 2" }, status: "completed", baseUpdatedAt: r.body.updated_at }, A.token);
  ok("N7 edit after completion bumps revision and stays completed", r.status === 200 && r.body.revision === 2 && r.body.status === "completed");
  const g = (await call("GET", "/api/me/notebooks", null, A.token)).body.entries.find((e) => e.id === id);
  ok("N8 re-entry (GET) returns the saved answers, status and rating", g && g.answers.q1 === "معدّل" && g.status === "completed" && g.helpfulness === 2);

  /* الملكية */
  r = await call("PATCH", `/api/me/notebooks/${id}`, { answers: { q1: "اختراق" } }, Bu.token);
  ok("O1 another user cannot write it (404, same as non-existent)", r.status === 404);
  r = await call("DELETE", `/api/me/notebooks/${id}`, null, Bu.token);
  ok("O2 another user cannot delete it (404)", r.status === 404);
  ok("O3 it is unchanged", (await query(`SELECT answers->>'q1' a FROM user_notebook_entries WHERE id = $1`, [id])).rows[0].a === "معدّل");
  ok("O4 other user's list does not include it", !(await call("GET", "/api/me/notebooks", null, Bu.token)).body.entries.some((e) => e.id === id));

  /* معرّفات غير صالحة */
  r = await call("PATCH", `/api/me/notebooks/nb-123-local`, { answers: {} }, A.token);
  ok("V1 a non-UUID id (e.g. an unsynced local id) → 404, not 500", r.status === 404, String(r.status));
  r = await call("DELETE", `/api/me/notebooks/not-a-uuid`, null, A.token);
  ok("V2 DELETE with a non-UUID id → 404, not 500", r.status === 404, String(r.status));
  r = await call("PATCH", `/api/me/notebooks/${id}`, { answers: {}, baseUpdatedAt: "yesterday" }, A.token);
  ok("V3 malformed baseUpdatedAt → 400", r.status === 400 && r.body.error === "invalid_base_updated_at");

  /* الحذف */
  r = await call("DELETE", `/api/me/notebooks/${id}`, null, A.token);
  ok("D1 delete removes it", r.status === 200 && (await query(`SELECT 1 FROM user_notebook_entries WHERE id = $1`, [id])).rowCount === 0);
  r = await call("DELETE", `/api/me/notebooks/${id}`, null, A.token);
  ok("D2 deleting again → 404 (the client treats it as already gone)", r.status === 404);
  r = await call("PATCH", `/api/me/notebooks/${id}`, { answers: { q1: "بعد الحذف" }, baseUpdatedAt: u1 }, A.token);
  ok("D3 a late save after delete does not resurrect it (404)", r.status === 404 && (await query(`SELECT 1 FROM user_notebook_entries WHERE id = $1`, [id])).rowCount === 0);
} catch (e) { R.push(["!! stopped: " + String(e.stack || e).slice(0, 300), false]); }

let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${x})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
server.close(); await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
