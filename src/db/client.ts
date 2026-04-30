import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config.js";
import { logger } from "../lib/logger.js";
import * as schema from "./schema.js";

/**
 * Single shared pg pool for the process. Sized for a 1GB t4g.micro:
 * Postgres `max_connections` defaults to 100; we leave headroom for psql,
 * the worker, and ad-hoc backup/restore connections.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: "sakay-api",
});

pool.on("error", (err) => {
  logger.error({ err }, "pg pool error");
});

export const db = drizzle(pool, {
  schema,
  // SQL query logging is independent of LOG_LEVEL — set LOG_SQL=true to see
  // every query (very noisy). Otherwise off, even at debug level.
  logger: env.LOG_SQL,
});

export type DB = typeof db;
export { schema };
