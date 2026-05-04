-- 0003_waitlist.sql
-- Pre-launch waitlist + early-adopter mark on `users`.
--
-- Storage model: hash-only, mirroring identity_proofs.identifier_hash. We
-- never store the raw email, so we cannot send a broadcast email to the
-- waitlist later. The "future benefits" promise is delivered by joining
-- the email_hash against the waitlist when a user signs in via magic-link
-- and stamping users.early_adopter_at. The mobile app reads the flag from
-- /me and unlocks the early-adopter bonus once Phase 2 ships redemption.
--
-- Cap (500) is enforced at the route layer with a single race-safe SQL,
-- not as a CHECK constraint — at MVP scale ±a few over the cap is fine,
-- and a CHECK would force callers to swallow generic constraint errors
-- instead of returning a friendly WAITLIST_FULL.

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash  TEXT NOT NULL UNIQUE,
  -- Free-form attribution tag (e.g. 'landing-waitlist', 'hero-cta'). Lets
  -- us A/B test CTA placement later without a schema change.
  source      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS waitlist_signups_created_at_idx
  ON waitlist_signups (created_at);

-- Stamped on first magic-link verify when the user's email_hash is found
-- in waitlist_signups. NULL = not a waitlist member. Idempotent set: the
-- UPDATE in auth/routes.ts only fires when the column is currently NULL,
-- so the timestamp captures the actual first-sign-in moment.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS early_adopter_at TIMESTAMPTZ;
