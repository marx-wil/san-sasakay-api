/**
 * Dev seed for `transit_routes`. Reads the cached OpenStreetMap export
 * at `data/osm-routes/metro-manila.geojson` (produced by
 * `npm run osm:fetch`) and upserts each LTFRB-PUJ / UV Express route.
 *
 * Idempotent: ON CONFLICT (code) DO UPDATE refreshes name + type +
 * geometry on every run, so re-seeding after a fresh `osm:fetch`
 * propagates upstream OSM edits to the DB without manual SQL.
 *
 * Stops come from OSM relation members (role=stop/platform) embedded
 * in the GeoJSON by `osm:fetch`. Each re-seed replaces stops for that
 * route; locations are snapped to the route polyline.
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
import { classifyStoredRoute, codePrefixFor } from "../lib/osm-route-type.js";
import { db, pool } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GEOJSON_PATH = join(__dirname, "..", "..", "data", "osm-routes", "metro-manila.geojson");

type StoredRouteType = "jeepney" | "uv_express";

type RouteStopSeed = {
  seq: number;
  name: string;
  lng: number;
  lat: number;
};

type RouteFeature = {
  type: "Feature";
  properties: {
    ref: string | null;
    name: string;
    type: StoredRouteType | string;
    osmRelationId: number;
    network: string | null;
    operator: string | null;
    stops?: RouteStopSeed[];
  };
  geometry: { type: "LineString"; coordinates: [number, number][] };
};

type RouteFeatureCollection = {
  type: "FeatureCollection";
  features: RouteFeature[];
};

function codeFor(f: RouteFeature): string {
  const ref = f.properties.ref?.trim();
  // Prefix follows the original GeoJSON class so refining jeepney →
  // carousel / p2p_bus does not mint a new code and orphan FKs.
  const prefix = codePrefixFor(f.properties.type);
  if (ref) return `${prefix}-${ref}`;
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
    const prevLen = prev?.geometry.coordinates.length ?? 0;
    const nextLen = f.geometry.coordinates.length;
    if (!prev || nextLen > prevLen) {
      best.set(code, f);
      continue;
    }
    if (nextLen === prevLen) {
      const prevStops = prev.properties.stops?.length ?? 0;
      const nextStops = f.properties.stops?.length ?? 0;
      if (nextStops > prevStops) best.set(code, f);
    }
  }
  return [...best.values()];
}

async function replaceRouteStops(routeId: string, stops: RouteStopSeed[]): Promise<void> {
  await db.execute(sql`
    DELETE FROM stops WHERE route_id = ${routeId}::uuid
  `);
  for (const stop of stops) {
    await db.execute(sql`
      INSERT INTO stops (route_id, seq, name, location)
      SELECT
        ${routeId}::uuid,
        ${stop.seq},
        ${stop.name},
        ST_ClosestPoint(
          tr.geometry::geometry,
          ST_SetSRID(ST_MakePoint(${stop.lng}, ${stop.lat}), 4326)
        )::geography
      FROM transit_routes tr
      WHERE tr.id = ${routeId}::uuid
    `);
  }
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
  const geojsonRoutesWithStops = fc.features.filter(
    (f) => (f.properties.stops?.length ?? 0) > 0,
  ).length;

  logger.info(
    { total: fc.features.length, unique: features.length, geojsonRoutesWithStops },
    "Loaded OSM routes",
  );
  if (geojsonRoutesWithStops === 0) {
    logger.warn(
      "GeoJSON has no properties.stops — deploy a newer API image (osm:fetch with stop extraction) then re-run seed",
    );
  }

  let upserted = 0;
  let skipped = 0;
  let stopsInserted = 0;
  let routesWithStops = 0;

  for (const f of features) {
    if (f.geometry.coordinates.length < 2) {
      skipped++;
      continue;
    }
    const code = codeFor(f);
    const classified = classifyStoredRoute({
      type: f.properties.type,
      network: f.properties.network,
      name: f.properties.name,
    });
    const geomJson = JSON.stringify(f.geometry);
    try {
      await db.execute(sql`
        INSERT INTO transit_routes (code, name, type, geometry)
        VALUES (
          ${code},
          ${f.properties.name},
          ${classified},
          ST_SetSRID(ST_GeomFromGeoJSON(${geomJson}), 4326)::geography
        )
        ON CONFLICT (code) DO UPDATE
          SET name = EXCLUDED.name,
              type = EXCLUDED.type,
              geometry = EXCLUDED.geometry
      `);

      const idRes = await db.execute<{ id: string }>(sql`
        SELECT id FROM transit_routes WHERE code = ${code} LIMIT 1
      `);
      const routeId = idRes.rows[0]?.id;
      const stops = f.properties.stops ?? [];
      if (routeId) {
        await replaceRouteStops(routeId, stops);
        if (stops.length > 0) {
          routesWithStops++;
          stopsInserted += stops.length;
        }
      }

      upserted++;
    } catch (err) {
      skipped++;
      logger.warn({ code, err }, "skip route on insert error");
    }
  }

  logger.info({ upserted, skipped, routesWithStops, stopsInserted }, "seed complete");
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    logger.error({ err }, "seed failed");
    process.exit(1);
  });
