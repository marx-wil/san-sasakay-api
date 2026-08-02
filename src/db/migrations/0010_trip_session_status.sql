-- Trip lifecycle status for history (completed / cancelled / active).
ALTER TABLE trip_sessions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

UPDATE trip_sessions SET status = 'completed' WHERE duration_seconds > 0;
UPDATE trip_sessions SET status = 'active' WHERE duration_seconds = 0;

ALTER TABLE trip_sessions
  ADD CONSTRAINT trip_sessions_status_chk
  CHECK (status IN ('active', 'completed', 'cancelled'));
