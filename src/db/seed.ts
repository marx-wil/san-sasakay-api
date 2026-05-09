/**
 * Dev seed for `transit_routes`. Reads the cached OpenStreetMap export
 * at `data/osm-routes/metro-manila.geojson` (produced by
 * `npm run osm:fetch`) and upserts each LTFRB-PUJ / UV Express route.
 *
 * Idempotent: ON CONFLICT (code) DO UPDATE refreshes name + type +
 * geometry on every run, so re-seeding after a fresh `osm:fetch`
 * propagates upstream OSM edits to the DB without manual SQL.
 *
 * Code naming:
 *   - Prefer `JEEP-<ref>` / `UV-<ref>` for routes that have an LTFRB
 *     route number tagged on the OSM relation (e.g. "T101", "300").
 *   - Fall back to `OSM-<relationId>` for routes without a ref.
 *
 * If multiple OSM relations share a ref (forward+backward, or rival
 * operators), the longest geometry wins — that's a reasonable proxy
 * for the canonical full-loop relation in this dataset.
 *
 * Usage:
 *   npm run osm:fetch     # writes the GeoJSON cache (~1 min)
 *   npm run db:seed       # this script (a few seconds against local pg)
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { db, pool } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GEOJSON_PATH = join(__dirname, "..", "..", "data", "osm-routes", "metro-manila.geojson");

type RouteType = "jeepney" | "uv_express";

type RouteFeature = {
  type: "Feature";
  properties: {
    ref: string | null;
    name: string;
    type: RouteType;
    osmRelationId: number;
    network: string | null;
    operator: string | null;
  };
  geometry: { type: "LineString"; coordinates: [number, number][] };
};

type RouteFeatureCollection = {
  type: "FeatureCollection";
  features: RouteFeature[];
};

const TYPE_PREFIX: Record<RouteType, string> = {
  jeepney: "JEEP",
  uv_express: "UV",
};

function codeFor(f: RouteFeature): string {
  const ref = f.properties.ref?.trim();
  if (ref) return `${TYPE_PREFIX[f.properties.type]}-${ref}`;
  return `OSM-${f.properties.osmRelationId}`;
}

/**
 * When two OSM relations collapse to the same code, keep the one with
 * the most coordinates. Best-effort canonical-route picker — see
 * file header.
 */
function dedupeByCode(features: RouteFeature[]): RouteFeature[] {
  const best = new Map<string, RouteFeature>();
  for (const f of features) {
    const code = codeFor(f);
    const prev = best.get(code);
    if (!prev || f.geometry.coordinates.length > prev.geometry.coordinates.length) {
      best.set(code, f);
    }
  }
  return [...best.values()];
}

async function seed(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(GEOJSON_PATH, "utf8");
  } catch (err) {
    logger.error(
      { path: GEOJSON_PATH, err },
      "GeoJSON cache missing. Run `npm run osm:fetch` first.",
    );
    throw err;
  }

  const fc = JSON.parse(raw) as RouteFeatureCollection;
  const features = dedupeByCode(fc.features);

  logger.info({ total: fc.features.length, unique: features.length }, "Loaded OSM routes");

  let upserted = 0;
  let skipped = 0;

  for (const f of features) {
    if (f.geometry.coordinates.length < 2) {
      skipped++;
      continue;
    }
    const code = codeFor(f);
    const geomJson = JSON.stringify(f.geometry);
    try {
      await db.execute(sql`
        INSERT INTO transit_routes (code, name, type, geometry)
        VALUES (
          ${code},
          ${f.properties.name},
          ${f.properties.type},
          ST_SetSRID(ST_GeomFromGeoJSON(${geomJson}), 4326)::geography
        )
        ON CONFLICT (code) DO UPDATE
          SET name = EXCLUDED.name,
              type = EXCLUDED.type,
              geometry = EXCLUDED.geometry
      `);
      upserted++;
    } catch (err) {
      skipped++;
      logger.warn({ code, err }, "skip route on insert error");
    }
  }

  logger.info({ upserted, skipped }, "seed complete");
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    logger.error({ err }, "seed failed");
    process.exit(1);
  });
