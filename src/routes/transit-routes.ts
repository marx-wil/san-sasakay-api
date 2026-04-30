import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { ROUTE_STATUS, TRANSIT_TYPE } from "../db/schema.js";
import { NotFound } from "../lib/errors.js";

const RouteSummary = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  type: z.enum(TRANSIT_TYPE),
  status: z.enum(ROUTE_STATUS),
  confidence: z.number(),
  reportCount: z.number().int(),
  lastReportAt: z.string().nullable(),
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

export const transitRouteRoutes: FastifyPluginAsyncZod = async (app) => {
  // GET /routes?bbox=minLng,minLat,maxLng,maxLat — list routes intersecting a bbox.
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
        }),
        response: { 200: z.object({ items: z.array(RouteSummary) }) },
      },
    },
    async (req) => {
      const { bbox, type } = req.query;
      const filters: string[] = ["tr.is_active = 1"];
      const params: Array<string | number> = [];

      if (bbox) {
        const parts = bbox.split(",").map(Number);
        if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
          throw new Error("invalid bbox");
        }
        const [minLng, minLat, maxLng, maxLat] = parts as [number, number, number, number];
        params.push(minLng, minLat, maxLng, maxLat);
        filters.push(
          `ST_Intersects(tr.geometry, ST_MakeEnvelope($${params.length - 3}, $${
            params.length - 2
          }, $${params.length - 1}, $${params.length}, 4326)::geography)`,
        );
      }
      if (type) {
        params.push(type);
        filters.push(`tr.type = $${params.length}`);
      }

      const where = filters.join(" AND ");
      const result = await db.execute<{
        id: string;
        code: string;
        name: string;
        type: (typeof TRANSIT_TYPE)[number];
        status: (typeof ROUTE_STATUS)[number];
        confidence: number;
        report_count: number;
        last_report_at: string | null;
      }>(
        sql.raw(`
        SELECT tr.id, tr.code, tr.name, tr.type,
               COALESCE(rs.status, 'hindi_alam') AS status,
               COALESCE(rs.confidence, 0)        AS confidence,
               COALESCE(rs.report_count, 0)      AS report_count,
               rs.last_report_at
        FROM transit_routes tr
        LEFT JOIN route_status rs ON rs.route_id = tr.id
        WHERE ${where}
        ORDER BY tr.code ASC
        LIMIT 200
      `),
      );

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
