import { requireDedicatedDatabase } from "./test-support/guard.mjs"; // يجب أن يبقى أول استيراد
/**
 * KANAF-ORD-0014 §2.1 — اللوحة المبنية (admin-ui، ما يُخدَم فعلاً) مطابقة لمصدرها (admin-src).
 *  F1 بصمة البناء مسجَّلة.
 *  F2 🔴 مصدر اللوحة لم يتغيّر منذ آخر بناء (وإلا: عُدّل admin-src ولم يُبنَ).
 *  F3 🔴 الناتج لم يُعدَّل يدوياً منذ آخر بناء.
 *  F4 حيث يتوفّر Vite: بناء حقيقي من المصدر إلى مجلد مؤقت مطابق بايتاً بايتاً لما في git.
 *  F5 index.html يشير إلى ملفات موجودة.  F6 ملف البصمة لا يُخدَم للعموم.
 *  F7 الحزمة نسخة React الإنتاجية (كان البناء بـNODE_ENV غير production يُخرج التطويرية بلا إنذار).
 */
requireDedicatedDatabase(import.meta.url);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
process.env.PORT = "4647";
process.env.SKIP_PDF_BOOT_CHECK = "1";
const { sourceHash, outputHash, recorded } = await import("./test-support/panel-fingerprint.mjs");
const out = (s) => process.stdout.write(s + "\n");
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const FIX = "الإصلاح: cd admin-src && npm run build ثم ادفع admin-ui مع المصدر.";

const rec = recorded();
ok("F1 admin-ui/.build-fingerprint موجودة", rec && rec.source && rec.output);
ok("F2 🔴 مصدر اللوحة مطابق لما بُنيت منه admin-ui", rec?.source === sourceHash(), `admin-src تغيّر بعد آخر بناء. ${FIX}`);
ok("F3 🔴 admin-ui لم تُعدَّل يدوياً بعد البناء", rec?.output === outputHash(), `محتوى admin-ui لا يطابق ما سجّله البناء. ${FIX}`);

const vite = path.join("admin-src", "node_modules", ".bin", "vite");
if (fs.existsSync(vite)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panel-build-"));
  try {
    execFileSync(path.resolve(vite), ["build", "--outDir", tmp, "--emptyOutDir", "--logLevel", "error"], { cwd: "admin-src", stdio: "pipe" });
    const list = (d) => { const r = []; const w = (x) => fs.statSync(x).isDirectory() ? fs.readdirSync(x).forEach((n) => w(path.join(x, n))) : r.push(path.relative(d, x)); w(d); return r.sort(); };
    const built = list(tmp), committed = list("admin-ui").filter((f) => f !== ".build-fingerprint");
    const differ = built.filter((f) => !committed.includes(f) || !fs.readFileSync(path.join(tmp, f)).equals(fs.readFileSync(path.join("admin-ui", f))));
    const extra = committed.filter((f) => !built.includes(f));
    ok(`F4 🔴 بناء حقيقي من المصدر = admin-ui المتتبَّعة بايتاً بايتاً (${built.length} ملفاً)`, differ.length === 0 && extra.length === 0, `مختلف: ${differ.join(" ")} زائد: ${extra.join(" ")}. ${FIX}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
} else {
  out("  SKIP  F4 البناء الحقيقي: Vite غير مثبّت هنا (npm ci في admin-src) — F2/F3 تحرسان بالبصمة.");
}

const bundle = fs.readFileSync("admin-ui/assets/app.js", "utf8");
ok("F7 🔴 الحزمة المخدومة نسخة React الإنتاجية لا التطويرية", bundle.includes("Minified React error") && !/react-dom\.development|Warning: %s/.test(bundle), `${bundle.length} بايت`);

const html = fs.readFileSync("admin-ui/index.html", "utf8");
const refs = [...html.matchAll(/(?:src|href)="\/?([^"#?]+\.(?:js|css|svg|png|woff2?))"/g)].map((m) => m[1].replace(/^admin\//, ""));
ok("F5 كل ملف يشير إليه index.html موجود في admin-ui", refs.length >= 2 && refs.every((r) => fs.existsSync(path.join("admin-ui", r))), refs.join(" "));

const logs = []; console.log = (...a) => logs.push(a.join(" ")); console.error = console.log; console.warn = console.log;
await import("./index.js");
await new Promise((r) => setTimeout(r, 300));
const { pool } = await import("./db/pool.js");
const fp = await fetch("http://127.0.0.1:4647/.build-fingerprint");
const body = await fp.text();
ok("F6 ملف البصمة لا يُخدَم للعموم", fp.status === 404 && !body.includes("source "), String(fp.status));
await pool.end().catch(() => {});

let pass = 0, fail = 0;
for (const [l, c, x] of R) { if (c) { pass++; out(`  PASS  ${l}`); } else { fail++; out(`  FAIL  ${l}${x ? `  (${String(x).slice(0, 400)})` : ""}`); } }
out(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
