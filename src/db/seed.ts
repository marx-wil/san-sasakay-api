/**
 * Dev seed. Inserts a handful of Metro Manila jeepney/UV-Express routes for
 * local testing. Idempotent: ON CONFLICT DO NOTHING on `code`.
 *
 * Usage:
 *   npm run db:seed
 */

import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { db, pool } from "./client.js";

const ROUTES = [
  {
    code: "JEEP-001",
    name: "Cubao - Quiapo via España",
    type: "jeepney",
    line: "LINESTRING(121.0560 14.6206, 121.0500 14.6118, 121.0400 14.6020, 121.0260 14.5996)",
  },
  {
    code: "JEEP-002",
    name: "Monumento - Pier",
    type: "jeepney",
    line: "LINESTRING(120.9836 14.6541, 120.9785 14.6300, 120.9700 14.6010, 120.9650 14.5870)",
  },
  {
    code: "JEEP-014",
    name: "Crossing - Cogeo via Marcos Highway",
    type: "jeepney",
    line: "LINESTRING(121.0670 14.5780, 121.1010 14.6210, 121.1340 14.6480, 121.1700 14.6650)",
  },
  {
    code: "UV-007",
    name: "Fairview - Makati via C5",
    type: "uv_express",
    line: "LINESTRING(121.0700 14.7100, 121.0780 14.6450, 121.0510 14.5530)",
  },
  {
    code: "P2P-021",
    name: "Alabang - Ortigas",
    type: "p2p_bus",
    line: "LINESTRING(121.0420 14.4220, 121.0600 14.5870)",
  },
] as const;

async function seed() {
  logger.info("seeding transit_routes");
  for (const r of ROUTES) {
    await db.execute(sql`
      INSERT INTO transit_routes (code, name, type, geometry)
      VALUES (
        ${r.code},
        ${r.name},
        ${r.type},
        ${`SRID=4326;${r.line}`}::geography
      )
      ON CONFLICT (code) DO NOTHING
    `);
  }
  logger.info({ count: ROUTES.length }, "seed complete");
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    logger.error({ err }, "seed failed");
    process.exit(1);
  });
