/* ============================================================
   كتابة مرة واحدة بمفتاح العميل — KANAF-ORD-0002 B-04

   onceByClientRef(userId, clientRef, resource, insert, fetchExisting)
     - بلا clientRef: يُنفّذ insert كما كان (توافق مع العميل القديم).
     - clientRef صالح: معاملة واحدة تقفل مفتاح الإيصال، فإن وُجد إيصال
       يُعاد المورد الموجود (fetchExisting) بلا إدراج؛ وإلا يُدرج المورد
       ويُسجل الإيصال. النتيجة {row, replayed}.
   القفل بـpg_advisory_xact_lock على (user_id, client_ref) يمنع سباق
   نداءين متزامنين بنفس المفتاح (إعادة محاولة فورية من المتصفح).
   ============================================================ */
import { withTransaction } from "../db/pool.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isClientRef = (v) => typeof v === "string" && UUID_RE.test(v);

export async function onceByClientRef(userId, clientRef, resource, insert, fetchExisting) {
  return withTransaction(async (client) => {
    if (clientRef === undefined || clientRef === null) return { row: await insert(client), replayed: false };
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [userId, clientRef]);
    const { rows: rc } = await client.query(
      `SELECT resource, resource_id FROM user_write_receipts WHERE user_id = $1 AND client_ref = $2`, [userId, clientRef]);
    if (rc[0]) {
      if (rc[0].resource !== resource) { const e = new Error("client_ref_reused"); e.status = 409; e.code = "client_ref_reused"; throw e; }
      return { row: await fetchExisting(client, rc[0].resource_id), replayed: true };
    }
    const row = await insert(client);
    await client.query(
      `INSERT INTO user_write_receipts (user_id, client_ref, resource, resource_id) VALUES ($1, $2, $3, $4)`,
      [userId, clientRef, resource, String(row.id)]);
    return { row, replayed: false };
  });
}
