import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "../config.js";
import { db } from "../db/client.js";
import { identityProofs, magicLinkTokens, users } from "../db/schema.js";
import { BadRequest, Unauthorized } from "../lib/errors.js";
import { generateMagicToken, hashIdentifier, hashToken, sendMagicLink } from "./magic-link.js";

// #region agent log
// Debug instrumentation. Container reaches host loopback via host.docker.internal.
function dlog(payload: {
  location: string;
  message: string;
  data?: Record<string, unknown>;
  hypothesisId?: string;
}): void {
  try {
    fetch("http://host.docker.internal:7652/ingest/12fcec5a-657d-4abd-b83d-ebfbba60b53a", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "1b02c8",
      },
      body: JSON.stringify({
        sessionId: "1b02c8",
        location: payload.location,
        message: payload.message,
        data: payload.data ?? {},
        hypothesisId: payload.hypothesisId,
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  } catch {}
}
// #endregion

const RequestBody = z.object({
  email: z.string().email().max(254),
});

const VerifyQuery = z.object({
  token: z.string().min(20).max(64),
  // Default flow is a 302 redirect to PUBLIC_WEB_URL/auth/callback so the
  // email link "just works" when tapped on a phone. Programmatic callers
  // (mobile app, curl, tests) opt into JSON with ?format=json.
  format: z.enum(["json", "redirect"]).optional(),
});

const VerifyResponse = z.object({
  token: z.string(),
  user: z.object({
    id: z.string().uuid(),
    displayName: z.string().nullable(),
    hasPhone: z.boolean(),
    // Explicit "next step is phone" signal so the client doesn't have to
    // infer the post-auth route from `hasPhone`. Today equals `!hasPhone`;
    // when SMS-OTP ships, this will additionally require verifiedAt.
    phoneRequired: z.boolean(),
  }),
});

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  // POST /auth/request — accepts an email, sends a magic-link.
  // Always returns 202 to prevent account enumeration: the response shape
  // is identical whether the email exists, is malformed-but-zod-valid, or
  // the upstream mail provider failed.
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
      // #region agent log
      dlog({
        location: "auth/routes.ts:/auth/request",
        message: "handler entered",
        data: { ip: req.ip, ua: req.headers["user-agent"]?.slice(0, 80) },
        hypothesisId: "A,B,C",
      });
      // #endregion
      const { email } = req.body;
      const emailHash = hashIdentifier(email);

      const token = generateMagicToken();
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + env.MAGIC_LINK_TTL_SECONDS * 1000);

      try {
        await db.insert(magicLinkTokens).values({
          tokenHash,
          emailHash,
          expiresAt,
        });
        // #region agent log
        dlog({
          location: "auth/routes.ts:/auth/request",
          message: "magic-link row inserted",
          hypothesisId: "C",
        });
        // #endregion
      } catch (err) {
        // #region agent log
        dlog({
          location: "auth/routes.ts:/auth/request",
          message: "magic-link insert threw",
          data: { errMessage: (err as Error)?.message ?? String(err) },
          hypothesisId: "C",
        });
        // #endregion
        throw err;
      }

      // Email CTA points at the web (sansasakay.com), not the API. The
      // /auth/verify page on the landing is a brand-aligned bridge: it
      // immediately deep-links into the mobile app via the sansasakay://
      // scheme and lets the app's DeepLinkAuthBridge consume the token.
      // The web page never calls /auth/verify itself, so the magic token
      // isn't burned if the user opened the email on the wrong device.
      const link = `${env.PUBLIC_WEB_URL}/auth/verify?token=${token}`;

      try {
        await sendMagicLink(email, link);
        // #region agent log
        dlog({
          location: "auth/routes.ts:/auth/request",
          message: "sendMagicLink resolved (mailpit accepted)",
          hypothesisId: "D",
        });
        // #endregion
      } catch (err) {
        // #region agent log
        dlog({
          location: "auth/routes.ts:/auth/request",
          message: "sendMagicLink threw",
          data: {
            errMessage: (err as Error)?.message ?? String(err),
            smtpHost: env.SMTP_HOST,
          },
          hypothesisId: "D",
        });
        // #endregion
        // Don't leak send failures to the client. Log + still return 202.
        req.log.error({ err }, "magic-link send failed");
      }

      reply.code(202);
      return { ok: true as const };
    },
  );

  // GET /auth/verify?token=... — consumes the token, signs in (or signs up).
  //
  // Two response styles:
  //   - default (browser-tap from email): 302 redirect to
  //     PUBLIC_WEB_URL/auth/callback#token=<JWT>. The fragment is never sent
  //     to the server, so the JWT doesn't leak via referer or proxy logs.
  //     The web/app callback page is responsible for stashing it.
  //   - ?format=json: returns { token, user } as JSON. Used by the mobile
  //     app when it can intercept the link itself (universal links) and by
  //     curl in the README.
  app.get(
    "/verify",
    {
      schema: {
        tags: ["auth"],
        querystring: VerifyQuery,
        response: {
          // Only the JSON path declares a schema; the 302 redirect emits a
          // minimal body that Fastify writes itself, no validation needed.
          200: VerifyResponse,
        },
      },
    },
    async (req, reply) => {
      const { token, format } = req.query;
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
        // For browser flow, redirect to the callback with an error so the
        // landing page can render a friendly message instead of a JSON 401.
        if (format !== "json") {
          const url = new URL("/auth/callback", env.PUBLIC_WEB_URL);
          url.hash = "error=invalid_token";
          reply.redirect(url.toString(), 302);
          return;
        }
        throw Unauthorized("INVALID_TOKEN", "Magic link is invalid or expired");
      }

      const { userId, displayName, hasPhone } = await findOrCreateUserByEmailHash(row.emailHash);

      // If this email is on the pre-launch waitlist, stamp the user as an
      // early adopter the first time they sign in. Idempotent: the WHERE
      // clause only fires when early_adopter_at is currently NULL, so the
      // timestamp captures the actual first-sign-in moment, not later
      // re-verifications. The mobile app reads this off /me.
      await db.execute(sql`
        UPDATE users SET early_adopter_at = NOW()
        WHERE id = ${userId}::uuid
          AND early_adopter_at IS NULL
          AND EXISTS (
            SELECT 1 FROM waitlist_signups WHERE email_hash = ${row.emailHash}
          )
      `);

      // Mark token used (single-use). Done after user resolution so a DB
      // failure during user creation doesn't burn the token.
      await db
        .update(magicLinkTokens)
        .set({ usedAt: now, userId })
        .where(eq(magicLinkTokens.tokenHash, tokenHash));

      // Touch last_seen_at — cheap and useful for active-user counts.
      await db.update(users).set({ lastSeenAt: now }).where(eq(users.id, userId));

      const accessToken = app.jwt.sign({ sub: userId });

      if (format === "json") {
        return {
          token: accessToken,
          user: { id: userId, displayName, hasPhone, phoneRequired: !hasPhone },
        };
      }

      const url = new URL("/auth/callback", env.PUBLIC_WEB_URL);
      // URL fragment is not sent to the server on subsequent requests, so
      // the JWT doesn't appear in access logs or referrer headers.
      url.hash = `token=${encodeURIComponent(accessToken)}`;
      reply.redirect(url.toString(), 302);
      return;
    },
  );
};

/**
 * Signup-on-verify: if no user has this email proof yet, create one.
 * Returned `hasPhone` lets the client decide whether to prompt for phone
 * post-auth without making a second round-trip.
 */
async function findOrCreateUserByEmailHash(emailHash: string): Promise<{
  userId: string;
  displayName: string | null;
  hasPhone: boolean;
}> {
  const now = new Date();

  const [existing] = await db
    .select({ userId: identityProofs.userId })
    .from(identityProofs)
    .where(and(eq(identityProofs.provider, "email"), eq(identityProofs.identifierHash, emailHash)))
    .limit(1);

  if (existing) {
    const [u] = await db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        displayName: users.displayName,
      })
      .from(users)
      .where(eq(users.id, existing.userId))
      .limit(1);

    const [phoneProof] = await db
      .select({ userId: identityProofs.userId })
      .from(identityProofs)
      .where(and(eq(identityProofs.userId, existing.userId), eq(identityProofs.provider, "phone")))
      .limit(1);

    return {
      userId: existing.userId,
      displayName: composeDisplayName(u?.firstName, u?.lastName, u?.displayName),
      hasPhone: !!phoneProof,
    };
  }

  const [created] = await db.insert(users).values({}).returning({
    id: users.id,
  });
  if (!created) throw BadRequest("USER_CREATE_FAILED", "Could not create user");

  await db.insert(identityProofs).values({
    userId: created.id,
    provider: "email",
    identifierHash: emailHash,
    verifiedAt: now,
    isPrimary: 1,
  });

  // A freshly-created user has no name yet; the client will route to the
  // post-auth setup screen which collects firstName + lastName via PATCH /me.
  return { userId: created.id, displayName: null, hasPhone: false };
}

/**
 * Same composition rule as the /me payload — keep the two in lockstep.
 * Prefer structured first/last; fall back to any legacy display_name we
 * haven't re-prompted (post-migration, pre-edit rows).
 */
function composeDisplayName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  legacyDisplayName: string | null | undefined,
): string | null {
  const composed = [firstName, lastName].filter((s) => s && s.length > 0).join(" ");
  if (composed.length > 0) return composed;
  return legacyDisplayName ?? null;
}
