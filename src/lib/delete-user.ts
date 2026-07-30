/**
 * Hard-delete a user account and associated personal data.
 *
 * Deleting the `users` row cascades to identity_proofs, reports,
 * trip_feedback, user_saved_routes, points_events, and
 * account_deletion_tokens. magic_link_tokens.user_id is set null.
 *
 * Waitlist rows are keyed by email hash (not user_id), so we also
 * remove any waitlist_signups that match the user's email identity.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { identityProofs, users, waitlistSignups } from "../db/schema.js";

export async function deleteUserAccount(userId: string): Promise<void> {
  const emailProofs = await db
    .select({ identifierHash: identityProofs.identifierHash })
    .from(identityProofs)
    .where(and(eq(identityProofs.userId, userId), eq(identityProofs.provider, "email")));

  const emailHashes = emailProofs.map((p) => p.identifierHash);

  if (emailHashes.length > 0) {
    await db.delete(waitlistSignups).where(inArray(waitlistSignups.emailHash, emailHashes));
  }

  await db.delete(users).where(eq(users.id, userId));
}
