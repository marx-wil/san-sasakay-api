import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "../config.js";
import { db } from "../db/client.js";
import { identityProofs, magicLinkTokens, users } from "../db/schema.js";
import { BadRequest, Unauthorized } from "../lib/errors.js";
import { generateMagicToken, hashIdentifier, hashToken, sendMagicLink } from "./magic-link.js";

const RequestBody = z.object({
  email: z.string().email().max(254),
});

const VerifyQuery = z.object({
  token: z.string().min(20).max(64),
});

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  // POST /auth/request — accepts an email, sends a magic-link.
  // Always returns 202 to prevent account enumeration.
  app.post(
    "/request",
    {
      schema: {
        tags: ["auth"],
        body: RequestBody,
        response: {
          202: z.object({ ok: z.literal(true) }),
        },
      },
      config: {
        rateLimit: { max: 5, timeWindow: "15 minutes" },
      },
    },
    async (req, reply) => {
      const { email } = req.body;
      const emailHash = hashIdentifier(email);

      const token = generateMagicToken();
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + env.MAGIC_LINK_TTL_SECONDS * 1000);

      await db.insert(magicLinkTokens).values({
        tokenHash,
        emailHash,
        expiresAt,
      });

      const link = `${env.PUBLIC_API_URL}/auth/verify?token=${token}`;

      try {
        await sendMagicLink(email, link);
      } catch (err) {
        // Don't leak send failures to the client. Log + still return 202.
        req.log.error({ err }, "magic-link send failed");
      }

      reply.code(202);
      return { ok: true as const };
    },
  );

  // GET /auth/verify?token=... — consumes the token, signs in (or signs up).
  app.get(
    "/verify",
    {
      schema: {
        tags: ["auth"],
        querystring: VerifyQuery,
        response: {
          200: z.object({
            token: z.string(),
            user: z.object({
              id: z.string().uuid(),
              displayName: z.string().nullable(),
            }),
          }),
        },
      },
    },
    async (req) => {
      const { token } = req.query;
      const tokenHash = hashToken(token);
      const now = new Date();

      const [row] = await db
        .select()
        .from(magicLinkTokens)
        .where(
          and(
            eq(magicLinkTokens.tokenHash, tokenHash),
            isNull(magicLinkTokens.usedAt),
            gt(magicLinkTokens.expiresAt, now),
          ),
        )
        .limit(1);

      if (!row) {
        throw Unauthorized("INVALID_TOKEN", "Magic link is invalid or expired");
      }

      // Find or create user (signup-on-verify).
      const [existing] = await db
        .select({ userId: identityProofs.userId })
        .from(identityProofs)
        .where(
          and(
            eq(identityProofs.provider, "email"),
            eq(identityProofs.identifierHash, row.emailHash),
          ),
        )
        .limit(1);

      let userId: string;
      let displayName: string | null = null;

      if (existing) {
        userId = existing.userId;
        const [u] = await db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        displayName = u?.displayName ?? null;
      } else {
        const [created] = await db.insert(users).values({}).returning({
          id: users.id,
          displayName: users.displayName,
        });
        if (!created) throw BadRequest("USER_CREATE_FAILED", "Could not create user");
        userId = created.id;
        displayName = created.displayName ?? null;

        await db.insert(identityProofs).values({
          userId,
          provider: "email",
          identifierHash: row.emailHash,
          verifiedAt: now,
          isPrimary: 1,
        });
      }

      // Mark token used (single-use).
      await db
        .update(magicLinkTokens)
        .set({ usedAt: now, userId })
        .where(eq(magicLinkTokens.tokenHash, tokenHash));

      const accessToken = app.jwt.sign({ sub: userId });
      return { token: accessToken, user: { id: userId, displayName } };
    },
  );
};
