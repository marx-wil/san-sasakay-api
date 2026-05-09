/**
 * Pull Metro Manila jeepney + UV Express route relations from the
 * OpenStreetMap Overpass API and write a GeoJSON FeatureCollection
 * of LineStrings to data/osm-routes/metro-manila.geojson.
 *
 * The committed GeoJSON is what `npm run db:seed` reads — Overpass is
 * not in the prod deploy path. Re-run this script weekly (or on
 * demand with --force) to refresh the cache.
 *
 * Why a hand-rolled relation→LineString assembler instead of
 * osmtogeojson? osmtogeojson preserves OSM topology faithfully, which
 * for a *route* relation (an ordered list of ways forming one path)
 * over-produces — every way emits its own Feature, and we'd have to
 * stitch anyway. The greedy stitcher here joins consecutive ways by
 * their nearer endpoint, flipping when needed; that handles both
 * forward-only routes and mixed forward/backward role tagging.
 *
 * Usage:
 *   npm run osm:fetch              # use cache if <7 days old
 *   npm run osm:fetch -- --force   # always hit Overpass
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "data", "osm-routes");
const OUTPUT_FILE = join(OUTPUT_DIR, "metro-manila.geojson");

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

// Metro Manila bounding box: south, west, north, east.
const METRO_MANILA_BBOX = [14.4, 120.85, 14.78, 121.2] as const;

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const OVERPASS_QUERY = `
[out:json][timeout:180];
(
  relation["type"="route"]["route"~"^(bus|minibus|share_taxi)$"]
          ["network"~"LTFRB"](${METRO_MANILA_BBOX.join(",")});
);
out body;
>;
out skel qt;
`.trim();

// ─── Overpass response shapes ───────────────────────────────────────
type OverpassNode = {
  type: "node";
  id: number;
  lat: number;
  lon: number;
};
type OverpassWay = {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
};
type OverpassRelationMember = {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
};
type OverpassRelation = {
  type: "relation";
  id: number;
  members: OverpassRelationMember[];
  tags?: Record<string, string>;
};
type OverpassElement = OverpassNode | OverpassWay | OverpassRelation;
type OverpassResponse = {
  elements: OverpassElement[];
};

// ─── Output GeoJSON shape ───────────────────────────────────────────
type Lng = number;
type Lat = number;
type Coord = [Lng, Lat];

type RouteFeatureProps = {
  ref: string | null;
  name: string;
  type: "jeepney" | "uv_express";
  osmRelationId: number;
  network: string | null;
  operator: string | null;
};

type RouteFeature = {
  type: "Feature";
  properties: RouteFeatureProps;
  geometry: { type: "LineString"; coordinates: Coord[] };
};

type RouteFeatureCollection = {
  type: "FeatureCollection";
  generatedAt: string;
  source: string;
  features: RouteFeature[];
};

// ─── Cache check ────────────────────────────────────────────────────
async function isCacheFresh(force: boolean): Promise<boolean> {
  if (force) return false;
  try {
    const s = await stat(OUTPUT_FILE);
    const ageMs = Date.now() - s.mtimeMs;
    return ageMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

// ─── Overpass fetch ─────────────────────────────────────────────────
async function fetchOverpass(): Promise<OverpassResponse> {
  const body = new URLSearchParams({ data: OVERPASS_QUERY }).toString();
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // Overpass enforces a UA — generic "node" gets 429'd.
      "user-agent": "sakay-api/0.1 (https://sansasakay.com)",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Overpass ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as OverpassResponse;
}

// ─── Relation → LineString assembly ─────────────────────────────────

/**
 * Greedy stitch: starting with the first way's coords, walk each
 * subsequent way and append its coords in whichever orientation
 * connects (or comes closest) to the running line's tail.
 *
 * Routes in OSM are mostly tagged with role="" or role="forward" for
 * geometry ways and role="stop"/"platform" for stops; we filter to
 * geometry ways before calling this. Some routes still mix forward
 * and backward ways — the greedy join keeps the result as a single
 * polyline rather than fanning out.
 */
function stitchWays(ways: Coord[][]): Coord[] {
  const out: Coord[] = [];
  for (const w of ways) {
    if (w.length === 0) continue;
    if (out.length === 0) {
      out.push(...w);
      continue;
    }
    const tail = out[out.length - 1] as Coord;
    const head = w[0] as Coord;
    const last = w[w.length - 1] as Coord;
    const dHead = sqDist(tail, head);
    const dLast = sqDist(tail, last);
    const oriented = dLast < dHead ? [...w].reverse() : w;
    // Skip the joining vertex if it duplicates the tail (within 1 m).
    const first = oriented[0] as Coord;
    const start = sqDist(tail, first) < 1e-9 ? 1 : 0;
    for (let i = start; i < oriented.length; i++) {
      out.push(oriented[i] as Coord);
    }
  }
  return out;
}

function sqDist(a: Coord, b: Coord): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/** Drop consecutive duplicates within 1e-7° (~1 cm). */
function dedupe(coords: Coord[]): Coord[] {
  const out: Coord[] = [];
  for (const c of coords) {
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev[0] - c[0]) > 1e-7 || Math.abs(prev[1] - c[1]) > 1e-7) {
      out.push(c);
    }
  }
  return out;
}

/** Roles whose ways are part of the route's drawn path. */
const GEOMETRY_ROLES = new Set(["", "forward", "backward"]);

function pickType(tags: Record<string, string>): RouteFeatureProps["type"] | null {
  const route = tags.route;
  if (route === "share_taxi") return "uv_express";
  if (route === "bus" || route === "minibus") return "jeepney";
  return null;
}

function nameFor(tags: Record<string, string>): string {
  const name = tags.name?.trim();
  if (name && name.length > 0) return name;
  const ref = tags.ref?.trim();
  const from = tags.from?.trim();
  const to = tags.to?.trim();
  if (from && to) return ref ? `${ref}: ${from} – ${to}` : `${from} – ${to}`;
  if (ref) return `Route ${ref}`;
  return "Unnamed route";
}

// ─── Main ──────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  if (await isCacheFresh(force)) {
    process.stdout.write(`Cache fresh at ${OUTPUT_FILE}; pass --force to refetch.\n`);
    return;
  }

  process.stdout.write("Fetching from Overpass (~30-90s)...\n");
  const data = await fetchOverpass();

  const nodeMap = new Map<number, Coord>();
  const wayMap = new Map<number, number[]>();
  const relations: OverpassRelation[] = [];

  for (const el of data.elements) {
    if (el.type === "node") {
      nodeMap.set(el.id, [el.lon, el.lat]);
    } else if (el.type === "way") {
      wayMap.set(el.id, el.nodes);
    } else if (el.type === "relation") {
      relations.push(el);
    }
  }

  process.stdout.write(
    `Overpass returned ${nodeMap.size} nodes, ${wayMap.size} ways, ${relations.length} relations.\n`,
  );

  const features: RouteFeature[] = [];
  let skippedNoType = 0;
  let skippedNoGeom = 0;

  for (const rel of relations) {
    const tags = rel.tags ?? {};
    const type = pickType(tags);
    if (!type) {
      skippedNoType++;
      continue;
    }

    // Geometry ways: prefer empty/forward role; fall back to including
    // backward if that's all the relation has.
    const primary = rel.members.filter(
      (m) => m.type === "way" && (m.role === "" || m.role === "forward"),
    );
    const fallback = rel.members.filter((m) => m.type === "way" && GEOMETRY_ROLES.has(m.role));
    const memberWays = primary.length > 0 ? primary : fallback;

    const wayCoords: Coord[][] = [];
    for (const m of memberWays) {
      const nodes = wayMap.get(m.ref);
      if (!nodes) continue;
      const coords: Coord[] = [];
      for (const nodeId of nodes) {
        const c = nodeMap.get(nodeId);
        if (c) coords.push(c);
      }
      if (coords.length >= 2) wayCoords.push(coords);
    }

    if (wayCoords.length === 0) {
      skippedNoGeom++;
      continue;
    }

    const stitched = dedupe(stitchWays(wayCoords));
    if (stitched.length < 2) {
      skippedNoGeom++;
      continue;
    }

    features.push({
      type: "Feature",
      properties: {
        ref: tags.ref?.trim() ?? null,
        name: nameFor(tags),
        type,
        osmRelationId: rel.id,
        network: tags.network?.trim() ?? null,
        operator: tags.operator?.trim() ?? null,
      },
      geometry: { type: "LineString", coordinates: stitched },
    });
  }

  const fc: RouteFeatureCollection = {
    type: "FeatureCollection",
    generatedAt: new Date().toISOString(),
    source: `Overpass API @ ${OVERPASS_ENDPOINT}; query bbox ${METRO_MANILA_BBOX.join(",")}`,
    features,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(fc, null, 2), "utf8");

  process.stdout.write(
    `Wrote ${features.length} routes to ${OUTPUT_FILE} ` +
      `(skipped ${skippedNoType} non-PUJ, ${skippedNoGeom} bad geometry).\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`fetch-osm-routes failed: ${(err as Error).message}\n`);
  process.exit(1);
});
