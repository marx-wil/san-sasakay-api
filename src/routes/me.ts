import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { makeRequireAuth } from "../auth/jwt.js";
import { hashIdentifier, normalizePhPhone } from "../auth/magic-link.js";
import { db } from "../db/client.js";
import { identityProofs, pointsEvents, users } from "../db/schema.js";
import { BadRequest, Conflict, NotFound } from "../lib/errors.js";

// Name fields: human-typed, generous limits, but trim and reject control
// chars. Allow anything else (Unicode letters, spaces, apostrophes, hyphens,
// periods — Filipino names like "Maria-Clara", "O'Reilly", "Jr." all valid).
// Empty string after trim = clear it (see PATCH handler).
const NameField = z
  .string()
  .max(60, "Name too long")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly rejecting them.
  .regex(/^[^\u0000-\u001f\u007f]*$/, "Name contains control characters")
  .transform((s) => s.trim())
  .nullable()
  .optional();

const PhoneBody = z.object({
  phone: z.string().min(7).max(20),
});

const MeResponse = z.object({
  id: z.string().uuid(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  // Computed convenience field: `${firstName} ${lastName}` when either is
  // present, else any legacy `users.display_name` value, else null. The
  // client can render this directly without re-deriving.
  displayName: z.string().nullable(),
  hasEmail: z.boolean(),
  hasPhone: z.boolean(),
  // True iff this user joined the pre-launch waitlist. Set when their
  // email_hash matched waitlist_signups on first magic-link verify.
  // Client uses it to render the early-adopter badge and (in Phase 2)
  // unlock the double-points bonus for the first 30 days.
  isEarlyAdopter: z.boolean(),
  credibilityScore: z.number(),
  pointsBalance: z.number().int(),
  createdAt: z.string(),
});

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  const requireAuth = makeRequireAuth();

  // GET /me — current authenticated user. Used by the client on app start
  // to confirm the JWT is still valid and to know whether to prompt for
  // post-auth phone enrollment.
  app.get(
    "/",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["me"],
        response: { 200: MeResponse },
      },
    },
    async (req) => {
      const userId = req.currentUser?.id;
      if (!userId) throw NotFound("USER_NOT_FOUND", "User not found");
      return loadProfile(userId);
    },
  );

  // PATCH /me — update first / last name. Either field is optional; pass
  // `null` (or an empty string) to clear that field specifically. Omitting
  // a field leaves it untouched. We deliberately don't surface other user
  // fields here: credibility is system-managed; createdAt is immutable.
  app.patch(
    "/",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["me"],
        body: z.object({
          firstName: NameField,
          lastName: NameField,
        }),
        response: { 200: MeResponse },
      },
    },
    async (req) => {
      const userId = req.currentUser?.id;
      if (!userId) throw NotFound("USER_NOT_FOUND", "User not found");

      // Build the partial update. Empty string after trim → null (clear);
      // `undefined` (omitted in the body) means "leave alone" — we skip
      // those keys in the update payload.
      const patch: Partial<{ firstName: string | null; lastName: string | null }> = {};
      if (Object.hasOwn(req.body, "firstName")) {
        const v = req.body.firstName;
        patch.firstName = v && v.length > 0 ? v : null;
      }
      if (Object.hasOwn(req.body, "lastName")) {
        const v = req.body.lastName;
        patch.lastName = v && v.length > 0 ? v : null;
      }

      if (Object.keys(patch).length > 0) {
        await db.update(users).set(patch).where(eq(users.id, userId));
      }
      return loadProfile(userId);
    },
  );

  // POST /me/phone — attach a PH mobile number to the authenticated user.
  //
  // Phase 1: trust-on-submit. We do not send an SMS OTP; the auth boundary
  // is already crossed via the magic link, and SMS sending is deferred to
  // Phase 2 (cost: ~$0.06/msg). The phone is stored with verifiedAt = null
  // so we can layer OTP verification on later without a schema migration.
  //
  // If a phone proof already exists for this user, this UPDATEs it
  // (commuters change SIMs). If the same number is already attached to a
  // *different* user, return 409 — phones are unique per user across the
  // table.
  app.post(
    "/phone",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["me"],
        body: PhoneBody,
        response: { 200: MeResponse },
      },
      config: {
        rateLimit: { max: 10, timeWindow: "1 hour" },
      },
    },
    async (req) => {
      const userId = req.currentUser?.id;
      if (!userId) throw NotFound("USER_NOT_FOUND", "User not found");

      let normalized: string;
      try {
        normalized = normalizePhPhone(req.body.phone);
      } catch {
        throw BadRequest(
          "INVALID_PHONE",
          "Phone must be a valid PH mobile number (e.g. 09171234567)",
        );
      }
      const phoneHash = hashIdentifier(normalized);

      // Reject if some other account owns this number.
      const [collision] = await db
        .select({ userId: identityProofs.userId })
        .from(identityProofs)
        .where(
          and(eq(identityProofs.provider, "phone"), eq(identityProofs.identifierHash, phoneHash)),
        )
        .limit(1);
      if (collision && collision.userId !== userId) {
        throw Conflict("PHONE_TAKEN", "This phone is already linked to another account");
      }

      // Drop any prior phone proofs for this user (one phone per user).
      await db
        .delete(identityProofs)
        .where(and(eq(identityProofs.userId, userId), eq(identityProofs.provider, "phone")));

      await db.insert(identityProofs).values({
        userId,
        provider: "phone",
        identifierHash: phoneHash,
        // verifiedAt left null — Phase 2 OTP will set it.
        isPrimary: 0,
      });

      return loadProfile(userId);
    },
  );

  // DELETE /me/phone — detach the user's phone proof. Idempotent.
  app.delete(
    "/phone",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["me"],
        response: { 200: MeResponse },
      },
    },
    async (req) => {
      const userId = req.currentUser?.id;
      if (!userId) throw NotFound("USER_NOT_FOUND", "User not found");

      await db
        .delete(identityProofs)
        .where(and(eq(identityProofs.userId, userId), eq(identityProofs.provider, "phone")));

      return loadProfile(userId);
    },
  );
};

/**
 * Single source of truth for the /me payload. Used by every endpoint in
 * this module so the response shape stays in lockstep.
 *
 * Points balance is computed live (`SUM(delta)`); the points table is
 * append-only so this is correct by construction. At MVP volume the user
 * has O(100s) of events at most. Migrate to a materialized view or Redis
 * cache when this becomes hot.
 */
async function loadProfile(userId: string) {
  const [u] = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      displayName: users.displayName,
      credibilityScore: users.credibilityScore,
      createdAt: users.createdAt,
      earlyAdopterAt: users.earlyAdopterAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) throw NotFound("USER_NOT_FOUND", "User not found");

  const proofs = await db
    .select({ provider: identityProofs.provider })
    .from(identityProofs)
    .where(eq(identityProofs.userId, userId));

  const balanceRow = await db
    .select({ total: sql<number>`COALESCE(SUM(${pointsEvents.delta}), 0)::int` })
    .from(pointsEvents)
    .where(eq(pointsEvents.userId, userId));

  // Prefer structured first/last; fall back to any legacy display_name we
  // never re-prompted (post-migration, pre-edit rows).
  const composed = [u.firstName, u.lastName].filter((s) => s && s.length > 0).join(" ");
  const displayName = composed.length > 0 ? composed : (u.displayName ?? null);

  return {
    id: u.id,
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    displayName,
    hasEmail: proofs.some((p) => p.provider === "email"),
    hasPhone: proofs.some((p) => p.provider === "phone"),
    isEarlyAdopter: u.earlyAdopterAt !== null,
    credibilityScore: u.credibilityScore,
    pointsBalance: balanceRow[0]?.total ?? 0,
    createdAt: u.createdAt.toISOString(),
  };
}
