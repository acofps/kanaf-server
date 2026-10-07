/* KANAF-ORD-0004 COR-04 — حالة سلبية للمشغّل: يخرج بصفر دون أي فحص. يجب أن يعدّه run-tests فاشلاً. */
import { requireDedicatedDatabase } from "../guard.mjs"; // KANAF-ORD-0001 U09-2: يجب أن يبقى أول استيراد
requireDedicatedDatabase(import.meta.url);
console.log("لا فحوص هنا — توقفت قبل أول فحص");
process.exit(0);
