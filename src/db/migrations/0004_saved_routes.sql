-- 0004_saved_routes.sql
-- User-bookmarked transit routes, shown on the home screen with live
-- aggregated status from route_status. Simple join table keyed on
-- (user_id, route_id) — a route can only be saved once per user.
-- Default query order is saved_at DESC (most recently saved first).

CREATE TABLE IF NOT EXISTS user_saved_routes (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id  UUID NOT NULL REFERENCES transit_routes(id) ON DELETE CASCADE,
  saved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, route_id)
);

CREATE INDEX IF NOT EXISTS user_saved_routes_user_idx
  ON user_saved_routes (user_id);
