-- 0009_trip_sessions.sql
-- Completed journey log for monthly stats (trips taken, commute hours).

CREATE TABLE IF NOT EXISTS trip_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id         UUID NOT NULL REFERENCES transit_routes(id) ON DELETE CASCADE,
  client_trip_id   UUID NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trip_sessions_user_client_uq UNIQUE (user_id, client_trip_id)
);

CREATE INDEX IF NOT EXISTS trip_sessions_user_time_idx
  ON trip_sessions (user_id, ended_at DESC);
