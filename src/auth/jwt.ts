import type { FastifyReply, FastifyRequest } from "fastify";
import { Unauthorized } from "../lib/errors.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; iat?: number; exp?: number; iss?: string };
    user: { id: string };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    currentUser?: { id: string };
  }
}

/**
 * Pre-handler: verifies a JWT from `Authorization: Bearer <token>` and
 * attaches `req.currentUser` for downstream handlers.
 *
 * Register on the Fastify instance before route plugins:
 *   app.decorate("requireAuth", makeRequireAuth(app));
 */
export function makeRequireAuth() {
  return async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
    try {
      const decoded = await req.jwtVerify<{ sub: string }>();
      req.currentUser = { id: decoded.sub };
    } catch {
      throw Unauthorized();
    }
  };
}
