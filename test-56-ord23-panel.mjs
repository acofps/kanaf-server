import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0023 القسم ب — ملاحظات المالك الخمس في لوحة التحكم، على الخادم الكامل واللوحة المبنية.
 *  W) ب-3 تعيين كلمة مرور العميل: الحرّاس السبعة واحداً واحداً بالقياس.
 *  A) ب-5 الفاعل في سجلّ الإجراءات: الاسم والبريد، والمعرّف حين لا حساب، و«—» حين لا فاعل.
 *  L) ب-1 الحقل وقيمته متجاوران (≤24)، والبطاقة ≤720، والرصّ على الجوال بلا تمرير أفقي، ولمس 44.
 *  Z) ب-2 تكبير الصورة: يُفتح، ويُغلق بالخارج وEsc والزرّ، والبؤرة تعود، والحرف الأول لا يفتح شيئاً.
 *  S) ب-4 تأكيد الإرسال: ظاهر فوق الزرّ، يذكر ما أُرسل وإلى كم وبأي قناة، ويبقى، والفشل مميَّز.
 *  B) ب-6 جدول الفواتير كلها بمعاينة وتنزيل، وتأكيد الإلغاء يقول إنه لا يُعيد مالاً وينقل إلى الاسترداد.
 * لقطات الأدلة في test-support/.local/e2e-ord23/. بلا Playwright: فحوص الخادم وحدها، وSKIP للواجهة.
 */
requireDedicatedDatabase(import.meta.url);
import fs from "node:fs";
import crypto from "node:crypto";
let chromium = null;
{
  const { createRequire } = await import("node:module");
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync("/opt/pw-browsers")) process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers";
  for (const base of [import.meta.url, "file:///opt/node22/lib/node_modules/", "file:///opt/node-tools/", "file:///usr/local/lib/node_modules_global/"]) {
    try { ({ chromium } = createRequire(base)("playwright")); break; } catch { /* التالي */ }
  }
}
const { startSmtpSink, mimeParts } = await import("./test-support/smtp-sink.mjs");
const sink = await startSmtpSink();
process.env.PORT = "4656";
process.env.SKIP_PDF_BOOT_CHECK = "1";
process.env.ALLOWED_ORIGINS = "http://127.0.0.1:4656";
const logs = []; const rl = console.log; console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;
await import("./index.js");
const { query, pool } = await import("./db/pool.js");
const bcrypt = (await import("bcrypt")).default;
const jwt = (await import("jsonwebtoken")).default;
const { storeAvatar } = await import("./userdata/routes.js");
const { ERROR_AR } = await import("./admin-src/src/errors.js");
await new Promise((r) => setTimeout(r, 300));
const B = "http://127.0.0.1:4656";
const SHOTS = "test-support/.local/e2e-ord23"; fs.mkdirSync(SHOTS, { recursive: true });
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const OWNER_PW = "Owner-ORD23-Panel-Standards-2026";
const MEMBER_OLD = "Old-member-pass-2026";
let browser;

const adminCookie = (id, role) => `kanaf_admin_access=${jwt.sign({ sub: id, role, type: "access" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "15m" })}`;
async function call(method, path, { body, cookie, bearer } = {}) {
  const h = {};
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (cookie) h.Cookie = cookie;
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  const r = await fetch(B + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch { /* */ }
  return { status: r.status, body: json, raw, headers: r.headers };
}
/** كل جداول المخطط العام: كم صفاً يحمل النصّ needle في أي عمود (row::text). */
async function occurrences(needle) {
  const { rows: tables } = await query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  const hits = [];
  for (const { tablename } of tables) {
    const { rows } = await query(`SELECT count(*)::int n FROM "${tablename}" t WHERE position($1 in t::text) > 0`, [needle]);
    if (rows[0].n) hits.push(`${tablename}:${rows[0].n}`);
  }
  return hits;
}

try {
  /* ---------- البذر ---------- */
  const mk = async (name, email, role, active = true) => (await query(`INSERT INTO admin_users (name,email,password_hash,role,active) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [name, email, await bcrypt.hash(OWNER_PW, 12), role, active])).rows[0];
  const owner = await mk("ريم المالكة", "reem.owner@kanaf.test", "owner");
  const admin = await mk("مدير التشغيل", "ops.admin@kanaf.test", "admin");
  const support = await mk("دعم فني", "help.support@kanaf.test", "support");
  const content = await mk("محرر المحتوى", "content@kanaf.test", "content_manager");
  const gone = await mk("خالد السابق", "khaled.former@kanaf.test", "support", false);
  await query(`INSERT INTO subscription_plans (plan_key,name,price_sar,duration_days,display_order) VALUES ('monthly','الباقة الشهرية',29.00,30,1) ON CONFLICT (plan_key) DO NOTHING`);
  const { rows: [m] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at,confirmed_adult,age_range,gender) VALUES ('سارة العتيبي','sara.o23@example.com',$1,now(),true,'30-40','female') RETURNING id`, [await bcrypt.hash(MEMBER_OLD, 12)]);
  const { rows: [m2] } = await query(`INSERT INTO users (name,email,password_hash,email_verified_at,confirmed_adult) VALUES ('نورة بلا صورة','noura.o23@example.com','x',now(),true) RETURNING id`);
  await query(`INSERT INTO user_auth_state (user_id) VALUES ($1),($2)`, [m.id, m2.id]);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUklEQVR42u3PMQ0AAAgDoNm/9Ezh4w8VSE9VJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCTkxQPHmwF/VeY9CAAAAABJRU5ErkJggg==", "base64");
  const av = await storeAvatar(m.id, png);
  ok("SETUP صورة العضو محفوظة", !av.error, JSON.stringify(av.error || ""));
  await query(`INSERT INTO subscriptions (user_id, plan_id, status, started_at, current_period_end) VALUES ($1,'monthly','active',now()-interval '80 days',now()+interval '10 days')`, [m.id]);
  const invIds = [];
  for (let i = 0; i < 4; i++) {
    const { rows: [inv] } = await query(`INSERT INTO invoices (user_id, plan_id, amount_sar, status, zatca_invoice_number, subtotal_sar, vat_sar, zatca_issued_at, created_at, pdf_data)
      VALUES ($1,'monthly',29,'paid',$2,25.22,3.78,now()-($3||' days')::interval,now()-($3||' days')::interval,$4) RETURNING id`, [m.id, `TNFS-INV-0230${i}`, String(i * 30 + 1), Buffer.from(`%PDF-1.4\n%o23-${i}\n`)]);
    invIds.push(inv.id);
  }
  const GHOST = "00000000-0000-4000-8000-0000000000ab";
  const act = (adminId, action, ago) => query(`INSERT INTO admin_action_log (admin_user_id,target_user_id,action,entity,entity_id,old_value,new_value,reason,created_at)
    VALUES ($1,$2,$3,'user',$4,'{"a":1}','{"a":2}','بذر اختبار',now()-($5||' hours')::interval)`, [adminId, m.id, action, String(m.id), String(ago)]);
  await act(gone.id, "user_profile_edit", 30);
  await act(GHOST, "suspend_account", 20);

  const OW = adminCookie(owner.id, "owner");

  /* ================= W) ب-3 الحرّاس السبعة ================= */
  // (1) الصلاحية: users:edit وحدها — دعم ومحرر محتوى ← 403، وبلا جلسة ← 401، والمدير (users:edit) ← يُقبل
  let r = await call("POST", `/admin/users/${m.id}/password`, { cookie: adminCookie(support.id, "support"), body: { password: "Support-Should-Not-2026" } });
  const r2 = await call("POST", `/admin/users/${m.id}/password`, { cookie: adminCookie(content.id, "content_manager"), body: { password: "Content-Should-Not-2026" } });
  const r3 = await call("POST", `/admin/users/${m.id}/password`, { body: { password: "Anonymous-Should-Not-2026" } });
  ok("W1 🔴 (1) غير صاحب users:edit ← 403 (الدعم، ومحرر المحتوى)، وبلا جلسة ← 401", r.status === 403 && r2.status === 403 && r3.status === 401, `${r.status} ${r2.status} ${r3.status}`);
  const { rows: [{ ph: phAfterDenied }] } = await query(`SELECT password_hash ph FROM users WHERE id = $1`, [m.id]);
  ok("W1b والمرفوض لم يغيّر شيئاً (الكلمة القديمة باقية)", await bcrypt.compare(MEMBER_OLD, phAfterDenied));

  // (4) قاعدة القوة هي قاعدة المستخدم: قصيرة، شائعة، حرف مكرّر، أطول من 72 بايتاً — برسالة عربية تقول السبب
  const weak = [["short7!", "member_password_too_short"], ["password", "member_password_too_common"], ["qwertyuiop", "member_password_too_common"], ["aaaaaaaaaaaa", "member_password_too_common"], ["ك".repeat(40), "member_password_too_long"]];
  const weakBad = [];
  for (const [pw, code] of weak) {
    const x = await call("POST", `/admin/users/${m.id}/password`, { cookie: OW, body: { password: pw } });
    if (x.status !== 400 || x.body.error !== code || !/[؀-ۿ]/.test(ERROR_AR[code] || "")) weakBad.push(`${pw.slice(0, 6)}→${x.status} ${x.body.error}`);
  }
  ok(`W4 🔴 (4) ${weak.length} كلمات ضعيفة تُرفض بقاعدة المستخدم (validatePassword نفسها) ولكل رمز نصّ عربي يقول السبب`, weakBad.length === 0, weakBad.join(" | "));
  ok("W4b نصّ «القصيرة» يقول قاعدة العميل (ثمانية) لا قاعدة الإدارة (خمسة عشر)", /ثمانية/.test(ERROR_AR.member_password_too_short) && !/عشر/.test(ERROR_AR.member_password_too_short));

  // جلسة قائمة للعضو قبل التغيير
  const login0 = await call("POST", "/api/auth/login", { body: { email: "sara.o23@example.com", password: MEMBER_OLD } });
  ok("SETUP العضو دخل بكلمته القديمة (جلسة قائمة)", login0.status === 200 && !!login0.body.refreshToken, `${login0.status}`);
  const { rows: [{ n: liveBefore }] } = await query(`SELECT count(*)::int n FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [m.id]);

  // التعيين بخطوة واحدة
  const NEW_PW = `Sara-${crypto.randomBytes(6).toString("hex")}-2026`;
  sink.inbox.length = 0;
  const t0 = Date.now();
  r = await call("POST", `/admin/users/${m.id}/password`, { cookie: OW, body: { password: NEW_PW } });
  ok("W0 التعيين بخطوة واحدة ← 200، وجلسات أُنهيت، وبريد أُرسل", r.status === 200 && r.body.ok === true && r.body.sessionsRevoked >= 1 && r.body.email === "sent", r.raw);
  // (6) للكتابة فقط: لا في الردّ ولا في GET الملف
  const prof = await call("GET", `/admin/users/${m.id}`, { cookie: OW });
  ok("W6 🔴 (6) الكلمة لا تُعاد في أي ردّ: لا في ردّ التعيين، ولا في GET الملف (ولا حقل كلمة مرور ولا بصمة)",
    !r.raw.includes(NEW_PW) && !prof.raw.includes(NEW_PW) && !/password|hash/i.test(Object.keys(prof.body.user || prof.body).join(",")) && !/"\$2[aby]\$/.test(prof.raw),
    Object.keys(prof.body.user || prof.body).join(","));
  ok("W6b الردّ no-store", r.headers.get("cache-control") === "no-store", r.headers.get("cache-control"));

  // (3) الجلسات: القديمة سقطت فعلاً
  const { rows: [{ n: liveAfter }] } = await query(`SELECT count(*)::int n FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [m.id]);
  const refreshOld = await call("POST", "/api/auth/refresh", { body: { refreshToken: login0.body.refreshToken } });
  ok(`W3 🔴 (3) الجلسات القائمة كلها أُنهيت (${liveBefore} ← ${liveAfter})، وتجديد الجلسة القديمة ← 401`, liveBefore >= 1 && liveAfter === 0 && refreshOld.status === 401, `${liveBefore}→${liveAfter} refresh=${refreshOld.status} ${refreshOld.raw}`);
  const loginOld = await call("POST", "/api/auth/login", { body: { email: "sara.o23@example.com", password: MEMBER_OLD } });
  const loginNew = await call("POST", "/api/auth/login", { body: { email: "sara.o23@example.com", password: NEW_PW } });
  ok("W3b الكلمة القديمة لا تُدخل، والجديدة تُدخل فوراً (بلا تغيير إجباري عند الدخول)", loginOld.status === 401 && loginNew.status === 200 && !loginNew.raw.includes("must_change") && !loginNew.raw.includes("password_change_required"), `${loginOld.status} ${loginNew.status}`);
  const accessOld = await call("GET", "/api/auth/me", { bearer: login0.body.accessToken });
  const exp = jwt.decode(login0.body.accessToken)?.exp;
  ok(`W3c (قياس) رمز الوصول القديم عديم الحالة يبقى حتى انتهائه (${accessOld.status}، يبقى ${Math.round(exp - Date.now() / 1000)} ث ≤ 900) — كتغيير العميل كلمته بنفسه؛ والتجديد سقط`,
    (accessOld.status === 200 || accessOld.status === 401) && exp - Date.now() / 1000 <= 900, String(accessOld.status));

  // (5) التشفير القائم نفسه
  const { rows: [{ ph }] } = await query(`SELECT password_hash ph FROM users WHERE id = $1`, [m.id]);
  const { hashPassword } = await import("./auth/tokens.js");
  const ref = await hashPassword("x-reference-only");
  ok("W5 🔴 (5) مخزَّنة bcrypt بجولات hashPassword نفسها، وتطابق الكلمة الجديدة", /^\$2[aby]\$\d\d\$/.test(ph) && ph.slice(0, 7) === ref.slice(0, 7) && await bcrypt.compare(NEW_PW, ph), `${ph.slice(0, 7)} vs ${ref.slice(0, 7)}`);

  // (2) سجلّ الإجراءات: الفاعل والعميل والوقت — بلا الكلمة ولا بصمتها
  const { rows: logRows } = await query(`SELECT admin_user_id, target_user_id, action, old_value, new_value, metadata, created_at, reason FROM admin_action_log WHERE action = 'user_password_set_by_admin' AND target_user_id = $1`, [m.id]);
  const L0 = logRows[0];
  ok("W2 🔴 (2) سطر في سجلّ الإجراءات: الفاعل والعميل والوقت والسبب التلقائي، وقيمته {password: changed}",
    logRows.length === 1 && L0.admin_user_id === owner.id && L0.target_user_id === m.id && Math.abs(new Date(L0.created_at) - t0) < 10000 && JSON.stringify(L0.new_value) === '{"password":"changed"}' && /كلمة مرور العميل/.test(L0.reason),
    JSON.stringify(L0));
  const sha = crypto.createHash("sha256").update(NEW_PW).digest("hex");
  const anyPlain = await occurrences(NEW_PW), anySha = await occurrences(sha), anySha16 = await occurrences(sha.slice(0, 16)), anyHash = await occurrences(ph);
  ok("W2b 🔴 الكلمة لا تظهر في أي جدول بأي عمود (ولا sha256 لها ولا مقطعه)، والبصمة bcrypt في users.password_hash وحده",
    anyPlain.length === 0 && anySha.length === 0 && anySha16.length === 0 && anyHash.length === 1 && anyHash[0] === "users:1", `plain=${anyPlain} sha=${anySha} sha16=${anySha16} bcrypt=${anyHash}`);
  ok("W2c ولا في سجلّ الخادم (stdout/stderr) المطبوع أثناء الاختبار", !logs.join("\n").includes(NEW_PW));

  // (7) البريد: وصل بلا الكلمة، عبر سجلّ الرسائل
  const mail = sink.inbox.find((x) => x.to.some((t) => t.includes("sara.o23@example.com")));
  const parts = mail ? mimeParts(mail.data) : null;
  const mailText = mail ? `${mail.data}\n${(parts || []).map((x) => x.text).join("\n")}` : "";
  ok("W7 🔴 (7) وصل العميلَ بريد «غيّر فريق الدعم كلمة مرور حسابك» بلا الكلمة", !!mail && /الدعم/.test(mailText) && /كلمة مرور/.test(mailText) && !mailText.includes(NEW_PW), mail ? mailText.slice(0, 200) : "no mail");
  const { rows: sml } = await query(`SELECT kind, channel, status FROM system_message_log WHERE kind = 'password_set_by_support' ORDER BY created_at DESC LIMIT 1`);
  ok("W7b سُجّل في سجلّ رسائل النظام (password_set_by_support · email · sent)", sml[0]?.status === "sent" && sml[0]?.channel === "email", JSON.stringify(sml));

  // (7) فشل البريد لا يُسقط التغيير، ويُسجَّل ويُبلَّغ المسؤول
  sink.ctl.reject = () => true;
  const PW2 = `Sara-${crypto.randomBytes(6).toString("hex")}-fail`;
  r = await call("POST", `/admin/users/${m.id}/password`, { cookie: adminCookie(admin.id, "admin"), body: { password: PW2 } });
  sink.ctl.reject = null;
  const loginPw2 = await call("POST", "/api/auth/login", { body: { email: "sara.o23@example.com", password: PW2 } });
  const { rows: [L1] } = await query(`SELECT metadata FROM admin_action_log WHERE action = 'user_password_set_by_admin' AND target_user_id = $1 ORDER BY created_at DESC LIMIT 1`, [m.id]);
  ok("W7c 🔴 فشل البريد لا يُسقط التغيير: 200 والكلمة سارية، والردّ email=failed، والسطر notify_email=failed (والمدير صاحب users:edit يملكه)",
    r.status === 200 && r.body.email === "failed" && loginPw2.status === 200 && L1.metadata.notify_email === "failed", `${r.raw} login=${loginPw2.status} ${JSON.stringify(L1.metadata)}`);

  /* ================= A) ب-5 الفاعل ================= */
  const acts = await call("GET", `/admin/users/${m.id}/actions`, { cookie: OW });
  const byAction = (a) => acts.body.actions.find((x) => x.action === a);
  const pwRow = acts.body.actions.find((x) => x.action === "user_password_set_by_admin" && x.admin_user_id === owner.id);
  ok("A1 سجلّ إجراءات العميل يحمل الفاعل بالاسم والبريد (كانا مخزَّنين: admin_user_id، والاسم والبريد من admin_users)",
    pwRow?.admin_name === "ريم المالكة" && pwRow?.admin_email === "reem.owner@kanaf.test", JSON.stringify(pwRow || {}).slice(0, 200));
  ok("A2 حساب إدارة معطَّل يُعرض باسمه وبريده (لا يُحذف بل يُعطَّل)", byAction("user_profile_edit")?.admin_email === "khaled.former@kanaf.test");
  ok("A3 فاعل لا حساب له: المعرّف كما هو، والاسم والبريد null (لا تخمين)", byAction("suspend_account")?.admin_user_id === GHOST && byAction("suspend_account")?.admin_name === null && byAction("suspend_account")?.admin_email === null);
  const audit = await call("GET", "/admin/audit-log?pageSize=50", { cookie: OW });
  const ghostAudit = (audit.body.entries || []).find((x) => x.action === "suspend_account");
  ok("A4 صفحة «سجلّ الإجراءات» العامة: admin_email وadmin_user_id في كل سطر", ghostAudit?.admin_user_id === GHOST && (audit.body.entries || []).some((x) => x.admin_email === "reem.owner@kanaf.test"), JSON.stringify(ghostAudit || {}).slice(0, 160));

  /* ================= الواجهة ================= */
  if (!chromium) { R.push(["SKIP Playwright غير متاح — فحوص الواجهة لم تُجرَ", true, ""]); throw "skip-ui"; }
  browser = await chromium.launch();
  const login = async (page) => {
    await page.goto(`${B}/`); await page.fill('input[type="email"]', "reem.owner@kanaf.test"); await page.fill('input[type="password"]', OWNER_PW); await page.click('button[type="submit"]');
    await page.waitForSelector("main", { timeout: 15000 }); await page.waitForTimeout(300);
  };
  const shot = async (page, name) => {
    const vp = page.viewportSize(); const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
    await page.setViewportSize({ width: vp.width, height: Math.min(h, 4000) }); await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/${name}.png` }); await page.setViewportSize(vp);
  };
  const measure = (page) => page.evaluate(() => {
    const tr = (el) => { const x = document.createRange(); x.selectNodeContents(el); return x.getBoundingClientRect(); };
    const rows = [...document.querySelectorAll(".kv-row")].map((row) => { const a = tr(row.querySelector("dt")), b = tr(row.querySelector("dd")); return { stacked: b.top >= a.bottom - 1, gap: Math.round(a.left - b.right) }; });
    const kv = document.querySelector(".kv");
    const small = [...document.querySelectorAll(".u-touch button, .u-touch .u-tab, .u-touch a.kt-act")].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect()).filter((b) => b.width < 44 || b.height < 44).length;
    return { rows, kvW: kv ? Math.round(kv.getBoundingClientRect().width) : null, hscroll: document.documentElement.scrollWidth > innerWidth, small };
  });

  for (const theme of ["light", "dark"]) for (const [vpName, vp] of [["desktop", { width: 1920, height: 1080 }], ["mobile", { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: vpName === "desktop" ? 1 : 2, locale: "ar" });
    await ctx.addInitScript((t) => { try { localStorage.setItem("tanaffus-admin-theme", t); } catch { /* */ } }, theme);
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(e.message));
    await login(page);
    for (const tab of ["profile", "billing"]) {
      await page.goto(`${B}/users/${m.id}${tab === "profile" ? "" : "/billing"}`); await page.waitForSelector(".kv-row"); await page.waitForTimeout(500);
      const mm = await measure(page);
      const gaps = mm.rows.filter((x) => !x.stacked).map((x) => x.gap);
      if (vpName === "desktop") ok(`L1 🔴 ${theme}/${tab} 1920: العنوان ملاصق لقيمته (${Math.min(...gaps)}–${Math.max(...gaps)} بكسل ≤ 24) في ${mm.rows.length} سطراً، والبطاقة ${mm.kvW} ≤ 720`,
        gaps.length === mm.rows.length && gaps.every((g) => g >= 0 && g <= 24) && mm.kvW <= 720, JSON.stringify(mm));
      else ok(`L2 ${theme}/${tab} 390: العنوان فوق قيمته في كل سطر، بلا تمرير أفقي`, mm.rows.length > 0 && mm.rows.every((x) => x.stacked) && !mm.hscroll, JSON.stringify(mm));
      ok(`L3 ${vpName}/${theme}/${tab}: كل زرّ وتبويب ورابط فعل في الصفحة 44×44 على الأقل`, mm.small === 0, String(mm.small));
      await shot(page, `${vpName}-${theme}-${tab}`);
    }
    if (theme === "light" && vpName === "desktop") {
      /* ---------- Z) ب-2 ---------- */
      await page.goto(`${B}/users/${m.id}`); await page.waitForSelector("[data-avatar-zoom]");
      const openZoom = async () => { await page.click("[data-avatar-zoom]"); await page.waitForSelector('[role="dialog"] img'); await page.waitForTimeout(250); };
      await openZoom();
      const big = await page.locator('[role="dialog"] img').evaluate((i) => ({ w: i.getBoundingClientRect().width, nat: i.naturalWidth }));
      const closeVisible = await page.locator("[data-avatar-close]").evaluate((b) => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, text: b.innerText.trim() }; });
      await page.screenshot({ path: `${SHOTS}/zoom-open.png` });
      ok(`Z1 الضغط على الصورة يفتحها مكبَّرة (${Math.round(big.w)} بكسل بعد 56) وزرّ «إغلاق» ظاهر ${closeVisible.w}×${closeVisible.h}`, big.nat > 0 && big.w >= 300 && closeVisible.w >= 44 && closeVisible.h >= 44 && closeVisible.text === "إغلاق", JSON.stringify({ big, closeVisible }));
      await page.keyboard.press("Escape"); await page.waitForTimeout(200);
      const afterEsc = await page.evaluate(() => ({ open: !!document.querySelector('[role="dialog"]'), focus: document.activeElement?.hasAttribute("data-avatar-zoom") }));
      ok("Z2 🔴 Esc يُغلقها والبؤرة تعود إلى الصورة", !afterEsc.open && afterEsc.focus, JSON.stringify(afterEsc));
      await openZoom(); await page.mouse.click(30, 30); await page.waitForTimeout(200);
      const afterOut = await page.evaluate(() => ({ open: !!document.querySelector('[role="dialog"]'), focus: document.activeElement?.hasAttribute("data-avatar-zoom") }));
      ok("Z3 🔴 الضغط خارجها يُغلقها والبؤرة تعود", !afterOut.open && afterOut.focus, JSON.stringify(afterOut));
      await openZoom(); await page.click("[data-avatar-close]"); await page.waitForTimeout(200);
      const afterBtn = await page.evaluate(() => ({ open: !!document.querySelector('[role="dialog"]'), focus: document.activeElement?.hasAttribute("data-avatar-zoom") }));
      ok("Z4 🔴 زرّ «إغلاق» يُغلقها والبؤرة تعود", !afterBtn.open && afterBtn.focus, JSON.stringify(afterBtn));
      await openZoom(); await page.click('[role="dialog"] img'); await page.waitForTimeout(150);
      ok("Z5 الضغط على الصورة المكبَّرة نفسها لا يُغلقها", await page.locator('[role="dialog"]').count() === 1);
      await page.keyboard.press("Escape");
      await page.goto(`${B}/users/${m2.id}`); await page.waitForSelector(".kv-row");
      const initial = await page.evaluate(() => ({ btn: document.querySelectorAll("[data-avatar-zoom]").length }));
      await page.locator("main").getByText("ن", { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(200);
      ok("Z6 🔴 بلا صورة (الحرف الأول): لا زرّ تكبير، والضغط على الحرف لا يفتح شيئاً", initial.btn === 0 && await page.locator('[role="dialog"]').count() === 0, JSON.stringify(initial));

      /* ---------- W-UI) ب-3 في الواجهة ---------- */
      await page.goto(`${B}/users/${m.id}/edit`); await page.waitForSelector("[data-set-password] input");
      const pwInput = page.locator("[data-set-password] input");
      const fresh = await pwInput.evaluate((i) => ({ v: i.value, t: i.type, ac: i.autocomplete }));
      ok("W8 الحقل فارغ عند فتح الصفحة، من نوع password، وautocomplete=new-password", fresh.v === "" && fresh.t === "password" && fresh.ac === "new-password", JSON.stringify(fresh));
      let posted = 0; page.on("request", (q) => { if (/\/password$/.test(q.url()) && q.method() === "POST") posted++; });
      await page.getByRole("button", { name: "ولّد كلمة قوية" }).click();
      const gen = await pwInput.inputValue();
      ok("W9 «ولّد كلمة قوية» يملأ الحقل أمام المسؤول (≥ 20 حرفاً) ولا يُرسل شيئاً قبل «تعيين»", gen.length >= 20 && posted === 0, `${gen.length} posted=${posted}`);
      await page.getByRole("button", { name: "تعيين كلمة المرور" }).click();
      await page.waitForSelector("[data-password-result]");
      const res = await page.locator("[data-password-result]").innerText();
      const after = await pwInput.inputValue();
      await shot(page, "password-set");
      ok("W10 بعد الحفظ: رسالة «عُيّنت وسرت» ثابتة، والحقل فُرِّغ، والكلمة لا تظهر في الصفحة", /عُيّنت كلمة المرور/.test(res) && after === "" && !(await page.content()).includes(gen) && posted === 1, `${res} posted=${posted}`);
      await page.reload(); await page.waitForSelector("[data-set-password] input");
      ok("W11 بعد إعادة التحميل: الحقل فارغ (لا يُقرأ من أي شاشة)", (await page.locator("[data-set-password] input").inputValue()) === "");
      const loginGen = await call("POST", "/api/auth/login", { body: { email: "sara.o23@example.com", password: gen } });
      ok("W12 الكلمة المولَّدة من الواجهة سارية فوراً", loginGen.status === 200, String(loginGen.status));

      /* ---------- S) ب-4 ---------- */
      sink.inbox.length = 0;
      await page.goto(`${B}/users/${m.id}/message?channel=email`); await page.waitForSelector("textarea");
      await page.locator("main input").first().fill("تذكير بموعد الجلسة");
      await page.locator("main textarea").first().fill("مرحباً سارة، هذا تذكير.");
      await page.getByRole("button", { name: "إرسال الآن" }).click();
      await page.waitForSelector("[data-send-result]");
      const s1 = await page.locator("[data-send-result]").evaluate((e) => ({ tone: e.dataset.sendResult, text: e.innerText, role: e.getAttribute("role"), r: e.getBoundingClientRect().toJSON(), vh: innerHeight }));
      const btn = await page.getByRole("button", { name: "إرسال الآن" }).evaluate((b) => b.getBoundingClientRect().toJSON());
      await page.screenshot({ path: `${SHOTS}/send-ok.png` });
      ok("S1 🔴 رسالة نجاح تذكر ما أُرسل («العنوان») وإلى كم (1) وبأي قناة (بريد)، خضراء role=status", s1.tone === "ok" && s1.role === "status" && s1.text.includes("تذكير بموعد الجلسة") && /إلى 1 من 1 مستلم/.test(s1.text) && s1.text.includes("بريد"), JSON.stringify(s1));
      ok(`S2 ظاهرة في مجال النظر وفوق زرّ الإرسال مباشرة (${Math.round(btn.top - s1.r.bottom)} بكسل فوقه)`, s1.r.top >= 0 && s1.r.bottom <= s1.vh && s1.r.bottom <= btn.top && btn.top - s1.r.bottom <= 24, JSON.stringify({ r: s1.r, btn }));
      await page.waitForTimeout(6000);
      ok("S3 🔴 تبقى بعد 6 ثوانٍ (حتى تُغلق)، والنموذج فُرِّغ", await page.locator("[data-send-result]").count() === 1 && (await page.locator("main textarea").first().inputValue()) === "");
      await page.getByRole("button", { name: "إغلاق رسالة النتيجة" }).click();
      ok("S4 زرّ الإغلاق يُخفيها", await page.locator("[data-send-result]").count() === 0);
      ok("S5 والبريد وصل فعلاً", sink.inbox.some((x) => x.to.some((t) => t.includes("sara.o23@example.com"))));
      sink.ctl.reject = () => true;
      await page.locator("main input").first().fill("رسالة ستفشل");
      await page.locator("main textarea").first().fill("نصّ.");
      await page.getByRole("button", { name: "إرسال الآن" }).click();
      await page.waitForSelector("[data-send-result]");
      const s6 = await page.locator("[data-send-result]").evaluate((e) => ({ tone: e.dataset.sendResult, text: e.innerText, role: e.getAttribute("role") }));
      sink.ctl.reject = null;
      await page.screenshot({ path: `${SHOTS}/send-fail.png` });
      ok("S6 🔴 الفشل مميَّز: لوحة حمراء role=alert «لم تُرسَل الرسالة» والنموذج باقٍ لإعادة المحاولة", s6.tone === "fail" && s6.role === "alert" && /لم تُرسَل/.test(s6.text) && (await page.locator("main input").first().inputValue()) === "رسالة ستفشل", JSON.stringify(s6));

      /* ---------- A-UI) ب-5 ---------- */
      await page.goto(`${B}/users/${m.id}/actions`); await page.waitForSelector("table.kt tbody tr");
      const actorCells = await page.evaluate(() => [...document.querySelectorAll("table.kt tbody tr")].map((tr) => tr.children[1].innerText.replace(/\s+/g, " ").trim()));
      await shot(page, "actions-actor");
      ok("A5 تبويب «سجلّ الإجراءات»: عمود الفاعل بالاسم والبريد، والمعرّف لمن لا حساب له", actorCells.some((t) => t.includes("ريم المالكة") && t.includes("reem.owner@kanaf.test")) && actorCells.some((t) => t.includes(GHOST)), actorCells.join(" | "));
      await page.goto(`${B}/audit-log`); await page.waitForSelector("table.kt tbody tr"); await page.waitForTimeout(300);
      const auditCells = await page.evaluate(() => [...document.querySelectorAll("table.kt tbody tr")].map((tr) => tr.children[1]?.innerText.replace(/\s+/g, " ").trim()).filter(Boolean));
      await shot(page, "audit-log-actor");
      ok("A6 صفحة «سجلّ الإجراءات» العامة: الاسم والبريد في عمود المسؤول", auditCells.some((t) => t.includes("ريم المالكة") && t.includes("reem.owner@kanaf.test")), auditCells.slice(0, 4).join(" | "));
    }
    if (theme === "light") {
      /* ---------- B) ب-6 ---------- */
      await page.goto(`${B}/users/${m.id}/billing`); await page.waitForSelector("[data-user-invoices] table tbody tr");
      const inv = await page.evaluate(() => [...document.querySelectorAll("[data-user-invoices] tbody tr")].map((tr) => ({ cells: tr.children.length, num: tr.children[0].innerText.trim(), prev: tr.querySelector("[data-preview]")?.getAttribute("href"), dl: tr.querySelector("[data-download]")?.getAttribute("href") })));
      ok(`B1 🔴 ${vpName}: جدول بفواتير العميل كلها (${inv.length} من 4)، في كل صفّ رقم وتاريخ ومبلغ وحالة ومعاينة وتنزيل`, inv.length === 4 && inv.every((x) => x.cells === 5 && /^TNFS-INV-0230\d$/.test(x.num) && /\/admin\/invoices\/[0-9a-f-]+\/pdf$/.test(x.prev || "") && /\?download=1$/.test(x.dl || "")), JSON.stringify(inv));
      if (vpName === "desktop") {
        const pdf = await page.evaluate(async (u) => { const x = await fetch(u, { credentials: "include" }); return { s: x.status, t: x.headers.get("content-type"), d: x.headers.get("content-disposition") }; }, inv[0].prev);
        const pdfDl = await page.evaluate(async (u) => { const x = await fetch(u, { credentials: "include" }); return { s: x.status, d: x.headers.get("content-disposition") }; }, inv[0].dl);
        ok("B2 المعاينة PDF inline والتنزيل attachment — مسار صفحة الفواتير القائم نفسه", pdf.s === 200 && /pdf/.test(pdf.t) && /inline/.test(pdf.d || "") && pdfDl.s === 200 && /attachment/.test(pdfDl.d || ""), JSON.stringify({ pdf, pdfDl }));
      }
      await page.getByRole("button", { name: "إلغاء", exact: true }).first().click();
      await page.waitForSelector("[data-cancel-refund-note]");
      const note = await page.locator("[data-cancel-refund-note]").innerText();
      await page.screenshot({ path: `${SHOTS}/${vpName}-cancel-confirm.png` });
      ok(`B3 🔴 ${vpName}: تأكيد الإلغاء يقول «الإلغاء لا يُعيد مالاً… استخدم «استرداد مبلغ»» ومعه زرّ الانتقال`, /الإلغاء لا يُعيد مالاً/.test(note) && /استرداد مبلغ/.test(note) && await page.getByRole("button", { name: "الانتقال إلى «استرداد مبلغ»" }).count() === 1, note);
      await page.getByRole("button", { name: "الانتقال إلى «استرداد مبلغ»" }).click();
      await page.waitForTimeout(700);
      const focus = await page.evaluate(() => ({ dialog: !!document.querySelector('[role="dialog"], .fixed.inset-0'), onRefund: document.activeElement?.hasAttribute("data-refund-card"), outline: getComputedStyle(document.querySelector("[data-refund-card]")).outlineStyle, inView: (() => { const b = document.querySelector("[data-refund-card]").getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; })() }));
      await page.screenshot({ path: `${SHOTS}/${vpName}-refund-highlight.png` });
      ok(`B4 🔴 ${vpName}: الزرّ يُغلق التأكيد، وينقل البؤرة إلى بطاقة الاسترداد ويُبرزها في مجال النظر`, !focus.dialog && focus.onRefund && focus.outline === "solid" && focus.inView, JSON.stringify(focus));
      const { rows: [{ st }] } = await query(`SELECT status st FROM subscriptions WHERE user_id = $1`, [m.id]);
      const { rows: [{ n: refunds }] } = await query(`SELECT count(*)::int n FROM refunds WHERE user_id = $1`, [m.id]);
      ok(`B5 🔴 ${vpName}: لا إلغاء ولا استرداد وقع تلقائياً (الاشتراك ${st}، الاستردادات ${refunds})`, st === "active" && refunds === 0);
    }
    ok(`E0 ${vpName}/${theme}: لا أخطاء صفحة`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} catch (e) { if (e !== "skip-ui") R.push(["!! stopped: " + String(e?.stack || e).slice(0, 600), false]); }
await browser?.close().catch(() => {});
console.log = rl;
let p = 0, f = 0;
for (const [l, c, x] of R) { if (c) { p++; console.log(`  PASS  ${l}`); } else { f++; console.log(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 1500)})` : ""}`); } }
console.log(`\n  ${p} passed, ${f} failed`);
if (f) console.log(logs.slice(-15).join("\n"));
await pool.end().catch(() => {});
process.exit(f ? 1 : 0);
