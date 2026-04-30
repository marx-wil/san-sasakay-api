import { pool } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { logger } from "../lib/logger.js";
import { startAggregator } from "./aggregator.js";

async function main() {
  logger.info("worker starting");

  // Wait for migrations to be applied before the first tick. This serializes
  // safely against the api container via a Postgres advisory lock — whichever
  // process gets the lock first applies the schema; the other sees it's done
  // and continues. Ensures the worker never queries tables that don't yet
  // exist on a fresh DB boot.
  await migrate();

  const aggregator = startAggregator();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutting down");
    aggregator.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Block forever — process exits via signal handlers.
  await new Promise(() => {});
}

main().catch((err) => {
  logger.error({ err }, "worker failed to start");
  process.exit(1);
});
