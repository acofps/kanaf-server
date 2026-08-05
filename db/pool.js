import pg from "pg";

const { Pool } = pg;

// Real bug found via Render's live logs when connecting to the DB
// remotely (not on the same server): the DB server's pg_hba.conf
// requires SSL for external connections — the driver was never
// telling it to use SSL, so every remote connection was rejected
// with "SSL off". Detect "is this actually a remote host" from the
// connection string itself, so a same-server (localhost) deployment
// still works without SSL exactly as before, while `psql`-verified
// remote setups like this one enable it automatically — no extra env
// var needed for the common cases.
function isLocalHost(connectionString) {
  try {
    const { hostname } = new URL(connectionString);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false; // if DATABASE_URL isn't even parseable, let pg's own error surface naturally
  }
}

const connectionString = process.env.DATABASE_URL;

// A single shared connection pool. Import { pool } from this file
// anywhere you need to run a query — never create a second Pool.
export const pool = new Pool({
  connectionString,
  // rejectUnauthorized: false because shared/managed Postgres hosts
  // (like cPanel-provisioned PostgreSQL) typically present a
  // self-signed certificate, not one from a public CA — full chain
  // validation would reject every connection. This still encrypts
  // the connection; it just doesn't verify the server's identity
  // against a trusted CA. Fine for this deployment's threat model;
  // revisit if the host ever provides a real CA-signed certificate.
  ssl: connectionString && !isLocalHost(connectionString) ? { rejectUnauthorized: false } : false,
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
