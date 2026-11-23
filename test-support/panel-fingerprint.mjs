/* ============================================================
   بصمة اللوحة المبنية — KANAF-ORD-0014 §2.1

   admin-ui/ متتبَّع في git وهو ما يخدمه Express فعلاً. من يعدّل admin-src
   وينسى البناء يدفع كوداً سليماً ولوحة قديمة، بلا اختبار يسقط.

   كل بناء (npm run build في admin-src) يكتب admin-ui/.build-fingerprint:
     source  = بصمة مدخلات البناء في admin-src (src/، public/، index.html،
               الإعدادات، package.json، package-lock.json)
     output  = بصمة كل ملف في admin-ui (عدا هذا الملف نفسه)
   والاختبار test-46 يعيد حسابهما. أي اختلاف = مصدر تغيّر بلا بناء، أو لوحة
   عُدّلت يدوياً. الملف يبدأ بنقطة، فلا يخدمه express.static (dotfiles: ignore).

   الاستعمال:  node test-support/panel-fingerprint.mjs --write   (يُنادى بعد البناء)
              node test-support/panel-fingerprint.mjs            (يطبع الحالة)
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "admin-src");
const OUT = path.join(ROOT, "admin-ui");
export const FINGERPRINT_FILE = path.join(OUT, ".build-fingerprint");
const SOURCE_ENTRIES = ["src", "public", "index.html", "package.json", "package-lock.json", "vite.config.js", "tailwind.config.js", "postcss.config.js"];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const st = fs.statSync(dir);
  if (st.isFile()) return [dir];
  return fs.readdirSync(dir).sort().flatMap((n) => walk(path.join(dir, n)));
}

/** بصمة مجموعة ملفات: مساراتها النسبية ومحتواها، بترتيب ثابت. */
function digest(base, files) {
  const h = crypto.createHash("sha256");
  for (const f of files.sort()) {
    h.update(path.relative(base, f).split(path.sep).join("/"));
    h.update("\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

export function sourceHash() {
  return digest(SRC, SOURCE_ENTRIES.flatMap((e) => walk(path.join(SRC, e))));
}
export function outputHash() {
  return digest(OUT, walk(OUT).filter((f) => f !== FINGERPRINT_FILE));
}
export function recorded() {
  if (!fs.existsSync(FINGERPRINT_FILE)) return null;
  return Object.fromEntries(fs.readFileSync(FINGERPRINT_FILE, "utf8").trim().split("\n").map((l) => l.split(/\s+/)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) {
    fs.writeFileSync(FINGERPRINT_FILE, `source ${sourceHash()}\noutput ${outputHash()}\n`);
    console.log(`✅ ${path.relative(ROOT, FINGERPRINT_FILE)} كُتبت`);
  } else {
    const r = recorded() || {};
    console.log(JSON.stringify({ source: { now: sourceHash(), recorded: r.source }, output: { now: outputHash(), recorded: r.output } }, null, 2));
  }
}
