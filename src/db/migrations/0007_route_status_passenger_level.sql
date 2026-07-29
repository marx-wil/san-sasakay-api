-- Aggregated passenger level per route (Kaunti / Sakto / Puno / Tayuan).
ALTER TABLE route_status
  ADD COLUMN IF NOT EXISTS passenger_level TEXT
  CHECK (passenger_level IN ('kaunti', 'sakto', 'puno', 'tayuan'));
