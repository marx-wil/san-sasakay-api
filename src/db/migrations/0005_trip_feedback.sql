-- 0005_trip_feedback.sql
-- Post-trip survey responses from the journey drawer completion flow.

CREATE TABLE IF NOT EXISTS trip_feedback (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  client_uuid      UUID NOT NULL,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id         UUID NOT NULL REFERENCES transit_routes(id) ON DELETE CASCADE,
  trip_issue       TEXT NOT NULL CHECK (trip_issue IN ('aksidente', 'baha', 'sarado', 'others')),
  others_text      TEXT,
  trip_speed       TEXT NOT NULL CHECK (trip_speed IN ('mabilis', 'sakto', 'matagal')),
  passenger_level  TEXT NOT NULL CHECK (passenger_level IN ('kaunti', 'sakto', 'puno', 'tayuan')),
  location         GEOGRAPHY(POINT, 4326) NOT NULL,
  weight           REAL NOT NULL DEFAULT 1.0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT trip_feedback_user_client_uq UNIQUE (user_id, client_uuid)
);

CREATE INDEX IF NOT EXISTS trip_feedback_route_time_idx
  ON trip_feedback (route_id, created_at DESC);

CREATE INDEX IF NOT EXISTS trip_feedback_created_at_idx
  ON trip_feedback (created_at DESC);
