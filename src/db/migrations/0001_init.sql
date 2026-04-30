-- 0001_init.sql
-- Initial schema for San Sasakay. Hand-written rather than drizzle-kit generated
-- because PostGIS geography columns are outside drizzle-kit's modeling. Drizzle
-- ORM (src/db/schema.ts) is the source of truth for *application* queries;
-- this file is the source of truth for the *database* shape.
--
-- Transaction management: src/db/migrate.ts wraps each migration in BEGIN/
-- COMMIT, so this file does NOT issue its own transaction control.
--
-- Note on Timescale hypertable conversion (deliberately deferred):
-- Converting `reports` to a Timescale hypertable on `created_at` requires
-- every UNIQUE constraint to include the partitioning column. Our offline-
-- queue idempotency relies on UNIQUE (user_id, client_uuid) — adding
-- created_at to that key would break idempotency (two retries at different
-- times would both succeed). At MVP volume (~30K reports/week), a regular
-- table with a BRIN index on created_at is more than sufficient; we'll
-- migrate to a hypertable + dedup-table pattern when volume justifies it.

-- ─── users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name       TEXT,
  credibility_score  REAL NOT NULL DEFAULT 1.0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at);

-- ─── identity_proofs ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS identity_proofs (
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL CHECK (provider IN ('email','phone','philsys')),
  identifier_hash       TEXT NOT NULL,
  encrypted_identifier  TEXT,
  is_primary            INTEGER NOT NULL DEFAULT 1,
  verified_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider, identifier_hash),
  CONSTRAINT identity_proofs_provider_hash_uq UNIQUE (provider, identifier_hash)
);
CREATE INDEX IF NOT EXISTS identity_proofs_user_idx ON identity_proofs (user_id);

-- ─── magic_link_tokens ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  token_hash   TEXT PRIMARY KEY,
  email_hash   TEXT NOT NULL,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS magic_link_tokens_expires_idx ON magic_link_tokens (expires_at);
CREATE INDEX IF NOT EXISTS magic_link_tokens_email_idx   ON magic_link_tokens (email_hash);

-- ─── transit_routes ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transit_routes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('jeepney','uv_express','p2p_bus','tricycle','ferry')),
  geometry    GEOGRAPHY(LineString, 4326),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS transit_routes_type_idx ON transit_routes (type);
CREATE INDEX IF NOT EXISTS transit_routes_geom_gix ON transit_routes USING GIST (geometry);

-- ─── stops ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stops (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id   UUID NOT NULL REFERENCES transit_routes(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  name       TEXT NOT NULL,
  location   GEOGRAPHY(Point, 4326) NOT NULL,
  CONSTRAINT stops_route_seq_uq UNIQUE (route_id, seq)
);
CREATE INDEX IF NOT EXISTS stops_loc_gix ON stops USING GIST (location);

-- ─── reports ────────────────────────────────────────────────────────────────
-- Composite PK (id, created_at) is kept so a future hypertable conversion is
-- a smaller change. id alone is uniquely random (gen_random_uuid), so this is
-- functionally equivalent to a single-column PK today.
CREATE TABLE IF NOT EXISTS reports (
  id           UUID NOT NULL DEFAULT gen_random_uuid(),
  client_uuid  UUID NOT NULL,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id     UUID NOT NULL REFERENCES transit_routes(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('tumatakbo','limitado','hindi_tumatakbo')),
  crowd_level  TEXT CHECK (crowd_level IN ('maluwag','katamtaman','siksikan')),
  location     GEOGRAPHY(Point, 4326) NOT NULL,
  weight       REAL NOT NULL DEFAULT 1.0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT reports_user_client_uq UNIQUE (user_id, client_uuid)
);
CREATE INDEX IF NOT EXISTS reports_route_time_idx  ON reports (route_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_created_at_idx  ON reports USING BRIN (created_at);
CREATE INDEX IF NOT EXISTS reports_loc_gix         ON reports USING GIST (location);

-- Retention is enforced by a daily cron in production (see scripts/backup.sh
-- area). For MVP volume, a simple `DELETE FROM reports WHERE created_at <
-- NOW() - INTERVAL '7 days'` is sufficient and we'll add it when needed.

-- ─── route_status ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS route_status (
  route_id        UUID PRIMARY KEY REFERENCES transit_routes(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'hindi_alam'
                    CHECK (status IN ('tumatakbo','limitado','hindi_tumatakbo','hindi_alam')),
  confidence      REAL NOT NULL DEFAULT 0,
  report_count    INTEGER NOT NULL DEFAULT 0,
  last_report_at  TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── points_events (append-only ledger) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS points_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
                'report_submitted',
                'report_validated_by_other',
                'validated_other',
                'streak_multiplier',
                'redemption_debit',
                'manual_grant'
              )),
  delta       INTEGER NOT NULL,
  ref_id      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS points_events_user_time_idx ON points_events (user_id, created_at DESC);
