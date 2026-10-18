/**
 * TomTom Routing API — route reconstruction with traffic sections.
 *
 * Uses supportingPoints so the driven path follows our transit polyline
 * while TomTom supplies travel time and per-section traffic severity.
 */

import { logger } from "../lib/logger.js";

export type TrafficLevel = "light" | "moderate" | "heavy";

export type TrafficSegment = {
  coordinates: [number, number][];
  level: TrafficLevel;
};

export type TomTomRouteEstimate = {
  etaSeconds: number;
  trafficDelaySeconds: number;
  distanceM: number;
  segments: TrafficSegment[];
};

type TomTomPoint = { latitude: number; longitude: number };

type TomTomSection = {
  startPointIndex?: number;
  endPointIndex?: number;
  sectionType?: string;
  simpleCategory?: string;
  magnitudeOfDelay?: number;
};

type TomTomLeg = {
  points?: TomTomPoint[];
  summary?: { lengthInMeters?: number; travelTimeInSeconds?: number };
};

type TomTomRoute = {
  summary?: {
    lengthInMeters?: number;
    travelTimeInSeconds?: number;
    trafficDelayInSeconds?: number;
  };
  legs?: TomTomLeg[];
  sections?: TomTomSection[];
};

type TomTomResponse = {
  routes?: TomTomRoute[];
};

export type CalculateRouteInput = {
  apiKey: string;
  origin: { lat: number; lng: number };
  dest: { lat: number; lng: number };
  supportingPoints: [number, number][];
  signal?: AbortSignal;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
};

function levelFromCategory(category: string | undefined): TrafficLevel {
  switch (category) {
    case "JAM":
    case "CLOSED":
      return "heavy";
    case "ROAD_WORK":
      return "moderate";
    default:
      return "light";
  }
}

function pointsToLngLat(points: TomTomPoint[]): [number, number][] {
  return points.map((p) => [p.longitude, p.latitude]);
}

/**
 * Build colored segments from TomTom traffic sections over leg points.
 * Gaps between traffic sections are treated as light.
 */
export function segmentsFromTomTomRoute(route: TomTomRoute): TrafficSegment[] {
  const points = route.legs?.[0]?.points ?? [];
  if (points.length < 2) return [];

  const coords = pointsToLngLat(points);
  const sections = (route.sections ?? []).filter((s) => s.sectionType === "TRAFFIC");
  if (sections.length === 0) {
    return [{ coordinates: coords, level: "light" }];
  }

  const levelAt = new Array<TrafficLevel>(coords.length).fill("light");
  for (const sec of sections) {
    const start = sec.startPointIndex ?? 0;
    const end = sec.endPointIndex ?? coords.length - 1;
    const level = levelFromCategory(sec.simpleCategory);
    for (let i = start; i <= end && i < levelAt.length; i++) {
      levelAt[i] = mergeLevel(levelAt[i] ?? "light", level);
    }
  }

  const segments: TrafficSegment[] = [];
  let runStart = 0;
  for (let i = 1; i < levelAt.length; i++) {
    if (levelAt[i] !== levelAt[runStart]) {
      segments.push({
        coordinates: coords.slice(runStart, i + 1),
        level: levelAt[runStart] ?? "light",
      });
      runStart = i;
    }
  }
  segments.push({
    coordinates: coords.slice(runStart),
    level: levelAt[runStart] ?? "light",
  });

  return segments.filter((s) => s.coordinates.length >= 2);
}

function mergeLevel(a: TrafficLevel, b: TrafficLevel): TrafficLevel {
  const rank: Record<TrafficLevel, number> = { light: 0, moderate: 1, heavy: 2 };
  return rank[b] > rank[a] ? b : a;
}

/**
 * Project TomTom traffic levels onto our trimmed polyline by normalized
 * distance when TomTom's point geometry differs slightly from ours.
 */
export function projectSegmentsOntoPolyline(
  targetCoords: [number, number][],
  tomtomSegments: TrafficSegment[],
): TrafficSegment[] {
  if (targetCoords.length < 2) return [];
  if (tomtomSegments.length === 0) {
    return [{ coordinates: targetCoords, level: "light" }];
  }

  const sourceCoords: [number, number][] = [];
  const sourceLevels: TrafficLevel[] = [];
  for (const seg of tomtomSegments) {
    for (const c of seg.coordinates) {
      sourceCoords.push(c);
      sourceLevels.push(seg.level);
    }
  }
  if (sourceCoords.length < 2) {
    return [{ coordinates: targetCoords, level: sourceLevels[0] ?? "light" }];
  }

  const cumSource: number[] = [0];
  for (let i = 1; i < sourceCoords.length; i++) {
    const a = sourceCoords.at(i - 1);
    const b = sourceCoords.at(i);
    if (a === undefined || b === undefined) continue;
    cumSource.push((cumSource.at(i - 1) ?? 0) + haversineSeg(a, b));
  }
  const totalSource = cumSource.at(-1) ?? 1;

  const levelAtTarget: TrafficLevel[] = [];
  for (const t of targetCoords) {
    const frac = closestFractionOnPolyline(sourceCoords, cumSource, totalSource, t);
    const idx = Math.min(
      sourceLevels.length - 1,
      Math.max(0, Math.round(frac * (sourceLevels.length - 1))),
    );
    levelAtTarget.push(sourceLevels.at(idx) ?? "light");
  }

  const out: TrafficSegment[] = [];
  let runStart = 0;
  for (let i = 1; i < levelAtTarget.length; i++) {
    if (levelAtTarget[i] !== levelAtTarget[runStart]) {
      out.push({
        coordinates: targetCoords.slice(runStart, i + 1),
        level: levelAtTarget[runStart] ?? "light",
      });
      runStart = i;
    }
  }
  out.push({
    coordinates: targetCoords.slice(runStart),
    level: levelAtTarget[runStart] ?? "light",
  });
  return out.filter((s) => s.coordinates.length >= 2);
}

function haversineSeg(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function closestFractionOnPolyline(
  coords: [number, number][],
  cum: number[],
  total: number,
  point: [number, number],
): number {
  let bestDist = Number.POSITIVE_INFINITY;
  let bestFrac = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords.at(i - 1);
    const b = coords.at(i);
    if (a === undefined || b === undefined) continue;
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const lenSq = abx * abx + aby * aby;
    let t = 0;
    if (lenSq > 0) {
      t = ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }
    const px = a[0] + abx * t;
    const py = a[1] + aby * t;
    const dx = point[0] - px;
    const dy = point[1] - py;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      const cumEnd = cum.at(i) ?? 0;
      const cumStart = cum.at(i - 1) ?? 0;
      const segLen = cumEnd - cumStart;
      bestFrac = (cumStart + segLen * t) / total;
    }
  }
  return Math.max(0, Math.min(1, bestFrac));
}

export async function calculateRouteWithTraffic(
  input: CalculateRouteInput,
): Promise<TomTomRouteEstimate> {
  const fetchFn = input.fetchFn ?? fetch;
  const { origin, dest, supportingPoints, apiKey } = input;

  const locs = `${origin.lat},${origin.lng}:${dest.lat},${dest.lng}`;
  // Default routeRepresentation is polyline. "none" is only valid with
  // computeBestOrder=true and makes supportingPoints POSTs fail with BAD_INPUT.
  const qs = new URLSearchParams({
    key: apiKey,
    traffic: "true",
    sectionType: "traffic",
    travelMode: "car",
    routeRepresentation: "polyline",
  });
  const url = `https://api.tomtom.com/routing/1/calculateRoute/${locs}/json?${qs}`;

  const body = {
    supportingPoints: supportingPoints.map(([lng, lat]) => ({
      latitude: lat,
      longitude: lng,
    })),
  };

  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: input.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn({ status: res.status, body: text.slice(0, 200) }, "TomTom routing failed");
    throw new Error(`TomTom HTTP ${res.status}`);
  }

  const data = (await res.json()) as TomTomResponse;
  const route = data.routes?.[0];
  if (!route) throw new Error("TomTom returned no routes");

  const summary = route.summary;
  const tomtomSegments = segmentsFromTomTomRoute(route);

  return {
    etaSeconds: summary?.travelTimeInSeconds ?? 0,
    trafficDelaySeconds: summary?.trafficDelayInSeconds ?? 0,
    distanceM: summary?.lengthInMeters ?? 0,
    segments: tomtomSegments,
  };
}
