/* KANAF-ORD-0004 COR-04 — حالة موجبة للمشغّل: فحص واحد ناجح وخروج بصفر. يجب أن يعدّه run-tests ناجحاً. */
import { requireDedicatedDatabase } from "../guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
requireDedicatedDatabase(import.meta.url);
console.log("  ✔  فحص واحد");
process.exit(0);
