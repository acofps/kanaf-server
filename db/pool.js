import pg from "pg";

const { Pool } = pg;

// Real-world back-and-forth found during actual deployment: the DB
// host's pg_hba.conf first rejected connections with "SSL off"
// (implying SSL was required), then after enabling SSL client-side,
// the server rejected the handshake with "the server does not
// support SSL connections" — meaning the pg_hba.conf rule demands
// something the Postgres server itself isn't configured to do.
// That's a server-side misconfiguration to fix on their end, but we
// don't want a new code deploy every time this setting might change
// on their side — so it's a direct, explicit env var instead of
// automatic host-based detection.
//
// Set DB_SSL=true on the host once SSL is actually enabled and its
// pg_hba.conf rule is satisfiable; leave it unset/false until then.
const connectionString = process.env.DATABASE_URL;
const sslMode = (process.env.DB_SSL || "false").toLowerCase();
const ssl = sslMode === "true" ? { rejectUnauthorized: false } : false;

// A single shared connection pool. Import { pool } from this file
// anywhere you need to run a query — never create a second Pool.
export const pool = new Pool({
  connectionString,
  ssl,
  // Reasonable defaults for a small VPS; raise max if you outgrow it.
  max: 10,
  idleTimeoutMillis: 30000,
  // بلا هذه المهلة، استنفاد المجمّع يعني انتظاراً بلا نهاية — أي
  // تجمّد صامت للخادم كله بدل خطأ يمكن رؤيته في السجل. أُضيفت في
  // المرحلة 4 بعد أن أظهرت المراجعة أن مسحاً واحداً للإشعارات قد
  // يحجز ثلاثة اتصالات في آن واحد.
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  // A background/idle client emitted an error (e.g. connection reset).
  // Log it — don't crash the whole process over one bad connection.
  console.error("Unexpected Postgres pool error:", err);
});

/**
 * Run a query with a client checked out from the pool. Prefer this
 * over pool.query() directly when you need a transaction — see
 * withTransaction() below for that case.
 */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run a set of queries inside a single transaction. `fn` receives a
 * client and must use it (not `pool`/`query`) for every statement,
 * or the statements won't actually be part of the transaction.
 *
 * Example:
 *   await withTransaction(async (client) => {
 *     await client.query("UPDATE ... WHERE id = $1", [id]);
 *     await client.query("INSERT INTO admin_access_log ...", [...]);
 *   });
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
