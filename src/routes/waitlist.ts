import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hashIdentifier } from "../auth/magic-link.js";
import { db } from "../db/client.js";
import { Conflict } from "../lib/errors.js";
import { sendWaitlistConfirmation } from "../lib/waitlist-email.js";

// Hard cap on pre-launch waitlist signups. After this we return WAITLIST_FULL
// instead of silently accepting. ±a few over the cap due to race conditions
// is fine — this is a marketing line, not a security boundary.
const WAITLIST_CAP = 500;

const RequestBody = z.object({
  email: z.string().email().max(254),
  // Free-form attribution (e.g. 'landing-waitlist', 'hero-cta'). Persisted
  // verbatim so we can A/B test CTA placement later. Capped to avoid
  // someone shoving ad-tracking blobs into the column.
  source: z.string().max(40).optional(),
  // Honeypot. Real users never see this field. Bots that auto-fill every
  // input will set it; we silently 202 them. Must be empty when present.
  hp: z.string().max(0).optional(),
});

export const waitlistRoutes: FastifyPluginAsyncZod = async (app) => {
  // POST /waitlist — public endpoint. Pre-launch list, hash-only storage.
  //
  // Response model mirrors /auth/request: 202 for everything that isn't a
  // server error or a hit cap, even when the row is a duplicate, so we
  // don't leak whether an address is already in the list.
  //
  // Cap (500) returns 409 WAITLIST_FULL specifically because the UI needs
  // to communicate it. Past 500 we'd rather be honest than silent.
  app.post(
    "/",
    {
      schema: {
        tags: ["waitlist"],
        body: RequestBody,
        response: {
          202: z.object({ ok: z.literal(true) }),
        },
      },
      config: {
        // Same envelope as /auth/request — generous enough for legit retries
        // (typo, then re-submit), tight enough that brute-forcing the cap
        // costs more than it returns.
        rateLimit: { max: 5, timeWindow: "15 minutes" },
      },
    },
    async (req, reply) => {
      const { email, source, hp } = req.body;

      // Honeypot tripped — pretend we accepted, do nothing else. Returning
      // a different status would tell the bot operator their probe worked.
      if (hp && hp.length > 0) {
        reply.code(202);
        return { ok: true as const };
      }

      const emailHash = hashIdentifier(email);

      // Race-safe insert + cap check in a single SQL. Three outcomes:
      //   1. Row inserted -> RETURNING yields the new id (fresh signup).
      //   2. ON CONFLICT fires -> RETURNING is empty, but the row exists
      //      already (duplicate; don't leak — return 202).
      //   3. WHERE clause fails because count >= cap -> RETURNING is empty
      //      AND no conflicting row exists (cap hit; return 409).
      //
      // We disambiguate (2) vs (3) with a follow-up existence check. The
      // count subquery + insert run inside the same statement so two
      // concurrent inserts can't both see count = 499.
      const result = await db.execute<{ id: string }>(sql`
        INSERT INTO waitlist_signups (email_hash, source)
        SELECT ${emailHash}, ${source ?? null}
        WHERE (SELECT COUNT(*) FROM waitlist_signups) < ${WAITLIST_CAP}
        ON CONFLICT (email_hash) DO NOTHING
        RETURNING id
      `);

      const inserted = result.rows[0];
      let isFreshSignup = false;
      let position: number | undefined;

      if (inserted) {
        // Fresh signup. Compute the user's position for the confirmation
        // email — cheap COUNT(*) since the table is tiny (≤500) and has
        // an index on created_at.
        isFreshSignup = true;
        const posResult = await db.execute<{ pos: number }>(sql`
          SELECT COUNT(*)::int AS pos FROM waitlist_signups
        `);
        position = posResult.rows[0]?.pos;
      } else {
        // Either a duplicate or the cap was hit. Check existence to tell
        // the two apart.
        const existing = await db.execute<{ id: string }>(sql`
          SELECT id FROM waitlist_signups WHERE email_hash = ${emailHash} LIMIT 1
        `);
        if (existing.rows.length === 0) {
          // No row for this hash AND insert was rejected -> cap hit.
          throw Conflict("WAITLIST_FULL", "Punô na ang waitlist");
        }
        // Duplicate. Fall through to 202 without re-sending the email.
      }

      if (isFreshSignup) {
        try {
          await sendWaitlistConfirmation(email, position);
        } catch (err) {
          // Don't fail the request if the email send blew up — the user
          // is in the list, which is what matters. Same posture as
          // /auth/request's mail-send failure path.
          req.log.error({ err }, "waitlist confirmation send failed");
        }
      }

      reply.code(202);
      return { ok: true as const };
    },
  );
};
