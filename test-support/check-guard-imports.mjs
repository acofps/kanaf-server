/* يتحقق أن أول استيراد في كل ملف test-*.mjs هو الحارس المركزي.
   ملف اختبار جديد بلا الحارس = فشل هذا الفحص (exit 1).
     node test-support/check-guard-imports.mjs */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = fs.readdirSync(ROOT).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  const first = src.match(/^\s*import\s[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/m);
  const spec = first && (first[1] || first[2]);
  const ok = spec === "./test-support/guard.mjs";
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "FAIL"} ${f}  first import: ${spec || "∅"}`);
}
console.log(`\n${files.length - bad}/${files.length} test files guarded`);
process.exit(bad ? 1 : 0);
