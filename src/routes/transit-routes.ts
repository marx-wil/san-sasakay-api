import { type SQL, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { ROUTE_STATUS, TRANSIT_TYPE } from "../db/schema.js";
import { NotFound } from "../lib/errors.js";
import { LATLNG_RE, parseLatLng } from "../lib/latlng.js";

const RouteSummary = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  type: z.enum(TRANSIT_TYPE),
  status: z.enum(ROUTE_STATUS),
  confidence: z.number(),
  reportCount: z.number().int(),
  lastReportAt: z.string().nullable(),
  // Present only when the request asked for `?include=geometry`. GeoJSON
  // LineString, simplified server-side to keep the list payload light
  // for map overlays. Use GET /routes/:id for full-fidelity geometry.
  geometry: z.unknown().nullable().optional(),
});

const RouteDetail = RouteSummary.extend({
  geometry: z.unknown().nullable(), // GeoJSON LineString
  stops: z.array(
    z.object({
      id: z.string().uuid(),
      seq: z.number().int(),
      name: z.string(),
      location: z.object({ lng: z.number(), lat: z.number() }),
    }),
  ),
});

// Douglas-Peucker tolerance in degrees (~10 m at the equator). Cuts vertex
// counts roughly 5–10× for typical jeepney route geometries — small enough
// that the simplified line still hugs the road at city zoom levels, big
// enough that a full Metro Manila bundle stays well under 1 MB.
const SIMPLIFY_TOLERANCE_DEG = 0.0001;

// Default walk radius for "this route serves my origin / destination".
// 400 m ≈ 5 minutes on foot. Anything smaller starts excluding routes
// that pass on the next block over (a normal interchange in Manila);
// anything bigger silently merges adjacent corridors into one result
// set, which is misleading for an "ano ang ruta" answer.
const DEFAULT_NEAR_RADIUS_M = 400;
const MIN_NEAR_RADIUS_M = 50;
const MAX_NEAR_RADIUS_M = 2000;

export const transitRouteRoutes: FastifyPluginAsyncZod = async (app) => {
  // GET /routes — list routes for the map and the search sheet.
  //
  // Query params (all optional):
  //   bbox=minLng,minLat,maxLng,maxLat
  //     Spatial filter — intersect the route polyline with the envelope.
  //     Used by the map for viewport-scoped fetches.
  //   type=<jeepney|uv_express|...>
  //     Narrow to a single transit class. Drives the filter pills.
  //   include=geometry
  //     Ship a simplified GeoJSON LineString on each row. Default is
  //     OFF for the polling path so status refreshes are cheap.
  //   q=<text>
  //     Free-text match on route `name` and `code` (case-insensitive
  //     substring). Cheap "ano ang ruta na…" search for users who type
  //     a route name directly.
  //   nearOrigin=lat,lng & nearDest=lat,lng
  //     The search-sheet O→D candidate path: returns routes whose
  //     polyline passes within `radius` metres of BOTH points. When
  //     only one of the two is supplied we filter by that single
  //     point — handy for "what runs through here?" exploration. Sort
  //     order shifts to "smallest combined distance to the two pins"
  //     so the most-relevant route ends up at the top of the list.
  //   radius=<metres>
  //     Walk-distance threshold for `nearOrigin`/`nearDest`. Default 400 m,
  //     clamped to [50, 2000].
  app.get(
    "/",
    {
      schema: {
        tags: ["routes"],
        querystring: z.object({
          bbox: z
            .string()
            .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
            .optional(),
          type: z.enum(TRANSIT_TYPE).optional(),
          include: z.enum(["geometry"]).optional(),
          q: z.string().min(1).max(120).optional(),
          nearOrigin: z.string().regex(LATLNG_RE).optional(),
          nearDest: z.string().regex(LATLNG_RE).optional(),
          radius: z.coerce.number().int().positive().optional(),
        }),
        response: { 200: z.object({ items: z.array(RouteSummary) }) },
      },
    },
    async (req) => {
      const { bbox, type, include, q, nearOrigin, nearDest, radius } = req.query;

      // Build the WHERE via drizzle's sql template so values are bound as
      // proper $1/$2 parameters. The previous implementation hand-rolled
      // $-placeholders into a sql.raw(...) string and never passed the
      // values, so Postgres saw `$1` with no binding and 500'd with
      // `42P02 there is no parameter $1`. Also fixes a latent SQL-injection
      // foothold if the bbox regex ever drifted.
      const conditions: SQL[] = [sql`tr.is_active = 1`];

      if (bbox) {
        const parts = bbox.split(",").map(Number);
        if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
          throw new Error("invalid bbox");
        }
        const [minLng, minLat, maxLng, maxLat] = parts as [number, number, number, number];
        conditions.push(
          sql`ST_Intersects(tr.geometry, ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)::geography)`,
        );
      }
      if (type) {
        conditions.push(sql`tr.type = ${type}`);
      }
      if (q) {
        // ILIKE on (name, code) is plenty for ~300 routes. If/when the
        // catalog grows enough to need it we'll add a tsvector + GIN.
        // The leading/trailing % wildcards inhibit any name-prefix index
        // anyway, so a tsvector switch is the right call later, not a
        // half-step like trigram pg_trgm.
        const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
        conditions.push(sql`(tr.name ILIKE ${like} OR tr.code ILIKE ${like})`);
      }

      // ─── Walk-radius filter for the search sheet ────────────────────
      // The geography column lets ST_DWithin take metres directly with
      // no projection dance. `radius` is clamped because both extremes
      // are bad UX — too tight and a 250 m walk excludes the route the
      // user was hunting; too loose and "near" loses meaning.
      const clampedRadius = radius
        ? Math.min(Math.max(radius, MIN_NEAR_RADIUS_M), MAX_NEAR_RADIUS_M)
        : DEFAULT_NEAR_RADIUS_M;
      let originPt: { lat: number; lng: number } | null = null;
      let destPt: { lat: number; lng: number } | null = null;
      if (nearOrigin) {
        try {
          originPt = parseLatLng(nearOrigin);
        } catch {
          throw new Error("invalid nearOrigin");
        }
        conditions.push(
          sql`ST_DWithin(tr.geometry, ST_MakePoint(${originPt.lng}, ${originPt.lat})::geography, ${clampedRadius})`,
        );
      }
      if (nearDest) {
        try {
          destPt = parseLatLng(nearDest);
        } catch {
          throw new Error("invalid nearDest");
        }
        conditions.push(
          sql`ST_DWithin(tr.geometry, ST_MakePoint(${destPt.lng}, ${destPt.lat})::geography, ${clampedRadius})`,
        );
      }

      const whereClause = sql.join(conditions, sql` AND `);
      const includeGeom = include === "geometry";
      // SIMPLIFY_TOLERANCE_DEG is a compile-time constant, so inlining it via
      // sql.raw is safe and keeps the value out of the bind list (PostGIS
      // requires it as a literal anyway).
      const geomFragment = includeGeom
        ? sql`ST_AsGeoJSON(ST_Simplify(tr.geometry::geometry, ${sql.raw(String(SIMPLIFY_TOLERANCE_DEG))})) AS geometry,`
        : sql``;

      // When we have OD pins, sort routes by how close they pass to
      // each of the two — a route that grazes both endpoints by 50 m
      // outranks one that swings 380 m wide of each. Falls through to
      // the catalogue's natural code order when no OD context exists.
      const orderClause =
        originPt && destPt
          ? sql`ORDER BY (ST_Distance(tr.geometry, ST_MakePoint(${originPt.lng}, ${originPt.lat})::geography)
                       + ST_Distance(tr.geometry, ST_MakePoint(${destPt.lng}, ${destPt.lat})::geography)) ASC`
          : originPt
            ? sql`ORDER BY ST_Distance(tr.geometry, ST_MakePoint(${originPt.lng}, ${originPt.lat})::geography) ASC`
            : destPt
              ? sql`ORDER BY ST_Distance(tr.geometry, ST_MakePoint(${destPt.lng}, ${destPt.lat})::geography) ASC`
              : sql`ORDER BY tr.code ASC`;

      const result = await db.execute<{
        id: string;
        code: string;
        name: string;
        type: (typeof TRANSIT_TYPE)[number];
        geometry?: string | null;
        status: (typeof ROUTE_STATUS)[number];
        confidence: number;
        report_count: number;
        last_report_at: string | null;
      }>(sql`
        SELECT tr.id, tr.code, tr.name, tr.type,
               ${geomFragment}
               COALESCE(rs.status, 'hindi_alam') AS status,
               COALESCE(rs.confidence, 0)        AS confidence,
               COALESCE(rs.report_count, 0)      AS report_count,
               rs.last_report_at
        FROM transit_routes tr
        LEFT JOIN route_status rs ON rs.route_id = tr.id
        WHERE ${whereClause}
        ${orderClause}
        LIMIT 500
      `);

      return {
        items: result.rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          type: r.type,
          status: r.status,
          confidence: r.confidence,
          reportCount: r.report_count,
          lastReportAt: r.last_report_at ? new Date(r.last_report_at).toISOString() : null,
          ...(includeGeom ? { geometry: r.geometry ? JSON.parse(r.geometry) : null } : {}),
        })),
      };
    },
  );

  // GET /routes/:id — full detail with stops + geometry as GeoJSON.
  app.get(
    "/:id",
    {
      schema: {
        tags: ["routes"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: RouteDetail },
      },
    },
    async (req) => {
      const { id } = req.params;

      const head = await db.execute<{
        id: string;
        code: string;
        name: string;
        type: (typeof TRANSIT_TYPE)[number];
        geometry: string | null;
        status: (typeof ROUTE_STATUS)[number];
        confidence: number;
        report_count: number;
        last_report_at: string | null;
      }>(sql`
        SELECT tr.id, tr.code, tr.name, tr.type,
               ST_AsGeoJSON(tr.geometry) AS geometry,
               COALESCE(rs.status, 'hindi_alam') AS status,
               COALESCE(rs.confidence, 0)        AS confidence,
               COALESCE(rs.report_count, 0)      AS report_count,
               rs.last_report_at
        FROM transit_routes tr
        LEFT JOIN route_status rs ON rs.route_id = tr.id
        WHERE tr.id = ${id}::uuid
        LIMIT 1
      `);

      const row = head.rows[0];
      if (!row) throw NotFound("ROUTE_NOT_FOUND", "Route does not exist");

      const stopsRes = await db.execute<{
        id: string;
        seq: number;
        name: string;
        lng: number;
        lat: number;
      }>(sql`
        SELECT id, seq, name,
               ST_X(location::geometry) AS lng,
               ST_Y(location::geometry) AS lat
        FROM stops
        WHERE route_id = ${id}::uuid
        ORDER BY seq ASC
      `);

      return {
        id: row.id,
        code: row.code,
        name: row.name,
        type: row.type,
        status: row.status,
        confidence: row.confidence,
        reportCount: row.report_count,
        lastReportAt: row.last_report_at ? new Date(row.last_report_at).toISOString() : null,
        geometry: row.geometry ? JSON.parse(row.geometry) : null,
        stops: stopsRes.rows.map((s) => ({
          id: s.id,
          seq: s.seq,
          name: s.name,
          location: { lng: s.lng, lat: s.lat },
        })),
      };
    },
  );
};
