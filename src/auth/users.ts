import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { identityProofs, users } from "../db/schema.js";
import { BadRequest, Conflict } from "../lib/errors.js";
import { hashIdentifier } from "./magic-link.js";

export function composeDisplayName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  legacyDisplayName: string | null | undefined,
): string | null {
  const composed = [firstName, lastName].filter((s) => s && s.length > 0).join(" ");
  if (composed.length > 0) return composed;
  return legacyDisplayName ?? null;
}

export type ResolvedUser = {
  userId: string;
  displayName: string | null;
  hasPhone: boolean;
};

/**
 * Signup-on-verify: if no user has this email proof yet, create one.
 * Returned `hasPhone` lets the client decide whether to prompt for phone
 * post-auth without making a second round-trip.
 */
export async function findOrCreateUserByEmailHash(
  emailHash: string,
  opts?: { firstName?: string | null; lastName?: string | null },
): Promise<ResolvedUser> {
  const now = new Date();

  const [existing] = await db
    .select({ userId: identityProofs.userId })
    .from(identityProofs)
    .where(and(eq(identityProofs.provider, "email"), eq(identityProofs.identifierHash, emailHash)))
    .limit(1);

  if (existing) {
    if (opts?.firstName !== undefined || opts?.lastName !== undefined) {
      await db
        .update(users)
        .set({
          ...(opts.firstName !== undefined ? { firstName: opts.firstName } : {}),
          ...(opts.lastName !== undefined ? { lastName: opts.lastName } : {}),
        })
        .where(eq(users.id, existing.userId));
    }

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

  const [created] = await db
    .insert(users)
    .values({
      firstName: opts?.firstName ?? null,
      lastName: opts?.lastName ?? null,
    })
    .returning({
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

  return {
    userId: created.id,
    displayName: composeDisplayName(opts?.firstName, opts?.lastName, null),
    hasPhone: false,
  };
}

export async function stampEarlyAdopter(userId: string, emailHash: string): Promise<void> {
  await db.execute(sql`
    UPDATE users SET early_adopter_at = NOW()
    WHERE id = ${userId}::uuid
      AND early_adopter_at IS NULL
      AND EXISTS (
        SELECT 1 FROM waitlist_signups WHERE email_hash = ${emailHash}
      )
  `);
}

export async function touchLastSeen(userId: string): Promise<void> {
  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, userId));
}

export async function attachPhoneIfProvided(
  userId: string,
  rawPhone: string | undefined,
): Promise<boolean> {
  if (!rawPhone || rawPhone.trim().length === 0) return false;

  const { normalizePhPhone } = await import("./magic-link.js");
  let normalized: string;
  try {
    normalized = normalizePhPhone(rawPhone);
  } catch {
    throw BadRequest("INVALID_PHONE", "Phone must be a valid PH mobile number (e.g. 09171234567)");
  }
  const phoneHash = hashIdentifier(normalized);

  const [collision] = await db
    .select({ userId: identityProofs.userId })
    .from(identityProofs)
    .where(and(eq(identityProofs.provider, "phone"), eq(identityProofs.identifierHash, phoneHash)))
    .limit(1);
  if (collision && collision.userId !== userId) {
    throw Conflict("PHONE_TAKEN", "This phone is already linked to another account");
  }

  await db
    .delete(identityProofs)
    .where(and(eq(identityProofs.userId, userId), eq(identityProofs.provider, "phone")));

  await db.insert(identityProofs).values({
    userId,
    provider: "phone",
    identifierHash: phoneHash,
    isPrimary: 0,
  });

  return true;
}
