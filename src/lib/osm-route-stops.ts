/**
 * Extract ordered stop points from an OSM route relation's members.
 * Shared by `scripts/fetch-osm-routes.ts` and unit tests.
 */

export type OsmRouteStop = {
  seq: number;
  name: string;
  lng: number;
  lat: number;
};

export type OsmNodeForStop = {
  lng: number;
  lat: number;
  tags?: Record<string, string>;
};

export type OsmRelationMember = {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
};

/** OSM route relation roles that denote a passenger stop. */
export function isStopMemberRole(role: string): boolean {
  const r = role.trim().toLowerCase();
  if (r === "stop" || r === "platform" || r === "halt") return true;
  if (r.endsWith(":stop") || r.endsWith(":platform")) return true;
  return false;
}

function nameForStop(tags: Record<string, string> | undefined, seq: number): string {
  const name =
    tags?.name?.trim() || tags?.["name:en"]?.trim() || tags?.ref?.trim();
  if (name) return name;
  return `Stop ${seq}`;
}

/**
 * Walk relation members in OSM order; emit one stop per stop/platform node.
 */
export function extractRelationStops(
  members: OsmRelationMember[],
  nodeById: ReadonlyMap<number, OsmNodeForStop>,
): OsmRouteStop[] {
  const stops: OsmRouteStop[] = [];
  let seq = 0;

  for (const m of members) {
    if (m.type !== "node" || !isStopMemberRole(m.role)) continue;
    const node = nodeById.get(m.ref);
    if (!node) continue;
    seq += 1;
    stops.push({
      seq,
      name: nameForStop(node.tags, seq),
      lng: node.lng,
      lat: node.lat,
    });
  }

  return stops;
}
