-- Postgres extensions San Sasakay depends on.
-- Idempotent: safe to run on every boot.
-- Runs once on first cluster init via the postgres image's docker-entrypoint-initdb.d hook,
-- and re-asserted by the migration runner on every API start.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Sanity check that PostGIS GEOGRAPHY type is registered.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'geography') THEN
    RAISE EXCEPTION 'postgis extension did not register the geography type';
  END IF;
END $$;
