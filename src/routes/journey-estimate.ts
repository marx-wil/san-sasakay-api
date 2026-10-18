import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "../config.js";
import { db } from "../db/client.js";
import type { ROUTE_STATUS } from "../db/schema.js";
import { AppError, NotFound } from "../lib/errors.js";
import { LATLNG_RE, parseLatLng } from "../lib/latlng.js";
import { LRUCache } from "../lib/lru-cache.js";
import { isLastReportFresh } from "../lib/report-window.js";
import {
  polylineLengthM,
  remainingPolylineToDest,
  samplePolylineVertices,
} from "../lib/route-polyline.js";
import {
  type TrafficLevel,
  calculateRouteWithTraffic,
  projectSegmentsOntoPolyline,
} from "../traffic/tomtom-routing.js";

const TrafficLevelSchema = z.enum(["light", "moderate", "heavy"]);

const JourneyEstimateResponse = z.object({
  etaSeconds: z.number().int().nonnegative(),
  trafficDelaySeconds: z.number().int().nonnegative().optional(),
  refreshedAt: z.string(),
  distanceRemainingM: z.number().nonnegative(),
  segments: z.array(
    z.object({
      coordinates: z.array(z.tuple([z.number(), z.number()])).min(2),
      level: TrafficLevelSchema,
    }),
  ),
  sources: z.array(z.enum(["tomtom", "route_status"])),
});

type CachedEstimate = z.infer<typeof JourneyEstimateResponse>;

const CACHE_TTL_MS = 90_000;
const CACHE_MAX = 500;
const estimateCache = new LRUCache<string, CachedEstimate>({
  max: CACHE_MAX,
  ttlMs: CACHE_TTL_MS,
});

const MAX_SUPPORTING_POINTS = 80;

function cacheKey(
  routeId: string,
  origin: { lat: number; lng: number },
  dest: { lat: number; lng: number },
): string {
  const round = (n: number) => n.toFixed(4);
  return `${routeId}|${round(origin.lat)},${round(origin.lng)}|${round(dest.lat)},${round(dest.lng)}`;
}

function etaMultiplierForStatus(status: (typeof ROUTE_STATUS)[number]): number {
  switch (status) {
    case "limitado":
      return 1.08;
    case "hindi_tumatakbo":
      return 1.15;
    default:
      return 1;
  }
}

function parseLineStringCoords(geometryJson: string | null): [number, number][] | null {
  if (!geometryJson) return null;
  try {
    const geo = JSON.parse(geometryJson) as {
      type?: string;
      coordinates?: [number, number][];
    };
    if (geo.type !== "LineString" || !Array.isArray(geo.coordinates)) return null;
    return geo.coordinates;
  } catch {
    return null;
  }
}

/**
 * Register GET /routes/:id/journey-estimate — must be mounted on the
 * `/routes` prefix before the generic `/:id` detail route.
 */
export const journeyEstimateRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/:id/journey-estimate",
    {
      schema: {
        tags: ["routes"],
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          origin: z.string().regex(LATLNG_RE),
          dest: z.string().regex(LATLNG_RE),
        }),
        response: { 200: JourneyEstimateResponse },
      },
    },
    async (req) => {
      const { id } = req.params;
      const origin = parseLatLng(req.query.origin);
      const dest = parseLatLng(req.query.dest);

      const key = cacheKey(id, origin, dest);
      const cached = estimateCache.get(key);
      if (cached) return cached;

      const head = await db.execute<{
        geometry: string | null;
        status: (typeof ROUTE_STATUS)[number];
        last_report_at: string | null;
      }>(sql`
        SELECT ST_AsGeoJSON(tr.geometry) AS geometry,
               COALESCE(rs.status, 'hindi_alam') AS status,
               rs.last_report_at
        FROM transit_routes tr
        LEFT JOIN route_status rs ON rs.route_id = tr.id
        WHERE tr.id = ${id}::uuid
        LIMIT 1
      `);

      const row = head.rows[0];
      if (!row) throw NotFound("ROUTE_NOT_FOUND", "Route does not exist");

      const fullCoords = parseLineStringCoords(row.geometry);
      if (!fullCoords || fullCoords.length < 2) {
        throw new AppError({
          statusCode: 503,
          code: "TRAFFIC_UNAVAILABLE",
          message: "Route has no geometry for traffic estimate",
        });
      }

      const trimmed = remainingPolylineToDest(fullCoords, origin, dest);
      if (trimmed.length < 2) {
        throw new AppError({
          statusCode: 400,
          code: "INVALID_JOURNEY",
          message: "Could not build a path along this route for the given points",
        });
      }

      const apiKey = env.TOMTOM_API_KEY;
      if (!apiKey || apiKey.length === 0) {
        throw new AppError({
          statusCode: 503,
          code: "TRAFFIC_UNAVAILABLE",
          message: "Traffic estimates are not configured",
        });
      }

      const supporting = samplePolylineVertices(trimmed, MAX_SUPPORTING_POINTS);
      let tomtomEta = 0;
      let trafficDelay = 0;
      let segments: { coordinates: [number, number][]; level: TrafficLevel }[];

      try {
        const result = await calculateRouteWithTraffic({
          apiKey,
          origin,
          dest,
          supportingPoints: supporting,
        });
        tomtomEta = result.etaSeconds;
        trafficDelay = result.trafficDelaySeconds;
        segments = projectSegmentsOntoPolyline(trimmed, result.segments);
      } catch {
        throw new AppError({
          statusCode: 503,
          code: "TRAFFIC_UNAVAILABLE",
          message: "Traffic data is temporarily unavailable",
        });
      }

      const nowMs = Date.now();
      const fresh = isLastReportFresh(row.last_report_at, nowMs);
      const status = fresh ? row.status : "hindi_alam";
      const multiplier = etaMultiplierForStatus(status);
      const adjustedEta = Math.max(0, Math.round(tomtomEta * multiplier));

      const distanceRemainingM = polylineLengthM(trimmed);

      const sources: ("tomtom" | "route_status")[] = ["tomtom"];
      if (multiplier > 1) sources.push("route_status");

      const payload: CachedEstimate = {
        etaSeconds: adjustedEta,
        trafficDelaySeconds: trafficDelay > 0 ? trafficDelay : undefined,
        refreshedAt: new Date().toISOString(),
        distanceRemainingM: Math.round(distanceRemainingM),
        segments,
        sources,
      };

      estimateCache.set(key, payload);
      return payload;
    },
  );
};
