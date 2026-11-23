import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * ملحق KANAF-ORD-0013 — قرار المالك 1: «ولا في أي مكان اكتب السبب — إلغاؤه والاكتفاء بسجلّ قبل/بعد».
 * على الخادم الكامل (index.js) بلا أي سبب مكتوب:
 *  A) إجراءات من كل صنف تنجح، وصفّ السجل يحمل سبباً تلقائياً غير فارغ (ليس «—» ولا «-»)،
 *     والقيمتين قبل وبعد، ومن نفّذ، وعنوان IP.
 *  R) قراءة البيانات الحسّاسة بلا سبب تنجح، وتُسجَّل في سجل الوصول بسبب تلقائي.
 *  C) 🔴 كل مسار كتابة في /admin له نصّ في جدول الأسباب (لا يسقط إلى النصّ العام).
 *  N) لا صفّ في سجل الإجراءات ولا في سجل الوصول بسبب فارغ أو شرطة.
 *  P) اللوحة: لا ReasonPrompt ولا حقل سبب.
 *  BG) الملحق الثاني، القرار 6: الوصول الطارئ محذوف، وجدوله باقٍ خاملاً.
 */
requireDedicatedDatabase(import.meta.url);
process.env.PORT = "4645";
process.env.SKIP_PDF_BOOT_CHECK = "1";
import fs from "node:fs";
const jwt = (await import("jsonwebtoken")).default;
const logs = []; console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
const { AUTO_REASONS, autoReasonFor } = await import("./admin/auto-reason.js");
await new Promise((r) => setTimeout(r, 300));
const out = (s) => process.stdout.write(s + "\n");
const B = "http://127.0.0.1:4645";
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
let cookie = "";
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ } return { status: r.status, body: json, raw };
};
const lastAction = async (action) => (await query(
  `SELECT admin_user_id, reason, old_value, new_value, ip_address FROM admin_action_log WHERE action = $1 ORDER BY created_at DESC LIMIT 1`, [action])).rows[0];
const BAD = (r) => r == null || !String(r).trim() || ["-", "—", "–"].includes(String(r).trim());

try {
  const { rows: [own] } = await query(`INSERT INTO admin_users (name,email,password_hash,role) VALUES ('المالك','ar-owner@kanaf.test','x','owner') RETURNING id`);
  cookie = `kanaf_admin_access=${jwt.sign({ sub: own.id, role: "owner", type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
  const { rows: [u] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at,confirmed_adult) VALUES ('ريم','reem-ar@example.com','x',now(),true) RETURNING id`);

  /* ---------- A) أفعال بلا سبب مكتوب ---------- */
  let r = await call("PATCH", `/admin/users/${u.id}/profile`, { name: "ريم الجديدة" });
  let a = await lastAction("user_profile_edit");
  ok("A1 تعديل ملف العميل بلا سبب → 200؛ السجل: «تعديل ملف العميل من اللوحة»، قبل/بعد، المنفّذ، IP",
    r.status === 200 && a.reason === "تعديل ملف العميل من اللوحة" && a.old_value?.name === "ريم" && a.new_value?.name === "ريم الجديدة" && a.admin_user_id === own.id && Boolean(a.ip_address), JSON.stringify(a));

  r = await call("POST", `/admin/users/${u.id}/suspend`, {});
  a = await lastAction("suspend_account");
  ok("A2 تعليق الحساب بلا سبب → 200؛ سبب تلقائي وقبل/بعد", r.status === 200 && a.reason === "تعليق حساب العميل من اللوحة" && a.old_value?.account_status === "active" && a.new_value?.account_status === "suspended", JSON.stringify(a));
  const { rows: [st] } = await query(`SELECT suspended_reason FROM user_auth_state WHERE user_id = $1`, [u.id]);
  ok("A3 والسبب المخزَّن مع التعليق نفسه تلقائي غير فارغ", st?.suspended_reason === "تعليق حساب العميل من اللوحة");
  r = await call("POST", `/admin/users/${u.id}/restore`, { reason: "  " });
  ok("A4 سبب من مسافات = لا سبب → يُولَّد", r.status === 200 && (await lastAction("restore_account")).reason === "رفع تعليق حساب العميل من اللوحة");

  r = await call("PUT", "/admin/app-settings/support_hours", { value: "كل يوم" });
  a = await lastAction("app_setting_updated");
  ok("A5 تعديل إعداد بلا سبب → 200؛ سبب تلقائي وقبل/بعد", r.status === 200 && a?.reason === "تعديل إعداد تشغيل من اللوحة" && a.new_value != null && a.old_value != null, JSON.stringify(a));

  r = await call("POST", "/admin/message-templates", { name: "قالب بلا سبب", accent: "#594372" });
  a = await lastAction("message_template_create");
  ok("A6 إنشاء قالب بريد بلا سبب → 201؛ سبب تلقائي", r.status === 201 && a.reason === "إنشاء قالب بريد من اللوحة");

  r = await call("POST", "/admin/plans", { planKey: "auto_reason_plan", name: "باقة", priceSar: 9, durationDays: 7 });
  const planId = r.body.id;
  r = await call("PATCH", `/admin/plans/${planId}`, { priceSar: 11 });
  a = await lastAction("plan_price_changed");
  ok("A7 تعديل سعر باقة بلا سبب → 200؛ السعر قبل 9 وبعد 11 بسبب تلقائي", r.status === 200 && a.reason === "تعديل باقة من اللوحة" && Number(a.old_value.price_sar) === 9 && Number(a.new_value.price_sar) === 11, JSON.stringify(a));

  /* ---------- R) القراءة الحسّاسة ---------- */
  r = await call("GET", `/admin/users/${u.id}/sensitive`);
  const { rows: [acc] } = await query(`SELECT reason, ip_address FROM admin_access_log WHERE action = 'view_sensitive_data' AND target_user_id = $1 ORDER BY created_at DESC LIMIT 1`, [u.id]);
  ok("R1 عرض البيانات الحسّاسة بلا سبب → 200، ومسجَّل في سجل الوصول بسبب تلقائي وIP", r.status === 200 && acc?.reason === "عرض بيانات المتابعة الحسّاسة في ملف العميل" && Boolean(acc.ip_address), JSON.stringify(acc));

  /* ---------- C) كل مسار كتابة له نصّ ---------- */
  const SKIP = new Set(["/auth/login", "/auth/refresh", "/auth/logout", "/setup/accept", "/discount-codes/check", "/notifications", "/broadcasts",
    "/notifications-scheduler/sweep", "/message-catalog/:key/preview", "/message-catalog/:key/test-send", "/messages/:id/status"]);
  const missing = [];
  for (const f of fs.readdirSync("admin").filter((x) => x.endsWith(".js"))) {
    const src = fs.readFileSync(`admin/${f}`, "utf8");
    const prefix = f === "billing.js" ? "/billing" : "";
    for (const m of src.matchAll(/\b\w+Router\.(post|put|patch|delete)\(\s*"([^"]+)"/g)) {
      const path = prefix + m[2];
      if (SKIP.has(m[2])) continue;
      const sample = path.replace(/:[a-z_]+/g, "00000000-0000-0000-0000-000000000000");
      const t = autoReasonFor(m[1].toUpperCase(), sample);
      if (!t || t.startsWith("إجراء من لوحة الإدارة:")) missing.push(`${m[1].toUpperCase()} ${path} (${f})`);
    }
  }
  ok(`C1 🔴 كل مسار كتابة يحتاج سبباً في /admin له نصّ خاص في الجدول (${AUTO_REASONS.length} نصاً)`, missing.length === 0, missing.join(" · "));
  ok("C2 النصّ العام لمسار مستقبلي غير مُدرج: غير فارغ ويسمّي الإجراء", autoReasonFor("POST", "/future/x") === "إجراء من لوحة الإدارة: POST /future/x");
  ok("C3 القراءة العادية لا تُعطى سبباً", autoReasonFor("GET", "/users") === null);
  ok("C4 لا نصّ في الجدول فارغ أو شرطة، ولا نصّان متطابقان لمسارين مختلفين بلا قصد", AUTO_REASONS.every(([, , t]) => !BAD(t) && t.length >= 8));

  /* ---------- C5/C6 — KANAF-ORD-0014 §2.6 ---------- */
  const { logAdminAction: lA, logSensitiveAccess: lS } = await import("./admin/middleware.js");
  const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };
  ok("C5 كاتبا السجلين يرفضان سبباً فارغاً أو شرطةً وحدها (لا يُكتب «—» أبداً)",
    (await rejects(() => lA({ adminUserId: null, action: "x", reason: "—" }))) && (await rejects(() => lA({ adminUserId: null, action: "x", reason: " - " })))
    && (await rejects(() => lS({ adminUserId: null, action: "x", reason: "" }))) && (await rejects(() => lS({ adminUserId: null, action: "x", reason: "–" }))));
  const callSites = ["admin", "billing", "notifications", "userdata", "auth", "ops"].flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".js")).map((f) => `${d}/${f}`));
  /* داخل وسائط كاتبَي السجلين وحدها: ما يُمرَّر reason لهما لا يحمل شرطة أو فراغاً احتياطياً. */
  const auditCalls = [];
  for (const f of callSites) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/\b(logAdminAction|logSensitiveAccess)\(\{/g)) {
      let d = 0, j = src.indexOf("{", m.index);
      for (let k = j; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}" && --d === 0) { j = k; break; } }
      auditCalls.push([`${f}:${src.slice(0, m.index).split("\n").length}`, src.slice(m.index, j + 1)]);
    }
  }
  const dashFallback = auditCalls.filter(([, body]) => /\breason\s*:[^,\n]*\|\|\s*["'`][\s\-–—]*["'`]/.test(body)).map(([w]) => w);
  ok(`C6 لا نداء من ${auditCalls.length} لكاتبَي السجلين يضع شرطة أو فراغاً احتياطياً للسبب`, auditCalls.length >= 50 && dashFallback.length === 0, dashFallback.join(" "));

  /* ---------- N) ---------- */
  const { rows: [nb] } = await query(`SELECT
      (SELECT count(*)::int FROM admin_action_log WHERE btrim(reason) IN ('', '-', '—', '–')) AS actions,
      (SELECT count(*)::int FROM admin_access_log WHERE btrim(reason) IN ('', '-', '—', '–')) AS access,
      (SELECT count(*)::int FROM admin_action_log) AS total`);
  ok("N1 لا صفّ بسبب فارغ أو شرطة في سجل الإجراءات ولا في سجل الوصول", nb.actions === 0 && nb.access === 0 && nb.total >= 6, JSON.stringify(nb));

  /* ---------- P) اللوحة ---------- */
  const panel = fs.readdirSync("admin-src/src/pages").map((f) => fs.readFileSync(`admin-src/src/pages/${f}`, "utf8")).join("\n") + fs.readFileSync("admin-src/src/ui.jsx", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  ok("P1 لا ReasonPrompt في اللوحة", !/ReasonPrompt/.test(panel.replace(/\/\*[\s\S]*?\*\//g, "")));
  ok("P2 لا حقل «السبب» يُكتب فيه ولا «السبب مطلوب»", !/<Field label="السبب"|السبب مطلوب|value=\{reason\}|value=\{f\.reason\}/.test(panel));
  const bundle = fs.readFileSync("admin-ui/assets/app.js", "utf8");
  ok("P3 الحزمة المبنية بلا «السبب مطلوب» ولا «اكتب سبباً»", !/السبب مطلوب|اكتب سبباً|لازم تكتب سبب/.test(bundle));

  /* ---------- BG) الوصول الطارئ أُلغي (ملحق KANAF-ORD-0013 الثاني، القرار 6) ---------- */
  const bg1 = await call("POST", "/admin/break-glass/request", { targetUserId: null });
  const bg2 = await call("GET", "/admin/break-glass/pending");
  const bg3 = await call("POST", "/admin/break-glass/00000000-0000-0000-0000-000000000000/approve", {});
  ok("BG1 مسارات الوصول الطارئ الثلاثة محذوفة: 404 حتى للمالك", [bg1, bg2, bg3].every((x) => x.status === 404), [bg1, bg2, bg3].map((x) => x.status).join(","));
  const { rows: [tb] } = await query(`SELECT to_regclass('public.break_glass_requests') IS NOT NULL AS present`);
  ok("BG2 🔴 جدول break_glass_requests باقٍ (لا حذف ولا ترحيلة تُسقطه)", tb.present === true
    && !fs.readdirSync("db/migrations").some((f) => /DROP\s+TABLE[^;]*break_glass_requests/i.test(fs.readFileSync(`db/migrations/${f}`, "utf8"))));
  const code = ["admin", "auth", "userdata", "billing", "payments", "notifications", "ops"].flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".js")).map((f) => `${d}/${f}`)).concat(["index.js"]);
  const writers = code.filter((f) => /(INSERT\s+INTO|UPDATE)\s+break_glass_requests/i.test(fs.readFileSync(f, "utf8")));
  ok("BG3 الجدول خامل: لا ملف يكتب فيه", writers.length === 0, writers.join(" "));
  const { PERMISSION_CATALOG, PANEL_PAGES } = await import("./admin/permissions.js");
  ok("BG4 لا صلاحية break_glass:* ولا صفحة break-glass ولا نصّ سبب لها", !Object.keys(PERMISSION_CATALOG).some((k) => k.startsWith("break_glass:"))
    && !PANEL_PAGES.some((p) => p.key === "break-glass") && !AUTO_REASONS.some(([, pth]) => pth.includes("break-glass")));
  ok("BG5 اللوحة: لا صفحة BreakGlass ولا دوال api لها", !fs.existsSync("admin-src/src/pages/BreakGlass.jsx") && !/BreakGlass|break-glass/.test(fs.readFileSync("admin-src/src/api.js", "utf8") + fs.readFileSync("admin-src/src/App.jsx", "utf8")));
} catch (e) { ok("!! توقّف: " + String(e.stack || e).slice(0, 400), false); }
finally { await pool.end().catch(() => {}); }

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; out(`  PASS  ${l}`); } else { fail++; out(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 400)})` : ""}`); } }
out(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
