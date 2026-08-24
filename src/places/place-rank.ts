/**
 * Turn raw Nominatim hits into commute-shaped place suggestions.
 *
 * Nominatim happily returns four OSM features named "One Ayala"
 * (mall, busway stop, street, building). We:
 *   1. Map OSM class/type → a small commute kind.
 *   2. Build a subtitle that does not repeat the title.
 *   3. Collapse true clones (same name, same kind, <80 m).
 *   4. Keep different kinds even when the name matches.
 *   5. Sort mall/POI → stop/station → building → street.
 */

export const PLACE_KINDS = ["mall", "bus_stop", "station", "street", "building", "place"] as const;

export type PlaceKind = (typeof PLACE_KINDS)[number];

export type RankablePlace = {
  id: string;
  name: string;
  displayName: string;
  lat: number;
  lng: number;
  osmClass?: string;
  osmType?: string;
};

export type RankedPlace = {
  id: string;
  name: string;
  displayName: string;
  lat: number;
  lng: number;
  kind: PlaceKind;
  subtitle: string;
};

const KIND_RANK: Record<PlaceKind, number> = {
  mall: 0,
  bus_stop: 1,
  station: 1,
  building: 2,
  place: 3,
  street: 4,
};

const CLONE_METERS = 80;

export function classifyPlaceKind(osmClass?: string, osmType?: string): PlaceKind {
  const cls = (osmClass ?? "").toLowerCase();
  const typ = (osmType ?? "").toLowerCase();

  if (
    cls === "shop" ||
    typ === "mall" ||
    typ === "marketplace" ||
    typ === "retail" ||
    typ === "supermarket" ||
    typ === "department_store"
  ) {
    return "mall";
  }

  if (
    typ === "bus_stop" ||
    typ === "bus_station" ||
    cls === "public_transport" ||
    typ === "stop_position" ||
    typ === "platform"
  ) {
    return "bus_stop";
  }

  if (cls === "railway" || typ === "station" || typ === "halt" || typ === "ferry_terminal") {
    return "station";
  }

  if (cls === "highway") return "street";
  if (cls === "building" || cls === "office") return "building";
  return "place";
}

export function placeSubtitle(name: string, displayName: string): string {
  let s = displayName.trim();
  const n = name.trim();
  if (n && s.toLowerCase().startsWith(n.toLowerCase())) {
    s = s.slice(n.length).replace(/^\s*,\s*/, "");
  }
  s = s.replace(/,?\s*(Philippines|Pilipinas)\s*$/i, "");
  s = s.replace(/,?\s*Metro Manila\s*$/i, "");
  s = s.replace(/,\s*$/, "").trim();
  return s;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sin =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(sin)));
}

export function rankPlaces(hits: RankablePlace[], limit: number): RankedPlace[] {
  const ranked: RankedPlace[] = hits.map((h) => ({
    id: h.id,
    name: h.name,
    displayName: h.displayName,
    lat: h.lat,
    lng: h.lng,
    kind: classifyPlaceKind(h.osmClass, h.osmType),
    subtitle: placeSubtitle(h.name, h.displayName),
  }));

  ranked.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);

  const kept: RankedPlace[] = [];
  for (const hit of ranked) {
    const key = normalizeName(hit.name);
    const clone = kept.find(
      (k) =>
        k.kind === hit.kind &&
        normalizeName(k.name) === key &&
        haversineMeters(k, hit) < CLONE_METERS,
    );
    if (clone) continue;
    kept.push(hit);
    if (kept.length >= limit) break;
  }
  return kept;
}
