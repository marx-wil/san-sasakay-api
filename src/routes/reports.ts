import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { makeRequireAuth } from "../auth/jwt.js";
import { db } from "../db/client.js";
import {
  CROWD_LEVEL,
  PASSENGER_LEVEL,
  REPORT_STATUS,
  ROUTE_STATUS,
  identityProofs,
  reports,
  users,
} from "../db/schema.js";
import { BadRequest, Forbidden } from "../lib/errors.js";
import {
  CONFIDENCE_SATURATION_REPORTS,
  MIN_REPORTS_FOR_BREAKDOWN,
  WINDOW_MINUTES,
  ageMinutesSql,
  decayFactorSql,
  previousWindowIntervalSql,
  windowIntervalSql,
} from "../lib/report-window.js";

// Anonymise user_id to a stable 3-digit passenger token — same pattern
// as the frontend mock data. The token is deterministic (same user always
// gets the same 3 digits for a given route session) but does not expose
// the real user id to other commuters.
function anonymizeUser(userId: string): string {
  const hex = userId.replace(/-/g, "").slice(-6);
  const n = Number.parseInt(hex, 16) % 1000;
  return n.toString().padStart(3, "0");
}

/**
 * Incidents surfaced publicly. `others` is deliberately excluded — its
 * free-text `others_text` is user-authored and must not reach an
 * unauthenticated aggregate response.
 */
const PUBLIC_INCIDENTS = ["aksidente", "baha", "sarado"] as const;

const SummaryResponse = z.object({
  routeId: z.string().uuid(),
  windowMinutes: z.number().int(),
  status: z.object({
    dominant: z.enum(ROUTE_STATUS),
    confidence: z.number(),
    /** Empty when the route has too few reports to publish a breakdown. */
    breakdown: z.array(
      z.object({
        status: z.enum(REPORT_STATUS),
        count: z.number().int(),
        share: z.number(),
      }),
    ),
  }),
  crowd: z.object({
    dominant: z.enum(PASSENGER_LEVEL).nullable(),
    breakdown: z.array(
      z.object({
        level: z.enum(PASSENGER_LEVEL),
        count: z.number().int(),
        share: z.number(),
      }),
    ),
  }),
  incidents: z.array(
    z.object({
      tripIssue: z.enum(PUBLIC_INCIDENTS),
      count: z.number().int(),
      minutesAgo: z.number().int(),
    }),
  ),
  freshness: z.object({
    reportCount: z.number().int(),
    previousWindowCount: z.number().int(),
    lastReportMinutesAgo: z.number().int().nullable(),
  }),
});

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
  // Scoped to the shared freshness window so the rows listed here are exactly
  // the rows that produced the aggregate shown above them in the sheet.
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
          AND r.created_at >= NOW() - ${windowIntervalSql()}
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

  // GET /reports/route/:routeId/summary — aggregated breakdown for one route.
  //
  // The route badge answers "what is it doing"; this answers "how sure are we,
  // and who disagrees". No auth: it returns counts only, never a user id, a
  // coordinate, or free text, so it carries no more information than the
  // status already published on GET /routes.
  //
  // Deliberately computed on read rather than denormalised into route_status:
  // only the one route whose sheet is open needs a breakdown, so paying for it
  // per request is cheaper than widening the table every route on the map
  // carries. Correctness comes from sharing lib/report-window.ts with the
  // aggregator, not from sharing storage.
  app.get(
    "/route/:routeId/summary",
    {
      schema: {
        tags: ["reports"],
        params: z.object({ routeId: z.string().uuid() }),
        response: { 200: SummaryResponse },
      },
    },
    async (req) => {
      const { routeId } = req.params;

      const [statusRes, freshnessRes, crowdRes, incidentRes] = await Promise.all([
        // Weighted status distribution — same CTE shape as the aggregator.
        db.execute<{
          status: (typeof REPORT_STATUS)[number];
          sw: number;
          cnt: string;
          total_w: number;
          total_cnt: string;
        }>(sql`
          WITH windowed AS (
            SELECT
              r.status,
              r.weight,
              ${ageMinutesSql(sql.raw("r.created_at"))} AS age_min
            FROM reports r
            WHERE r.route_id = ${routeId}::uuid
              AND r.created_at > NOW() - ${windowIntervalSql()}
          ),
          weighted AS (
            SELECT status, weight * ${decayFactorSql()} AS w FROM windowed
          ),
          per_status AS (
            SELECT status, SUM(w) AS sw, COUNT(*) AS cnt
            FROM weighted
            WHERE w > 0
            GROUP BY status
          )
          SELECT
            status,
            sw,
            cnt,
            SUM(sw) OVER () AS total_w,
            SUM(cnt) OVER () AS total_cnt
          FROM per_status
          ORDER BY sw DESC
        `),

        // Volume trend + recency. The previous window is the same length
        // immediately before the current one, so the two counts are comparable.
        db.execute<{
          last_report_at: string | null;
          previous_count: string;
        }>(sql`
          SELECT
            MAX(created_at) FILTER (
              WHERE created_at > NOW() - ${windowIntervalSql()}
            ) AS last_report_at,
            COUNT(*) FILTER (
              WHERE created_at <= NOW() - ${windowIntervalSql()}
                AND created_at > NOW() - ${previousWindowIntervalSql()}
            ) AS previous_count
          FROM reports
          WHERE route_id = ${routeId}::uuid
            AND created_at > NOW() - ${previousWindowIntervalSql()}
        `),

        // Crowd distribution comes from trip_feedback, not reports.crowd_level:
        // passenger_level is the four-level scale the app renders, and it is
        // what the aggregator already trusts for route_status.passenger_level.
        db.execute<{
          passenger_level: (typeof PASSENGER_LEVEL)[number];
          sw: number;
          cnt: string;
          total_w: number;
          total_cnt: string;
        }>(sql`
          WITH windowed AS (
            SELECT
              tf.passenger_level,
              tf.weight,
              ${ageMinutesSql(sql.raw("tf.created_at"))} AS age_min
            FROM trip_feedback tf
            WHERE tf.route_id = ${routeId}::uuid
              AND tf.created_at > NOW() - ${windowIntervalSql()}
          ),
          weighted AS (
            SELECT passenger_level, weight * ${decayFactorSql()} AS w FROM windowed
          ),
          per_level AS (
            SELECT passenger_level, SUM(w) AS sw, COUNT(*) AS cnt
            FROM weighted
            WHERE w > 0
            GROUP BY passenger_level
          )
          SELECT
            passenger_level,
            sw,
            cnt,
            SUM(sw) OVER () AS total_w,
            SUM(cnt) OVER () AS total_cnt
          FROM per_level
          ORDER BY sw DESC
        `),

        // Incidents are reported as raw counts, undecayed: a flood 40 minutes
        // ago is still a flood, and quietly shrinking it toward zero would
        // understate a hazard the commuter is about to walk into.
        db.execute<{
          trip_issue: (typeof PUBLIC_INCIDENTS)[number];
          cnt: string;
          last_at: string;
        }>(sql`
          SELECT trip_issue, COUNT(*) AS cnt, MAX(created_at) AS last_at
          FROM trip_feedback
          WHERE route_id = ${routeId}::uuid
            AND created_at > NOW() - ${windowIntervalSql()}
            AND trip_issue = ANY(${sql.raw(`ARRAY['${PUBLIC_INCIDENTS.join("','")}']`)})
          GROUP BY trip_issue
          ORDER BY COUNT(*) DESC
        `),
      ]);

      const nowMs = Date.now();
      const minutesSince = (iso: string) =>
        Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 60_000));

      // ─── Status ───────────────────────────────────────────────────────
      const statusRows = statusRes.rows;
      // Window functions repeat the totals on every row, so the first row
      // carries them; no rows means no reports in the window.
      const winner = statusRows[0];
      const totalCount = winner ? Number(winner.total_cnt) : 0;
      const totalWeight = winner ? Number(winner.total_w) : 0;

      // The dominant value and confidence always mirror what the aggregator
      // wrote to route_status — anything else would contradict the badge shown
      // above this panel on the same screen. Only the distribution is gated,
      // since a lone report as a 100% bar overstates agreement and exposes the
      // one reporter. Low confidence carries the uncertainty instead.
      const publishBreakdown = totalCount >= MIN_REPORTS_FOR_BREAKDOWN;
      const agreement = winner && totalWeight > 0 ? Number(winner.sw) / totalWeight : 0;
      const saturation = Math.min(1, totalCount / CONFIDENCE_SATURATION_REPORTS);

      // ─── Crowd ────────────────────────────────────────────────────────
      const crowdRows = crowdRes.rows;
      const crowdWinner = crowdRows[0];
      const crowdTotalCount = crowdWinner ? Number(crowdWinner.total_cnt) : 0;
      const crowdTotalWeight = crowdWinner ? Number(crowdWinner.total_w) : 0;
      const publishCrowd = crowdTotalCount >= MIN_REPORTS_FOR_BREAKDOWN;

      const freshness = freshnessRes.rows[0];
      const lastReportAt = freshness?.last_report_at ?? null;

      return {
        routeId,
        windowMinutes: WINDOW_MINUTES,
        status: {
          dominant: winner ? winner.status : ("hindi_alam" as const),
          confidence: winner ? Math.min(1, agreement * saturation) : 0,
          breakdown: publishBreakdown
            ? statusRows.map((r) => ({
                status: r.status,
                count: Number(r.cnt),
                share: totalWeight > 0 ? Number(r.sw) / totalWeight : 0,
              }))
            : [],
        },
        crowd: {
          dominant: crowdWinner ? crowdWinner.passenger_level : null,
          breakdown: publishCrowd
            ? crowdRows.map((r) => ({
                level: r.passenger_level,
                count: Number(r.cnt),
                share: crowdTotalWeight > 0 ? Number(r.sw) / crowdTotalWeight : 0,
              }))
            : [],
        },
        incidents: incidentRes.rows.map((r) => ({
          tripIssue: r.trip_issue,
          count: Number(r.cnt),
          minutesAgo: minutesSince(r.last_at),
        })),
        freshness: {
          reportCount: totalCount,
          previousWindowCount: Number(freshness?.previous_count ?? 0),
          lastReportMinutesAgo: lastReportAt ? minutesSince(lastReportAt) : null,
        },
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
