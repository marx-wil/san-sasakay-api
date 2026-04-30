import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { pool } from "../db/client.js";

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  // Liveness — answers as long as the event loop is running.
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        response: {
          200: z.object({ ok: z.literal(true), service: z.string() }),
        },
      },
    },
    async () => ({ ok: true as const, service: "sakay-api" }),
  );

  // Readiness — actually pings the DB. Used by load balancer health checks.
  app.get(
    "/ready",
    {
      schema: {
        tags: ["health"],
        response: {
          200: z.object({ ok: z.literal(true), db: z.literal("ok") }),
          503: z.object({ ok: z.literal(false), db: z.string() }),
        },
      },
    },
    async (_req, reply) => {
      try {
        await pool.query("SELECT 1");
        return { ok: true as const, db: "ok" as const };
      } catch (err) {
        reply.code(503);
        return { ok: false as const, db: (err as Error).message };
      }
    },
  );
};
