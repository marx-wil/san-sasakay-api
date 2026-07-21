import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { makeRequireAuth } from "../auth/jwt.js";
import { db } from "../db/client.js";
import {
  CROWD_LEVEL,
  PASSENGER_LEVEL,
  TRIP_ISSUE,
  TRIP_SPEED,
  identityProofs,
  users,
} from "../db/schema.js";
import { BadRequest, Forbidden } from "../lib/errors.js";

const SubmitBody = z
  .object({
    clientUuid: z.string().uuid(),
    routeId: z.string().uuid(),
    tripIssue: z.enum(TRIP_ISSUE),
    othersText: z.string().trim().max(500).optional(),
    tripSpeed: z.enum(TRIP_SPEED),
    passengerLevel: z.enum(PASSENGER_LEVEL),
    location: z.object({
      lng: z.number().min(115).max(127),
      lat: z.number().min(4).max(22),
    }),
  })
  .superRefine((body, ctx) => {
    if (body.tripIssue === "others" && (!body.othersText || body.othersText.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "othersText is required when tripIssue is others",
        path: ["othersText"],
      });
    }
  });

const SubmitResponse = z.object({
  id: z.string().uuid(),
  pointsAwarded: z.number().int(),
  duplicate: z.boolean(),
});

const MeItem = z.object({
  id: z.string().uuid(),
  routeId: z.string().uuid(),
  tripIssue: z.enum(TRIP_ISSUE),
  othersText: z.string().nullable(),
  tripSpeed: z.enum(TRIP_SPEED),
  passengerLevel: z.enum(PASSENGER_LEVEL),
  createdAt: z.string(),
});

function passengerToCrowd(
  level: (typeof PASSENGER_LEVEL)[number],
): (typeof CROWD_LEVEL)[number] {
  if (level === "kaunti") return "maluwag";
  if (level === "sakto") return "katamtaman";
  return "siksikan";
}

/** Deterministic UUID v4-shaped id for idempotent incident report side-effects. */
function derivedClientUuid(base: string, suffix: string): string {
  const hash = createHash("sha256").update(`${base}:${suffix}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export const tripFeedbackRoutes: FastifyPluginAsyncZod = async (app) => {
  const requireAuth = makeRequireAuth();

  app.post(
    "/",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["trip-feedback"],
        body: SubmitBody,
        response: { 201: SubmitResponse, 200: SubmitResponse },
      },
      config: {
        rateLimit: { max: 20, timeWindow: "1 hour" },
      },
    },
    async (req, reply) => {
      const userId = req.currentUser?.id;
      if (!userId) throw BadRequest("NO_USER", "Missing user");

      const [phoneProof] = await db
        .select({ userId: identityProofs.userId })
        .from(identityProofs)
        .where(and(eq(identityProofs.userId, userId), eq(identityProofs.provider, "phone")))
        .limit(1);
      if (!phoneProof) {
        throw Forbidden("PHONE_REQUIRED", "Magdagdag muna ng numero mo bago mag-report.");
      }

      const body = req.body;

      const [u] = await db
        .select({ score: users.credibilityScore })
        .from(users)
        .where(sql`${users.id} = ${userId}`)
        .limit(1);
      const weight = u?.score ?? 1.0;

      const inserted = await db.execute<{ id: string }>(sql`
        INSERT INTO trip_feedback (
          client_uuid, user_id, route_id, trip_issue, others_text,
          trip_speed, passenger_level, location, weight
        ) VALUES (
          ${body.clientUuid}::uuid,
          ${userId}::uuid,
          ${body.routeId}::uuid,
          ${body.tripIssue},
          ${body.othersText ?? null},
          ${body.tripSpeed},
          ${body.passengerLevel},
          ${`SRID=4326;POINT(${body.location.lng} ${body.location.lat})`}::geography,
          ${weight}
        )
        ON CONFLICT (user_id, client_uuid) DO NOTHING
        RETURNING id
      `);

      const row = inserted.rows[0];
      const duplicate = !row;

      if (duplicate) {
        const prior = await db.execute<{ id: string }>(sql`
          SELECT id FROM trip_feedback
          WHERE user_id = ${userId}::uuid AND client_uuid = ${body.clientUuid}::uuid
          LIMIT 1
        `);
        const priorId = prior.rows[0]?.id;
        if (!priorId) throw BadRequest("FEEDBACK_RACE", "Could not resolve feedback");
        reply.code(200);
        return { id: priorId, pointsAwarded: 0, duplicate: true };
      }

      if (body.tripIssue !== "others") {
        const reportClientUuid = derivedClientUuid(body.clientUuid, "incident");
        await db.execute(sql`
          INSERT INTO reports (
            client_uuid, user_id, route_id, status, crowd_level, location, weight
          ) VALUES (
            ${reportClientUuid}::uuid,
            ${userId}::uuid,
            ${body.routeId}::uuid,
            'hindi_tumatakbo',
            ${passengerToCrowd(body.passengerLevel)},
            ${`SRID=4326;POINT(${body.location.lng} ${body.location.lat})`}::geography,
            ${weight}
          )
          ON CONFLICT (user_id, client_uuid) DO NOTHING
        `);
      }

      reply.code(201);
      return { id: row.id, pointsAwarded: 25, duplicate: false };
    },
  );

  app.get(
    "/me",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["trip-feedback"],
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: {
          200: z.object({ items: z.array(MeItem) }),
        },
      },
    },
    async (req) => {
      const userId = req.currentUser?.id;
      const { limit } = req.query;

      const result = await db.execute<{
        id: string;
        route_id: string;
        trip_issue: (typeof TRIP_ISSUE)[number];
        others_text: string | null;
        trip_speed: (typeof TRIP_SPEED)[number];
        passenger_level: (typeof PASSENGER_LEVEL)[number];
        created_at: string;
      }>(sql`
        SELECT id, route_id, trip_issue, others_text, trip_speed, passenger_level, created_at
        FROM trip_feedback
        WHERE user_id = ${userId}::uuid
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);

      return {
        items: result.rows.map((r) => ({
          id: r.id,
          routeId: r.route_id,
          tripIssue: r.trip_issue,
          othersText: r.others_text,
          tripSpeed: r.trip_speed,
          passengerLevel: r.passenger_level,
          createdAt: new Date(r.created_at).toISOString(),
        })),
      };
    },
  );
};
