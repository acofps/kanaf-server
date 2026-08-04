import pg from "pg";

const { Pool } = pg;

// A single shared connection pool. Import { pool } from this file
// anywhere you need to run a query — never create a second Pool.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Reasonable defaults for a small VPS; raise max if you outgrow it.
  max: 10,
  idleTimeoutMillis: 30000,
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
