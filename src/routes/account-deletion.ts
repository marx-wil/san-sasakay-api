/**
 * Public account-deletion flow for Google Play's required web URL.
 *
 *   POST /account-deletion/request  — email in, always 202 (anti-enumeration)
 *   POST /account-deletion/status   — read-only token check (confirmation page)
 *   POST /account-deletion/cancel   — invalidate token without deleting
 *   POST /account-deletion/confirm  — one-time token from email link
 *
 * In-app deletion uses DELETE /me instead (authenticated).
 */

import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { generateMagicToken, hashIdentifier, hashToken } from "../auth/magic-link.js";
import { env, isDev } from "../config.js";
import { db } from "../db/client.js";
import { accountDeletionTokens, identityProofs } from "../db/schema.js";
import { sendAccountDeletionEmail } from "../lib/account-deletion-email.js";
import { deleteUserAccount } from "../lib/delete-user.js";
import { BadRequest } from "../lib/errors.js";

const RequestBody = z.object({
  email: z.string().email().max(254),
});

const TokenBody = z.object({
  token: z.string().min(20).max(64),
});

const INVALID_TOKEN_MSG = "This deletion link is invalid or has expired. Request a new one.";

async function findValidDeletionToken(raw: string) {
  const tokenHash = hashToken(raw);
  const now = new Date();

  const [row] = await db
    .select({
      tokenHash: accountDeletionTokens.tokenHash,
      userId: accountDeletionTokens.userId,
    })
    .from(accountDeletionTokens)
    .where(
      and(
        eq(accountDeletionTokens.tokenHash, tokenHash),
        isNull(accountDeletionTokens.usedAt),
        gt(accountDeletionTokens.expiresAt, now),
      ),
    )
    .limit(1);

  return row ?? null;
}

export const accountDeletionRoutes: FastifyPluginAsyncZod = async (app) => {
  // POST /account-deletion/request — always 202.
  // Mail is sent ONLY when an email identity exists (no signup-on-request).
  // In production the body is always `{ ok: true }` (anti-enumeration).
  // In development we also return `sent` so the landing can point at Mailpit
  // when a message was actually delivered.
  app.post(
    "/request",
    {
      schema: {
        tags: ["account-deletion"],
        body: RequestBody,
        response: {
          202: z.object({
            ok: z.literal(true),
            // Dev-only signal. Omitted in production responses.
            sent: z.boolean().optional(),
          }),
        },
      },
      config: {
        rateLimit: { max: 5, timeWindow: "15 minutes" },
      },
    },
    async (req, reply) => {
      const { email } = req.body;
      const emailHash = hashIdentifier(email);

      const [proof] = await db
        .select({ userId: identityProofs.userId })
        .from(identityProofs)
        .where(
          and(eq(identityProofs.provider, "email"), eq(identityProofs.identifierHash, emailHash)),
        )
        .limit(1);

      let sent = false;

      if (proof) {
        const token = generateMagicToken();
        const tokenHash = hashToken(token);
        const expiresAt = new Date(Date.now() + env.ACCOUNT_DELETION_TOKEN_TTL_SECONDS * 1000);

        await db.insert(accountDeletionTokens).values({
          tokenHash,
          userId: proof.userId,
          expiresAt,
        });

        // Confirmation CTA opens the landing (PUBLIC_WEB_URL), same as
        // magic links. In local, EMAIL_PROVIDER=mailpit so the message
        // lands in Mailpit's UI (http://localhost:8025) — never Resend.
        const link = `${env.PUBLIC_WEB_URL}/delete-account/confirm?token=${token}`;
        try {
          await sendAccountDeletionEmail(email, link);
          sent = true;
        } catch (err) {
          // Don't leak send failures in production. Log + still 202.
          req.log.error({ err }, "account-deletion email send failed");
        }
      }

      reply.code(202);
      if (isDev) {
        return { ok: true as const, sent };
      }
      return { ok: true as const };
    },
  );

  // POST /account-deletion/status — read-only token check for the confirmation page.
  app.post(
    "/status",
    {
      schema: {
        tags: ["account-deletion"],
        body: TokenBody,
        response: {
          200: z.object({ valid: z.literal(true) }),
        },
      },
      config: {
        rateLimit: { max: 20, timeWindow: "15 minutes" },
      },
    },
    async (req) => {
      const row = await findValidDeletionToken(req.body.token);
      if (!row) {
        throw BadRequest("INVALID_TOKEN", INVALID_TOKEN_MSG);
      }
      return { valid: true as const };
    },
  );

  // POST /account-deletion/cancel — invalidate token without deleting the account.
  app.post(
    "/cancel",
    {
      schema: {
        tags: ["account-deletion"],
        body: TokenBody,
        response: {
          200: z.object({ ok: z.literal(true) }),
        },
      },
      config: {
        rateLimit: { max: 10, timeWindow: "15 minutes" },
      },
    },
    async (req) => {
      const row = await findValidDeletionToken(req.body.token);
      if (!row) {
        throw BadRequest("INVALID_TOKEN", INVALID_TOKEN_MSG);
      }

      const now = new Date();
      await db
        .update(accountDeletionTokens)
        .set({ usedAt: now })
        .where(eq(accountDeletionTokens.tokenHash, row.tokenHash));

      return { ok: true as const };
    },
  );

  // POST /account-deletion/confirm — consume a one-time token and hard-delete.
  // Invalid / expired / already-used tokens all map to the same 400 so we
  // don't leak whether a prior request existed.
  app.post(
    "/confirm",
    {
      schema: {
        tags: ["account-deletion"],
        body: TokenBody,
        response: {
          200: z.object({ ok: z.literal(true) }),
        },
      },
      config: {
        rateLimit: { max: 10, timeWindow: "15 minutes" },
      },
    },
    async (req) => {
      const row = await findValidDeletionToken(req.body.token);
      if (!row) {
        throw BadRequest("INVALID_TOKEN", INVALID_TOKEN_MSG);
      }

      const now = new Date();

      // Mark used before delete so a concurrent confirm can't double-fire.
      // User delete cascades the token row anyway; marking used first is
      // belt-and-suspenders against races on a still-live user.
      await db
        .update(accountDeletionTokens)
        .set({ usedAt: now })
        .where(eq(accountDeletionTokens.tokenHash, row.tokenHash));

      await deleteUserAccount(row.userId);
      return { ok: true as const };
    },
  );
};
