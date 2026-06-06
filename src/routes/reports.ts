import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { makeRequireAuth } from "../auth/jwt.js";
import { db } from "../db/client.js";
import { CROWD_LEVEL, REPORT_STATUS, identityProofs, reports, users } from "../db/schema.js";
import { BadRequest, Forbidden } from "../lib/errors.js";

// Anonymise user_id to a stable 3-digit passenger token — same pattern
// as the frontend mock data. The token is deterministic (same user always
// gets the same 3 digits for a given route session) but does not expose
// the real user id to other commuters.
function anonymizeUser(userId: string): string {
  const hex = userId.replace(/-/g, "").slice(-6);
  const n = Number.parseInt(hex, 16) % 1000;
  return n.toString().padStart(3, "0");
}

const ROUTE_REPORTS_WINDOW_MINUTES = 60;

const SubmitBody = z.object({
  clientUuid: z.string().uuid(),
  routeId: z.string().uuid(),
  status: z.enum(REPORT_STATUS),
  crowdLevel: z.enum(CROWD_LEVEL).optional(),
  location: z.object({
    lng: z.number().min(115).max(127), // PH bbox sanity check
    lat: z.number().min(4).max(22),
  }),
});

const SubmitResponse = z.object({
  id: z.string().uuid(),
  pointsAwarded: z.number().int(),
  duplicate: z.boolean(),
});

export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  const requireAuth = makeRequireAuth();

  // POST /reports — idempotent on (user_id, client_uuid).
  // Phase 1: writes raw row only; aggregator worker rolls up route_status.
  app.post(
    "/",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["reports"],
        body: SubmitBody,
        response: { 201: SubmitResponse, 200: SubmitResponse },
      },
      config: {
        rateLimit: { max: 20, timeWindow: "1 hour" }, // Per FRD section 8.
      },
    },
    async (req, reply) => {
      const userId = req.currentUser?.id;
      if (!userId) throw BadRequest("NO_USER", "Missing user");

      // Defense-in-depth phone gate. The mobile client already routes
      // phone-less users to /onboarding/phone before they can reach the
      // report sheet, but the API has to enforce its own contract — a
      // hand-crafted request with a valid JWT must not be able to farm
      // reports from an email-only account.
      const [phoneProof] = await db
        .select({ userId: identityProofs.userId })
        .from(identityProofs)
        .where(and(eq(identityProofs.userId, userId), eq(identityProofs.provider, "phone")))
        .limit(1);
      if (!phoneProof) {
        throw Forbidden("PHONE_REQUIRED", "Magdagdag muna ng numero mo bago mag-report.");
      }

      const body = req.body;

      // Snapshot user credibility for weighting at submission time.
      const [u] = await db
        .select({ score: users.credibilityScore })
        .from(users)
        .where(sql`${users.id} = ${userId}`)
        .limit(1);
      const weight = u?.score ?? 1.0;

      // Use raw INSERT ... ON CONFLICT DO NOTHING to handle offline-queue retries
      // idempotently on (user_id, client_uuid).
      const inserted = await db.execute<{ id: string }>(sql`
        INSERT INTO reports (
          client_uuid, user_id, route_id, status, crowd_level, location, weight
        ) VALUES (
          ${body.clientUuid}::uuid,
          ${userId}::uuid,
          ${body.routeId}::uuid,
          ${body.status},
          ${body.crowdLevel ?? null},
          ${`SRID=4326;POINT(${body.location.lng} ${body.location.lat})`}::geography,
          ${weight}
        )
        ON CONFLICT (user_id, client_uuid) DO NOTHING
        RETURNING id
      `);

      const row = inserted.rows[0];
      const duplicate = !row;

      if (duplicate) {
        // Look up the prior id to return.
        const prior = await db.execute<{ id: string }>(sql`
          SELECT id FROM reports
          WHERE user_id = ${userId}::uuid AND client_uuid = ${body.clientUuid}::uuid
          LIMIT 1
        `);
        const priorId = prior.rows[0]?.id;
        if (!priorId) throw BadRequest("REPORT_RACE", "Could not resolve report");
        reply.code(200);
        return { id: priorId, pointsAwarded: 0, duplicate: true };
      }

      // Points are credited by the worker (off the hot path) once the report
      // passes basic anti-spam checks. For MVP, return the *expected* +25.
      reply.code(201);
      return { id: row.id, pointsAwarded: 25, duplicate: false };
    },
  );

  // GET /reports/route/:routeId — recent public (anonymised) reports for one route.
  // No auth required — used by RouteDetailSheet's "MGA ULAT" section.
  // Returns only reports from the last ROUTE_REPORTS_WINDOW_MINUTES minutes so
  // stale data doesn't mislead commuters checking a real-time status panel.
  app.get(
    "/route/:routeId",
    {
      schema: {
        tags: ["reports"],
        params: z.object({ routeId: z.string().uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(20).default(10),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                status: z.enum(REPORT_STATUS),
                crowdLevel: z.enum(CROWD_LEVEL).nullable(),
                minutesAgo: z.number().int(),
                passengerId: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const { routeId } = req.params;
      const { limit } = req.query;

      const result = await db.execute<{
        id: string;
        user_id: string;
        status: (typeof REPORT_STATUS)[number];
        crowd_level: (typeof CROWD_LEVEL)[number] | null;
        created_at: string;
      }>(sql`
        SELECT r.id, r.user_id, r.status, r.crowd_level, r.created_at
        FROM reports r
        WHERE r.route_id = ${routeId}::uuid
          AND r.created_at >= NOW() - INTERVAL '${sql.raw(String(ROUTE_REPORTS_WINDOW_MINUTES))} minutes'
        ORDER BY r.created_at DESC
        LIMIT ${limit}
      `);

      const nowMs = Date.now();
      return {
        items: result.rows.map((r) => ({
          id: r.id,
          status: r.status,
          crowdLevel: r.crowd_level,
          minutesAgo: Math.round((nowMs - new Date(r.created_at).getTime()) / 60_000),
          passengerId: anonymizeUser(r.user_id),
        })),
      };
    },
  );

  // GET /reports/me — recent reports by current user. Used by profile screen.
  app.get(
    "/me",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["reports"],
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string().uuid(),
                routeId: z.string().uuid(),
                status: z.enum(REPORT_STATUS),
                crowdLevel: z.enum(CROWD_LEVEL).nullable(),
                createdAt: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const userId = req.currentUser?.id;
      const { limit } = req.query;
      const result = await db.execute<{
        id: string;
        route_id: string;
        status: (typeof REPORT_STATUS)[number];
        crowd_level: (typeof CROWD_LEVEL)[number] | null;
        created_at: string;
      }>(sql`
        SELECT id, route_id, status, crowd_level, created_at
        FROM reports
        WHERE user_id = ${userId}::uuid
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);
      return {
        items: result.rows.map((r) => ({
          id: r.id,
          routeId: r.route_id,
          status: r.status,
          crowdLevel: r.crowd_level,
          createdAt: new Date(r.created_at).toISOString(),
        })),
      };
    },
  );
};
