/**
 * Polyline trimming along a stored route geometry.
 * Mirrors the mobile app's trip-utils helpers so journey-estimate
 * trims origin→destination the same way JourneyMap does.
 */

export type LatLng = { lat: number; lng: number };

export function haversineM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export type ClosestPointOnPolyline = {
  point: [number, number];
  index: number;
  t: number;
};

export function closestPointOnPolyline(
  coords: [number, number][],
  user: LatLng,
): ClosestPointOnPolyline | null {
  if (coords.length === 0) return null;
  if (coords.length === 1) {
    return { point: coords[0]!, index: 0, t: 0 };
  }

  const ux = user.lng;
  const uy = user.lat;
  let bestDistSq = Infinity;
  let best: ClosestPointOnPolyline = {
    point: coords[0]!,
    index: 0,
    t: 0,
  };

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const lenSq = abx * abx + aby * aby;
    let t = 0;
    if (lenSq > 0) {
      t = ((ux - a[0]) * abx + (uy - a[1]) * aby) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }
    const px = a[0] + abx * t;
    const py = a[1] + aby * t;
    const dx = ux - px;
    const dy = uy - py;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = { point: [px, py], index: i, t };
    }
  }

  return best;
}

function dedupeCoords(coords: [number, number][]): [number, number][] {
  if (coords.length === 0) return [];
  const out: [number, number][] = [coords[0]!];
  for (let i = 1; i < coords.length; i++) {
    const prev = out[out.length - 1]!;
    const cur = coords[i]!;
    const dx = cur[0] - prev[0];
    const dy = cur[1] - prev[1];
    if (dx * dx + dy * dy > 1e-18) out.push(cur);
  }
  return out;
}

function polylineSliceBetween(
  coords: [number, number][],
  a: ClosestPointOnPolyline,
  b: ClosestPointOnPolyline,
): [number, number][] {
  const forward = b.index + b.t >= a.index + a.t;
  const lo = forward ? a : b;
  const hi = forward ? b : a;
  const middle = coords.slice(lo.index + 1, hi.index + 1) as [number, number][];
  const path: [number, number][] = [lo.point, ...middle, hi.point];
  return dedupeCoords(forward ? path : path.reverse());
}

const DEST_OFF_ROUTE_M = 600;

function destSnapUsable(dest: LatLng, destPt: ClosestPointOnPolyline): boolean {
  const [lng, lat] = destPt.point;
  return haversineM(dest, { lat, lng }) <= DEST_OFF_ROUTE_M;
}

export function remainingPolyline(
  coords: [number, number][],
  user: LatLng,
): [number, number][] {
  if (coords.length < 2) return coords.slice() as [number, number][];

  const closest = closestPointOnPolyline(coords, user);
  if (!closest) return coords.slice() as [number, number][];

  const tail = coords.slice(closest.index + 1) as [number, number][];
  const remaining: [number, number][] = [closest.point, ...tail];

  if (remaining.length >= 3 && closest.t > 0.999) {
    remaining.shift();
  }

  return remaining.length >= 2 ? remaining : [closest.point, coords[coords.length - 1]!];
}

export function remainingPolylineToDest(
  coords: [number, number][],
  user: LatLng,
  dest: LatLng,
): [number, number][] {
  if (coords.length < 2) return coords.slice() as [number, number][];

  const userPt = closestPointOnPolyline(coords, user);
  const destPt = closestPointOnPolyline(coords, dest);
  if (!userPt || !destPt) return remainingPolyline(coords, user);
  if (!destSnapUsable(dest, destPt)) return remainingPolyline(coords, user);

  const path = polylineSliceBetween(coords, userPt, destPt);
  if (path.length >= 2) return path;

  const lo = Math.min(userPt.index, destPt.index);
  const hi = Math.max(userPt.index, destPt.index);
  if (hi > lo) {
    const recovered = coords.slice(lo, hi + 1) as [number, number][];
    if (recovered.length >= 2) return recovered;
  }

  return remainingPolyline(coords, user);
}

/** Cumulative geodesic length along a LineString (metres). */
export function polylineLengthM(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    total += haversineM({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] });
  }
  return total;
}

/** Downsample to at most `maxPoints` vertices for TomTom supportingPoints. */
export function samplePolylineVertices(
  coords: [number, number][],
  maxPoints: number,
): [number, number][] {
  if (coords.length <= maxPoints) return coords;
  const out: [number, number][] = [];
  const step = (coords.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(coords.length - 1, Math.round(i * step));
    out.push(coords[idx]!);
  }
  return dedupeCoords(out);
}
