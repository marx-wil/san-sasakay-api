/**
 * Custom migration runner.
 *
 * Why not drizzle-kit's built-in migrator?
 *   - PostGIS geography columns and Timescale hypertable conversion live
 *     outside drizzle-kit's modeling surface.
 *   - We want hand-written SQL to be the source of truth for *database* shape;
 *     the drizzle schema (src/db/schema.ts) is the source of truth for
 *     *application* queries.
 *
 * Migrations run in lexicographic order from src/db/migrations/*.sql.
 * Applied filenames are recorded in the `_migrations` table.
 *
 * Usage:
 *   npm run db:migrate
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../config.js";
import { logger } from "../lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");
const EXTENSIONS_FILE = join(__dirname, "extensions.sql");

// Arbitrary project-specific 32-bit key for pg_advisory_lock. Serializes
// concurrent migrate() calls (e.g. api + worker booting against an empty DB).
const MIGRATION_LOCK_KEY = 5_731_993;

async function ensureExtensions(client: pg.PoolClient): Promise<void> {
  const sql = await readFile(EXTENSIONS_FILE, "utf8");
  await client.query(sql);
}

async function ensureLedger(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename     TEXT PRIMARY KEY,
      checksum     TEXT NOT NULL,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function appliedSet(client: pg.PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query<{ filename: string; checksum: string }>(
    "SELECT filename, checksum FROM _migrations ORDER BY filename ASC",
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function migrate(): Promise<void> {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  const client = await pool.connect();

  try {
    // Block until we own the lock; releases automatically if the connection
    // dies. Other migrators wait here, then see all migrations already
    // applied and exit cleanly.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    try {
      logger.info("Asserting Postgres extensions");
      await ensureExtensions(client);

      logger.info("Asserting _migrations ledger");
      await ensureLedger(client);

      const applied = await appliedSet(client);
      const files = await listMigrationFiles();

      let pending = 0;
      for (const file of files) {
        const path = join(MIGRATIONS_DIR, file);
        const content = await readFile(path, "utf8");
        const sum = checksum(content);
        const prior = applied.get(file);

        if (prior === undefined) {
          logger.info({ file }, "Applying migration");
          await client.query("BEGIN");
          try {
            await client.query(content);
            await client.query("INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)", [
              file,
              sum,
            ]);
            await client.query("COMMIT");
            pending++;
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          }
        } else if (prior !== sum) {
          throw new Error(
            `Checksum mismatch for ${file}. Migrations are immutable once applied. Create a new migration to alter the schema.`,
          );
        } else {
          logger.debug({ file }, "Migration already applied");
        }
      }

      if (pending === 0) {
        logger.info("Database is up to date");
      } else {
        logger.info({ applied: pending }, "Migrations applied");
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// Run when invoked directly (`tsx src/db/migrate.ts` or `node dist/db/migrate.js`).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  migrate().catch((err) => {
    logger.error({ err }, "Migration failed");
    process.exit(1);
  });
}
