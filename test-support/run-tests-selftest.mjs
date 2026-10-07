/* ============================================================
   KANAF-ORD-0004 COR-04 — الدليل السلبي لمشغّل الاختبارات:
     node test-support/run-tests-selftest.mjs
   يشغّل run-tests.mjs على حالتين في مجلد سجلات مؤقت (لا يمس سجلات الجلسة):
     • selftest/zero-checks.mjs — خروج 0 بلا فحص ← يجب: سطر FAIL … no-checks، verdict=fail، خروج كلي ≠ 0
     • selftest/one-check.mjs   — فحص واحد ناجح  ← يجب: OK، verdict=ok
     • الاثنان معاً             ← خروج كلي ≠ 0 (ملف واحد بلا فحوص يكفي لإفشال التشغيل)
     • one-check وحده           ← خروج كلي 0
   ============================================================ */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const R = []; const ok = (l, c, x = "") => R.push([l, !!c, x]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kanaf-runner-selftest-"));
const run = (...files) => {
  const env = { ...process.env, KANAF_TEST_LOG_DIR: tmp }; delete env.SUPERUSER_URL;
  const r = spawnSync(process.execPath, ["test-support/run-tests.mjs", ...files], { cwd: ROOT, env, encoding: "utf8" });
  const summary = JSON.parse(fs.readFileSync(path.join(tmp, "summary.json"), "utf8")).summary;
  return { status: r.status, out: r.stdout + r.stderr, summary };
};
const Z = "test-support/selftest/zero-checks.mjs", O = "test-support/selftest/one-check.mjs";

const z = run(Z);
const zs = z.summary.find((s) => s.file === Z);
ok("N1 a file that exits 0 with no checks → FAIL … no-checks, verdict fail, overall exit non-zero",
  z.status !== 0 && zs?.exit === 0 && zs?.noChecks === true && zs?.verdict === "fail" && /^FAIL .*no-checks/m.test(z.out) && /no-checks=1/.test(z.out), `${z.status} ${JSON.stringify(zs)}`);
const o = run(O);
const os1 = o.summary.find((s) => s.file === O);
ok("P1 a file with one passing check and exit 0 → OK, verdict ok, overall exit 0",
  o.status === 0 && os1?.verdict === "ok" && os1?.noChecks === false && /^OK /m.test(o.out) && /no-checks=0/.test(o.out), `${o.status} ${JSON.stringify(os1)}`);
const b = run(O, Z);
ok("N2 one passing file plus one zero-check file → overall exit non-zero", b.status !== 0 && b.summary.length === 2, `${b.status}`);
fs.rmSync(tmp, { recursive: true, force: true });

let fail = 0;
for (const [l, c, x] of R) { if (!c) fail++; console.log(`  ${c ? "✔" : "✘"}  ${l}${!c && x ? `  (${x})` : ""}`); }
console.log(`\n  ${R.length - fail} ناجح، ${fail} فاشل`);
process.exit(fail ? 1 : 0);
