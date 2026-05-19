/**
 * Geographic coordinate parsing.
 *
 * Lives here (not next to its only consumer in `routes/transit-routes.ts`)
 * because it's the kind of helper that a test should be able to import
 * without dragging the whole DB client + migration logic along for the
 * ride. Same reason we keep `errors.ts` as a sibling module.
 *
 * Wire format: `"lat,lng"` (decimal degrees). This matches how geocoder
 * URLs / reverse-search payloads conventionally pair the values, and it's
 * less error-prone for hand-built query strings than GeoJSON's
 * `[lng, lat]` order. We never accept the GeoJSON tuple on the wire so
 * nobody can confuse the two.
 */

/** Strict regex — the route handler's zod schema runs this same check. */
export const LATLNG_RE = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

export type LatLng = { lat: number; lng: number };

export function parseLatLng(value: string): LatLng {
  if (!LATLNG_RE.test(value)) throw new Error("invalid lat,lng");
  const [latStr, lngStr] = value.split(",");
  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("invalid lat,lng");
  }
  // WGS84 ranges. We're strict on lat but tolerant on lng wrap-around so
  // the antipodal-meridian case (uncommon, but harmless) doesn't 400 a
  // legitimate request — Postgres ST_MakePoint accepts the value either
  // way, the wrap-around just shows up as a faraway point.
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error("lat,lng out of range");
  }
  return { lat, lng };
}
