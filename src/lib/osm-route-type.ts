/**
 * Classify an OSM route relation into a San Sasakay transit type.
 *
 * OSM in Metro Manila tags almost every PUV as `route=bus` (or
 * `minibus`). The useful signal is `network` (LTFRB PUJ / PUB /
 * Interregional Bus) plus the name (Carousel, UV Express).
 *
 * Shared by the Overpass fetch script and db:seed so a GeoJSON refresh
 * and a re-seed cannot drift.
 */

export const OSM_ROUTE_TYPES = [
  "jeepney",
  "uv_express",
  "p2p_bus",
  "carousel",
  "interregional_bus",
] as const;

export type OsmRouteType = (typeof OSM_ROUTE_TYPES)[number];

export type OsmRouteTags = {
  route?: string | null;
  network?: string | null;
  name?: string | null;
};

function norm(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[–—]/g, "-");
}

/**
 * Returns null when the relation isn't a PUV we ingest (ferry, train, …).
 */
export function pickType(tags: OsmRouteTags): OsmRouteType | null {
  const route = norm(tags.route);
  const network = norm(tags.network);
  const name = tags.name ?? "";

  const isShareTaxi = route === "share_taxi" || route === "share_taxi" || route === "uv_express";
  if (isShareTaxi || /\buv express\b/i.test(name)) return "uv_express";

  if (/carousel/i.test(name)) return "carousel";

  if (
    /interregional|inter-regional|inter-provincial/.test(network) ||
    /\bregion iii\b/.test(network)
  ) {
    return "interregional_bus";
  }

  if (/\bpub\b/.test(network) || /\bbus\b/i.test(name)) return "p2p_bus";

  if (/\bpuj\b/.test(network)) return "jeepney";

  if (route === "bus" || route === "minibus" || route === "minibus" || route === "jeepney") {
    return "jeepney";
  }

  return null;
}

/**
 * Seed / GeoJSON path: `properties.type` is the previous coarse class
 * (`jeepney` | `uv_express`), not the OSM `route=*` tag. Re-run pickType
 * against network + name with that coarse class as the route hint.
 */
export function classifyStoredRoute(p: {
  type: string;
  network: string | null;
  name: string;
}): OsmRouteType {
  return (
    pickType({
      route: p.type === "uv_express" ? "share_taxi" : "bus",
      network: p.network,
      name: p.name,
    }) ?? (p.type === "uv_express" ? "uv_express" : "jeepney")
  );
}

/** Keep existing `JEEP-*` / `UV-*` codes stable when the type is refined. */
export function codePrefixFor(type: string): "JEEP" | "UV" {
  return type === "uv_express" ? "UV" : "JEEP";
}
