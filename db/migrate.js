import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool, withTransaction } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/* ---------------------------------------------------------
   A deliberately small migration runner.

   This deployment has no SSH or shell access, and cPanel ships
   phpMyAdmin (MySQL only) — there is no web SQL console for
   PostgreSQL. So schema changes had no path to production at all.
   The same constraint is why /api/setup/create-first-admin exists;
   this follows that precedent rather than inventing a second one.

   Deliberately NOT a general SQL executor: it only ever runs .sql
   files already committed to this repository, in filename order,
   exactly once each. It cannot be used to run arbitrary statements
   even by someone holding SETUP_TOKEN.
--------------------------------------------------------- */

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 001_, 002_, ... — zero-pad new files to keep this honest
}

/**
 * Applies any migration files not yet recorded in schema_migrations.
 * Each file runs inside its own transaction, and its filename is
 * recorded in that same transaction — so a file that fails partway
 * leaves no trace and can simply be re-run after a fix, rather than
 * leaving the schema in a state nothing describes.
 */
export async function runMigrations({ log = console.log } = {}) {
  await ensureMigrationsTable();

  const { rows } = await pool.query(`SELECT filename FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.filename));

  const files = listMigrationFiles();
  const results = [];

  for (const filename of files) {
    if (applied.has(filename)) {
      results.push({ filename, status: "skipped" });
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
    log(`Applying migration: ${filename}`);

    try {
      await withTransaction(async (client) => {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [filename]);
      });
      results.push({ filename, status: "applied" });
      log(`  applied: ${filename}`);
    } catch (err) {
      log(`  FAILED: ${filename} — ${err.message}`);
      results.push({ filename, status: "failed", error: err.message });
      // Stop at the first failure. Later migrations routinely assume
      // earlier ones landed, so continuing would turn one clear error
      // into a cascade of confusing ones.
      break;
    }
  }

  return results;
}

/**
 * Read-only view of migration state, for the status endpoint — so you
 * can check what's applied without triggering anything.
 */
export async function migrationStatus() {
  await ensureMigrationsTable();
  const { rows } = await pool.query(
    `SELECT filename, applied_at FROM schema_migrations ORDER BY filename`
  );
  const appliedMap = new Map(rows.map((r) => [r.filename, r.applied_at]));
  return listMigrationFiles().map((filename) => ({
    filename,
    applied: appliedMap.has(filename),
    appliedAt: appliedMap.get(filename) || null,
  }));
}

// Also runnable directly — `node db/migrate.js` — if shell access
// ever becomes available.
if (process.argv[1] && process.argv[1].endsWith("migrate.js")) {
  const results = await runMigrations();
  const failed = results.find((r) => r.status === "failed");
  await pool.end();
  process.exit(failed ? 1 : 0);
}
