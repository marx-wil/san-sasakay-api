-- Widen transit_routes.type so OSM classification can store carousel
-- and interregional buses instead of collapsing everything to jeepney.
-- Postgres names an inline CHECK {table}_{column}_check; drop by lookup
-- so a renamed constraint still gets replaced.

DO $$
DECLARE
  conname text;
BEGIN
  SELECT c.conname INTO conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'transit_routes'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%type%';
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE transit_routes DROP CONSTRAINT %I', conname);
  END IF;
END $$;

ALTER TABLE transit_routes
  ADD CONSTRAINT transit_routes_type_check
  CHECK (type IN (
    'jeepney',
    'uv_express',
    'p2p_bus',
    'carousel',
    'interregional_bus',
    'tricycle',
    'ferry'
  ));
